# ADR-0008: Klassische Schritte und Gherkin gleichrangig im Kernmodell

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Der ursprüngliche Plan sah BDD erst in Wave 5 vor. QA arbeitet heute klassisch (Aktion / Testdaten /
Erwartung); gleichzeitig soll BDD/Gherkin kein Textfeld zweiter Klasse sein.

## Entscheidung
- Jede Testfallversion hat `format = CLASSIC | GHERKIN`. Bei `GHERKIN` ist `gherkin` Pflicht und wird
  beim Speichern validiert (Fehler mit Zeilennummer).
- Eigener, abhängigkeitsfreier Gherkin-Parser (Deutsch und Englisch, `# language:`), unterstützt
  Funktionalität/Grundlage/Szenario/Szenariogrundriss/Beispiele/Regel, Tabellen, DocStrings, Tags.
- Für die **manuelle Ausführung** liefert der Server für beide Formate eine einheitliche Schrittliste
  (`executionSteps`); Gherkin-Schritte erhalten stabile IDs, „Dann“ wird zur Erwartung.
- Umwandlung klassisch ↔ Gherkin ist ein **Vorschlag** (`/api/gherkin/from-classic`, `/to-classic`)
  mit Hinweisen (fehlende Erwartung, mehrere Wenn/Dann-Blöcke) und wird erst durch Speichern zur neuen Version.

## Konsequenzen
BDD ist ab Wave 2 nutzbar. Wave 5 (Git/CI) kann Feature-Dateien direkt gegen `gherkin` synchronisieren.
Der Parser ersetzt nicht Cucumber; für Ausführung automatisierter Szenarien bleibt das Test-Framework zuständig.
