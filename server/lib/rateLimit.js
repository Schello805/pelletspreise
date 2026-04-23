import fs from "node:fs/promises";
import path from "node:path";

const TIME_ZONE = "Europe/Berlin";
const FILE_VERSION = 1;

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

function fmtBerlinTime(date) {
  return new Intl.DateTimeFormat("de-DE", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" }).format(date);
}

function fmtBerlinDateTime(date) {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function runsFilePath({ projectRoot }) {
  return path.join(projectRoot, "server", "data", "scrape-runs.json");
}

async function readFileRuns({ projectRoot }) {
  const filePath = runsFilePath({ projectRoot });
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const obj = JSON.parse(raw);
    const items = Array.isArray(obj?.items) ? obj.items : [];
    return { version: FILE_VERSION, items };
  } catch {
    return { version: FILE_VERSION, items: [] };
  }
}

async function writeFileRuns({ projectRoot, data }) {
  const filePath = runsFilePath({ projectRoot });
  const tmp = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const normalized = { version: FILE_VERSION, items: Array.isArray(data?.items) ? data.items : [] };
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

export async function readRunsToday({ projectRoot, now = new Date() } = {}) {
  const dateKey = berlinDateKey(now);
  const file = await readFileRuns({ projectRoot });
  return (file.items || [])
    .filter((it) => it && typeof it === "object" && String(it.dateKey || "") === dateKey && typeof it.startedAt === "string")
    .map((it) => new Date(it.startedAt))
    .filter((d) => Number.isFinite(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
}

export async function recordRun({ projectRoot, startedAt = new Date() } = {}) {
  const dt = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const startedAtIso = dt.toISOString();
  const dateKey = berlinDateKey(dt);

  const file = await readFileRuns({ projectRoot });
  const items = Array.isArray(file.items) ? file.items : [];
  items.push({ startedAt: startedAtIso, dateKey });

  // Keep file small: only last 90 days.
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const pruned = items.filter((it) => {
    const t = Date.parse(String(it?.startedAt || ""));
    return Number.isFinite(t) ? t >= cutoff : false;
  });
  await writeFileRuns({ projectRoot, data: { version: FILE_VERSION, items: pruned } });
}

export async function checkScrapeAllowance({
  projectRoot,
  now = new Date(),
  maxRunsPerDay = 2,
  minGapHours = 10,
} = {}) {
  const runs = await readRunsToday({ projectRoot, now });
  const minGapMs = Number(minGapHours) * 60 * 60 * 1000;

  if (runs.length >= maxRunsPerDay) {
    return {
      allowed: false,
      statusCode: 429,
      error: `Tageslimit erreicht (${runs.length}/${maxRunsPerDay}). Bitte morgen erneut versuchen.`,
      details: { runsToday: runs.map((d) => d.toISOString()) },
    };
  }

  if (runs.length === 1) {
    const first = runs[0];
    const earliestSecond = new Date(first.getTime() + minGapMs);
    if (now.getTime() < earliestSecond.getTime()) {
      return {
        allowed: false,
        statusCode: 429,
        error: `Heute lief bereits um ${fmtBerlinTime(first)} eine Abfrage. Die nächste ist frühestens ab ${fmtBerlinDateTime(
          earliestSecond,
        )} erlaubt (mind. ${minGapHours}h Abstand).`,
        details: { runsToday: runs.map((d) => d.toISOString()), nextAllowedAt: earliestSecond.toISOString() },
      };
    }
  }

  return { allowed: true, statusCode: 200, error: null, details: { runsToday: runs.map((d) => d.toISOString()) } };
}

