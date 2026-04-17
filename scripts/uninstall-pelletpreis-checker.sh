#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-pelletpreis-checker}"
APP_USER="${APP_USER:-pelletpreise}"
APP_DIR="${APP_DIR:-/opt/$APP_NAME}"
ENV_FILE="${ENV_FILE:-/etc/${APP_NAME}.env}"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Please run as root (use sudo)." >&2
  exit 1
fi

echo "Stopping service…"
systemctl disable --now "${APP_NAME}.service" >/dev/null 2>&1 || true

echo "Removing service file…"
rm -f "$SERVICE_FILE"
systemctl daemon-reload || true

echo "Removing env file…"
rm -f "$ENV_FILE"

echo "Removing app dir…"
rm -rf "$APP_DIR"

echo "User '$APP_USER' is NOT removed automatically."
echo "If you want to remove it:"
echo "  userdel $APP_USER"

echo "Done."

