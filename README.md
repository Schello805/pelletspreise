# Pelletpreis-Checker

Lokale Webapp (ohne Build-Step) zum Abrufen und Vergleichen von Pelletpreisen aus mehreren Quellen.

- Frontend: `pelletpreise/`
- Backend/API: `server/`

## Installation

### Lokal (Entwicklung)

Voraussetzungen: Node.js (>= 18)

1. Abhängigkeiten installieren:
   - `npm ci`
2. Server starten:
   - `node server/server.js`
3. Öffnen:
   - `http://127.0.0.1:8000/pelletpreise/`

Optional (für Playwright-Quellen wie „HeizPellets24 Angebotsliste“):

- `npx playwright install chromium`

## Quickstart

1. Abhängigkeiten installieren:
   - `npm ci`
2. Server starten:
   - `node server/server.js`
3. Öffnen:
   - `http://127.0.0.1:8000/pelletpreise/`

## Features

- Quellenverwaltung (HTTP/Regex + optional Playwright)
- Tages-Cache: i. d. R. max. 1 Abruf/Tag je Quelle+Parameter
- Ergebnisse: Deutschland-Ø getrennt von bestellbaren Angeboten
- Historie: Raw + Tageswerte inkl. Chart & Analyse
- Export: CSV/JSON (raw oder daily)

## Installation (Debian 13 / Proxmox LXC)

Im Repo liegt ein Install-Script (systemd Service):

- `scripts/install-pelletpreis-checker-debian13-lxc.sh`

Beispiel:

- `sudo bash scripts/install-pelletpreis-checker-debian13-lxc.sh`

Optional (Playwright Browser installieren – groß):

- `sudo INSTALL_PLAYWRIGHT=1 bash scripts/install-pelletpreis-checker-debian13-lxc.sh`

Optional (SQLite statt JSON-Dateien, empfohlen bei viel Historie):

- `sudo INSTALL_SQLITE=1 bash scripts/install-pelletpreis-checker-debian13-lxc.sh`

## Update (Debian 13 / Proxmox LXC)

- `sudo bash scripts/update-pelletpreis-checker-debian13-lxc.sh`

Wenn dein Install ohne `.git` gemacht wurde (Copy-Install), gib beim Update die Repo-URL an:

- `sudo REPO_URL="https://github.com/<you>/<repo>.git" bash scripts/update-pelletpreis-checker-debian13-lxc.sh`

## Lizenz

AGPL-3.0 (siehe `LICENSE`).

## Hinweis

Scraping kann gegen Nutzungsbedingungen verstoßen. Nutze nur Quellen, die du verwenden darfst.
