# Anemo – Roadmap

Abgeleitet aus einem vollständig migrierten Jira/Zephyr-Bestand (Testfälle, Zyklen, Ausführungen, Schrittergebnisse
und Zephyr-Änderungshistorie), den Arbeitsweisen darin und den Anforderungen des Product Owners.
**Reihenfolge = Umsetzungsreihenfolge.** ✅ = umgesetzt, ▶ = in Arbeit.

## Stufe A – Fundament für den Produktivbetrieb

| # | Thema | Inhalt | Warum jetzt |
|---|---|---|---|
| A1 | ✅ **Layout & Ruhe in der Oberfläche** | Navigator links ohne Höhenwachstum, Planansicht ohne gestreckte Spalten, Editor ohne springende Höhe beim Wechsel Klassisch/Gherkin | Tägliche Nutzung; schnell |
| A2 | ✅ **Administrationsbereich** | Eigener Bereich: Migration, Ereignisse, Testkonfigurationen, Status & Workflow, Nutzer/Gruppen/Rechte, Integrationen – raus aus der allgemeinen Navigation | Ordnung; Platz für A3–A5 |
| A3 | ✅ **Authentifizierung, Nutzer, Gruppen, Rollen, Rechte** | Anmeldung (lokal, später OIDC/LDAP), Rollen je Projekt (Lesen / Ausführen / Pflegen / Projektadmin) + Systemadmin, Gruppen, Sitzungen, Audit „wer hat was getan“ | Voraussetzung für Integrationen (Fehler im Namen einer Person melden) und für Projekte mit besonderem Schutzbedarf (z. B. Behörden) |
| A4 | ✅ **Status & Workflow konfigurierbar** (ADR-0013) | Ausführungsstatus und Schrittstatus (Name, Farbe, „gilt als bestanden/fehlgeschlagen/offen“), Testfall-Workflow (Entwurf → Review → Freigegeben → Veraltet) mit erlaubten Übergängen | Migrierte Status (z. B. „BESTANDEN MIT MANGEL“, Jira-Workflow „Spezifikation/Review!“) müssen pflegbar sein |
| A6 | ✅ **WYSIWYG-Bearbeitung und Anhänge überall** (ADR-0012) | Visueller Editor in allen Textfeldern, wo sinnvoll (Beschreibung, Vorbedingungen, Schritte, Erwartung, Kommentare); Speicherformat bleibt Jira-Wiki-Markup (Bestand bleibt gültig). Anhänge per Einfügen aus der Zwischenablage (Screenshots), Drag & Drop und Dateiauswahl – direkt in den Text eingebettet, in der Testfallbeschreibung **und** bei der Durchführung je Schritt/Ergebnis. Alle Feld- und Fenstergrößen prüfen und vereinheitlichen | Tägliche Arbeit; heute unvollständig |
| A7 | ✅ **Textfeldgrößen nach erwartetem Inhalt** ([Richtlinie](ui/feldgroessen.md)) | Jedes Eingabefeld (Kommentare, Befunde, Beschreibungen, Schritte, Notizen) systematisch prüfen: Breite und Höhe passend zum typischen Umfang – ein ausführlicher Befund braucht Platz statt zwei Zeilen. Mindesthöhe je Feldart, mitwachsende Felder, vom Benutzer vergrößerbar, breite Ansicht für Durchführung | Tägliche Arbeit; Befunde werden sonst knapp oder unleserlich |
| A5 | ✅ **Sensibilität je Projekt** (ADR-0014) | Sichtbarkeit nur für Mitglieder, Zugriffsprotokoll, keine Inhalte an externe Dienste | Projekte mit besonderem Schutzbedarf (z. B. Behörden) |

## Stufe B – Integrationen

| # | Thema | Inhalt |
|---|---|---|
| B1 | ✅ **OpenProject – bidirektionale Verknüpfung** (ADR-0015, [Anleitung](openproject.md); gegen lokale OpenProject-17.8-Instanz getestet) | Testfälle, Testpläne und Zyklen mit Arbeitspaketen verknüpfen (Suche im Dialog); im Arbeitspaket erscheint ein Rück-Link zu Anemo; Status/Titel werden aktualisiert; Navigation in beide Richtungen |
| B2 | ✅ **Fehlermeldung an die Entwicklung** (Vorlagen, Anlage in OpenProject, automatischer Nachtest) | Aus fehlgeschlagener Ausführung/Schritt ein Arbeitspaket anlegen – mit Vorlagen (Titel, Beschreibung aus Schritten, Erwartung/Ist, Umgebung/Konfiguration, Build, Evidenzen als Anhang), Zuweisung, Version; Rückverknüpfung; wird das Arbeitspaket gelöst, entsteht automatisch eine **Nachtest-Aufgabe** im passenden Zyklus |
| B3 | ✅ **Jira-Adapter (live)** (nur lesend: Titel/Status verknüpfter Tickets, alle 6 h) | Für den Parallelbetrieb bis zur Umstellung; gleiche Schnittstelle wie OpenProject (ADR-0005) |
| B4 | ✅ **GitLab / Git** (.feature-Abgleich, MR/Commit-Verknüpfung, Pipeline-Ergebnisse; ADR-0017/0022) | Gherkin-Testfälle ↔ `.feature`-Dateien im Repository (Export/Abgleich), Verknüpfung Testfall ↔ Commit/Merge-Request, Pipeline-Ergebnisse (JUnit/Cucumber) als Ausführungen importieren |
| B5 | ✅ **LDAP / OIDC** (Keycloak, Entra ID, AD/OpenLDAP; ADR-0021, [Anleitung](anmeldung-sso.md)) | Anmeldung über Unternehmensverzeichnis, Gruppen aus LDAP übernehmen |
| B6 | ✅ **Webhooks/Benachrichtigungen** (ADR-0019, E-Mail ADR-0020) | aus dem Event-Log (Mail/Teams bei neuem FAIL in einem Release-Zyklus, Nachtest fällig) |

## Stufe C – Nachweise und Auslieferung

| # | Thema | Inhalt |
|---|---|---|
| C1 | ✅ **Testprotokolle nach Standard** (ADR-0016) | Anpassbare Protokolle in Anlehnung an **ISO/IEC/IEEE 29119-3** (Testprotokoll/Test Log, Testabschlussbericht/Test Completion Report, Testfallspezifikation) – Vorlagen, Firmenlayout, Ausgabe als PDF/HTML/Markdown/JSON |
| C2 | ✅ **Auslieferungsartefakt** (ADR-0016) | Signierbares Paket je Release: Bericht + maschinenlesbare Ergebnisse + Evidenzen + Prüfsummen, für Kunden/Abnahme |
| C3 | ✅ **Release-Cockpit** | Fortschritt, offene Fehler mit Live-Status, Trend, Risiko „geändert, aber nicht getestet“, Freigabeempfehlung mit Begründung |

## Stufe D – Automatisierung und Agenten

| # | Thema | Inhalt |
|---|---|---|
| D1 | ✅ **Testautomation anbinden** (JUnit/Cucumber-Import, API-Tokens, ADR-0017; Testarten aus Zephyr als Filter) | Automationsbezüge aus migrierten Tests strukturieren (z. B. Jenkins), Testfall ↔ automatisierter Test, Ergebnisse automatisch in Zyklen |
| D2 | ✅ **MCP-Server** (ADR-0018, [Anleitung](mcp.md)) | `search`, `get_test_case`, `get_cycle_results`, `create_cycle`, `record_result`, `create_defect`, `find_tests_for_issue` – Claude, Codex oder eigene Agenten arbeiten direkt mit Anemo |
| D3 | ✅ **Agentische Abarbeitung** (QA-Freigabe, Eskalation, ADR-0024, [Anleitung](agenten.md)) | Agenten führen geeignete Tests aus (z. B. über Playwright), dokumentieren Ergebnisse mit Evidenzen, eskalieren Unklares an Menschen; Freigabe durch QA |
| D4 | ✅ **KI-Unterstützung** (regelbasiert + optionales Modell, ADR-0023, [Anleitung](ki-assistenz.md)) | Ähnlichkeitssuche (Duplikate), Gherkin-Vorschläge, Anforderungsabdeckung, Fehlerursachen-Cluster – on-prem bzw. freigegebenes Modell |

## Stufe E – Qualität des Testbestands (regelbasiert)

- ✅ **Test-Health-Dashboard** (*Test-Health* je Projekt, Label-Vergabe als Brücke in die Pflege): nie/lange nicht ausgeführt, wackelnde Tests, immer bestanden (Automatisierungskandidat), häufig blockiert, kein überprüfbares Ergebnis, „INVALID“/„BESTANDEN MIT MANGEL“ als Pflege-Warteschlange.
- ✅ (regelbasiert, Titelgleichheit/„(alt)“) **Duplikate und Altlasten** („(alt)“-Tests, Nachfolger) erkennen und verknüpfen.
- ✅ **Manuelle Änderungstabellen** in Beschreibungen (Bearbeiter/Datum/Grund) als dokumentierte Änderungen ausgewiesen (Text bleibt unverändert).

## Stufe F – Planung & Ausführung weiter ausbauen

- ✅ Zyklus wiederholen (neuer Build, Nachtest nur Probleme, je Konfiguration ein Zyklus, Zuständige bleiben). ✅ Verteilung nach Auslastung.
- ✅ Schnelle Ausführung per Tastatur (j/k, p/f/b/n, c, Strg+S), ✅ Screenshot per Einfügen als Evidenz am Schritt.
- ✅ Vergleich zweier Zyklen/Builds (Regression, behoben, weiterhin fehlerhaft). ✅ Gespeicherte Ansichten (privat/geteilt).

## Frage: Versionierung der Testfälle – Git?

Testfälle sind in Anemo bereits **vollständig versioniert** (unveränderliche Versionen, ADR-0004; Historie aus
Zephyr/Jira rekonstruiert). Git ist kein guter Speicher für manuelle Tests (Anhänge, Ausführungsbezug, Rechte).
Sinnvoll ist Git dort, wo Code entsteht: **Gherkin-Features und automatisierte Tests** werden mit Git abgeglichen
(B4), jede Ausführung verweist auf die Testfallversion *und* – bei Automation – auf den Commit.

## Erledigt

- ✅ Verlustfreie Migration Jira/Zephyr (alle Projekte, globaler Abgleich Zephyr ↔ Anemo ohne Differenz)
- ✅ Versionsrekonstruktion aus der Historie
- ✅ Planung & Ausführung für große Datenmengen, übergreifende Suche
- ✅ Testkonfigurationen (ADR-0010)
- ✅ Jira-Wiki-Darstellung mit eingebetteten Bildern
- ✅ UX-Überarbeitung mit Fokusfenstern ([UX-Review](ux/review-2026-10-11.md))
- ✅ Härtung: Playwright-E2E (Desktop/Laptop/Telefon), Sicherheitsreview (Bericht intern), Lasttest ([Bericht](performance/lasttest-2026-10-11.md))
- ✅ Einstellungen und KI-Administration in der Oberfläche (ADR-0025), [KI-Konzept](ki-konzept.md), [BDD-Beispiel](bdd-e2e-beispiel.md)
- ✅ Technisches, fachliches und UX-Review nach Stufe G mit Umsetzung ([Bericht](reviews/review-2026-10-11-teil2.md)): Kennzahlen nach ISTQB, Ausstiegskriterien, Freigabeentscheidung, Vier-Augen-Freigabe, Ergebnisverlauf, Zyklusabschluss, Sitzungs-Nachbesprechung, persönliche Startseite

## Stufe G: Ideen aus Xray und KI-Arbeitshilfen ✅ (11.10.2026)
Siehe [Vergleich mit Xray](vergleich-xray.md) und [KI-Konzept](ki-konzept.md), Abschnitt 6:
- ✅ G1 Parametrisierte Tests mit Datensätzen und Durchläufen (auch aus Gherkin-Beispielen)
- ✅ G2 Explorative Testsitzungen (Charter, Timebox, Zeitnahme, Protokoll, Funde → Fehler/Testfall, im Testprotokoll)
- ✅ G3 Anforderungsabdeckung je Release: Rückverfolgbarkeitsbericht, Kacheln im Cockpit, Teil des Lieferpakets
- ✅ G4 Testsets (fest/dynamisch), Dauer je Ausführung, Verteilen nach Erfahrungswert
- ✅ G5 KI-Skills „Testfall prüfen“, „Fehlermeldung formulieren“, „Fazit“; Modellprofile, Projektkontext, Kennzeichnung „mit KI erstellt“

Noch offen aus dem Vergleich (Priorität 2–3): Fehler je Schritt, Abdeckungsstatus im OpenProject-Ticket
(Vorbedingungen, modulare Tests, Kombinatorik und Importformate folgten mit Stufe H).

Noch offen aus dem Review (Teil 2): Teststatusbericht (Zwischenbericht), Schweregrad am Fehler, Beobachtung aus
Sitzungen direkt als OpenProject-Fehler anlegen.

## Stufe H ✅: Umstieg komfortabel machen
Aus dem [Funktionsabgleich mit Zephyr und Xray](vergleich-zephyr-xray.md), Priorität 1–2 und Teile von 3:
- ✅ H1 CSV/Excel-Import mit Spaltenzuordnung, Zephyr-/Xray-Vorlagen, Probelauf, Aktualisieren per Schlüssel; Export von
  Testfällen, Ausführungen und Matrix (XLSX/CSV); Berichte als PDF
- ✅ H2 Abfragesprache für Testfälle und Ausführungen (Liste, Ausführungssuche, Ansichten, dynamische Testsets, API)
- ✅ H3 Massenbearbeitung von Ausführungen und Testfällen; Schnellausführung aus der Liste
- ✅ H4 Archivieren/Löschen von Testfällen und Zyklen, Ordner umbenennen/verschieben/löschen, Projekt umbenennen/löschen
- ✅ H5 Eigene Felder (Testfall, Zyklus, Ausführung) mit Auswahllisten und Abgleich aus Jira/OpenProject; Prioritäten als Werteliste
- ✅ H6 Wiederverwendbare Vorbedingungen, aufrufbare Tests, Anhänge an Schritten, Diskussion mit Erwähnungen,
  Datensatz je Plan/Zyklus, alle Kombinationen bzw. paarweise für Datensätze und Konfigurationen
- ✅ H7 Jetzt ausführen (Ad-hoc-Zyklus), Schätzung mit Erfahrungswerten, geplanter Aufwand und Rest, Testplan kopieren
- ✅ H8 Ergebnisformate TestNG, NUnit, xUnit.net, MSTest/TRX, Robot, Behave, Playwright, Jest; Import in der Oberfläche,
  nachträgliche Zuordnung, Fehler automatisch bei Fehlschlag
- ✅ H9 Abdeckung im Verlauf und zum Stichtag, Top-Fehler, Team & Aufwand, Portfolio, neue Startseiten-Kacheln
- ✅ H10 Risikobasierte Testauswahl (nachvollziehbarer Risikowert, Budget, Änderungsumfang, optional KI mit Begründung)

## Stufe I ✅: Restliches Backlog
Aus Roadmap, Review und Funktionsabgleich:
- ✅ I1 Teststatusbericht (Zwischenbericht nach ISO/IEC/IEEE 29119-3) mit Berichtszeitraum, Lagebild, neuen Fehlern und
  Fehlschlägen; Burn-down gegen das geplante Ende mit Prognose (Cockpit, Bericht als HTML/PDF/Markdown)
- ✅ I2 Beobachten von Testfällen, Zyklen und Testplänen mit E-Mail (Sammelmail), Liste im Kontomenü
- ✅ I3 Schrittbibliothek (Bausteine als Kopie einfügen, Verwendung sichtbar)
- ✅ I4 Unstrukturierter Test (Freitext statt Schritten), auch in Suche, Abfragesprache, Import/Export und Berichten
- ✅ I5 Fehler je Schritt und Schweregrad am Fehler; Funde aus explorativen Sitzungen direkt als Fehler anlegen
- ✅ I6 Projektregel „Ausführung nur durch Zuständige“ (Testleitung ausgenommen)
- ✅ I7 Offline-/Excel-Rundlauf mit Probelauf und Konflikterkennung
- ✅ I8 CI-Pipelines (GitLab) aus dem Zyklus starten; Ergebnisse kommen über die Automatisierungs-API zurück
- ✅ I9 Abdeckungsstatus als Kommentar im OpenProject-Ticket (nur bei Änderung, je Projekt einschaltbar)
- ✅ I10 Fehler direkt in Jira anlegen (Parallelbetrieb; ausdrücklich einzuschalten, OpenProject hat Vorrang)
- ✅ Härtung nebenbei: Webhooks prüfen die Sperre externer Dienste für alle Ereignisarten; Jira-Zugang aus der Oberfläche
  (Token bzw. Benutzer/Passwort) wird ausgewertet; Benachrichtigung „Erwähnung“ ließ sich nicht abonnieren (behoben);
  OpenProject-Zuordnung als Übersicht mit Auswahl, Verknüpfen per Nummer auch ohne Zuordnung

Bewusst nicht übernommen: Tests als Ticket-Typen/Zyklen im Sprint-Board, Gadget-Baukasten, No-Code-Recorder,
explorative Desktop-App mit Video, Confluence-Anbindung.

## Stufe K ✅: Projekte übertragen (Projektpaket)
Projekt komplett oder selektiv exportieren und als neues oder in ein bestehendes Projekt importieren; Konzept:
[projekt-export-import.md](projekt-export-import.md), [ADR-0027](adr/0027-projektpaket-export-import.md).
- ✅ K1 Recht „Projekte übertragen“ (Vergabe unter Benutzer/Gruppen), Paketformat, ZIP64 (Schreiber und Leser), kompletter Export mit Freigabe bei sensiblen Projekten
- ✅ K2 Import als neues Projekt (ID-Übersetzung, Schlüssel, Personen/Kataloge, Probelauf), Rundlauftest
- ✅ K3 Selektiver Export mit Abhängigkeitsschluss, Optionen, Pseudonymisierung
- ✅ K4 Import in bestehendes Projekt, alles inkl. Ausführungen (Herkunft, Aktualisieren statt Dubletten, Konflikte)
- ✅ K5 Oberfläche, Hintergrundauftrag, MCP, CLI, Handbuch, E2E

## Ideen (zurückgestellt)
- **Assistent klassisch → Gherkin (BDD)**: machbar, sinnvoll nur interaktiv für ausgewählte Testfälle (Eignungsbewertung,
  regelbasierter Vorschlag, optional KI mit Glossar/Schrittvokabular, Gegenüberstellung, Vollständigkeitsprüfung, Erprobung mit
  50 Testfällen). Keine Massenumwandlung. Bewertung: [bewertung-gherkin-konverter.md](bewertung-gherkin-konverter.md)
