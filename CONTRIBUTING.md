# Mitwirken an Anemo

Danke für dein Interesse! Fehlerberichte, Verbesserungsvorschläge und Pull-Requests sind willkommen.

## Fehler melden und Ideen einbringen

- Bitte zuerst in den bestehenden Issues suchen.
- Ein guter Fehlerbericht enthält: Version (`GET /api/version` bzw. Server-Log beim Start), Schritte zum Nachstellen,
  erwartetes und tatsächliches Verhalten, gegebenenfalls Screenshots oder Server-Log (ohne Zugangsdaten und ohne
  echte Testinhalte).
- Sicherheitslücken bitte **nicht** als Issue, sondern wie in [SECURITY.md](SECURITY.md) beschrieben melden.

## Entwicklungsumgebung

```bash
npm install
npm run dev        # PostgreSQL, Backend mit Hot-Reload, Oberfläche mit Vite
```

Vor einem Pull-Request:

```bash
npm run typecheck
npm test           # node:test gegen echte PostgreSQL
npm run e2e        # Playwright inkl. Layout- und Barrierefreiheitsprüfung (bei Änderungen an der Oberfläche)
```

## Leitlinien

- **Modulgrenzen**: Module unter `server/src/modules/<modul>` werden nur über ihre `index.ts` importiert
  (geprüft durch `modularity.test.ts`).
- **Migrationen**: angewandte SQL-Migrationen nie ändern – immer eine neue Datei anlegen und ihre Prüfsumme in
  `server/test/migrations.test.ts` eintragen.
- **Tests**: Jede Änderung am Verhalten bringt einen Test mit; Fehlerbehebungen einen Regressionstest.
- **Oberfläche und Dokumentation** sind deutschsprachig, mit korrekten Umlauten. Die Oberfläche soll per Tastatur
  bedienbar sein und WCAG 2.1 AA erfüllen.
- **Abhängigkeiten** sparsam: neue Laufzeitkomponenten brauchen eine kompatible Lizenz (siehe
  `config/third-party.json`, Prüfung mit `npm run third-party`).
- **Beispieldaten** sind immer fiktiv (z. B. `DEMO-T1`, `PROJ-123`, `example.org`) – keine echten Namen, Kunden oder
  Zugangsdaten.
- Größere Änderungen am besten vorher in einem Issue abstimmen; Architekturentscheidungen stehen in
  [docs/adr](docs/adr).

## Lizenz

Mit einem Beitrag stimmst du zu, dass er unter der [Apache License 2.0](LICENSE) veröffentlicht wird
(Abschnitt 5 der Lizenz).
