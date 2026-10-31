# ADR-0028: Revisionssicherheit – Freigabestand und unveränderliches Protokoll

- Status: angenommen
- Datum: 2026-10-30

## Kontext
Das fachliche Review vom 30.10.2026 zeigte drei Lücken für Audits durch Auftraggeber (Behörden):
1. Die Freigabeentscheidung speicherte nur Entscheidung, Begründung, Person und Zeit. Der Abschlussbericht entstand bei
   jedem Aufruf neu aus den aktuellen Daten – nach späteren Änderungen stand dieselbe Entscheidung neben anderen
   Zahlen.
2. Prozessrelevante Änderungen (Ausstiegskriterien, Abschließen/Wiederöffnen von Zyklen, Plan- und Zyklusdaten,
   Projektregeln, Kategorien des Statuskatalogs) hinterließen kein Ereignis.
3. Das Ereignisprotokoll war nur für die Systemadministration einsehbar, ohne Filter und Export, und technisch nicht
   gegen Änderungen geschützt.

## Entscheidung
- **Freigabestand**: Zu jeder Freigabeentscheidung legt Anemo das Lieferpaket (Berichte, Protokolle, Ergebnisse,
  Evidenzen, Prüfsummen, ggf. Signatur) unverändert im Datenverzeichnis ab (`.release-baselines` im
  Anhangsverzeichnis, mit der Sicherung) und protokolliert die SHA-256 (`ReleaseBaselineCreated`). Der Stand entsteht
  nach der Entscheidung (Ereignis-Abonnement) und wird beim Start bzw. Abruf nachgeholt; jede Entscheidung hat genau
  einen Stand (`unique (plan_id, decided_at)`). Der Plan wird nicht gesperrt – Nachtests und Korrekturen bleiben
  möglich –, aber Cockpit und Abschlussbericht zeigen die Zahl der Änderungen nach der Entscheidung an.
- **Audit-Trail mit altem und neuem Wert** (`recordChange`): nur geänderte Felder, kein Ereignis ohne Änderung. Das
  Fazit wird mit Verfasser, Zeitpunkt und ggf. Modell des KI-Entwurfs gespeichert; jede Fassung steht im Protokoll.
- **Unveränderliches Protokoll**: Ein Datenbank-Trigger verbietet `update` und `delete` auf `domain_event`. Einzige
  Ausnahme ist das Entfernen von Kommentarauszügen beim Löschen eines Projekts (Datenschutz), freigeschaltet nur für
  diese Transaktion (`anemo.event_redaction`).
- **Protokoll je Projekt**: Spalte `project_id` (per Trigger aus dem Objekt abgeleitet, Bestand nachgetragen),
  Ansicht für die Testleitung mit Filtern, deutschen Bezeichnungen (`shared/events/labels.ts`) und CSV-Export.

## Konsequenzen
- Auditoren erhalten den Stand der Entscheidung bitgenau und können ihn über die Prüfsumme im Protokoll prüfen.
- Speicherbedarf: ein Lieferpaket je Entscheidung (mit Evidenzen). Bei häufigem Umentscheiden wächst das
  Datenverzeichnis entsprechend.
- Eine Hash-Verkettung der Ereignisse (Manipulation auch durch Datenbankadministration erkennbar) ist nicht umgesetzt;
  der Trigger schützt gegen Fehler und Anwendungszugriffe, nicht gegen Superuser.
