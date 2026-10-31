# ADR-0004: Testfälle haben unveränderliche Versionen ab Tag 1

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Der Ursprungsplan führt Versionierung erst in Wave 4 ein. Die Discovery zeigt, dass QA heute
Änderungen manuell als Tabelle in der Beschreibung protokolliert. Ausführungen in Wave 2 müssen
reproduzierbar bleiben.

## Entscheidung
- `test_case` hält nur Identität und Verwaltungsdaten (Schlüssel, Projekt, Ordner, Status, Owner).
- Jeder fachliche Inhalt (Titel, Beschreibung, Vorbedingungen, Schritte, Priorität, Labels,
  Komponenten, Custom Fields) liegt in `test_case_version` und ist **unveränderlich**.
- Jede inhaltliche Änderung erzeugt Version n+1; `test_case.current_version` zeigt auf die neueste.
- Eine Ausführung referenziert immer eine konkrete Version (`TC-4711@v3`).
- Verwaltungsänderungen (Ordner verschieben, Status) erzeugen keine Version, aber einen Audit-Eintrag.

## Konsequenzen
Historische Ergebnisse ändern sich nie. Diff zwischen Versionen ist trivial. Speicherverbrauch steigt
moderat (Schritte werden je Version als `jsonb`-Snapshot gespeichert).
