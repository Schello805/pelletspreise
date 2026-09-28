import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";

import { readAlerts, writeAlerts } from "./alerts.js";
import { clearCache } from "./cache.js";
import { appendHistory, clearHistory, ensureDataFiles, getPaths, readHistoryAll } from "./store.js";
import { readSettings, writeSettings } from "./settings.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const FORMAT = "pelletpreis-checker-backup";
const FORMAT_VERSION = 1;
const MAX_HISTORY_ITEMS = 200_000;
const MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;

function normalizeDays(value) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error("Der Backup-Zeitraum muss zwischen 1 und 3650 Tagen liegen.");
  }
  return days;
}

async function readStoredSources({ projectRoot }) {
  const paths = await ensureDataFiles({ projectRoot });
  const raw = await fs.readFile(paths.sourcesPath, "utf8");
  const sources = JSON.parse(raw);
  if (!Array.isArray(sources)) throw new Error("Die gespeicherten Quellen sind ungültig.");
  return sources;
}

function filterHistoryByDays(items, days, now = new Date()) {
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  return items.filter((item) => {
    const retrievedAtMs = Date.parse(String(item?.retrievedAt || ""));
    return Number.isFinite(retrievedAtMs) && retrievedAtMs >= cutoffMs;
  });
}

function validateBackupPayload(input) {
  if (!input || typeof input !== "object") throw new Error("Die Backup-Datei enthält keine gültigen Daten.");
  if (input.format !== FORMAT || Number(input.formatVersion) !== FORMAT_VERSION) {
    throw new Error("Dieses Backup-Format wird nicht unterstützt.");
  }
  if (!input.data || typeof input.data !== "object") throw new Error("Im Backup fehlt der Datenbereich.");
  if (!Array.isArray(input.data.sources)) throw new Error("Im Backup fehlen gültige Quellen.");
  if (!Array.isArray(input.data.history)) throw new Error("Im Backup fehlt eine gültige Historie.");
  if (!input.data.settings || typeof input.data.settings !== "object") throw new Error("Im Backup fehlen gültige Einstellungen.");
  if (!input.data.alerts || typeof input.data.alerts !== "object") throw new Error("Im Backup fehlen gültige Alarme.");
  if (input.data.history.length > MAX_HISTORY_ITEMS) throw new Error(`Das Backup enthält mehr als ${MAX_HISTORY_ITEMS} Historieneinträge.`);
  return input;
}

export async function createBackup({ projectRoot, days = 30, includeAllHistory = false, now = new Date() }) {
  const normalizedDays = includeAllHistory ? null : normalizeDays(days);
  const [sources, settings, alerts, allHistory] = await Promise.all([
    readStoredSources({ projectRoot }),
    readSettings({ projectRoot }),
    readAlerts({ projectRoot }),
    readHistoryAll({ projectRoot, maxLines: MAX_HISTORY_ITEMS }),
  ]);
  const history = includeAllHistory ? allHistory : filterHistoryByDays(allHistory, normalizedDays, now);
  const payload = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    createdAt: now.toISOString(),
    historyDays: normalizedDays,
    app: { name: "Pelletpreis-Checker" },
    data: { sources, settings, alerts, history },
    summary: {
      sources: sources.filter((source) => !source?.deleted && !source?.__deleted).length,
      alerts: Array.isArray(alerts.rules) ? alerts.rules.length : 0,
      historyItems: history.length,
      containsSecrets: Boolean(settings?.ai?.apiKey),
    },
  };
  const buffer = await gzipAsync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 9 });
  return { buffer, payload };
}

export async function parseBackup(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("Die Backup-Datei ist leer.");
  let raw;
  try {
    raw = await gunzipAsync(buffer, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch {
    throw new Error("Die Backup-Datei ist beschädigt oder nicht komprimiert.");
  }
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Die Backup-Datei enthält kein gültiges JSON.");
  }
  return validateBackupPayload(payload);
}

async function writeStoredSources({ projectRoot, sources }) {
  const { sourcesPath } = await ensureDataFiles({ projectRoot });
  const tmp = `${sourcesPath}.restore.tmp`;
  await fs.writeFile(tmp, JSON.stringify(sources, null, 2), "utf8");
  await fs.rename(tmp, sourcesPath);
}

async function applyBackupPayload({ projectRoot, payload }) {
  await writeStoredSources({ projectRoot, sources: payload.data.sources });
  await writeSettings({ projectRoot, settings: payload.data.settings });
  await writeAlerts({ projectRoot, alerts: payload.data.alerts });
  await clearHistory({ projectRoot });
  for (const item of payload.data.history) await appendHistory({ projectRoot, item });
  await clearCache({ projectRoot });
}

async function saveSafetyBackup({ projectRoot, buffer, now = new Date() }) {
  const { dataDir } = getPaths({ projectRoot });
  const backupDir = path.join(dataDir, "backups");
  await fs.mkdir(backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(backupDir, `vor-restore-${stamp}.json.gz`);
  await fs.writeFile(filePath, buffer);

  const entries = await fs.readdir(backupDir, { withFileTypes: true });
  const safetyFiles = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("vor-restore-") && entry.name.endsWith(".json.gz"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  await Promise.all(safetyFiles.slice(5).map((name) => fs.unlink(path.join(backupDir, name)).catch(() => {})));
  return filePath;
}

export async function restoreBackup({ projectRoot, buffer }) {
  const payload = await parseBackup(buffer);
  const current = await createBackup({ projectRoot, includeAllHistory: true });
  const safetyBackupPath = await saveSafetyBackup({ projectRoot, buffer: current.buffer });
  try {
    await applyBackupPayload({ projectRoot, payload });
  } catch (error) {
    await applyBackupPayload({ projectRoot, payload: current.payload }).catch(() => {});
    throw error;
  }
  return {
    restoredAt: new Date().toISOString(),
    createdAt: payload.createdAt,
    historyDays: payload.historyDays,
    summary: payload.summary,
    safetyBackupPath,
  };
}
