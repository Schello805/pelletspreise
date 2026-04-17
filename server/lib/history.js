import { readHistoryAll } from "./store.js";

const TIME_ZONE = "Europe/Berlin";

function berlinDateKey(dateOrIso) {
  const d = dateOrIso ? new Date(dateOrIso) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("de-DE", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(d)
    .reduce((acc, p) => (p.type !== "literal" ? { ...acc, [p.type]: p.value } : acc), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function normalizeDealerName(value) {
  const s = String(value || "").trim();
  return s ? s : null;
}

function normalizeGroup(value) {
  const g = String(value || "").trim().toLowerCase();
  if (!g) return null;
  return g;
}

function observationBase(item) {
  const date = berlinDateKey(item?.retrievedAt) || berlinDateKey();
  return {
    date,
    retrievedAt: item?.retrievedAt || null,
    asOf: item?.asOf || null,
    sourceId: item?.sourceId || null,
    sourceName: item?.sourceName || null,
    url: item?.url || null,
    group: normalizeGroup(item?.group),
    query: item?.query || null,
  };
}

function expandToObservations(item) {
  const base = observationBase(item);
  if (!base.date || !base.sourceId) return [];
  if (!item?.ok) return [];

  // Offer sources: create one observation per offer (dealer-level).
  if (Array.isArray(item.offers) && item.offers.length) {
    return item.offers
      .map((o) => {
        const dealerName = normalizeDealerName(o?.dealerName) || normalizeDealerName(item?.bestDealerName);
        return {
          ...base,
          kind: "offer",
          dealerName,
          orderUrl: o?.orderUrl || null,
          deliveryBy: o?.deliveryBy || null,
          priceEurPerTon: isFiniteNumber(o?.priceEurPerTon) ? o.priceEurPerTon : null,
          totalEur: isFiniteNumber(o?.totalEur) ? o.totalEur : null,
        };
      })
      .filter((o) => o.priceEurPerTon != null);
  }

  // Single-value sources (averages or best-offer without per-dealer breakdown).
  return [
    {
      ...base,
      kind: base.group === "average" ? "average" : "offer",
      dealerName: normalizeDealerName(item?.bestDealerName),
      orderUrl: item?.orderUrl || null,
      deliveryBy: item?.deliveryBy || null,
      priceEurPerTon: isFiniteNumber(item?.priceEurPerTon) ? item.priceEurPerTon : null,
      totalEur: isFiniteNumber(item?.totalEur) ? item.totalEur : null,
    },
  ].filter((o) => o.priceEurPerTon != null);
}

function pickBestOffer(current, next) {
  const ct = isFiniteNumber(current?.totalEur) ? current.totalEur : Number.POSITIVE_INFINITY;
  const nt = isFiniteNumber(next?.totalEur) ? next.totalEur : Number.POSITIVE_INFINITY;
  if (nt < ct) return next;
  if (nt > ct) return current;
  const cp = isFiniteNumber(current?.priceEurPerTon) ? current.priceEurPerTon : Number.POSITIVE_INFINITY;
  const np = isFiniteNumber(next?.priceEurPerTon) ? next.priceEurPerTon : Number.POSITIVE_INFINITY;
  return np < cp ? next : current;
}

export async function getDailyHistory({ projectRoot, days = 365, groupBy = "source", onlyOrderable = false } = {}) {
  const maxLines = 80_000;
  const items = await readHistoryAll({ projectRoot, maxLines });

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Math.max(1, Math.min(3650, Number(days) || 365)) + 1);
  const cutoffKey = berlinDateKey(cutoff);

  const map = new Map();
  for (const item of items) {
    for (const obs of expandToObservations(item)) {
      if (!obs.date) continue;
      if (cutoffKey && obs.date < cutoffKey) continue;
      if (onlyOrderable && !(obs.orderUrl && /^https?:\/\//i.test(String(obs.orderUrl)))) continue;

      const dealerPart = groupBy === "dealer" ? `|${obs.dealerName || "—"}` : "";
      const key = `${obs.date}|${obs.sourceId}${dealerPart}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { ...obs, offersCount: obs.kind === "offer" ? 1 : 0 });
        continue;
      }

      // For dealer grouping, duplicates can happen (should be rare) -> keep best (min total).
      if (obs.kind === "offer") {
        const best = pickBestOffer(existing, obs);
        map.set(key, { ...best, offersCount: existing.offersCount + 1 });
      } else {
        map.set(key, { ...existing, ...obs });
      }
    }
  }

  const rows = Array.from(map.values()).sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const sa = String(a.sourceName || a.sourceId || "");
    const sb = String(b.sourceName || b.sourceId || "");
    const sCmp = sa.localeCompare(sb, "de");
    if (sCmp !== 0) return sCmp;
    return String(a.dealerName || "").localeCompare(String(b.dealerName || ""), "de");
  });

  return rows;
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n\r;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function dailyRowsToCsv(rows) {
  const header = [
    "date",
    "sourceId",
    "sourceName",
    "group",
    "kind",
    "dealerName",
    "priceEurPerTon",
    "totalEur",
    "deliveryBy",
    "orderUrl",
    "url",
    "asOf",
    "retrievedAt",
    "postalCode",
    "quantityTons",
    "product",
  ];
  const lines = [header.join(";")];
  for (const r of rows || []) {
    const q = r.query || {};
    const line = [
      r.date,
      r.sourceId,
      r.sourceName,
      r.group,
      r.kind,
      r.dealerName,
      r.priceEurPerTon,
      r.totalEur,
      r.deliveryBy,
      r.orderUrl,
      r.url,
      r.asOf,
      r.retrievedAt,
      q.postalCode,
      q.quantityTons,
      q.product,
    ].map(csvEscape);
    lines.push(line.join(";"));
  }
  return `${lines.join("\n")}\n`;
}

export function rawItemsToCsv(items) {
  const header = [
    "retrievedAt",
    "sourceId",
    "sourceName",
    "group",
    "ok",
    "error",
    "priceEurPerTon",
    "totalEur",
    "asOf",
    "url",
    "postalCode",
    "quantityTons",
    "product",
  ];
  const lines = [header.join(";")];
  for (const it of items || []) {
    const q = it.query || {};
    const line = [
      it.retrievedAt,
      it.sourceId,
      it.sourceName,
      it.group,
      it.ok ? "true" : "false",
      it.error || "",
      isFiniteNumber(it.priceEurPerTon) ? it.priceEurPerTon : "",
      isFiniteNumber(it.totalEur) ? it.totalEur : "",
      it.asOf || "",
      it.url || "",
      q.postalCode || "",
      q.quantityTons ?? "",
      q.product || "",
    ].map(csvEscape);
    lines.push(line.join(";"));
  }
  return `${lines.join("\n")}\n`;
}

