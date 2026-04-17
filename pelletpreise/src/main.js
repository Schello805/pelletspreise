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
  _dailyExportParams: "",
};

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

function renderResults({ query, results }) {
  const avgBody = $("resultsAvgBody");
  const offersBody = $("resultsOffersBody");
  const meta = $("resultsMeta");

  const avgResults = (results || []).filter(isAverageResult);
  const offerResults = (results || []).filter((r) => !isAverageResult(r));
  state.lastOffersRows = buildOfferRowsFromResults(offerResults);
  meta.textContent = `PLZ ${query.postalCode} · ${fmtNumber(query.quantityTons)} t · ${mapProductLabel(query.product)} · Ø ${avgResults.length} · Angebote ${state.lastOffersRows.length}`;

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
    body.innerHTML = `<tr><td colspan="5" class="muted">Keine Quellen angelegt.</td></tr>`;
    return;
  }

  body.innerHTML = sources
    .map((s) => {
      const enabled = s.enabled ? "checked" : "";
      const last = s.lastRunAt ? fmtTime(s.lastRunAt) : "—";
      return `<tr>
        <td><input type="checkbox" data-action="toggle" data-id="${escapeAttr(s.id)}" ${enabled} /></td>
        <td>${escapeHtml(s.name)}</td>
        <td class="muted">${escapeHtml(s.kind)}</td>
        <td class="muted">${escapeHtml(last)}</td>
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

function openSourceDialog(source) {
  state.editingSourceId = source?.id || null;
  $("sourceDialogTitle").textContent = source?.id ? "Quelle bearbeiten" : "Quelle hinzufügen";

  $("src_name").value = source?.name || "";
  $("src_enabled").value = String(Boolean(source?.enabled ?? true));
  $("src_kind").value = source?.kind || "http-regex";
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
  const url = String($("src_url").value || "").trim();
  const regex = String($("src_regex").value || "").trim();
  const regexAsOf = String($("src_regexAsOf").value || "").trim();
  const stepsText = String($("src_steps").value || "").trim();

  const source = {
    name: name || "Quelle",
    enabled,
    kind,
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

function setupTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panels = {
    query: $("tab-query"),
    sources: $("tab-sources"),
    history: $("tab-history"),
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
        await refreshSources().catch((e) => toast(e.message, { kind: "error" }));
      }
      if (name === "history") {
        await refreshDailyHistory({ apiFetch, $, state, toast, renderDailyHistory }).catch(() => {});
        await refreshHistory().catch((e) => toast(e.message, { kind: "error" }));
      }
    }),
  );
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
      renderResults({ query: data.query, results: data.results || [] });
      state.lastQuery = data.query;
      state.lastResults = data.results || [];
      toast("Fertig.", { kind: "success" });
    } catch (err) {
      const msg = err?.name === "AbortError" ? "Zeitüberschreitung beim Abruf (bitte erneut versuchen)." : err.message || "Fehler";
      toast(msg, { kind: "error", timeoutMs: 5200 });
    } finally {
      setLoading(false);
    }
  });

  $("refreshSourcesBtn").addEventListener("click", () => refreshSources().catch((e) => toast(e.message, { kind: "error" })));

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

  ["dailyDays", "dailyGroupBy", "dailyOnlyOrderable", "dailyMetric", "dailySeriesSearch"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => refreshDailyHistory({ apiFetch, $, state, toast, renderDailyHistory }));
    el.addEventListener("change", () => refreshDailyHistory({ apiFetch, $, state, toast, renderDailyHistory }));
  });
  $("dailySeriesSelect").addEventListener("change", () => {
    state.dailySeriesKey = String($("dailySeriesSelect").value || "");
    renderDailyHistory();
  });

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
    if (!cb) return;
    const id = cb.dataset.id;
    const src = state.sources.find((s) => s.id === id);
    if (!src) return;
    try {
      await apiFetch(`/api/sources/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ source: { enabled: cb.checked } }) });
      await refreshSources();
      toast("Aktualisiert.", { kind: "success" });
    } catch (err) {
      cb.checked = !cb.checked;
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

export async function bootstrap() {
  setupTabs();
  setupEvents();

  try {
    const health = await apiFetch("/api/health");
    setServerStatus(`Server: OK (${health.version})`, true);
  } catch {
    setServerStatus("Server: nicht erreichbar", false);
    toast("Server nicht erreichbar. Starte den lokalen Server.", { kind: "error", timeoutMs: 6000 });
  }

  updateHistoryExportLinks({ $, state });

  await refreshSources().catch(() => {});
  await refreshHistory().catch(() => {});

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
      renderResults({ query: data.query, results: data.results || [] });
      state.lastQuery = data.query;
      state.lastResults = data.results || [];
    }
  } catch {
    // ignore auto-run failures (user can click manually)
  } finally {
    setLoading(false);
  }
}
