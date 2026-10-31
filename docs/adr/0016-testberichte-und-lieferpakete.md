# ADR-0016: Testberichte nach ISO/IEC/IEEE 29119-3 als HTML/Markdown/JSON, Lieferpaket mit Prüfsummen und Signatur

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Testnachweise werden an Kunden und Abnahmen ausgeliefert. Sie sollen einem anerkannten Aufbau folgen, ein
anpassbares Erscheinungsbild haben und prüfbar sein. Der Container soll schlank bleiben, ohne Headless-Browser
und ohne PDF-Bibliothek.

## Entscheidung
- Drei Berichtsarten in Anlehnung an **ISO/IEC/IEEE 29119-3**:
  - **Testprotokoll** (Test Log) je Zyklus
  - **Testabschlussbericht** (Test Completion Report) je Testplan/Release: aktueller Stand je Testfall,
    Abweichungen, Fehler, offene Punkte und eine regelbasierte Freigabeempfehlung
  - **Testfallspezifikation** je Projekt/Ordner
- Ein gemeinsames **Datenmodell** (`reports/data.ts`) dient zugleich als maschinenlesbares JSON. Ausgaben sind
  **HTML** (eigenständig, druckfertig für A4; PDF über „Drucken → Als PDF speichern“), **Markdown** und **JSON**.
- **Berichtsprofile** (`report_profile`) steuern Organisation, Akzentfarbe, Fußzeile, Normhinweis, Abschnitte und
  die Rollen im Freigabeblock.
- Der Wiki-Parser liegt jetzt in `shared/wiki` und wird von Web und Server gemeinsam genutzt. Das HTML wird
  serverseitig maskiert erzeugt, ohne durchgereichtes Markup.
- **Lieferpaket** je Testplan als ZIP (eigener Streaming-Schreiber, ohne Abhängigkeit). Es enthält
  Abschlussbericht (HTML/MD), Testprotokolle je Zyklus, `ergebnisse.json`, nur die referenzierten Evidenzen,
  `manifest.json`, `SHA256SUMS` und eine Prüfanleitung. Mit `ANEMO_SIGNING_KEY_FILE` (Ed25519, PEM) wird
  `SHA256SUMS` signiert; der öffentliche Schlüssel liegt bei.

## Konsequenzen
PDF entsteht im Browser. Echte serverseitige PDF/A-Erzeugung wäre ein späterer, optionaler Baustein (z. B. ein
getrennter Dienst). Die Freigabeempfehlung ist eine Regel und keine Entscheidung; der Freigabeblock bleibt zum
Unterschreiben. Pakete sind auf 4 GiB begrenzt (kein ZIP64).

## Nachtrag 2026-10-30: barrierefreies und archivfähiges PDF
Der Server erzeugt das PDF selbst (`server/src/platform/pdf.ts`, weiterhin ohne Bibliothek), ausgerichtet an PDF/UA-1
(BITV 2.0) und PDF/A-2b für die revisionssichere Ablage:
- Tagged PDF mit Strukturbaum (Überschriften ohne Ebenensprung, Absätze, Listen, Tabellen mit Spaltenköpfen, Code),
  Kopf-/Fußzeilen und Linien als Artefakte, Sprache `de-DE`, Titel in Info und XMP, `DisplayDocTitle`.
- Eingebettete Schriftteilmengen aus DejaVu Sans/Sans Mono (`server/assets/fonts`, Bitstream-Vera-Lizenz) mit
  ToUnicode – Zeichen wie ✓ ✗ → ≥ bleiben erhalten; OutputIntent sRGB (`server/assets/icc`, CC0), Dokument-ID.
- Beide Dateigruppen stehen als mitgelieferte Komponenten mit Prüfsummen in `config/third-party.json` (ADR-0026).
- Bilder enthält das PDF weiterhin nicht. Eine Prüfung mit veraPDF bzw. PAC gehört vor die Abnahme durch Behörden.
