import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendHistory, clearHistory, readHistory, readHistoryAll, readSources, resetSourcesToDefaults, writeSources } from "./lib/store.js";
import { getCachedResult, pruneCache, setCachedResult } from "./lib/cache.js";
import { dailyRowsToCsv, getDailyHistory, rawItemsToCsv } from "./lib/history.js";
import { jsonResponse, newId, normalizeQuery, readJsonBody, textResponse } from "./lib/util.js";
import { runSource } from "./scrape/runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

// Hinweis: In manchen Sandbox-Umgebungen sind nicht alle Ports erlaubt. 8000 ist meist freigeschaltet.
const PORT = Number(process.env.PORT || 8000);
const HOST = String(process.env.HOST || "127.0.0.1");
const BASE_URL = String(process.env.BASE_URL || `http://${HOST}:${PORT}`);
const APP_VERSION = "0.1.0";

function normalizeExtract(ex) {
  if (!ex || typeof ex !== "object") return null;
  const out = {};
  if (ex.regex) out.regex = String(ex.regex);
  if (ex.regexAsOf) out.regexAsOf = String(ex.regexAsOf);
  if (ex.regexTotal) out.regexTotal = String(ex.regexTotal);
  return Object.keys(out).length ? out : null;
}

function resolveFrontendPath(urlPath) {
  const safe = urlPath.replace(/\/+/g, "/");
  if (safe === "/pelletpreise" || safe === "/pelletpreise/") return path.join(projectRoot, "pelletpreise", "index.html");
  if (!safe.startsWith("/pelletpreise/")) return null;
  const rel = safe.slice("/pelletpreise/".length);
  if (!rel || rel.includes("..")) return null;
  return path.join(projectRoot, "pelletpreise", rel);
}

function resolveRootStaticPath(urlPath) {
  const safe = urlPath.replace(/\/+/g, "/");
  const allow = new Set(["/impressum.html", "/datenschutz.html", "/cookies.html"]);
  if (!allow.has(safe)) return null;
  const filename = safe.slice(1);
  return path.join(projectRoot, filename);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".webmanifest": "application/manifest+json; charset=utf-8",
    }[ext] || "application/octet-stream"
  );
}

function withLimit(limit, tasks) {
  return new Promise((resolve) => {
    const results = new Array(tasks.length);
    let next = 0;
    let active = 0;

    function runMore() {
      while (active < limit && next < tasks.length) {
        const idx = next++;
        active++;
        Promise.resolve()
          .then(() => tasks[idx]())
          .then((v) => (results[idx] = v))
          .catch((e) => (results[idx] = { ok: false, error: e?.message || String(e) }))
          .finally(() => {
            active--;
            if (next >= tasks.length && active === 0) resolve(results);
            else runMore();
          });
      }
    }

    runMore();
  });
}

function demoHtml({ query }) {
  const base = 299.9;
  const factor = query.product === "ENPLUS_A1_SACK" ? 1.12 : query.product === "DINPLUS_LOSE" ? 1.03 : 1.0;
  const qtyDiscount = Math.max(0.84, 1.0 - Math.min(0.12, (query.quantityTons - 2) * 0.015));
  const pc = Number(query.postalCode.slice(-2));
  const region = 0.6 + (pc % 9) * 0.02;
  const price = Math.round(base * factor * qtyDiscount * region * 100) / 100;
  return `<!doctype html>
<html lang="de">
  <head><meta charset="utf-8"><title>Demo Preis</title></head>
  <body>
    <h1>Demo (lokal)</h1>
    <p>PLZ: <strong>${query.postalCode}</strong></p>
    <p>Menge: <strong>${query.quantityTons}</strong> t</p>
    <p>Produkt: <strong>${query.product}</strong></p>
    <div class="price">Preis: <strong>${String(price).replace(".", ",")}</strong> € / t</div>
  </body>
</html>`;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return jsonResponse(res, 200, { ok: true, version: APP_VERSION, baseUrl: BASE_URL });
  }

  if (req.method === "GET" && url.pathname === "/api/debug/heizpellets24-offer") {
    const postalCode = String(url.searchParams.get("postalCode") || "").trim();
    const quantityTons = Number(url.searchParams.get("quantityTons") || "3");
    const product = String(url.searchParams.get("product") || "ENPLUS_A1_LOSE").trim();
    if (!/^\d{5}$/.test(postalCode)) return jsonResponse(res, 400, { error: "postalCode muss 5-stellig sein." });
    if (!Number.isFinite(quantityTons) || quantityTons <= 0) return jsonResponse(res, 400, { error: "quantityTons ungültig." });

    const stations = String(url.searchParams.get("stations") || "1");
    const amountKg = Math.round(quantityTons * 1000);
    const hpProduct = product === "ENPLUS_A1_SACK" ? "21" : "20";
    const options = "108,131,-18,127,159";
    const pcert = "4,2,6,1";
    const targetUrl = `https://www.heizpellets24.de/holzpellets-lose/angebotsliste?zipCode=${encodeURIComponent(
      postalCode,
    )}&amount=${encodeURIComponent(String(amountKg))}&stations=${encodeURIComponent(stations)}&product=${encodeURIComponent(
      hpProduct,
    )}&options=${encodeURIComponent(options)}&ap=0&pcert=${encodeURIComponent(pcert)}&lbp=0`;

    try {
      const r = await fetch(targetUrl, {
        redirect: "follow",
        headers: {
          "user-agent": "pelletpreis-checker/0.1 (+contact: info@schellenberger.biz)",
          from: "info@schellenberger.biz",
          "x-contact": "info@schellenberger.biz",
          "accept-language": "de-DE,de;q=0.9,en;q=0.8",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      const html = await r.text();
      const idx = html.indexOf("günstigster");
      const sliceFrom = idx >= 0 ? Math.max(0, idx - 1600) : 0;
      const sliceTo = idx >= 0 ? Math.min(html.length, idx + 2600) : Math.min(html.length, 4200);
      const snippet = html.slice(sliceFrom, sliceTo);

      const nuxtIdx = html.indexOf("__NUXT__");
      const nuxtFrom = nuxtIdx >= 0 ? Math.max(0, nuxtIdx - 900) : 0;
      const nuxtTo = nuxtIdx >= 0 ? Math.min(html.length, nuxtIdx + 2100) : 0;
      const nuxtSnippet = nuxtIdx >= 0 ? html.slice(nuxtFrom, nuxtTo) : null;

      const searchFrom = nuxtIdx >= 0 ? Math.min(html.length, nuxtIdx + 2500) : 0;
      const keys = ["offers", "offer", "dealerId", "dealer", "unitPrice", "totalPrice", "price", "gesamt", "Angebot", "angebote"];
      let hit = null;
      for (const key of keys) {
        const kIdx = html.indexOf(key, searchFrom);
        if (kIdx >= 0 && (!hit || kIdx < hit.index)) hit = { key, index: kIdx };
      }
      const hitFrom = hit ? Math.max(0, hit.index - 900) : 0;
      const hitTo = hit ? Math.min(html.length, hit.index + 2100) : 0;
      const hitSnippet = hit ? html.slice(hitFrom, hitTo) : null;

      const absoluteUrls = Array.from(html.matchAll(/https?:\/\/[^\s"'<>]+/g))
        .slice(0, 30)
        .map((m) => m[0]);
      const assetPaths = Array.from(html.matchAll(/\/[a-zA-Z0-9_./-]+\.(?:js|css|json)(?:\?[^"'<>\\s]+)?/g))
        .slice(0, 40)
        .map((m) => m[0]);

      return jsonResponse(res, 200, {
        ok: r.ok,
        status: r.status,
        url: targetUrl,
        length: html.length,
        markerIndex: idx,
        hasMajorNumber: html.includes("major-number"),
        hasMinorNumber: html.includes("minor-number"),
        hasUnitPriceParam: html.includes("unitPrice="),
        hasDealerWrapper: html.includes("dealer-card--outer-wrapper"),
        hasNextData: html.includes("__NEXT_DATA__"),
        hasNuxt: html.includes("__NUXT__"),
        hasInitialState: html.includes("INITIAL_STATE"),
        absoluteUrls,
        assetPaths,
        nuxtIndex: nuxtIdx,
        nuxtSnippet,
        hit,
        hitSnippet,
        snippet,
      });
    } catch (err) {
      return jsonResponse(res, 502, { error: err?.message || String(err), url: targetUrl });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/sources") {
    const sources = await readSources({ projectRoot });
    return jsonResponse(res, 200, { sources });
  }

  if (req.method === "GET" && url.pathname === "/api/sources/export") {
    const sources = await readSources({ projectRoot });
    return jsonResponse(res, 200, { sources });
  }

  if (req.method === "POST" && url.pathname === "/api/sources/import") {
    const body = (await readJsonBody(req)) || {};
    const sources = body?.data?.sources;
    if (!Array.isArray(sources)) return jsonResponse(res, 400, { error: "Import-Format ungültig (sources fehlt)." });

    const normalized = sources.map((s) => ({
      id: String(s.id || newId("src")),
      name: String(s.name || "Quelle").slice(0, 120),
      enabled: Boolean(s.enabled),
      group: s.group != null ? String(s.group) : null,
      kind: String(s.kind || "http-regex"),
      url: s.url != null ? String(s.url) : null,
      extract: normalizeExtract(s.extract),
      request:
        s.request && typeof s.request === "object"
          ? {
              ...(s.request.method ? { method: String(s.request.method).toUpperCase() } : {}),
              ...(s.request.contentType ? { contentType: String(s.request.contentType) } : {}),
              ...(s.request.bodyTemplate ? { bodyTemplate: String(s.request.bodyTemplate) } : {}),
              ...(s.request.headers && typeof s.request.headers === "object" ? { headers: s.request.headers } : {}),
            }
          : null,
      steps: Array.isArray(s.steps) ? s.steps : null,
      lastRunAt: s.lastRunAt || null,
    }));
    await writeSources({ projectRoot, sources: normalized });
    return jsonResponse(res, 200, { ok: true, count: normalized.length });
  }

  if (req.method === "POST" && url.pathname === "/api/sources/reset") {
    await resetSourcesToDefaults({ projectRoot });
    return jsonResponse(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/sources") {
    const body = (await readJsonBody(req)) || {};
    const s = body.source;
    if (!s) return jsonResponse(res, 400, { error: "source fehlt." });
    const sources = await readSources({ projectRoot });
    const id = newId("src");

    const next = {
      id,
      name: String(s.name || "Quelle").slice(0, 120),
      enabled: Boolean(s.enabled ?? true),
      group: s.group != null ? String(s.group) : null,
      kind: String(s.kind || "http-regex"),
      url: s.url != null ? String(s.url) : null,
      extract: normalizeExtract(s.extract),
      request:
        s.request && typeof s.request === "object"
          ? {
              ...(s.request.method ? { method: String(s.request.method).toUpperCase() } : {}),
              ...(s.request.contentType ? { contentType: String(s.request.contentType) } : {}),
              ...(s.request.bodyTemplate ? { bodyTemplate: String(s.request.bodyTemplate) } : {}),
              ...(s.request.headers && typeof s.request.headers === "object" ? { headers: s.request.headers } : {}),
            }
          : null,
      steps: Array.isArray(s.steps) ? s.steps : null,
      lastRunAt: null,
    };
    sources.push(next);
    await writeSources({ projectRoot, sources });
    return jsonResponse(res, 201, { ok: true, source: next });
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/sources/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/sources/".length));
    const body = (await readJsonBody(req)) || {};
    const patch = body.source || {};
    const sources = await readSources({ projectRoot });
    const idx = sources.findIndex((s) => s.id === id);
    if (idx < 0) return jsonResponse(res, 404, { error: "Quelle nicht gefunden." });
    const current = sources[idx];

    const updated = {
      ...current,
      ...(patch.name != null ? { name: String(patch.name).slice(0, 120) } : {}),
      ...(patch.enabled != null ? { enabled: Boolean(patch.enabled) } : {}),
      ...(patch.group !== undefined ? { group: patch.group != null ? String(patch.group) : null } : {}),
      ...(patch.kind != null ? { kind: String(patch.kind) } : {}),
      ...(patch.url !== undefined ? { url: patch.url != null ? String(patch.url) : null } : {}),
      ...(patch.extract !== undefined ? { extract: normalizeExtract(patch.extract) } : {}),
      ...(patch.request !== undefined
        ? {
            request:
              patch.request && typeof patch.request === "object"
                ? {
                    ...(patch.request.method ? { method: String(patch.request.method).toUpperCase() } : {}),
                    ...(patch.request.contentType ? { contentType: String(patch.request.contentType) } : {}),
                    ...(patch.request.bodyTemplate ? { bodyTemplate: String(patch.request.bodyTemplate) } : {}),
                    ...(patch.request.headers && typeof patch.request.headers === "object" ? { headers: patch.request.headers } : {}),
                  }
                : null,
          }
        : {}),
      ...(patch.steps !== undefined ? { steps: Array.isArray(patch.steps) ? patch.steps : null } : {}),
    };
    sources[idx] = updated;
    await writeSources({ projectRoot, sources });
    return jsonResponse(res, 200, { ok: true, source: updated });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/sources/")) {
    const id = decodeURIComponent(url.pathname.slice("/api/sources/".length));
    const sources = await readSources({ projectRoot });
    const next = sources.filter((s) => s.id !== id);
    await writeSources({ projectRoot, sources: next });
    return jsonResponse(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/sources/test") {
    const body = (await readJsonBody(req)) || {};
    const query = normalizeQuery(body.query || {});
    const source = body.source;
    if (!source) return jsonResponse(res, 400, { error: "source fehlt." });
    const result = await runSource({ source: { ...source, id: source.id || "test", name: source.name || "Test" }, query, baseUrl: BASE_URL });
    return jsonResponse(res, 200, { ok: true, result });
  }

  if (req.method === "POST" && url.pathname === "/api/scrape/run") {
    const body = (await readJsonBody(req)) || {};
    const query = normalizeQuery(body.query || {});
    const onlyDemo = Boolean(body.onlyDemo);
    const sources = await readSources({ projectRoot });
    const enabled = sources.filter((s) => s.enabled);
    const selected = onlyDemo ? enabled.filter((s) => s.kind === "demo") : enabled;

    const httpish = selected.filter((s) => s.kind !== "playwright");
    const playwrightSources = selected.filter((s) => s.kind === "playwright");

    await pruneCache({ projectRoot }).catch(() => {});

    const results = [];

    const httpTasks = httpish.map((s) => async () => {
      const cached = await getCachedResult({ projectRoot, sourceId: s.id, query });
      if (cached) return cached;
      const fresh = await runSource({ source: s, query, baseUrl: BASE_URL });
      await setCachedResult({ projectRoot, sourceId: s.id, query, result: fresh }).catch(() => {});
      return fresh;
    });
    results.push(...(await withLimit(4, httpTasks)));

    if (playwrightSources.length) {
      let playwrightBrowser = null;
      try {
        const playwright = await import("playwright");
        playwrightBrowser = await playwright.chromium.launch({ headless: true });
      } catch {
        playwrightBrowser = null;
      }
      try {
        for (const s of playwrightSources) {
          const cached = await getCachedResult({ projectRoot, sourceId: s.id, query });
          if (cached) {
            results.push(cached);
            continue;
          }
          const fresh = await runSource({ source: s, query, baseUrl: BASE_URL, sharedBrowser: playwrightBrowser });
          await setCachedResult({ projectRoot, sourceId: s.id, query, result: fresh }).catch(() => {});
          results.push(fresh);
        }
      } finally {
        if (playwrightBrowser) await playwrightBrowser.close().catch(() => {});
      }
    }

    const now = new Date().toISOString();
    const updatedSources = sources.map((s) => {
      if (!selected.some((sel) => sel.id === s.id)) return s;
      return { ...s, lastRunAt: now };
    });
    await writeSources({ projectRoot, sources: updatedSources });

    for (const r of results) {
      // Only persist non-cached runs (so daily caching also keeps history clean).
      if (r && r.cached) continue;
      await appendHistory({ projectRoot, item: { ...r, query } });
    }

    const sorted = results.slice().sort((a, b) => {
      if (a.ok && b.ok) return (a.priceEurPerTon ?? Infinity) - (b.priceEurPerTon ?? Infinity);
      if (a.ok) return -1;
      if (b.ok) return 1;
      return 0;
    });

    return jsonResponse(res, 200, { ok: true, query, results: sorted });
  }

  if (req.method === "GET" && url.pathname === "/api/history") {
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 80)));
    const items = await readHistory({ projectRoot, limit });
    return jsonResponse(res, 200, { ok: true, items });
  }

  if (req.method === "GET" && url.pathname === "/api/history/daily") {
    const days = Math.max(1, Math.min(3650, Number(url.searchParams.get("days") || 365)));
    const groupBy = String(url.searchParams.get("groupBy") || "source");
    const onlyOrderable = url.searchParams.get("onlyOrderable") === "1" || url.searchParams.get("onlyOrderable") === "true";
    const rows = await getDailyHistory({ projectRoot, days, groupBy: groupBy === "dealer" ? "dealer" : "source", onlyOrderable });
    return jsonResponse(res, 200, { ok: true, days, groupBy: groupBy === "dealer" ? "dealer" : "source", onlyOrderable, rows });
  }

  if (req.method === "GET" && url.pathname === "/api/history/export.json") {
    const mode = String(url.searchParams.get("mode") || "daily");
    if (mode === "raw") {
      const maxLines = Math.max(1, Math.min(200_000, Number(url.searchParams.get("maxLines") || 80_000)));
      const items = await readHistoryAll({ projectRoot, maxLines });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="pelletpreise-history-raw.json"`,
        "cache-control": "no-store",
      });
      return res.end(JSON.stringify({ ok: true, mode: "raw", items }, null, 2));
    }
    const days = Math.max(1, Math.min(3650, Number(url.searchParams.get("days") || 365)));
    const groupBy = String(url.searchParams.get("groupBy") || "source");
    const onlyOrderable = url.searchParams.get("onlyOrderable") === "1" || url.searchParams.get("onlyOrderable") === "true";
    const rows = await getDailyHistory({ projectRoot, days, groupBy: groupBy === "dealer" ? "dealer" : "source", onlyOrderable });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="pelletpreise-history-daily.json"`,
      "cache-control": "no-store",
    });
    return res.end(JSON.stringify({ ok: true, mode: "daily", days, groupBy: groupBy === "dealer" ? "dealer" : "source", onlyOrderable, rows }, null, 2));
  }

  if (req.method === "GET" && url.pathname === "/api/history/export.csv") {
    const mode = String(url.searchParams.get("mode") || "daily");
    if (mode === "raw") {
      const maxLines = Math.max(1, Math.min(200_000, Number(url.searchParams.get("maxLines") || 80_000)));
      const items = await readHistoryAll({ projectRoot, maxLines });
      const csv = rawItemsToCsv(items);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="pelletpreise-history-raw.csv"`,
        "cache-control": "no-store",
      });
      return res.end(csv);
    }
    const days = Math.max(1, Math.min(3650, Number(url.searchParams.get("days") || 365)));
    const groupBy = String(url.searchParams.get("groupBy") || "source");
    const onlyOrderable = url.searchParams.get("onlyOrderable") === "1" || url.searchParams.get("onlyOrderable") === "true";
    const rows = await getDailyHistory({ projectRoot, days, groupBy: groupBy === "dealer" ? "dealer" : "source", onlyOrderable });
    const csv = dailyRowsToCsv(rows);
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="pelletpreise-history-daily.csv"`,
      "cache-control": "no-store",
    });
    return res.end(csv);
  }

  if (req.method === "POST" && url.pathname === "/api/history/clear") {
    await clearHistory({ projectRoot });
    return jsonResponse(res, 200, { ok: true });
  }

  return jsonResponse(res, 404, { error: "Not found" });
}

async function handle(req, res) {
  const url = new URL(req.url, BASE_URL);
  try {
    if (url.pathname === "/" || url.pathname === "/pelletpreise") {
      res.writeHead(302, { location: "/pelletpreise/" });
      return res.end();
    }

    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);

    if (url.pathname === "/demo/html") {
      const query = normalizeQuery({
        postalCode: url.searchParams.get("postalCode"),
        quantityTons: url.searchParams.get("quantityTons"),
        product: url.searchParams.get("product"),
      });
      return textResponse(res, 200, demoHtml({ query }), "text/html; charset=utf-8");
    }

    const rootStatic = resolveRootStaticPath(url.pathname);
    if (rootStatic) {
      const data = await fs.readFile(rootStatic);
      res.writeHead(200, { "content-type": contentTypeFor(rootStatic), "cache-control": "no-store" });
      return res.end(data);
    }

    const filePath = resolveFrontendPath(url.pathname);
    if (!filePath) return textResponse(res, 404, "Not found");

    const data = await fs.readFile(filePath);
    res.writeHead(200, { "content-type": contentTypeFor(filePath), "cache-control": "no-store" });
    res.end(data);
  } catch (err) {
    if (url.pathname.startsWith("/api/")) return jsonResponse(res, 500, { error: err?.message || String(err) });
    return textResponse(res, 500, err?.message || "Server error");
  }
}

const server = http.createServer(handle);
server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Pelletpreise-Server läuft: ${BASE_URL}/pelletpreise/`);
});
