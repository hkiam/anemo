# ADR-0007: Domain Events transaktional persistieren (Outbox / Event-Log)

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Agenten (Wave 8) sollen auf `TestCaseChanged`, `TestExecuted` usw. reagieren. Das Event-Modell soll
von Anfang an existieren, ohne sofort einen Broker zu betreiben.

## Entscheidung
Fachliche Änderungen schreiben in derselben Transaktion einen Eintrag in `domain_event`
(`type`, `aggregate_type`, `aggregate_id`, `payload jsonb`, `occurred_at`, `actor`). Zusätzlich wird ein
Spring-Application-Event publiziert (in-process Listener). `domain_event` dient gleichzeitig als
Audit-Trail und als Quelle für spätere Verteilung (Polling-Relay, Kafka, Webhooks, MCP-Notifications).

## Konsequenzen
Kein Event geht bei Fehlern verloren; Konsumenten können per Sequenznummer nachlesen.
Ein Broker kann später ergänzt werden, ohne Producer zu ändern.
