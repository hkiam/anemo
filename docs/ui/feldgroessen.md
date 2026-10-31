# Richtlinie: Feld- und Fenstergrößen (Roadmap A7)

Grundsatz: **Die Größe eines Feldes richtet sich nach dem typischen Umfang seines Inhalts.** Ein ausführlicher
Befund passt nicht in zwei Zeilen. Alle mehrzeiligen Felder wachsen mit dem Inhalt (bis 70 % der Fensterhöhe),
lassen sich mit der Maus vergrößern und behalten ihre Höhe beim Umschalten (kein Springen).

| Feld | Editor | Mindesthöhe | Begründung |
|---|---|---|---|
| Befund / Kommentar zur Ausführung | WYSIWYG + Anhänge | 8 Zeilen | Beobachtung, Ist-/Soll, Umgebung, Screenshots |
| Befund in der Massenbearbeitung (Ergebnis für mehrere setzen) | WYSIWYG (ohne Anhänge – gilt für alle gewählten) | 8 Zeilen | gleicher Text für viele Ausführungen; Screenshots je Ausführung in der Durchführung |
| Befund beim Schnellstatus ✗/⊘ in Listen | Text (Rückfrage) | 5 Zeilen | kurzer Nachweis; für ausführliche Befunde mit Screenshot die Durchführung öffnen |
| Kommentar je Schritt (Durchführung) | WYSIWYG kompakt + Anhänge | 3 Zeilen | Abweichung des Schritts, oft mit Screenshot |
| Ziel / Beschreibung (Testfall) | WYSIWYG + Anhänge | 6 Zeilen | Kontext, Abgrenzung, oft Panels/Listen |
| Vorbedingungen | WYSIWYG + Anhänge | 4 Zeilen | Datenstand, Rechte, Konfiguration |
| Testdaten (Testfall) | WYSIWYG + Anhänge | 3 Zeilen | Werte, Dateien |
| Aktion / Erwartetes Ergebnis (Schritt) | WYSIWYG kompakt | 3 Zeilen | Breite Spalten (je 38 %), Testdaten 22 % |
| Gherkin | Monospace | 16 Zeilen, wächst bis 40 | Szenarien mit Beispielen |
| Testumfang / Hinweise (Zyklus) | WYSIWYG | 4 Zeilen | Ziel und Schwerpunkte des Laufs |
| Lagebild (Zwischenbericht, Cockpit) | WYSIWYG | 8 Zeilen | Einschätzung, Hindernisse, nächste Schritte – erscheint im Teststatusbericht |
| Fazit des Testmanagements (Cockpit) | WYSIWYG | 14 Zeilen | Bewertung, Restrisiken, Empfehlung – erscheint im Testabschlussbericht |
| Fehlerbeschreibung („Fehler melden“) | WYSIWYG | 14 Zeilen | Vorlage mit Schritten, Ist/Soll, Umgebung |
| Begründung der Freigabeentscheidung | Text | 5 Zeilen | Auflagen, akzeptierte Restrisiken |
| Anmerkung / Antwort (Diskussion) | Text | 3 Zeilen | Rückfrage oder Hinweis; @name benachrichtigt |
| Beschreibungen in der Administration | Text | 3 Zeilen | kurze Erläuterung |
| Änderungsnotiz | einzeilig, volle Breite | – | ein Satz |
| Defect-Schlüssel, Namen, Codes | einzeilig | – | kurze Werte |

Fenster: Bearbeitungsdialoge für Testfälle sind „groß“ (feste Höhe, Inhalt scrollt). Die Durchführung lässt sich
breit schalten (⇤), dann ist die Zyklusliste schmal. Werkzeugleisten kompakter Felder erscheinen schwebend und
verschieben keine Tabellenzeilen. Neue Felder halten sich an diese Tabelle. Abweichungen werden hier ergänzt.

Dialoge: genau ein Primärknopf, rechts außen; links daneben „Abbrechen“. Nebenaktionen (KI, Kopieren, Zurücknehmen,
Entfernen) stehen links in der Fußzeile, im Inhalt gibt es keine weiteren Primärknöpfe. Deaktivierte Knöpfe nennen
den Grund (Tooltip bzw. Text daneben). Dialoge mit längeren Eingaben (Fazit, Lagebild, Fehlermeldung, Baustein,
Risikoauswahl, Diskussion) fragen beim Schließen nach, wenn Eingaben verloren gingen.
