# ADR-0026: Fremdkomponenten beim Build prüfen, SBOM erzeugen

**Status:** angenommen (12.10.2026)

## Kontext
Anemo wird als Container ausgeliefert und soll unter der Apache License 2.0 veröffentlicht werden. Betreiber in der
öffentlichen Verwaltung verlangen eine Stückliste der Software (SBOM) und den Nachweis, dass keine Komponenten mit
unverträglichen Lizenzen oder bekannten schweren Schwachstellen ausgeliefert werden.

## Entscheidung
- Ein eigenes Werkzeug `tools/third-party.ts` ohne zusätzliche Abhängigkeiten liest `package-lock.json` und
  `node_modules` und unterscheidet:
  - **Laufzeit:** Abhängigkeiten des Servers (im Container) und der Web-Oberfläche (im Bundle).
  - **Entwicklung:** nur zum Bauen und Testen.
- **Lizenzen** werden gegen `config/third-party.json` geprüft:
  - Erlaubt: permissive Lizenzen.
  - Prüfpflichtig: schwaches Copyleft wie MPL/LGPL.
  - Unzulässig: GPL, AGPL, SSPL, BUSL und nicht lizenzierte Komponenten.
  - Unbekannt: fehlende Kennung.
  - Bei Laufzeitkomponenten bricht jeder Verstoß den Build ab. Entwicklungskomponenten werden nur gemeldet.
  - Ausnahmen werden je Paket mit Begründung eingetragen.
- **Schwachstellen:** `npm audit` über die Laufzeitkomponenten; „hoch“ und „kritisch“ brechen den Build ab.
- **SBOM:**
  - Das Werkzeug erzeugt CycloneDX 1.5 und SPDX 2.3 für die ausgelieferten Komponenten, mit Hashes, purl,
    Abhängigkeitsgraph und Basis-Image.
  - Eine zweite CycloneDX-Datei enthält zusätzlich die Entwicklungswerkzeuge.
  - Dazu kommt `THIRD-PARTY-NOTICES.md` mit den Lizenztexten der ausgelieferten Komponenten.
- **Einbindung in den Build:**
  - `npm run build`
  - Docker-Build: Prüfung im Build-Stadium, Ergebnis im Image unter `/app/third-party`.
  - GitLab-CI und GitHub-Actions: Ergebnis als Artefakt.
  - Die CI scannt zusätzlich das fertige Image mit syft. Diese SBOM erfasst auch Node.js und die Systembibliotheken
    des Basis-Images.

## Folgen
- Eine neue Abhängigkeit mit unpassender Lizenz fällt sofort beim Build auf, nicht erst bei der Veröffentlichung.
- `npm audit` braucht Netz. Für Offline-Builds gibt es `--audit-optional` (lokal in `npm run build`, im Docker-Build
  per `--build-arg THIRD_PARTY_AUDIT=--audit-optional`); die CI prüft immer streng.
- npm hat zwar ein eingebautes `npm sbom`. Es scheitert aber am Wurzelpaket ohne Versionsangabe und unterscheidet
  nicht zwischen Server-, Web- und Entwicklungskomponenten. Deshalb das eigene Werkzeug.

## Nachtrag 2026-10-30: mitgelieferte Dateien
Dateien Dritter ohne npm-Paket (Schriften und Farbprofil der PDF-Berichte unter `server/assets`) stehen in
`config/third-party.json` unter `vendored` mit Version, Quelle, Lizenz und SHA-256 je Datei. Das Werkzeug führt sie
als Laufzeitkomponenten (purl `pkg:generic/…`) in Lizenzprüfung, SBOM und THIRD-PARTY-NOTICES und bricht ab, wenn eine
Datei fehlt oder ihre Prüfsumme abweicht. Lizenzen außerhalb der Liste (DejaVu: Bitstream-Vera) sind begründete Ausnahmen.
