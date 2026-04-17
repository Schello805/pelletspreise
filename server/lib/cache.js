import fs from "node:fs/promises";
import path from "node:path";

import { getDb } from "./db.js";

const TIME_ZONE = "Europe/Berlin";
const CACHE_VERSION = 1;
let triedMigrateToDb = false;

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function berlinDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, p) => (p.type !== "literal" ? { ...acc, [p.type]: p.value } : acc), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function makeKey({ sourceId, query }) {
  return `${String(sourceId || "")}|${stableStringify(query)}`;
}

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

export function getCachePath({ projectRoot }) {
  return path.join(projectRoot, "server", "data", "cache.json");
}

export async function readCache({ projectRoot }) {
  const filePath = getCachePath({ projectRoot });
  const data = await readJson(filePath);
  if (!data || typeof data !== "object") return { version: CACHE_VERSION, items: {} };
  if (data.version !== CACHE_VERSION) return { version: CACHE_VERSION, items: {} };
  if (!data.items || typeof data.items !== "object") return { version: CACHE_VERSION, items: {} };
  return data;
}

export async function writeCache({ projectRoot, cache }) {
  const filePath = getCachePath({ projectRoot });
  const normalized = {
    version: CACHE_VERSION,
    items: cache?.items && typeof cache.items === "object" ? cache.items : {},
  };
  await writeJsonAtomic(filePath, normalized);
}

export async function getCachedResult({ projectRoot, sourceId, query }) {
  const db = await getDb({ projectRoot });
  if (db) {
    if (!triedMigrateToDb) {
      triedMigrateToDb = true;
      try {
        const migrated = db.prepare("SELECT value FROM meta WHERE key = ?").get("migrated_cache_json")?.value === "1";
        if (!migrated) {
          const fileCache = await readCache({ projectRoot });
          const today = berlinDateKey();
          const insert = db.prepare(
            "INSERT INTO cache (key, dateKey, storedAt, json) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET dateKey=excluded.dateKey, storedAt=excluded.storedAt, json=excluded.json",
          );
          const tx = db.transaction((entries) => {
            for (const [k, v] of entries) {
              if (!v || typeof v !== "object") continue;
              if (v.dateKey !== today) continue;
              if (!v.result || typeof v.result !== "object" || !v.result.ok) continue;
              insert.run(String(k), today, String(v.storedAt || new Date().toISOString()), JSON.stringify(v.result));
            }
          });
          tx(Object.entries(fileCache.items || {}));
          db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("migrated_cache_json", "1");
        }
      } catch {
        // ignore
      }
    }

    const key = makeKey({ sourceId, query });
    const row = db.prepare("SELECT json FROM cache WHERE key = ? AND dateKey = ?").get(key, berlinDateKey());
    if (!row || !row.json) return null;
    try {
      const result = JSON.parse(row.json);
      if (!result || typeof result !== "object") return null;
      if (!result.ok) return null;
      return { ...result, cached: true };
    } catch {
      return null;
    }
  }

  const cache = await readCache({ projectRoot });
  const key = makeKey({ sourceId, query });
  const item = cache.items[key];
  if (!item || typeof item !== "object") return null;
  if (item.dateKey !== berlinDateKey()) return null;
  if (!item.result || typeof item.result !== "object") return null;
  if (!item.result.ok) return null;
  return { ...item.result, cached: true };
}

export async function setCachedResult({ projectRoot, sourceId, query, result }) {
  if (!result || typeof result !== "object") return;
  if (!result.ok) return;

  const db = await getDb({ projectRoot });
  if (db) {
    const key = makeKey({ sourceId, query });
    const json = JSON.stringify(result);
    db.prepare(
      "INSERT INTO cache (key, dateKey, storedAt, json) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET dateKey=excluded.dateKey, storedAt=excluded.storedAt, json=excluded.json",
    ).run(key, berlinDateKey(), new Date().toISOString(), json);
    return;
  }

  const cache = await readCache({ projectRoot });
  const key = makeKey({ sourceId, query });
  cache.items[key] = {
    dateKey: berlinDateKey(),
    storedAt: new Date().toISOString(),
    result,
  };
  await writeCache({ projectRoot, cache });
}

export async function pruneCache({ projectRoot }) {
  const db = await getDb({ projectRoot });
  if (db) {
    db.prepare("DELETE FROM cache WHERE dateKey <> ?").run(berlinDateKey());
    return;
  }

  const cache = await readCache({ projectRoot });
  const today = berlinDateKey();
  const nextItems = {};
  for (const [k, v] of Object.entries(cache.items)) {
    if (v && typeof v === "object" && v.dateKey === today) nextItems[k] = v;
  }
  await writeCache({ projectRoot, cache: { version: CACHE_VERSION, items: nextItems } });
}
