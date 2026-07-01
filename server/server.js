import http from "node:http";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendHistory, clearHistory, deletedDefaultSourceTombstone, readHistory, readHistoryAll, readSources, resetSourcesToDefaults, writeSources } from "./lib/store.js";
import { getCachedResult, pruneCache, setCachedResult } from "./lib/cache.js";
import { dailyRowsToCsv, getDailyHistory, rawItemsToCsv } from "./lib/history.js";
import { checkScrapeAllowance, getScrapeStatus, readRunsToday, recordRun } from "./lib/rateLimit.js";
import { berlinDateKey, berlinHour, patchSettings, publicSettings, readSettings, writeSettings } from "./lib/settings.js";
import { evaluateAlerts, patchAlerts, readAlerts, writeAlerts } from "./lib/alerts.js";
import { getEmailConfig, sendAlertEmail } from "./lib/email.js";
import { annotatePriceAnomalies } from "./lib/anomaly.js";
import { applyPlaceholders, jsonResponse, newId, normalizeQuery, parseGermanNumber, readJsonBody, textResponse } from "./lib/util.js";
import { runSource } from "./scrape/runner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

// Hinweis: In manchen Sandbox-Umgebungen sind nicht alle Ports erlaubt. 8000 ist meist freigeschaltet.
const PORT = Number(process.env.PORT || 8000);
const HOST = String(process.env.HOST || "127.0.0.1");
const BASE_URL = String(process.env.BASE_URL || `http://${HOST}:${PORT}`);
function readAppVersion() {
  try {
    const pkg = JSON.parse(fsSync.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
    return String(pkg?.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

const APP_VERSION = readAppVersion();
const GITHUB_REPO = "Schello805/pelletspreise";
const APP_USERNAME = String(process.env.APP_USERNAME || "admin");
const APP_PASSWORD = String(process.env.APP_PASSWORD || "");
const ALLOW_FRONTEND_UPDATE = ["1", "true", "yes", "on"].includes(String(process.env.ALLOW_FRONTEND_UPDATE || "").toLowerCase());
const UPDATE_REQUEST_FILE = String(process.env.UPDATE_REQUEST_FILE || "/var/lib/pelletpreis-checker/update.request");
const UPDATE_PATH_UNIT_FILE = "/etc/systemd/system/pelletpreis-checker-update.path";

let remoteUpdateCache = { checkedAtMs: 0, ok: false, sha: null, date: null, error: null };
let dailyHistoryCache = new Map(); // key -> { atMs, sig, rows }
const AUTH_COOKIE = "pelletpreis_session";
const AUTH_SESSION_MS = 12 * 60 * 60 * 1000;
const REMEMBERED_AUTH_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

async function readLocalGitSha() {
  try {
    const headPath = path.join(projectRoot, ".git", "HEAD");
    const headRaw = String(await fs.readFile(headPath, "utf8")).trim();
    if (!headRaw) return null;
    if (headRaw.startsWith("ref:")) {
      const ref = headRaw.slice("ref:".length).trim();
      const refPath = path.join(projectRoot, ".git", ref);
      try {
        const sha = String(await fs.readFile(refPath, "utf8")).trim();
        if (sha) return sha;
      } catch {
        // fall through
      }
      // packed-refs fallback
      try {
        const packed = String(await fs.readFile(path.join(projectRoot, ".git", "packed-refs"), "utf8"));
        const line = packed
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith("#") && !l.startsWith("^") && l.endsWith(` ${ref}`));
        if (line) return line.split(/\s+/)[0] || null;
      } catch {
        // ignore
      }
      return null;
    }
    return headRaw;
  } catch {
    return null;
  }
}

function shortSha(sha) {
  const s = String(sha || "").trim();
  return /^[0-9a-f]{7,40}$/i.test(s) ? s.slice(0, 7) : null;
}

async function fetchRemoteMainSha({ force = false } = {}) {
  const now = Date.now();
  const maxAgeMs = 30 * 60 * 1000;
  if (!force && remoteUpdateCache.checkedAtMs && now - remoteUpdateCache.checkedAtMs < maxAgeMs) return remoteUpdateCache;

  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/commits/main`;
    const r = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "pelletpreis-checker/0.1 (+contact: info@schellenberger.biz)",
      },
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const data = await r.json().catch(() => null);
    const sha = data?.sha ? String(data.sha) : null;
    const date = data?.commit?.author?.date ? String(data.commit.author.date) : null;
    remoteUpdateCache = { checkedAtMs: now, ok: Boolean(sha), sha, date, error: null };
    return remoteUpdateCache;
  } catch (err) {
    remoteUpdateCache = { checkedAtMs: now, ok: false, sha: null, date: null, error: err?.message || String(err) };
    return remoteUpdateCache;
  }
}

async function scrapeRunInternal({ query, onlyDemo = false, persistCached = false } = {}) {
  const sources = await readSources({ projectRoot });
  const enabled = sources.filter((s) => s.enabled);
  const selected = onlyDemo ? enabled.filter((s) => s.kind === "demo") : enabled;

  await pruneCache({ projectRoot }).catch(() => {});

  const results = [];

  // 1) Cache pre-check for all selected sources (so we can enforce an overall daily limit
  // only when at least one source would actually run).
  const cachedChecks = await withLimit(
    6,
      selected.map((s) => async () => ({ source: s, cached: await getCachedResult({ projectRoot, sourceId: s.id, query, cacheHours: s.cacheHours ?? null }) })),
    );

  const httpToRun = [];
  const pwToRun = [];
  for (const item of cachedChecks) {
    if (item?.cached) {
      const nowIso = new Date().toISOString();
      results.push({
        ...item.cached,
        cached: true,
        cachedFromRetrievedAt: item.cached?.retrievedAt || null,
        retrievedAt: nowIso,
      });
    } else if (item?.source?.kind === "playwright") pwToRun.push(item.source);
    else if (item?.source) httpToRun.push(item.source);
  }

  const needsFreshRun = httpToRun.length > 0 || pwToRun.length > 0;
  let rateLimitInfo = null;
  if (needsFreshRun) {
    const allowance = await checkScrapeAllowance({ projectRoot });
    if (!allowance.allowed) {
      // UX: Do not hard-fail. Return cached values we already have, and mark the remaining sources as blocked.
      const nowIso = new Date().toISOString();
      rateLimitInfo = { error: allowance.error || "Abfrage nicht erlaubt.", details: allowance.details || {} };
      for (const s of [...httpToRun, ...pwToRun]) {
        results.push({
          ok: false,
          sourceId: s.id,
          sourceName: s.name,
          group: s.group || "offers",
          retrievedAt: nowIso,
          url: null,
          asOf: null,
          priceEurPerTon: null,
          totalEur: null,
          error: rateLimitInfo.error,
          rateLimited: true,
        });
      }
      // We deliberately do NOT record a run when blocked.
      const sortedBlocked = results.slice().sort((a, b) => {
        const ao = a && a.ok;
        const bo = b && b.ok;
        if (ao && bo) return (a.priceEurPerTon ?? Infinity) - (b.priceEurPerTon ?? Infinity);
        if (ao) return -1;
        if (bo) return 1;
        return 0;
      });
      return { ok: true, query, results: sortedBlocked, meta: { needsFreshRun: true, rateLimited: true, rateLimit: rateLimitInfo } };
    }
    await recordRun({ projectRoot }).catch(() => {});
  }

  // 2) HTTP-ish sources (concurrent)
  const httpTasks = httpToRun.map((s) => async () => {
    const fresh = await runSource({ source: s, query, baseUrl: BASE_URL });
    await setCachedResult({ projectRoot, sourceId: s.id, query, result: fresh }).catch(() => {});
    return fresh;
  });
  results.push(...(await withLimit(4, httpTasks)));

  // 3) Playwright sources (launch browser only if needed)
  if (pwToRun.length) {
    let playwrightBrowser = null;
    try {
      const playwright = await import("playwright");
      playwrightBrowser = await playwright.chromium.launch({ headless: true });
    } catch {
      playwrightBrowser = null;
    }
    try {
      const pwTasks = pwToRun.map((s) => async () => {
        const fresh = await runSource({ source: s, query, baseUrl: BASE_URL, sharedBrowser: playwrightBrowser });
        await setCachedResult({ projectRoot, sourceId: s.id, query, result: fresh }).catch(() => {});
        return fresh;
      });
      results.push(...(await withLimit(2, pwTasks)));
    } finally {
      if (playwrightBrowser) await playwrightBrowser.close().catch(() => {});
    }
  }

  const enrichedResults = await annotatePriceAnomalies({ projectRoot, results }).catch(() => results);
  const now = new Date().toISOString();
  const updatedSources = sources.map((s) => {
    if (!selected.some((sel) => sel.id === s.id)) return s;
    const result = enrichedResults.find((r) => String(r?.sourceId || "") === String(s.id));
    return {
      ...s,
      lastRunAt: now,
      ...(result?.ok ? { lastSuccessAt: now, lastError: null } : { lastError: String(result?.error || "Unbekannter Abruffehler").slice(0, 500) }),
    };
  });
  await writeSources({ projectRoot, sources: updatedSources });

  const historyModeById = new Map(updatedSources.map((s) => [String(s?.id || ""), normalizeHistoryMode(s?.historyMode)]));

  const persistedItems = [];
  for (const r of enrichedResults) {
    // Only persist non-cached runs (so daily caching keeps history clean).
    if (!persistCached && r && r.cached) continue;
    const sourceId = String(r?.sourceId || "");
    const mode = historyModeById.get(sourceId) || "auto";
    const prepared = applyHistoryModeToResult({ ...r, query }, mode);
    if (!prepared) continue;
    await appendHistory({ projectRoot, item: prepared });
    persistedItems.push(prepared);
  }

  // Evaluate alarm rules based on what we actually persisted.
  if (persistedItems.length) {
    try {
      const currentAlerts = await readAlerts({ projectRoot });
      const { alerts: nextAlerts, triggers } = evaluateAlerts({ alerts: currentAlerts, items: persistedItems });

      let nextRules = nextAlerts.rules.slice();
      for (const trig of triggers) {
        const rule = trig.rule;
        const item = trig.item;
        const price = item?.priceEurPerTon;
        const dateKey = berlinDateKey(new Date(item?.retrievedAt || new Date()));
        const subject = `Pelletpreis-Alarm: ${item.sourceName || item.sourceId} ≤ ${rule.thresholdEurPerTon} €/t`;
        const text = [
          `Auslöser: ${rule.name || rule.id}`,
          `Quelle: ${item.sourceName || item.sourceId}`,
          `Datum: ${dateKey}`,
          `Preis: ${typeof price === "number" ? `${price} €/t` : "—"}`,
          `Gesamt: ${typeof item.totalEur === "number" ? `${item.totalEur} €` : "—"}`,
          `PLZ: ${item.query?.postalCode || "—"}`,
          `Menge: ${item.query?.quantityTons || "—"} t`,
          `Produkt: ${item.query?.product || "—"}`,
          item.url ? `Link: ${item.url}` : "",
          "",
          "Hinweis: Dieser Alarm wird nur ausgelöst, wenn ein Wert in die Historie geschrieben wird (z. B. Auto-Run 1×/Tag).",
        ]
          .filter(Boolean)
          .join("\n");

        const idx = nextRules.findIndex((r) => String(r.id) === String(rule.id));
        if (idx < 0) continue;

        try {
          await sendAlertEmail({ subject, text });
          nextRules[idx] = { ...nextRules[idx], lastSentAt: new Date().toISOString(), lastSentPriceEurPerTon: price, lastError: null };
        } catch (err) {
          nextRules[idx] = { ...nextRules[idx], lastError: err?.message || String(err) };
        }
      }

      await writeAlerts({ projectRoot, alerts: { ...nextAlerts, rules: nextRules } });
    } catch {
      // ignore alert failures (must not break scrape)
    }
  }

  const sorted = enrichedResults.slice().sort((a, b) => {
    if (a.ok && b.ok) return (a.priceEurPerTon ?? Infinity) - (b.priceEurPerTon ?? Infinity);
    if (a.ok) return -1;
    if (b.ok) return 1;
    return 0;
  });

  return { ok: true, query, results: sorted, meta: { needsFreshRun, rateLimited: Boolean(rateLimitInfo), rateLimit: rateLimitInfo } };
}

async function tryAutoDailyScrape({ force = false } = {}) {
  const settings = await readSettings({ projectRoot });
  if (!settings.autoDailyEnabled) return { ok: true, skipped: true, reason: "disabled" };

  const now = new Date();
  const todayKey = berlinDateKey(now);
  if (!force && settings.lastAutoRunDateKey === todayKey) return { ok: true, skipped: true, reason: "already_ran" };

  const h = berlinHour(now);
  if (!force && typeof h === "number" && h < Number(settings.autoDailyMinHour || 0)) return { ok: true, skipped: true, reason: "too_early" };

  // If there was any fresh run today, we already have today's data -> do not auto-run again.
  const runsToday = await readRunsToday({ projectRoot, now }).catch(() => []);
  if (!force && runsToday.length) {
    await writeSettings({
      projectRoot,
      settings: { ...settings, lastAutoRunDateKey: todayKey, lastAutoRunAt: now.toISOString(), lastAutoError: null },
    }).catch(() => {});
    return { ok: true, skipped: true, reason: "already_has_data" };
  }

  let normalizedQuery = null;
  try {
    normalizedQuery = normalizeQuery(settings.lastQuery || {});
  } catch {
    normalizedQuery = null;
  }
  if (!normalizedQuery) {
    await writeSettings({
      projectRoot,
      settings: { ...settings, lastAutoRunDateKey: todayKey, lastAutoRunAt: now.toISOString(), lastAutoError: "Keine gültige Abfrage hinterlegt." },
    }).catch(() => {});
    return { ok: false, skipped: true, reason: "no_query" };
  }

  try {
    // Auto daily job should ensure that today's values appear in the history/chart,
    // even if the underlying run uses cached values (e.g. after a restart).
    await scrapeRunInternal({ query: normalizedQuery, onlyDemo: false, persistCached: true });
    await writeSettings({
      projectRoot,
      settings: { ...settings, lastAutoRunDateKey: todayKey, lastAutoRunAt: new Date().toISOString(), lastAutoError: null },
    }).catch(() => {});
    return { ok: true, skipped: false };
  } catch (err) {
    await writeSettings({
      projectRoot,
      settings: { ...settings, lastAutoRunDateKey: todayKey, lastAutoRunAt: new Date().toISOString(), lastAutoError: err?.message || String(err) },
    }).catch(() => {});
    return { ok: false, skipped: false, error: err?.message || String(err) };
  }
}

function normalizeExtract(ex) {
  if (!ex || typeof ex !== "object") return null;
  const out = {};
  if (ex.regex) out.regex = String(ex.regex);
  if (ex.regexAsOf) out.regexAsOf = String(ex.regexAsOf);
  if (ex.regexTotal) out.regexTotal = String(ex.regexTotal);
  return Object.keys(out).length ? out : null;
}

function normalizeHistoryMode(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "auto";
  if (v === "none" || v === "off") return "none";
  if (v === "best" || v === "best-only" || v === "beste") return "best";
  if (v === "auto") return "auto";
  return "auto";
}

function normalizeCacheHours(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return Math.max(0.25, Math.min(168, n)); // 15min .. 7d
}

function pickBestOfferFromList(offers) {
  const list = Array.isArray(offers) ? offers : [];
  let best = null;
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const total = typeof o.totalEur === "number" ? o.totalEur : Number.POSITIVE_INFINITY;
    const perTon = typeof o.priceEurPerTon === "number" ? o.priceEurPerTon : Number.POSITIVE_INFINITY;
    if (!best) {
      best = o;
      continue;
    }
    const bestTotal = typeof best.totalEur === "number" ? best.totalEur : Number.POSITIVE_INFINITY;
    const bestPerTon = typeof best.priceEurPerTon === "number" ? best.priceEurPerTon : Number.POSITIVE_INFINITY;
    if (total < bestTotal) best = o;
    else if (total === bestTotal && perTon < bestPerTon) best = o;
  }
  return best;
}

function applyHistoryModeToResult(result, historyMode) {
  const mode = normalizeHistoryMode(historyMode);
  if (mode === "none") return null;
  if (mode !== "best") return result;

  if (result && typeof result === "object" && Array.isArray(result.offers) && result.offers.length) {
    const best = pickBestOfferFromList(result.offers);
    if (!best) return { ...result, offers: [] };
    return {
      ...result,
      bestDealerName: result.bestDealerName ?? best.dealerName ?? null,
      priceEurPerTon: typeof best.priceEurPerTon === "number" ? best.priceEurPerTon : result.priceEurPerTon ?? null,
      totalEur: typeof best.totalEur === "number" ? best.totalEur : result.totalEur ?? null,
      offers: [best],
    };
  }
  return result;
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
  const allow = new Set([]);
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

function stripHtmlForSnippet(input) {
  return String(input || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPriceProbe(html) {
  const text = stripHtmlForSnippet(html).slice(0, 900_000);
  const euroPattern =
    /(?:(?:€|EUR)\s*(\d{1,4}(?:[.\s]\d{3})*(?:[,.]\d{1,2})?|\d{1,4})|(\d{1,4}(?:[.\s]\d{3})*(?:[,.]\d{1,2})?|\d{1,4})\s*(?:€|EUR))(?:\s*(?:\/|pro|je)\s*(?:Tonne|1000\s*kg|t))?/gi;
  const candidates = [];
  const seen = new Set();
  let match;
  while ((match = euroPattern.exec(text))) {
    const raw = match[0].trim();
    const numberText = match[1] || match[2] || "";
    const number = parseGermanNumber(numberText);
    if (!Number.isFinite(number) || number < 50 || number > 1500) continue;
    const start = Math.max(0, match.index - 110);
    const end = Math.min(text.length, match.index + raw.length + 110);
    const snippet = text.slice(start, end).trim();
    const context = snippet.toLowerCase();
    let score = 0;
    if (/(?:\/|pro|je)\s*(?:t|tonne|1000\s*kg)|€\s*\/\s*t|€\/t/.test(context)) score += 80;
    if (/pelletspreis|preis\s*(?:pro|je)\s*tonne|holzpellets?\s*lose/.test(context)) score += 45;
    if (/gesamtpreis|gesamt|inkl\.?\s*mwst|transport|zuschlag|pauschale|einblas|gutschein|versand|telefon|kontakt|liefer-?\s*und/.test(context)) score -= 85;
    if (number >= 200 && number <= 700) score += 25;
    if (number > 900) score -= 35;
    const key = `${number}:${raw}:${snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      value: number,
      raw,
      snippet,
      score,
      reason: score >= 80 ? "starker €/t-Kontext" : score >= 30 ? "passender Preis-Kontext" : "prüfen",
      regex: `(\\d{2,4}(?:[\\.,]\\d{1,2})?)\\s*(?:€|EUR)\\s*(?:\\/|pro|je)\\s*(?:Tonne|1000\\s*kg|t)`,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.value - b.value);

  return {
    suggestedRegex: "(\\d{2,4}(?:[\\.,]\\d{1,2})?)\\s*(?:€|EUR)\\s*(?:/|pro|je)\\s*(?:Tonne|1000\\s*kg|t)",
    candidates: candidates.slice(0, 12),
  };
}

async function probeSourceUrl({ sourceUrl, query }) {
  const resolved = applyPlaceholders(sourceUrl, query);
  if (!/^https?:\/\//i.test(resolved) && !resolved.startsWith("/")) throw new Error("Bitte eine HTTP(S)-URL eingeben.");
  const finalUrl = resolved.startsWith("/") ? `${BASE_URL}${resolved}` : resolved;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18_000);
  try {
    const response = await fetch(finalUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": `pelletpreis-checker/${APP_VERSION} (+contact: ${process.env.CONTACT_EMAIL || "info@schellenberger.biz"})`,
        "accept-language": "de-DE,de;q=0.9,en;q=0.8",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} beim Prüfen der URL.`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("xml")) {
      throw new Error(`Unerwarteter Inhaltstyp: ${contentType || "unbekannt"}.`);
    }
    const html = await response.text();
    let probe = buildPriceProbe(html);
    if (!probe.candidates.length) {
      try {
        const playwright = await import("playwright");
        const browser = await playwright.chromium.launch({ headless: true });
        try {
          const page = await browser.newPage({ locale: "de-DE" });
          await page.goto(finalUrl, { waitUntil: "networkidle", timeout: 18_000 });
          const rendered = await page.content();
          const renderedProbe = buildPriceProbe(rendered);
          if (renderedProbe.candidates.length) probe = { ...renderedProbe, rendered: true };
        } finally {
          await browser.close().catch(() => {});
        }
      } catch {
        // Optional fallback only; HTTP probe result remains valid.
      }
    }
    return {
      url: response.url || finalUrl,
      bytes: Buffer.byteLength(html, "utf8"),
      ...probe,
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function pageTextForAi({ sourceUrl, query }) {
  const resolved = applyPlaceholders(sourceUrl, query);
  if (!/^https?:\/\//i.test(resolved) && !resolved.startsWith("/")) throw new Error("Bitte eine HTTP(S)-URL eingeben.");
  const finalUrl = resolved.startsWith("/") ? `${BASE_URL}${resolved}` : resolved;
  const response = await fetch(finalUrl, {
    redirect: "follow",
    headers: {
      "user-agent": `pelletpreis-checker/${APP_VERSION} (+contact: ${process.env.CONTACT_EMAIL || "info@schellenberger.biz"})`,
      "accept-language": "de-DE,de;q=0.9,en;q=0.8",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} beim Prüfen der URL.`);
  let html = await response.text();
  let rendered = false;

  try {
    const probe = buildPriceProbe(html);
    if (!probe.candidates.length) {
      const playwright = await import("playwright");
      const browser = await playwright.chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ locale: "de-DE" });
        await page.goto(finalUrl, { waitUntil: "networkidle", timeout: 18_000 });
        html = await page.content();
        rendered = true;
      } finally {
        await browser.close().catch(() => {});
      }
    }
  } catch {
    // Rendering is optional; HTTP text is still useful.
  }

  return {
    url: response.url || finalUrl,
    rendered,
    text: stripHtmlForSnippet(html).slice(0, 40_000),
  };
}

async function callAiExtractor({ settings, pageText, query }) {
  const provider = String(settings?.ai?.provider || "").trim().toLowerCase();
  const apiKey = String(settings?.ai?.apiKey || "").trim();
  if (!provider || !apiKey) throw new Error("KI ist nicht konfiguriert. Bitte in System OpenAI oder Gemini API-Key hinterlegen.");

  const prompt = [
    "Du bist ein Extraktor für deutsche Holzpellet-Preisrechner.",
    "Finde den relevanten Pelletpreis pro Tonne für die aktuelle Abfrage.",
    "Ignoriere Gesamtpreis, MwSt., Lieferpauschalen, Transportkosten, Telefonnummern, Versandbedingungen und Kontaktinfos.",
    "Antworte ausschließlich als JSON mit diesen Feldern:",
    "{\"priceEurPerTon\": number|null, \"priceText\": string|null, \"totalEur\": number|null, \"confidence\": number, \"reason\": string}",
    "",
    `Abfrage: PLZ ${query.postalCode}, Menge ${query.quantityTons} t, Produkt ${query.product}`,
    "",
    "Seitentext:",
    pageText,
  ].join("\n");

  if (provider === "openai") {
    const model = String(settings.ai.model || "gpt-4o-mini").trim();
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Du extrahierst Preise strikt als JSON. Keine Markdown-Ausgabe." },
          { role: "user", content: prompt },
        ],
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message || `OpenAI Fehler ${response.status}`);
    return extractJsonObject(data?.choices?.[0]?.message?.content);
  }

  if (provider === "gemini") {
    const model = String(settings.ai.model || "gemini-1.5-flash").trim();
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message || `Gemini Fehler ${response.status}`);
    return extractJsonObject(data?.candidates?.[0]?.content?.parts?.[0]?.text);
  }

  throw new Error("Unbekannter KI-Anbieter.");
}

function normalizeAiExtraction(raw) {
  const priceEurPerTon = parseGermanNumber(raw?.priceEurPerTon);
  const totalEur = parseGermanNumber(raw?.totalEur);
  return {
    priceEurPerTon: Number.isFinite(priceEurPerTon) ? priceEurPerTon : null,
    priceText: raw?.priceText ? String(raw.priceText).trim() : null,
    totalEur: Number.isFinite(totalEur) ? totalEur : null,
    confidence: Math.max(0, Math.min(1, Number(raw?.confidence || 0))),
    reason: raw?.reason ? String(raw.reason).trim().slice(0, 600) : "",
  };
}

function readCookies(req) {
  const raw = String(req.headers.cookie || "");
  return raw.split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index < 0) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        // Ignore malformed cookies.
      }
    }
    return cookies;
  }, {});
}

function getAuthenticatedSession(req) {
  if (!APP_PASSWORD) return true;
  const raw = readCookies(req)[AUTH_COOKIE];
  if (!raw) return false;
  const [token, expiresAtRaw, signature] = String(raw).split(".");
  const expiresAt = Number(expiresAtRaw);
  if (!token || !signature || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  const expected = crypto.createHmac("sha256", APP_PASSWORD).update(`${token}.${expiresAt}`).digest("base64url");
  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length || !crypto.timingSafeEqual(provided, expectedBuffer)) return false;
  return { username: APP_USERNAME, expiresAt };
}

function hasValidPassword({ username, password }) {
  const supplied = Buffer.from(String(password || ""));
  const expected = Buffer.from(APP_PASSWORD);
  return String(username || "") === APP_USERNAME && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function makeSession(res, { remember = false } = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  const durationMs = remember ? REMEMBERED_AUTH_SESSION_MS : AUTH_SESSION_MS;
  const expiresAt = Date.now() + durationMs;
  const signature = crypto.createHmac("sha256", APP_PASSWORD).update(`${token}.${expiresAt}`).digest("base64url");
  const value = `${token}.${expiresAt}.${signature}`;
  res.setHeader("set-cookie", `${AUTH_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(durationMs / 1000)}`);
  return { username: APP_USERNAME, expiresAt };
}

function clearSession(req, res) {
  res.setHeader("set-cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
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

function getHistoryFilters(searchParams) {
  const postalCode = String(searchParams.get("postalCode") || "").trim();
  const product = String(searchParams.get("product") || "").trim();
  const sourceId = String(searchParams.get("sourceId") || "").trim();
  const dealerName = String(searchParams.get("dealerName") || "").trim();
  return {
    ...(postalCode ? { postalCode } : {}),
    ...(product ? { product } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(dealerName ? { dealerName } : {}),
  };
}

async function activeHistorySourceIds({ projectRoot }) {
  const sources = await readSources({ projectRoot });
  return new Set(sources.map((source) => String(source?.id || "")).filter(Boolean));
}

function filterDailyRowsBySources(rows, sourceIds) {
  if (!(sourceIds instanceof Set) || sourceIds.size === 0) return [];
  return rows.filter((row) => sourceIds.has(String(row?.sourceId || "")));
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    const session = getAuthenticatedSession(req);
    return jsonResponse(res, 200, {
      ok: true,
      required: Boolean(APP_PASSWORD),
      authenticated: Boolean(session),
      username: typeof session === "object" ? session.username : null,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    if (!APP_PASSWORD) return jsonResponse(res, 200, { ok: true, required: false, authenticated: true });
    const body = (await readJsonBody(req)) || {};
    if (!hasValidPassword({ username: body.username, password: body.password })) {
      return jsonResponse(res, 401, { error: "Benutzername oder Passwort ist falsch." });
    }
    const session = makeSession(res, { remember: Boolean(body.remember) });
    return jsonResponse(res, 200, { ok: true, required: true, authenticated: true, username: session.username, expiresAt: new Date(session.expiresAt).toISOString() });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    clearSession(req, res);
    return jsonResponse(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return jsonResponse(res, 200, { ok: true, version: APP_VERSION, baseUrl: BASE_URL });
  }

  if (req.method === "GET" && url.pathname === "/api/update") {
    const localSha = await readLocalGitSha();
    const local = { version: APP_VERSION, sha: localSha, rev: shortSha(localSha) };
    const remote = await fetchRemoteMainSha({ force: url.searchParams.get("force") === "1" });
    const latest = { sha: remote.sha, rev: shortSha(remote.sha), date: remote.date };
    const updateAvailable = Boolean(local.rev && latest.rev && local.rev !== latest.rev);
    const hint = [
      "Update (Debian/Proxmox LXC):",
      "  cd /opt/pelletpreis-checker/scripts",
      "  chmod +x update-pelletpreis-checker-debian13-lxc.sh",
      "  ./update-pelletpreis-checker-debian13-lxc.sh",
    ].join("\n");
    const updateRequested = await fs
      .access(UPDATE_REQUEST_FILE)
      .then(() => true)
      .catch(() => false);
    const frontendUpdateInstalled = await fs
      .access(UPDATE_PATH_UNIT_FILE)
      .then(() => true)
      .catch(() => false);
    return jsonResponse(res, 200, {
      ok: true,
      current: local,
      latest,
      updateAvailable,
      updateHint: hint,
      remoteOk: remote.ok,
      remoteError: remote.error,
      frontendUpdateEnabled: ALLOW_FRONTEND_UPDATE,
      frontendUpdateInstalled,
      frontendUpdateReady: Boolean(APP_PASSWORD && ALLOW_FRONTEND_UPDATE && frontendUpdateInstalled),
      updateRequested,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/update/run") {
    const frontendUpdateInstalled = await fs
      .access(UPDATE_PATH_UNIT_FILE)
      .then(() => true)
      .catch(() => false);
    if (!APP_PASSWORD || !ALLOW_FRONTEND_UPDATE || !frontendUpdateInstalled) {
      return jsonResponse(res, 403, {
        error: "Frontend-Update ist nicht bereit. Aktiviere APP_PASSWORD und ALLOW_FRONTEND_UPDATE=1 und führe einmal das aktuelle Install- oder Update-Script aus.",
      });
    }
    await fs.mkdir(path.dirname(UPDATE_REQUEST_FILE), { recursive: true });
    await fs.writeFile(UPDATE_REQUEST_FILE, JSON.stringify({ requestedAt: new Date().toISOString(), requestedFrom: req.socket.remoteAddress || null }), "utf8");
    return jsonResponse(res, 202, { ok: true, message: "Update angefordert. Die Webapp startet in Kürze neu." });
  }

  if (req.method === "GET" && url.pathname === "/api/scrape/status") {
    const settings = await readSettings({ projectRoot });
    const query = normalizeQuery(settings.lastQuery || {});
    const sources = await readSources({ projectRoot });
    const enabled = sources.filter((source) => source.enabled);
    const cache = await withLimit(
      6,
      enabled.map((source) => async () => {
        const result = await getCachedResult({ projectRoot, sourceId: source.id, query, cacheHours: source.cacheHours ?? null });
        const cachedAt = result?.retrievedAt || null;
        return {
          sourceId: source.id,
          sourceName: source.name,
          cached: Boolean(result),
          cachedAt,
          cacheHours: source.cacheHours ?? null,
          status: result ? "cached" : "needs_refresh",
          lastError: source.lastError || null,
        };
      }),
    );
    const rateLimit = await getScrapeStatus({ projectRoot });
    return jsonResponse(res, 200, { ok: true, query, rateLimit, sources: cache });
  }

  if (req.method === "GET" && url.pathname === "/api/diagnostics") {
    const dataDir = path.join(projectRoot, "server", "data");
    const diag = {
      ok: true,
      version: APP_VERSION,
      baseUrl: BASE_URL,
      dataDir,
      playwright: { moduleOk: false, chromiumOk: false, chromiumPath: null, error: null },
      security: { passwordProtection: Boolean(APP_PASSWORD), username: APP_PASSWORD ? APP_USERNAME : null },
      updates: {
        frontendUpdateEnabled: ALLOW_FRONTEND_UPDATE,
        frontendUpdateInstalled: await fs
          .access(UPDATE_PATH_UNIT_FILE)
          .then(() => true)
          .catch(() => false),
      },
    };
    try {
      const st = await fs.stat(dataDir);
      diag.dataDirExists = st.isDirectory();
    } catch {
      diag.dataDirExists = false;
    }

    // Playwright status (cached for 10 minutes).
    try {
      if (!globalThis.__pp_pw_cache || Date.now() - globalThis.__pp_pw_cache.checkedAtMs > 10 * 60 * 1000) {
        const out = { checkedAtMs: Date.now(), moduleOk: false, chromiumOk: false, chromiumPath: null, error: null };
        try {
          const pw = await import("playwright");
          out.moduleOk = true;
          const chromiumPath = pw?.chromium?.executablePath?.() || null;
          out.chromiumPath = chromiumPath;
          if (chromiumPath) {
            try {
              await fs.access(chromiumPath);
              out.chromiumOk = true;
            } catch {
              out.chromiumOk = false;
            }
          }
        } catch (err) {
          out.error = err?.message || String(err);
        }
        globalThis.__pp_pw_cache = out;
      }
      const c = globalThis.__pp_pw_cache;
      diag.playwright = { moduleOk: Boolean(c.moduleOk), chromiumOk: Boolean(c.chromiumOk), chromiumPath: c.chromiumPath, error: c.error };
    } catch (err) {
      diag.playwright.error = err?.message || String(err);
    }

    // Auto-run status
    try {
      const settings = await readSettings({ projectRoot });
      diag.settings = publicSettings(settings);
      diag.ai = {
        configured: Boolean(settings?.ai?.apiKey),
        provider: settings?.ai?.provider || null,
        model: settings?.ai?.model || null,
      };
    } catch {
      diag.settings = null;
      diag.ai = { configured: false, provider: null, model: null };
    }

    try {
      const [sources, rateLimit, email] = await Promise.all([readSources({ projectRoot }), getScrapeStatus({ projectRoot }), Promise.resolve(getEmailConfig())]);
      diag.rateLimit = rateLimit;
      diag.email = { configured: Boolean(email.ok), to: email.to || null };
      diag.sources = {
        enabled: sources.filter((s) => s.enabled).length,
        failed: sources.filter((s) => s.enabled && s.lastError).map((s) => ({ id: s.id, name: s.name, error: s.lastError, lastRunAt: s.lastRunAt || null })),
      };
      const entries = await Promise.all(
        ["history.jsonl", "cache.json", "alerts.json", "settings.json", "scrape-runs.json"].map(async (name) => {
          try {
            const stat = await fs.stat(path.join(dataDir, name));
            return { name, bytes: stat.size, exists: true };
          } catch {
            return { name, bytes: 0, exists: false };
          }
        }),
      );
      diag.storage = entries;
    } catch {
      // Diagnostics should remain available even when optional parts fail.
    }

    return jsonResponse(res, 200, diag);
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    const settings = await readSettings({ projectRoot });
    return jsonResponse(res, 200, { ok: true, settings: publicSettings(settings) });
  }

  if (req.method === "PUT" && url.pathname === "/api/settings") {
    const body = (await readJsonBody(req)) || {};
    const patch = body.settings || body.patch || body || {};
    const current = await readSettings({ projectRoot });
    const next = patchSettings(current, patch);
    await writeSettings({ projectRoot, settings: next });
    return jsonResponse(res, 200, { ok: true, settings: publicSettings(next) });
  }

  if (req.method === "GET" && url.pathname === "/api/alerts") {
    const alerts = await readAlerts({ projectRoot });
    return jsonResponse(res, 200, { ok: true, alerts });
  }

  if (req.method === "PUT" && url.pathname === "/api/alerts") {
    const body = (await readJsonBody(req)) || {};
    const patch = body.alerts || body.patch || body || {};
    const current = await readAlerts({ projectRoot });
    const next = patchAlerts(current, patch);
    await writeAlerts({ projectRoot, alerts: next });
    return jsonResponse(res, 200, { ok: true, alerts: next });
  }

  if (req.method === "GET" && url.pathname === "/api/email/config") {
    const cfg = getEmailConfig();
    return jsonResponse(res, 200, {
      ok: true,
      email: {
        configured: Boolean(cfg.ok),
        host: cfg.host ? String(cfg.host) : null,
        port: cfg.port,
        secure: Boolean(cfg.secure),
        from: cfg.from ? String(cfg.from) : null,
        to: cfg.to ? String(cfg.to) : null,
        hasAuth: Boolean(cfg.auth),
      },
    });
  }

  if (req.method === "POST" && url.pathname === "/api/email/test") {
    const body = (await readJsonBody(req)) || {};
    const subject = body?.subject ? String(body.subject) : "Pelletpreis-Checker: Testmail";
    const text =
      body?.text
        ? String(body.text)
        : `Das ist eine Testmail vom Pelletpreis-Checker.\n\nZeit: ${new Date().toISOString()}\nServer: ${BASE_URL}\n`;
    try {
      await sendAlertEmail({ subject, text });
      return jsonResponse(res, 200, { ok: true });
    } catch (err) {
      return jsonResponse(res, 500, { ok: false, error: err?.message || String(err) });
    }
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
	      historyMode: normalizeHistoryMode(s.historyMode),
	      cacheHours: normalizeCacheHours(s.cacheHours),
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
	      historyMode: normalizeHistoryMode(s.historyMode),
	      cacheHours: normalizeCacheHours(s.cacheHours),
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
	      ...(patch.historyMode !== undefined ? { historyMode: normalizeHistoryMode(patch.historyMode) } : {}),
	      ...(patch.cacheHours !== undefined ? { cacheHours: normalizeCacheHours(patch.cacheHours) } : {}),
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
    const tombstone = await deletedDefaultSourceTombstone({ projectRoot, id });
    if (tombstone) next.push(tombstone);
    await writeSources({ projectRoot, sources: next });
    return jsonResponse(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/sources/probe") {
    const body = (await readJsonBody(req)) || {};
    const query = normalizeQuery(body.query || {});
    const sourceUrl = String(body.url || "").trim();
    if (!sourceUrl) return jsonResponse(res, 400, { error: "URL fehlt." });
    const probe = await probeSourceUrl({ sourceUrl, query });
    return jsonResponse(res, 200, { ok: true, probe });
  }

  if (req.method === "POST" && url.pathname === "/api/sources/ai-analyze") {
    const body = (await readJsonBody(req)) || {};
    const query = normalizeQuery(body.query || {});
    const sourceUrl = String(body.url || "").trim();
    if (!sourceUrl) return jsonResponse(res, 400, { error: "URL fehlt." });
    const settings = await readSettings({ projectRoot });
    const page = await pageTextForAi({ sourceUrl, query });
    const raw = await callAiExtractor({ settings, pageText: page.text, query });
    const extraction = normalizeAiExtraction(raw);
    if (!Number.isFinite(extraction.priceEurPerTon)) {
      return jsonResponse(res, 422, { ok: false, error: "KI konnte keinen eindeutigen €/t-Preis erkennen.", extraction, page: { url: page.url, rendered: page.rendered } });
    }
    return jsonResponse(res, 200, { ok: true, extraction, page: { url: page.url, rendered: page.rendered } });
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
    // Persist last query so the auto-daily scheduler can run without user interaction.
    const cur = await readSettings({ projectRoot });
    await writeSettings({ projectRoot, settings: { ...cur, lastQuery: query } }).catch(() => {});

    try {
      const data = await scrapeRunInternal({ query, onlyDemo });
      return jsonResponse(res, 200, { ok: true, query: data.query, results: data.results, meta: data.meta || {} });
    } catch (err) {
      const status = err?.statusCode || err?.status || 500;
      const details = err?.details && typeof err.details === "object" ? err.details : {};
      return jsonResponse(res, status, { error: err?.message || String(err), ...details });
    }
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
    const filters = getHistoryFilters(url.searchParams);
    const gb = groupBy === "dealer" ? "dealer" : "source";
    const sourceIds = await activeHistorySourceIds({ projectRoot });
    let sig = "no-file";
    try {
      const hp = path.join(projectRoot, "server", "data", "history.jsonl");
      const st = await fs.stat(hp);
      sig = `${st.size}:${st.mtimeMs}`;
    } catch {
      // ignore
    }
    const sourceSig = Array.from(sourceIds).sort().join(",");
    const cacheKey = `${days}|${gb}|${onlyOrderable ? 1 : 0}|${sourceSig}|${JSON.stringify(filters)}`;
    const now = Date.now();
    const cached = dailyHistoryCache.get(cacheKey);
    if (cached && cached.sig === sig && now - cached.atMs < 30_000) {
      return jsonResponse(res, 200, { ok: true, days, groupBy: gb, onlyOrderable, filters, rows: cached.rows });
    }

    const rows = filterDailyRowsBySources(await getDailyHistory({ projectRoot, days, groupBy: gb, onlyOrderable, filters }), sourceIds);
    dailyHistoryCache.set(cacheKey, { atMs: now, sig, rows });
    // small cap
    if (dailyHistoryCache.size > 16) dailyHistoryCache = new Map(Array.from(dailyHistoryCache.entries()).slice(-16));
    return jsonResponse(res, 200, { ok: true, days, groupBy: gb, onlyOrderable, filters, rows });
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
    const filters = getHistoryFilters(url.searchParams);
    const sourceIds = await activeHistorySourceIds({ projectRoot });
    const rows = filterDailyRowsBySources(await getDailyHistory({ projectRoot, days, groupBy: groupBy === "dealer" ? "dealer" : "source", onlyOrderable, filters }), sourceIds);
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
    const filters = getHistoryFilters(url.searchParams);
    const sourceIds = await activeHistorySourceIds({ projectRoot });
    const rows = filterDailyRowsBySources(await getDailyHistory({ projectRoot, days, groupBy: groupBy === "dealer" ? "dealer" : "source", onlyOrderable, filters }), sourceIds);
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

    if (url.pathname.startsWith("/api/")) {
      const publicApi = new Set(["/api/health", "/api/update", "/api/auth/status", "/api/auth/login", "/api/auth/logout"]);
      if (!publicApi.has(url.pathname) && !getAuthenticatedSession(req)) {
        return jsonResponse(res, 401, { error: "Anmeldung erforderlich.", authRequired: true });
      }
      return await handleApi(req, res, url);
    }

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

  // Auto run: check periodically whether today's data is missing.
  // We keep this lightweight (no background work when disabled / before the minimum hour).
  const intervalMs = 10 * 60 * 1000;
  tryAutoDailyScrape().catch(() => {});
  setInterval(() => tryAutoDailyScrape().catch(() => {}), intervalMs).unref?.();
});
