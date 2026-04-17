import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

const htmlFiles = ["index.html", "impressum.html", "datenschutz.html", "cookies.html"];
const semverRe = /^\d+\.\d+\.\d+$/;

function extractMetaVersion(html) {
  const m = html.match(/<meta\s+name=["']app-version["']\s+content=["']([^"']+)["']\s*\/?>/i);
  return m?.[1]?.trim() || "";
}

function extractSwVersion(swJs) {
  const m = swJs.match(/const\s+APP_VERSION\s*=\s*["']([^"']+)["'];/);
  return m?.[1]?.trim() || "";
}

async function readJson(file) {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw);
}

async function main() {
  const versions = new Map();

  for (const file of htmlFiles) {
    const content = await fs.readFile(path.join(ROOT, file), "utf8");
    const v = extractMetaVersion(content);
    if (!v) throw new Error(`Missing app-version meta in ${file}`);
    if (!semverRe.test(v)) throw new Error(`Invalid semver in ${file}: ${v}`);
    versions.set(file, v);
  }

  const unique = new Set(versions.values());
  if (unique.size !== 1) {
    throw new Error(`app-version mismatch across HTML: ${JSON.stringify(Object.fromEntries(versions))}`);
  }

  const appVersion = [...unique][0];

  const pkg = await readJson(path.join(ROOT, "package.json"));
  if (pkg.version !== appVersion) {
    throw new Error(`package.json version (${pkg.version}) != app-version (${appVersion})`);
  }

  const sw = await fs.readFile(path.join(ROOT, "service-worker.js"), "utf8");
  const swVersion = extractSwVersion(sw);
  if (swVersion !== appVersion) {
    throw new Error(`service-worker APP_VERSION (${swVersion}) != app-version (${appVersion})`);
  }

  // Basic changelog check (must mention the version header).
  const changelog = await fs.readFile(path.join(ROOT, "CHANGELOG.md"), "utf8");
  if (!changelog.includes(`## [${appVersion}]`)) {
    throw new Error(`CHANGELOG.md missing header for version ${appVersion}`);
  }
}

await main();

