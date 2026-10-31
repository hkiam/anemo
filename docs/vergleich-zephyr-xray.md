# Funktionsabgleich: Anemo, Zephyr und Xray (Stand 11.10.2026, nach Stufe I)

Verglichen werden drei Werkzeuge und Anemo:
- **Zephyr Squad DC**: das Altsystem „Zephyr for Jira“, seit 2025 „Zephyr Essential“;
- **Zephyr Scale**: heute „Zephyr“, DC und Cloud;
- **Xray**: DC und Cloud, Editionen Standard, Advanced und Enterprise;
- **Anemo** auf dem Stand des Codes.

Quellen für die Fremdprodukte: Herstellerdokumentation (support.smartbear.com, docs.getxray.app) und Atlassian
Marketplace. Anemos Stand wurde im Code geprüft, nicht im Handbuch. Der frühere Xray-Vergleich steht in
[vergleich-xray.md](vergleich-xray.md).

**Rahmen:**
- Atlassian verkauft seit 30.03.2026 keine Data-Center-Apps mehr an Neukunden.
- Ab 28.03.2029 sind DC-Produkte nur noch lesbar.
- KI-Funktionen bieten Zephyr und Xray ausschließlich in der Cloud an.
- Für sensible Projekte, die on-prem bleiben müssen, gibt es dort also künftig keine Weiterentwicklung.

Legende: ✓ vorhanden · teilw. teilweise · ✗ fehlt · Ent nur Xray Enterprise · Cl nur Cloud · DC nur Data Center ·
? unklar

## 1. Gesamtbild

**Wo Anemo vorne liegt:**
- **Versionierung**: Squad hat keine, Xray nur in Enterprise. In Anemo ist sie Standard, mit Feldvergleich und
  rekonstruierter Zephyr-Historie.
- **Freigabeprozess**: Vier-Augen-Freigabe je Version gibt es in keinem der drei Werkzeuge.
- **Ausstiegskriterien, Freigabeentscheidung und Abschlussbericht nach ISO 29119-3**, dazu ein signiertes
  Lieferpaket.
- **Strukturierte Konfigurationen**: automatische Erkennung, Auswertung je Merkmal, Wiederholen je Konfiguration.
- **Datenhoheit**: eingeschränkte Projekte mit Zugriffsprotokoll, on-prem.
- **KI on-prem und optional**, dazu ein MCP-Server und Agenten mit QA-Prüfung.
- **Test-Health, Fokusfenster und Tastaturbedienung.**

**Wo Anemo Lücken hat:** Vor allem im **„Handwerkszeug“ großer Bestände**:
- Abfragesprache;
- CSV/Excel-Import und -Export;
- Löschen und Archivieren;
- vom Admin definierte Felder;
- Massenbearbeitung;
- Wiederverwendung: Vorbedingungen und aufrufbare Tests;
- Standardberichte und Gadgets.

Diese Lücken spüren Umsteiger aus Zephyr Squad zuerst.

**Nachtrag nach Stufe H:** Die Lücken der Prioritäten 1 und 2 sowie die Punkte 13, 14 und 18 der Priorität 3 sind
geschlossen (Matrix oben aktualisiert). Offen bleiben: Teststatusbericht (Zwischenbericht), Burn-down gegen geplantes
Ende, Beobachten mit Benachrichtigung, Schrittbibliothek, unstrukturierter Test, Fehler je Schritt, CI-Läufe aus
Anemo auslösen, Fehler direkt in Jira, Ausführung nur durch Zuständige, Offline-/Excel-Rundlauf.

**Nachtrag nach Stufe I:** Auch diese Punkte sind umgesetzt (siehe [Roadmap](ROADMAP.md), Stufe I). Bewusst nicht
übernommen bleiben Tests als Ticket-Typen/Sprint-Board, der Gadget-Baukasten, der No-Code-Recorder, die explorative
Desktop-App mit Video und eine Confluence-Anbindung.

## 2. Vergleichsmatrix

### A Repository & Organisation
| Funktion | Squad | Scale | Xray | Anemo |
|---|---|---|---|---|
| Zentrales Repository mit Ordnerbaum | ✗ | ✓ | ✓ | ✓ |
| Ordner umbenennen, verschieben, löschen | – | ✓ | ✓ | ✓ (Löschen mit Verschieben des Inhalts) |
| Labels / Komponenten | ✓ | ✓ | ✓ | ✓ / ✓ (Filter über Abfragesprache) |
| Volltextsuche, übergreifende Suche | teilw. (JQL) | teilw. | teilw. (JQL) | ✓ (inkl. Kommentare, Anhänge, Tickets) |
| Abfragesprache für Ausführungen (ZQL) | ✓ | ✗ | teilw. (30 JQL-Funktionen DC) | ✓ (Testfälle und Ausführungen, mit Prüfung und Vorschlägen) |
| Gespeicherte Filter, geteilt | ✓ | ✓ | ✓ | ✓ (Ansichten) |
| Massenbearbeitung Testfälle | ✓ (Jira) | ✓ | ✓ (Jira) | ✓ (Status, Ordner, Owner, Priorität, Komponenten, Labels, Felder, Schätzung, Archiv) |
| Massenbearbeitung Ausführungen | ✓ (Status, verschieben, zuweisen, Fehler, Felder, löschen) | teilw. | ✓ | ✓ (Status, Kommentar, zuweisen, Fehler, Felder, entfernen, verschieben) |
| Testfall klonen | ✓ | ✓ | ✓ | ✓ |
| Testfall löschen / archivieren | ✓ / ✗ | ✓ / ✓ | ✓ / teilw. | ✓ (nur nie eingeplante) / ✓ |

### B Testdesign
| Funktion | Squad | Scale | Xray | Anemo |
|---|---|---|---|---|
| Schritte Aktion/Daten/Erwartung | ✓ | ✓ | ✓ | ✓ |
| BDD/Gherkin mit Prüfung | ✗ | teilw. (ohne Validierung) | ✓ | ✓ (DE/EN, Live-Prüfung, Git-Abgleich) |
| Unstrukturierter Test (Plain Text) | ✗ | ✓ | ✓ | ✓ (Freitext) |
| Parameter / Datensätze | ✗ | ✓ | ✓ (bis 1.000 Iterationen) | ✓ (bis 200 Zeilen) |
| Datensatz am Plan/Zyklus überschreiben | ✗ | ? | ✓ | ✓ |
| Kombinatorische Parameter / Pairwise | ✗ | ✗ | ✓ / Ent | ✓ (alle Kombinationen oder paarweise; Datensätze und Konfigurationen) |
| Aufrufbare Tests (Call Test) | ✗ | ✓ | ✓ | ✓ (Version fest, bis Tiefe 5) |
| Vorbedingung als eigenes Objekt | ✗ | ✗ | ✓ | ✓ (versioniert, wiederverwendbar) |
| Schrittbibliothek | ✗ | teilw. | ✓ | ✓ (Bausteine als Kopie) |
| Eigene Felder (Admin definiert) | ✓ | ✓ (auch Pflichtfelder) | ✓ | ✓ (Testfall, Zyklus, Ausführung; Pflichtfelder; Auswahllisten mit Abgleich aus Jira/OpenProject) |
| Priorität als Werteliste | ✓ | ✓ | ✓ | ✓ |
| Anhänge an Schritten | ✓ | ✓ | ✓ | ✓ |

### C Versionierung, Freigabe, Historie
| Funktion | Squad | Scale | Xray | Anemo |
|---|---|---|---|---|
| Testfall-Versionen | ✗ | ✓ | Ent | ✓ |
| Versionen vergleichen | ✗ | ✓ | ✗ | ✓ (feldweise) |
| Freigabe-Workflow | teilw. (Jira) | teilw. (Status) | teilw. (Jira) | ✓ (konfigurierbar, Vier-Augen, je Version) |
| Änderungshistorie Ausführung | ✓ | ✓ | ✓ | ✓ (Ergebnisverlauf) |
| Kommentare/Diskussion am Testfall | ✓ (Jira) | ✓ | ✓ (Jira) | ✓ (mit @Erwähnung und E-Mail) |
| Beobachten / Benachrichtigung bei Änderung | ✓ (Jira) | teilw. | ✓ (Jira) | ✓ (Testfall, Zyklus, Testplan; Erwähnungen; Webhooks) |

### D Planung
| Funktion | Squad | Scale | Xray | Anemo |
|---|---|---|---|---|
| Testpläne | ✗ | ✓ | ✓ | ✓ (mit Ausstiegskriterien, Freigabe) |
| Dynamische Testpläne/Testsets | ✗ | ✗ | Ent | ✓ (dynamische Testsets) |
| Testsets | ✗ | ✗ | ✓ | ✓ |
| Umgebungen / Konfigurationen | teilw. | ✓ | ✓ | ✓ (strukturiert, automatisch erkannt) |
| Ad-hoc-Ausführung ohne Zyklus | ✓ | ✓ | teilw. | ✓ (Jetzt ausführen → Ad-hoc-Zyklus) |
| Zyklus klonen / nur Fehlgeschlagene wiederholen | ✓ / teilw. | ✓ / ? | ✓ / ✓ | ✓ / ✓ |
| Testplan klonen | – | DC | ✓ | ✓ |
| Ausführung aus Zyklus entfernen | ✓ | ✓ | ✓ | ✓ |
| Zyklus löschen / archivieren | ✓ / ✓ | ✓ / ? | ✓ / teilw. | ✓ (nur ohne Ergebnisse) / ✓ |
| Geplanter Aufwand (Schätzung) | ✓ | ✓ | ? | ✓ (je Testfall, Vorschlag aus Erfahrungswerten, Rest je Zyklus/Person) |
| Zyklen im Sprint/Board | ✓ | ✓ | teilw. | ✗ (bewusst: OpenProject) |

### E Durchführung
| Funktion | Squad | Scale | Xray | Anemo |
|---|---|---|---|---|
| Status je Schritt, eigene Status | ✓ | ✓ | ✓ | ✓ (mit Kategorien, Ableitung) |
| Evidenzen | ✓ | ✓ | ✓ | ✓ (Strg+V, Nachweispflicht) |
| Fehler anlegen aus Ausführung | ✓ (Jira) | ✓ (Jira) | ✓ (Jira) | ✓ (OpenProject; Jira im Parallelbetrieb) |
| Fehler je Schritt | ✓ | ✓ | ✓ | ✓ (mit Schweregrad) |
| Zeiterfassung | ✓ (Start/Pause/Done) | ✓ | ✓ | ✓ (automatisch, Leerlauf ausgenommen) |
| Iterationen | ✗ | ✓ | ✓ | ✓ |
| Explorativ | teilw. (Capture) | ✗ | ✓ (Desktop-App mit Video) | ✓ (Sitzungen, Nachbesprechung; ohne Video) |
| Schnellausführung aus der Liste | ✓ | ? | ? | ✓ (Status direkt in der Liste) |
| Ausführung nur durch Zuständige | ? | ? | ✓ | ✓ (Projektregel) |
| Offline/Excel-Rundlauf | ✗ | ✗ | teilw. | ✓ (mit Probelauf und Konflikterkennung) |

### F Automatisierung & CI
| Funktion | Squad | Scale | Xray | Anemo |
|---|---|---|---|---|
| REST-API | ✓ | ✓ | ✓ (+GraphQL Cl) | ✓ (OpenAPI, Tokens) |
| Import JUnit / Cucumber | ✓ / ✗ | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ |
| Import TestNG, NUnit, Robot, xUnit, Behave | teilw. | teilw. (Cl) | ✓ | ✓ (auch MSTest/TRX, Playwright, Jest; automatisch erkannt) |
| Ergebnisimport in der Oberfläche | ? | ✓ | ✓ | ✓ (mit nachträglicher Zuordnung) |
| Automatisch Fehler bei Automationsfehlschlag | ✓ | ✗ | ? | ✓ (OpenProject, offener Fehler wird wiederverwendet) |
| CI-Job auslösen | teilw. (ZBot) | ✗ | Ent | ✓ (GitLab-Pipeline je Zyklus) |
| MCP / KI-Agenten | ✗ | Cl | ? | ✓ (17 Werkzeuge, QA-Prüfung) |

### G Rückverfolgbarkeit
| Funktion | Squad | Scale | Xray | Anemo |
|---|---|---|---|---|
| Abdeckungsstatus je Anforderung | teilw. | ✓ | ✓ | ✓ (OK/NOK/nicht getestet/ohne Test) |
| Traceability Anforderung → Test → Ergebnis → Fehler | ✓ | ✓ | ✓ | ✓ |
| Rückrichtung Fehler → Anforderung | ✓ | teilw. | ✓ | ✓ (Top-Fehler mit betroffenen Anforderungen) |
| Historische Abdeckung | ✗ | teilw. | DC | ✓ (Verlauf je Woche, Rückverfolgbarkeit zum Stichtag) |
| Abdeckung im Ticket sichtbar | ✓ | ✓ | ✓ | ✓ (Kommentar in OpenProject bei Änderung) |

### H Berichte & Dashboards
| Funktion | Squad | Scale | Xray | Anemo |
|---|---|---|---|---|
| Standardberichte | 3 | bis 70 | ca. 8 | 4 + Cockpit, Matrix, Test-Health, Top-Fehler, Team & Aufwand, Portfolio |
| Gadgets / Dashboard | 10 | bis 60 | ca. 9 | Startseite mit 10 Kacheln, Cockpit |
| Burn-down/up | ✓ | ✓ | teilw. | ✓ (gegen geplantes Ende, mit Prognose) |
| Top-Fehler | ✓ | ✓ | teilw. | ✓ (betroffene Testfälle, Ausführungen, Anforderungen) |
| Auswertung je Tester / Zuweisung | ✓ | ✓ | ? | ✓ |
| Aufwand je Zyklus/Tester | ✓ | ✓ | ? | ✓ (erfasst, geplant, Rest) |
| PDF / Excel-Export | ✗ / ✓ | DC / ✓ | ✓ / ✓ | ✓ / ✓ |
| Projektübergreifende Berichte | ✗ | ✓ | Cl | ✓ (Portfolio) |

### I–L Import/Export, Integrationen, Administration, KI
| Funktion | Squad | Scale | Xray | Anemo |
|---|---|---|---|---|
| Testfälle aus CSV/Excel importieren | ✓ | ✓ | ✓ | ✓ (Spaltenzuordnung, Zephyr-/Xray-Vorlagen, Probelauf, Aktualisieren per Schlüssel) |
| Testfälle/Ausführungen nach Excel/CSV exportieren | ✓ | ✓ | ✓ | ✓ |
| Migration aus Zephyr | – | ✓ | ✓ | ✓ (verlustfrei, mit Historie) |
| Confluence | ✗ | DC | DC | ✗ |
| Teams/Slack | ? | ? | ? | teilw. (Webhook) |
| Eigenes Rechteschema je Projekt | ✓ | ✓ | teilw. | ✓ (Rollen, Gruppen, eingeschränkte Projekte) |
| Projekt umbenennen/löschen | ✓ (Jira) | ✓ | ✓ | ✓ |
| Backup/Restore | ✓ | ✗ | ✗ | ✓ (Skripte) |
| KI: Testfall aus Anforderung | ✗ | Cl | Cl | ✓ (on-prem möglich) |
| KI: Prüfung, Fehlermeldung, Fazit | ✗ | teilw. Cl | teilw. Cl | ✓ |
| KI: Testpriorisierung / Risikoauswahl | ✗ | teilw. Cl | Cl | ✓ (regelbasiert nachvollziehbar, optional KI mit Begründung, on-prem möglich) |

## 3. Lücken nach Priorität

**Priorität 1: erwartet von Umsteigern aus Zephyr Squad, alltäglich**
1. **CSV/Excel-Import und -Export** für Testfälle (mit Schritten) und Ausführungslisten. Ohne das bleiben
   Excel-Gewohnheiten und Abstimmungen mit Fachbereichen außen vor.
2. **Abfragesprache für Testfälle und Ausführungen** (ZQL-ähnlich). Sie wäre für Gespeicherte Ansichten,
   dynamische Testsets und die Massenbearbeitung nutzbar. Beispiel:
   `status = FAIL AND zyklus ~ "Regression" AND konfiguration.db = Oracle AND ausgeführt > -7d`
3. **Massenbearbeitung von Ausführungen**: Status setzen, Fehler verknüpfen, entfernen, in einen anderen Zyklus
   verschieben. Für Testfälle zusätzlich Priorität, Owner, Komponenten und Label entfernen.
4. **Löschen und Archivieren**:
   - Ausführungen aus dem Zyklus entfernen und Zyklen löschen (nur ohne Ergebnisse) in der Oberfläche;
   - Testfälle archivieren (ausgeblendet, wiederherstellbar);
   - Anhänge löschen;
   - Ordner umbenennen, verschieben und löschen.
5. **Felder, die der Admin definiert**: Text, Auswahl, Zahl, Datum, Benutzer; optional Pflichtfeld; an Testfall,
   Zyklus und Ausführung. Dazu **Priorität als Werteliste** mit Filter. Die migrierten Zephyr-Felder werden darauf
   abgebildet statt als JSON angezeigt.

**Priorität 2: Pflegeaufwand und Planung**

6. **Wiederverwendbare Vorbedingungen** und **aufrufbare Tests (Call Test)**, versioniert. Damit lassen sich
   Anmelden, Akte anlegen usw. zentral pflegen.
7. **Ad-hoc-Ausführung**: „Jetzt ausführen“ am Testfall, landet in einem Ad-hoc-Zyklus je Release.
8. **Schätzung**: geplanter Aufwand je Testfall bzw. Zyklus gegen die Ist-Dauer. Das ergibt Aufwand je Tester und
   eine Restaufwandsprognose im Cockpit.
9. **Weitere Importformate** (TestNG, NUnit, Robot, xUnit) und **Ergebnisimport in der Oberfläche** (Datei
   hochladen).
10. **Standardberichte ergänzen**:
    - Fortschritt je Tester;
    - Burn-down gegen geplantes Ende;
    - Top-Fehler mit betroffenen Anforderungen;
    - **Teststatusbericht** (Zwischenbericht);
    - **Excel-Export** von Matrix und Ausführungen;
    - Startseite mit zusätzlichen Kacheln (z. B. Burn-down eines gewählten Plans).
11. **Kommentare am Testfall** (Review-Anmerkungen je Version) und **Beobachten** mit Benachrichtigung.
12. **Testplan klonen** (ohne Ergebnisse).

**Priorität 3: nützlich, aber nicht dringend**

13. Datensatz am Zyklus überschreiben; kombinatorische (paarweise) Auswahl bei Datensätzen und Konfigurationen.
14. Historische Abdeckung (Abdeckung zum Stichtag).
15. CI-Läufe aus Anemo auslösen (GitLab-Pipeline per Knopf am Zyklus).
16. Fehler direkt in Jira anlegen. Das hat nur Bedeutung, solange Jira parallel läuft; Ziel ist OpenProject.
17. Ausführung auf Zuständige beschränken (Projekteinstellung).
18. KI-Testpriorisierung bzw. risikobasierte Auswahl (KI-Konzept Stufe 3).

**Bewusst nicht übernehmen:**
- **Tests als Ticket-Typen und Zyklen im Sprint-Board**: Anemo bleibt eigenständig, Verknüpfung erfolgt über
  OpenProject.
- **Gadget-Baukasten mit 60 Gadgets**: Eine anpassbare Startseite und ein gutes Cockpit genügen der Zielgruppe.
- **No-Code-Recorder** (Scale Cloud): Automatisierung läuft über Playwright bzw. Agenten (siehe
  [BDD-Beispiel](bdd-e2e-beispiel.md)).
- **Explorative Desktop-App mit Video**: Die Sitzungen im Browser mit Screenshots genügen.

## 4. Stufe H „Umstieg komfortabel machen“ (umgesetzt)
Die fünf Punkte der Priorität 1, erweitert um die Punkte der Priorität 2 und Teile der Priorität 3:

| Schritt | Inhalt |
|---|---|
| H1 | CSV/Excel-Import mit Vorschau und Spaltenzuordnung (Testfälle mit Schritten, Update per Schlüssel); Export von Testfällen, Ausführungen und Matrix als XLSX/CSV |
| H2 | Abfragesprache (Parser mit Hilfe und Autovervollständigung), nutzbar in Liste, Ansichten, dynamischen Testsets und der API |
| H3 | Massenbearbeitung von Ausführungen und erweiterte Massenbearbeitung von Testfällen |
| H4 | Löschen/Archivieren mit Rechteprüfung und Ereignisprotokoll; Ordnerverwaltung |
| H5 | Eigene Felder und Prioritäten (Admin, Editor, Filter, Berichte); Übernahme der migrierten Zephyr-Felder |
| H6 | Wiederverwendbare Vorbedingungen, aufrufbare Tests, Anhänge an Schritten, Diskussion, Datensatz je Plan/Zyklus, Kombinatorik |
| H7 | Jetzt ausführen (Ad-hoc), Schätzung mit Erfahrungswerten, Aufwand und Rest, Testplan kopieren |
| H8 | Weitere Ergebnisformate, Import in der Oberfläche, Fehler automatisch bei Fehlschlag |
| H9 | Auswertungen: Abdeckung im Verlauf/zum Stichtag, Top-Fehler, Team & Aufwand, Portfolio, PDF/Excel |
| H10 | Risikobasierte Testauswahl, optional mit KI |

Danach Priorität 2: zuerst wiederverwendbare Vorbedingungen und aufrufbare Tests sowie die Ad-hoc-Ausführung.
