# ADR-0009: Zugriff auf Zephyr-Daten ohne ZAPI (Datenbank-Dump)

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Quelle der Migration ist Jira Server 7.x mit **Zephyr for JIRA 3.x** (Zephyr Squad Server). Testfälle sind dort
Jira-Vorgänge vom Typ `Test` und über Jira REST v2 vollständig lesbar (Felder, Kommentare, Historie, Anhänge, Links).
Testschritte, Zyklen, Ausführungen, Schrittergebnisse und Ausführungsanhänge liefert dagegen nur Zephyr selbst:
- Die offizielle Zephyr-API **ZAPI** war für diese Generation ein separat lizenziertes Add-on. Auf vielen
  Bestandsinstallationen ist sie nicht vorhanden, und für Jira-Server-Produkte ist eine Nachlizenzierung heute
  praktisch nicht mehr möglich (Server-Produkte seit 2024 ohne Support und Verkauf).
- Die interne Zephyr-UI-API (`/rest/zephyr/latest/...`) ist für Skriptzugriffe typischerweise gesperrt (`403`).
  Diese Sperre wird bewusst **nicht** umgangen.

## Optionen
1. ZAPI aktivieren bzw. lizenzieren – nur möglich, wo sie bereits vorhanden ist.
2. **Lesender Zugriff auf die Jira-Datenbank** (Zephyr-Tabellen `AO_7DEABF_*`, z. B. `TESTSTEP`, `CYCLE`,
   `SCHEDULE`, `STEP_RESULT`, Anhänge) plus Anhangsverzeichnis im Jira-Home. Vollständigster Weg inklusive
   Änderungshistorie; erfordert einen zusätzlichen Source-Adapter, der dasselbe Snapshot-Format erzeugt
   (Normalizer und Verifikation bleiben unverändert).
3. Manuelle Exporte aus der Zephyr-Oberfläche (Zyklus-/ZQL-Export). Unvollständig, nicht wiederholbar – nicht
   empfohlen.

## Entscheidung
Option 2 als **Dump der `AO_7DEABF_*`-Tabellen** (und der Zephyr-Einträge aus Jiras Eigenschaftstabellen) statt
Live-Zugriff: Ein Dump mit `mysqldump --single-transaction` ändert nichts am Produktivsystem, ist reproduzierbar und
über ein Manifest (Zeilenzahlen je Tabelle, SHA-256) prüfbar. Datenbankserver müssen dafür nicht von außen
erreichbar sein. Ablauf und Skripte: [Zephyr-Export](../migration/zephyr-export.md).

## Konsequenzen
Ohne geladene Zephyr-Daten meldet jede Verifikation „Snapshot vollständig extrahiert: ✗“ – es gibt keinen stillen
Teilerfolg. Ist ZAPI vorhanden, bleibt der REST-Weg des Extraktors nutzbar; beide Wege erzeugen dasselbe
Snapshot-Format.
