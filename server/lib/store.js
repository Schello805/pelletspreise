import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getPaths({ projectRoot }) {
  const dataDir = path.join(projectRoot, "server", "data");
  return {
    dataDir,
    sourcesPath: path.join(dataDir, "sources.json"),
    historyPath: path.join(dataDir, "history.jsonl"),
    defaultsSourcesPath: path.join(projectRoot, "server", "defaults", "sources.json"),
  };
}

export async function ensureDataFiles({ projectRoot }) {
  const paths = getPaths({ projectRoot });
  await fs.mkdir(paths.dataDir, { recursive: true });
  try {
    await fs.access(paths.sourcesPath);
  } catch {
    const raw = await fs.readFile(paths.defaultsSourcesPath, "utf8");
    await fs.writeFile(paths.sourcesPath, raw, "utf8");
  }
  // Migration/Sync: entferne alte Demo-Quellen und ergänze/aktualisiere Default-Quellen anhand server/defaults/sources.json.
  try {
    const [rawExisting, rawDefaults] = await Promise.all([
      fs.readFile(paths.sourcesPath, "utf8"),
      fs.readFile(paths.defaultsSourcesPath, "utf8"),
    ]);
    const existing = JSON.parse(rawExisting);
    const defaults = JSON.parse(rawDefaults);
    if (!Array.isArray(existing) || !Array.isArray(defaults)) throw new Error("sources.json ungültig");

    const strippedExisting = existing.filter((s) => !["demo", "demo-http"].includes(String(s?.id || "")));
    const byId = new Map(strippedExisting.map((s) => [String(s?.id || ""), s]));

    const merged = [];
    const addedIds = new Set();

    for (const def of defaults) {
      const id = String(def?.id || "");
      if (!id) continue;
      const cur = byId.get(id);
      if (cur) {
        merged.push({
          ...def,
          enabled: cur.enabled ?? def.enabled,
          lastRunAt: cur.lastRunAt ?? def.lastRunAt ?? null,
        });
      } else {
        merged.push(def);
      }
      addedIds.add(id);
    }

    // Keep user-defined sources (not in defaults)
    for (const s of strippedExisting) {
      const id = String(s?.id || "");
      if (!id || addedIds.has(id)) continue;
      merged.push(s);
    }

    const changed = JSON.stringify(existing) !== JSON.stringify(merged);
    if (changed) {
      const tmp = `${paths.sourcesPath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(merged, null, 2), "utf8");
      await fs.rename(tmp, paths.sourcesPath);
    }
  } catch {
    // ignore
  }
  try {
    await fs.access(paths.historyPath);
  } catch {
    await fs.writeFile(paths.historyPath, "", "utf8");
  }
  return paths;
}

export async function readSources({ projectRoot }) {
  const { sourcesPath } = await ensureDataFiles({ projectRoot });
  const raw = await fs.readFile(sourcesPath, "utf8");
  const sources = JSON.parse(raw);
  if (!Array.isArray(sources)) throw new Error("sources.json ist ungültig.");
  return sources;
}

export async function writeSources({ projectRoot, sources }) {
  const { sourcesPath } = await ensureDataFiles({ projectRoot });
  const tmp = `${sourcesPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(sources, null, 2), "utf8");
  await fs.rename(tmp, sourcesPath);
}

export async function resetSourcesToDefaults({ projectRoot }) {
  const paths = await ensureDataFiles({ projectRoot });
  const raw = await fs.readFile(paths.defaultsSourcesPath, "utf8");
  await fs.writeFile(paths.sourcesPath, raw, "utf8");
}

export async function appendHistory({ projectRoot, item }) {
  const { historyPath } = await ensureDataFiles({ projectRoot });
  const line = `${JSON.stringify(item)}\n`;
  await fs.appendFile(historyPath, line, "utf8");
}

export async function readHistory({ projectRoot, limit = 80 }) {
  const { historyPath } = await ensureDataFiles({ projectRoot });
  const raw = await fs.readFile(historyPath, "utf8");
  const lines = raw.trim() ? raw.trim().split("\n") : [];
  const slice = lines.slice(Math.max(0, lines.length - limit));
  const items = slice
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
  return items;
}

export async function readHistoryAll({ projectRoot, maxLines = 50_000 } = {}) {
  const { historyPath } = await ensureDataFiles({ projectRoot });
  const raw = await fs.readFile(historyPath, "utf8");
  const lines = raw.trim() ? raw.trim().split("\n") : [];
  const slice = lines.slice(Math.max(0, lines.length - maxLines));
  const items = slice
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return items;
}

export async function clearHistory({ projectRoot }) {
  const { historyPath } = await ensureDataFiles({ projectRoot });
  await fs.writeFile(historyPath, "", "utf8");
}
