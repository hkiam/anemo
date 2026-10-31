# Xray im Vergleich: Was sich für Anemo lohnt

> Aktueller, umfassender Abgleich mit Zephyr Squad, Zephyr Scale und Xray: [vergleich-zephyr-xray.md](vergleich-zephyr-xray.md).

Xray (Xblend) ist das verbreitetste Testmanagement in Jira. Grundlage dieses Vergleichs sind der
öffentliche Funktionsumfang (Atlassian Marketplace, Stand Oktober 2026) und Erfahrungen mit Xray Server/DC.
Bewertet wird, was Anemos Nutzern im Alltag hilft. Ob ein Merkmal auf der Feature-Liste steht, spielt keine Rolle.

## Wo Anemo gleichwertig oder voraus ist
| Thema | Xray | Anemo |
|---|---|---|
| Testfall-Versionen | erst in der Enterprise-Stufe | Standard: jede Änderung ist eine Version, Ausführungen bleiben an ihrer Version, Hinweis „veraltet“ |
| Umgebungen/Konfigurationen | „Test Environments“ als Freitext je Ausführung | strukturierte Konfigurationen (DB, Client, OS …) mit automatischer Erkennung, Auswertung je Konfiguration, Wiederholen je Konfiguration |
| Datenhoheit | Jira-Issues (Cloud oder DC) | eigenständig, on-prem, eingeschränkte Projekte mit Zugriffsprotokoll |
| KI | KI-Testmodelle im Test Case Designer (Enterprise, begrenzte Lizenzen) | optional, on-prem-fähig, Prompts anpassbar, KI-Agenten mit QA-Freigabe |
| Durchführung | Testlauf-Bildschirm in Jira | Fokusfenster, Tastatur, „Speichern & weiter“, Evidenzen per Strg+V |
| Berichte | Gadgets, Coverage-Charts | Abschlussbericht nach ISO 29119-3, Lieferpaket mit Signatur, Release-Cockpit |
| BDD | Cucumber-Szenarien als Testtyp, Export/Import | Gherkin-Testfälle mit Live-Prüfung, Git-Abgleich, Cucumber-JSON-Import mit Schrittergebnissen |

## Ideen, die sich übertragen lassen (priorisiert)

| Prio | Idee aus Xray | Nutzen in Anemo | Aufwand | Umsetzungsskizze |
|---|---|---|---|---|
| **1** | **Parametrisierte Tests / Datensätze** (Parameter in Schritten, Werte als Tabelle, Iterationen je Datenzeile) | Ein Testfall statt vieler Kopien für Benutzerrollen, Dokumenttypen usw. Die Durchführung zeigt je Iteration Status und Befund. | mittel | Parameter `${rolle}` in Schritten, Datentabelle am Testfall (optional am Zyklus überschreibbar); Ausführung erhält Iterationen mit eigenen Schrittergebnissen; Gesamtergebnis = schlechteste Iteration. Gherkin-Grundrisse passen direkt dazu. |
| **1** | **Explorative Testsitzungen** (Xray Exploratory App) | Strukturiertes freies Testen: Charter, Timebox, Notizen, Screenshots, Funde → Fehler/Testfall | mittel | Neuer Ausführungstyp „Sitzung“ im Zyklus: Ziel, Dauer, Zeitnehmer, laufendes Protokoll (Text + Strg+V-Bilder), Fund → 🐞 Fehler melden bzw. „als Testfall übernehmen“. Passt ideal ins Fokusfenster. |
| **1** | **Anforderungsabdeckung je Version/Plan mit Status OK / NOK / NICHT AUSGEFÜHRT / UNABGEDECKT** und Traceability-Bericht | Freigabefrage „Sind alle Anforderungen des Release getestet?“ auf einen Blick, als Bericht für Abnahmen | klein–mittel | Vorhandene Abdeckungsanalyse um Plan-/Konfigurationsfilter und den Status „unabgedeckt“ erweitern; Bericht „Traceability-Matrix“ (Anforderung × Testfall × letztes Ergebnis) im Berichtsmenü und im Lieferpaket. |
| **2** | **Testsets** (statische und dynamische Sammlungen) | Wiederkehrende Auswahl wie „Smoke“, „Regression Kern“ schnell in Zyklen aufnehmen | klein | Gespeicherte Ansicht oder Label als Testset nutzbar machen: „+ Tests aufnehmen → aus Testset“. Dynamisch = Filter, statisch = feste Liste. |
| **2** | **Wiederverwendbare Vorbedingungen** (eigene Objekte, mehreren Tests zugeordnet) | Einmal pflegen statt in 50 Testfällen kopieren, z. B. „Testmandant mit Akte vorbereitet“ | mittel | Vorbedingung als eigenes, versioniertes Objekt mit Verweis aus Testfällen; Anzeige in Durchführung und Bericht; Änderung zeigt betroffene Testfälle. |
| **2** | **Modulare Tests** („Call Test“: Schritte eines anderen Testfalls einbinden) | Gemeinsame Abläufe (Anmelden, Akte anlegen) nur einmal pflegen | mittel | Schritt vom Typ „Testfall einbinden“; in der Durchführung aufgeklappt; Versionierung beachten. |
| **2** | **Dauer je Ausführung** (Start/Ende, Timer) | Aufwandsschätzung für künftige Zyklen, Planung „Verteilen“ nach echter Dauer statt Schrittanzahl | klein | Startzeit beim Öffnen/ersten Status, Ende beim Speichern; Anzeige im Zyklus, Summen im Bericht, Verteilen gewichtet mit Erfahrungswerten. |
| **3** | **Kombinatorische Testplanung** (Test Case Designer: paarweise Kombination) | Weniger Zyklen bei vielen Konfigurationen (DB × Client × OS) bei gleicher Abdeckung | mittel | Beim „Wiederholen je Konfiguration“ wahlweise paarweise statt vollständig; auch für Datensätze nutzbar. |
| **3** | **Fehler je Schritt** | Genauere Zuordnung bei langen Testfällen | klein | Verweis „Fehler“ optional mit Schrittnummer; Anzeige am Schritt. |
| **3** | **Weitere Importformate** (TestNG, NUnit, Robot Framework, xUnit) | Mehr CI-Werkzeuge ohne Umweg | klein | Parser analog JUnit (Robot: output.xml). |
| **3** | **Abdeckung im Ticket sichtbar** (Xray-Panel im Jira-Issue) | Entwicklung sieht am Ticket, ob getestet | klein | OpenProject: Abdeckungsstatus als Kommentar/benutzerdefiniertes Feld am Arbeitspaket aktualisieren (Rückverweis existiert bereits). |

**Bewusst nicht übernehmen:**
- **Tests als Ticket-Typen**: Anemo bleibt eigenständig; Verknüpfung statt Duplikat.
- **Gadget-Baukasten**: Ein festes, gutes Cockpit ist für die Zielgruppe wertvoller als frei konfigurierbare Dashboards.

## Umsetzungsstand
Umgesetzt in Stufe G: parametrisierte Tests, explorative Sitzungen, Rückverfolgbarkeit, Testsets und Dauer je Ausführung.
Die übrigen Ideen stehen in der Roadmap.

## Empfehlung (ursprünglich)
Als Nächstes die drei Punkte mit Priorität 1:
1. **Parametrisierte Tests**: größter Pflegegewinn, passt zu Gherkin-Grundrissen.
2. **Explorative Sitzungen**: modernes manuelles Testen und gute Ergänzung zur KI-Unterstützung.
3. **Abdeckung je Release als Traceability-Bericht**: wichtig für Abnahme und Freigabe.

Dazu die kleinen Gewinne **Testsets** und **Dauer je Ausführung**. Zusammen ist das etwa ein Ausbauschritt in der
Größe der bisherigen Roadmap-Stufen.
