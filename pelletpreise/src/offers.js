function parseGermanDateLikeToSortable(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  // dd.mm.yyyy
  const m1 = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
  // dd.mm.yy
  const m2 = raw.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (m2) return `20${m2[3]}-${m2[2]}-${m2[1]}`;
  return null;
}

function normalizeOfferRow({ provider, providerUrl, dealer, orderUrl, deliveryBy, priceEurPerTon, totalEur, status, retrievedAt }) {
  return {
    provider: provider || "—",
    providerUrl: providerUrl || null,
    dealer: dealer || "—",
    orderUrl: orderUrl || null,
    deliveryBy: deliveryBy || null,
    priceEurPerTon: typeof priceEurPerTon === "number" ? priceEurPerTon : null,
    totalEur: typeof totalEur === "number" ? totalEur : null,
    status,
    retrievedAt,
  };
}

export function buildOfferRowsFromResults(results) {
  const rows = [];
  for (const r of results || []) {
    const provider = r.sourceName || r.sourceId || "—";
    const providerUrl = r.url || null;
    const status = r;
    const retrievedAt = r.retrievedAt;

    if (Array.isArray(r.offers) && r.offers.length) {
      for (const o of r.offers) {
        rows.push(
          normalizeOfferRow({
            provider,
            providerUrl,
            dealer: o.dealerName ? String(o.dealerName) : r.bestDealerName ? String(r.bestDealerName) : "—",
            orderUrl: o.orderUrl || null,
            deliveryBy: o.deliveryBy || null,
            priceEurPerTon: o.priceEurPerTon,
            totalEur: o.totalEur,
            status,
            retrievedAt,
          }),
        );
      }
      continue;
    }

    rows.push(
      normalizeOfferRow({
        provider,
        providerUrl,
        dealer: r.bestDealerName ? String(r.bestDealerName) : "—",
        orderUrl: null,
        deliveryBy: null,
        priceEurPerTon: r.priceEurPerTon,
        totalEur: r.totalEur,
        status,
        retrievedAt,
      }),
    );
  }
  return rows;
}

export function getOffersControls({ $ }) {
  return {
    search: String($("offersSearch").value || "").trim().toLowerCase(),
    sort: String($("offersSort").value || "totalEur"),
    dir: String($("offersSortDir").value || "asc"),
    onlyOrderable: Boolean($("offersOnlyOrderable").checked),
  };
}

export function applyOffersView({ state, $, escapeHtml, fmtMoney, fmtNumber, fmtTime, isSafeHttpUrl, escapeAttr, linkHtml, statusCellHtml }) {
  const offersBody = $("resultsOffersBody");
  const { search, sort, dir, onlyOrderable } = getOffersControls({ $ });

  let rows = state.lastOffersRows.slice();
  if (onlyOrderable) rows = rows.filter((r) => r.orderUrl && isSafeHttpUrl(r.orderUrl));
  if (search) rows = rows.filter((r) => String(r.dealer).toLowerCase().includes(search));

  const sortDir = dir === "desc" ? -1 : 1;
  const safeNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY);
  rows.sort((a, b) => {
    if (sort === "provider") return sortDir * String(a.provider).localeCompare(String(b.provider), "de");
    if (sort === "dealer") return sortDir * String(a.dealer).localeCompare(String(b.dealer), "de");
    if (sort === "deliveryBy") {
      const ad = parseGermanDateLikeToSortable(a.deliveryBy) || "9999-12-31";
      const bd = parseGermanDateLikeToSortable(b.deliveryBy) || "9999-12-31";
      return sortDir * ad.localeCompare(bd);
    }
    if (sort === "priceEurPerTon") return sortDir * (safeNum(a.priceEurPerTon) - safeNum(b.priceEurPerTon));
    return sortDir * (safeNum(a.totalEur) - safeNum(b.totalEur));
  });

  if (!rows.length) {
    offersBody.innerHTML = `<tr><td colspan="7" class="muted">Keine Angebote für die aktuelle Filterung.</td></tr>`;
    return;
  }

  offersBody.innerHTML = rows
    .map((row) => {
      const providerCell = linkHtml(row.providerUrl, row.provider);
      const dealerCell = linkHtml(row.orderUrl, row.dealer);
      const delivery = row.deliveryBy ? escapeHtml(String(row.deliveryBy)) : "—";
      const price = row.priceEurPerTon != null ? `${fmtNumber(row.priceEurPerTon)} €` : "—";
      const total = row.totalEur != null ? fmtMoney(row.totalEur) : "—";
      return `<tr>
        <td>${providerCell}</td>
        <td>${dealerCell}</td>
        <td class="muted">${delivery}</td>
        <td class="right">${escapeHtml(price)}</td>
        <td class="right">${escapeHtml(total)}</td>
        <td>${statusCellHtml(row.status)}</td>
        <td class="muted right">${escapeHtml(fmtTime(row.retrievedAt))}</td>
      </tr>`;
    })
    .join("");
}

