#!/usr/bin/env bash
set -euo pipefail

# Pelletpreis-Checker update script for Debian 13 in a Proxmox LXC.
#
# What it does:
# - Stops the systemd service
# - Updates the repo checkout (git pull/reset OR rsync from a fresh clone)
# - Re-installs npm deps (npm ci)
# - Optionally re-installs better-sqlite3 and/or Playwright browsers
# - Restarts the service + runs a health check
#
# Usage:
#   sudo bash scripts/update-pelletpreis-checker-debian13-lxc.sh
#
# If your install was created without .git (copy install), provide REPO_URL:
#   sudo REPO_URL="https://github.com/<you>/<repo>.git" bash scripts/update-pelletpreis-checker-debian13-lxc.sh
#
# Optional:
#   sudo BRANCH="main" INSTALL_SQLITE="1" INSTALL_PLAYWRIGHT="1" bash scripts/update-pelletpreis-checker-debian13-lxc.sh
#   sudo INSTALL_PLAYWRIGHT="1" PLAYWRIGHT_WITH_DEPS="1" bash scripts/update-pelletpreis-checker-debian13-lxc.sh

APP_NAME="${APP_NAME:-pelletpreis-checker}"
APP_USER="${APP_USER:-pelletpreise}"
APP_GROUP="${APP_GROUP:-$APP_USER}"
APP_DIR="${APP_DIR:-/opt/$APP_NAME}"
REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"

ENV_FILE="${ENV_FILE:-/etc/${APP_NAME}.env}"

# If not explicitly set, we auto-detect whether better-sqlite3 was present before npm ci.
INSTALL_SQLITE="${INSTALL_SQLITE:-auto}"
# If set, run Playwright browser install after updating.
INSTALL_PLAYWRIGHT="${INSTALL_PLAYWRIGHT:-0}"
PLAYWRIGHT_WITH_DEPS="${PLAYWRIGHT_WITH_DEPS:-0}"
# In some Proxmox/LXC setups, systemd sandboxing (mount namespaces) can fail with status=226/NAMESPACE.
# This drop-in disables the mount-namespace hardening so the service starts reliably.
LXC_COMPAT="${LXC_COMPAT:-1}"

need_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "Please run as root (use sudo)." >&2
    exit 1
  fi
}

log() {
  echo "[$APP_NAME] $*"
}

ensure_rsync() {
  if command -v rsync >/dev/null 2>&1; then
    return
  fi
  log "Installing missing dependency: rsync…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends rsync
}

ensure_runtime_dirs() {
  mkdir -p "$APP_DIR/server/data"
  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR/server/data"
}

ensure_lxc_compat_override() {
  if [[ "$LXC_COMPAT" != "1" ]]; then
    return
  fi
  local unit="/etc/systemd/system/${APP_NAME}.service"
  if [[ ! -f "$unit" ]]; then
    return
  fi
  local dir="/etc/systemd/system/${APP_NAME}.service.d"
  mkdir -p "$dir"
  cat >"${dir}/override.conf" <<EOF
[Service]
NoNewPrivileges=no
PrivateTmp=no
ProtectSystem=no
ProtectHome=no
ReadWritePaths=
EOF
  systemctl daemon-reload
}

stop_service() {
  if systemctl list-unit-files | grep -qE "^${APP_NAME}\\.service"; then
    log "Stopping service…"
    systemctl stop "${APP_NAME}.service" || true
  else
    log "Service unit not found (continuing): ${APP_NAME}.service"
  fi
}

update_checkout_git() {
  log "Updating via git (branch: $BRANCH)…"

  if [[ -n "$REPO_URL" ]]; then
    # Ensure remote exists (helpful if someone copied a .git dir manually).
    if ! sudo -u "$APP_USER" -H git -C "$APP_DIR" remote get-url origin >/dev/null 2>&1; then
      sudo -u "$APP_USER" -H git -C "$APP_DIR" remote add origin "$REPO_URL"
    fi
  else
    if ! sudo -u "$APP_USER" -H git -C "$APP_DIR" remote get-url origin >/dev/null 2>&1; then
      echo "Git remote 'origin' is missing in $APP_DIR and REPO_URL is empty." >&2
      echo "Run with REPO_URL set (or add an origin remote) and try again." >&2
      exit 1
    fi
  fi

  sudo -u "$APP_USER" -H git -C "$APP_DIR" fetch --prune origin
  sudo -u "$APP_USER" -H git -C "$APP_DIR" checkout -q "$BRANCH" || true
  sudo -u "$APP_USER" -H git -C "$APP_DIR" reset --hard "origin/$BRANCH"
}

update_checkout_clone_rsync() {
  if [[ -z "$REPO_URL" ]]; then
    echo "No git checkout in $APP_DIR and REPO_URL is empty." >&2
    echo "Either reinstall with REPO_URL, or run this script with REPO_URL set." >&2
    exit 1
  fi

  ensure_rsync
  log "Updating via fresh clone + rsync…"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$tmp/repo"

  # Preserve runtime data and installed deps.
  rsync -a --delete \
    --exclude ".git" \
    --exclude "node_modules" \
    --exclude "server/data" \
    "$tmp/repo/" "$APP_DIR/"

  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
}

install_deps() {
  log "Installing npm dependencies…"
  cd "$APP_DIR"
  if [[ -f package-lock.json ]]; then
    sudo -u "$APP_USER" -H npm ci
  else
    sudo -u "$APP_USER" -H npm install
  fi
}

install_optional_sqlite() {
  local had_sqlite="${1:-0}"
  if [[ "$INSTALL_SQLITE" == "1" || ( "$INSTALL_SQLITE" == "auto" && "$had_sqlite" == "1" ) ]]; then
    log "Installing optional SQLite backend (better-sqlite3)…"
    cd "$APP_DIR"
    sudo -u "$APP_USER" -H npm install --no-save better-sqlite3
  else
    log "Skipping SQLite backend install (INSTALL_SQLITE=1 to enable)."
  fi
}

install_playwright_browsers() {
  if [[ "$INSTALL_PLAYWRIGHT" != "1" ]]; then
    return
  fi
  log "Installing Playwright browsers…"
  cd "$APP_DIR"
  if [[ "$PLAYWRIGHT_WITH_DEPS" == "1" ]]; then
    log "Installing Playwright system dependencies (requires root, can be large)…"
    npx playwright install --with-deps chromium
  else
    sudo -u "$APP_USER" -H npx playwright install chromium
  fi
}

start_service() {
  if systemctl list-unit-files | grep -qE "^${APP_NAME}\\.service"; then
    log "Starting service…"
    systemctl start "${APP_NAME}.service"
  else
    log "Service unit not found: ${APP_NAME}.service (skipping start)"
  fi
}

health_check() {
  if [[ ! -f "$ENV_FILE" ]]; then
    log "No env file found at $ENV_FILE (skipping health check)."
    return
  fi

  # shellcheck disable=SC1090
  source "$ENV_FILE"
  local url="${BASE_URL:-}"
  if [[ -z "$url" ]]; then
    url="http://${HOST:-127.0.0.1}:${PORT:-8000}"
  fi

  log "Health check: ${url}/api/health"
  sleep 1
  if curl -sS -m 4 "${url}/api/health" >/dev/null; then
    log "OK: ${url}/pelletpreise/"
  else
    log "Health check failed. Logs:"
    log "  journalctl -u ${APP_NAME}.service -n 200 --no-pager"
    exit 1
  fi
}

main() {
  need_root

  if [[ ! -d "$APP_DIR" ]]; then
    echo "APP_DIR does not exist: $APP_DIR" >&2
    exit 1
  fi

  local had_sqlite="0"
  if [[ -d "$APP_DIR/node_modules/better-sqlite3" ]]; then
    had_sqlite="1"
  fi

  stop_service

  if [[ -d "$APP_DIR/.git" ]]; then
    update_checkout_git
  else
    update_checkout_clone_rsync
  fi

  ensure_runtime_dirs
  ensure_lxc_compat_override
  install_deps
  install_optional_sqlite "$had_sqlite"
  install_playwright_browsers

  start_service
  health_check

  log "Update complete."
}

main "$@"
