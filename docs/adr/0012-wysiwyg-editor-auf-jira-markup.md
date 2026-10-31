# ADR-0012: WYSIWYG-Editor auf Basis von Jira-Wiki-Markup, eigene Umsetzung mit Verlustprüfung

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Beschreibungen, Vorbedingungen, Schritte und Ausführungskommentare sollen visuell bearbeitet werden, inklusive
Screenshots per Einfügen und Ablegen. Der gesamte migrierte Bestand liegt als Jira-Wiki-Markup vor, und Anemo stellt ihn bereits über einen eigenen Parser sicher dar (ohne innerHTML).
Fertige Editoren (ProseMirror/TipTap, Lexical) bringen zehn und mehr Pakete mit und kennen Jira-Markup nicht. Ein
Wechsel des Speicherformats (HTML/JSON) hätte zwei Formate im Bestand bedeutet.

## Entscheidung
- **Speicherformat bleibt Jira-Wiki-Markup.** Der Editor arbeitet auf dem Strukturbaum des vorhandenen Parsers:
  Markup → Baum → bearbeitbares DOM (`contentEditable`) → Baum → Markup (`serialize.ts`, `dom.ts`).
- **Keine neue Abhängigkeit.** Formatierung über die Browser-Editierbefehle, Werkzeugleiste mit Fett, Kursiv,
  Unterstrichen, Durchgestrichen, Code, Farbe, Überschrift, Listen (Tab rückt ein), Zitat, Codeblock, Tabelle,
  Hinweiskasten (Panel), Link (Strg+K) und Datei. Ein Umschalter führt in den Markup-Modus.
- **Verlustfreiheit wird geprüft, nicht angenommen:** Ein Feld öffnet nur dann visuell, wenn
  `parse(serialize(parse(text)))` dem Baum gleicht *und* das aufgebaute DOM genau diesen Baum zurückliefert.
  Sonst öffnet es im Markup-Modus mit Hinweis. In einem migrierten Bestand öffnen nahezu alle Felder visuell. Unverändert gelassene Felder werden nie neu
  geschrieben.
- **Einfügen bereinigt:** Eingefügtes HTML (Word, Browser) wird über denselben Baum gelesen. Übrig bleibt nur, was
  Jira-Markup ausdrücken kann; Skripte, Stile, Ereignisattribute und `javascript:`-Ziele entfallen.
- **Anhänge:** Eingefügte bzw. abgelegte Dateien werden mit eindeutigem Namen hochgeladen
  (`screenshot-JJJJMMTT-hhmmss.png`) und als `!name!` bzw. `[^name]` eingebettet. Am Testfall erfordert das die Rolle
  „Pflegen“, an der Ausführung „Ausführen“ (Evidenz je Schritt oder Gesamtergebnis). Bei neuen Testfällen werden
  Dateien vorgemerkt und nach dem Anlegen hochgeladen. Der Server prüft, dass der Besitzer existiert, und liefert
  nur unbedenkliche Typen inline aus.

## Konsequenzen
Bestand und Neuerfassung haben ein Format; Export und Rückweg nach Jira bleiben einfach. Konstrukte, die Jira
selbst nur eingeschränkt kann (z. B. Formatierung mitten im Wort, verschachtelte Panels), bleiben im
Markup-Modus bearbeitbar. Die Editierbefehle des Browsers gelten als veraltet, werden aber von allen Browsern
unterstützt. Sollte das einmal nicht mehr gelten, lässt sich die Editorfläche austauschen, ohne Speicherformat und
Verlustprüfung zu ändern.
