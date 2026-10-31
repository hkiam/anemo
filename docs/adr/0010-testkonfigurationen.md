# ADR-0010: Testkonfigurationen als erkannte, korrigierbare Merkmale

- Status: angenommen
- Datum: 2026-10-11

## Kontext
In Zephyr ist die Umgebung eines Zyklus Freitext („SQL/ORA“, „SC - ORADB“, „SYSTEST_Q124“). Viele Zyklen haben
gar keine Umgebungsangabe; der Kontext steckt oft im Zyklusnamen. Auswertungen je Datenbank,
Client oder Betriebssystem sind so nicht möglich.

## Entscheidung
- Merkmale (`config_dimension`) mit Werten (`config_value`) und **Erkennungsregeln als Daten** (reguläre Ausdrücke),
  abgeleitet aus dem migrierten Bestand: Datenbank, Client, Betriebssystem, Office/Dokumente, Browser,
  Testsystem/Mandant (offener Wertebereich per Extraktionsmuster), Testart.
- Ein Zyklus trägt `configuration` (je Merkmal mehrere Werte, z. B. „SQL+ORA“ → Oracle und SQL Server), die Quelle
  (`auto`/`manual`) und die **Belege** (welche Textstelle welchen Wert ausgelöst hat).
- Automatische Erkennung beim Anlegen/Ändern und per Neuklassifizierung; **manuell festgelegte Konfigurationen
  werden nie überschrieben**. Der Originaltext der Umgebung bleibt erhalten.
- Filter (`?config=database:Oracle,client:Web`, jsonb-Containment mit GIN-Index), Auswertung je Wert
  (Fehlerquote), Verwaltungsseite mit Liste nicht erkannter Angaben.
- Konfiguration gehört fachlich zum Zyklus und liegt deshalb im Modul `execution`.

## Konsequenzen
Ergebnisse lassen sich nach Kontext vergleichen; neue Zyklen können über eine Konfigurationsauswahl angelegt werden.
Erkennung ist erklärbar und korrigierbar. Grenzen: mehrdeutige Kürzel (z. B. „AC“) brauchen fachliche Klärung;
Konfiguration je einzelner Ausführung (statt je Zyklus) ist ein möglicher nächster Schritt.
