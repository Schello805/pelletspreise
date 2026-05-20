import nodemailer from "nodemailer";

function env(name) {
  const v = process.env[name];
  return v == null ? "" : String(v).trim();
}

export function getEmailConfig() {
  const host = env("SMTP_HOST");
  const portRaw = env("SMTP_PORT");
  const secureRaw = env("SMTP_SECURE");
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  const from = env("SMTP_FROM") || env("CONTACT_EMAIL");
  const to = env("ALERT_TO") || env("SMTP_TO") || env("CONTACT_EMAIL");

  const port = portRaw ? Number(portRaw) : 587;
  const secure = secureRaw ? ["1", "true", "yes", "on"].includes(secureRaw.toLowerCase()) : port === 465;

  return {
    ok: Boolean(host && from && to),
    host,
    port: Number.isFinite(port) ? port : 587,
    secure,
    auth: user && pass ? { user, pass } : null,
    from,
    to,
  };
}

export async function sendAlertEmail({ subject, text }) {
  const cfg = getEmailConfig();
  if (!cfg.ok) {
    const missing = [];
    if (!cfg.host) missing.push("SMTP_HOST");
    if (!cfg.from) missing.push("SMTP_FROM (oder CONTACT_EMAIL)");
    if (!cfg.to) missing.push("ALERT_TO (oder CONTACT_EMAIL)");
    const err = new Error(`E-Mail nicht konfiguriert. Fehlend: ${missing.join(", ")}`);
    err.code = "EMAIL_NOT_CONFIGURED";
    throw err;
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.auth || undefined,
  });

  await transporter.sendMail({
    from: cfg.from,
    to: cfg.to,
    subject: String(subject || "Pelletpreis-Alarm"),
    text: String(text || ""),
  });

  return { ok: true };
}

