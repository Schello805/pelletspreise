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

function normalizeExtract(ex) {
  if (!ex || typeof ex !== "object") return null;
  const out = {};
  if (ex.regex) out.regex = String(ex.regex);
  if (ex.regexAsOf) out.regexAsOf = String(ex.regexAsOf);
  if (ex.regexTotal) out.regexTotal = String(ex.regexTotal);
  return Object.keys(out).length ? out : null;
}

function statusCellHtml(result) {
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
};

let authenticatedAppInitialized = false;

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

function renderOverview({ query, avgResults, offerRows }) {
  const host = document.getElementById("overviewCards");
  if (!host) return;

  const avg = avgResults
    .filter((r) => r && r.ok && typeof r.priceEurPerTon === "number")
    .slice()
    .sort((a, b) => a.priceEurPerTon - b.priceEurPerTon);
  const bestAvg = avg[0] || null;

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
    <div class="overview-card">
      <div class="overview-title">Beste Bestellung (gesamt)</div>
      <div class="overview-value">${bestOffer ? safe(fmtTotal(bestOffer.totalEur)) : "—"}</div>
      <div class="overview-meta">
        ${bestOffer ? `${safe(bestOffer.dealer)} · ${safe(bestOffer.provider)}<br/>${safe(fmtPerTon(bestOffer.priceEurPerTon))}` : "—"}<br/>
        PLZ ${safe(query.postalCode)} · ${safe(fmtNumber(query.quantityTons))} t · ${safe(mapProductLabel(query.product))}
      </div>
      <div class="overview-actions">
        ${bestOffer ? orderLink(bestOffer.orderUrl) : ""}
      </div>
    </div>
    <div class="overview-card">
      <div class="overview-title">Deutschland-Ø (günstigste Quelle)</div>
      <div class="overview-value">${bestAvg ? safe(fmtPerTon(bestAvg.priceEurPerTon)).replace("€ / t", "€") : "—"}</div>
      <div class="overview-meta">
        ${bestAvg ? `${safe(bestAvg.sourceName || bestAvg.sourceId)}<br/>Stand: ${safe(bestAvg.asOf || "—")}` : "—"}
      </div>
      <div class="overview-actions">
        ${bestAvg && bestAvg.url ? `<a class="btn btn-sm btn-outline-light" href="${escapeAttr(bestAvg.url)}" target="_blank" rel="noopener noreferrer">Quelle öffnen</a>` : ""}
      </div>
    </div>
    <div class="overview-card">
      <div class="overview-title">Beste je Anbieter</div>
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

  renderOverview({ query, avgResults, offerRows: state.lastOffersRows });

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
          return `<tr>
            <td>${sourceCell}</td>
            <td class="right">${escapeHtml(price)}</td>
            <td class="right">${escapeHtml(total)}</td>
            <td class="muted">${escapeHtml(asOf)}</td>
            <td>${statusCellHtml(r)}</td>
            <td class="muted right">${escapeHtml(fmtTime(r.retrievedAt))}</td>
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
    body.innerHTML = `<tr><td colspan="6" class="muted">Keine Quellen angelegt.</td></tr>`;
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
      return `<tr>
        <td><input type="checkbox" data-action="toggle" data-id="${escapeAttr(s.id)}" ${enabled} /></td>
        <td>${escapeHtml(s.name)}</td>
        <td class="muted">${kindLabel}${cacheBadge}</td>
        <td>
          <select class="form-select form-select-sm" data-action="historyMode" data-id="${escapeAttr(s.id)}" aria-label="Statistik">
            ${hm("auto", "Auto")}
            ${hm("best", "Best")}
            ${hm("none", "Off")}
          </select>
        </td>
        <td class="muted">${escapeHtml(last)}<br/>${sourceHealth}</td>
        <td class="right">
          <button class="btn btn-outline-light btn-sm" type="button" data-action="edit" data-id="${escapeAttr(s.id)}">Bearbeiten</button>
          <button class="btn btn-outline-danger btn-sm" type="button" data-action="delete" data-id="${escapeAttr(s.id)}">Löschen</button>
        </td>
      </tr>`;
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

  $("sourceDialog").showModal();
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
        <td class="muted">${escapeHtml(fmtTime(q.retrievedAt))}</td>
        <td>${sourceCell}</td>
        <td class="muted">${escapeHtml(q.query?.postalCode || "—")}</td>
        <td class="muted">${escapeHtml(fmtNumber(q.query?.quantityTons))}</td>
        <td class="muted">${escapeHtml(mapProductLabel(q.query?.product))}</td>
        <td>${q.priceEurPerTon != null ? escapeHtml(`${fmtNumber(q.priceEurPerTon)} €`) : "—"}</td>
        <td class="muted">${escapeHtml(q.asOf || "—")}</td>
        <td>${statusCellHtml(q)}</td>
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

function setFooterVersion({ version, rev, updateAvailable, updateHint } = {}) {
  const el = document.getElementById("footerVersion");
  if (!el) return;
  const v = String(version || "").trim();
  const r = String(rev || "").trim();
  const parts = [];
  if (v) parts.push(`v${v}`);
  if (r) parts.push(`rev ${r}`);
  if (updateAvailable) parts.push("Update verfügbar");
  el.textContent = parts.join(" · ");
  el.title = String(updateHint || "").trim();
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
  const updateBtn = document.getElementById("runFrontendUpdateBtn");
  if (!host) return;
  const diag = state.diagnostics || {};
  const update = state.update || {};
  const rate = diag.rateLimit || state.scrapeStatus?.rateLimit || {};
  const failed = Array.isArray(diag.sources?.failed) ? diag.sources.failed : [];
  const storage = Array.isArray(diag.storage) ? diag.storage : [];
  const updateText = update.updateAvailable ? "Neue Version verfügbar" : update.remoteOk ? "Auf dem aktuellen Stand" : "GitHub-Status nicht verfügbar";
  const updateHint = update.frontendUpdateReady
    ? "Das Update startet als systemd-Job; die Seite verbindet sich danach automatisch neu."
    : "Frontend-Update benötigt APP_PASSWORD, ALLOW_FRONTEND_UPDATE=1 und den einmalig installierten systemd-Trigger.";

  host.innerHTML = `
    <div class="overview-card"><div class="overview-title">Abruflimit</div><div class="overview-value">${escapeHtml(String(rate.remainingRuns ?? "—"))}</div><div class="overview-meta">echte Abrufe heute verfügbar${rate.nextAllowedAt ? `<br/>Nächster Abruf: ${escapeHtml(fmtTime(rate.nextAllowedAt))}` : ""}</div></div>
    <div class="overview-card"><div class="overview-title">Quellen</div><div class="overview-value">${escapeHtml(String(diag.sources?.enabled ?? "—"))}</div><div class="overview-meta">aktiv · ${escapeHtml(String(failed.length))} mit Fehler${failed.length ? `<br/>${escapeHtml(failed.map((source) => source.name).join(", "))}` : ""}</div></div>
    <div class="overview-card"><div class="overview-title">E-Mail</div><div class="overview-value">${diag.email?.configured ? "Bereit" : "Offen"}</div><div class="overview-meta">${diag.email?.configured ? `Empfänger: ${escapeHtml(diag.email.to || "—")}` : "SMTP noch nicht vollständig konfiguriert"}</div></div>
    <div class="overview-card"><div class="overview-title">Playwright</div><div class="overview-value">${diag.playwright?.chromiumOk ? "Bereit" : "Prüfen"}</div><div class="overview-meta">${diag.playwright?.chromiumOk ? "Chromium installiert" : "Browser fehlt oder Playwright nicht verfügbar"}</div></div>
    <div class="overview-card"><div class="overview-title">Schutz</div><div class="overview-value">${diag.security?.passwordProtection ? "Passwort aktiv" : "LAN offen"}</div><div class="overview-meta">${diag.security?.passwordProtection ? `Benutzer: ${escapeHtml(diag.security.username || "admin")}` : "Optional: APP_PASSWORD setzen"}</div></div>
    <div class="overview-card"><div class="overview-title">Update</div><div class="overview-value">${escapeHtml(updateText)}</div><div class="overview-meta">${escapeHtml(updateHint)}</div></div>
    <div class="overview-card system-storage"><div class="overview-title">Lokaler Speicher</div><div class="overview-meta">${storage.length ? storage.map((entry) => `${escapeHtml(entry.name)}: ${escapeHtml(formatBytes(entry.bytes))}`).join("<br/>") : "—"}</div></div>
  `;

  if (updateBtn) {
    const canRun = Boolean(update.updateAvailable && update.frontendUpdateReady && !update.updateRequested);
    updateBtn.hidden = !update.updateAvailable;
    updateBtn.disabled = !canRun;
    updateBtn.title = updateHint;
    updateBtn.textContent = update.updateRequested ? "Update wird gestartet …" : "Update installieren";
  }
}

async function refreshSystem() {
  const [diag, update, scrape] = await Promise.all([apiFetch("/api/diagnostics"), apiFetch("/api/update"), refreshScrapeStatus()]);
  state.diagnostics = diag || null;
  state.update = update || null;
  state.scrapeStatus = scrape || null;
  setFooterVersion({
    version: update?.current?.version || diag?.version,
    rev: update?.current?.rev,
    updateAvailable: Boolean(update?.updateAvailable),
    updateHint: update?.updateHint,
  });
  renderSystem();
}

function setupTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
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

  tabs.forEach((t) =>
    t.addEventListener("click", async () => {
      const name = t.dataset.tab;
      activate(name);
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
    body.innerHTML = `<tr><td colspan="7" class="muted">Noch keine Alarme angelegt.</td></tr>`;
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
      return `<tr>
        <td><input type="checkbox" data-action="toggleAlert" data-id="${escapeAttr(r.id)}" ${enabled} /></td>
        <td>${name}</td>
        <td>${escapeHtml(srcName)}</td>
        <td class="right">
          <input class="form-control form-control-sm" style="max-width: 140px; margin-left:auto;" type="number" step="0.01" min="1"
            value="${escapeAttr(String(thr))}" data-action="threshold" data-id="${escapeAttr(r.id)}" />
        </td>
        <td class="muted right">${escapeHtml(lastMail)}</td>
        <td>${status}</td>
        <td class="right">
          <button class="btn btn-outline-light btn-sm" type="button" data-action="saveAlert" data-id="${escapeAttr(r.id)}">Speichern</button>
          <button class="btn btn-outline-danger btn-sm" type="button" data-action="deleteAlert" data-id="${escapeAttr(r.id)}">Löschen</button>
        </td>
      </tr>`;
    })
    .join("");
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
    $("resultsAvgBody").innerHTML = `<tr><td colspan="6" class="muted">Abruf läuft …</td></tr>`;
    $("resultsOffersBody").innerHTML = `<tr><td colspan="7" class="muted">Abruf läuft …</td></tr>`;
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
  if (addAlertBtn) {
    addAlertBtn.addEventListener("click", async () => {
      try {
        const sourceId = String(document.getElementById("alert_sourceId")?.value || "").trim();
        const threshold = Number(document.getElementById("alert_threshold")?.value || "");
        const minIntervalHours = Number(document.getElementById("alert_minIntervalHours")?.value || 12);
        const rearmAboveEurPerTon = Number(document.getElementById("alert_rearmAbove")?.value || "");
        const name = String(document.getElementById("alert_name")?.value || "").trim();
        const matchQuery = Boolean(document.getElementById("alert_matchQuery")?.checked);
        const repeatWhileBelow = Boolean(document.getElementById("alert_repeatWhileBelow")?.checked);

        if (!sourceId) return toast("Bitte eine Quelle auswählen.", { kind: "error" });
        if (!Number.isFinite(threshold) || threshold <= 0) return toast("Bitte einen gültigen Schwellwert (€/t) eingeben.", { kind: "error" });

        const baseQuery = state.lastQuery || state.settings?.lastQuery || null;
        const rule = {
          id: newLocalId("al"),
          enabled: true,
          name,
          sourceId,
          thresholdEurPerTon: threshold,
          minIntervalHours: Number.isFinite(minIntervalHours) ? minIntervalHours : 12,
          rearmAboveEurPerTon: Number.isFinite(rearmAboveEurPerTon) && rearmAboveEurPerTon >= threshold ? rearmAboveEurPerTon : threshold + 2,
          repeatWhileBelow,
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
  const runUpdateBtn = document.getElementById("runFrontendUpdateBtn");
  if (runUpdateBtn) {
    runUpdateBtn.addEventListener("click", async () => {
      if (!confirm("Update jetzt installieren? Die Webapp ist während des Neustarts kurz nicht erreichbar.")) return;
      try {
        runUpdateBtn.disabled = true;
        await apiFetch("/api/update/run", { method: "POST", body: JSON.stringify({}) });
        toast("Update angefordert. Die Seite wird in Kürze neu geladen.", { kind: "success", timeoutMs: 5200 });
        window.setTimeout(() => window.location.reload(), 10_000);
      } catch (err) {
        runUpdateBtn.disabled = false;
        toast(err.message || "Update konnte nicht gestartet werden.", { kind: "error", timeoutMs: 5200 });
      }
    });
  }
  ["dailyCompareMode", "dailyCompareMax"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => renderDailyHistory());
    el.addEventListener("change", () => renderDailyHistory());
  });
  const compareHost = document.getElementById("dailyCompareSeries");
  if (compareHost) compareHost.addEventListener("change", () => renderDailyHistory());

  // Sources table actions
  $("sourcesBody").addEventListener("click", async (e) => {
    const btn = e.target?.closest?.("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
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
    try {
      const data = await testSourceFromDialog();
      if (data.result?.ok) {
        toast(`OK: ${fmtNumber(data.result.priceEurPerTon)} €/t`, { kind: "success" });
      } else {
        toast(data.result?.error || "Test fehlgeschlagen.", { kind: "error" });
      }
    } catch (err) {
      toast(err.message || "Fehler", { kind: "error" });
    } finally {
      $("testSourceBtn").disabled = false;
    }
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
  await refreshDiagnostics().catch(() => {});

  // Non-blocking update check (GitHub main SHA)
  apiFetch("/api/update")
    .then((data) => {
      if (!data?.ok) return;
      setFooterVersion({
        version: data.current?.version,
        rev: data.current?.rev,
        updateAvailable: Boolean(data.updateAvailable),
        updateHint: data.updateHint,
      });
    })
    .catch(() => {});

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
      $("resultsAvgBody").innerHTML = `<tr><td colspan="6" class="muted">Abruf läuft …</td></tr>`;
      $("resultsOffersBody").innerHTML = `<tr><td colspan="7" class="muted">Abruf läuft …</td></tr>`;
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
