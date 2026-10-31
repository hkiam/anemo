# Auswertung & Berichte

## Release-Cockpit
Testplan wählen → Tab **Release-Cockpit**:
- **Freigabeentscheidung**: *Freigabe entscheiden…* hält fest, ob freigegeben, mit Auflagen oder nicht
  freigegeben wird – mit Begründung (Pflicht), Name und Zeitpunkt. Sie erscheint im Testabschlussbericht und im
  Lieferpaket und lässt sich ändern oder zurücknehmen.
- **Freigabestand**: Zu jeder Entscheidung legt Anemo das Lieferpaket so auf dem Server ab, wie es im Moment der
  Entscheidung war, und hält seine Prüfsumme (SHA-256) im Protokoll fest. **⇩ Lieferpaket zur Entscheidung** lädt
  genau diesen Stand – auch Monate später, wenn sich Ergebnisse, Kriterien oder Statuskategorien inzwischen geändert
  haben. Ändert sich nach der Entscheidung etwas am Plan, seinen Zyklen oder Ausführungen, zeigen Cockpit und
  Abschlussbericht **„Nach der Entscheidung geändert: n Änderungen“** – bei wesentlichen Änderungen neu entscheiden.
- **Freigabeempfehlung** mit Begründung (regelbasiert, Grundlage für die Entscheidung): *nicht empfohlen* bei
  aktuell fehlgeschlagenen/blockierten Tests oder verfehlten Ausstiegskriterien; *keine Aussage möglich*, wenn
  nichts bzw. nichts erfolgreich getestet ist; *unter Vorbehalt* bei offenen Tests, offenen Fehlern, Restrisiken
  oder ungeprüften Agentenergebnissen.
- **Ausstiegskriterien** je Testplan: Bestehensquote, Durchführungsgrad, höchstens n offene Fehler bzw.
  fehlgeschlagene Testfälle, höchstens n bekannte Fehler, alle Anforderungen bestanden, keine ungetesteten
  Änderungen. Das Cockpit zeigt Ziel, Ist und ✓/✗.
- **Behoben, aber nicht nachgetestet**: Testfälle, deren verknüpfter Fehler laut Ticket behoben ist, die aber noch
  nicht wieder bestanden haben. Fehlt der Nachtest, gibt es keinen offenen Zyklus mit gleicher Konfiguration – dann
  einen anlegen bzw. wieder öffnen. Die Liste steht auch im Abschlussbericht und in der Begründung der Empfehlung.
- **Bekannte Fehler**: Ergebnis „Fehlgeschlagen (bekannt)“ – der Fehler ist dokumentiert (Ticket verknüpft oder
  Befund beschrieben, sonst lässt sich das Ergebnis nicht speichern). Er blockiert die Freigabeempfehlung nicht,
  steht aber im Cockpit in einer eigenen Liste und im Abschlussbericht als Restrisiko.
- **Stand je Konfiguration**: Läuft ein Plan auf mehreren Konfigurationen (z. B. Gerät iPad und iPhone), zeigt das
  Cockpit Ergebnisse und Bestehensquote je Konfiguration und eine Matrix der Testfälle, die irgendwo fehlschlagen
  (leere Zelle: dort nicht eingeplant).
- **Restrisiken**: Anforderungen ohne oder ohne vollständigen Test, ungetestete Änderungen, bekannte nicht
  behobene Fehler (abgelehnt/zurückgestellt), „bestanden mit Einschränkung“, Fehlerfunde aus Sitzungen ohne Ticket,
  mit ungeprüfter Spezifikation ausgeführte Tests.
- Kennzahlen: Testfälle, **Bestehensquote** (bestanden ÷ (bestanden + fehlgeschlagen); blockierte zählen nicht
  hinein, sondern getrennt; *ungültig* und *nicht anwendbar* zählen weder hier noch im Durchführungsgrad), fehlgeschlagen/blockiert, offen, offene Fehler, „geändert, aber nicht erneut
  getestet“. Maßgeblich ist der **aktuelle Stand je Testfall und Konfiguration** (letztes Ergebnis zählt; über
  Konfigurationen das schlechteste).
- **Verlauf**: ausgeführte Tests je Tag, gestapelt nach Ergebnis, plus kumulierte Linie.
- **Burn-down gegen geplantes Ende**: offene Ausführungen je Tag (Linie), gestrichelte **Ideallinie** vom Beginn bis
  zum geplanten Ende und eine senkrechte Linie am **geplanten Ende**. Beginn ist der früheste Zyklusbeginn, Ende das
  späteste Zyklusende der (nicht archivierten) Zyklen des Plans. Darunter ein Satz zum Stand, z. B. „12 offen ·
  Tempo 3,5 je Tag · Prognose fertig am 14.10. – im Plan“ bzw. „– 2 Arbeitstage nach Plan“. Das **Tempo** ist das
  Mittel der erledigten Ausführungen an den letzten 10 Tagen mit Aktivität; die **Prognose** schreibt den Rest mit
  diesem Tempo über Arbeitstage (Montag bis Freitag) fort. Ohne Fortschritt gibt es keine Prognose; haben die Zyklen
  kein Enddatum, fehlen Ideallinie und Planvergleich (Hinweis im Diagramm).
- **Lagebild (Zwischenbericht)**: Einschätzung, Hindernisse und nächste Schritte der Testleitung als Freitext.
  **✎ Lagebild schreiben** bzw. **✎ Bearbeiten** (Rolle *Pflegen*); gespeichert mit Datum und Namen, ein leeres Feld
  entfernt es. Darunter **Teststatusbericht öffnen** mit Berichtszeitraum (*letzte 7 Tage*, *letzte 14 Tage*,
  *letzte 30 Tage* oder *seit Datum …*) als **HTML**, **PDF** oder **MD**.
- Zyklen mit Fortschritt, offene Fehler mit Ticketstatus, aktuelle Probleme, Testfälle mit neuerer Version als der
  getesteten.
- **Aufwand**: Summe der gemessenen Bearbeitungszeit.
- **Abdeckung der Anforderungen**: abgedeckt und bestanden, mit Fehlern, nicht (vollständig) getestet, ohne
  Testfall. **Rückverfolgbarkeit öffnen** zeigt den Bericht.
- **Abdeckung der Anforderungen im Verlauf**: dieselben vier Gruppen je Woche (letzte 12 Wochen), gestapelt.
  **Rückverfolgbarkeit zum Stichtag**: Datum wählen, dann **Bericht zum Stichtag**. Der Bericht zeigt die Ergebnisse
  laut Ergebnisverlauf bis zu diesem Tag; später angelegte Ausführungen fehlen, Verknüpfungen von Anforderungen
  gelten mit dem heutigen Stand.
- **Team & Aufwand**: je zuständiger Person Fortschritt (erledigt/gesamt), offen, Probleme, erfasste Zeit und
  geplant/Rest laut Schätzung. **⇩ Excel** enthält zusätzlich die Auswertung je Tester und je Zyklus.
- **Top-Fehler**: verknüpfte Fehler nach Auswirkung (betroffene Testfälle und Anforderungen), offene zuerst, mit Stand
  *offen*, *behoben* oder *abgelehnt*. **⇩ Excel** exportiert die Liste.
- **Fazit des Testmanagements**: Bewertung, Restrisiken, Empfehlung. Ohne vorhandenes Fazit entsteht beim Öffnen
  direkt ein KI-Entwurf aus Kennzahlen, Kriterien, Restrisiken und Fehlern; **✨ Neu entwerfen** erzeugt einen neuen. Gespeichert erscheint das Fazit im
  Testabschlussbericht und im Lieferpaket – mit **Verfasser, Zeitpunkt** und, wenn es auf einem KI-Entwurf beruht,
  dem Vermerk **„mit KI erstellt“** samt Modell. Jede Fassung steht vollständig im Protokoll.

## Teststatusbericht (Zwischenbericht)
Der Teststatusbericht („Test Status Report“ nach ISO/IEC/IEEE 29119-3) berichtet während des Testens über einen
**Berichtszeitraum**. Öffnen: im Release-Cockpit unter *Lagebild (Zwischenbericht)* mit frei wählbarem Zeitraum, oder
im Testplan über **📄 Berichte → Teststatusbericht (Zwischenbericht)** (letzte 7 Tage). Inhalt:
- **Lage**: Freigabeempfehlung aus heutiger Sicht, Stand des Burn-downs mit Prognose und das **Lagebild des
  Testmanagements** (mit Name und Datum);
- **Fortschritt gegen Plan**: Burn-down-Grafik mit Ideallinie und geplantem Ende;
- **Im Berichtszeitraum**: erfasste Ergebnisse, bestanden, fehlgeschlagen/blockiert, neue Fehler, Ergebnisse je
  Person, **Neue Fehlschläge** und **Neue Fehler** (erstmals im Zeitraum mit dem Testplan verknüpft);
- **Gesamtstand je Testfall**, **Ausstiegskriterien (Zwischenstand)**, **Risiken und Hindernisse** und **Aktuell
  fehlgeschlagen/blockiert**.

Erscheinungsbild und Abschnitte richten sich nach dem Berichtsprofil wie bei den übrigen Berichten.

## Ergebnis-Matrix
Testfälle (Zeilen) × Zyklen bzw. Konfigurationen (Spalten). „Nur Probleme“ blendet Unauffälliges aus. **⇩ Excel** bzw.
**⇩ CSV** exportiert die ganze Matrix (bis 200 Zyklen).

## Startseite: Top-Fehler und Team & Aufwand
Zwei Kacheln der Startseite (einblenden über **⚙ Anpassen**, siehe [Erste Schritte](01-erste-schritte.md)):
- **Top-Fehler**: Fehler mit den meisten betroffenen Testfällen der letzten 90 Tage; **⇩ Excel (alle)**.
- **Team & Aufwand** (nur mit Rolle *Pflegen*): Fortschritt und Aufwand je Person in den aktiven Zyklen;
  **⇩ Excel (inkl. je Tester und Zyklus)**.

Für die Testleitung sind beide Kacheln standardmäßig sichtbar; für Testende ist *Top-Fehler* zunächst ausgeblendet.

## Portfolio
**Portfolio** in der Kopfzeile (sichtbar ab zwei Projekten) zeigt alle Projekte, die Sie sehen dürfen:
Testfälle, aktive Zyklen, offene Ausführungen, ausgeführt und Bestehensquote der letzten 30 Tage, offene Fehler, das
jüngste Release mit Freigabeentscheidung (*freigegeben*, *mit Auflagen*, *nicht freigegeben*) und die letzte
Aktivität. Darüber Summen für alle Projekte. Ein Klick öffnet die Startseite des Projekts; **⇩ Excel** exportiert die
Übersicht. Eingeschränkte Projekte tragen 🔒.

## Test-Health
Bereich **Test-Health**: Pflegelisten je Projekt.
- nie ausgeführt, lange nicht ausgeführt (über 12 Monate);
- **wackelnd** (wechselnde Ergebnisse oder in den letzten 90 Tagen erst im Wiederholungsversuch bestanden), **immer bestanden** (Kandidat für Automatisierung), häufig blockiert;
- ohne prüfbares Ergebnis, mit Mangel/ungültig, mögliche Duplikate (gleicher Titel), Altlasten.

Testfälle ankreuzen → **Label vergeben**. Über das Label lassen sie sich in der Testfallliste filtern und
abarbeiten.

**Analysen** (ohne KI, nachvollziehbar):
- **Ähnliche Testfälle**: Duplikatkandidaten nach Titel und Inhalt, mit Schwellwert.
- **Fehlerursachen**: Fehlschläge mit ähnlichem Befund bzw. gleichem Fehler gruppiert. Umgebungsangaben,
  Kennungen und Zahlen werden ausgeblendet. Optional mit KI-Kurzzusammenfassung.
- **Anforderungsabdeckung**: verknüpfte Anforderungen und Stories × letztes Ergebnis (bestanden, teilweise,
  fehlgeschlagen, ungetestet).

## Testberichte
**📄 Berichte** (im Testplan, im Zyklus, in den Testfällen). Aufbau in Anlehnung an **ISO/IEC/IEEE 29119-3**:

| Bericht | Ort | Inhalt |
|---|---|---|
| Teststatusbericht (Zwischenbericht) | Testplan, Release-Cockpit | Lage mit Prognose und Lagebild, Burn-down, Ergebnisse und neue Fehler im Berichtszeitraum, Stand je Testfall, Ausstiegskriterien (Zwischenstand), Risiken, aktuelle Probleme |
| Testprotokoll | Zyklus | Zusammenfassung, Umgebung, alle Ausführungen mit Befunden, Schritten (je Profil), Durchläufen, Dauer, Evidenzen, explorative Sitzungen, Abweichungen, offene Punkte, Freigabeblock |
| Testabschlussbericht | Testplan | Bewertung mit Freigabeentscheidung und Fazit, Testbasis, Ausstiegskriterien (Ziel/Ist/erfüllt), Restrisiken, Abweichungen vom Testplan, Stand je Testfall, Testumfang, Fehlerwirkungen, verknüpfte Fehler, offene Punkte, Freigabeblock |
| Rückverfolgbarkeit | Testplan | Anforderungen (am Plan, an Zyklen, an eingeplanten Testfällen) × Testfälle × letztes Ergebnis; ohne Testfall, mit Fehlern, nicht getestet; Testfälle ohne Anforderung |
| Testfallspezifikation | Testfälle (Projekt/Ordner) | alle Testfälle mit Ziel, Vorbedingungen, Schritten, Gherkin bzw. Testanweisung (Freitext) |

- **Ansehen**: HTML im Browser mit Bildern und Evidenzen; *Drucken → Als PDF speichern* (A4 ist eingestellt) ergibt
  ein PDF mit Bildern.
- **PDF**: direkt erzeugte PDF-Datei (A4, Text und Tabellen, Seitenzahlen; ohne Bilder) – für Barrierefreiheit getaggt
  (ausgerichtet an PDF/UA-1) und für die Archivierung nach PDF/A-2b ausgelegt, mit eingebetteter Schrift.
- **MD/JSON**: Markdown bzw. maschinenlesbare Daten.
- **Profil**: Aufbau und Erscheinungsbild (Organisation, Farbe, Abschnitte, Freigaberollen), siehe
  Administration.

## Lieferpaket
Im Testplan **📄 Berichte → Lieferpaket**. Die ZIP-Datei enthält:
- Abschlussbericht und Rückverfolgbarkeit (HTML/MD) sowie die Testprotokolle je Zyklus;
- `ergebnisse.json` und die verwendeten Evidenzen;
- `manifest.json`, `SHA256SUMS`, optional eine Ed25519-Signatur, und `LIESMICH.txt` mit Prüfanleitung
  (`shasum -a 256 -c SHA256SUMS`).
