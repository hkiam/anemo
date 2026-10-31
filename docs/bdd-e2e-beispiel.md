# Beispiel: Oberflächentests mit BDD, Playwright und KI – am Tic-Tac-Toe

Dieses Kapitel zeigt an einem kleinen Programm einen modernen, durchgängigen Ablauf zum Nachmachen:

**Anforderung → Gherkin-Szenarien (mit KI-Entwurf) → Review in Anemo → automatisierter Playwright-Lauf →
Ergebnisse in Anemo → Fehler, Nachtest, Freigabe.**

Alles liegt lauffähig im Repository unter [`examples/tictactoe`](../examples/tictactoe). Der Ablauf ist
Bestandteil der Ende-zu-Ende-Tests von Anemo (`e2e/tests/automation.spec.ts`).

```bash
npx playwright test -c examples/tictactoe      # 8 Szenarien, Ergebnis zusätzlich als JUnit
```

## 1. Die Anwendung
Ein Spielbrett mit neun Feldern, Statuszeile und „Neues Spiel“ ([app/index.html](../examples/tictactoe/app/index.html),
[app/spiel.js](../examples/tictactoe/app/spiel.js)).

Wichtig für gute Oberflächentests ist schon der Entwurf der Oberfläche:
- **Zugängliche Namen statt Test-IDs**: Jedes Feld ist ein Button mit Namen („Feld oben links“, nach dem Zug
  „Feld oben links: X“). Der Status hat `role="status"`, das Brett `role="grid"`.
- Dieselben Namen verwenden Screenreader, Playwright (`getByRole`) und KI-Agenten. Tests werden lesbar und
  überstehen Umbauten im HTML/CSS.

## 2. Anforderung → Szenarien
Anforderung (Ausschnitt): *„Zwei Personen setzen abwechselnd X und O; X beginnt. Wer zuerst drei in einer Reihe
hat, gewinnt; danach ist das Brett gesperrt. Sind alle Felder belegt, ist es unentschieden.“*

In Anemo erzeugt **Testfälle → ✨ Aus Anforderung** daraus einen Entwurf mit Schritten und Gherkin. Der Prompt
lässt sich unter *Administration → KI → Prompts* anpassen. Die Testanalystin prüft und schärft den Entwurf:
- Randfälle ergänzen: belegtes Feld, Unentschieden, Sperre nach Sieg.
- Gleichartige Fälle als **Szenariogrundriss mit Beispielen** zusammenfassen.

Das Ergebnis ist [features/spiel.feature](../examples/tictactoe/features/spiel.feature):

```gherkin
# language: de
@TTT
Funktionalität: Tic-Tac-Toe spielen

  Grundlage:
    Angenommen ein neues Spiel ist geöffnet

  @TTT-T2
  Szenario: Spieler wechseln sich ab
    Wenn ich "Feld oben links" wähle
    Dann zeigt "Feld oben links" ein "X"
    Und steht "O ist am Zug" im Status

  @TTT-T4
  Szenariogrundriss: Drei in einer Reihe gewinnt
    Wenn X die Felder <x> und O die Felder <o> wählen
    Dann steht "X gewinnt!" im Status
    Und sind die Gewinnfelder <x> markiert

    Beispiele:
      | x                                                  | o                                  |
      | Feld oben links, Feld oben Mitte, Feld oben rechts | Feld unten links, Feld unten Mitte |
      | Feld oben links, Feld Mitte, Feld unten rechts     | Feld oben Mitte, Feld oben rechts  |
```

**Regeln für gute Szenarien:**
- fachliche Sprache statt Klickpfaden;
- ein Verhalten je Szenario;
- beobachtbare Erwartungen (`Dann …`);
- das Tag `@TTT-T4` verbindet das Szenario mit dem Testfall in Anemo.

Die Testfälle liegen in Anemo im Format **Gherkin**, mit Live-Prüfung im Editor. Über **⎇ Git** werden sie als
`.feature`-Dateien mit dem Repository abgeglichen. Entwicklung und QA arbeiten so an derselben Datei.

## 3. Szenarien ausführbar machen
[bdd/steps.ts](../examples/tictactoe/bdd/steps.ts) ordnet jeder Formulierung einen regulären Ausdruck und
Playwright-Code zu:

```ts
Schritt(/^ich ["„](.+?)["“] wähle$/, async (page, name) => {
  await page.getByRole('button', { name: new RegExp(`^${name}(: [XO])?$`) }).click();
});
Schritt(/^steht ["„](.+?)["“] im Status$/, async (page, text) => {
  await expect(page.getByRole('status')).toHaveText(text);
});
```

- [tests/spiel.spec.ts](../examples/tictactoe/tests/spiel.spec.ts) liest die Feature-Datei und erzeugt je Szenario
  einen Playwright-Test.
- Jeder Gherkin-Schritt erscheint als eigener Schritt in Bericht und Trace.
- Der Mini-Leser [bdd/gherkin.ts](../examples/tictactoe/bdd/gherkin.ts) hat bewusst nur gut 60 Zeilen, damit man
  das Prinzip sieht. In echten Projekten nimmt man **playwright-bdd** oder **Cucumber.js** (gleiche Feature-Dateien,
  Cucumber-JSON-Bericht mit Schrittergebnissen).

**Effizienz-Tipps:**
- **Wenige, wiederverwendbare Schritte** mit Parametern statt einer Definition je Satz. 9 Definitionen tragen hier
  8 Szenarien.
- **`getByRole`/`getByLabel` statt CSS-Selektoren**: stabil, lesbar und gleichzeitig ein Barrierefreiheits-Test.
- **Auto-Waiting** von Playwright statt fester Wartezeiten. **Trace on failure** (`trace: 'retain-on-failure'`)
  zeigt bei Fehlern jeden Schritt mit DOM-Snapshot.
- Ein **unbekannter Schritt** schlägt mit klarer Meldung fehl, und die fehlende Definition lässt sich gezielt
  ergänzen, auch per KI (unten).

## 4. KI im Ablauf – wo sie hilft
| Schritt | KI-Unterstützung | Mensch |
|---|---|---|
| Szenarien finden | Entwurf aus der Anforderung (Anemo ✨), Randfälle vorschlagen | prüft fachlich, entscheidet |
| Schrittdefinitionen | Coding-Assistent erzeugt fehlende Definitionen aus der Feature-Datei und dem Seitenaufbau, z. B. über **Playwright MCP**, das die Seite als Zugänglichkeitsbaum sieht | Review wie normaler Code |
| Lokatoren | `npx playwright codegen http://localhost:8111` zeichnet Klicks als `getByRole`-Code auf | übernimmt Passendes |
| Fehleranalyse | Trace und Screenshot an den Assistenten: „Warum schlägt TTT-T5 fehl?“ | bewertet, korrigiert |
| Manuelle Restfälle | KI-Agent führt Gherkin-Testfälle über MCP in Anemo aus und hängt Screenshots an | **QA-Freigabe** in Anemo (🤖 Freigaben) |

Ein Prompt für fehlende Schrittdefinitionen, z. B. im Coding-Assistenten:
```text
Hier sind spiel.feature und bdd/steps.ts. Ergänze Definitionen für alle Schritte, die noch keine haben.
Verwende ausschließlich getByRole/getByLabel/getByText, keine CSS-Selektoren, keine festen Wartezeiten.
Fasse ähnliche Formulierungen mit Parametern zusammen. Nutze die laufende App unter http://localhost:8111
(Playwright MCP), um Rollen und Namen zu prüfen.
```

## 5. Ergebnisse in Anemo
Der Playwright-Lauf schreibt `results/junit.xml`. Die Testnamen tragen die Tags, z. B.
„Spieler wechseln sich ab @TTT-T2“. Die Pipeline übergibt das Ergebnis mit einem API-Token (Rolle „Ausführen“):

```bash
curl --fail -X POST -H "Authorization: Bearer $ANEMO_TOKEN" -H "Content-Type: application/xml" \
  --data-binary @examples/tictactoe/results/junit.xml \
  "https://anemo.firma.de/api/projects/TTT/automation-results?cycle=Nightly%20$CI_COMMIT_REF_NAME&build=$CI_PIPELINE_IID"
```

Was dabei passiert:
- Anemo legt den Zyklus „Nightly …“ an bzw. verwendet ihn wieder und ordnet die Ergebnisse über die Tags den
  Testfällen TTT-T1 bis TTT-T6 zu.
- Die drei Beispiele des Grundrisses `@TTT-T4` werden zu einem Ergebnis zusammengefasst; es zählt das
  schlechteste.
- Fehlermeldungen landen im Kommentar.
- Mit Cucumber-JSON kommen zusätzlich Schrittergebnisse.

Danach weiter wie bei manuellen Tests:
- Fehlschlag → **🐞 Fehler melden** mit Vorlage (OpenProject, Jira-Verweis).
- Nach der Korrektur → **↻ Wiederholen → nur Nachtest**.
- **Release-Cockpit** und **Testabschlussbericht** zeigen manuelle und automatisierte Ergebnisse gemeinsam.

## 6. Zum Nachmachen in der Schulung
1. `npx playwright test -c examples/tictactoe` laufen lassen, dann `npx playwright show-report` öffnen.
2. In `app/spiel.js` einen Fehler einbauen (z. B. Diagonale `[2, 4, 6]` aus `LINIEN` entfernen) und erneut laufen
   lassen. Kein Szenario schlägt fehl. Das ist die Lücke, und ein Beispiel ergänzen schließt sie.
3. Ein neues Szenario schreiben („O gewinnt“), den fehlenden Schritt per KI ergänzen lassen und reviewen.
4. In Anemo ein Projekt `TTT` anlegen, die Szenarien als Gherkin-Testfälle erfassen (oder per ✨ entwerfen
   lassen), Ergebnis per `curl` übergeben und im Zyklus ansehen.
