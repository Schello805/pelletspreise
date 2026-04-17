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

function drawLineChart(canvas, points, { unitLabel = "", title = "" } = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 58, r: 16, t: 18, b: 36 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;

  ctx.fillStyle = "rgba(255,255,255,0.02)";
  ctx.fillRect(pad.l, pad.t, innerW, innerH);

  const vals = points.map((p) => p.value).filter((v) => typeof v === "number" && Number.isFinite(v));
  const minV = vals.length ? Math.min(...vals) : 0;
  const maxV = vals.length ? Math.max(...vals) : 1;
  const span = Math.max(1e-9, maxV - minV);
  const yMin = minV - span * 0.07;
  const yMax = maxV + span * 0.07;

  const xOf = (i) => pad.l + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
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
  ctx.font = "12px ui-sans-serif, system-ui";
  const fmt = (n) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(n);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(title, pad.l, 2);

  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(`${fmt(yMax)} ${unitLabel}`, pad.l - 8, pad.t);
  ctx.fillText(`${fmt(yMin)} ${unitLabel}`, pad.l - 8, pad.t + innerH);

  // line
  const usable = points.filter((p) => typeof p.value === "number" && Number.isFinite(p.value));
  if (usable.length >= 2) {
    ctx.strokeStyle = "rgba(99, 230, 190, 0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      if (!(typeof p.value === "number" && Number.isFinite(p.value))) continue;
      const x = xOf(i);
      const y = yOf(p.value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // points
    ctx.fillStyle = "rgba(77, 171, 247, 0.95)";
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      if (!(typeof p.value === "number" && Number.isFinite(p.value))) continue;
      const x = xOf(i);
      const y = yOf(p.value);
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Keine Daten für diese Serie im Zeitraum.", pad.l + innerW / 2, pad.t + innerH / 2);
  }
}

export function getDailyControls({ $ }) {
  const days = Number($("dailyDays").value || 365);
  const groupBy = String($("dailyGroupBy").value || "source");
  const onlyOrderable = Boolean($("dailyOnlyOrderable").checked);
  const metric = String($("dailyMetric").value || "priceEurPerTon");
  const search = String($("dailySeriesSearch").value || "").trim().toLowerCase();
  return { days, groupBy, onlyOrderable, metric, search };
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

  const { groupBy, metric, search } = getDailyControls({ $ });
  const seriesList = buildSeriesFromDailyRows(state.dailyRows, { groupBy: groupBy === "dealer" ? "dealer" : "source" });
  const filtered = search ? seriesList.filter((s) => s.label.toLowerCase().includes(search)) : seriesList;

  if (!filtered.length) {
    select.innerHTML = "";
    dailyBody.innerHTML = `<tr><td colspan="7" class="muted">Keine Tageswerte (noch keine Abrufe?)</td></tr>`;
    statsEl.textContent = "—";
    lastEl.textContent = "—";
    drawLineChart(canvas, [], {});
    return;
  }

  const candidateKey = state.dailySeriesKey && filtered.some((s) => s.key === state.dailySeriesKey) ? state.dailySeriesKey : filtered[0].key;
  state.dailySeriesKey = candidateKey;

  select.innerHTML = filtered
    .map((s) => `<option value="${escapeAttr(s.key)}"${s.key === candidateKey ? " selected" : ""}>${escapeHtml(s.label)}</option>`)
    .join("");

  const selected = filtered.find((s) => s.key === candidateKey) || filtered[0];
  const points = selected.items.map((r) => ({ date: r.date, value: Number(r[metric]) }));
  const values = points.map((p) => (Number.isFinite(p.value) ? p.value : null)).filter((v) => v != null);
  const st = computeSeriesStats(values);
  const unitLabel = metric === "totalEur" ? "€" : "€/t";
  const title = `${selected.label} · ${metric === "totalEur" ? "Gesamt" : "Preis"} (${unitLabel})`;

  drawLineChart(canvas, points, { unitLabel, title });

  if (!st) {
    statsEl.innerHTML = "—";
  } else {
    const nf = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
    statsEl.innerHTML = `Punkte: <strong>${st.count}</strong><br/>
Min: <strong>${nf.format(st.min)} ${unitLabel}</strong> · Median: <strong>${nf.format(st.median)} ${unitLabel}</strong><br/>
Ø: <strong>${nf.format(st.avg)} ${unitLabel}</strong> · Max: <strong>${nf.format(st.max)} ${unitLabel}</strong><br/>
P10–P90: <strong>${nf.format(st.p10)}–${nf.format(st.p90)} ${unitLabel}</strong>`;
  }

  const last = selected.items[selected.items.length - 1];
  if (last) {
    const val = Number(last[metric]);
    const valText = Number.isFinite(val) ? `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(val)} ${unitLabel}` : "—";
    lastEl.innerHTML = `<strong>${fmtDateKey(last.date)}</strong><br/>
Wert: <strong>${escapeHtml(valText)}</strong><br/>
Quelle: ${escapeHtml(last.sourceName || last.sourceId || "—")}<br/>
Händler: ${escapeHtml(last.dealerName || "—")}`;
  } else {
    lastEl.textContent = "—";
  }

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

