import fs from "node:fs/promises";
import path from "node:path";

const FILE_VERSION = 1;

function alertsPath({ projectRoot }) {
  return path.join(projectRoot, "server", "data", "alerts.json");
}

export function defaultAlerts() {
  return { version: FILE_VERSION, rules: [] };
}

function normalizeRule(input) {
  const obj = input && typeof input === "object" ? input : {};
  const id = obj.id ? String(obj.id) : null;
  if (!id) return null;

  const threshold = Number(obj.thresholdEurPerTon);
  const thresholdEurPerTon = Number.isFinite(threshold) && threshold > 0 ? threshold : null;
  if (thresholdEurPerTon == null) return null;

  const sourceId = obj.sourceId ? String(obj.sourceId) : null;
  if (!sourceId) return null;

  const query = obj.query && typeof obj.query === "object" ? obj.query : null;
  const matchQuery = Boolean(obj.matchQuery);

  const minIntervalHoursRaw = obj.minIntervalHours == null ? 12 : Number(obj.minIntervalHours);
  const minIntervalHours =
    Number.isFinite(minIntervalHoursRaw) && minIntervalHoursRaw > 0 ? Math.max(1, Math.min(168, minIntervalHoursRaw)) : 12;
  const rearmRaw = obj.rearmAboveEurPerTon == null ? thresholdEurPerTon + 2 : Number(obj.rearmAboveEurPerTon);
  const rearmAboveEurPerTon = Number.isFinite(rearmRaw) ? Math.max(thresholdEurPerTon, rearmRaw) : thresholdEurPerTon + 2;

  return {
    id,
    enabled: Boolean(obj.enabled ?? true),
    name: obj.name ? String(obj.name).slice(0, 120) : "",
    sourceId,
    thresholdEurPerTon,
    direction: "below",
    matchQuery,
    query: matchQuery ? query : null,
    minIntervalHours,
    repeatWhileBelow: Boolean(obj.repeatWhileBelow ?? false),
    rearmAboveEurPerTon,
    // runtime state
    lastBelow: Boolean(obj.lastBelow ?? false),
    lastSentAt: obj.lastSentAt ? String(obj.lastSentAt) : null,
    lastSentPriceEurPerTon: typeof obj.lastSentPriceEurPerTon === "number" ? obj.lastSentPriceEurPerTon : null,
    lastError: obj.lastError ? String(obj.lastError).slice(0, 500) : null,
  };
}

function normalizeAlerts(input) {
  const base = defaultAlerts();
  const obj = input && typeof input === "object" ? input : {};
  const rulesRaw = Array.isArray(obj.rules) ? obj.rules : [];
  const rules = rulesRaw.map(normalizeRule).filter(Boolean);
  return { ...base, ...obj, version: FILE_VERSION, rules };
}

export async function readAlerts({ projectRoot }) {
  const filePath = alertsPath({ projectRoot });
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeAlerts(parsed);
  } catch {
    return defaultAlerts();
  }
}

export async function writeAlerts({ projectRoot, alerts }) {
  const filePath = alertsPath({ projectRoot });
  const tmp = `${filePath}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const normalized = normalizeAlerts(alerts);
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

export function patchAlerts(current, patch) {
  const cur = current && typeof current === "object" ? current : defaultAlerts();
  const p = patch && typeof patch === "object" ? patch : {};
  const next = { ...cur };
  if (Array.isArray(p.rules)) next.rules = p.rules.map(normalizeRule).filter(Boolean);
  return normalizeAlerts(next);
}

function queryMatches(ruleQuery, itemQuery) {
  if (!ruleQuery || typeof ruleQuery !== "object") return true;
  if (!itemQuery || typeof itemQuery !== "object") return false;
  const keys = ["postalCode", "quantityTons", "product"];
  for (const k of keys) {
    if (ruleQuery[k] == null || ruleQuery[k] === "") continue;
    if (String(ruleQuery[k]) !== String(itemQuery[k])) return false;
  }
  return true;
}

function shouldSendNow(rule, nowMs, currentPrice) {
  if (!rule.enabled) return { send: false, reason: "disabled" };

  const isBelow = typeof currentPrice === "number" && currentPrice <= rule.thresholdEurPerTon;
  if (!isBelow) {
    const rearmed = currentPrice > Number(rule.rearmAboveEurPerTon ?? rule.thresholdEurPerTon);
    return { send: false, reason: rearmed ? "rearmed" : "above_threshold", setBelow: rearmed ? false : rule.lastBelow };
  }

  const lastSentAtMs = rule.lastSentAt ? Date.parse(rule.lastSentAt) : 0;
  const minIntervalMs = Number(rule.minIntervalHours || 12) * 60 * 60 * 1000;
  const intervalOk = !lastSentAtMs || nowMs - lastSentAtMs >= minIntervalMs;

  // Edge trigger (crossing): send immediately when it becomes below.
  const edge = !rule.lastBelow;
  if (edge) return { send: true, reason: "edge", setBelow: true };
  if (rule.repeatWhileBelow && intervalOk) return { send: true, reason: "interval", setBelow: true };
  return { send: false, reason: "cooldown", setBelow: true };
}

export function evaluateAlerts({ alerts, items, now = new Date() } = {}) {
  const cur = normalizeAlerts(alerts);
  const nowMs = now.getTime();
  const results = [];

  // Build per-source latest item from this run (items come from the same scrape run).
  const latestBySource = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const sourceId = String(item.sourceId || "");
    if (!sourceId) continue;
    latestBySource.set(sourceId, item);
  }

  const nextRules = cur.rules.map((rule) => {
    if (!rule || typeof rule !== "object") return rule;
    const sourceId = String(rule.sourceId || "");
    const item = latestBySource.get(sourceId) || null;
    if (!item) return rule;
    if (rule.matchQuery && !queryMatches(rule.query, item.query)) return rule;
    if (!item.ok || typeof item.priceEurPerTon !== "number") return rule;

    const decision = shouldSendNow(rule, nowMs, item.priceEurPerTon);
    const updated = { ...rule, lastBelow: decision.setBelow ?? rule.lastBelow };

    if (decision.send) {
      results.push({ rule, item, reason: decision.reason });
    }

    return updated;
  });

  return { alerts: { ...cur, rules: nextRules }, triggers: results };
}
