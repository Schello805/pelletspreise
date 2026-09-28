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
- Backup/Restore mit frei wählbarem Historienzeitraum und Sicherheitsbackup
- System-Tab: Diagnose für Quellen, Speicher, E-Mail, Playwright, Schutz und Updates

## Versionierung

Bei jedem Push auf den Branch `main` erhöht der GitHub-Workflow die Patch-Version in `package.json` automatisch. Der Footer liest diese Version zur Laufzeit über die API aus. Nach dem nächsten LXC-Update zeigt die installierte Webapp somit die neue Versionsnummer an.

Der Workflow benötigt die GitHub-Actions-Berechtigung **Read and write permissions** für `GITHUB_TOKEN` (Repository Settings → Actions → General → Workflow permissions).

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

## Installation mit CapRover

Das Repository enthält eine `captain-definition` und ein produktionsfertiges `Dockerfile` inklusive Chromium für Playwright-Quellen.

1. In CapRover eine neue App anlegen und **Container HTTP Port `8000`** einstellen.
2. Unter **Deployment** dieses GitHub-Repository bzw. den Branch `main` verbinden und bereitstellen.
3. Unter **App Configs → Environmental Variables** mindestens setzen:
   - `BASE_URL=https://pelletpreise.example.de`
   - `APP_USERNAME=admin`
   - `APP_PASSWORD=<langes-zufälliges-passwort>`
   - bei E-Mail-Alarmen zusätzlich die unten beschriebenen `SMTP_*`- und `ALERT_TO`-Werte
4. Unter **App Configs → Persistent Directories** ein Volume für **`/app/server/data`** anlegen.
5. HTTPS aktivieren und die App mit genau einer Instanz betreiben, damit der tägliche Abruf nicht mehrfach gestartet wird.

Quellen, Historie, Einstellungen, Alarme und automatisch angelegte Sicherheitsbackups liegen dadurch im persistenten Volume und bleiben bei neuen Deployments erhalten. Updates werden bei CapRover über ein erneutes Deployment ausgeführt; das Debian/LXC-Update-Script wird im Container nicht benötigt.

### Backup & Restore

Im Tab **System** steht der Bereich **Backup & Wiederherstellung** zur Verfügung:

- Backup der letzten 30 oder 90 Tage oder eines frei wählbaren Zeitraums bis 3650 Tage
- Quellen, Einstellungen und Alarme sind unabhängig vom Zeitraum immer vollständig enthalten
- Download als komprimierte Datei `*.json.gz`
- Restore mit Prüfung des Dateiformats und klarer Bestätigung
- Vor jedem Restore entsteht automatisch ein vollständiges Sicherheitsbackup unter `/app/server/data/backups`; die fünf neuesten Sicherheitsbackups bleiben erhalten

Backup-Dateien können gespeicherte KI-API-Keys enthalten und sollten deshalb vertraulich behandelt werden. Für einen vollständigen Infrastruktur-Schutz empfiehlt sich zusätzlich ein regelmäßiges Volume-Backup auf Ebene des CapRover-Servers.

## Installation (Debian 13 / Proxmox LXC)

Im Repo liegt ein Install-Script (systemd Service):

- `scripts/install-pelletpreis-checker-debian13-lxc.sh`

Beispiel:

- `sudo bash scripts/install-pelletpreis-checker-debian13-lxc.sh`

Eine vollständige Vorlage für die Runtime-Konfiguration liegt als [`.env.example`](.env.example) im Repository. Für eine manuelle Konfiguration:

- `sudo install -m 600 .env.example /etc/pelletpreis-checker.env`
- Datei mit den echten SMTP-, Passwort- und LAN-Werten anpassen

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

Optional schützt eine lokale Sitzungsanmeldung die gesamte API. Die Webapp zeigt dann einen eigenen Login-Dialog an. In `/etc/pelletpreis-checker.env` setzen:

- `APP_USERNAME=admin`
- `APP_PASSWORD=<ein-langes-zufälliges-passwort>`

Danach:

- `sudo systemctl restart pelletpreis-checker.service`

Nach dem Neustart erscheint beim Aufruf der Webapp ein Login-Dialog. Dort kann „Angemeldet bleiben“ gewählt werden; die sichere Sitzung bleibt dann 30 Tage gültig, sonst 12 Stunden. Das Passwort selbst wird nicht von der Webapp gespeichert – der Browser kann es bei Bedarf im integrierten Passwortmanager ablegen. Ohne `APP_PASSWORD` bleibt die App wie bisher im LAN offen.

## Lizenz

AGPL-3.0 (siehe `LICENSE`).

## Hinweis

Scraping kann gegen Nutzungsbedingungen verstoßen. Nutze nur Quellen, die du verwenden darfst.
