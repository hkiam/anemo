# ADR-0005: Externe Arbeitspakete nur als Referenz (Provider-Abstraktion)

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Anforderungen, Stories und Defects liegen heute in Jira, künftig (auch) in OpenProject.
Das QA-Modell darf nicht an eines der Systeme gekoppelt werden.

## Entscheidung
Verweise auf fremde Arbeitspakete werden als `external_reference`
(`provider`, `external_key`, `relation`, `url`, `title_snapshot`, `status_snapshot`) gespeichert.
`relation` ist z. B. `REQUIREMENT`, `DEFECT`, `RELATED`, `SUBTASK`, `EPIC`, `AUTOMATION`.
Der Zugriff auf Live-Daten erfolgt später über einen Port `IssueTrackerAdapter`
(`getWorkItem`, `searchWorkItems`, `createDefect`, …) mit Implementierungen je Provider.

## Konsequenzen
Der Import kann Jira-Verweise sofort korrekt ablegen. OpenProject wird in Wave 4 als zusätzlicher
Provider ergänzt, ohne das QA-Modell anzufassen. Snapshots können veralten; Aktualisierung über Adapter.
