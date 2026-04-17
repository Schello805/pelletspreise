import crypto from "node:crypto";

export function jsonResponse(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

export function textResponse(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "content-type": contentType, "cache-control": "no-store" });
  res.end(text);
}

export async function readJsonBody(req, { maxBytes = 1_000_000 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Body too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

export function newId(prefix = "src") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

export function normalizeQuery(input) {
  const postalCode = String(input?.postalCode || "").trim();
  const quantityTons = Number(input?.quantityTons);
  const product = String(input?.product || "").trim();
  if (!/^\d{5}$/.test(postalCode)) throw new Error("PLZ muss 5-stellig sein.");
  if (!Number.isFinite(quantityTons) || quantityTons <= 0) throw new Error("Menge (t) ist ungültig.");
  if (!product) throw new Error("Produkt fehlt.");

  const optIn = input?.options && typeof input.options === "object" ? input.options : {};
  const options = {
    abladestellen: Math.max(1, Math.min(5, Number(optIn.abladestellen || 1))),
    qualitaet: String(optIn.qualitaet || "").trim(),
    zahlungsart: String(optIn.zahlungsart || "beliebig").trim(),
    lieferfrist: String(optIn.lieferfrist || "Standard").trim(),
    tageszeit: String(optIn.tageszeit || "ganztägig").trim(),
    schlauchlaenge: Math.max(0, Math.min(120, Number(optIn.schlauchlaenge || 30))),
    twgroesse: String(optIn.twgroesse || "egal").trim(),
  };

  return { postalCode, quantityTons, product, options };
}

export function derivePlaceholders(query, extra = {}) {
  const quantityKg = Math.round(Number(query.quantityTons) * 1000);
  const hpProductType = query.product === "ENPLUS_A1_SACK" ? "2" : "1";
  return {
    postalCode: query.postalCode,
    quantityTons: String(query.quantityTons),
    quantityKg: String(quantityKg),
    product: query.product,
    hpProductType,
    ...extra,
  };
}

export function applyPlaceholders(template, query, extra = {}) {
  const values = derivePlaceholders(query, extra);
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => (values[key] != null ? String(values[key]) : `{${key}}`));
}

export function parseGermanNumber(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/\s/g, "")
    .replace(/€/g, "")
    .replace(/[^\d,.\-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "");
  const normalized = cleaned.replace(",", ".");
  const v = Number(normalized);
  return Number.isFinite(v) ? v : null;
}

export function parseRegexInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  if (raw.startsWith("/") && raw.lastIndexOf("/") > 0) {
    const last = raw.lastIndexOf("/");
    const pattern = raw.slice(1, last);
    const flagsRaw = raw.slice(last + 1);
    const flags = flagsRaw.replace(/[^gimsuy]/g, "") || "i";
    return new RegExp(pattern, flags.includes("i") ? flags : `${flags}i`);
  }

  return new RegExp(raw, "i");
}

export function nowIso() {
  return new Date().toISOString();
}
