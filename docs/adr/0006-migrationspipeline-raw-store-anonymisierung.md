# ADR-0006: Migrationspipeline mit Raw Store, Snapshots und Anonymisierung

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Quelle ist Jira Server 7.1 mit Zephyr for Jira 3.x (Testfälle sind Jira-Issues, Schritte/Zyklen/
Ausführungen kommen aus der ZAPI bzw. der Zephyr-Datenbank, ADR-0009). Kein Feld darf stillschweigend verloren
gehen. Ein Teil der Testfälle kann aus Projekten mit besonderem Schutzbedarf (z. B. Behörden) stammen.

## Entscheidung
Pipeline: `Source Adapter → Snapshot (JSON-Dateien) → [Anonymizer] → Raw Store → Normalizer →
Canonical Model → Verification → Report`.

- **Snapshot**: Die Extraktion schreibt die API-Antworten unverändert als JSON-Dateien
  (`issues/`, `teststeps/`, `cycles/`, `executions/`). Import und Extraktion sind entkoppelt;
  Snapshots sind reproduzierbar und versionierbar.
- **Anonymizer**: pseudonymisiert Personen konsistent (gleiche Person → gleiches Pseudonym),
  optional Freitexte. Nur anonymisierte Snapshots dürfen in Entwicklungsumgebungen.
- **Raw Store**: `source_record(source_system, source_type, source_id, payload jsonb, hash)`.
  Jedes Objekt wird vollständig archiviert, bevor es normalisiert wird.
- **Mapping**: `migration_mapping` hält für jedes Quellobjekt Zielobjekt, Status
  (`MAPPED`, `PARTIAL`, `SKIPPED`, `FAILED`) und die Liste der **nicht strukturiert übernommenen
  Felder**. Diese Felder landen in `custom_fields` *und* bleiben im Raw Store.
- **Idempotenz**: Re-Import erkennt bereits migrierte Objekte über `(source_system, source_type,
  source_id)`; geänderte Payloads (Hash) erzeugen eine neue Testfallversion statt eines Duplikats.
- **Verification**: Ein Lauf ist nur erfolgreich, wenn *jeder* Raw-Record eine Mapping-Zeile hat.

## Konsequenzen
Das Mapping kann jederzeit verbessert und erneut angewendet werden. Ein Online-Adapter (REST) und ein
Offline-Adapter (Snapshot-Verzeichnis) teilen sich denselben Normalizer.
