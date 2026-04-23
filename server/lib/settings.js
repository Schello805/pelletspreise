import fs from "node:fs/promises";
import path from "node:path";

const TIME_ZONE = "Europe/Berlin";
const FILE_VERSION = 1;

function settingsPath({ projectRoot }) {
  return path.join(projectRoot, "server", "data", "settings.json");
}

function berlinParts(date = new Date()) {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, p) => (p.type !== "literal" ? { ...acc, [p.type]: p.value } : acc), {});
}

export function berlinDateKey(date = new Date()) {
  const parts = berlinParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function berlinHour(date = new Date()) {
  const parts = berlinParts(date);
  const h = Number(parts.hour);
  return Number.isFinite(h) ? h : null;
}

export function defaultSettings() {
  return {
    version: FILE_VERSION,
    autoDailyEnabled: true,
    autoDailyMinHour: 6,
    // Default query matches the pre-filled UI defaults.
    lastQuery: {
      postalCode: "91572",
      quantityTons: 3,
      product: "ENPLUS_A1_LOSE",
      options: {
        abladestellen: 1,
        qualitaet: "",
        zahlungsart: "beliebig",
        lieferfrist: "Standard",
        tageszeit: "ganztägig",
        schlauchlaenge: 30,
        twgroesse: "egal",
      },
    },
    lastAutoRunDateKey: null,
    lastAutoRunAt: null,
    lastAutoError: null,
  };
}

function normalizeSettings(input) {
  const base = defaultSettings();
  const obj = input && typeof input === "object" ? input : {};
  const lastQuery = obj.lastQuery && typeof obj.lastQuery === "object" ? obj.lastQuery : base.lastQuery;
  return {
    ...base,
    ...obj,
    version: FILE_VERSION,
    autoDailyEnabled: Boolean(obj.autoDailyEnabled ?? base.autoDailyEnabled),
    autoDailyMinHour: Math.max(0, Math.min(23, Number(obj.autoDailyMinHour ?? base.autoDailyMinHour))),
    lastQuery,
    lastAutoRunDateKey: obj.lastAutoRunDateKey ? String(obj.lastAutoRunDateKey) : null,
    lastAutoRunAt: obj.lastAutoRunAt ? String(obj.lastAutoRunAt) : null,
    lastAutoError: obj.lastAutoError ? String(obj.lastAutoError) : null,
  };
}

export async function readSettings({ projectRoot }) {
  const filePath = settingsPath({ projectRoot });
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeSettings(parsed);
  } catch {
    return defaultSettings();
  }
}

export async function writeSettings({ projectRoot, settings }) {
  const filePath = settingsPath({ projectRoot });
  const tmp = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const normalized = normalizeSettings(settings);
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

export function patchSettings(current, patch) {
  const next = { ...(current || defaultSettings()) };
  const p = patch && typeof patch === "object" ? patch : {};
  if (p.autoDailyEnabled != null) next.autoDailyEnabled = Boolean(p.autoDailyEnabled);
  return next;
}

