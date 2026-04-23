function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function computeSeriesStats(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const min = v[0];
  const max = v[v.length - 1];
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const median = percentile(v, 0.5);
  const p10 = percentile(v, 0.1);
  const p90 = percentile(v, 0.9);
  return { count: v.length, min, max, avg, median, p10, p90 };
}

function buildSeriesFromDailyRows(rows, { groupBy }) {
  const series = new Map();
  for (const r of rows || []) {
    const dealer = groupBy === "dealer" ? String(r.dealerName || "—") : "";
    const key = groupBy === "dealer" ? `${r.sourceId}|${dealer}` : String(r.sourceId);
    const label = groupBy === "dealer" ? `${r.sourceName || r.sourceId} — ${dealer}` : String(r.sourceName || r.sourceId);
    if (!series.has(key)) series.set(key, { key, label, items: [] });
    series.get(key).items.push(r);
  }
  const list = Array.from(series.values());
  list.sort((a, b) => a.label.localeCompare(b.label, "de"));
  for (const s of list) s.items.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return list;
}

const CHART_PALETTE = [
  "rgba(99, 230, 190, 0.92)",
  "rgba(77, 171, 247, 0.92)",
  "rgba(255, 212, 59, 0.92)",
  "rgba(255, 107, 107, 0.92)",
  "rgba(186, 104, 200, 0.92)",
];

function alignSeriesPoints(seriesList) {
  const dates = new Set();
  for (const s of seriesList) for (const p of s.points) dates.add(String(p.date));
  const axis = Array.from(dates.values()).sort((a, b) => a.localeCompare(b, "de"));
  const byKey = new Map();
  for (const s of seriesList) {
    const m = new Map(s.points.map((p) => [String(p.date), p.value]));
    byKey.set(
      s.key,
      axis.map((d) => (typeof m.get(d) === "number" && Number.isFinite(m.get(d)) ? m.get(d) : null)),
    );
  }
  return { axisDates: axis, valuesByKey: byKey };
}

function drawMultiLineChart(canvas, seriesList, { unitLabel = "", title = "" } = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const allValues = [];
  for (const s of seriesList) {
    for (const p of s.points) if (typeof p.value === "number" && Number.isFinite(p.value)) allValues.push(p.value);
  }
  const vals = allValues;
  const minV = vals.length ? Math.min(...vals) : 0;
  const maxV = vals.length ? Math.max(...vals) : 1;
  const span = Math.max(1e-9, maxV - minV);
  const yMin = minV - span * 0.07;
  const yMax = maxV + span * 0.07;

  // Choose left padding based on label width so y-axis values never clip.
  ctx.font = "12px ui-sans-serif, system-ui";
  const fmt = (n) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(n);
  const yMaxLabel = `${fmt(yMax)} ${unitLabel}`.trim();
  const yMinLabel = `${fmt(yMin)} ${unitLabel}`.trim();
  const labelW = Math.max(ctx.measureText(yMaxLabel).width, ctx.measureText(yMinLabel).width);

  const pad = { l: Math.max(58, Math.ceil(labelW) + 18), r: 16, t: 18, b: 36 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;

  ctx.fillStyle = "rgba(255,255,255,0.02)";
  ctx.fillRect(pad.l, pad.t, innerW, innerH);

  const { axisDates, valuesByKey } = alignSeriesPoints(seriesList);
  const xOf = (i) => pad.l + (axisDates.length <= 1 ? innerW / 2 : (i / (axisDates.length - 1)) * innerW);
  const yOf = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.t + (i / 4) * innerH;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + innerW, y);
    ctx.stroke();
  }

  // title + y labels
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(title, pad.l, 2);

  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(yMaxLabel, pad.l - 8, pad.t);
  ctx.fillText(yMinLabel, pad.l - 8, pad.t + innerH);

  const hasAny = vals.length > 0;
  if (!hasAny) {
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Keine Daten für diese Serie im Zeitraum.", pad.l + innerW / 2, pad.t + innerH / 2);
    return;
  }

  // Legend (top right)
  const legendMax = Math.min(seriesList.length, 5);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = "12px ui-sans-serif, system-ui";
  const legendX = pad.l + innerW - 240;
  let legendY = pad.t + 6;
  for (let i = 0; i < legendMax; i += 1) {
    const s = seriesList[i];
    const color = CHART_PALETTE[i % CHART_PALETTE.length];
    const label = String(s.label || s.key || "").slice(0, 38);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(legendX, legendY + 7, 4.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.72)";
    ctx.fillText(label, legendX + 10, legendY);
    legendY += 18;
  }

  // Lines
  for (let sIdx = 0; sIdx < seriesList.length; sIdx += 1) {
    const s = seriesList[sIdx];
    const values = valuesByKey.get(s.key) || [];
    const usableCount = values.filter((v) => typeof v === "number" && Number.isFinite(v)).length;
    if (usableCount < 2) continue;

    ctx.strokeStyle = CHART_PALETTE[sIdx % CHART_PALETTE.length];
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i];
      if (!(typeof v === "number" && Number.isFinite(v))) continue;
      const x = xOf(i);
      const y = yOf(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Points
    ctx.fillStyle = CHART_PALETTE[sIdx % CHART_PALETTE.length];
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i];
      if (!(typeof v === "number" && Number.isFinite(v))) continue;
      const x = xOf(i);
      const y = yOf(v);
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function getDailyControls({ $ }) {
  const days = Number($("dailyDays").value || 365);
  const groupBy = String($("dailyGroupBy").value || "source");
  const onlyOrderable = Boolean($("dailyOnlyOrderable").checked);
  const metric = String($("dailyMetric").value || "priceEurPerTon");
  const search = String($("dailySeriesSearch").value || "").trim().toLowerCase();
  const compareMode = Boolean($("dailyCompareMode")?.checked);
  const compareMax = Math.max(1, Math.min(5, Number($("dailyCompareMax")?.value || 3)));
  const compareKeys = compareMode
    ? Array.from(document.querySelectorAll("#dailyCompareSeries input[type=checkbox]:checked")).map((el) => String(el.value))
    : [];
  return { days, groupBy, onlyOrderable, metric, search, compareMode, compareMax, compareKeys };
}

export function updateHistoryExportLinks({ $, state }) {
  const { days, groupBy, onlyOrderable } = getDailyControls({ $ });
  const dailyParams = new URLSearchParams();
  dailyParams.set("mode", "daily");
  dailyParams.set("days", String(days));
  dailyParams.set("groupBy", groupBy === "dealer" ? "dealer" : "source");
  if (onlyOrderable) dailyParams.set("onlyOrderable", "1");

  $("exportDailyCsv").href = `/api/history/export.csv?${dailyParams.toString()}`;
  $("exportDailyJson").href = `/api/history/export.json?${dailyParams.toString()}`;
  state._dailyExportParams = dailyParams.toString();
}

export async function refreshDailyHistory({ apiFetch, $, state, toast, renderDailyHistory }) {
  const { days, groupBy, onlyOrderable } = getDailyControls({ $ });
  updateHistoryExportLinks({ $, state });
  const params = new URLSearchParams();
  params.set("days", String(days));
  params.set("groupBy", groupBy === "dealer" ? "dealer" : "source");
  if (onlyOrderable) params.set("onlyOrderable", "1");

  try {
    const data = await apiFetch(`/api/history/daily?${params.toString()}`);
    state.dailyRows = Array.isArray(data.rows) ? data.rows : [];
    renderDailyHistory();
  } catch (e) {
    toast(e.message || "Fehler", { kind: "error" });
  }
}

export function renderDailyHistory({
  state,
  $,
  escapeHtml,
  escapeAttr,
  fmtDateKey,
  fmtMoney,
  fmtNumber,
  isSafeHttpUrl,
  linkHtml,
}) {
  const dailyBody = $("dailyHistoryBody");
  const select = $("dailySeriesSelect");
  const statsEl = $("dailyStats");
  const lastEl = $("dailyLastPoint");
  const canvas = $("historyChart");
  const compareHost = $("dailyCompareSeries");

  const { groupBy, metric, search, compareMode, compareMax, compareKeys } = getDailyControls({ $ });
  const seriesList = buildSeriesFromDailyRows(state.dailyRows, { groupBy: groupBy === "dealer" ? "dealer" : "source" });
  const filtered = search ? seriesList.filter((s) => s.label.toLowerCase().includes(search)) : seriesList;

  if (!filtered.length) {
    select.innerHTML = "";
    dailyBody.innerHTML = `<tr><td colspan="7" class="muted">Keine Tageswerte (noch keine Abrufe?)</td></tr>`;
    statsEl.textContent = "—";
    lastEl.textContent = "—";
    if (compareHost) compareHost.innerHTML = "";
    drawMultiLineChart(canvas, [], {});
    return;
  }

  const candidateKey = state.dailySeriesKey && filtered.some((s) => s.key === state.dailySeriesKey) ? state.dailySeriesKey : filtered[0].key;
  state.dailySeriesKey = candidateKey;

  select.innerHTML = filtered
    .map((s) => `<option value="${escapeAttr(s.key)}"${s.key === candidateKey ? " selected" : ""}>${escapeHtml(s.label)}</option>`)
    .join("");

  const selected = filtered.find((s) => s.key === candidateKey) || filtered[0];
  const unitLabel = metric === "totalEur" ? "€" : "€/t";
  const title = `${selected.label} · ${metric === "totalEur" ? "Gesamt" : "Preis"} (${unitLabel})`;

  // Compare series (chart only)
  const availableKeys = new Set(filtered.map((s) => s.key));
  const cleaned = (compareMode ? compareKeys : [])
    .filter((k) => availableKeys.has(k))
    .slice(0, compareMax);
  const fallback = filtered.slice(0, compareMax).map((s) => s.key);
  state.dailyCompareKeys = cleaned.length ? cleaned : fallback;

  if (compareHost) {
    if (!compareMode) {
      compareHost.style.display = "none";
      compareHost.innerHTML = "";
    } else {
      compareHost.style.display = "";
      compareHost.innerHTML = filtered
        .slice(0, 80)
        .map((s, idx) => {
          const checked = state.dailyCompareKeys.includes(s.key) ? " checked" : "";
          const dot = CHART_PALETTE[idx % CHART_PALETTE.length];
          return `<label class="compare-item" title="${escapeAttr(s.label)}">
            <span class="compare-dot" style="background:${escapeAttr(dot)}"></span>
            <input type="checkbox" value="${escapeAttr(s.key)}"${checked} />
            <span class="text-truncate">${escapeHtml(s.label)}</span>
          </label>`;
        })
        .join("");
    }
  }

  const chartSeries = compareMode
    ? state.dailyCompareKeys
        .map((k) => filtered.find((s) => s.key === k))
        .filter(Boolean)
        .slice(0, compareMax)
    : [selected];

  const chartInput = chartSeries.map((s) => ({
    key: s.key,
    label: s.label,
    points: s.items.map((r) => ({ date: r.date, value: Number(r[metric]) })),
  }));
  drawMultiLineChart(canvas, chartInput, { unitLabel, title: compareMode ? `Vergleich · ${metric === "totalEur" ? "Gesamt" : "Preis"} (${unitLabel})` : title });

  // Stats
  const statsFor = (s) => {
    const pts = s.items.map((r) => Number(r[metric]));
    return computeSeriesStats(pts);
  };

  if (!compareMode || chartSeries.length <= 1) {
    const st = statsFor(selected);
    if (!st) {
      statsEl.innerHTML = "—";
    } else {
      const nf = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
      statsEl.innerHTML = `Punkte: <strong>${st.count}</strong><br/>
Min: <strong>${nf.format(st.min)} ${unitLabel}</strong> · Median: <strong>${nf.format(st.median)} ${unitLabel}</strong><br/>
Ø: <strong>${nf.format(st.avg)} ${unitLabel}</strong> · Max: <strong>${nf.format(st.max)} ${unitLabel}</strong><br/>
P10–P90: <strong>${nf.format(st.p10)}–${nf.format(st.p90)} ${unitLabel}</strong>`;
    }
  } else {
    const nf = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
    statsEl.innerHTML = chartSeries
      .map((s, idx) => {
        const st = statsFor(s);
        if (!st) return null;
        const dot = CHART_PALETTE[idx % CHART_PALETTE.length];
        return `<div class="row" style="gap:10px; align-items:baseline; justify-content:space-between;">
          <span class="row" style="gap:8px; align-items:center;">
            <span class="compare-dot" style="background:${escapeAttr(dot)}"></span>
            <strong>${escapeHtml(String(s.label || s.key))}</strong>
          </span>
          <span class="muted">Ø ${escapeHtml(nf.format(st.avg))} ${escapeHtml(unitLabel)} · Min ${escapeHtml(nf.format(st.min))} · Max ${escapeHtml(nf.format(st.max))}</span>
        </div>`;
      })
      .filter(Boolean)
      .join("");
  }

  const lastCandidates = chartSeries
    .map((s) => s.items[s.items.length - 1])
    .filter(Boolean)
    .map((r) => ({ r, val: Number(r[metric]) }))
    .filter((x) => Number.isFinite(x.val));
  const bestLast = lastCandidates.length
    ? lastCandidates.slice().sort((a, b) => (metric === "totalEur" ? a.val - b.val : a.val - b.val))[0]
    : null;
  const last = bestLast ? bestLast.r : selected.items[selected.items.length - 1];
  if (last) {
    const val = Number(last[metric]);
    const valText = Number.isFinite(val) ? `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(val)} ${unitLabel}` : "—";
    lastEl.innerHTML = `<strong>${fmtDateKey(last.date)}</strong><br/>
Wert: <strong>${escapeHtml(valText)}</strong><br/>
Quelle: ${escapeHtml(last.sourceName || last.sourceId || "—")}<br/>
Händler: ${escapeHtml(last.dealerName || "—")}`;
  } else lastEl.textContent = "—";

  const rows = selected.items.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  dailyBody.innerHTML = rows
    .slice(0, 180)
    .map((r) => {
      const sourceCell = linkHtml(r.url, r.sourceName || r.sourceId || "—");
      const dealer = r.dealerName ? escapeHtml(String(r.dealerName)) : "—";
      const price = r.priceEurPerTon != null ? `${fmtNumber(r.priceEurPerTon)} €` : "—";
      const total = r.totalEur != null ? fmtMoney(r.totalEur) : "—";
      const delivery = r.deliveryBy ? escapeHtml(String(r.deliveryBy)) : "—";
      const order = r.orderUrl && isSafeHttpUrl(r.orderUrl) ? `<a class="source-link" href="${escapeAttr(r.orderUrl)}" target="_blank" rel="noopener noreferrer">Link</a>` : "—";
      return `<tr>
        <td class="muted">${escapeHtml(fmtDateKey(r.date))}</td>
        <td>${sourceCell}</td>
        <td>${dealer}</td>
        <td class="right">${escapeHtml(price)}</td>
        <td class="right">${escapeHtml(total)}</td>
        <td class="muted">${delivery}</td>
        <td>${order}</td>
      </tr>`;
    })
    .join("");
}
