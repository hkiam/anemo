# Zephyr-Daten aus der Jira-Datenbank exportieren und laden

Wiederholbarer Ablauf, um die Daten von Zephyr for JIRA (Testschritte, Zyklen, Ausführungen, Schrittergebnisse,
Anhänge) verlustfrei zu übernehmen, wenn die Zephyr-API (ZAPI) nicht verfügbar ist. Hintergrund:
[ADR-0009](../adr/0009-zugriff-auf-zephyr-daten.md).

| | |
|---|---|
| Quelle | Jira-Server mit MySQL (getestet mit MySQL 5.5 unter Windows), Datenbankbenutzer von Jira |
| Umfang | alle Tabellen mit Präfix `AO_7DEABF_` (Zephyr for JIRA) sowie die **Zephyr-Einträge** aus Jiras Eigenschaftstabellen (`propertyentry` + Wertetabellen; dort stehen Ausführungs- und Schrittstatus mit Namen und Farben). Keine anderen Jira-Daten. |
| Wirkung auf Jira | keine: nur lesend, `mysqldump --single-transaction` (konsistenter Stand ohne Tabellensperren) |
| Ergebnis | `zephyr-dump-<Zeitstempel>.sql.gz`, `….manifest.json` und `….attachments.tar.gz` |

Die Dateien enthalten Testinhalte im Klartext. Projekte mit besonderem Schutzbedarf (z. B. Behörden) nur über
interne Wege übertragen und ausschließlich in `migration-snapshots/` ablegen (von Git ausgeschlossen). Für die
Weitergabe an Entwicklungsumgebungen gibt es die Anonymisierung (ADR-0006).

## 1. Export auf dem Jira-Server (Windows)

Einmalig das Skript `tools/windows/export-zephyr.ps1` aus diesem Repository auf den Server kopieren,
z. B. nach `C:\temp\zephyr-export\`.

Bei jedem Export in einem normalen **Windows-PowerShell**-Fenster (nicht PowerShell ISE):

```powershell
cd C:\temp\zephyr-export
powershell -ExecutionPolicy Bypass -File .\export-zephyr.ps1
```

Das Skript läuft auch unter **Windows PowerShell 2.0** (.NET 2.0/3.5), wie sie auf älteren Jira-Servern noch
vorkommt. Es verwendet deshalb nur Sprachmittel dieser Version (kein `ConvertTo-Json`, keine ZIP-Klassen, keine
asynchronen Methoden); Anhänge werden als `tar.gz` geschrieben. `tools/windows/check-ps2-compat.ps1` prüft das
automatisch (Teil des Tests).

Das Skript fragt das MySQL-Passwort verdeckt ab. `-ExecutionPolicy Bypass` gilt nur für diesen einen Aufruf und
ändert keine Systemeinstellung.

Parameter (alle optional):

| Parameter | Standard | Bedeutung |
|---|---|---|
| `-Database` | `jiradb` | Name der Jira-Datenbank (`<jira-home>\dbconfig.xml`) |
| `-User` | `jira` | MySQL-Benutzer |
| `-MySqlBin` | `C:\Program Files\MySQL\MySQL Server 5.5\bin` | Ordner mit `mysql.exe` / `mysqldump.exe` |
| `-OutDir` | `C:\temp\zephyr-export` | Zielordner |
| `-HostName`, `-Port` | `localhost`, `3306` | MySQL-Verbindung |
| `-JiraHome` | automatisch | Jira-Home (Ordner mit `dbconfig.xml` und `data\`); gesucht über `JIRA_HOME`, `jira-application.properties` und Standardpfade |
| `-SkipAttachments` | aus | Anhänge nicht exportieren |

Was das Skript tut:
1. ermittelt alle `AO_7DEABF_*`-Tabellen und zählt **exakt** (`COUNT(*)`) ihre Zeilen,
2. streamt `mysqldump` direkt in eine gzip-Datei (keine unkomprimierte Zwischendatei),
3. holt die Anhangsdateien aus dem Jira-Home. Zephyr legt sie unter
   `data\attachments\<Projekt>\<schedule|teststepresult>\<Objekt-ID>\<Anhang-ID>` ab; das Skript sucht
   zuerst **exakt dort** (Größe muss stimmen, `match = exact`) und nur ersatzweise über Größe + Name/ID im
   gesamten Anhangsverzeichnis (`match = heuristic`, wird beim Laden als Hinweis gemeldet). Gefundene Dateien kommen
   als `attachments/<Anhang-ID>` in ein `tar.gz` (Originalname, Typ, Objekt-ID und Quellpfad stehen in
   `index.json`); nicht gefundene oder mehrdeutige werden im Manifest unter `attachments.missing` einzeln aufgeführt,
4. schreibt ein Manifest mit Zeilenzahlen je Tabelle, MySQL-Version, Dauer, Anhangsbilanz und SHA-256 von Dump und
   Archiv.

Am Ende nennt das Skript alle erzeugten Dateien. Bei einem Fehler gibt es zusätzlich die genaue Skriptstelle aus
(„FEHLERSTELLE: …“).

Das Passwort wird nur an die MySQL-Prozesse übergeben (Umgebungsvariable des Kindprozesses), nicht auf der
Kommandozeile und nicht in Dateien.

Hinweis: Unter Windows sind die Tabellennamen kleingeschrieben (`ao_7deabf_…`); Skript und Loader berücksichtigen
das.

## 2. Übertragen

Alle Dateien eines Laufs (`.sql.gz`, `.attachments.tar.gz`, `.manifest.json`) nach `<Anemo>/migration-snapshots/`
kopieren (Netzwerkfreigabe, `scp` o. Ä.). Die Prüfsumme im Manifest deckt Übertragungsfehler auf.

## 3. Laden und prüfen

```bash
npm run zephyr:load -- --manifest migration-snapshots/zephyr-dump-<Zeitstempel>.manifest.json
```

1. prüft die SHA-256 von Dump und Anhangsarchiv gegen das Manifest und ob alle Anhänge enthalten sind,
2. startet die lokale MariaDB `zephyr-db` (Compose-Profil `zephyr`, Port 3316) und legt die Datenbank
   `zephyr` **neu** an – jeder Lauf beginnt sauber,
3. spielt den Dump gestreamt ein,
4. vergleicht die Zeilenzahl jeder Tabelle mit dem Manifest und schreibt
   `zephyr-dump-<Zeitstempel>.load.json` (Ergebnis `PASSED`/`FAILED`, Exit-Code 1 bei Abweichung).

Zusätzlich zählt der Loader die Datenzeilen direkt im Dump-Strom. Damit ist die Kette
**Quell-DB (Manifest) → Dump → geladene DB** je Tabelle nachgewiesen.

Ältere Dumps ohne Manifest (z. B. manuell erstellte `.sql`, `.sql.gz` oder `.zip`) lassen sich ebenfalls laden;
geprüft wird dann Dump → geladene DB:

```bash
npm run zephyr:load -- --dump migration-snapshots/zephyr-dump.zip
```

Ein neuer Export ersetzt den alten Stand vollständig; der anschließende Anemo-Import ist idempotent.

## 4. Snapshot erzeugen und importieren

Aus Jira-Snapshot (Tests, Felder, Links, Kommentare, Historie) und geladener Zephyr-Datenbank entsteht ein
vollständiger Snapshot; Defect-IDs werden dabei über Jira in Schlüssel aufgelöst. Beispiel für ein Projekt `PROJ`:

```bash
npm run migration -w server -- extract --projects PROJ --out ../migration-snapshots/proj-raw --no-zephyr --no-attachments
npm run migration -w server -- zephyr-snapshot --jira ../migration-snapshots/proj-raw --out ../migration-snapshots/proj-full \
  --attachments ../migration-snapshots/zephyr-dump-<Zeitstempel>.attachments.tar.gz
npm run migration -w server -- import --in ../migration-snapshots/proj-full
```

- Test- und Schrittstatus kommen aus Zephyrs Einstellungen im Dump (`zephyr.testcase.execution.statuses`,
  `zephyr.testcase.step.execution.statuses`). Systemstatus (−1…4) werden über ihre feste ID zugeordnet,
  weil ihre Namen übersetzt sein können („BESTANDEN“, „NICHT AUSGEFÜHRT“ …). `config/zephyr-statuses.json`
  dient nur als Rückfall für alte Dumps ohne diese Einstellungen.
- Ad-hoc-Ausführungen (ohne Zyklus) landen je Version in einem Zyklus „Ad hoc (<Version>)“;
  Zephyr-Versionen werden zu Testplänen.
- Unplausible Datumswerte (z. B. Jahr 21 statt 2021) werden nicht übernommen, sondern als Originalwert
  bewahrt und im Bericht genannt; NUL-Zeichen werden entfernt (Original exakt im Raw Store).

### Alle Projekte in einem Lauf

```bash
npm run migration -w server -- migrate-projects --projects ALL \
  --discovery ../migration-snapshots/discovery-<Datum>.json \
  --work ../migration-snapshots/run-<Datum> \
  --attachments ../migration-snapshots/zephyr-dump-<Zeitstempel>.attachments.tar.gz
```

Je Projekt: Jira-Extraktion (inkl. Anhänge, Historie; parallel, fortsetzbar – vorhandene Extraktionen werden
wiederverwendet) → Zephyr-Daten aus der Dump-DB → Import → Verifikationsbericht (`reports/<Projekt>.json`).
Danach ein zweiter Importdurchgang für Ausführungen, deren Test inzwischen in einem anderen Projekt liegt,
und ein **globaler Abgleich** Zephyr-DB ↔ Anemo (Zyklen, Ausführungen, Tests, Schritte, Schrittergebnisse;
nicht zuordenbare Zephyr-Daten je Projekt-ID). Ergebnis: `summary.md` / `summary.json` im Arbeitsordner.

Empfehlung aus der Praxis: Den Jira-Suchindex vor dem finalen Export neu aufbauen. Tests, die im Index fehlen,
findet JQL nicht; der Lauf liest sie zwar über ihre Zephyr-ID nach, Tests ganz ohne Zephyr-Daten wären aber nicht
erkennbar.

## Test des Ablaufs

```bash
tools/windows/test-export.sh
```

Simuliert die Jira-MySQL in einem Container und ein Jira-Home mit Anhängen und führt das echte
PowerShell-Skript (mit `pwsh`) sowie den Loader aus. Prüft Zeilenzahlen, Prüfsummen und byte-genaue Inhalte
(Umlaute, Sonderzeichen, Zeilenumbrüche, NULL, Binärdaten, Klammern/Semikolons in Texten), dass keine
fremden Jira-Tabellen oder -Eigenschaften exportiert werden, die Zuordnung der Anhänge (Originalname,
Ablage unter ID, Attrappe gleicher Größe) und dass ein fehlender Anhang zum Ergebnis FAILED führt.
Vorab prüft `check-ps2-compat.ps1` anhand des Syntaxbaums, dass nur Kommandos, Methoden, Typen und Parameter
verwendet werden, die es unter PowerShell 2.0 / .NET 2.0 gibt. Ausgeführt wird der Test unter PowerShell 7.

## Fehlerbilder

| Meldung | Ursache / Abhilfe |
|---|---|
| `Fehler beim Aufrufen der Methode … ReadToEndAsync` | veraltete Skriptversion für PowerShell 2.0 – aktuelle Version verwenden |
| `Keine Tabellen mit Präfix 'AO_7DEABF_' …` | Datenbankname falsch → `-Database <name>` |
| `mysql-Fehler (1): … Access denied` | Benutzer/Passwort falsch → `-User` prüfen |
| `mysql nicht gefunden in …` | MySQL-Pfad abweichend → `-MySqlBin` |
| `… kann nicht geladen werden, da die Ausführung von Skripts … deaktiviert ist` | Aufruf mit `powershell -ExecutionPolicy Bypass -File …` wie oben |
| `SHA-256 stimmt nicht` (beim Laden) | Datei bei der Übertragung beschädigt/unvollständig → erneut kopieren |
| `Jira-Home nicht gefunden` | `-JiraHome "D:\…\Application Data\JIRA"` angeben (Ordner mit `dbconfig.xml`) |
| `n Anhänge fehlen` | Manifest `attachments.missing` ansehen; meist anderer Speicherort → Ordner suchen und mit `-JiraHome` angeben |
