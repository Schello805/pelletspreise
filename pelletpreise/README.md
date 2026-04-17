# Pelletpreis-Checker

Lokale Webapp zum Abrufen und Vergleichen von Pelletpreisen aus mehreren Quellen (HTML/Regex + optional Playwright für dynamische Seiten).

## Start

1. Server starten:
   - `node server/server.js`
2. App öffnen:
   - `http://127.0.0.1:8000/pelletpreise/`

## Features

- **Quellenverwaltung** in der UI (`/pelletpreise/` → Tab „Quellen“)
  - `http-regex` (Preis ist im HTML vorhanden)
  - `playwright` (Formulare/JavaScript; optional)
- **Tages-Cache**: pro Quelle + Parametern wird i. d. R. nur 1× pro Tag abgerufen (Berlin-Zeit)
- **Ergebnisse** getrennt nach:
  - Deutschland-Durchschnitt (Ø)
  - Bestellbare Angebote (je Händler/Anbieter)
- **Historie**
  - Raw-Historie (letzte Abrufe)
  - Aggregierte Tageswerte + Chart/Analyse
- **Export**
  - CSV/JSON (raw oder daily)

## Architektur (kurz)

- Frontend: `pelletpreise/`
  - Entry: `pelletpreise/app.js`
  - Module: `pelletpreise/src/`
- Backend (Node HTTP-Server): `server/`
  - API: `server/server.js`
  - Caching: `server/lib/cache.js`
  - Historie: `server/lib/store.js` (JSONL) + `server/lib/history.js` (Aggregation/Export)
  - Scraper: `server/scrape/runner.js`
- Daten (lokal):
  - `server/data/sources.json`
  - `server/data/history.jsonl`
  - `server/data/cache.json`

## API (Auszug)

- `POST /api/scrape/run` – Abruf aller aktivierten Quellen
- `GET /api/sources` – Quellenliste
- `GET /api/history` – Raw-Historie (letzte Einträge)
- `GET /api/history/daily` – Tageswerte (Aggregation)
- `GET /api/history/export.csv` – Export (raw/daily)
- `GET /api/history/export.json` – Export (raw/daily)

## Playwright (optional)

Wenn eine Quelle client-seitig rendert (z. B. Seiten mit Formular + JS), kann `playwright` nötig sein.

- Install: `npm i -D playwright`
- Browser: `npx playwright install`

## Rechtliches

Scraping kann gegen Nutzungsbedingungen verstoßen. Nutze nur Quellen, die du verwenden darfst.

