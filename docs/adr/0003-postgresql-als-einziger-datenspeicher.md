# ADR-0003: PostgreSQL als einziger Datenspeicher (inkl. Suche)

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Der Plan nennt "PostgreSQL + Search". Erwartet werden Bestände in der Größenordnung von einigen tausend bis zehntausend Testfällen.

## Entscheidung
PostgreSQL ist System of Record **und** Suchindex: Volltext über `tsvector` (Konfiguration `german`),
Rohdaten als `jsonb`, später Ähnlichkeitssuche über `pgvector`. Kein separates OpenSearch/Elastic,
solange Messungen keinen Bedarf zeigen. Schema-Migrationen als nummerierte SQL-Dateien (`server/migrations`), eigener Runner mit Advisory-Lock; ausgelieferte Migrationen werden nie geändert (Test mit Prüfsummen). PostgreSQL ≥ 18 (`uuidv7()`).

## Konsequenzen
Einfacher Betrieb (ein Stateful-Container). Suche ist transaktional konsistent mit den Daten.
