# ADR-0013: Status mit Kategorie und Testfall-Workflow mit erlaubten Übergängen

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Die Auswertungen hingen an fest verdrahteten Codes (`FAIL`, `BLOCKED`, `NOT_EXECUTED`, `WIP`). Der Bestand bringt
aber eigene Zephyr-Status mit (z. B. „BESTANDEN MIT MANGEL“, „INVALID“, „PASS MIT EINSCHRÄNKUNG“).
Testfälle tragen zahlreiche verschiedene Jira-Status („Fertig“, „Aufgabe(n)“, „Review!“, „Spezifikation“ …), und es gab
bisher keinen Freigabeprozess.

## Entscheidung
- **Ausführungs- und Schrittstatus** bilden einen Katalog. Jeder Status hat eine **Kategorie**
  (`OPEN`, `IN_PROGRESS`, `PASSED`, `FAILED`, `BLOCKED`, `INVALID`), einen Geltungsbereich (Ausführung, Schritt oder
  beides), einen Aktiv-Schalter und eine Beschreibung. Filter („offen“, „fehlgeschlagen“), die Matrix „nur
  Probleme“, das Ereignis `TestFailed` und der Vorschlag des Gesamtergebnisses richten sich nach der Kategorie.
- Neu gesetzte Werte müssen aktiv und für ihren Zweck zugelassen sein. Bestehende Ergebnisse behalten ihren Status
  auch dann, wenn er später deaktiviert wird. `NOT_EXECUTED` bleibt immer aktiv und offen.
- Neu importierte Status erhalten eine aus dem Namen abgeleitete Kategorie, die in der Administration korrigiert
  werden kann. Eigene Status, die im Bestand nie an Schritten vorkommen, gelten nur für Ausführungen.
- **Testfall-Workflow:** Status mit Kategorie (`DRAFT`, `REVIEW`, `APPROVED`, `DEPRECATED`), Farbe und
  Ausgangsstatus, dazu erlaubte Übergänge. Vorgabe: Entwurf → Bereit zum Review → Freigegeben → Veraltet, mit
  Rückwegen. Migrierte Jira-Status werden in den Katalog übernommen. Hat ein Status keine ausgehenden Übergänge,
  ist der Wechsel von ihm aus frei. So bleibt der Bestand bedienbar, bis der Workflow festgelegt ist.
- Geprüft werden Änderungen durch Benutzer (Einzel- und Massenbearbeitung). Import und Systemvorgänge prüfen nicht,
  nehmen unbekannte Status aber in den Katalog auf.

## Konsequenzen
Auswertungen bleiben richtig, wenn Status umbenannt oder ergänzt werden. Rollen je Übergang (z. B. „nur
Projektadmin gibt frei“) und Pflichtfelder bei Übergängen sind mögliche Erweiterungen.
