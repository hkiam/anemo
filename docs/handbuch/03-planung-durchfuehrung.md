# Planung & Durchführung

## Aufbau
- **Testplan** (meist ein Release): bündelt Zyklen, zeigt Fortschritt, Ergebnis-Matrix und Release-Cockpit.
- **Testzyklus**: ein Lauf mit Build, Umgebung, Zeitraum und **Konfiguration** (Datenbank, Client, Betriebssystem
  …). Er enthält **Ausführungen**, je eine pro Testfall und Testfallversion.

Linke Leiste: *Alle Testzyklen*, *Mir zugewiesen*, *🔎 Ausführungen suchen*, *🤖 KI-Ergebnisprüfung*, *Ohne
Testplan* und die Testpläne mit Fortschrittsbalken.

## Testpläne pflegen
- **+ Plan** (linke Leiste): Name, Release/Version, **Ziele, Umfang, Ein- und Ausstiegskriterien**. Die
  Beschreibung erscheint im Testabschlussbericht.
- **✎ Plan bearbeiten** (beim gewählten Testplan), auch im eigenen Fenster (⧉). Leere Testpläne lassen sich
  löschen; Pläne mit Zyklen nicht, damit keine Ergebnisse verloren gehen.
- **🗄 Archivieren** (beim gewählten Testplan): blendet abgeschlossene Releases in der linken Leiste aus; Berichte,
  Freigabestände und Ergebnisse bleiben. *Archivierte zeigen* unter der Liste blendet sie wieder ein,
  **↺ Wiederherstellen** macht das Archivieren rückgängig.
- **⎘ Kopieren …** (für das nächste Release): Name und Release des neuen Plans angeben. Übernommen werden Ziele,
  Ausstiegskriterien, Verweise, Datensatz-Anpassungen und alle Zyklen mit ihren Testfällen (aktuelle Version,
  Zuständige), ohne Ergebnisse.
- **👁 Beobachten** (beim gewählten Testplan bzw. im Kopf des Zyklus): Änderungen per E-Mail erhalten, siehe
  [Zusammenarbeit](05-zusammenarbeit.md#beobachten).
- **📄 Berichte** beim Testplan enthält auch den **Teststatusbericht (Zwischenbericht)**, siehe
  [Auswertung & Berichte](04-auswertung-berichte.md#teststatusbericht-zwischenbericht).

## Zyklen anlegen und finden
- **+ Testzyklus**: Name, Testplan (oder neuen anlegen), Release, Build, Umgebung, Zeitraum, **Testumfang**.
  Die Konfiguration wird aus Name, Umgebung und Build erkannt oder ausdrücklich festgelegt.
- **✎ Bearbeiten** (im Zyklus): alle Angaben nachträglich ändern, auch den Testplan. Eine manuell festgelegte
  Konfiguration bleibt erhalten.
- **+ Tests aufnehmen**: Testfälle suchen und in der aktuellen Version einplanen, *alle Treffer auswählen*, aus
  einem Testset übernehmen oder **⚖ Risikobasiert …** auswählen lassen (siehe unten).
- Eigene Felder für Zyklen (z. B. Abnahmestufe) stehen im Formular des Zyklus.
- Filter in der Zyklusliste: Text und Zustand (offen/fehlgeschlagen/fertig); unter **Weitere Filter** Build,
  Zeitraum und Konfiguration (z. B. „Datenbank: Oracle“). Aktive Filter stehen als Chips da und lassen sich mit ✕
  einzeln entfernen. **☆ Ansichten** speichert Filter.
- Tab **Nach Konfiguration**: Ergebnisse und Fehlerquote je Datenbank, Client usw.

## Zyklen wiederholen, verteilen, vergleichen
Diese Aktionen liegen im Zyklus unter **⋯ Mehr**.

- **↻ Wiederholen**: neuer Zyklus für einen neuen Build. Optional **nur Nachtest** (fehlgeschlagene, blockierte und
  offene Tests) und **je Konfiguration ein eigener Zyklus** (z. B. Oracle und SQL Server). Zuständige bleiben
  erhalten, Testfälle kommen in der aktuellen Version.
- **↻ Wiederholen** je Konfiguration: Werte mehrerer Merkmale ankreuzen (z. B. Datenbank und Client) und wählen:
  **paarweise** (jedes Wertepaar zweier Merkmale mindestens einmal) oder **alle Kombinationen**. Anemo zeigt die
  Anzahl („4 Zyklen statt 12“) und legt höchstens 20 Zyklen auf einmal an.
- **⚖ Verteilen**: offene Ausführungen nach Auslastung auf Personen verteilen. Standard ist der Aufwand je Test: die
  **Schätzung** des Testfalls, ohne Schätzung der **Erfahrungswert** (Median der gemessenen Dauer früherer
  Ausführungen), sonst 2 Minuten je Schritt. Alternativ nach Schrittanzahl oder je Test gleich; vorhandene offene
  Arbeit im Projekt zählt mit.
- **⇄ Vergleichen**: zwei Zyklen bzw. Builds gegenüberstellen, mit Regressionen (bestanden → fehlgeschlagen),
  behobenen Fehlern und weiterhin fehlerhaften Tests.
- **⇅ Excel-Rundlauf…** und **▶ CI-Pipeline starten…**: siehe unten.

## Geplanter Aufwand
Unter dem Fortschrittsbalken des Zyklus steht **⏱ erfasst … · geplant … · Rest …**: erfasst ist die gemessene
Bearbeitungszeit, geplant die Summe der Schätzungen, Rest die Schätzungen der noch offenen Ausführungen. Testfälle ohne
Schätzung zählen nicht mit und werden als „n ohne Schätzung“ ausgewiesen.

## Risikobasierte Testauswahl
Im Zyklus **+ Tests aufnehmen → ⚖ Risikobasiert …** schlägt eine Auswahl nach Risiko vor, wenn nicht alles getestet
werden kann:
1. **Umfang**: eine Abfrage, z. B. `komponente = Anmeldung` (leer = alle gültigen Testfälle; archivierte und veraltete
   zählen nie).
2. **Budget**: *Zeit* (z. B. `6h`, `2d`; ein Tag = 8 Stunden) oder *Anzahl Tests*.
3. Optional **Änderungsumfang des Release**: Änderungsbeschreibung (Release Notes, Ticket-Titel, Commit-Texte),
   geänderte Komponenten/Schlagworte und geänderte Anforderungen.
4. **Vorschlag berechnen**.

Jeder Testfall erhält einen nachvollziehbaren **Risikowert** aus Einzelfaktoren (Höchstpunkte; ohne Änderungsumfang
zusammen 100):

| Faktor | Punkte |
|---|---|
| Priorität (höchste Stufe volle Punkte, linear abnehmend) | 20 |
| Zuletzt fehlgeschlagen/blockiert | 15 |
| Fehlerquote der letzten 10 Ergebnisse | 15 |
| Wackelnd (Wechsel bestanden/fehlgeschlagen) | 10 |
| Geändert seit letzter Ausführung bzw. nie ausgeführt | 15 |
| Lange nicht ausgeführt (ab 14 Tagen, steigend) | 10 |
| Offene Fehler | 10 |
| Gefährdete Anforderung (ein verknüpfter Test fehlgeschlagen) | 5 |
| Im Änderungsumfang (Komponente/Label bzw. Anforderung) | 25 |
| Passt zur Änderungsbeschreibung (Textähnlichkeit) | 15 |

Die Auswahl nimmt die Testfälle nach Risikowert, bis das Budget erreicht ist; Testfälle im Zyklus werden nicht erneut
vorgeschlagen. Die Dauer je Test ist die Schätzung, sonst der Median der erfassten Zeiten, sonst der
Projektdurchschnitt (in der Liste mit „~“ markiert). Die Spalte *wichtigste Gründe* klappt alle Faktoren auf.
Der Hinweis über der Liste und die Fußzeile nennen die **Risikoabdeckung**: welcher Anteil des Gesamtrisikos (Summe
aller Risikowerte) in der Auswahl liegt.

**✨ mit KI verfeinern** (wenn ein Sprachmodell eingerichtet ist): Das Modell justiert die vorderen 80 Kandidaten
anhand der Änderungsbeschreibung um höchstens ±30 Punkte, bis zu 25 Anpassungen. Jede Anpassung steht als Faktor
**KI-Einschätzung** mit Begründung beim Testfall, dazu eine kurze Zusammenfassung der betroffenen Bereiche.

Auswahl prüfen, Häkchen anpassen, dann **Auswahl aufnehmen**.

## Ausführungen suchen und gemeinsam bearbeiten
*Testplanung → 🔎 Ausführungen suchen*: Abfrage über alle Zyklen des Projekts (Sprache wie bei den Testfällen, siehe
[Testfälle](02-testfaelle.md#abfragesprache)). Ohne Abfrage stehen Beispiele zum Anklicken da, etwa:
- `status = Fehlgeschlagen UND fehler IST LEER`: Fehlschläge ohne Fehlerticket
- `zugewiesen = ich() UND kategorie = offen`: meine offenen Ausführungen
- `zyklus ~ Regression UND konfiguration.datenbank = Oracle`: Regression auf Oracle
- `release = "7.5" UND kategorie IN (Fehlgeschlagen, Blockiert)`: Probleme im Release

Zusätzliche Felder für Ausführungen: `zugewiesen`, `plan`, `release`, `build`, `umgebung`, `zyklusstatus` (geplant,
aktiv, abgeschlossen), `kommentar`, `dauer` (Minuten), `prüfung` (KI-Ergebnisprüfung), `veraltet`,
`konfiguration.<Merkmal>`, `feld.<Name>`. Archivierte Zyklen findet `archiviert = ja`.

**⇩ Excel** bzw. **⇩ CSV** exportieren die Treffer (bis 20.000). Angekreuzte Ausführungen (oder **alle Treffer
auswählen**) lassen sich gemeinsam bearbeiten:
- **Ergebnis setzen …** mit Befund/Kommentar für alle (Nachweispflicht gilt auch hier);
- **Zuweisen …** (leer = Zuweisung entfernen);
- unter **Mehr ▾**: **🐞 Fehler verknüpfen …**, **☰ Feld setzen …**, **↦ In anderen Zyklus verschieben …** und
  **🗑 Aus dem Zyklus entfernen** (nur nicht ausgeführte; bereits ausgeführte werden übersprungen).

**Schnellausführung:** In der Trefferliste stehen beim Status ✓ ✗ ⊘. **✓** speichert sofort *bestanden*, **✗** und
**⊘** fragen nach Befund bzw. Grund der Blockade. Schritt- und Durchlaufergebnisse bleiben unverändert. ⧉ öffnet die
Ausführung im eigenen Fenster.

## Jetzt ausführen (ohne Zyklus)
Am Testfall **▶ Jetzt ausführen** führt ihn sofort aus, ohne vorher einen Zyklus anzulegen. Die Ausführung landet im
Zyklus **Ad hoc** des Projekts (Kennzeichen *Ad hoc* in der Zyklusliste), der bei Bedarf entsteht, und öffnet im
eigenen Fenster. Jede Sofortausführung ist ein eigener Eintrag. Ist der Ad-hoc-Zyklus abgeschlossen, entsteht ein neuer.
Archivierte Testfälle lassen sich nicht so ausführen.

## Ausführen
Eine Ausführung in der Liste anklicken. Rechts öffnet die Durchführung, mit ⇤ breiter, mit ✕ wieder zu.

**Zum Testfall:** **📄 Testfall** zeigt den Testfall in der Fassung dieser Ausführung, ohne die Durchführung zu
verlassen; **✎ Testfall bearbeiten** öffnet den Editor im eigenen Fenster. Wird dort eine neue Fassung gespeichert,
meldet die Durchführung „neue Fassung vN gespeichert – diese Ausführung bleibt bei vM“: Laufende Ausführungen
behalten ihre Fassung, neue Einplanungen nehmen die neue.

**Im eigenen Fenster (empfohlen für längere Läufe):** **▶ Durchführen (n offen)** im Zyklus öffnet die nächste offene
Ausführung als ganze Seite (⧉ an einer Zeile bzw. *⧉ Fenster* öffnet eine bestimmte). Oben stehen Fortschritt
(„7 / 20 erledigt“), vorige/nächste Ausführung und *Nächste offene ›*. **Speichern & weiter ›** (`Strg+Enter`)
speichert und springt zur nächsten offenen Ausführung. Die Speicherleiste bleibt immer sichtbar.
- **Abschnitte** gliedern die Schritte (siehe [Testfälle](02-testfaelle.md#abschnitte)): ohne Statusknöpfe, mit
  Fortschritt („2/5 erledigt · 1 mit Fehler“), auf- und zuklappbar. Die Tasten j/k bzw. ↓/↑ überspringen Abschnitte.
- Je Schritt den **Status** setzen: ✓ bestanden, ✗ fehlgeschlagen, ⊘ blockiert, weitere Status über **⋯**. Ein
  zweiter Klick setzt zurück. Dazu das **tatsächliche Ergebnis** notieren, Screenshots per Strg+V. Anemo leitet das
  Gesamtergebnis ab (fehlgeschlagen vor blockiert vor offen vor „bestanden mit Einschränkung“ vor bestanden).
- **Werkzeugleiste** unter jedem Schritt-Ergebnis: **📎 Anhang**, **🐞 Fehler melden** (hervorgehoben, sobald der
  Schritt fehlgeschlagen oder blockiert ist; die Fehlermeldung kennt dann die Fehlerstelle) und **🔗 Verknüpfen**
  (vorhandenen Fehler mit dem Schritt verknüpfen). Anhänge und verknüpfte Fehler stehen als Chips darüber.
- **Befund / Kommentar zur Ausführung** erfassen; darunter dieselbe Werkzeugleiste für die ganze Ausführung
  (**📎 Anhang** als Evidenz, **🐞 Fehler melden**, **🔗 Fehler verknüpfen**), dann **Ergebnis speichern**.
- **Nachweispflicht** (Projekteinstellung, Standard an): *fehlgeschlagen* und *blockiert* lassen sich nur mit
  Kommentar oder verknüpftem Fehler speichern. Vorhandene Fehler verknüpfen Sie mit **🔗 Fehler verknüpfen**.
- **Fehlgeschlagen (bekannt)** (über **⋯**): der Test schlägt wegen eines bereits dokumentierten Fehlers fehl. Immer
  mit verknüpftem Ticket oder Befund (unabhängig von der Nachweispflicht). Blockiert die Freigabeempfehlung nicht,
  erscheint aber im Cockpit und im Abschlussbericht als Restrisiko. Aus der CI per Tag `@bekannter-fehler`
  (siehe [Automatisierung](../automation.md#bekannte-fehler)).
- **Nicht anwendbar** (über **⋯**): der Prüfpunkt trifft in diesem Release bzw. dieser Konfiguration nicht zu
  (z. B. ein BITV-Kriterium ohne passende Inhalte). Zählt wie *ungültig* weder als ausgeführt noch als offen und
  geht nicht in Bestehensquote und Durchführungsgrad ein; eine Anforderung, deren Tests alle nicht anwendbar sind,
  gilt als erfüllt.
- **Fehler verknüpfen**: im Reiter *Ticket* per Schlüssel (OpenProject-Nummer, Jira-Schlüssel). Sind *Freie Links*
  in der Administration erlaubt, kommt der Reiter **Link (URL)** hinzu: Adresse und **Kurzname** eingeben – angezeigt
  wird der Kurzname, ein Klick öffnet die Adresse. Bleibt der Kurzname leer, gilt der Vorschlag aus der Adresse
  (Host und letzter Pfadteil). Den Status eines Links (*offen*, *behoben*, *abgelehnt*) setzen Sie von Hand, weil
  Anemo fremde Systeme nicht abfragt.
- **Verlauf der Ergebnisse**: Jede Ergebnisänderung bleibt mit Person und Zeit erhalten (auch Korrekturen).
- Haben zwei Personen dieselbe Ausführung offen, verhindert Anemo, dass die spätere Speicherung die frühere
  unbemerkt überschreibt; neu laden und erneut erfassen.
- **Tastatur**: `j`/`k` Schritt wechseln, `p` bestanden (springt weiter), `f` fehlgeschlagen, `b` blockiert,
  `n` zurücksetzen, `c` Befund schreiben, `Strg+S` speichern, `Strg+Enter` speichern & weiter (Fokusfenster).
- **Versionstreue:** Eine Ausführung bleibt bei der Testfallfassung, mit der sie eingeplant wurde – auch wenn der
  Testfall inzwischen weiterentwickelt wurde (z. B. Schritte für Knöpfe, die es erst in einer späteren Version gibt).
  Das gilt ebenso für wiederverwendbare Vorbedingungen (Anzeige „Fassung beim Einplanen; aktuell vN“). Neue
  Einplanungen nehmen immer die aktuelle Fassung. Beim Speichern im Editor nennt Anemo, wie viele laufende
  Ausführungen bei der bisherigen Fassung bleiben.
- **Umstellen:** Hinweis „bezieht sich auf v3 …; aktuell ist v5“ → **Auf v5 umstellen …** zeigt zuerst eine Vorschau:
  neue, geänderte und entfernte Schritte, geänderte Vorbedingungen und was mit den Ergebnissen geschieht. Ergebnisse
  **unveränderter** Schritte bleiben, **geänderte** Schritte werden wieder offen (das bisherige Ergebnis steht als
  „vor Umstellung (v3)“ darüber, bis der Schritt neu bewertet ist), Ergebnisse **entfernter** Schritte entfallen. Der
  Stand vor der Umstellung bleibt im *Verlauf der Ergebnisse*. Möglich für offene und begonnene Ausführungen;
  abgeschlossene Ergebnisse (bestanden, fehlgeschlagen …) bleiben bei ihrer Fassung – dafür erneut einplanen.
  Für einen ganzen Zyklus: *⋯ Mehr → ⟳ Auf aktuelle Testfallfassungen umstellen …* (mit Zählung vorab).
- **Dieser Test in anderen Kontexten**: dieselbe Prüfung in anderen Zyklen bzw. Konfigurationen.

**Parametrisierte Tests:** Oberhalb der Schritte stehen die **Durchläufe** (je Datenzeile ein Reiter mit
Ergebnisfarbe). Anemo setzt die Werte in die Schritte ein und beginnt beim ersten offenen Durchlauf.
- Jeder Durchlauf hat eigene Schrittergebnisse, ein eigenes Ergebnis und einen Befund.
- Das **Gesamtergebnis** ergibt sich automatisch; das schlechteste Ergebnis zählt. Abweichen geht nur mit
  Begründung.
- **Datensatz anpassen:** Unter den Durchläufen steht, woher der Datensatz kommt (*des Testfalls*, *für den Testplan
  angepasst*, *für diesen Zyklus angepasst*). **anpassen …** (Rolle *Pflegen*) ändert die Datenzeilen **nur für
  diesen Zyklus** oder den **ganzen Testplan**, der Testfall bleibt unverändert. Der Zyklus hat Vorrang vor dem Plan;
  bereits erfasste Durchläufe behalten ihre Werte. **Anpassung entfernen** gilt wieder der Datensatz des Testfalls.

**Freitext-Testfälle:** Statt der Schritte steht die **Testanweisung** (Datensatzwerte sind eingesetzt). Erfasst
werden nur Gesamtergebnis, Befund und Evidenzen.

**Fehler je Schritt:** Jeder Schritt hat **🐞** zum Melden eines Fehlers genau zu diesem Schritt (bei
fehlgeschlagenen oder blockierten Schritten ausgeschrieben als *🐞 Fehler zu Schritt n melden*). Die Ausführung wird
vorher gespeichert. Verknüpfte Fehler stehen danach am Schritt (🐞 mit Nummer und Schweregrad) und in der Fehlerliste
der Ausführung mit „· Schritt n“.

**Weitere Angaben:** Aufgerufene Tests erscheinen mit ihren Schritten an der Aufrufstelle, Anhänge an Schritten beim
jeweiligen Schritt. **+ 📎** am Schritt hängt eine Evidenz an. Eigene Felder für Ausführungen (z. B. Datenstand)
stehen unter **Felder der Ausführung** und werden mit dem Ergebnis gespeichert.

**Bearbeitungsdauer (⏱):** Anemo misst die aktive Zeit, solange das Fenster sichtbar ist, und überträgt sie beim
Speichern. Pausen, andere Tabs und mehr als 5 Minuten ohne Eingabe zählen nicht. Die Summe steht im Zyklus und im Cockpit; „Verteilen“ nutzt sie als
Erfahrungswert.

## Explorative Testsitzungen
Freies, zielgerichtetes Testen mit Nachweis.
- Im Zyklus **+ Explorative Sitzung** anlegen:
  - **Auftrag (Charter)**: Ziel, z. B. „Erkunde den Druck großer Akten, um Abbrüche zu finden“;
  - Bereiche, **Zeitrahmen (Timebox)** und Tester.
- **⧉ Öffnen** öffnet die Sitzung im eigenen Fenster:
  - **▶ Start / ⏸ Pause**: Zeitnahme gegen die Timebox.
  - **Protokoll**: Notizen, Screenshots per Strg+V. Es wird alle 30 Sekunden und beim Verlassen gesichert
    („gesichert HH:MM“). Protokollieren geht erst nach dem Start.
  - **Beobachtungen**: 🐞 Fehler, ❓ Frage, 💡 Idee, 📝 Notiz, Erfassen mit Enter. Bei Fehlern: **Text kopieren**
    und **→ Fehler verknüpfen**; **→ Testfall** legt einen Testfall an.
  - **■ Abschließen**: nur mit Zusammenfassung (abgedeckt, nicht abgedeckt, Risiken). Danach ist die Sitzung
    schreibgeschützt.
  - **🐞 Als Fehler anlegen** (bei Fehler-Beobachtungen ohne Ticket): Titel (vorbelegt aus der ersten Zeile) und
    optional **Schweregrad** angeben, dann **Fehler anlegen**. Anemo legt den Fehler im Ticketsystem des Projekts
    (OpenProject bzw. Jira, siehe unten) an, mit Beobachtung, Auftrag, Tester, Zyklus und Rückverweis auf die Sitzung,
    und verknüpft ihn mit der Beobachtung. Das geht auch nach Abschluss der Sitzung.
- **Nachbesprechung** (Testleitung): Ergebnis des Gesprächs und Zeitanteile Testen / Fehlerbearbeitung /
  Vorbereitung (zusammen 100 %). Die Sitzung gilt dann als *nachbesprochen*.
- Sitzungen erscheinen im Testprotokoll des Zyklus; Fehlerfunde ohne Ticket erscheinen als Restrisiko im Cockpit.

## Zyklus abschließen, archivieren, löschen
Im Menü **⋯ Mehr** des Zyklus:
- **🔒 Zyklus abschließen**: Danach lassen sich keine Ergebnisse mehr erfassen und keine Tests mehr aufnehmen;
  Nachtests landen im nächsten offenen Zyklus desselben Plans und derselben Konfiguration. **🔓 Zyklus wieder öffnen**
  hebt das auf.
- **🗄 Archivieren**: blendet den Zyklus in Listen und auf der Startseite aus und schließt ihn ab. Ergebnisse und
  Berichte bleiben erhalten. **↺ Wiederherstellen** (im Menü oder im Hinweis über dem Zyklus) macht das rückgängig. Archivierte Zyklen zeigt die Zyklusliste über den Filter „mit archivierten“ bzw. „nur archivierte“.
- **🗑 Löschen …**: nur für Zyklen ohne Ergebnisse und ohne begonnene explorative Sitzungen, sonst archivieren.

## Ergebnisse automatisierter Tests
Im Zyklus **⋯ Mehr → ⇧ Automatisierte Ergebnisse …** übernimmt eine Ergebnisdatei aus der Testautomatisierung
(höchstens 20 MB). Das Format wird **automatisch erkannt**: JUnit, Cucumber, Behave, TestNG, NUnit, xUnit.net, MSTest
(TRX), Robot Framework, Playwright und Jest (.xml, .json, .trx).
- **Ziel**: *in diesen Zyklus* oder *neuer bzw. gleichnamiger Zyklus* (Zyklusname, Build optional).
- **Zuordnung** zum Testfall über einen gespeicherten Automatisierungsverweis, den Testfallschlüssel (z. B. `DEMO-T12`)
  im Namen, Tag oder in der Kategorie, oder den Jira-Altschlüssel.
- **Nicht zugeordnet**: Ergebnisse ohne Treffer stehen danach in einer Liste. Einmal über „Testfall zuordnen …“
  verbinden, ab dem nächsten Import werden sie automatisch übernommen.
- **Für fehlgeschlagene Tests Fehler anlegen** (wenn für das Projekt ein Ziel für Fehler eingerichtet ist, siehe
  *Fehler melden*): Ein offener Fehler des Testfalls wird wiederverwendet, sonst entsteht ein neuer; höchstens 20 neue
  je Import.

Für Pipelines gibt es denselben Import per API, siehe [Zusammenarbeit](05-zusammenarbeit.md).

## CI-Pipeline starten
Ist dem Projekt ein GitLab-Repository zugeordnet (Administration → Anbindungen → GitLab), startet **⋯ Mehr → ▶
CI-Pipeline starten…** (Rolle *Pflegen*) eine GitLab-Pipeline für den Zyklus:
- **Branch/Tag** (optional): ohne Angabe der *Zweig für CI* der GitLab-Zuordnung, sonst deren Gherkin-Zweig.
- **Variablen** (je Zeile `SCHLÜSSEL=Wert`, höchstens 20): eigene Variablen, die mit `ANEMO_` beginnen, werden
  ignoriert.
- Die Pipeline erhält immer `ANEMO_URL`, `ANEMO_PROJECT`, `ANEMO_CYCLE_ID`, `ANEMO_CYCLE_NAME` und, wenn der Zyklus
  einen Build hat, `ANEMO_BUILD`. Damit meldet sie ihre Ergebnisse in genau diesen Zyklus zurück (Beispiel:
  [Zusammenarbeit](05-zusammenarbeit.md#ci-pipeline-aus-anemo-starten)).
- **Letzte Läufe** zeigt Pipeline-Nummer (Link nach GitLab), Branch/Tag, Status und wer gestartet hat;
  **↻ Status aktualisieren** fragt laufende Pipelines erneut ab. Der letzte Lauf steht als Chip „CI <Zweig> <Status>“
  neben dem Zyklusnamen.
- Abgeschlossene und archivierte Zyklen lassen sich nicht anstoßen. Ist GitLab nicht eingerichtet, zeigt der Eintrag
  „(nicht verfügbar)“ mit Grund.

## Excel-Rundlauf (Durchführung ohne Anemo)
Für Testumgebungen ohne Zugriff auf Anemo: **⋯ Mehr → ⇅ Excel-Rundlauf…** im Zyklus.
1. **Ausgeben**: optional *nur mir zugewiesene* und *nur offene* (Standard), dann **⇩ Arbeitsmappe herunterladen**.
   Die Arbeitsmappe hat die Blätter:
   - **Ausführungen**: je Ausführung eine Zeile (Ausführungs-ID, Stand, Schlüssel, Titel, Version, Zuständig,
     Bisheriger Status);
   - **Schritte**: je Schritt eine Zeile (Ausführungs-ID, Schlüssel, Schritt, Schritt-ID, Aktion, Testdaten,
     Erwartetes Ergebnis, Bisheriger Status);
   - **Statuswerte**: zulässige Status mit Geltung (nur Schritte, nur Ausführungen, beides);
   - **Hinweise**: Zyklus, Zeitpunkt der Ausgabe und Ausfüllhilfe.
2. **Ausfüllen**: nur diese Spalten – im Blatt *Ausführungen* **Neuer Status**, **Kommentar**, **Fehler
   (Schlüssel)** (mehrere mit Komma; reine Zahlen gelten als OpenProject-Nummer, sonst Jira-Schlüssel) und **Dauer
   (Min.)**; im Blatt *Schritte* **Neuer Status** und **Befund**. Status wie im Blatt *Statuswerte*. Fehlt der neue
   Gesamtstatus, leitet Anemo ihn aus den Schritten ab. *Ausführungs-ID*, *Stand* und *Schritt-ID* nicht ändern.
3. **Einlesen** (Rolle *Ausführen*): die ausgefüllte `.xlsx` wählen oder hineinziehen. Anemo macht sofort einen
   **Probelauf** und zeigt je Zeile *übernommen*, *unverändert*, *Konflikt* oder *Fehler*, speichert aber nichts.
   **Übernehmen** speichert dann die Ergebnisse.

- Jede Zeile wird einzeln geprüft; ein Fehler in einer Zeile hält die übrigen nicht auf. Nachweispflicht und die
  Regel „Nur Zuständige“ gelten auch hier.
- **Konflikt**: Die Ausführung wurde seit der Ausgabe in Anemo geändert und wird nicht überschrieben. Mit **auch seit
  der Ausgabe geänderte überschreiben (Konflikte übernehmen)** werden auch diese Zeilen übernommen; der Probelauf
  läuft dabei neu.
- In abgeschlossene Zyklen lässt sich nichts einlesen. Die Datei darf etwa 20 MB groß sein.

## Exporte
- Zyklus: **⋯ Mehr → ⇩ Export Excel**: alle Ausführungen, mit Blatt *Schrittergebnisse*.
- Testplan, Tab *Ergebnis-Matrix*: **⇩ Excel** (ganze Matrix, bis 200 Zyklen) bzw. **⇩ CSV**.
- Ausführungssuche: **⇩ Excel** / **⇩ CSV** der Treffer.

## Fehler melden und Nachtest
- **🐞 Fehler melden** (Werkzeugleiste unter dem Ergebnis bzw. am Schritt): Die Vorlage füllt Titel und Beschreibung (Umgebung, Konfiguration,
  Schritte mit Fehlerstelle, erwartet/tatsächlich, Evidenzen, Rückverweis). **✨ Formulieren** lässt die KI Titel und
  Beschreibung aus Schritten, Befunden, Durchläufen und Konfiguration schreiben. Optional den **Schweregrad** wählen.
  Text prüfen, dann:
  - **In OpenProject anlegen** bzw. **In Jira anlegen**: der Fehler wird erzeugt und mit der Ausführung (und ggf. dem
    Schritt) verknüpft. Der Dialog nennt das Ziel („Wird in … angelegt“); oder
  - **Text kopieren** und den anderswo angelegten Fehler per Schlüssel oder als Link verknüpfen (auch mit Schweregrad).
- **Ziel für neue Fehler**: das zugeordnete OpenProject-Projekt. Nur wenn keines zugeordnet ist, die Einstellung
  *Fehler in Jira anlegen* eingeschaltet und das Projekt einem Jira-Projekt zugeordnet ist, legt Anemo den Fehler in
  Jira an (siehe [Administration](10-administration.md#anbindungen)). Dasselbe Ziel gilt für Sitzungsfunde und für
  Fehler aus automatisierten Ergebnissen.
- **Schweregrad** (aus Sicht des Tests): *Blocker*, *Kritisch*, *Schwer*, *Mittel*, *Gering* oder keine Angabe. Er
  steht in der Beschreibung des Tickets („Schweregrad (Anemo)“), bei Jira optional auch als Priorität laut
  Projektzuordnung. An verknüpften Fehlern lässt er sich in der Liste der Verweise jederzeit ändern (Auswahl
  *Schweregrad –*); das Ticket selbst ändert sich dadurch nicht.
- **Nachtest**: Wechselt ein verknüpfter Fehler in OpenProject oder Jira auf *behoben*, legt Anemo im jüngsten
  offenen Zyklus desselben Testplans mit **gleicher Konfiguration** eine neue Ausführung an (sonst im ursprünglichen
  Zyklus, falls er noch offen ist), zugewiesen an die Person, die den Fehler gefunden hat. Eine andere Konfiguration
  kommt nie in Frage – ein Fehler unter Oracle wird nicht unter SQL Server nachgetestet. Gibt es keinen passenden
  offenen Zyklus, steht das im Protokoll („Nachtest ohne Zielzyklus“), und das Release-Cockpit führt den Testfall
  unter **Behoben, aber nicht nachgetestet**. Abgelehnte oder zurückgestellte Fehler lösen keinen Nachtest aus,
  ebenso wenig ein bereits wartender Nachtest. Mit E-Mail-Benachrichtigung, wenn diese eingerichtet ist.
- **Ergebnis des Nachtests im Ticket**: Ist das Projekt einem OpenProject-Projekt zugeordnet, schreibt Anemo das
  abschließende Ergebnis des Nachtests als Kommentar an das Arbeitspaket („✅ Nachtest bestanden“ bzw. „❌ Nachtest
  nicht bestanden“, mit Link). Fehler aus explorativen Sitzungen haben keinen Testfall und damit keinen
  automatischen Nachtest – sie werden in einer neuen Sitzung erneut erkundet.

## Protokoll
*Planung & Ausführung → Protokoll* (Rolle *Pflegen*): alle fachlichen Änderungen im Projekt mit Person und
Zeitpunkt, neueste zuerst – Ergebnisse, Einplanungen, Verweise, Freigaben, aber auch Änderungen an
Ausstiegskriterien, Testplänen, Zyklen (auch das Verschieben in einen anderen Plan), Abschließen und Wiederöffnen von
Zyklen, Projektregeln und dem Fazit, jeweils mit **altem und neuem Wert**. Filter nach Ereignis, Person und
Zeitraum; **⇩ CSV** exportiert die Auswahl, z. B. für Revision oder Auftraggeber. Das Protokoll ist in der Datenbank
gegen Ändern und Löschen gesperrt; beim Löschen eines Projekts werden nur Kommentarauszüge entfernt (Datenschutz).

## Nur Zuständige erfassen Ergebnisse
Ist für das Projekt die Regel **Nur Zuständige** eingeschaltet (Administration → Projekte & Rechte), gilt:
- Eine **zugewiesene** Ausführung kann nur die zuständige Person erfassen, auch per Schnellausführung,
  Massenbearbeitung oder Excel-Rundlauf. Andere erhalten die Meldung „In diesem Projekt erfasst nur die zuständige
  Person Ergebnisse“ mit den betroffenen Testfällen.
- **Nicht zugewiesene** Ausführungen bleiben für alle mit Rolle *Ausführen* offen.
- Die **Testleitung** (Rolle *Pflegen*) ist ausgenommen und kann jede Ausführung erfassen.

## Mir zugewiesen
Alle offenen Ausführungen, die Ihnen zugewiesen sind, über alle Zyklen des Projekts. **▶ Durchführen (n offen)**
startet mit der ersten im Fokusfenster. Kurzfassung auch auf der Startseite unter *Meine Aufgaben*.

## Ergebnisse von KI-Agenten
Ergebnisse, die ein Agentenkonto erfasst, sind mit **🤖 zu prüfen** markiert. Unter *KI-Ergebnisprüfung* (oder im
Banner der Ausführung) **bestätigen** oder **ablehnen** – nur die Testleitung (Rolle *Pflegen*). Bis zur Prüfung
zählen sie in Kennzahlen als offen. Ein ungeprüftes Agentenergebnis kann nur die Testleitung durch ein eigenes
ersetzen (vermerkt als „ersetzt“); mit der Rolle *Ausführen* ist das gesperrt, auch in der Massenbearbeitung. Ablehnen setzt den Test zurück und schreibt die Begründung in den
Kommentar. **Eskaliert** bedeutet: Der Agent war unsicher und übergibt an einen Menschen.
