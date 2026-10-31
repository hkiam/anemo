# Technisches, fachliches und UX-Review – 11.10.2026 (Teil 2)

Drei Review-Agenten haben Anemo nach Stufe G parallel geprüft:
- **technisch**: Nebenläufigkeit, Transaktionen, Rechte, Leistung, Testlücken;
- **fachlich**: Testmanagement nach ISTQB bzw. ISO/IEC/IEEE 29119, Begriffe, Freigabeprozess;
- **UX**: Aufgabenflüsse, Auffindbarkeit, Darstellung auf Laptop und Telefon.

Ergebnis: 18 technische (T), 20 fachliche (F) und 21 UX-Befunde (U), dazu Optimierungen und eine Begriffstabelle.
Dieses Dokument ordnet die Befunde nach Themen und hält den Stand der Umsetzung fest.

## 1. Kennzahlen und Freigabe (fachlich)
| Befund | Umsetzung |
|---|---|
| Bestehensquote zählte blockierte Tests als „nicht bestanden“ | Quote = bestanden ÷ (bestanden + fehlgeschlagen). Blockiert, ungültig und Durchführungsgrad werden getrennt ausgewiesen ✅ |
| „Aktueller Stand“ ignorierte Konfigurationen | Letztes Ergebnis je Testfall × Konfiguration, über Konfigurationen das schlechteste; ungeprüfte Agentenergebnisse zählen als offen ✅ |
| Keine Ausstiegskriterien | Ausstiegskriterien je Testplan (Quote, Durchführungsgrad, offene Fehler, Fehlschläge, Abdeckung, Änderungen), im Cockpit und Bericht mit Ziel/Ist ✅ |
| Empfehlung ≠ Entscheidung | Freigabeentscheidung (freigegeben / mit Auflagen / nicht freigegeben) mit Pflichtbegründung, Name, Zeit und Ereignis ✅ |
| Empfehlung „freigeben“ ohne Testbasis | Neue Stufe *keine Aussage möglich* bei fehlender Testbasis ✅ |
| Restrisiken fehlten | Restrisiken im Cockpit und Bericht, darunter bekannte, nicht behobene Fehler ✅ |
| „Bestanden mit Einschränkung“ uneinheitlich | Eigene Kategorie PASSED_WITH_ISSUES; migrierte Status zugeordnet ✅ |
| Rückverfolgbarkeit: ungültig galt als OK, veraltete Version als getestet | Ungültig ist nicht OK, ältere Versionen gelten als *nicht getestet*, abgelehnte Anforderungen werden gesondert gezeigt ✅ |
| Abschlussbericht unvollständig nach 29119-3 | Abschnitte Freigabeentscheidung, Testbasis, Ausstiegskriterien, Restrisiken, Abweichungen vom Testplan; „Abweichungen“ heißen jetzt „Fehlerwirkungen“ ✅ |

## 2. Ergebnisse und Nachvollziehbarkeit (fachlich und technisch)
| Befund | Umsetzung |
|---|---|
| Ergebnis-Korrekturen überschrieben die Historie | Tabelle `execution_result` mit jeder Änderung; *Verlauf der Ergebnisse* in der Durchführung ✅ |
| Gleichzeitiges Speichern überschrieb stillschweigend | Optimistische Sperre (`expectedUpdatedAt`, 409) und Zeilensperre ✅ |
| Gesamtergebnis widersprach Schritten bzw. Durchläufen | Ableitung serverseitig nach gemeinsamer Regel (`shared/status`); Abweichung nur mit Begründung ✅ |
| Fehlschlag ohne Nachweis | Nachweispflicht je Projekt (Standard an) ✅ |
| Zeitpunkt und Person änderten sich bei bloßem Kommentar | `executed_at/by` ändern sich nur mit dem Status ✅ |
| Menschliche Korrektur eines Agentenergebnisses unprotokolliert | Ereignis *ResultReviewed (overridden)* ✅ |
| Zyklus ließ sich nicht abschließen | Zyklusstatus geplant/aktiv/abgeschlossen; abgeschlossen sperrt Ergebnisse und Aufnahme ✅ |
| Nachtest im falschen Zyklus und doppelt | Nachtest im jüngsten offenen Zyklus gleichen Plans und gleicher Konfiguration, ohne Dubletten; nur bei *behoben*, nicht bei *abgelehnt* ✅ |
| Fehlerstatus nur offen/erledigt | Klassen offen / behoben / abgelehnt ✅ |
| Schrittergebnisse bei Durchläufen fehlten im Bericht und in der Fehlermeldung | Schrittergebnisse je Durchlauf in Bericht und KI-Fehlermeldung ✅ |
| Automatisierung übernahm Schrittergebnis des ersten Laufs | Schrittergebnisse aus dem schlechtesten Lauf ✅ |

## 3. Testfälle (fachlich)
| Befund | Umsetzung |
|---|---|
| Selbstfreigabe möglich | Vier-Augen-Prinzip: nicht freigeben, wer die aktuelle Version geschrieben hat ✅ |
| Freigabe galt versionsübergreifend | Freigabe an Version gebunden; neue Version → zurück in den Review ✅ |
| Entwürfe und veraltete Testfälle ungeprüft in Zyklen | *Veraltet* wird übersprungen, *Entwurf/Review* gemeldet ✅ |
| Datensatz schwer auffindbar | Unter den Schritten, Hinweis „parametrisiert · n Durchläufe“ ✅ |

## 4. Explorative Sitzungen (fachlich, technisch, UX)
| Befund | Umsetzung |
|---|---|
| Autospeichern überschrieb neuere Eingaben, Funde gingen bei parallelem Speichern verloren | Eigene, gesperrte Endpunkte für Beobachtungen; Revisionszähler im Editor ✅ |
| Abschluss ohne Zusammenfassung, Bearbeiten nach Abschluss | Zusammenfassung Pflicht, danach schreibgeschützt; Stopp ist idempotent ✅ |
| Keine Nachbesprechung (SBTM-Debrief) | Nachbesprechung mit Zeitanteilen (TBS = 100 %), Status *nachbesprochen* ✅ |
| Fehlerfunde ohne Ticket unsichtbar | Als Restrisiko im Cockpit und Bericht ✅ |
| Begriffe | Auftrag (Charter), Zeitrahmen (Timebox), Beobachtungen ✅ |

## 5. Technik
| Befund | Umsetzung |
|---|---|
| KI-Kontingent bei parallelen Aufrufen überschreitbar | Atomar per Advisory-Lock und Reservierung ✅ |
| Rechte zu weit: Verteilen, Agentenprüfung, KI-Zusammenfassungen | Erfordern *Pflegen* ✅ |
| Teure Zählungen in Testset-Liste, ein fehlerhafter Filter brach die Liste | Günstige Zählung, Fehler je Testset isoliert ✅ |
| Testsets: Name doppelt, ungültige Filter speicherbar | Prüfung beim Speichern ✅ |
| Ganzes Testset nur bis zur Listengrenze aufnehmbar | Serverseitig ohne Größengrenze ✅ |
| Verteilen nach Durchschnitt verzerrt | Median der Dauer, sonst Schätzung nach Schritten × Datenzeilen ✅ |
| Zeitmessung lief bei Inaktivität weiter | Leerlauf nach 5 Minuten ohne Eingabe zählt nicht ✅ |
| `fillParams` anfällig für Prototyp-Schlüssel | `Object.hasOwn` ✅ |
| Testlücken | Neue Tests: `review-rules`, `start`, erweiterte `stage-g`, `workflow` u. a.; E2E an neue Abläufe angepasst ✅ |

## 6. Oberfläche (UX)
| Befund | Umsetzung |
|---|---|
| Keine Startseite mit eigenen Aufgaben | **Startseite** mit Kennzahlen, *Meine Aufgaben* (▶ Weiter testen), Aufgaben der Testleitung, Releases, aktive Zyklen, Fehlschläge, Änderungen, Test-Health, Schnellzugriff; persönlich anpassbar; Logo führt dorthin ✅ |
| Statusauswahl je Schritt zu breit | Kompakt ✓ ✗ ⊘ plus „⋯“, zweiter Klick setzt zurück ✅ |
| Fehler zum Schritt umständlich | *🐞 Fehler zu Schritt n melden* am Schritt; speichert vorher ✅ |
| Hauptaktion im Zyklus unklar | *▶ Durchführen (n offen)* als Primäraktion ✅ |
| *Mir zugewiesen* ohne Startknopf, leerer Zustand ohne Hilfe | *▶ Durchführen*, hilfreicher Leerzustand ✅ |
| *🤖 Freigaben* missverständlich (Verwechslung mit Testfall-Freigabe) | *🤖 KI-Ergebnisprüfung* ✅ |
| Cockpit ohne Entscheidung, Kriterien, Risiken; KI-Entwurf erst nach zweitem Klick | Alles im Cockpit; Entwurf entsteht beim Öffnen ✅ |
| Zyklusformular: Plan anlegen in separatem Feld | Auswahl mit *+ Neuer Testplan …*, Release aus dem Plan ✅ |
| Kopfzeile der Testfälle überladen | Testsets und Git-Abgleich im Menü, Suche in eigener Zeile ✅ |
| Testsets vs. Ansichten unklar | Erklärung im Dialog, *In Zyklus aufnehmen…* direkt am Testset ✅ |
| Admin-Projekte: Spalten zu schmal, viele Knöpfe | Breitere Auswahlfelder, Nachweispflicht als Häkchen, Seltenes im ⋯-Menü ✅ |
| Einstellungen: „abschalten“ unauffällig | ⊘ abschalten ✅ |
| Telefon: Planungsnavigation verdeckt Inhalt | Einklappbar (☰ Pläne und Ansichten) ✅ |
| Doppeltes „Administrator Admin“ im Kopf | Abzeichen nur, wenn der Name es nicht schon sagt ✅ |
| Tastaturhilfe dauerhaft sichtbar | Einklappbar ✅ |
| Test-Health-Navigation zu lang | Beschreibung nur beim gewählten Eintrag, sonst Tooltip ✅ |
| Menüs „Ansichten“, „⋯ Mehr“, „Berichte“ öffneten hinter der linken Navigation | Menüs als schwebende Ebene, am Fensterrand ausgerichtet ✅ (Rückmeldung aus dem Testbetrieb) |
| Begriffe „Defect“, „Abweichungen“ | „Fehler“, „Fehlerwirkungen“ ✅ |

## 7. Bewusst zurückgestellt
- **Migrierte Statusnamen** wie „Outdated“ oder „Review!“: Das sind Daten aus Jira. Die Administration benennt sie
  unter *Status & Workflow* um oder führt sie zusammen.
- **Datumsfelder im Browserformat**: Die Anzeige folgt der Spracheinstellung des Browsers.
- **Beobachtung direkt als OpenProject-Fehler anlegen**: Derzeit gibt es *Text kopieren* und *→ Fehler verknüpfen*;
  direktes Anlegen folgt mit dem nächsten OpenProject-Ausbau.
- **Teststatusbericht (Zwischenbericht)** und **Schweregrad am Fehler**: in die Roadmap aufgenommen.

## 8. Prüfung
- Server: 188 Tests grün, gemeinsame Regeln: 25.
- E2E (Playwright): 119 Läufe auf Desktop, Laptop und Telefon grün, einschließlich Startseite, Cockpit-Freigabe,
  Sitzungen, Testsets und Layoutprüfung aller Ansichten.
