# ADR-0015: Integrationen über Adapter, Fehlermeldungen aus Vorlagen

- Status: angenommen (OpenProject vorbereitet, Inbetriebnahme folgt)
- Datum: 2026-10-11

## Kontext
Fehler sollen aus der Durchführung heraus an die Entwicklung gemeldet werden (Roadmap B2), zunächst nach
OpenProject. Die Meldung soll alles enthalten, was die Entwicklung braucht, und zurück auf die Ausführung zeigen,
damit ein Nachtest möglich ist. Zugangsdaten für OpenProject liegen noch nicht vor.

## Entscheidung
- Modul `integrations` mit einem Adapter je System (Port `IssueTrackerAdapter` aus ADR-0005). Der
  **OpenProject-Adapter** (API v3: Benutzer prüfen, Arbeitspaket lesen/suchen/anlegen, Kommentar) wird aktiv, sobald
  `OPENPROJECT_URL` und `OPENPROJECT_API_KEY` gesetzt sind. Der Schlüssel wird nie über die API ausgegeben.
- **Projektzuordnung** `project_integration` (Anemo-Projekt → OpenProject-Projekt, optional Typ-ID für Fehler).
- **Fehlervorlagen** `defect_template` (global oder je Projekt) mit einer logikfreien Platzhaltersprache
  (`{{pfad}}`, `{{pfad|kurz}}`, Abschnitte `{{#…}}`/`{{^…}}`). Die Daten kommen aus Ausführung, Testfallversion,
  Zyklus, Konfiguration, fehlgeschlagenem Schritt, Evidenzen und Rückverweis. Vorlagen sind in Jira-Markup
  geschrieben; für OpenProject wird nach Markdown übersetzt.
- **Fehler melden** in der Durchführung: Entwurf aus der Vorlage, prüfen und bearbeiten, dann im Fremdsystem
  anlegen. Danach wird der Fehler als `DEFECT`-Verweis an der Ausführung gespeichert. Ohne eingerichtete Integration
  lässt sich der Text kopieren und der angelegte Fehler von Hand verknüpfen.
- Inhalte gehen nur raus, wenn das Projekt externe Dienste erlaubt (ADR-0014). Sonst antwortet die API mit 409 und
  nennt den Grund.

## Konsequenzen
Inbetriebnahme bedeutet: Umgebungsvariablen setzen, Verbindung prüfen, Projekte zuordnen. Noch offen für B1/B2:
Rück-Link im Arbeitspaket (Kommentar beim Verknüpfen), Statusabgleich und automatische Nachtest-Aufgabe, wenn ein
Fehler erledigt ist, Suche im Verknüpfungsdialog, Testfälle und Pläne mit Anforderungen verknüpfen.
