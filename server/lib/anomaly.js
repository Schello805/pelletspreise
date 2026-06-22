import { getDailyHistory } from "./history.js";

function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export async function annotatePriceAnomalies({ projectRoot, results, days = 45 } = {}) {
  const rows = await getDailyHistory({ projectRoot, days, groupBy: "source", onlyOrderable: false }).catch(() => []);
  const bySource = new Map();
  for (const row of rows) {
    const value = Number(row?.priceEurPerTon);
    if (!Number.isFinite(value)) continue;
    const key = String(row?.sourceId || "");
    if (!key) continue;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(value);
  }

  return (Array.isArray(results) ? results : []).map((result) => {
    if (!result?.ok || !Number.isFinite(Number(result.priceEurPerTon))) return result;
    const baselineValues = bySource.get(String(result.sourceId || "")) || [];
    if (baselineValues.length < 5) return result;
    const baseline = median(baselineValues);
    if (!Number.isFinite(baseline) || baseline <= 0) return result;
    const price = Number(result.priceEurPerTon);
    const deviationPercent = ((price - baseline) / baseline) * 100;
    if (deviationPercent > -30 && deviationPercent < 30) return result;
    return {
      ...result,
      anomaly: {
        type: deviationPercent < 0 ? "unusually_low" : "unusually_high",
        baselineEurPerTon: Math.round(baseline * 100) / 100,
        deviationPercent: Math.round(deviationPercent * 10) / 10,
        sampleSize: baselineValues.length,
      },
    };
  });
}
