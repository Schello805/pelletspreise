export function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element not found: ${id}`);
  return el;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function escapeAttr(s) {
  return escapeHtml(String(s ?? ""));
}

export function isSafeHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function linkHtml(url, label) {
  const safeLabel = escapeHtml(label);
  if (url && isSafeHttpUrl(url)) return `<a class="source-link" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
  return safeLabel;
}

export function toast(message, { kind = "info", timeoutMs = 2400 } = {}) {
  const t = $("toast");
  t.textContent = message;
  t.dataset.kind = kind;
  t.classList.add("show");
  window.clearTimeout(toast._timer);
  toast._timer = window.setTimeout(() => t.classList.remove("show"), timeoutMs);
}

export function fmtMoney(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(Number(value));
}

export function fmtNumber(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(Number(value));
}

export function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("de-DE");
}

export function fmtDateKey(dateKey) {
  const raw = String(dateKey || "").trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return raw || "—";
  return `${m[3]}.${m[2]}.${m[1]}`;
}

export function mapProductLabel(code) {
  return (
    {
      ENPLUS_A1_LOSE: "ENplus A1 (lose)",
      ENPLUS_A1_SACK: "ENplus A1 (Sackware)",
      DINPLUS_LOSE: "DINplus (lose)",
    }[code] || code
  );
}

export function setServerStatus(text, ok) {
  const pill = $("serverStatus");
  pill.textContent = text;
  pill.style.borderColor = ok ? "rgba(99, 230, 190, 0.45)" : "rgba(255, 107, 107, 0.45)";
  pill.style.color = "rgba(255,255,255,0.82)";
}

export function setLoading(isLoading, label = null) {
  const btn = $("runBtn");
  btn.disabled = Boolean(isLoading);
  btn.setAttribute("aria-busy", isLoading ? "true" : "false");
  btn.dataset.originalText ||= btn.textContent;
  btn.textContent = isLoading ? (label || "Lade …") : btn.dataset.originalText;
}

