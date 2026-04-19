import { bootstrap } from "./src/main.js";

bootstrap();

async function showFooterVersion() {
  const existing = document.getElementById("footerVersion");
  const footerInner = document.querySelector(".footer-inner");
  if (!existing && !footerInner) return;

  try {
    const res = await fetch("/api/health", { headers: { accept: "application/json" } });
    const data = await res.json().catch(() => null);
    const version = data?.version ? String(data.version).trim() : "";
    if (!version) return;

    const text = `v${version}`;

    if (existing) {
      existing.textContent = text;
      return;
    }

    const el = document.createElement("span");
    el.className = "muted";
    el.id = "footerVersion";
    el.setAttribute("aria-label", "Version");
    el.textContent = text;

    const links = footerInner.querySelector(".footer-links");
    footerInner.insertBefore(el, links || null);
  } catch {
    // ignore
  }
}

showFooterVersion();
