# Testfälle

Bereich **Testfälle**: links der Ordnerbaum, in der Mitte die Liste mit Suche und Filtern, rechts der gewählte
Testfall.

## Finden und filtern
- Suchfeld: Volltext (deutsch, mit Wortstämmen), Testfallschlüssel oder Jira-Altschlüssel.
- Filter: **Status**, **Testart** (Unit, Integration, System, UAT … aus Zephyr), **Label**, **Priorität**, Ordner (mit
  Unterordnern). Gibt es archivierte Testfälle, wählt ein weiterer Filter *ohne archivierte*, *mit archivierten* oder
  *nur archivierte*.
- **⌕ Abfrage** öffnet die erweiterte Suche mit der Abfragesprache (siehe unten).
- **☆ Ansichten**: die aktuelle Filterung speichern, für sich oder mit „Pflegen“ für das ganze Projekt.

## Abfragesprache
Die Abfragesprache ähnelt ZQL/JQL und gilt gleich für Testfälle (**⌕ Abfrage**) und Ausführungen (*Testplanung →
🔎 Ausführungen suchen*, siehe [Planung & Durchführung](03-planung-durchfuehrung.md)). Anemo prüft die Abfrage beim
Tippen, markiert Fehler mit **^** an der Stelle und schlägt Felder, Vergleiche und Werte vor (Tab oder Enter
übernimmt). **?** neben *Suchen* zeigt alle Felder mit Erklärung und Beispiele zum Anklicken.

**Aufbau:** Bedingungen der Form `feld vergleich wert`, verknüpft mit **UND**, **ODER**, **NICHT** und Klammern. Ohne
Verknüpfung gilt UND. Freie Wörter durchsuchen den Text. Englische Schreibweisen (AND, OR, NOT, ORDER BY) gehen ebenfalls.

| Vergleich | Bedeutung |
|---|---|
| `=` `!=` | gleich, ungleich |
| `~` `!~` | enthält, enthält nicht |
| `<` `<=` `>` `>=` | kleiner/größer (Datum, Zahl, Priorität) |
| `IN (a, b)` `NICHT IN (a, b)` | einer der Werte |
| `IST LEER` `IST NICHT LEER` | ohne bzw. mit Wert |

**Werte:**
- Werte mit Leerzeichen in Anführungszeichen: `zyklus = "Regression 7.5"`.
- Datum relativ oder absolut: `-7d`, `-2w`, `-1m`, `-1y`, `heute()`, `01.10.2026`, `2026-10-01`.
- Person: `ich()` für das eigene Konto.
- Ja/Nein-Felder: `ja`/`nein`.
- Priorität: `priorität >= Kritisch` heißt „Kritisch oder wichtiger“ (Reihenfolge laut Werteliste der Administration).

**Wichtige Felder für Testfälle:** `text`, `schlüssel`, `titel`, `status`, `kategorie` (Entwurf, Review,
Freigegeben, Veraltet), `priorität`, `label`, `komponente`, `ordner` (`=` Pfad mit Unterordnern wie `A/B`, `~` Teil
eines Namens), `owner`, `erstellt`, `ersteller`, `geändert`, `geändertvon`, `version`, `format`, `schritte`,
`schätzung`, `parametrisiert`, `testart`, `anforderung`, `fehler`, `verweis`, `ergebnis` (letztes Ergebnis),
`ausgeführt`, `ausgeführtvon`, `zyklus`, `archiviert`. `format` kennt `klassisch`, `gherkin` und `freitext`. Eigene Felder: `feld.Team` bzw. `feld."Name mit Leerzeichen"`.

**Sortieren:** `SORTIERT NACH feld` mit `AUF` (aufsteigend, Standard) oder `AB` (absteigend), mehrere Felder mit Komma.
Sortierbar sind u. a. `schlüssel`, `titel`, `status`, `priorität`, `erstellt`, `geändert`, `ausgeführt`, `zyklus`.

**Beispiele:**
- `priorität >= Kritisch UND kategorie = Freigegeben`: wichtige, freigegebene Testfälle
- `label IN (smoke, regression) UND NICHT ordner ~ Alt`: Labels, ohne Ordner „Alt…“
- `ergebnis = Fehlgeschlagen UND ausgeführt > -14d`: in den letzten 14 Tagen fehlgeschlagen
- `anforderung = PROJ-1234`: Tests zu einer Anforderung
- `feld.Team = Alpha SORTIERT NACH geändert AB`: eigenes Feld, neueste zuerst
- `geändert > -7d UND geändertvon = ich()`: was ich diese Woche geändert habe
- `schätzung IST LEER`: Testfälle ohne Schätzung
- `format = freitext`: Freitext-Testfälle (ohne Schritte)

Archivierte Testfälle erscheinen nur, wenn die Abfrage `archiviert` nennt oder der Archivfilter es erlaubt.

## Massenbearbeitung
Testfälle ankreuzen (Kopfzeile: alle auf der Seite; **alle n Treffer auswählen**: alle Treffer des Filters). Die
Leiste *Massenbearbeitung* bietet:
- **Status …** und **Priorität …** (auch „– entfernen –“);
- unter **Mehr ▾**: **+ Label …**, **− Label entfernen …**, **+ Komponente …**, **− Komponente entfernen …**,
  **👤 Owner setzen …**, **☰ Feld setzen …** (eigene Felder), **⏱ Schätzung setzen …**, **⏱ Schätzung aus
  Erfahrungswerten**, **↦ In diesen Ordner verschieben** (bzw. *Auf oberste Ebene verschieben*), **▤ Als Testset
  speichern …** und **🗄 Archivieren** (in der Ansicht *nur archivierte*: **↺ Wiederherstellen**).

Inhaltliche Änderungen (Priorität, Labels, Komponenten, Felder) ergeben je Testfall eine neue Version. Testfälle, bei
denen eine Änderung nicht erlaubt ist (z. B. Statuswechsel außerhalb des Workflows), werden übersprungen; Anemo nennt
sie mit Grund.

## Ordner
Im Ordnerbaum legt **+** einen Ordner unter dem gewählten an. **⋯** am gewählten Ordner:
- **✎ Umbenennen …**
- **↦ Verschieben …**: in einen anderen Ordner oder auf die oberste Ebene (nicht in sich selbst oder einen eigenen
  Unterordner).
- **🗑 Löschen …**: Enthaltene Testfälle und Unterordner wandern eine Ebene nach oben, es wird kein Testfall gelöscht.

## Anlegen und bearbeiten
**+ Testfall** bzw. **Bearbeiten** öffnet den Editor; **⧉** (neben *Bearbeiten* bzw. im Editor-Kopf) öffnet ihn als
ganze Seite im eigenen Fenster. `Strg+S` speichert. Jedes Speichern eines geänderten Inhalts erzeugt eine **neue
Version**. Ausführungen bleiben an der Version, mit der getestet wurde. Eine kurze **Änderungsnotiz** erklärt
später, was sich warum geändert hat.

**Format:**
- **Klassisch**: Ziel/Beschreibung, Vorbedingungen, Schritte (Aktion, Testdaten, erwartetes Ergebnis), Testdaten.
  Schritte lassen sich mit **Abschnitten** gliedern (siehe unten). **📋** in der Werkzeugleiste eines Feldes fügt
  eine **Feldvorlage** ein (z. B. „Vorbedingung / Vorgehen“, siehe [Administration](10-administration.md#feldvorlagen)).
- **Gherkin (BDD)**: Funktionalität/Szenario mit Angenommen/Wenn/Dann (deutsch oder englisch), Live-Prüfung mit
  Zeilenangabe.
- **Freitext**: unstrukturierter Test ohne Schritte. Statt der Schritttabelle steht das Feld **Testanweisung** (was zu
  tun ist und was erwartet wird, mit Formatierung, z. B. nummerierter Liste). In der Durchführung wird nur das
  Gesamtergebnis mit Befund erfasst. Liste und Ansicht kennzeichnen solche Testfälle mit **Freitext**.
- „In Gherkin umwandeln…“ und „In Schritte umwandeln…“ erzeugen Vorschläge. Gespeichert wird erst nach Prüfung.
- **Formatwechsel zu Freitext**: Anemo bietet an, vorhandene Schritte als nummerierten Text in die Testanweisung zu
  übernehmen. Umgekehrt (Freitext → Klassisch) lässt sich die Testanweisung als ersten Schritt übernehmen. Bis zum
  Speichern bleibt der bisherige Inhalt im Editor erhalten; gespeichert wird nur das gewählte Format.

**Texte bearbeiten:** Alle längeren Felder haben einen **visuellen Editor**:
- Fett, kursiv, Farbe, Listen (Tab rückt ein), Tabelle, Code, Hinweiskasten, Link (Strg+K).
- **Screenshots** per **Strg+V**, per Ablegen oder über 📎 direkt in den Text.
- „Markup“ schaltet auf Jira-Wiki-Markup um. Texte, die der visuelle Editor nicht verlustfrei darstellen kann (sehr
  selten), öffnen automatisch im Markup-Modus.
- Felder wachsen mit dem Inhalt und lassen sich mit der Maus vergrößern.

**✨ Aus Anforderung** (wenn ein KI-Modell eingerichtet ist): Anforderungstext einfügen. Anemo schlägt Titel,
Schritte und ein Gherkin-Szenario vor, die Sie im Editor prüfen und dann speichern.

**Priorität und Felder:** Die **Priorität** stammt aus der Werteliste der Administration; neue Testfälle starten mit
der Standard-Priorität. Unter **Felder** stehen die eigenen Felder des Projekts (Text, Auswahl, Zahl, Datum, Ja/Nein,
Person …). Pflichtfelder müssen beim Anlegen und Bearbeiten gefüllt sein. Feldwerte gehören zur Version.

## Abschnitte
Abschnitte gliedern lange Testfälle, z. B. *Einstellungen*, *Test durchführen*, *Aufräumen*. Ein Abschnitt ist **kein
Prüfschritt**: Er hat kein Ergebnis und zählt weder in Nummerierung, Fortschritt noch Gesamtergebnis. Alle Schritte bis
zum nächsten Abschnitt gehören dazu.
- **Ansicht und Durchführung:** Abschnitte lassen sich mit ▾/▸ auf- und zuklappen, darüber *Alle Abschnitte
  aufklappen / Alle zuklappen*. Standard: alles offen. Die Nummern zählen nur Prüfschritte.
- **Editor:** **§ Abschnitt** fügt einen Abschnitt vor dem ersten markierten Schritt ein (sonst am Ende); **§** an einem
  Schritt wandelt ihn in einen Abschnitt um (Aktion wird Name). ↑/↓ am Abschnitt verschiebt ihn **mit seinen
  Schritten**. Unter **⋯**: *In Schritt zurückwandeln* bzw. *Abschnitt entfernen* (die Schritte bleiben). Optional
  **+ Beschreibung**.
- **Aus Zephyr übernommen:** Die dort üblichen Pfeil-Trennschritte (Aktion `---->`, Erwartet `<----`, Name als
  Überschrift in den Testdaten) werden zu Abschnitten. Der Name kommt aus der Überschrift der Aktion, sonst aus der
  Überschrift bzw. dem Panel-Titel der Testdaten, sonst aus dem Begriff in der Pfeilzeile. Ein Begriff vor dem Pfeil
  neben einer Testdaten-Überschrift (z. B. „INAKTIV“) wird **Kennzeichen**, eine zweite Überschrift **Untertitel**,
  weiterer Text **Beschreibung**. Der Originaltext bleibt erhalten (*In Schritt zurückwandeln* stellt ihn wieder her).
  Ergebnisse, die in Zephyr auf solchen Trennschritten erfasst wurden, zeigt die Durchführung als *Ergebnis aus
  Zephyr* – sie zählen nicht.
- **Excel/CSV:** Abschnitte stehen als Zeile ohne Nummer mit „▸ Abschnitt: Name“ in der Spalte Aktion und werden beim
  Import wieder Abschnitte (ebenso Pfeil-Trennschritte aus Zephyr-Exporten). Im Excel-Rundlauf werden Einträge in
  Abschnittszeilen ignoriert.

## Wiederverwendbare Vorbedingungen
Vorbedingungen, die viele Testfälle teilen (z. B. „Testmandant mit Akte vorbereitet“), pflegen Sie einmal:
- **⋯ → ☑ Vorbedingungen …** (über der Testfallliste): suchen, **+ Vorbedingung** anlegen (Titel, Beschreibung),
  bearbeiten (✎, mit optionaler Änderungsnotiz), archivieren (🗄; danach nicht mehr neu verknüpfbar) oder, solange
  unbenutzt, löschen. Ein Klick auf eine Vorbedingung zeigt Inhalt, **Verwendet in** und **Versionen**.
- Im Editor unter *Vorbedingungen*: „Wiederverwendbare Vorbedingung suchen und verknüpfen …“, Reihenfolge mit ↑,
  entfernen mit ✕. Darunter bleibt Freitext für Vorbedingungen, die nur hier gelten.
- Vorbedingungen sind **versioniert** (Schlüssel wie `DEMO-P3`). Eine Änderung gilt sofort in allen verwendenden
  Testfällen; Durchführung und Berichte zeigen den aktuellen Stand mit Versionsnummer.

## Aufrufbare Tests (Call Test)
Wiederkehrende Abläufe wie Anmelden oder Akte anlegen als eigenen Testfall pflegen und in andere einsetzen:
- Im Editor unter den Schritten **↪ Testfall aufrufen …** → Testfall desselben Projekts wählen. Es entsteht ein
  Aufruf-Schritt („Aufruf DEMO-T7 …“).
- Beim Speichern wird die **Version festgeschrieben**, damit spätere Änderungen am aufgerufenen Testfall bestehende
  Abläufe nicht unbemerkt verändern. Gibt es eine neuere Fassung, hebt **auf vN aktualisieren** den Aufruf an.
- In Ansicht und Durchführung werden die Schritte des aufgerufenen Testfalls an dieser Stelle eingesetzt (in der
  Ansicht aufklappbar). Aufrufe dürfen bis **5 Ebenen** tief verschachtelt sein; Selbst- und Ringaufrufe weist Anemo
  beim Speichern zurück.

## Schrittbibliothek
Häufige Schrittfolgen wie „Anmelden als Sachbearbeitung“ oder „Akte über die Suche öffnen“ liegen als **Bausteine**
in der Schrittbibliothek des Projekts und werden als **Kopie** in Testfälle eingefügt.
- **⋯ → 📚 Schrittbibliothek …** (über der Testfallliste): Bausteine suchen (Name, Schlagwort, Schritttext),
  **+ Baustein** anlegen (Name, Schlagworte, Beschreibung, Schritte), bearbeiten (✎), archivieren (🗄; wird dann
  nicht mehr zum Einfügen angeboten, **↺** holt ihn zurück) und löschen (✕, nur Projektadmin). „archivierte zeigen“
  blendet archivierte ein. Die Spalte *verwendet* zählt die Testfälle, deren aktuelle Version Schritte aus dem
  Baustein enthält; ein Klick auf einen Baustein zeigt Schritte und **Verwendet in**.
- Im Editor unter den Schritten: **📚 Aus Bibliothek …** wählt einen Baustein mit Vorschau und fügt seine Schritte
  ein, nach dem zuletzt markierten Schritt (Kästchen an der Schrittnummer) oder am Ende. Eingefügte Schritte tragen
  das Zeichen 📚.
- **Als Baustein speichern …** macht aus den markierten Schritten (ohne Markierung: allen) einen neuen Baustein.
- Eingefügte Schritte bleiben im Testfall frei änderbar. Eine spätere Änderung am Baustein wirkt nur auf künftiges
  Einfügen, nicht auf vorhandene Testfälle. Wird ein Baustein gelöscht, bleiben die Schritte in den Testfällen
  erhalten.

**Baustein oder aufrufbarer Test?** Der Baustein ist eine Kopiervorlage: schnell eingefügt, danach im Testfall
anpassbar, aber nicht zentral nachgeführt. Soll ein Ablauf überall gleich bleiben und an einer Stelle gepflegt
werden, ist ein [aufrufbarer Test](#aufrufbare-tests-call-test) (**↪ Testfall aufrufen …**) die bessere Wahl.

## Schätzung (geplanter Aufwand)
Im Kopf des Testfalls steht **⏱** mit dem geplanten Aufwand je Ausführung; **schätzen** bzw. **ändern** setzt ihn.
- Eingabe in Minuten oder mit Einheit: `90`, `1h 30m`, `1,5 h`, `2d` (ein Tag = 8 Stunden). Leer entfernt die
  Schätzung.
- **⏱ Schätzung aus Erfahrungswerten** (Massenbearbeitung) übernimmt den Median der gemessenen Bearbeitungszeit, sobald
  mindestens zwei Messungen vorliegen; Testfälle mit zu wenigen Messwerten bleiben unverändert.
- Die Schätzung erzeugt keine neue Version. Sie speist den geplanten Aufwand im Zyklus, das Verteilen und die
  risikobasierte Auswahl.

## Archivieren und löschen
Im Menü **⋯** des Testfalls:
- **🗄 Archivieren**: blendet den Testfall in Listen, Testsets und der Zyklusauswahl aus. Inhalte, Versionen und
  Ergebnisse bleiben erhalten. **↺ Wiederherstellen** (oder *Wiederherstellen* im Hinweis) holt ihn zurück.
- **🗑 Endgültig löschen …** (nur Projektadmin): löscht alle Versionen, Verweise und Anhänge. Zur Bestätigung den
  Schlüssel eingeben. Möglich nur, wenn der Testfall **nie in einem Zyklus** eingeplant war; sonst archivieren.
- **⎘ Kopieren** legt einen neuen Testfall mit gleichem Inhalt als Entwurf an.

## Parametrisierte Tests (Datensätze)
Der Datensatz steht im Editor direkt unter den Schritten; ein Hinweis „parametrisiert · n Durchläufe“ zeigt, wie oft
der Test durchlaufen wird.

Ein Testfall für viele Varianten, z. B. je Benutzerrolle oder Dokumenttyp:
- **+ Datensatz** im Editor legt eine Tabelle an. Spalten sind die Parameter, Zeilen die Durchläufe. Eine Tabelle
  aus Excel lässt sich mit Kopfzeile in das erste Feld einfügen.
- In den Schritten setzt `${spalte}` den Wert ein, z. B. „Als `${rolle}` anmelden“.
- **Gherkin**: Ein *Szenariogrundriss* mit *Beispielen* ist automatisch parametrisiert, jede Beispielzeile wird
  ein Durchlauf.
- Der Datensatz ist Teil der Version. Ausführungen bleiben bei den Werten, mit denen getestet wurde.
- **⚙ Kombinationen …** erzeugt die Durchläufe aus Parametern und ihren Werten (mit Komma getrennt): **paarweise
  (empfohlen)**, d. h. jedes Wertepaar zweier Parameter kommt mindestens einmal vor, oder **alle Kombinationen**.
  **Ausschlüsse** (je Zeile eine Kombination wie `browser=Edge, os=Linux`) werden nicht erzeugt. Höchstens 200
  Durchläufe je Testfall.
- Für einzelne Zyklen oder Testpläne lässt sich der Datensatz anpassen, ohne den Testfall zu ändern (siehe
  [Planung & Durchführung](03-planung-durchfuehrung.md)).

## Testsets
Wiederkehrende Auswahlen wie „Smoke“ oder „Regression Kern“ (**▤ Testsets**):
- **fest**: Testfälle in der Liste auswählen, dann **▤ Als Testset**.
- **dynamisch**: einen Filter setzen (Suche, Ordner, Status, Label, Testart), dann **▤ Filter als Testset**.
  Neue passende Testfälle kommen automatisch hinzu.
- **Anzeigen**: Ein dynamisches Set wendet seinen Filter an, ein festes markiert seine Testfälle.
- Im Zyklus: **+ Tests aufnehmen → aus Testset …**.

## KI-Unterstützung im Editor
- **✨ Aus Anforderung** entwirft einen Testfall aus einem Anforderungstext. Die gespeicherte Version wird als
  **„✨ mit KI erstellt“** gekennzeichnet (Skill und Modell).
- **✨ Prüfen** bewertet den Testfall im Editor: unklare Erwartungen, fehlende Vorbedingungen oder Testdaten,
  zusammengefasste Schritte, Fachbegriffe laut Projektkontext. Es ändert nichts; Sie übernehmen, was passt.
- Die Schaltflächen erscheinen nur, wenn die KI eingeschaltet und ein Modell eingerichtet ist.

## Versionen und Änderungen
- Versionsauswahl im Kopf: ältere Fassungen ansehen.
- **Versionshistorie** mit Feld-für-Feld-Vergleich. Versionen mit „Rekonstruiert“ stammen aus der Zephyr- und
  Jira-Historie.
- **Dokumentierte Änderungen**: Änderungstabellen im Text (Bearbeiter/Datum/Grund) werden als Zeitleiste angezeigt.

## Status und Workflow
Der Status zeigt den Reifegrad, z. B. Entwurf → Bereit zum Review → Freigegeben → Veraltet. „ändern …“ bietet nur
die im Workflow erlaubten Wechsel an. Übernommene Jira-Status sind frei wechselbar, bis die Administration Regeln
festlegt.

**Vier-Augen-Prinzip:** Freigeben darf nicht, wer die aktuelle Version geschrieben hat. Die Freigabe gilt für eine
Version („✓ freigegeben v3 von …“ im Kopf). Eine neue Version eines freigegebenen Testfalls geht automatisch zurück in
den Review, die Freigabe entfällt. Werden Testfälle im Status *Entwurf* oder *Review* in einen Zyklus aufgenommen,
weist Anemo darauf hin; *veraltete* Testfälle werden nicht aufgenommen.

**Massenfreigabe** (Rolle *Projektadmin*): Testfälle in der Liste auswählen (auch „alle Treffer“ einer Abfrage) →
**✓ Freigeben …**. Anemo zählt vorher, was freigegeben wird, und überspringt eigene Versionen (Vier-Augen-Prinzip),
bereits freigegebene, archivierte und veraltete Testfälle. Ein optionaler Vermerk steht im Verlauf. Die Zwischenschritte
des Workflows (z. B. Review) entfallen dabei – deshalb nur mit der Rolle *Projektadmin*.

## Anhänge
Abschnitt **Anhänge** → *+ Datei*, oder direkt im Editor einbetten. Bilder werden im Text angezeigt. Gleichnamige
Screenshots erhalten automatisch eindeutige Namen.

**Anhänge an Schritten:** Im Editor eines gespeicherten Testfalls hängt **+ 📎** unter der Aktion eine Datei an genau
diesen Schritt (z. B. Bildschirmfoto, Beispieldatei). Sie erscheint in der Ansicht und in der Durchführung beim
Schritt.

## Beobachten
**👁 Beobachten** im Kopf des Testfalls meldet dessen Änderungen per E-Mail (Version, Status, Archivieren,
Kommentare, Fehlschläge). Erneut klicken (**👁 Beobachtet**) beendet das. Details und was gemeldet wird:
[Zusammenarbeit](05-zusammenarbeit.md#beobachten).

## Diskussion
Unter **Diskussion** am Testfall (und an Vorbedingungen) Anmerkungen schreiben und beantworten, mit
**@name** Personen benachrichtigen und Erledigtes abhaken. Details: [Zusammenarbeit](05-zusammenarbeit.md).

## Import aus Excel/CSV
**⋯ → ⇧ Import aus Excel/CSV …** (Rolle *Pflegen*):
1. Datei wählen: **.xlsx** oder **.csv** (Semikolon, Komma oder Tab; UTF-8 oder Windows-1252), höchstens 20 MB und
   5.000 Testfälle. Bei mehreren Tabellenblättern das Blatt wählen. Das alte Format .xls bitte als .xlsx speichern.
2. **Spalten zuordnen**: Je Spalte der Datei „übernehmen als“ Titel, Schlüssel, Ordner, Status, Priorität, Labels,
   Komponenten, Owner, Schätzung, Ziel, Vorbedingungen, Testdaten, Format, Gherkin, **Testanweisung (Freitext)**,
   Schrittspalten, eigene Felder
   oder „– nicht übernehmen –“. Spalten aus **Zephyr**- und **Xray**-Exporten sowie aus dem Anemo-Export erkennt Anemo
   automatisch.
3. **Vorgehen**: *Vorhandene per Schlüssel aktualisieren, übrige neu anlegen* oder *Alle als neue Testfälle anlegen*.
   **Ablage**: in den links gewählten Ordner; eine Spalte „Ordner“ legt Unterordner an.
4. **Probelauf**: prüft alles und zeigt je Zeile *neu*, *aktualisiert*, *unverändert* oder *Fehler*, speichert aber
   nichts. Danach **Importieren**.

Aufbau der Datei: je Schritt eine Zeile; eine Zeile mit Titel bzw. neuem Schlüssel beginnt einen neuen Testfall.
Beim Aktualisieren ändern nur zugeordnete, nicht leere Zellen den Testfall; Schritte werden ersetzt, wenn die Datei
Schrittzeilen enthält. Freitext-Testfälle entstehen, wenn die Spalte *Format* „Freitext“ enthält oder eine
Testanweisung ohne Schrittzeilen angegeben ist. Jede Änderung ergibt eine neue Version mit der Änderungsnotiz „Import aus …“. Neue Testfälle
lassen sich nicht direkt als *Freigegeben* anlegen (Vier-Augen-Prinzip).

## Export
**⋯ → ⇩ Export Excel** bzw. **⇩ Export CSV** (Semikolon, für Excel) exportiert die angekreuzten Testfälle oder alle
Treffer der aktuellen Filter: je Schritt eine Zeile mit Schlüssel, Titel, Ordner, Status, Priorität, Labels,
Komponenten, Owner, Format (Klassisch, Gherkin, Freitext), Ziel, Vorbedingungen, Testdaten, Gherkin, Testanweisung
(Freitext), Version, Schätzung und eigenen Feldern. Tipp:
exportieren, in Excel bearbeiten und per Schlüssel wieder importieren.

## Verweise auf Tickets
**🔗 Verknüpfen…** verbindet den Testfall mit:
- einem **OpenProject-Arbeitspaket**: Live-Suche, das Arbeitspaket erhält einen Rückverweis;
- einem **GitLab-Merge-Request/-Commit**;
- einem **Jira-Ticket** (Schlüssel eingeben).

Die Art der Beziehung ist z. B. Anforderung, Story, Epic oder Fehler. Titel und Status der Tickets werden
regelmäßig aktualisiert. Je Art eine Liste mit einer Zeile pro Ticket: Schlüssel, Titel, Schweregrad und Status
(offene farbig, erledigte bzw. abgelehnte grau, offene zuerst). Ab neun Einträgen gibt es die Filter **Alle / Offen /
Erledigt**, ein Suchfeld und **Alle n anzeigen**. **⋯** je Zeile: *Alle Stellen mit diesem Verweis* (🔎), Schweregrad
setzen, Status (nur bei freien Links) und *Verknüpfung lösen*.

## Gherkin und Git
**⎇ Git** gleicht Gherkin-Testfälle mit `.feature`-Dateien im GitLab-Repository ab:
- Stände: gleich, in Anemo geändert, in Git geändert, nur hier, nur dort.
- **Nach Git schreiben** erzeugt einen Commit. In Git geänderte Dateien werden nie überschrieben.
- **Aus Git übernehmen** legt neue Versionen bzw. neue Testfälle an.
- Jede Datei trägt das Tag `@<Testfallschlüssel>`; darüber ordnen auch CI-Ergebnisse automatisch zu.
