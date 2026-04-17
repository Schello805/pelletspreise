# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format basiert auf *Keep a Changelog* und Versionsnummern folgen *Semantic Versioning*.

## [1.1.0] - 2026-04-13
### Added
- PWA/Service‑Worker: Offline‑Support und „Update installieren“ direkt aus dem Footer (HTTPS/localhost).
- CI (GitHub Actions): Syntaxchecks + Versions-Konsistenzprüfung.

## [1.1.34] - 2026-04-14
### Changed
- Footer: Linkliste ist jetzt kleiner und untereinander.

## [1.1.35] - 2026-04-16
### Changed
- Header: Logo verlinkt jetzt auf die Startseite (auch auf Impressum/Datenschutz/Cookies).

## [1.1.36] - 2026-04-16
### Added
- Designs: 3 neue Templates (Underline, Compact Card, Classic).
### Changed
- UI: Designkarten kompakter, damit mehr Designs sichtbar sind.

## [1.1.37] - 2026-04-16
### Added
- Designs: 4 weitere Templates (Top Stripe, Mono, Bubble, Poster) – insgesamt jetzt 12.
### Changed
- UI: Designkarten zeigen nur noch den Namen (keine Beschreibung).

## [1.1.38] - 2026-04-16
### Changed
- Designs: „Bubble“ wurde zu einem deutlich kräftigeren „Ribbon“-Look umgebaut.
- Designs: „Poster“ wurde zu „Centered“ (zentriert, deutlich anders) umgebaut.
- Social Icons: Icon-Definitionen zentralisiert; Social-Row kann in bestimmten Designs zentriert gerendert werden.

## [1.1.39] - 2026-04-16
### Changed
- Design „Card“: Optik klarer getrennt von „Gradient Badge“ (Accent-Frame + Pill statt Split-Header).

## [1.1.33] - 2026-04-14
### Changed
- Footer: Links sind jetzt einfache Textlinks (keine Button-Pills).

## [1.1.32] - 2026-04-14
### Added
- SEO: Meta-Description, Open Graph/Twitter Cards, Canonical + Schema.org (WebApplication), `robots.txt` und `sitemap.xml`.

## [1.1.31] - 2026-04-14
### Added
- Validierung: Ungültige URLs/Telefonnummern werden direkt am Feld angezeigt (statt still zu ignorieren).
### Changed
- Autokorrektur: URLs ohne Protokoll bekommen beim Verlassen des Feldes automatisch `https://` ergänzt.

## [1.1.30] - 2026-04-14
### Changed
- UI: Vorschau-Buttons: „Kopieren“ links, weitere Copy-Buttons rechtsbündig.

## [1.1.29] - 2026-04-14
### Changed
- Branding: Sichtbarer Branding-Text ist kleiner und lautet jetzt „created by …“; HTML-Kommentar angepasst.

## [1.1.28] - 2026-04-14
### Changed
- Branding: HTML-Kommentar ist immer enthalten; Checkbox steuert nur den sichtbaren Hinweistext in der Signatur (standardmäßig an).
- Header: Untertitel klarer und mit Hinweis „kostenlos“.

## [1.1.27] - 2026-04-14
### Changed
- UI: HTML-Ausgabe ist jetzt standardmäßig eingeklappt (Accordion).

## [1.1.26] - 2026-04-14
### Changed
- Claim/Zusatztext: Wird in allen Designs am Ende (klein, kursiv) dargestellt.
- Branding: Standardmäßig aktiv (HTML‑Kommentar).
- UI: Neuer Hilfe‑Bereich unten rechts; Kompatibilitäts‑Hinweise + Anwendungshinweise dorthin verschoben.

## [1.1.25] - 2026-04-14
### Fixed
- Branding: Checkbox-Status wird korrekt wiederhergestellt (LocalStorage/Reload), damit das Kommentar-Branding nicht „versehentlich aus“ wirkt.

## [1.1.24] - 2026-04-14
### Changed
- Anwendungshinweise: Apple-Mail Detail-Hinweise (Datei-Pfad/HTTPS/localhost) entfernt, um Verwirrung zu vermeiden.

## [1.1.23] - 2026-04-14
### Added
- Anwendungshinweise: Apple Mail (macOS) Hinweise ergänzt.

## [1.1.22] - 2026-04-14
### Added
- Optional: Dezentes Branding als HTML‑Kommentar „Erstellt mit signatur-generator.com“ (nicht sichtbar, kann von Mail‑Clients entfernt werden).

## [1.1.21] - 2026-04-14
### Changed
- Gradient Badge: „Signature“ Text im Badge entfernt.

## [1.1.20] - 2026-04-14
### Fixed
- Social‑Icons: XING zeigt jetzt ein echtes Logo-Icon (Tabler Icons, MIT) statt Text-Fallback.

## [1.1.19] - 2026-04-14
### Changed
- UI: Vorschau-Actions linksbündig in 2 Zeilen (Kopieren oben, Downloads darunter) + kompaktere Download-Buttons.

## [1.1.18] - 2026-04-14
### Changed
- UI: Preview-Buttons sauber gruppiert (Kopieren/Downloads), damit nichts mehr „komisch“ umbrechen muss.

## [1.1.17] - 2026-04-14
### Added
- UI: Einfacher „Kopieren“-Button über der Vorschau (kopiert Rich‑Text).

## [1.1.16] - 2026-04-14
### Changed
- UI: Claim-Feld nach oben verschoben; Social‑Felder stehen jetzt zusammen.

## [1.1.15] - 2026-04-14
### Added
- Social‑Links: XING‑URL (optional) + Ausgabe als zusätzlicher Social‑Button/Link.

## [1.1.14] - 2026-04-14
### Changed
- Signatur: „LinkedIn: Profil“ wird nicht mehr als extra Textzeile ausgegeben (LinkedIn bleibt über Social‑Icons/Links verfügbar).

## [1.1.13] - 2026-04-14
### Fixed
- Update-Check: erkennt neue Versionen jetzt über GitHub `package.json` (statt nur SHA-Baseline), damit „Update verfügbar“ zuverlässiger erscheint.
### Changed
- Layout: Bild/Logo wieder links bei den Daten; Settings rechts unter Design/Vorschau.

## [1.1.12] - 2026-04-13
### Changed
- Layout: Einstellungen in die rechte Spalte verschoben (eigene „Einstellungen“-Box), links bleiben nur Daten/Content-Felder.

## [1.1.11] - 2026-04-13
### Fixed
- Gradient Badge: „Akzent: …“ Info aus dem Template entfernt.
- Bild-Vorschau: Uploads per `data:image/...` werden jetzt auch im Signature-Preview gerendert (mit Größenlimit).
- Bild-URL: Pastes von `data:` werden im URL-Feld abgefangen (Bitte Upload nutzen) + Schutz vor extrem großen Data-URLs.

## [1.1.10] - 2026-04-13
### Fixed
- Bild‑URL: Eingabe auf 300 Zeichen begrenzt, um Abstürze durch extrem lange Pastes zu verhindern.
- Social‑Icons: URLs werden auf erwartete Domains validiert (z. B. Instagram nur `instagram.com`), damit Icons nicht auf falsche Ziele verlinken.

## [1.1.9] - 2026-04-13
### Changed
- Rechtstexte: Datenschutz/Cookies/Impressum inhaltlich ergänzt (Matomo-Hinweise, Server-Logs, Betroffenenrechte, MStV-Verantwortlicher).

## [1.1.8] - 2026-04-13
### Fixed
- Footer: Version/Commits-Link überlappt nicht mehr (Footer-Link-Styling nur für Navigation, nicht für Versions-Links).
### Added
- GitHub Pages Custom Domain: `CNAME` für `signatur-generator.com`.

## [1.1.7] - 2026-04-13
### Fixed
- Social‑Icons Vorschau: LocalStorage-Migration (`v1` → `v2`), damit „Icons (Logos)“ nicht von alten gespeicherten Einstellungen überschrieben wird.

## [1.1.6] - 2026-04-13
### Fixed
- Matomo: Queue-Reihenfolge angepasst (Tracker-Setup vor `trackPageView`), um 400er Requests zu vermeiden.

## [1.1.5] - 2026-04-13
### Added
- vCard-Link: Optionales Feld „vCard‑Download‑URL“ (wird als Link in der Signatur ausgegeben, wenn HTTPS-URL gesetzt ist).
### Changed
- Matomo: Tracking-Code in `matomo.js` eingebunden.

## [1.1.4] - 2026-04-13
### Changed
- Social‑Icons: „Icons (Logos)“ rendert jetzt echte Icon‑Buttons (ohne Initialen‑Text), damit sofort erkennbar ist, dass SVG‑Icons aktiv sind.

## [1.1.3] - 2026-04-13
### Changed
- UI: Light‑Mode als Standard (keine Theme‑Umschaltung mehr).
- Footer: neu strukturiert (Links / Datenschutz‑Hinweis / Version).
- PWA/Cache: Network‑first auch für JS/CSS/Webmanifest, damit Updates zuverlässiger ankommen.
### Added
- `matomo.js` Platzhalter + Einbindung in alle Seiten.
- Rechtstexte: Hinweis auf Matomo (self‑hosted) ergänzt.

## [1.1.2] - 2026-04-13
### Changed
- Social‑Icon‑Buttons: SVGs auf Bootstrap Icons (MIT) umgestellt, mit robustem Fallback (Initialen bleiben sichtbar, falls SVG entfernt wird).
- Kompatibilitäts‑Hinweis: Zusätzlicher Hinweis, dass viele Mail‑Clients inline‑SVG entfernen.
### Added
- `THIRD_PARTY_NOTICES.md` (Bootstrap Icons Lizenz/Notice).

## [1.1.1] - 2026-04-13
### Added
- Profil Export/Import als JSON (für spätere Bearbeitung).
### Changed
- Social‑Badges optional als Icon‑Buttons (SVG) – mit Fallback in „Outlook‑sicher“ auf Textlinks.

## [1.0.2] - 2026-04-13
### Changed
- Designkarten wieder vollflächig klickbar, Vorschau per Doppelklick.

## [1.0.1] - 2026-04-13
### Changed
- UI-Polish (Footer, Karten, Preview-Bereich).

## [1.0.0] - 2026-04-13
### Added
- Erste Version des Signaturgenerators (Templates, Export, vCard, Rechtstexte).
