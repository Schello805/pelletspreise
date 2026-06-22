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
- Alarme: E-Mail bei Schwellwert (€/t), mit Wiederaktivierung nach Preis-Erholung
- Abrufstatus: Cache-Alter, Tageslimit und nächstmögliche echte Abfrage
- Datenqualität: Warnung bei starken Abweichungen vom historischen Median
- System-Tab: Diagnose für Quellen, Speicher, E-Mail, Playwright, Schutz und Updates

## Alarme (E-Mail)

Im Tab „Alarme“ kannst du Regeln anlegen wie: „Wenn Quelle X ≤ 360 €/t → E-Mail schicken“.

Wichtig: Alarme werden nur ausgewertet, wenn ein Wert in die Historie geschrieben wird (z. B. durch „Auto 1×/Tag“).

Standardmäßig löst ein Alarm beim Unterschreiten nur einmal aus. Erst wenn der Preis den Wert „Erneut aktiv ab“ überschreitet und danach wieder fällt, folgt eine neue Mail. Die optionale Wiederholung bei dauerhaft niedrigem Preis berücksichtigt den eingestellten Mindestabstand.

### SMTP konfigurieren (Debian/LXC)

In `/etc/pelletpreis-checker.env` (oder via Installer) folgende Variablen setzen und dann den Service neu starten:

- `SMTP_HOST` (z. B. `mail.example.com`)
- `SMTP_PORT` (z. B. `587` oder `465`)
- `SMTP_SECURE` (optional, `true`/`false`; default ist `true` bei Port `465`)
- `SMTP_USER` / `SMTP_PASS` (optional, falls Auth benötigt)
- `SMTP_FROM` (oder `CONTACT_EMAIL`)
- `ALERT_TO` (Empfänger, Komma-separiert möglich)

Restart:

- `sudo systemctl restart pelletpreis-checker.service`

### Testmail senden

- Im Tab „Alarme“ auf „Testmail“ klicken **oder**
- per API:
  - `curl -sS -X POST http://127.0.0.1:8000/api/email/test -H 'content-type: application/json' -d '{}'`

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

### Update direkt im Frontend

Das Install- und Update-Script installiert einen systemd-Trigger für sichere Update-Anforderungen aus dem System-Tab. Wegen der privilegierten Ausführung benötigt diese Funktion zwingend Passwortschutz und folgende Werte in `/etc/pelletpreis-checker.env`:

- `APP_PASSWORD=<ein-langes-zufälliges-passwort>`
- `ALLOW_FRONTEND_UPDATE=1`

Danach einmal ausführen und den Dienst neu starten:

- `sudo bash /opt/pelletpreis-checker/scripts/update-pelletpreis-checker-debian13-lxc.sh`
- `sudo systemctl restart pelletpreis-checker.service`

Bei einer verfügbaren GitHub-Version erscheint im Tab „System“ der Button „Update installieren“. Das Update läuft als root-gesteuerter systemd-Job; die Webapp ist dabei kurz nicht erreichbar und startet anschließend automatisch wieder.

## Zugriffsschutz (empfohlen bei LAN-Betrieb)

Optional schützt HTTP Basic Auth die gesamte Webapp inklusive API. In `/etc/pelletpreis-checker.env` setzen:

- `APP_USERNAME=admin`
- `APP_PASSWORD=<ein-langes-zufälliges-passwort>`

Danach:

- `sudo systemctl restart pelletpreis-checker.service`

Der Browser fragt beim nächsten Aufruf nach Benutzername und Passwort. Ohne `APP_PASSWORD` bleibt die App wie bisher im LAN offen.

## Lizenz

AGPL-3.0 (siehe `LICENSE`).

## Hinweis

Scraping kann gegen Nutzungsbedingungen verstoßen. Nutze nur Quellen, die du verwenden darfst.
