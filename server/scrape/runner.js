import { applyPlaceholders, nowIso, parseGermanNumber, parseRegexInput } from "../lib/util.js";

const CONTACT_EMAIL = String(process.env.CONTACT_EMAIL || "info@schellenberger.biz");
const DEFAULT_USER_AGENT = `pelletpreis-checker/0.1 (+contact: ${CONTACT_EMAIL})`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  const v = String(value || "").trim();
  if (!v) return null;
  const sec = Number(v);
  if (Number.isFinite(sec) && sec >= 0) return Math.min(60_000, sec * 1000);
  const dt = Date.parse(v);
  if (Number.isFinite(dt)) return Math.min(60_000, Math.max(0, dt - Date.now()));
  return null;
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function fetchWithRetry(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const maxAttempts = Number(options.maxAttempts || (method === "GET" || method === "HEAD" ? 3 : 2));
  const timeoutMs = Number(options.timeoutMs || 20_000);
  const minDelayMs = Number(options.minDelayMs || 650);

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (!isRetryableStatus(res.status) || attempt === maxAttempts) return res;

      const ra = parseRetryAfterMs(res.headers.get("retry-after"));
      const backoff = Math.min(15_000, minDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      const waitMs = ra != null ? Math.max(ra, 400 + jitter) : backoff + jitter;
      await sleep(waitMs);
      continue;
    } catch (err) {
      lastErr = err;
      const msg = err?.name === "AbortError" ? "Timeout" : err?.message || String(err);
      const retryableNetwork = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed/i.test(msg) || err?.name === "AbortError";
      if (!retryableNetwork || attempt === maxAttempts) throw err;

      const backoff = Math.min(15_000, minDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      await sleep(backoff + jitter);
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastErr) throw lastErr;
  return fetch(url, options);
}

function computeDemoPrice({ query }) {
  const pc = Number(query.postalCode.slice(-2));
  const regionFactor = 0.6 + (pc % 9) * 0.02;
  const productFactor = { ENPLUS_A1_LOSE: 1.0, ENPLUS_A1_SACK: 1.12, DINPLUS_LOSE: 1.03 }[query.product] ?? 1.0;
  const qtyDiscount = Math.max(0.82, 1.0 - Math.min(0.12, (query.quantityTons - 2) * 0.015));
  const base = 295;
  const priceEurPerTon = Math.round((base * regionFactor * productFactor * qtyDiscount) * 100) / 100;
  return priceEurPerTon;
}

function parseSetCookieHeader(setCookieValue) {
  const v = String(setCookieValue || "");
  const first = v.split(";")[0] || "";
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  return { name, value };
}

async function fetchWithCookieJar(url, { jar, method = "GET", headers = {}, body = undefined, redirect = "follow" } = {}) {
  const h = new Headers(headers);
  // Be polite and identify ourselves (can help when sites investigate traffic).
  h.set("user-agent", DEFAULT_USER_AGENT);
  h.set("from", CONTACT_EMAIL);
  h.set("x-contact", CONTACT_EMAIL);
  if (!h.has("accept-language")) h.set("accept-language", "de-DE,de;q=0.9,en;q=0.8");
  if (jar && jar.size) {
    const cookie = Array.from(jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    if (cookie) h.set("cookie", cookie);
  }

  const res = await fetchWithRetry(url, { method, headers: h, body, redirect });

  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (Array.isArray(setCookies)) {
    for (const sc of setCookies) {
      const parsed = parseSetCookieHeader(sc);
      if (parsed) jar.set(parsed.name, parsed.value);
    }
  } else {
    const sc = res.headers.get("set-cookie");
    const parsed = parseSetCookieHeader(sc);
    if (parsed) jar.set(parsed.name, parsed.value);
  }

  return res;
}

function toFormUrlEncoded(obj) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  return params.toString();
}

async function scrapeHolzpelletsNetBestOffer({ query }) {
  const base = "https://www.holzpellets.net";
  const produktTyp = query.product === "ENPLUS_A1_SACK" ? "2" : "1";
  const liefermengeKg = Math.round(Number(query.quantityTons) * 1000);
  const options = query.options || {};
  const abladestellen = String(options.abladestellen || "1");
  const qualitaet = String(options.qualitaet || "");
  const zahlungsart = String(options.zahlungsart || "beliebig");
  const lieferfrist = String(options.lieferfrist || "Standard");
  const tageszeit = String(options.tageszeit || "ganztägig");
  const schlauchlaenge = String(options.schlauchlaenge ?? "30");
  const twgroesse = String(options.twgroesse || "egal");

  const jar = new Map();

  // 1) Entry page (sets cookies and prepares session)
  const entry = produktTyp === "2" ? `${base}/pelletspreise/sackware/` : `${base}/pelletspreise/lose-ware/`;
  await fetchWithCookieJar(entry, {
    jar,
    headers: { accept: "text/html,*/*" },
    redirect: "follow",
  });

  // 2) Produktauswahl -> Mengenauswahl (AJAX chain used by the site)
  const common = { plz: query.postalCode, produkt_typ: produktTyp, abladestellen, qualitaet, width: "1200", height: "800" };
  await fetchWithCookieJar(`${base}/FE_AJAX/fe_ajax_produktauswahl.php`, {
    jar,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8", accept: "application/json,*/*" },
    body: toFormUrlEncoded({ plz: query.postalCode, produkt_typ: produktTyp, type: "1", width: "1200", height: "800" }),
    redirect: "follow",
  });
  await fetchWithCookieJar(`${base}/FE_AJAX/fe_ajax_mengenauswahl.php`, {
    jar,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8", accept: "application/json,*/*" },
    body: toFormUrlEncoded(common),
    redirect: "follow",
  });

  // 3) Submit form -> redirect contains oid/pid/cid
  const res = await fetchWithCookieJar(`${base}/pelletspreise/`, {
    jar,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8", accept: "text/html,*/*" },
    body: toFormUrlEncoded({
      fe_plz: query.postalCode,
      fe_produkt_typ: produktTyp,
      fe_liefermenge: String(liefermengeKg),
      fe_abladestellen: abladestellen,
      fe_qualitaet: qualitaet,
    }),
    redirect: "manual",
  });

  const loc = res.headers.get("location") || "";
  if (!loc) throw new Error("Holzpellets.net: Kein Redirect (Location) erhalten.");
  const redirectUrl = new URL(loc, base);
  const oid = redirectUrl.searchParams.get("oid");
  if (!oid) throw new Error("Holzpellets.net: oid fehlt.");

  // 4) Initialize calculation for this session (needed before set_prices)
  const initRes = await fetchWithCookieJar(`${base}/FE_ORDER/FE_AJAX/fe_ajax_show_price.php`, {
    jar,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8", accept: "application/json,*/*" },
    body: toFormUrlEncoded({ oid, liefermenge: String(liefermengeKg), width: "1200", height: "800" }),
    redirect: "follow",
  });
  const initJson = await initRes.json().catch(() => null);
  if (!initJson || initJson.status !== 2) throw new Error("Holzpellets.net: Initialisierung fehlgeschlagen.");

  async function applyChange(type, params) {
    const url = new URL(`${base}/FE_ORDER/FE_AJAX/fe_ajax_change_inputs.php`);
    url.searchParams.set("oid", oid);
    url.searchParams.set("type", type);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
    const r = await fetchWithCookieJar(url.toString(), {
      jar,
      headers: { accept: "application/json,*/*" },
      redirect: "follow",
    });
    const j = await r.json().catch(() => null);
    if (!j || Number(j.status) !== 2) throw new Error(`Holzpellets.net: Änderung fehlgeschlagen (${type}).`);
  }

  // Apply advanced options (Gebühren werden von der Seite berechnet; wir übergeben 0 als Platzhalter).
  if (zahlungsart && zahlungsart !== "beliebig") await applyChange("zahlungsart", { zahlungsart, zahlungsart_gebuehr: 0 });
  if (lieferfrist && lieferfrist !== "Standard") await applyChange("lieferfrist", { lieferfrist, lieferfrist_gebuehr: 0 });
  if (tageszeit && tageszeit !== "ganztägig") await applyChange("tageszeit", { tageszeit, tageszeit_gebuehr: 0 });
  if (schlauchlaenge && String(schlauchlaenge) !== "30") await applyChange("schlauchlaenge", { schlauchlaenge, schlauchlaenge_gebuehr: 0 });
  if (twgroesse && twgroesse !== "egal") await applyChange("twgroesse", { twgroesse, twgroesse_gebuehr: 0 });

  // 5) Fetch per-offer prices
  const pricesRes = await fetchWithCookieJar(
    `${base}/FE_ORDER/FE_AJAX/fe_ajax_set_prices.php?oid=${encodeURIComponent(oid)}&liefermenge=${encodeURIComponent(String(liefermengeKg))}`,
    { jar, headers: { accept: "application/json,*/*" }, redirect: "follow" },
  );
  const prices = await pricesRes.json().catch(() => null);
  if (!prices || typeof prices !== "object") throw new Error("Holzpellets.net: Preis-JSON ungültig.");

  // Optional: fetch the offer list HTML to enrich offers with dealer names and delivery dates.
  let offerPageHtml = null;
  try {
    const offerPageRes = await fetchWithCookieJar(redirectUrl.toString(), {
      jar,
      headers: { accept: "text/html,*/*" },
      redirect: "follow",
    });
    if (offerPageRes.ok) offerPageHtml = await offerPageRes.text();
  } catch {
    offerPageHtml = null;
  }

  const enrichFromHtml = (offerNo) => {
    if (!offerPageHtml) return { dealerName: null, deliveryBy: null };
    const n = String(offerNo);
    const reDealer = new RegExp(`modal_show_haendler\\(${n}\\)[\\s\\S]{0,220}?>([^<]{2,160}?)<\\/a>`, "i");
    const dm = offerPageHtml.match(reDealer);
    const dealerName = dm ? String(dm[1]).trim() : null;

    const reDelivery = new RegExp(`id="lieferfrist_angebot_${n}"[\\s\\S]{0,300}?<b>\\s*([0-9]{2}\\.[0-9]{2}\\.[0-9]{4})\\s*<\\/b>`, "i");
    const lm = offerPageHtml.match(reDelivery);
    const deliveryBy = lm ? String(lm[1]).trim() : null;
    return { dealerName, deliveryBy };
  };

  const offers = [];
  for (const [k, v] of Object.entries(prices)) {
    if (!/^\d+$/.test(k)) continue;
    if (!v || typeof v !== "object") continue;
    if (Number(v.status) !== 1) continue;
    const total = parseGermanNumber(v.gesamtpreis_brutto);
    const perTon = parseGermanNumber(v.gesamtpreis_pro_tonne);
    if (perTon == null) continue;
    const dealerNameFromJson =
      typeof v.haendler_name === "string"
        ? v.haendler_name
        : typeof v.haendlername === "string"
          ? v.haendlername
          : typeof v.haendler === "string"
            ? v.haendler
            : null;
    const { dealerName: dealerNameFromHtml, deliveryBy } = enrichFromHtml(k);
    const dealerName = dealerNameFromJson ? String(dealerNameFromJson).trim() : dealerNameFromHtml;
    offers.push({
      offerNo: k,
      dealerName: dealerName ? String(dealerName).trim() : null,
      priceEurPerTon: perTon,
      totalEur: total,
      deliveryBy,
    });
  }

  if (!offers.length) throw new Error("Holzpellets.net: Kein Angebot gefunden.");

  offers.sort((a, b) => {
    const at = typeof a.totalEur === "number" ? a.totalEur : Number.POSITIVE_INFINITY;
    const bt = typeof b.totalEur === "number" ? b.totalEur : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return a.priceEurPerTon - b.priceEurPerTon;
  });

  const best = offers[0];
  const offersCount = offers.length;

  return { url: redirectUrl.toString(), offerNo: best.offerNo, totalEur: best.totalEur, priceEurPerTon: best.priceEurPerTon, offersCount, offers };
}

function parseDynamicCurrencyFromBlock(block, { anchorRegex, tailRegex } = {}) {
  const anchor = anchorRegex ? block.match(anchorRegex) : null;
  const from = anchor ? Math.max(0, anchor.index - 1200) : 0;
  const sub = block.slice(from);

  const re = tailRegex;
  const m = sub.match(re);
  if (!m) return null;

  const majorRaw = String(m[1] || "").trim();
  const minorRaw = String(m[2] || "").trim();
  const major = majorRaw.replace(/[^\d.]/g, "");
  const minor = minorRaw.replace(/[^\d]/g, "");
  if (!major || minor.length !== 2) return null;
  const n = Number(`${major.replace(/\./g, "")}.${minor}`);
  return Number.isFinite(n) ? n : null;
}

const HEIZP_UNIT_PRICE_RE = /unitPrice=([0-9]{1,5}(?:\.[0-9]{1,2})?)(?:&|&amp;|")/i;
const HEIZP_TOTAL_DATA_PRICE_RE = /data-price\s*=\s*"([0-9]{1,7}(?:\.[0-9]{1,2})?)"/i;
const HEIZP_MAJOR_MINOR_RE = /major-number">\s*([0-9.]{1,10})[\s\S]{0,600}?minor-number[^>]*>\s*([0-9]{2})/gi;
const HEIZP_UNIT_DOM_RE =
  /major-number">\s*([0-9.]{1,10})[\s\S]{0,240}?minor-number[^>]*>\s*([0-9]{2})[\s\S]{0,1200}?\/\s*1\.000\s*kg/i;
const HEIZP_TOTAL_DOM_RE = /Gesamtpreis[\s\S]{0,6000}?major-number">\s*([0-9.]{1,10})[\s\S]{0,600}?minor-number[^>]*>\s*([0-9]{2})/i;

function parseHeizPellets24UnitPrice(block) {
  const byDom = parseDynamicCurrencyFromBlock(block, { tailRegex: HEIZP_UNIT_DOM_RE });
  if (byDom != null) return byDom;
  const m = block.match(HEIZP_UNIT_PRICE_RE);
  if (!m) return null;
  return parseGermanNumber(m[1]);
}

function parseHeizPellets24Total(block) {
  const m = block.match(HEIZP_TOTAL_DOM_RE);
  if (m) {
    const major = String(m[1] || "").trim();
    const minor = String(m[2] || "").trim();
    const n = parseGermanNumber(`${major},${minor}`);
    if (n != null) return n;
  }

  const byDom = parseDynamicCurrencyFromBlock(block, { anchorRegex: /Gesamtpreis/i, tailRegex: HEIZP_TOTAL_DOM_RE });
  if (byDom != null) return byDom;

  const m2 = block.match(HEIZP_TOTAL_DATA_PRICE_RE);
  if (m2) return parseGermanNumber(m2[1]);

  const matches = Array.from(block.matchAll(HEIZP_MAJOR_MINOR_RE));
  const values = matches
    .map((mm) => {
      const major = String(mm[1] || "").trim();
      const minor = String(mm[2] || "").trim();
      return parseGermanNumber(`${major},${minor}`);
    })
    .filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!values.length) return null;
  const max = Math.max(...values);
  return Number.isFinite(max) ? max : null;
}

function parseHeizPellets24DealerName(block) {
  const m = block.match(/dealer-name[^>]*>[\s\S]{0,240}?(?:<(?:a|span)[^>]*>)?\s*([^<]+)\s*(?:<\/(?:a|span)>)?/i);
  return m ? String(m[1]).trim() : null;
}

function parseHeizPellets24OrderUrl(block, pageUrl) {
  const m = block.match(/<a[^>]+href="([^"]*bestellparameter-bestaetigen[^"]*)"[^>]*>\s*Weiter/i);
  if (!m) return null;
  try {
    return new URL(m[1].replace(/&amp;/g, "&"), pageUrl).toString();
  } catch {
    return null;
  }
}

function parseHeizPellets24OfferBlock(block, pageUrl) {
  const unit = parseHeizPellets24UnitPrice(block);
  if (unit == null) return null;
  return {
    dealerName: parseHeizPellets24DealerName(block),
    priceEurPerTon: unit,
    totalEur: parseHeizPellets24Total(block),
    orderUrl: parseHeizPellets24OrderUrl(block, pageUrl),
  };
}

function parseHeizPellets24BestOfferFromHtml(html, url) {
  const idx = html.indexOf("günstigster");
  if (idx < 0) throw new Error("Best-Angebot nicht gefunden (Marker fehlt).");

  const start = Math.max(0, html.lastIndexOf("dealer-card--outer-wrapper", idx) - 20);
  const end = html.indexOf("dealer-card--outer-wrapper", idx + 50);
  const block = html.slice(start, end > 0 ? end : idx + 12000);
  const parsed = parseHeizPellets24OfferBlock(block, url);
  if (!parsed) throw new Error("Best-Angebot: Einheitspreis nicht gefunden.");
  return { url, priceEurPerTon: parsed.priceEurPerTon, totalEur: parsed.totalEur, bestDealerName: parsed.dealerName };
}

function parseHeizPellets24OffersFromHtml(html, pageUrl) {
  const offers = [];
  const split = html.split(/<div[^>]+dealer-card--outer-wrapper[^>]*>/i);
  if (split.length < 2) return offers;

  for (let i = 1; i < split.length; i += 1) {
    const chunk = split[i];
    const block = `<div class="dealer-card--outer-wrapper"${chunk}`;
    const parsed = parseHeizPellets24OfferBlock(block, pageUrl);
    if (!parsed) continue;
    offers.push(parsed);
  }

  // Sort: cheapest total first (fallback to unit price)
  offers.sort((a, b) => {
    const at = typeof a.totalEur === "number" ? a.totalEur : Number.POSITIVE_INFINITY;
    const bt = typeof b.totalEur === "number" ? b.totalEur : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return (a.priceEurPerTon || 0) - (b.priceEurPerTon || 0);
  });

  // de-duplicate by dealerName + price
  const seen = new Set();
  const deduped = [];
  for (const o of offers) {
    const k = `${o.dealerName || ""}|${o.priceEurPerTon}|${o.totalEur}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(o);
  }

  return deduped;
}

async function scrapeHeizPellets24BestOffer({ query }) {
  const base = "https://www.heizpellets24.de";
  const amountKg = Math.round(Number(query.quantityTons) * 1000);
  const stations = String(query.options?.abladestellen || 1);
  const product = query.product === "ENPLUS_A1_SACK" ? "21" : "20";

  // These are site-specific filter parameters; keep defaults until we model them explicitly in the UI.
  const options = "108,131,-18,127,159";
  const pcert = "4,2,6,1";

  const url = `${base}/holzpellets-lose/angebotsliste?zipCode=${encodeURIComponent(query.postalCode)}&amount=${encodeURIComponent(
    String(amountKg),
  )}&stations=${encodeURIComponent(stations)}&product=${encodeURIComponent(product)}&options=${encodeURIComponent(
    options,
  )}&ap=0&pcert=${encodeURIComponent(pcert)}&lbp=0`;

  const res = await fetchWithRetry(url, {
    redirect: "follow",
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      from: CONTACT_EMAIL,
      "x-contact": CONTACT_EMAIL,
      "accept-language": "de-DE,de;q=0.9,en;q=0.8",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} beim Abruf (HeizPellets24 Angebotsliste).`);
  const html = await res.text();

  if (html.includes("dealer-card--outer-wrapper")) {
    const best = parseHeizPellets24BestOfferFromHtml(html, url);
    const offers = parseHeizPellets24OffersFromHtml(html, url);
    return { ...best, offers };
  }

  // The offer list is rendered client-side (Nuxt). Use Playwright when available.
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error("HeizPellets24 Angebotsliste benötigt Playwright (npm i -D playwright && npx playwright install).");
  }

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: DEFAULT_USER_AGENT });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".dealer-card--outer-wrapper", { timeout: 25_000 });
    const rendered = await page.content();
    const pageUrl = page.url() || url;
    const best = parseHeizPellets24BestOfferFromHtml(rendered, pageUrl);
    const offers = parseHeizPellets24OffersFromHtml(rendered, pageUrl);
    return { ...best, offers };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function scrapeHttpRegex({ source, query, baseUrl }) {
  const template = source.url || "";
  const urlRaw = applyPlaceholders(template, query);
  const url = urlRaw.startsWith("/") ? `${baseUrl}${urlRaw}` : urlRaw;

  const method = String(source?.request?.method || "GET").toUpperCase();
  const headers = {
    "user-agent": DEFAULT_USER_AGENT,
    from: CONTACT_EMAIL,
    "x-contact": CONTACT_EMAIL,
    "accept-language": "de-DE,de;q=0.9,en;q=0.8",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    ...(source?.request?.headers && typeof source.request.headers === "object" ? source.request.headers : {}),
  };

  let body = undefined;
  if (method === "POST") {
    const contentType = String(source?.request?.contentType || "application/x-www-form-urlencoded; charset=utf-8");
    headers["content-type"] = headers["content-type"] || contentType;
    body = applyPlaceholders(String(source?.request?.bodyTemplate || ""), query);
  }

  const res = await fetchWithRetry(url, { method, body, redirect: "follow", headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} beim Abruf.`);
  const html = await res.text();

  const re = parseRegexInput(source?.extract?.regex);
  if (!re) throw new Error("Regex fehlt.");
  const m = html.match(re);
  if (!m) throw new Error("Preis nicht gefunden (Regex passt nicht).");

  const priceEurPerTon = parseGermanNumber(m[1] ?? m[0]);
  if (priceEurPerTon == null) throw new Error("Gefundener Preis ist keine Zahl.");

  let asOf = null;
  if (source?.extract?.regexAsOf) {
    const reAsOf = parseRegexInput(source.extract.regexAsOf);
    const m2 = reAsOf ? html.match(reAsOf) : null;
    if (m2) {
      if (m2[1] && m2[2]) asOf = `${String(m2[1]).trim()} ${String(m2[2]).trim()}`;
      else asOf = String(m2[1] ?? m2[0]).trim();
    }
  }

  let totalEur = null;
  if (source?.extract?.regexTotal) {
    const reTotal = parseRegexInput(source.extract.regexTotal);
    const mt = reTotal ? html.match(reTotal) : null;
    if (mt) totalEur = parseGermanNumber(mt[1] ?? mt[0]);
  }

  return { url, priceEurPerTon, totalEur, asOf, htmlSnippet: null };
}

async function scrapePlaywright({ source, query, baseUrl, sharedBrowser }) {
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error("Playwright ist nicht installiert. (npm i -D playwright)");
  }

  const browser = sharedBrowser || (await playwright.chromium.launch({ headless: true }));
  const context = await browser.newContext({ userAgent: DEFAULT_USER_AGENT });
  const page = await context.newPage();

  try {
    const steps = Array.isArray(source.steps) ? source.steps : null;
    if (!steps || !steps.length) throw new Error("Playwright Schritte fehlen.");

    const localSourceUrl = source.url ? applyPlaceholders(source.url, query) : null;
    for (const step of steps) {
      const action = String(step?.action || "").trim();
      if (action === "goto") {
        const u = step.url && step.url !== "{url}" ? step.url : localSourceUrl;
        if (!u) throw new Error("goto: url fehlt.");
        const urlResolved = applyPlaceholders(u, query);
        const urlFinal = urlResolved.startsWith("/") ? `${baseUrl}${urlResolved}` : urlResolved;
        await page.goto(urlFinal, { waitUntil: "domcontentloaded" });
        continue;
      }
      if (action === "fill") {
        const selector = String(step.selector || "").trim();
        const value = applyPlaceholders(String(step.value ?? ""), query);
        if (!selector) throw new Error("fill: selector fehlt.");
        await page.fill(selector, value);
        continue;
      }
      if (action === "select") {
        const selector = String(step.selector || "").trim();
        const value = applyPlaceholders(String(step.value ?? ""), query);
        if (!selector) throw new Error("select: selector fehlt.");
        await page.selectOption(selector, value);
        continue;
      }
      if (action === "click") {
        const selector = String(step.selector || "").trim();
        if (!selector) throw new Error("click: selector fehlt.");
        await page.click(selector);
        continue;
      }
      if (action === "waitForSelector") {
        const selector = String(step.selector || "").trim();
        if (!selector) throw new Error("waitForSelector: selector fehlt.");
        await page.waitForSelector(selector, { timeout: Number(step.timeoutMs || 15_000) });
        continue;
      }
      if (action === "waitForTimeout") {
        await page.waitForTimeout(Number(step.timeoutMs || 500));
        continue;
      }
      throw new Error(`Unbekannte Aktion: ${action}`);
    }

    const html = await page.content();
    const re = parseRegexInput(source?.extract?.regex);
    if (!re) throw new Error("Regex fehlt.");
    const m = html.match(re);
    if (!m) throw new Error("Preis nicht gefunden (Regex passt nicht).");

    const priceEurPerTon = parseGermanNumber(m[1] ?? m[0]);
    if (priceEurPerTon == null) throw new Error("Gefundener Preis ist keine Zahl.");

    let asOf = null;
    if (source?.extract?.regexAsOf) {
      const reAsOf = parseRegexInput(source.extract.regexAsOf);
      const m2 = reAsOf ? html.match(reAsOf) : null;
      if (m2) {
        if (m2[1] && m2[2]) asOf = `${String(m2[1]).trim()} ${String(m2[2]).trim()}`;
        else asOf = String(m2[1] ?? m2[0]).trim();
      }
    }

    let totalEur = null;
    if (source?.extract?.regexTotal) {
      const reTotal = parseRegexInput(source.extract.regexTotal);
      const mt = reTotal ? html.match(reTotal) : null;
      if (mt) totalEur = parseGermanNumber(mt[1] ?? mt[0]);
    }

    return { url: page.url(), priceEurPerTon, totalEur, asOf, htmlSnippet: null };
  } finally {
    await context.close().catch(() => {});
    if (!sharedBrowser) await browser.close().catch(() => {});
  }
}

export async function runSource({ source, query, baseUrl, sharedBrowser = null }) {
  const retrievedAt = nowIso();
  const sourceId = source?.id || null;
  const sourceName = source?.name || sourceId || "Quelle";
  const group = source?.group != null ? String(source.group) : null;

  try {
    const kind = String(source?.kind || "").trim();
    if (kind === "demo") {
      const priceEurPerTon = computeDemoPrice({ query });
      return {
        ok: true,
        sourceId,
        sourceName,
        group,
        retrievedAt,
        url: null,
        asOf: null,
        priceEurPerTon,
        totalEur: Math.round(priceEurPerTon * query.quantityTons * 100) / 100,
      };
    }

    if (kind === "http-regex") {
      const { url, priceEurPerTon, asOf, totalEur: totalFromPage } = await scrapeHttpRegex({ source, query, baseUrl });
      const totalEur = totalFromPage != null ? totalFromPage : Math.round(priceEurPerTon * query.quantityTons * 100) / 100;
      return {
        ok: true,
        sourceId,
        sourceName,
        group,
        retrievedAt,
        url,
        asOf: asOf || null,
        priceEurPerTon,
        totalEur,
      };
    }

    if (kind === "holzpellets-net") {
      const r = await scrapeHolzpelletsNetBestOffer({ query });
      return {
        ok: true,
        sourceId,
        sourceName,
        group,
        retrievedAt,
        url: r.url,
        asOf: null,
        priceEurPerTon: r.priceEurPerTon,
        totalEur: r.totalEur,
        offersCount: r.offersCount,
        bestOfferNo: r.offerNo,
        offers: Array.isArray(r.offers) ? r.offers : null,
      };
    }

    if (kind === "heizpellets24") {
      const r = await scrapeHeizPellets24BestOffer({ query });
      const totalEur = r.totalEur != null ? r.totalEur : Math.round(r.priceEurPerTon * query.quantityTons * 100) / 100;
      return {
        ok: true,
        sourceId,
        sourceName,
        group,
        retrievedAt,
        url: r.url,
        asOf: null,
        priceEurPerTon: r.priceEurPerTon,
        totalEur,
        bestDealerName: r.bestDealerName,
        offers: Array.isArray(r.offers) ? r.offers : null,
      };
    }

    if (kind === "playwright") {
      const { url, priceEurPerTon, asOf, totalEur: totalFromPage } = await scrapePlaywright({ source, query, baseUrl, sharedBrowser });
      const totalEur = totalFromPage != null ? totalFromPage : Math.round(priceEurPerTon * query.quantityTons * 100) / 100;
      return {
        ok: true,
        sourceId,
        sourceName,
        group,
        retrievedAt,
        url,
        asOf: asOf || null,
        priceEurPerTon,
        totalEur,
      };
    }

    throw new Error(`Unbekannter Typ: ${kind}`);
  } catch (err) {
    return {
      ok: false,
      sourceId,
      sourceName,
      group,
      retrievedAt,
      url: null,
      asOf: null,
      priceEurPerTon: null,
      totalEur: null,
      error: err?.message || String(err),
    };
  }
}
