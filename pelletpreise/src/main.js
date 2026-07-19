import { apiFetch } from "./api.js";
import { applyOffersView, buildOfferRowsFromResults } from "./offers.js";
import { refreshDailyHistory, renderDailyHistory as renderDailyHistoryImpl, updateHistoryExportLinks } from "./daily.js";
import {
  $,
  escapeAttr,
  escapeHtml,
  fmtDateKey,
  fmtMoney,
  fmtNumber,
  fmtTime,
  isSafeHttpUrl,
  linkHtml,
  mapProductLabel,
  setLoading,
  setServerStatus,
  toast,
} from "./ui.js";

function getQueryFromForm() {
  const postalCode = String($("postalCode").value || "").trim();
  const quantityTons = Number($("quantityTons").value);
  const product = String($("product").value || "").trim();
  const options = {
    abladestellen: Number(document.getElementById("opt_abladestellen")?.value || 1),
    qualitaet: String(document.getElementById("opt_qualitaet")?.value || "").trim(),
    zahlungsart: String(document.getElementById("opt_zahlungsart")?.value || "beliebig").trim(),
    lieferfrist: String(document.getElementById("opt_lieferfrist")?.value || "Standard").trim(),
    tageszeit: String(document.getElementById("opt_tageszeit")?.value || "ganztägig").trim(),
    schlauchlaenge: Number(document.getElementById("opt_schlauchlaenge")?.value || 30),
    twgroesse: String(document.getElementById("opt_twgroesse")?.value || "egal").trim(),
  };
  return { postalCode, quantityTons, product, options };
}

function validateQuery(query) {
  if (!/^\d{5}$/.test(String(query.postalCode || ""))) return "Bitte eine 5-stellige PLZ (nur Zahlen) eingeben.";
  if (!Number.isFinite(Number(query.quantityTons)) || Number(query.quantityTons) <= 0) return "Bitte eine gültige Menge (t) eingeben.";
  if (!query.product) return "Bitte ein Produkt auswählen.";
  return null;
}

function loadingRow(columns, label = "Wird geladen …") {
  return `<tr><td colspan="${columns}" class="loading-cell"><span class="loading-shimmer"></span><span>${escapeHtml(label)}</span></td></tr>`;
}

function normalizeExtract(ex) {
  if (!ex || typeof ex !== "object") return null;
  const out = {};
  if (ex.regex) out.regex = String(ex.regex);
  if (ex.regexAsOf) out.regexAsOf = String(ex.regexAsOf);
  if (ex.regexTotal) out.regexTotal = String(ex.regexTotal);
  return Object.keys(out).length ? out : null;
}

function statusCellHtml(result) {
  if (isRateLimitedResult(result)) {
    return `<span class="status warn" title="${escapeAttr(String(result.error || "Abruflimit aktiv."))}">Wartet</span>`;
  }
  if (result?.ok && result?.anomaly) {
    const a = result.anomaly;
    const direction = a.type === "unusually_low" ? "auffällig niedrig" : "auffällig hoch";
    const hint = `${direction}: ${a.deviationPercent}% gegenüber Median ${fmtNumber(a.baselineEurPerTon)} €/t (${a.sampleSize} Werte)`;
    return `<span class="status warn" title="${escapeAttr(hint)}">Prüfen</span>`;
  }
  if (result?.ok) return `<span class="status ok">OK</span>`;
  const msg = result?.error ? escapeHtml(String(result.error)) : "Fehler";
  return `<span class="status err">${msg}</span>`;
}

function isRateLimitedResult(result) {
  const error = String(result?.error || "");
  return Boolean(result?.rateLimited || /heute lief bereits|nächste.*erlaubt|10h|10 h|abstand|rate.?limit/i.test(error));
}

function rateLimitHint(meta = {}) {
  const info = meta?.rateLimit || {};
  const next = info?.details?.nextAllowedAt || info?.nextAllowedAt || null;
  if (next) return `Nächster echter Abruf: ${fmtTime(next)}`;
  if (info?.error) return String(info.error);
  return "Abruflimit aktiv – vorhandene Cachewerte bleiben sichtbar.";
}

function isAverageResult(r) {
  return String(r.group || "") === "average" || String(r.sourceId || "").includes("_avg_");
}

const state = {
  sources: [],
  editingSourceId: null,
  lastQuery: null,
  lastResults: [],
  lastOffersRows: [],
  dailyRows: [],
  dailySeriesKey: null,
  dailyCompareKeys: [],
  _dailyExportParams: "",
  settings: null,
  diagnostics: null,
  alerts: null,
  email: null,
  scrapeStatus: null,
  update: null,
  sourceFlowStep: "link",
};

let authenticatedAppInitialized = false;
const SAVED_KEY_MASK = "•••••••• gespeichert";

function showLoginDialog(message = "") {
  const dialog = document.getElementById("loginDialog");
  const error = document.getElementById("loginError");
  if (!dialog) return;
  if (error) error.textContent = message;
  if (!dialog.open) dialog.showModal();
  window.setTimeout(() => document.getElementById("loginUsername")?.focus(), 0);
}

function setupAuthEvents() {
  const dialog = document.getElementById("loginDialog");
  const form = document.getElementById("loginForm");
  const logout = document.getElementById("logoutBtn");
  if (dialog) dialog.addEventListener("cancel", (event) => event.preventDefault());

  window.addEventListener("pelletpreis:auth-required", () => showLoginDialog("Deine Sitzung ist abgelaufen. Bitte erneut anmelden."));

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const username = String(document.getElementById("loginUsername")?.value || "").trim();
      const password = String(document.getElementById("loginPassword")?.value || "");
      const remember = Boolean(document.getElementById("loginRemember")?.checked);
      const error = document.getElementById("loginError");
      const submit = document.getElementById("loginSubmitBtn");
      if (error) error.textContent = "";
      if (submit) submit.disabled = true;
      try {
        await apiFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password, remember }) });
        document.getElementById("loginPassword").value = "";
        dialog?.close();
        await initialiseAuthenticatedApp({ showLogout: true });
      } catch (err) {
        if (error) error.textContent = err.message || "Anmeldung fehlgeschlagen.";
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }

  if (logout) {
    logout.addEventListener("click", async () => {
      await apiFetch("/api/auth/logout", { method: "POST", body: JSON.stringify({}) }).catch(() => {});
      window.location.reload();
    });
  }
}

function renderScrapeStatus(status) {
  const host = document.getElementById("scrapeStatus");
  if (!host) return;
  if (!status) {
    host.textContent = "Abrufstatus nicht verfügbar.";
    return;
  }
  const rate = status.rateLimit || {};
  const cached = (status.sources || []).filter((source) => source.cached).length;
  const total = (status.sources || []).length;
  const next = rate.nextAllowedAt ? fmtTime(rate.nextAllowedAt) : null;
  const text = rate.allowed
    ? `Abruf bereit · ${cached}/${total} Quellen aus Cache · noch ${rate.remainingRuns ?? "—"} echte Abfrage(n) heute möglich`
    : `Cache wird weiterhin angezeigt · ${cached}/${total} Quellen aktuell im Cache · nächste echte Abfrage: ${next || "morgen"}`;
  host.className = `run-status${rate.allowed ? " is-ready" : " is-limited"}`;
  host.textContent = text;
  host.title = rate.error || "Cache schont die Quellen; echte Abrufe sind begrenzt.";
}

async function refreshScrapeStatus() {
  const data = await apiFetch("/api/scrape/status");
  state.scrapeStatus = data;
  renderScrapeStatus(data);
  return data;
}

function renderOverview({ query, avgResults, offerRows, meta = {} }) {
  const host = document.getElementById("overviewCards");
  if (!host) return;

  const avg = avgResults
    .filter((r) => r && r.ok && typeof r.priceEurPerTon === "number")
    .slice()
    .sort((a, b) => a.priceEurPerTon - b.priceEurPerTon);
  const bestAvg = avg[0] || null;
  const avgLimited = avgResults.some(isRateLimitedResult);

  const offers = (offerRows || [])
    .filter((r) => typeof r.totalEur === "number" || typeof r.priceEurPerTon === "number")
    .slice()
    .sort((a, b) => {
      const at = typeof a.totalEur === "number" ? a.totalEur : Number.POSITIVE_INFINITY;
      const bt = typeof b.totalEur === "number" ? b.totalEur : Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      const ap = typeof a.priceEurPerTon === "number" ? a.priceEurPerTon : Number.POSITIVE_INFINITY;
      const bp = typeof b.priceEurPerTon === "number" ? b.priceEurPerTon : Number.POSITIVE_INFINITY;
      return ap - bp;
    });
  const bestOffer = offers[0] || null;

  const byProvider = new Map();
  for (const o of offers) {
    const key = String(o.provider || "—");
    const cur = byProvider.get(key);
    if (!cur) {
      byProvider.set(key, o);
      continue;
    }
    const ct = typeof cur.totalEur === "number" ? cur.totalEur : Number.POSITIVE_INFINITY;
    const nt = typeof o.totalEur === "number" ? o.totalEur : Number.POSITIVE_INFINITY;
    if (nt < ct) byProvider.set(key, o);
  }
  const providerBest = Array.from(byProvider.entries())
    .map(([, v]) => v)
    .slice(0, 2);

  const fmtPerTon = (n) => (typeof n === "number" ? `${fmtNumber(n)} € / t` : "—");
  const fmtTotal = (n) => (typeof n === "number" ? fmtMoney(n) : "—");
  const safe = (s) => escapeHtml(String(s || "—"));
  const orderLink = (url) =>
    url && isSafeHttpUrl(url)
      ? `<a class="btn btn-sm btn-outline-light" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">Bestellen</a>`
      : "";

  host.innerHTML = `
    <div class="overview-card overview-card-primary">
      <div class="overview-title">Empfehlung · günstigste Bestellung</div>
      <div class="overview-value">${bestOffer ? safe(fmtTotal(bestOffer.totalEur)) : "—"}</div>
      <div class="overview-meta">
        ${bestOffer ? `${safe(bestOffer.dealer)} · ${safe(bestOffer.provider)}<br/>${safe(fmtPerTon(bestOffer.priceEurPerTon))}` : "Noch keine passenden Angebote"}<br/>
        PLZ ${safe(query.postalCode)} · ${safe(fmtNumber(query.quantityTons))} t · ${safe(mapProductLabel(query.product))}
      </div>
      <div class="overview-actions">
        ${bestOffer ? orderLink(bestOffer.orderUrl) : ""}
      </div>
    </div>
    <div class="overview-card">
      <div class="overview-title">Marktwert · günstigste Quelle</div>
      <div class="overview-value">${bestAvg ? safe(fmtPerTon(bestAvg.priceEurPerTon)).replace("€ / t", "€") : "—"}</div>
      <div class="overview-meta">
        ${bestAvg ? `${safe(bestAvg.sourceName || bestAvg.sourceId)}<br/>Stand: ${safe(bestAvg.asOf || "—")}` : avgLimited ? `Heute nicht frisch abgefragt<br/>${safe(rateLimitHint(meta))}` : "Noch kein Marktwert verfügbar"}
      </div>
      <div class="overview-actions">
        ${bestAvg && bestAvg.url ? `<a class="btn btn-sm btn-outline-light" href="${escapeAttr(bestAvg.url)}" target="_blank" rel="noopener noreferrer">Quelle öffnen</a>` : ""}
      </div>
    </div>
    <div class="overview-card">
      <div class="overview-title">Weitere starke Angebote</div>
      <div class="overview-meta">
        ${
          providerBest.length
            ? providerBest
                .map((o) => `${safe(o.provider)}: <strong>${safe(fmtTotal(o.totalEur))}</strong> (${safe(o.dealer)})`)
                .join("<br/>")
            : "—"
        }
      </div>
      <div class="overview-actions">
        ${providerBest.find((o) => o.orderUrl && isSafeHttpUrl(o.orderUrl)) ? orderLink(providerBest.find((o) => o.orderUrl && isSafeHttpUrl(o.orderUrl)).orderUrl) : ""}
      </div>
    </div>
  `;
}

function renderResults({ query, results, meta = {} }) {
  const avgBody = $("resultsAvgBody");
  const offersBody = $("resultsOffersBody");
  const metaEl = $("resultsMeta");

  const avgResults = (results || []).filter(isAverageResult);
  const offerResults = (results || []).filter((r) => !isAverageResult(r));
  state.lastOffersRows = buildOfferRowsFromResults(offerResults);
  const limited = meta?.rateLimited ? " · Cache/Limit aktiv" : "";
  metaEl.textContent = `PLZ ${query.postalCode} · ${fmtNumber(query.quantityTons)} t · ${mapProductLabel(query.product)} · Ø ${avgResults.length} · Angebote ${state.lastOffersRows.length}${limited}`;

  renderOverview({ query, avgResults, offerRows: state.lastOffersRows, meta });

  if (!results.length) {
    avgBody.innerHTML = `<tr><td colspan="6" class="muted">Keine Ergebnisse (sind Quellen aktiv?).</td></tr>`;
    offersBody.innerHTML = `<tr><td colspan="7" class="muted">Keine Ergebnisse (sind Quellen aktiv?).</td></tr>`;
    return;
  }

  avgBody.innerHTML = avgResults.length
    ? avgResults
        .map((r) => {
          const price = r.priceEurPerTon != null ? `${fmtNumber(r.priceEurPerTon)} €` : "—";
          const total = r.totalEur != null ? fmtMoney(r.totalEur) : "—";
          const asOf = r.asOf ? String(r.asOf) : "—";
          const sourceCell = linkHtml(r.url, r.sourceName || r.sourceId || "—");
          const limited = isRateLimitedResult(r);
          const statusText = limited ? rateLimitHint(meta) : null;
          return `<tr>
            <td data-label="Quelle">${sourceCell}</td>
            <td class="right" data-label="Preis (€/t)">${escapeHtml(price)}</td>
            <td class="right" data-label="Gesamt (€)">${escapeHtml(total)}</td>
            <td class="muted" data-label="Stand">${escapeHtml(asOf)}</td>
            <td data-label="Status">${statusCellHtml(r)}${statusText ? `<div class="status-note">${escapeHtml(statusText)}</div>` : ""}</td>
            <td class="muted right" data-label="Zeit">${escapeHtml(fmtTime(r.retrievedAt))}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="muted">Keine Durchschnitts-Quellen aktiv.</td></tr>`;

  offersBody.innerHTML = state.lastOffersRows.length ? "" : `<tr><td colspan="7" class="muted">Keine Angebots-Quellen aktiv.</td></tr>`;
  if (state.lastOffersRows.length) {
    applyOffersView({ state, $, escapeHtml, fmtMoney, fmtNumber, fmtTime, isSafeHttpUrl, escapeAttr, linkHtml, statusCellHtml });
  }
}

function renderSources(sources) {
  const body = $("sourcesBody");
  if (!sources.length) {
    body.innerHTML = `<div class="empty-state"><strong>Noch keine Quellen</strong><span>Lege deine erste Preisquelle geführt an. Danach entstehen Historie und Alarme automatisch.</span><button class="btn btn-primary btn-sm" type="button" data-action="addFirstSource">Quelle hinzufügen</button></div>`;
    return;
  }

  const pwMissing = Boolean(state.diagnostics?.playwright && state.diagnostics.playwright.moduleOk && !state.diagnostics.playwright.chromiumOk);
  const pwHint = pwMissing
    ? "Playwright ist installiert, aber Chromium fehlt. Installiere es auf dem Server: npx playwright install chromium"
    : "";
  const needsPwKinds = new Set(["playwright", "heizpellets24"]);

  body.innerHTML = sources
    .map((s) => {
      const enabled = s.enabled ? "checked" : "";
      const last = s.lastRunAt ? fmtTime(s.lastRunAt) : "—";
      const statusLabel = s.lastError ? "Fehler" : s.lastSuccessAt ? "OK" : "Noch nicht geprüft";
      const sourceHealth = s.lastError
        ? `<span class="status err" title="${escapeAttr(String(s.lastError))}">Fehler</span>`
        : s.lastSuccessAt
          ? `<span class="status ok" title="Letzter erfolgreicher Abruf: ${escapeAttr(fmtTime(s.lastSuccessAt))}">OK</span>`
          : `<span class="muted">—</span>`;
      const historyMode = String(s.historyMode || "auto");
      const hm = (value, label) => `<option value="${escapeAttr(value)}"${historyMode === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
      const kindLabel =
        needsPwKinds.has(String(s.kind || "")) && pwMissing
          ? `<span class="badge bg-warning text-dark" title="${escapeAttr(pwHint)}">${escapeHtml(String(s.kind || "playwright"))} ⚠</span>`
          : escapeHtml(s.kind);
      const cacheBadge =
        typeof s.cacheHours === "number" && Number.isFinite(s.cacheHours) && s.cacheHours > 0
          ? `<span class="badge bg-secondary-subtle text-light ms-1" title="Cache: ${escapeAttr(String(s.cacheHours))}h">cache</span>`
          : "";
      return `<article class="source-card${s.enabled ? "" : " is-disabled"}">
        <div class="source-card-main">
          <label class="source-toggle" title="${s.enabled ? "Quelle ist aktiv" : "Quelle ist deaktiviert"}">
            <input type="checkbox" data-action="toggle" data-id="${escapeAttr(s.id)}" ${enabled} />
            <span>${s.enabled ? "Aktiv" : "Aus"}</span>
          </label>
          <div>
            <h3>${escapeHtml(s.name)}</h3>
            <p>${kindLabel}${cacheBadge} · ${escapeHtml(statusLabel)} · zuletzt ${escapeHtml(last)}</p>
            ${s.lastError ? `<p class="source-error">${escapeHtml(String(s.lastError))}</p>` : ""}
          </div>
        </div>
        <div class="source-card-controls">
          <label>
            <span class="label">Historie</span>
            <select class="form-select form-select-sm" data-action="historyMode" data-id="${escapeAttr(s.id)}" aria-label="Statistik">
              ${hm("auto", "Auto")}
              ${hm("best", "Bestpreis")}
              ${hm("none", "Aus")}
            </select>
          </label>
          <div class="source-status">${sourceHealth}</div>
          <div class="source-actions">
            <button class="btn btn-outline-light btn-sm" type="button" data-action="edit" data-id="${escapeAttr(s.id)}">Bearbeiten</button>
            <button class="btn btn-outline-danger btn-sm" type="button" data-action="delete" data-id="${escapeAttr(s.id)}">Löschen</button>
          </div>
        </div>
      </article>`;
    })
    .join("");
}

async function refreshSources() {
  const data = await apiFetch("/api/sources");
  state.sources = data.sources || [];
  renderSources(state.sources);
}

function applySettingsToUi(settings) {
  const cb = document.getElementById("autoDailyEnabled");
  if (cb) cb.checked = Boolean(settings?.autoDailyEnabled);
  const aiProvider = document.getElementById("aiProvider");
  const aiModel = document.getElementById("aiModel");
  const aiApiKey = document.getElementById("aiApiKey");
  const aiHelp = document.getElementById("aiConfigHelp");
  if (aiProvider) aiProvider.value = String(settings?.ai?.provider || "");
  if (aiModel) aiModel.value = String(settings?.ai?.model || "");
  if (aiApiKey) aiApiKey.value = settings?.ai?.configured ? SAVED_KEY_MASK : "";
  if (aiHelp) aiHelp.textContent = settings?.ai?.configured ? "API-Key ist gespeichert. Leer lassen, um ihn beizubehalten." : "Noch kein API-Key gespeichert.";
  const statusEl = document.getElementById("autoDailyStatus");
  const lastAt = settings?.lastAutoRunAt ? fmtTime(settings.lastAutoRunAt) : "";
  const err = settings?.lastAutoError ? String(settings.lastAutoError) : "";
  if (statusEl) {
    statusEl.textContent = lastAt ? `(${lastAt})` : "";
    statusEl.title = err ? `Letzter Fehler: ${err}` : lastAt ? `Letzter Auto-Abruf: ${lastAt}` : "";
  }
  if (cb) cb.title = statusEl?.title || cb.title || "";
}

async function refreshSettings() {
  const data = await apiFetch("/api/settings");
  state.settings = data.settings || null;
  applySettingsToUi(state.settings);
}

async function refreshDiagnostics() {
  const data = await apiFetch("/api/diagnostics");
  state.diagnostics = data || null;
}

function openSourceDialog(source) {
  state.editingSourceId = source?.id || null;
  $("sourceDialogTitle").textContent = source?.id ? "Quelle bearbeiten" : "Quelle hinzufügen";

  $("src_name").value = source?.name || "";
  $("src_enabled").value = String(Boolean(source?.enabled ?? true));
  $("src_kind").value = source?.kind || "http-regex";
  const cacheEl = document.getElementById("src_cacheHours");
  if (cacheEl) cacheEl.value = source?.cacheHours != null ? String(source.cacheHours) : "";
  const historyModeEl = document.getElementById("src_historyMode");
  if (historyModeEl) historyModeEl.value = String(source?.historyMode || "auto");
  $("src_url").value = source?.url || "";
  $("src_regex").value = source?.extract?.regex || "";
  $("src_regexAsOf").value = source?.extract?.regexAsOf || "";
  $("src_steps").value = source?.steps ? JSON.stringify(source.steps, null, 2) : "";
  renderSourceProbe(null);
  setSourceFlowStep(source?.id ? "usage" : "link");

  $("sourceDialog").showModal();
}

function setSourceFlowStep(step) {
  const next = ["link", "price", "usage"].includes(step) ? step : "link";
  state.sourceFlowStep = next;
  const body = document.getElementById("sourceDialogBody");
  if (body) body.dataset.flowStep = next;
  document.querySelectorAll("#sourceDialog [data-source-step]").forEach((el) => {
    const steps = String(el.getAttribute("data-source-step") || "").split(/\s+/).filter(Boolean);
    el.hidden = !steps.includes(next);
  });
  const kind = String(document.getElementById("src_kind")?.value || "http-regex");
  document.querySelectorAll("#sourceDialog [data-kind-field]").forEach((el) => {
    el.hidden = el.hidden || String(el.getAttribute("data-kind-field")) !== kind;
  });
  document.querySelectorAll("#sourceDialog .wizard-step").forEach((el, index) => {
    el.classList.toggle("is-active", index === { link: 0, price: 1, usage: 2 }[next]);
    el.classList.toggle("is-done", index < { link: 0, price: 1, usage: 2 }[next]);
  });
  const title = document.getElementById("sourceAssistantTitle");
  const text = document.getElementById("sourceAssistantText");
  const copy = {
    link: ["Link einfügen", "Füge die Preis-Seite ein. Danach sucht die App automatisch passende Pelletpreise."],
    price: ["Preis auswählen", "Klicke den Preis an, der später in Historie und Alarmen landen soll."],
    usage: ["Quelle speichern", "Prüfe kurz Name, Historie und Aktiv-Status. Dann speichern — fertig."],
  }[next];
  if (title) title.textContent = copy[0];
  if (text) text.textContent = copy[1];
  const saveBtn = document.getElementById("saveSourceBtn");
  if (saveBtn) {
    saveBtn.hidden = next !== "usage";
    saveBtn.disabled = next !== "usage";
  }
  const testBtn = document.getElementById("testSourceBtn");
  if (testBtn) testBtn.hidden = next === "link";
}

function getSourceFromDialog() {
  const name = String($("src_name").value || "").trim();
  const enabled = $("src_enabled").value === "true";
  const kind = String($("src_kind").value || "").trim();
  const historyMode = String(document.getElementById("src_historyMode")?.value || "auto").trim();
  const cacheRaw = String(document.getElementById("src_cacheHours")?.value || "").trim();
  const cacheHours = cacheRaw ? Number(cacheRaw) : null;
  const url = String($("src_url").value || "").trim();
  const regex = String($("src_regex").value || "").trim();
  const regexAsOf = String($("src_regexAsOf").value || "").trim();
  const stepsText = String($("src_steps").value || "").trim();

  const source = {
    name: name || "Quelle",
    enabled,
    kind,
    historyMode,
    cacheHours: Number.isFinite(cacheHours) ? cacheHours : null,
    url: url || null,
    extract: normalizeExtract({ regex, regexAsOf }),
    steps: null,
  };

  if (stepsText) {
    try {
      source.steps = JSON.parse(stepsText);
    } catch {
      throw new Error("Steps JSON ist ungültig.");
    }
  }

  return source;
}

async function saveSourceFromDialog() {
  const payload = getSourceFromDialog();
  if (state.editingSourceId) {
    const id = state.editingSourceId;
    await apiFetch(`/api/sources/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ source: payload }) });
    return;
  }
  await apiFetch("/api/sources", { method: "POST", body: JSON.stringify({ source: payload }) });
}

async function testSourceFromDialog() {
  const payload = getSourceFromDialog();
  const query = getQueryFromForm();
  const result = await apiFetch(`/api/sources/test`, { method: "POST", body: JSON.stringify({ source: payload, query }) });
  return result;
}

function renderSourceProbe(probe) {
  const host = document.getElementById("sourceProbeResult");
  if (!host) return;
  if (!probe) {
    host.hidden = true;
    host.innerHTML = "";
    renderSourceParserResult(null);
    if (!state.editingSourceId) setSourceFlowStep("link");
    return;
  }

  const candidates = Array.isArray(probe.candidates) ? probe.candidates : [];
  setSourceFlowStep("price");
  host.hidden = false;
  host.innerHTML = `
    <div class="probe-head">
      <div>
        <strong>1. Link getestet</strong>
        <span>${escapeHtml(probe.url || "—")}</span>
      </div>
    </div>
    <div class="probe-meta">${escapeHtml(
      candidates.length
        ? `2. ${candidates.length} mögliche Preiswerte gefunden${probe.rendered ? " (per Browser-Rendering)" : ""}. Klicke den gewünschten Zielpreis an.`
        : "Keine typischen €/t-Werte gefunden. Eventuell braucht diese Seite Playwright oder einen spezifischeren Regex.",
    )}</div>
    ${
      candidates.length
        ? `<div class="probe-candidates">${candidates
            .map(
              (candidate, index) => `
                <button class="probe-candidate" type="button" data-probe-action="choosePrice" data-index="${index}" data-value="${escapeAttr(String(candidate.value ?? ""))}" data-raw="${escapeAttr(candidate.raw || "")}" data-regex="${escapeAttr(candidate.regex || probe.suggestedRegex || "")}">
                  <em>Preis ${index + 1}</em>
                  <strong>${escapeHtml(fmtNumber(candidate.value))} €/t</strong>
                  <span>${escapeHtml(candidate.snippet || "")}</span>
                  <small>${escapeHtml(candidate.reason || "Diesen Preis verwenden")}</small>
                </button>`,
            )
            .join("")}</div>`
        : ""
    }
  `;
}

function renderSourceParserResult(result, { pending = false, selectedValue = null } = {}) {
  const host = document.getElementById("sourceParserResult");
  if (!host) return;
  if (!result && !pending) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  if (pending) {
    setSourceFlowStep("usage");
    host.className = "source-parser-result is-pending";
    host.innerHTML = `<strong>3. Parser wird validiert …</strong><span>Die Quelle wird mit dem gewählten Preis-Regelwerk getestet.</span>`;
    return;
  }
  if (result?.ok) {
    setSourceFlowStep("usage");
    host.className = "source-parser-result is-ok";
    const parsed = result.priceEurPerTon != null ? `${fmtNumber(result.priceEurPerTon)} €/t` : "—";
    const expected = selectedValue != null ? `${fmtNumber(Number(selectedValue))} €/t` : "";
    host.innerHTML = `<strong>3. Parser passt</strong><span>Erkannt: ${escapeHtml(parsed)}${expected ? ` · Ausgewählt: ${escapeHtml(expected)}` : ""}. Du kannst die Quelle jetzt speichern.</span>`;
    return;
  }
  host.className = "source-parser-result is-error";
  host.innerHTML = `<strong>3. Parser noch nicht passend</strong><span>${escapeHtml(result?.error || "Der Test hat keinen Preis gefunden. Wähle einen anderen Kandidaten oder passe den Regex an.")}</span>`;
}

async function probeSourceFromDialog() {
  const url = String(document.getElementById("src_url")?.value || "").trim();
  if (!url) throw new Error("Bitte zuerst eine URL einfügen.");
  const query = getQueryFromForm();
  const data = await apiFetch("/api/sources/probe", { method: "POST", body: JSON.stringify({ url, query }) });
  return data.probe;
}

async function analyzeSourceWithAiFromDialog() {
  const url = String(document.getElementById("src_url")?.value || "").trim();
  if (!url) throw new Error("Bitte zuerst eine URL einfügen.");
  const query = getQueryFromForm();
  const data = await apiFetch("/api/sources/ai-analyze", { method: "POST", body: JSON.stringify({ url, query }) });
  const extraction = data.extraction || {};
  const value = Number(extraction.priceEurPerTon);
  const raw = extraction.priceText || (Number.isFinite(value) ? `${String(value).replace(".", ",")} € pro Tonne` : "");
  const probe = {
    url: data.page?.url || url,
    rendered: Boolean(data.page?.rendered),
    suggestedRegex: "(\\d{2,4}(?:[\\.,]\\d{1,2})?)\\s*(?:€|EUR)\\s*(?:/|pro|je)\\s*(?:Tonne|1000\\s*kg|t)",
    candidates: Number.isFinite(value)
      ? [
          {
            value,
            raw,
            snippet: extraction.reason || "Von KI als relevanter Pelletpreis pro Tonne erkannt.",
            reason: `KI · ${Math.round(Number(extraction.confidence || 0) * 100)}% Sicherheit`,
            regex: "(\\d{2,4}(?:[\\.,]\\d{1,2})?)\\s*(?:€|EUR)\\s*(?:\\/|pro|je)\\s*(?:Tonne|1000\\s*kg|t)",
          },
        ]
      : [],
  };
  renderSourceProbe(probe);
  if (probe.rendered) {
    const kindEl = document.getElementById("src_kind");
    const stepsEl = document.getElementById("src_steps");
    if (kindEl) kindEl.value = "playwright";
    if (stepsEl && !String(stepsEl.value || "").trim()) {
      stepsEl.value = JSON.stringify([{ action: "goto", url: "{url}" }, { action: "waitForTimeout", timeoutMs: 1200 }], null, 2);
    }
  }
  const nameEl = document.getElementById("src_name");
  if (nameEl && !String(nameEl.value || "").trim() && probe.url) nameEl.value = new URL(probe.url).hostname.replace(/^www\./, "");
  const firstCandidate = document.querySelector("#sourceProbeResult .probe-candidate");
  if (firstCandidate) firstCandidate.click();
  return extraction;
}

function regexForRawPrice(raw) {
  const number = String(raw || "").match(/\d{1,4}(?:[.,]\d{1,2})?/);
  if (number) return `(\\d{2,4}(?:[\\.,]\\d{1,2})?)\\s*(?:€|EUR)\\s*(?:\\/|pro|je)\\s*(?:Tonne|1000\\s*kg|t)`;
  const escaped = String(raw || "")
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s*");
  return escaped ? `(${escaped})` : "(\\d{2,4}(?:[\\.,]\\d{1,2})?)\\s*(?:€|EUR)";
}

function renderHistory(items) {
  const body = $("historyBody");
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted">Noch keine Einträge.</td></tr>`;
    return;
  }

  body.innerHTML = items
    .map((q) => {
      const sourceCell = linkHtml(q.url, q.sourceName || q.sourceId);
      return `<tr>
        <td class="muted" data-label="Zeit">${escapeHtml(fmtTime(q.retrievedAt))}</td>
        <td data-label="Quelle">${sourceCell}</td>
        <td class="muted" data-label="PLZ">${escapeHtml(q.query?.postalCode || "—")}</td>
        <td class="muted" data-label="Menge (t)">${escapeHtml(fmtNumber(q.query?.quantityTons))}</td>
        <td class="muted" data-label="Produkt">${escapeHtml(mapProductLabel(q.query?.product))}</td>
        <td data-label="Preis (€/t)">${q.priceEurPerTon != null ? escapeHtml(`${fmtNumber(q.priceEurPerTon)} €`) : "—"}</td>
        <td class="muted" data-label="Stand">${escapeHtml(q.asOf || "—")}</td>
        <td data-label="Status">${statusCellHtml(q)}</td>
      </tr>`;
    })
    .join("");
}

async function refreshHistory() {
  const data = await apiFetch("/api/history?limit=80");
  renderHistory(data.items || []);
}

function renderDailyHistory() {
  return renderDailyHistoryImpl({
    state,
    $,
    escapeHtml,
    escapeAttr,
    fmtDateKey,
    fmtMoney,
    fmtNumber,
    isSafeHttpUrl,
    linkHtml,
  });
}

function setFooterVersion({ version, rev, updateAvailable, updateHint, frontendUpdateReady, updateRequested, remoteOk = true, remoteError = "" } = {}) {
  const el = document.getElementById("footerVersion");
  const updateBtn = document.getElementById("runFrontendUpdateBtn");
  const v = String(version || "").trim();
  const r = String(rev || "").trim();
  const parts = [];
  if (v) parts.push(`v${v}`);
  if (r) parts.push(`rev ${r}`);
  if (updateAvailable) parts.push("Update verfügbar");
  if (remoteOk === false) parts.push("Updatecheck offen");
  if (el) {
    el.textContent = parts.join(" · ");
    el.title = String(remoteOk === false ? remoteError || "Online-Updatecheck konnte nicht geladen werden." : updateHint || "").trim();
  }
  if (updateBtn) {
    const canRun = Boolean(updateAvailable && !updateRequested);
    updateBtn.hidden = false;
    updateBtn.disabled = !canRun;
    updateBtn.title = String(
      updateAvailable
        ? frontendUpdateReady
          ? updateHint || "Update installieren."
          : `${updateHint || "Update verfügbar."}\n\nFrontend-Update ist nicht vollständig eingerichtet; beim Klick wird die Anleitung angezeigt.`
        : remoteOk === false
          ? remoteError || "Online-Updatecheck konnte nicht geladen werden."
          : updateHint || "",
    ).trim();
    updateBtn.textContent = updateRequested
      ? "Update läuft …"
      : updateAvailable && frontendUpdateReady
        ? "Update installieren"
        : updateAvailable
          ? "Update verfügbar"
          : updateAvailable === false
            ? "Auf aktuellem Stand"
            : "Update prüfen …";
  }
}

async function refreshUpdateStatus({ force = false } = {}) {
  const data = await apiFetch(`/api/update${force ? "?force=1" : ""}`);
  if (!data?.ok) return null;
  state.update = data;
  setFooterVersion({
    version: data.current?.version,
    rev: data.current?.rev,
    updateAvailable: Boolean(data.updateAvailable),
    updateHint: data.updateHint,
    frontendUpdateReady: Boolean(data.frontendUpdateReady),
    updateRequested: Boolean(data.updateRequested),
    remoteOk: data.remoteOk !== false,
    remoteError: data.remoteError,
  });
  return data;
}

function formatBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function renderSystem() {
  const host = document.getElementById("systemSummary");
  if (!host) return;
  const diag = state.diagnostics || {};
  const rate = diag.rateLimit || state.scrapeStatus?.rateLimit || {};
  const failed = Array.isArray(diag.sources?.failed) ? diag.sources.failed : [];
  const storage = Array.isArray(diag.storage) ? diag.storage : [];

  host.innerHTML = `
    <div class="overview-card"><div class="overview-title">Abruflimit</div><div class="overview-value">${escapeHtml(String(rate.remainingRuns ?? "—"))}</div><div class="overview-meta">echte Abrufe heute verfügbar${rate.nextAllowedAt ? `<br/>Nächster Abruf: ${escapeHtml(fmtTime(rate.nextAllowedAt))}` : ""}</div></div>
    <div class="overview-card"><div class="overview-title">Quellen</div><div class="overview-value">${escapeHtml(String(diag.sources?.enabled ?? "—"))}</div><div class="overview-meta">aktiv · ${escapeHtml(String(failed.length))} mit Fehler${failed.length ? `<br/>${escapeHtml(failed.map((source) => source.name).join(", "))}` : ""}</div></div>
    <div class="overview-card"><div class="overview-title">E-Mail</div><div class="overview-value">${diag.email?.configured ? "Bereit" : "Offen"}</div><div class="overview-meta">${diag.email?.configured ? `Empfänger: ${escapeHtml(diag.email.to || "—")}` : "SMTP noch nicht vollständig konfiguriert"}</div></div>
    <div class="overview-card"><div class="overview-title">KI-Analyse</div><div class="overview-value">${diag.ai?.configured ? "Bereit" : "Aus"}</div><div class="overview-meta">${diag.ai?.configured ? `${escapeHtml(diag.ai.provider || "KI")} · ${escapeHtml(diag.ai.model || "Standardmodell")}` : "Optional: API-Key unten hinterlegen"}</div></div>
    <div class="overview-card"><div class="overview-title">Playwright</div><div class="overview-value">${diag.playwright?.chromiumOk ? "Bereit" : "Prüfen"}</div><div class="overview-meta">${diag.playwright?.chromiumOk ? "Chromium installiert" : "Browser fehlt oder Playwright nicht verfügbar"}</div></div>
    <div class="overview-card"><div class="overview-title">Schutz</div><div class="overview-value">${diag.security?.passwordProtection ? "Passwort aktiv" : "LAN offen"}</div><div class="overview-meta">${diag.security?.passwordProtection ? `Benutzer: ${escapeHtml(diag.security.username || "admin")}` : "Optional: APP_PASSWORD setzen"}</div></div>
    <div class="overview-card system-storage"><div class="overview-title">Lokaler Speicher</div><div class="overview-meta">${storage.length ? storage.map((entry) => `${escapeHtml(entry.name)}: ${escapeHtml(formatBytes(entry.bytes))}`).join("<br/>") : "—"}</div></div>
  `;
}

async function refreshSystem() {
  const [diag, update, scrape] = await Promise.all([apiFetch("/api/diagnostics"), refreshUpdateStatus(), refreshScrapeStatus()]);
  state.diagnostics = diag || null;
  state.update = update || null;
  state.scrapeStatus = scrape || null;
  if (!update) setFooterVersion({ version: diag?.version });
  renderSystem();
}

function setupTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const jumps = Array.from(document.querySelectorAll("[data-tab-jump]"));
  const panels = {
    query: $("tab-query"),
    sources: $("tab-sources"),
    alarms: $("tab-alarms"),
    history: $("tab-history"),
    system: $("tab-system"),
  };

  function activate(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    Object.entries(panels).forEach(([k, el]) => el.classList.toggle("show", k === name));
  }

  function closeMobileNav() {
    const nav = document.getElementById("ppNavbar");
    const toggler = document.querySelector(".navbar-toggler");
    if (!nav || !toggler || window.matchMedia("(min-width: 992px)").matches) return;
    nav.classList.remove("show");
    toggler.classList.add("collapsed");
    toggler.setAttribute("aria-expanded", "false");
  }

  tabs.forEach((t) =>
    t.addEventListener("click", async () => {
      const name = t.dataset.tab;
      activate(name);
      closeMobileNav();
      if (name === "sources") {
        await refreshDiagnostics().catch(() => {});
        await refreshSettings().catch(() => {});
        await refreshSources().catch((e) => toast(e.message, { kind: "error" }));
      }
      if (name === "history") {
        await refreshDailyHistory({ apiFetch, $, state, toast, renderDailyHistory }).catch(() => {});
        await refreshHistory().catch((e) => toast(e.message, { kind: "error" }));
      }
      if (name === "alarms") {
        await refreshSettings().catch(() => {});
        await refreshSources().catch(() => {});
        await refreshEmailConfig().catch(() => {});
        await refreshAlerts().catch((e) => toast(e.message, { kind: "error" }));
      }
      if (name === "system") await refreshSystem().catch((e) => toast(e.message || "Diagnose nicht verfügbar", { kind: "error" }));
    }),
  );

  jumps.forEach((jump) =>
    jump.addEventListener("click", async () => {
      const name = jump.dataset.tabJump;
      activate(name);
      closeMobileNav();
      if (name === "alarms") {
        await refreshAlerts().catch((e) => toast(e.message || "Alarme nicht verfügbar", { kind: "error" }));
        await refreshEmailConfig().catch(() => {});
      }
      if (name === "history") {
        await refreshDailyHistory({ apiFetch, $, state, toast, renderDailyHistory });
        await refreshHistory().catch((e) => toast(e.message, { kind: "error" }));
      }
    }),
  );
}

function newLocalId(prefix = "id") {
  const rand = Math.random().toString(16).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

function renderEmailConfig(email) {
  const el = document.getElementById("emailConfigStatus");
  if (!el) return;
  if (!email) {
    el.textContent = "E-Mail: —";
    el.className = "badge text-bg-secondary border border-secondary-subtle";
    el.title = "SMTP-Konfiguration unbekannt.";
    return;
  }
  if (!email.configured) {
    el.textContent = "E-Mail: nicht konfiguriert";
    el.className = "badge text-bg-warning text-dark border border-warning-subtle";
    el.title =
      "SMTP ist nicht konfiguriert. Setze in /etc/pelletpreis-checker.env z. B. SMTP_HOST, SMTP_FROM, ALERT_TO (und optional SMTP_USER/SMTP_PASS). Danach: systemctl restart pelletpreis-checker.service";
    return;
  }
  el.textContent = "E-Mail: OK";
  el.className = "badge text-bg-success border border-success-subtle";
  el.title = `SMTP: ${email.host || "—"}:${email.port || ""} → ${email.to || "—"}`;
}

async function refreshEmailConfig() {
  const data = await apiFetch("/api/email/config");
  state.email = data.email || null;
  renderEmailConfig(state.email);
}

function renderAlerts() {
  const body = document.getElementById("alertsBody");
  if (!body) return;
  const alerts = state.alerts;
  const rules = Array.isArray(alerts?.rules) ? alerts.rules : [];
  const sourcesById = new Map((state.sources || []).map((s) => [String(s.id), s]));

  // Populate add form select
  const sel = document.getElementById("alert_sourceId");
  if (sel) {
    const cur = String(sel.value || "");
    const opts = state.sources
      .filter((s) => s && s.enabled)
      .map((s) => `<option value="${escapeAttr(s.id)}">${escapeHtml(s.name)}</option>`)
      .join("");
    sel.innerHTML = opts || `<option value="">(keine aktivierten Quellen)</option>`;
    if (cur && state.sources.some((s) => String(s.id) === cur)) sel.value = cur;
  }

  if (!rules.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted">Noch keine Alarme angelegt.</td></tr>`;
    return;
  }

  body.innerHTML = rules
    .map((r) => {
      const src = sourcesById.get(String(r.sourceId || "")) || null;
      const srcName = src ? src.name : r.sourceId || "—";
      const enabled = r.enabled ? "checked" : "";
      const lastMail = r.lastSentAt ? fmtTime(r.lastSentAt) : "—";
      const status = r.lastError ? `<span class="status err" title="${escapeAttr(r.lastError)}">Fehler</span>` : `<span class="status ok">OK</span>`;
      const name = r.name ? escapeHtml(String(r.name)) : `<span class="muted">—</span>`;
      const thr = typeof r.thresholdEurPerTon === "number" ? r.thresholdEurPerTon : "";
      const direction = r.direction === "above" ? "above" : "below";
      return `<tr>
        <td data-label="Aktiv"><input type="checkbox" data-action="toggleAlert" data-id="${escapeAttr(r.id)}" ${enabled} /></td>
        <td data-label="Name">${name}</td>
        <td data-label="Quelle">${escapeHtml(srcName)}</td>
        <td data-label="Richtung">
          <select class="form-select form-select-sm alert-direction-select" data-action="direction" data-id="${escapeAttr(r.id)}">
            <option value="below" ${direction === "below" ? "selected" : ""}>≤ Grenzwert</option>
            <option value="above" ${direction === "above" ? "selected" : ""}>≥ Grenzwert</option>
          </select>
        </td>
        <td class="right" data-label="Grenzwert (€/t)">
          <input class="form-control form-control-sm alert-threshold-input" type="number" step="0.01" min="1"
            value="${escapeAttr(String(thr))}" data-action="threshold" data-id="${escapeAttr(r.id)}" />
        </td>
        <td class="muted right" data-label="Letzte E-Mail">${escapeHtml(lastMail)}</td>
        <td data-label="Status">${status}</td>
        <td class="right" data-label="Aktion">
          <button class="btn btn-outline-light btn-sm" type="button" data-action="saveAlert" data-id="${escapeAttr(r.id)}">Speichern</button>
          <button class="btn btn-outline-danger btn-sm" type="button" data-action="deleteAlert" data-id="${escapeAttr(r.id)}">Löschen</button>
        </td>
      </tr>`;
    })
    .join("");
}

function syncAlertDirectionUi() {
  const direction = String(document.getElementById("alert_direction")?.value || "below");
  const isAbove = direction === "above";
  const thresholdHelp = document.getElementById("alert_threshold_help");
  const rearmLabel = document.getElementById("alert_rearm_label");
  const rearmInput = document.getElementById("alert_rearmAbove");
  const rearmHelp = document.getElementById("alert_rearm_help");
  const repeatLabel = document.getElementById("alert_repeat_label");
  const repeatHelp = document.getElementById("alert_repeat_help");

  if (thresholdHelp) thresholdHelp.textContent = isAbove ? "Alarm bei Preis ≥ Grenzwert." : "Alarm bei Preis ≤ Grenzwert.";
  if (rearmLabel) rearmLabel.textContent = isAbove ? "Erneut aktiv bis (€/t)" : "Erneut aktiv ab (€/t)";
  if (rearmInput) rearmInput.placeholder = isAbove ? "z. B. 378" : "z. B. 362";
  if (rearmHelp) {
    rearmHelp.textContent = isAbove
      ? "Nach einem Fall darunter kann ein neuer Preisanstieg erneut auslösen."
      : "Nach einem Anstieg darüber kann ein neuer Preisfall erneut auslösen.";
  }
  if (repeatLabel) repeatLabel.textContent = isAbove ? "bei dauerhaft hohem Preis wiederholen" : "bei dauerhaft niedrigem Preis wiederholen";
  if (repeatHelp) {
    repeatHelp.textContent = isAbove
      ? "Sonst erst nach Entschärfung und erneutem Überschreiten."
      : "Sonst erst nach Entschärfung und erneutem Unterschreiten.";
  }
}

async function refreshAlerts() {
  const data = await apiFetch("/api/alerts");
  state.alerts = data.alerts || null;
  renderAlerts();
}

async function saveAlertsToServer() {
  const rules = Array.isArray(state.alerts?.rules) ? state.alerts.rules : [];
  const data = await apiFetch("/api/alerts", { method: "PUT", body: JSON.stringify({ alerts: { rules } }) });
  state.alerts = data.alerts || null;
  renderAlerts();
  return state.alerts;
}

function setupEvents() {
  const postalEl = $("postalCode");
  postalEl.addEventListener("input", () => {
    const cleaned = String(postalEl.value || "").replace(/\D/g, "").slice(0, 5);
    if (postalEl.value !== cleaned) postalEl.value = cleaned;
  });

  $("queryForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = getQueryFromForm();
    const validationError = validateQuery(query);
    if (validationError) {
      toast(validationError, { kind: "error", timeoutMs: 5200 });
      if (!/^\d{5}$/.test(query.postalCode)) $("postalCode").focus();
      else if (!Number.isFinite(Number(query.quantityTons)) || Number(query.quantityTons) <= 0) $("quantityTons").focus();
      else $("product").focus();
      return;
    }

    setLoading(true);
    $("resultsAvgBody").innerHTML = loadingRow(6, "Preise werden abgefragt …");
    $("resultsOffersBody").innerHTML = loadingRow(7, "Angebote werden sortiert …");
    try {
      toast("Abruf läuft …", { timeoutMs: 1800 });
      const data = await apiFetch("/api/scrape/run", { method: "POST", body: JSON.stringify({ query }), timeoutMs: 60_000 });
      renderResults({ query: data.query, results: data.results || [], meta: data.meta || {} });
      state.lastQuery = data.query;
      state.lastResults = data.results || [];
      await refreshScrapeStatus().catch(() => {});
      if (data?.meta?.rateLimited) {
        const msg = data?.meta?.rateLimit?.error || "Rate-Limit aktiv – zeige Cache-Daten (falls vorhanden).";
        toast(msg, { kind: "warning", timeoutMs: 6500 });
      } else {
        toast("Fertig.", { kind: "success" });
      }
    } catch (err) {
      const msg = err?.name === "AbortError" ? "Zeitüberschreitung beim Abruf (bitte erneut versuchen)." : err.message || "Fehler";
      toast(msg, { kind: "error", timeoutMs: 5200 });
    } finally {
      setLoading(false);
    }
  });

  $("refreshSourcesBtn").addEventListener("click", () => refreshSources().catch((e) => toast(e.message, { kind: "error" })));
  const autoCb = document.getElementById("autoDailyEnabled");
  if (autoCb) {
    autoCb.addEventListener("change", async () => {
      try {
        const nextEnabled = Boolean(autoCb.checked);
        const data = await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify({ settings: { autoDailyEnabled: nextEnabled } }) });
        state.settings = data.settings || null;
        applySettingsToUi(state.settings);
        toast(nextEnabled ? "Auto-Abruf aktiviert." : "Auto-Abruf deaktiviert.", { kind: "success" });
      } catch (err) {
        autoCb.checked = Boolean(state.settings?.autoDailyEnabled);
        toast(err.message || "Fehler", { kind: "error" });
      }
    });
  }

  const addAlertBtn = document.getElementById("addAlertBtn");
  const alertDirection = document.getElementById("alert_direction");
  if (alertDirection) {
    alertDirection.addEventListener("change", syncAlertDirectionUi);
    syncAlertDirectionUi();
  }
  if (addAlertBtn) {
    addAlertBtn.addEventListener("click", async () => {
      try {
        const sourceId = String(document.getElementById("alert_sourceId")?.value || "").trim();
        const direction = String(document.getElementById("alert_direction")?.value || "below") === "above" ? "above" : "below";
        const threshold = Number(document.getElementById("alert_threshold")?.value || "");
        const minIntervalHours = Number(document.getElementById("alert_minIntervalHours")?.value || 12);
        const rearmValue = Number(document.getElementById("alert_rearmAbove")?.value || "");
        const name = String(document.getElementById("alert_name")?.value || "").trim();
        const matchQuery = Boolean(document.getElementById("alert_matchQuery")?.checked);
        const repeatWhileTriggered = Boolean(document.getElementById("alert_repeatWhileBelow")?.checked);

        if (!sourceId) return toast("Bitte eine Quelle auswählen.", { kind: "error" });
        if (!Number.isFinite(threshold) || threshold <= 0) return toast("Bitte einen gültigen Schwellwert (€/t) eingeben.", { kind: "error" });

        const baseQuery = state.lastQuery || state.settings?.lastQuery || null;
        const rule = {
          id: newLocalId("al"),
          enabled: true,
          name,
          sourceId,
          direction,
          thresholdEurPerTon: threshold,
          minIntervalHours: Number.isFinite(minIntervalHours) ? minIntervalHours : 12,
          rearmAboveEurPerTon: direction === "below" && Number.isFinite(rearmValue) && rearmValue >= threshold ? rearmValue : threshold + 2,
          rearmBelowEurPerTon: direction === "above" && Number.isFinite(rearmValue) && rearmValue > 0 && rearmValue <= threshold ? rearmValue : Math.max(1, threshold - 2),
          repeatWhileBelow: repeatWhileTriggered,
          repeatWhileTriggered,
          matchQuery,
          query: matchQuery ? baseQuery : null,
        };

        const cur = state.alerts && typeof state.alerts === "object" ? state.alerts : { rules: [] };
        state.alerts = { ...cur, rules: [...(cur.rules || []), rule] };
        await saveAlertsToServer();

        document.getElementById("alert_threshold").value = "";
        document.getElementById("alert_rearmAbove").value = "";
        document.getElementById("alert_name").value = "";
        document.getElementById("alert_repeatWhileBelow").checked = false;
        toast("Alarm gespeichert.", { kind: "success" });
      } catch (err) {
        toast(err.message || "Fehler", { kind: "error" });
      }
    });
  }

  const sendTestEmailBtn = document.getElementById("sendTestEmailBtn");
  if (sendTestEmailBtn) {
    sendTestEmailBtn.addEventListener("click", async () => {
      try {
        await refreshEmailConfig().catch(() => {});
        if (!state.email?.configured) {
          return toast("SMTP ist nicht konfiguriert (siehe Tooltip bei „E-Mail“).", { kind: "error", timeoutMs: 5200 });
        }
        sendTestEmailBtn.disabled = true;
        await apiFetch("/api/email/test", { method: "POST", body: JSON.stringify({}) });
        toast("Testmail wurde gesendet.", { kind: "success", timeoutMs: 4200 });
      } catch (err) {
        toast(err.message || "Fehler beim Senden der Testmail.", { kind: "error", timeoutMs: 5200 });
      } finally {
        sendTestEmailBtn.disabled = false;
      }
    });
  }

  const alertsBody = document.getElementById("alertsBody");
  if (alertsBody) {
    alertsBody.addEventListener("change", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const action = t.dataset.action;
      const id = t.dataset.id;
      if (!action || !id) return;
      const rules = Array.isArray(state.alerts?.rules) ? state.alerts.rules : [];
      const idx = rules.findIndex((r) => String(r.id) === String(id));
      if (idx < 0) return;

      if (action === "toggleAlert" && t instanceof HTMLInputElement) {
        rules[idx] = { ...rules[idx], enabled: Boolean(t.checked) };
        state.alerts = { ...state.alerts, rules };
      }
      if (action === "threshold" && t instanceof HTMLInputElement) {
        const n = Number(t.value);
        if (Number.isFinite(n) && n > 0) {
          rules[idx] = { ...rules[idx], thresholdEurPerTon: n };
          state.alerts = { ...state.alerts, rules };
        }
      }
      if (action === "direction" && t instanceof HTMLSelectElement) {
        const direction = t.value === "above" ? "above" : "below";
        rules[idx] = { ...rules[idx], direction, lastBelow: false, lastAbove: false };
        state.alerts = { ...state.alerts, rules };
      }
    });

    alertsBody.addEventListener("click", async (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const action = t.dataset.action;
      const id = t.dataset.id;
      if (!action || !id) return;

      const rules = Array.isArray(state.alerts?.rules) ? state.alerts.rules : [];
      const idx = rules.findIndex((r) => String(r.id) === String(id));
      if (idx < 0) return;

      if (action === "deleteAlert") {
        state.alerts = { ...state.alerts, rules: rules.filter((r) => String(r.id) !== String(id)) };
        await saveAlertsToServer();
        toast("Alarm gelöscht.", { kind: "success" });
      }
      if (action === "saveAlert") {
        await saveAlertsToServer();
        toast("Alarm gespeichert.", { kind: "success" });
      }
    });
  }

  ["offersSearch", "offersSort", "offersSortDir", "offersOnlyOrderable"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () =>
      applyOffersView({ state, $, escapeHtml, fmtMoney, fmtNumber, fmtTime, isSafeHttpUrl, escapeAttr, linkHtml, statusCellHtml }),
    );
    el.addEventListener("change", () =>
      applyOffersView({ state, $, escapeHtml, fmtMoney, fmtNumber, fmtTime, isSafeHttpUrl, escapeAttr, linkHtml, statusCellHtml }),
    );
  });

  ["dailyDays", "dailyGroupBy", "dailyOnlyOrderable", "dailyMetric", "dailySeriesSearch", "historyPostalCode", "historyProduct"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => refreshDailyHistory({ apiFetch, $, state, toast, renderDailyHistory }));
    el.addEventListener("change", () => refreshDailyHistory({ apiFetch, $, state, toast, renderDailyHistory }));
  });
  $("dailySeriesSelect").addEventListener("change", () => {
    state.dailySeriesKey = String($("dailySeriesSelect").value || "");
    renderDailyHistory();
  });

  const refreshSystemBtn = document.getElementById("refreshSystemBtn");
  if (refreshSystemBtn) refreshSystemBtn.addEventListener("click", () => refreshSystem().catch((e) => toast(e.message || "Diagnose nicht verfügbar", { kind: "error" })));

  const saveAiSettingsBtn = document.getElementById("saveAiSettingsBtn");
  const aiApiKeyInput = document.getElementById("aiApiKey");
  if (aiApiKeyInput) {
    aiApiKeyInput.addEventListener("focus", () => {
      if (aiApiKeyInput.value === SAVED_KEY_MASK) aiApiKeyInput.value = "";
    });
    aiApiKeyInput.addEventListener("blur", () => {
      if (!aiApiKeyInput.value && state.settings?.ai?.configured) aiApiKeyInput.value = SAVED_KEY_MASK;
    });
  }

  if (saveAiSettingsBtn) {
    saveAiSettingsBtn.addEventListener("click", async () => {
      saveAiSettingsBtn.disabled = true;
      try {
        const provider = String(document.getElementById("aiProvider")?.value || "");
        const model = String(document.getElementById("aiModel")?.value || "").trim();
        const apiKey = String(document.getElementById("aiApiKey")?.value || "").trim();
        const shouldUpdateApiKey = apiKey && apiKey !== SAVED_KEY_MASK;
        const data = await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify({ settings: { ai: { provider, model, ...(shouldUpdateApiKey ? { apiKey } : {}) } } }) });
        state.settings = data.settings || null;
        applySettingsToUi(state.settings);
        await refreshSystem().catch(() => {});
        toast("KI-Einstellungen gespeichert.", { kind: "success" });
      } catch (err) {
        toast(err.message || "KI-Einstellungen konnten nicht gespeichert werden.", { kind: "error", timeoutMs: 6200 });
      } finally {
        saveAiSettingsBtn.disabled = false;
      }
    });
  }
  const runUpdateBtn = document.getElementById("runFrontendUpdateBtn");
  if (runUpdateBtn) {
    runUpdateBtn.addEventListener("click", async () => {
      const update = state.update || (await refreshUpdateStatus({ force: true }).catch(() => null));
      if (update?.updateAvailable && !update.frontendUpdateReady) {
        const hint = String(update.updateHint || "").trim();
        await navigator.clipboard?.writeText?.(hint).catch(() => {});
        toast("Update verfügbar. Die Debian/LXC-Anleitung wurde in die Zwischenablage kopiert.", { kind: "success", timeoutMs: 7000 });
        return;
      }
      if (!update?.updateAvailable) {
        await refreshUpdateStatus({ force: true }).catch(() => null);
        toast(state.update?.updateAvailable ? "Update gefunden." : "Aktuell ist kein Update verfügbar.", { kind: state.update?.updateAvailable ? "success" : "info", timeoutMs: 3600 });
        return;
      }
      runUpdateBtn.disabled = true;
      toast("Warteseite wird geöffnet. Das Update startet dort automatisch.", { kind: "success", timeoutMs: 3200 });
      window.location.href = "/pelletpreise/update.html?start=1";
    });
  }
  const compareHost = document.getElementById("dailyCompareSeries");
  if (compareHost) compareHost.addEventListener("change", () => renderDailyHistory());

  // Sources table actions
  $("sourcesBody").addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "addFirstSource") {
      openSourceDialog({ enabled: true, kind: "http-regex" });
      return;
    }
    const id = btn.dataset.id;
    if (!id) return;
    const src = state.sources.find((s) => s.id === id);
    if (!src) return;

    if (action === "edit") openSourceDialog(src);
    if (action === "delete") {
      if (!confirm(`Quelle wirklich löschen?\n\n${src.name}`)) return;
      try {
        await apiFetch(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
        await refreshSources();
        toast("Quelle gelöscht.", { kind: "success" });
      } catch (err) {
        toast(err.message || "Fehler", { kind: "error" });
      }
    }
  });

  $("sourcesBody").addEventListener("change", async (e) => {
    const cb = e.target?.closest?.('input[type="checkbox"][data-action="toggle"]');
    const hm = e.target?.closest?.('select[data-action="historyMode"]');
    const el = cb || hm;
    if (!el) return;
    const id = el.dataset.id;
    const src = state.sources.find((s) => s.id === id);
    if (!src) return;
    try {
      if (cb) {
        await apiFetch(`/api/sources/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ source: { enabled: cb.checked } }) });
      } else if (hm) {
        await apiFetch(`/api/sources/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify({ source: { historyMode: String(hm.value || "auto") } }),
        });
      }
      await refreshSources();
      toast("Aktualisiert.", { kind: "success" });
    } catch (err) {
      if (cb) cb.checked = !cb.checked;
      if (hm) hm.value = String(src.historyMode || "auto");
      toast(err.message || "Fehler", { kind: "error" });
    }
  });

  $("addSourceBtn").addEventListener("click", () => openSourceDialog({ enabled: true, kind: "http-regex" }));
  document.getElementById("addSourceBtnHero")?.addEventListener("click", () => openSourceDialog({ enabled: true, kind: "http-regex" }));

  const closeSourceDialog = () => $("sourceDialog").close();
  document.getElementById("closeSourceDialogBtn")?.addEventListener("click", closeSourceDialog);
  document.getElementById("cancelSourceDialogBtn")?.addEventListener("click", closeSourceDialog);

  $("sourceForm").addEventListener("submit", async (e) => {
    const submitter = e.submitter;
    if (!submitter) return;
    if (submitter.value !== "save") return;
    e.preventDefault();

    $("saveSourceBtn").disabled = true;
    try {
      await saveSourceFromDialog();
      $("sourceDialog").close();
      await refreshSources();
      toast("Quelle gespeichert.", { kind: "success" });
    } catch (err) {
      toast(err.message || "Fehler", { kind: "error" });
    } finally {
      $("saveSourceBtn").disabled = false;
    }
  });

  $("testSourceBtn").addEventListener("click", async () => {
    $("testSourceBtn").disabled = true;
    renderSourceParserResult(null, { pending: true });
    try {
      const data = await testSourceFromDialog();
      renderSourceParserResult(data.result);
      if (data.result?.ok) {
        toast(`OK: ${fmtNumber(data.result.priceEurPerTon)} €/t`, { kind: "success" });
      } else {
        toast(data.result?.error || "Test fehlgeschlagen.", { kind: "error" });
      }
    } catch (err) {
      renderSourceParserResult({ ok: false, error: err.message || "Fehler" });
      toast(err.message || "Fehler", { kind: "error" });
    } finally {
      $("testSourceBtn").disabled = false;
    }
  });

  const probeSourceBtn = document.getElementById("probeSourceBtn");
  if (probeSourceBtn) {
    probeSourceBtn.addEventListener("click", async () => {
      probeSourceBtn.disabled = true;
      document.getElementById("probeSourceBtnTop")?.setAttribute("disabled", "disabled");
      const oldText = probeSourceBtn.textContent;
      probeSourceBtn.textContent = "Prüfe …";
      try {
        const probe = await probeSourceFromDialog();
        renderSourceProbe(probe);
        if (probe?.rendered) {
          const kindEl = document.getElementById("src_kind");
          const stepsEl = document.getElementById("src_steps");
          if (kindEl) kindEl.value = "playwright";
          if (stepsEl && !String(stepsEl.value || "").trim()) {
            stepsEl.value = JSON.stringify(
              [
                { action: "goto", url: "{url}" },
                { action: "waitForTimeout", timeoutMs: 1200 },
              ],
              null,
              2,
            );
          }
          setSourceFlowStep("price");
        }
        if (!String(document.getElementById("src_name")?.value || "").trim() && probe?.url) {
          document.getElementById("src_name").value = new URL(probe.url).hostname.replace(/^www\./, "");
        }
        toast("Link geprüft. Wähle bei Bedarf einen Regex-Vorschlag.", { kind: "success" });
      } catch (err) {
        renderSourceProbe({
          url: String(document.getElementById("src_url")?.value || ""),
          candidates: [],
          suggestedRegex: "",
        });
        toast(err.message || "Link konnte nicht geprüft werden.", { kind: "error", timeoutMs: 6200 });
      } finally {
        probeSourceBtn.disabled = false;
        probeSourceBtn.textContent = oldText;
        document.getElementById("probeSourceBtnTop")?.removeAttribute("disabled");
      }
    });
  }

  const probeSourceBtnTop = document.getElementById("probeSourceBtnTop");
  if (probeSourceBtnTop) {
    probeSourceBtnTop.addEventListener("click", () => document.getElementById("probeSourceBtn")?.click());
  }

  const runAiAnalyze = async (button) => {
    const related = [document.getElementById("aiAnalyzeSourceBtn"), document.getElementById("aiAnalyzeSourceBtnTop")].filter(Boolean);
    const previous = button?.textContent;
    related.forEach((btn) => (btn.disabled = true));
    if (button) button.textContent = "KI prüft …";
    try {
      const extraction = await analyzeSourceWithAiFromDialog();
      toast(`KI erkannt: ${fmtNumber(extraction.priceEurPerTon)} €/t`, { kind: "success" });
    } catch (err) {
      toast(err.message || "KI-Analyse fehlgeschlagen.", { kind: "error", timeoutMs: 7200 });
    } finally {
      related.forEach((btn) => (btn.disabled = false));
      if (button && previous) button.textContent = previous;
    }
  };

  document.getElementById("aiAnalyzeSourceBtn")?.addEventListener("click", (event) => runAiAnalyze(event.currentTarget));
  document.getElementById("aiAnalyzeSourceBtnTop")?.addEventListener("click", (event) => runAiAnalyze(event.currentTarget));

  const sourceProbeResult = document.getElementById("sourceProbeResult");
  if (sourceProbeResult) {
    sourceProbeResult.addEventListener("click", async (e) => {
      const btn = e.target?.closest?.("[data-probe-action]");
      if (!btn) return;
      const action = btn.dataset.probeAction;
      const regexInput = document.getElementById("src_regex");
      if (!regexInput) return;
      if (action === "useRegex") {
        regexInput.value = btn.dataset.regex || "(\\d{2,4}(?:[\\.,]\\d{1,2})?)\\s*(?:€|EUR)\\s*(?:/|pro)\\s*(?:Tonne|t)";
        regexInput.focus();
        setSourceFlowStep("usage");
        toast("Regex-Vorschlag übernommen. Jetzt „Testen“ drücken.", { kind: "success" });
      }
      if (action === "choosePrice") {
        sourceProbeResult.querySelectorAll(".probe-candidate").forEach((el) => el.classList.remove("is-selected"));
        btn.classList.add("is-selected");
        regexInput.value = btn.dataset.regex || regexForRawPrice(btn.dataset.raw || "");
        renderSourceParserResult(null, { pending: true, selectedValue: btn.dataset.value });
        try {
          const data = await testSourceFromDialog();
          renderSourceParserResult(data.result, { selectedValue: btn.dataset.value });
          if (data.result?.ok) {
            toast(`Preis übernommen und validiert: ${fmtNumber(data.result.priceEurPerTon)} €/t`, { kind: "success" });
          } else {
            toast(data.result?.error || "Parser-Test fehlgeschlagen.", { kind: "error", timeoutMs: 6200 });
          }
        } catch (err) {
          renderSourceParserResult({ ok: false, error: err.message || "Parser-Test fehlgeschlagen." }, { selectedValue: btn.dataset.value });
          toast(err.message || "Parser-Test fehlgeschlagen.", { kind: "error", timeoutMs: 6200 });
        }
      }
    });
  }

  document.getElementById("src_kind")?.addEventListener("change", () => setSourceFlowStep(state.sourceFlowStep));
  document.getElementById("src_url")?.addEventListener("input", () => {
    if (!String(document.getElementById("src_url")?.value || "").trim()) renderSourceProbe(null);
  });

  $("exportSourcesBtn").addEventListener("click", async () => {
    try {
      const data = await apiFetch("/api/sources/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pelletpreise-sources-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast(err.message || "Fehler", { kind: "error" });
    }
  });

  $("importSourcesInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await apiFetch("/api/sources/import", { method: "POST", body: JSON.stringify({ data }) });
      await refreshSources();
      toast("Import erfolgreich.", { kind: "success" });
    } catch (err) {
      toast(err.message || "Import fehlgeschlagen.", { kind: "error" });
    } finally {
      e.target.value = "";
    }
  });

  $("resetSourcesBtn").addEventListener("click", async () => {
    if (!confirm("Quellen auf Defaults zurücksetzen? Eigene Quellen gehen verloren.")) return;
    try {
      await apiFetch("/api/sources/reset", { method: "POST", body: JSON.stringify({}) });
      await refreshSources();
      toast("Zurückgesetzt.", { kind: "success" });
    } catch (err) {
      toast(err.message || "Fehler", { kind: "error" });
    }
  });

  $("reloadHistoryBtn").addEventListener("click", async () => {
    await refreshDailyHistory({ apiFetch, $, state, toast, renderDailyHistory });
    await refreshHistory().catch((e) => toast(e.message, { kind: "error" }));
  });

  $("clearHistoryBtn").addEventListener("click", async () => {
    if (!confirm("Historie wirklich löschen?")) return;
    try {
      await apiFetch("/api/history/clear", { method: "POST", body: JSON.stringify({}) });
      await refreshDailyHistory({ apiFetch, $, state, toast, renderDailyHistory });
      await refreshHistory();
      toast("Historie gelöscht.", { kind: "success" });
    } catch (err) {
      toast(err.message || "Fehler", { kind: "error" });
    }
  });
}

async function initialiseAuthenticatedApp({ showLogout = false } = {}) {
  if (authenticatedAppInitialized) return;
  authenticatedAppInitialized = true;
  document.getElementById("logoutBtn").hidden = !showLogout;
  if (new URLSearchParams(window.location.search).get("updated") === "1") {
    toast("Update abgeschlossen. Willkommen zurück.", { kind: "success", timeoutMs: 4200 });
    window.history.replaceState(null, "", "/pelletpreise/");
  }
  await refreshDiagnostics().catch(() => {});

  // Non-blocking update check (GitHub main SHA)
  refreshUpdateStatus().catch(() => {});
  window.setInterval(() => refreshUpdateStatus().catch(() => {}), 15 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshUpdateStatus({ force: true }).catch(() => {});
  });

  updateHistoryExportLinks({ $, state });

  await refreshSettings().catch(() => {});
  await refreshSources().catch(() => {});
  await refreshHistory().catch(() => {});
  await refreshScrapeStatus().catch(() => {});

  // Auto-run once on page load so the start page shows current prices immediately.
  try {
    const query = getQueryFromForm();
    const validationError = validateQuery(query);
    if (!validationError) {
      setLoading(true, "Aktualisiere …");
      $("resultsAvgBody").innerHTML = loadingRow(6, "Preise werden abgefragt …");
      $("resultsOffersBody").innerHTML = loadingRow(7, "Angebote werden sortiert …");
      toast("Aktualisiere Preise …", { timeoutMs: 1500 });
      const data = await apiFetch("/api/scrape/run", { method: "POST", body: JSON.stringify({ query }), timeoutMs: 60_000 });
      renderResults({ query: data.query, results: data.results || [], meta: data.meta || {} });
      state.lastQuery = data.query;
      state.lastResults = data.results || [];
      await refreshScrapeStatus().catch(() => {});
    }
  } catch {
    // ignore auto-run failures (user can click manually)
  } finally {
    setLoading(false);
  }
}

export async function bootstrap() {
  setupTabs();
  setupEvents();
  setupAuthEvents();

  try {
    const health = await apiFetch("/api/health");
    setServerStatus(`Server: OK (${health.version})`, true);
    setFooterVersion({ version: health.version });
    refreshUpdateStatus({ force: true }).catch(() => {});
  } catch {
    setServerStatus("Server: nicht erreichbar", false);
    toast("Server nicht erreichbar. Starte den lokalen Server.", { kind: "error", timeoutMs: 6000 });
    setFooterVersion({ version: "" });
    return;
  }

  try {
    const auth = await apiFetch("/api/auth/status");
    if (auth.required && !auth.authenticated) {
      showLoginDialog();
      return;
    }
    await initialiseAuthenticatedApp({ showLogout: Boolean(auth.required) });
  } catch (err) {
    toast(err.message || "Anmeldestatus konnte nicht geprüft werden.", { kind: "error", timeoutMs: 6000 });
  }
}
