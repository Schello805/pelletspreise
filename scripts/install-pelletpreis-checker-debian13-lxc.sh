#!/usr/bin/env bash
set -euo pipefail

# Pelletpreis-Checker install script for Debian 13 in a Proxmox LXC.
#
# What it does:
# - Installs required apt packages
# - Ensures a system user exists
# - Installs Node dependencies (npm)
# - Creates an env file and a systemd service
# - Starts + enables the service
#
# Usage (inside an existing repo checkout):
#   sudo bash scripts/install-pelletpreis-checker-debian13-lxc.sh
#
# Usage (clone first):
#   sudo REPO_URL="https://github.com/<you>/<repo>.git" bash scripts/install-pelletpreis-checker-debian13-lxc.sh
#
# Optional:
#   sudo HOST="127.0.0.1" PORT="8000" CONTACT_EMAIL="info@schellenberger.biz" INSTALL_PLAYWRIGHT="0" bash scripts/install-pelletpreis-checker-debian13-lxc.sh
#   sudo INSTALL_SQLITE="1" bash scripts/install-pelletpreis-checker-debian13-lxc.sh

APP_NAME="${APP_NAME:-pelletpreis-checker}"
APP_USER="${APP_USER:-pelletpreise}"
APP_GROUP="${APP_GROUP:-$APP_USER}"
APP_DIR="${APP_DIR:-/opt/$APP_NAME}"
REPO_URL="${REPO_URL:-}"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"
BASE_URL="${BASE_URL:-http://$HOST:$PORT}"
CONTACT_EMAIL="${CONTACT_EMAIL:-info@schellenberger.biz}"

INSTALL_PLAYWRIGHT="${INSTALL_PLAYWRIGHT:-0}"
INSTALL_SQLITE="${INSTALL_SQLITE:-0}"

ENV_FILE="${ENV_FILE:-/etc/${APP_NAME}.env}"
SERVICE_FILE="/etc/systemd/system/${APP_NAME}.service"

need_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "Please run as root (use sudo)." >&2
    exit 1
  fi
}

log() {
  echo "[$APP_NAME] $*"
}

ensure_packages() {
  log "Installing apt packages…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    nodejs \
    npm

  if [[ "$INSTALL_SQLITE" == "1" ]]; then
    log "Installing build deps for SQLite (better-sqlite3)…"
    apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      pkg-config \
      libsqlite3-dev
  fi

  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$node_major" -lt 18 ]]; then
    echo "Node.js >= 18 is required. Found: $(node -v 2>/dev/null || echo 'unknown')." >&2
    echo "Install a newer Node.js (e.g. via your preferred method) and re-run this script." >&2
    exit 1
  fi
}

ensure_user() {
  if id "$APP_USER" >/dev/null 2>&1; then
    log "User '$APP_USER' exists."
  else
    log "Creating system user '$APP_USER'…"
    useradd \
      --system \
      --home "$APP_DIR" \
      --create-home \
      --shell /usr/sbin/nologin \
      "$APP_USER"
  fi

  if getent group "$APP_GROUP" >/dev/null 2>&1; then
    true
  else
    groupadd --system "$APP_GROUP"
  fi

  usermod -a -G "$APP_GROUP" "$APP_USER" || true
}

checkout_repo() {
  if [[ -n "$REPO_URL" ]]; then
    log "Cloning repo into $APP_DIR…"
    rm -rf "$APP_DIR"
    git clone --depth 1 "$REPO_URL" "$APP_DIR"
  else
    # assume script is run inside the repo
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    if [[ "$here" == "$APP_DIR" ]]; then
      log "Repo already in $APP_DIR."
    else
      log "Copying repo from $here to $APP_DIR…"
      rm -rf "$APP_DIR"
      mkdir -p "$APP_DIR"
      # copy everything except common junk
      rsync -a \
        --delete \
        --exclude ".git" \
        --exclude "node_modules" \
        --exclude "server/data" \
        "$here/" "$APP_DIR/"
    fi
  fi

  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
}

install_deps() {
  log "Installing npm dependencies…"
  cd "$APP_DIR"
  # Use npm ci when lockfile exists, otherwise fallback to install.
  if [[ -f package-lock.json ]]; then
    sudo -u "$APP_USER" -H npm ci
  else
    sudo -u "$APP_USER" -H npm install
  fi

  if [[ "$INSTALL_SQLITE" == "1" ]]; then
    log "Installing optional SQLite backend (better-sqlite3)…"
    sudo -u "$APP_USER" -H npm install --no-save better-sqlite3
  else
    log "Skipping SQLite backend install (INSTALL_SQLITE=1 to enable; otherwise file-based storage is used)."
  fi

  if [[ "$INSTALL_PLAYWRIGHT" == "1" ]]; then
    log "Installing Playwright browsers (this can be large)…"
    sudo -u "$APP_USER" -H npx playwright install --with-deps
  else
    log "Skipping Playwright browser install (INSTALL_PLAYWRIGHT=1 to enable)."
  fi
}

write_env_file() {
  log "Writing env file: $ENV_FILE"
  umask 077
  cat >"$ENV_FILE" <<EOF
# ${APP_NAME} runtime config
HOST=${HOST}
PORT=${PORT}
BASE_URL=${BASE_URL}
CONTACT_EMAIL=${CONTACT_EMAIL}
EOF
}

write_service() {
  log "Writing systemd service: $SERVICE_FILE"
  cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=Pelletpreis-Checker (local price scraper webapp)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${APP_DIR}/server/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/server/data

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now "${APP_NAME}.service"
}

health_check() {
  log "Waiting for service…"
  sleep 1
  if curl -sS -m 3 "${BASE_URL}/api/health" >/dev/null; then
    log "OK: ${BASE_URL}/pelletpreise/"
  else
    log "Service started, but health check failed. Check logs:"
    log "  journalctl -u ${APP_NAME}.service -n 200 --no-pager"
  fi
}

main() {
  need_root
  ensure_packages
  ensure_user
  checkout_repo
  install_deps
  write_env_file
  write_service
  health_check

  cat <<OUT

Done.

- Service: ${APP_NAME}.service
- URL: ${BASE_URL}/pelletpreise/
- Logs: journalctl -u ${APP_NAME}.service -f

If you want external access, set HOST=0.0.0.0 in ${ENV_FILE} and restart:
  systemctl restart ${APP_NAME}.service

OUT
}

main "$@"
