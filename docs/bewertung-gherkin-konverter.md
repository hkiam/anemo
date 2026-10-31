# Bewertung: Konverter klassische Testfälle → Gherkin (BDD)

Die Frage: Ist eine Umwandlung klassischer Testfälle (Schritt / Testdaten / Erwartung) in Gherkin machbar und
sinnvoll, interaktiv, regelbasiert und/oder mit KI? Das Dokument bewertet nur; umgesetzt ist bisher die
regelbasierte Umwandlung als Vorschlag im Editor.

## 1. Ausgangslage

**Vorhanden in Anemo:**
- *Regelbasierte Umwandlung* `classicToGherkin`, als Vorschlag im Editor (speichert nichts):
  - Vorbedingungen werden zu `Angenommen`.
  - Jeder Schritt wird zu `Wenn <Aktion> (Testdaten: …)` / `Dann <Erwartung>`.
  - Hinweise erscheinen bei fehlender Erwartung oder bei mehreren Wenn/Dann-Blöcken.
- *Rückweg* Gherkin → klassisch.
- *Gherkin-Parser* mit Live-Prüfung, Git-Abgleich und Cucumber-Import.
- *Datensätze*: Szenariogrundriss/Beispiele werden als Durchläufe ausgeführt.
- *KI-Grundlagen*:
  - Skills mit JSON-Ausgabe und Prüfung, Projektkontext (Glossar/Stil), Kennzeichnung „mit KI erstellt“.
  - Ein On-Prem-Modell ist möglich.

**Typischer migrierter Testbestand** (Erfahrungswerte aus Jira/Zephyr-Beständen, qualitativ):

| Merkmal | Bedeutung für BDD |
|---|---|
| keine oder kaum Gherkin-Testfälle | Es gibt keine BDD-Vorlage im Bestand. |
| viele lange Testfälle (deutlich mehr als 15 Schritte) | Lange Ende-zu-Ende-Abläufe. Gutes BDD hat 3–7 Schritte und genau ein Verhalten je Szenario. |
| Erwartung fast immer gepflegt | Sehr gut: Jedes `Dann` hat eine fachliche Grundlage. |
| Testdaten bei einem großen Teil der Schritte | Gute Kandidaten für Szenariogrundriss und Beispiele. |
| mehrzeilige, zusammengesetzte Aktionen | Mechanisch umgewandelt entstehen überlange `Wenn`-Zeilen. |
| lange Aktionstexte (oft weit über 80 Zeichen) | Gherkin-Schritte sind typisch kürzer als 80 Zeichen. |
| Formulierungen auf Bedienebene („klicken“, „Menü“, „Dialog“ …) | Imperative UI-Skripte. Wörtlich übernommen entsteht das bekannte BDD-Anti-Muster. |
| Tabellen/Listen bzw. Bilder in Schritten | Brauchen Sonderbehandlung: Datentabelle bzw. Hinweis. |
| wiederkehrende, aber uneinheitliche Formulierungen | Ein Schrittvokabular ist nur teilweise vorhanden; Vereinheitlichung wäre nötig. |
| Vorbedingungen nur teilweise gepflegt | `Angenommen` muss oft aus dem Text erschlossen werden. |

Wie es im eigenen Bestand aussieht, lässt sich mit einfachen Auswertungen über die Testfallversionen ermitteln
(Schritte je Testfall, Anteil mit Erwartung/Testdaten, Länge der Aktionen, Wiederholungen).

## 2. Machbarkeit nach Stufe

| Stufe | Machbar? | Ergebnisqualität | Aufwand |
|---|---|---|---|
| **A. Syntaktisch** (heute vorhanden) | ja, 100 % gültig | Gültiges Gherkin, inhaltlich aber ein umformatiertes Klickskript: lange imperative Schritte, viele Wenn/Dann je Szenario. Kaum Mehrwert. | – |
| **B. Regelbasiert verbessert** | ja | Spürbar besser (siehe unten), bleibt aber wörtlich. | 2–3 Tage |
| **C. KI-gestützt mit Prüfung** | ja | Deklarativ formuliert, nach Verhalten in Szenarien aufgeteilt, Fachbegriffe aus dem Glossar. Qualität schwankt; jede Umwandlung braucht eine Durchsicht. | 4–6 Tage (+ 2–3 Tage Schrittvokabular) |
| **D. Vollautomatisch für den Bestand** | technisch ja | **Nicht empfohlen**: keine Durchsicht, Bedeutungsverlust nicht erkennbar, jeder umgewandelte Testfall erhält eine neue Version ohne fachliche Prüfung. Der Vier-Augen-Status entfällt für alle umgewandelten Testfälle. | – |

Mögliche Verbesserungen in Stufe B:
- zusammengesetzte Aktionen an Zeilen bzw. Aufzählungen in mehrere `Und`-Schritte teilen;
- Testdaten als Datentabelle oder `<Platzhalter>` mit Beispielen statt in Klammern;
- Vorbedingungen und gemeinsame Anfangsschritte mehrerer Testfälle als `Grundlage` (Background);
- Datensätze (Stufe G) direkt als Szenariogrundriss;
- eine Eignungsbewertung je Testfall (siehe 4.).

Was in Stufe C die KI leistet:
- Aufteilen in ein oder mehrere Szenarien;
- `Angenommen` aus Kontext und Vorbedingungen ableiten;
- deklarativ formulieren („Wenn die Akte abgeschlossen wird“ statt „Klicke auf …“);
- Platzhalter und Beispiele bilden;
- auf ein vorhandenes Schrittvokabular abbilden (bessere Automatisierbarkeit).

Technisch ist das gut beherrschbar:
- JSON-Ausgabe, Prüfung mit dem vorhandenen Parser;
- Abgleich, dass jede ursprüngliche Erwartung in einem `Dann` wiederkehrt;
- On-Prem-Modell für eingeschränkte Projekte.

Risiken der KI-Stufe:
- Die KI erfindet Erwartungen oder lässt Details weg (Testdaten, Sonderfälle).
- Ein deklarativer Text verliert die für manuelles Testen nötige Bedienführung.
- Kleinere On-Prem-Modelle formulieren im Deutschen schwächer.

Gegenmaßnahmen:
- Pflicht-Durchsicht mit Gegenüberstellung;
- automatischer Vollständigkeitsabgleich (Erwartungen, Testdaten, Bilder);
- Referenzset zur Messung (KI-Konzept, Stufe 4).

## 3. Ist es sinnvoll? Hängt vom Ziel ab

| Ziel | Nutzen der Umwandlung | Einschätzung |
|---|---|---|
| **Gemeinsame Sprache mit Fachbereich/Entwicklung** („lebende Dokumentation“) | hoch, aber nur deklarativ (Stufe C) und bei neuen bzw. fachlich stabilen Funktionen | sinnvoll für ausgewählte Testfälle |
| **Automatisierung** (Cucumber/Playwright, Git-Abgleich vorhanden) | hoch, wenn Schritte auf ein Vokabular mit Schrittdefinitionen passen; bei uneinheitlich formulierten Schritten muss vorher vereinheitlicht werden | sinnvoll für Automatisierungskandidaten, zusammen mit dem Vokabular |
| **Manuelle Ausführung** | gering bis negativ: klassische Schritte mit Bedienführung, Testdaten und Bildern sind für Tester oft besser lesbar | nicht umwandeln |
| **KI-Agenten** (MCP) | gering: Agenten können klassische Schritte bereits ausführen | kein Grund für eine Umwandlung |
| **Abnahme/Revision** | neutral: Berichte, Versionen und Rückverfolgbarkeit funktionieren mit beiden Formaten | kein Grund für eine Umwandlung |

**Fazit:**
- Ein Konverter ist **machbar**.
- **Sinnvoll** ist er als interaktiver, KI-gestützter Assistent für ausgewählte Testfälle.
- **Nicht sinnvoll** ist eine Massenumwandlung des Bestands. Gewachsene Bestände enthalten viele lange Ende-zu-Ende-Abläufe, die sich ohne fachliche Neugliederung nicht in gutes BDD überführen lassen.

## 4. Empfohlenes Vorgehen (falls gewünscht)

1. **Eignung bewerten** (regelbasiert, ohne KI) als Analyse in Test-Health. Kriterien:
   - höchstens 10 Schritte;
   - Erwartung in jedem Schritt;
   - geringer Anteil Bedienebene;
   - Datensatz bzw. Testdaten vorhanden;
   - Label „automatisierbar“.

   Ergebnis: eine Liste „BDD-Kandidaten“.
2. **Assistent im Editor** („✨ In Gherkin umwandeln …“, je Testfall oder kleine Auswahl):
   - Regelbasierter Vorschlag (Stufe B); KI wahlweise (Stufe C) mit Glossar und Schrittvokabular des Projekts.
   - Gegenüberstellung alt/neu; einzelne Szenarien übernehmen, ändern oder verwerfen.
   - Vollständigkeitsprüfung: Jede Erwartung muss in einem `Dann` wiederkehren, Testdaten erhalten bleiben, Bilder werden als Hinweis gemeldet.
   - Speichern als neue Version mit „mit KI erstellt“. Der Testfall geht in den Review (Vier-Augen-Prinzip).
   - Die Ausführungshistorie bleibt an der alten Version.
3. **Schrittvokabular** aus vorhandenen Gherkin-Testfällen bzw. `.feature`-Dateien im Git:
   - Die KI bevorzugt diese Formulierungen.
   - Grundlage für die Automatisierung.
4. **Erprobung mit etwa 50 Testfällen** aus einem freigegebenen Projekt. Erst danach über eine breitere Nutzung entscheiden. Messgrößen:
   - Übernahme ohne Änderung;
   - Änderungsaufwand je Testfall;
   - Durchsichtzeit;
   - Vollständigkeit.

Aufwand gesamt ca. 1,5–2 Wochen. Davon entfallen etwa 2–3 Tage auf die regelbasierte Stufe, die schon ohne KI nutzt.
Alternativ ließe sich nur Schritt 1 + Stufe B umsetzen (ca. 3–4 Tage), ohne KI-Abhängigkeit.
