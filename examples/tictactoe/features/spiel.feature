# language: de
@TTT
Funktionalität: Tic-Tac-Toe spielen
  Als Spieler möchte ich abwechselnd mit einer zweiten Person Felder setzen,
  damit wir sehen, wer zuerst drei in einer Reihe hat.

  Grundlage:
    Angenommen ein neues Spiel ist geöffnet

  @TTT-T1
  Szenario: X beginnt
    Dann steht "X ist am Zug" im Status
    Und alle 9 Felder sind leer

  @TTT-T2
  Szenario: Spieler wechseln sich ab
    Wenn ich "Feld oben links" wähle
    Dann zeigt "Feld oben links" ein "X"
    Und steht "O ist am Zug" im Status

  @TTT-T3
  Szenario: Ein belegtes Feld kann nicht erneut gewählt werden
    Wenn ich "Feld Mitte" wähle
    Dann ist "Feld Mitte" nicht mehr wählbar

  @TTT-T4
  Szenariogrundriss: Drei in einer Reihe gewinnt
    Wenn X die Felder <x> und O die Felder <o> wählen
    Dann steht "X gewinnt!" im Status
    Und sind die Gewinnfelder <x> markiert

    Beispiele:
      | x                                                | o                                 |
      | Feld oben links, Feld oben Mitte, Feld oben rechts | Feld unten links, Feld unten Mitte |
      | Feld oben links, Feld Mitte, Feld unten rechts     | Feld oben Mitte, Feld oben rechts  |
      | Feld oben rechts, Feld Mitte rechts, Feld unten rechts | Feld Mitte links, Feld Mitte  |

  @TTT-T5
  Szenario: Unentschieden
    Wenn X die Felder Feld oben links, Feld oben rechts, Feld Mitte rechts, Feld unten links, Feld unten Mitte und O die Felder Feld oben Mitte, Feld Mitte links, Feld Mitte, Feld unten rechts wählen
    Dann steht "Unentschieden" im Status

  @TTT-T6
  Szenario: Nach dem Sieg ist das Brett gesperrt, „Neues Spiel“ beginnt von vorn
    Wenn X die Felder Feld oben links, Feld oben Mitte, Feld oben rechts und O die Felder Feld unten links, Feld unten Mitte wählen
    Dann sind alle freien Felder gesperrt
    Wenn ich „Neues Spiel“ wähle
    Dann steht "X ist am Zug" im Status
    Und alle 9 Felder sind leer
