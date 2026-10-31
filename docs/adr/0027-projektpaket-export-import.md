# ADR-0027: Projektpaket für Export und Import von Projekten

**Status:** angenommen (29.10.2026)

## Kontext
Projekte sollen komplett oder auszugsweise zwischen Anemo-Instanzen übertragen, kopiert und archiviert werden. Bisher
gibt es nur Teilwege (Testfälle als CSV/XLSX, Offline-Rundlauf je Zyklus, Kopieren innerhalb der Instanz) und die
Sicherung der ganzen Instanz. Keiner davon überträgt Versionen, Aufrufe, Vorbedingungen, Ausführungen und Anhänge
gemeinsam und konsistent.

## Entscheidung
- Eigenes Austauschformat **Projektpaket** (`*.anemo.zip`): `manifest.json` mit eigener Formatversion (SemVer) und
  SHA-256 je Datei, Fachdaten als NDJSON je Typ, Anhänge inhaltsadressiert unter `files/`. Details:
  [Projekt exportieren und importieren](../projekt-export-import.md).
- Das Paket bildet das **fachliche Modell** ab, nicht die Tabellen: Es ist unabhängig vom Stand der DB-Migrationen;
  Formatänderungen werden über Upgrade-Funktionen im Formatmodul aufgefangen.
- Beim Import erhält **jedes Objekt eine neue ID**; alle Bezüge (auch in JSON-Feldern) werden über eine zentrale
  Liste der ID-Fundstellen übersetzt. Herkunft wird in `package_identity` festgehalten, damit ein erneuter Import
  aktualisiert statt zu verdoppeln.
- Testfallversionen werden unverändert übernommen (ADR-0004); „Aktualisieren“ erzeugt neue Versionen.
- Import immer mit **Probelauf**, Einspielen in einer Transaktion, Anhänge über einen Bereitstellungsordner.
- Geheimnisse, Tokens, Protokolle, Domain-Events und Migrationsdaten werden nie exportiert. Personen werden per
  Login/E-Mail zugeordnet oder auf Wunsch pseudonymisiert (ADR-0006).
- Keine neuen Abhängigkeiten: ZIP-Leser als Gegenstück zu `platform/zip.ts`; Schreiber und Leser beherrschen
  **ZIP64** (Pakete über 4 GiB, mehr als 65 535 Einträge).
- Integrität über **SHA-256-Prüfsummen**, keine Signatur.
- Export und Import brauchen das neue instanzweite Recht **„Projekte übertragen“** (`PROJECT_TRANSFER`), vergeben
  durch die Systemadministration an Nutzer oder Gruppen, zusätzlich zu `PROJECT_ADMIN` im Quell- bzw. Zielprojekt.
  Exporte aus Projekten mit erhöhter Sensibilität (ADR-0014) brauchen außerdem eine Freigabe durch die
  Systemadministration. Alle Exporte und Importe werden protokolliert.
- In bestehende Projekte darf **alles** importiert werden, auch Pläne, Zyklen und Ausführungen; Ausführungen in
  abgeschlossenen Zyklen des Ziels werden nie überschrieben.

## Alternativen
- **pg_dump je Projekt** (gefilterte Tabellen): an den Schemastand gebunden, keine ID-Übersetzung, kein selektiver
  Umfang, Import in bestehendes Projekt nicht möglich. Verworfen.
- **CSV/XLSX erweitern:** verliert Versionen, Bezüge und Anhänge; für Rundläufe ungeeignet. Bleibt Austauschformat
  für Fremdwerkzeuge.
- **REST-basierte Synchronisation zwischen Instanzen:** setzt Netzverbindung und Vertrauen zwischen Instanzen voraus;
  später auf Basis des Paketformats möglich.

## Konsequenzen
- Neues Modul `server/src/modules/transfer` mit Formatmodul, Export, Import und Probelauf.
- Das Rechtemodell (ADR-0011) bekommt neben den Rollen je Projekt instanzweite Rechte (`global_permission`);
  `PROJECT_TRANSFER` ist das erste davon.
- Jede neue Tabelle oder Spalte mit Bezügen muss in die Liste der ID-Fundstellen; ein Test erzwingt das.
- Ein Rundlauftest (Export → Import → Export) sichert die Verlustfreiheit dauerhaft ab.
