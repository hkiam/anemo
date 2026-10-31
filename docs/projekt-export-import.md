# Projekt exportieren und importieren (Projektpaket)

**Stand:** 29.10.2026 · **Status:** umgesetzt (K1–K5) (Roadmap Stufe K, [ADR-0027](adr/0027-projektpaket-export-import.md))

## Ausgangslage
Ein ganzes Projekt oder eine Auswahl daraus lässt sich heute **nicht** als Einheit exportieren und wieder importieren.
Vorhanden sind nur Teilwege, die jeweils einen Ausschnitt abdecken:

| Vorhanden | Umfang | Grenze |
|---|---|---|
| Testfälle CSV/XLSX (`/api/projects/:key/test-cases/export`, `…/import` mit Probelauf) | aktuelle Version, flache Felder | keine Historie, Anhänge, Aufrufe, Vorbedingungen, Kommentare |
| Ausführungen und Matrix als XLSX (`execution-export`, `plans/:id/matrix/export`) | Berichtsdaten | nur Export, nicht wieder einlesbar |
| Offline-/Excel-Rundlauf (`cycles/:id/offline`) | Ergebnisse eines Zyklus | nur innerhalb derselben Instanz |
| GitLab `.feature`-Abgleich | Gherkin-Testfälle | nur Gherkin |
| Testplan/Testfall kopieren (`clone`) | einzelnes Objekt | nur innerhalb derselben Instanz |
| `tools/backup.sh` / `restore.sh` | ganze Instanz (pg_dump + Anhänge) | alles oder nichts, kein einzelnes Projekt |

## Ziele
1. **Komplett:** ein Projekt mit allem Fachlichen (Testfälle mit Versionen, Ordner, Pläne, Zyklen, Ausführungen,
   Anhänge, Kommentare, Vorbedingungen, Schrittbibliothek, Testsets, Felder, Vorlagen) in eine Datei exportieren und
   auf derselben oder einer anderen Anemo-Instanz verlustfrei wieder einspielen.
2. **Selektiv:** eine Auswahl exportieren (Ordner, Abfrage, Testset, einzelne Pläne/Zyklen). Was die Auswahl braucht
   (aufgerufene Testfälle, Vorbedingungen, Feld-Definitionen, referenzierte Versionen), kommt automatisch mit.
3. **Import** als neues Projekt oder in ein bestehendes Projekt, immer mit **Probelauf** vorab.
4. Erneuter Import desselben Pakets **aktualisiert**, statt Dubletten anzulegen.

Anwendungsfälle: Umzug auf eine andere Instanz (z. B. aus der Erprobung in den Betrieb), Projekt als Vorlage
kopieren, Archiv vor dem Löschen, Austausch mit Partnern (ohne Ausführungen, Personen pseudonymisiert), Testdaten für
Staging und Fehlersuche.

**Nicht-Ziele:** Sicherung der Instanz (bleibt `backup.sh`), Austauschformat für Fremdwerkzeuge (bleibt CSV/XLSX),
laufender Abgleich zwischen zwei Instanzen.

## Paketformat `*.anemo.zip`
```
manifest.json            Format und Formatversion, Anemo-Version/Commit, Quellinstanz, Übertragungs-ID, Zeitpunkt,
                         exportierende Person, Umfang, Anzahl je Objektart, Personen (Login, Name, E-Mail),
                         Gruppen, Warnungen, SHA-256 und Größe jeder übrigen Datei
manifest.sha256          SHA-256 des Manifests
project.json             Projekt-Stammdaten und Projektregeln
catalog.json             benutzte globale Einträge: Ergebnis- und Testfallstatus mit Übergängen, Prioritäten,
                         Testkonfigurationen, globale Felder
folders, field-definitions, field-templates, defect-templates, preconditions, precondition-versions,
step-blocks, test-sets, test-cases, test-case-versions, plans, cycles, executions, execution-results,
sessions, dataset-overrides, comments, references, attachments, views, members, integrations, webhooks
                         je Objektart eine Datei <name>.ndjson (eine Zeile je Objekt)
files/<sha256>           Anhangsinhalte, inhaltsadressiert (Doppelte nur einmal)
```
Welche Spalten je Objektart übertragen werden, steht in `server/src/modules/transfer/format.ts`. Ein Test gleicht
das mit dem Datenbankschema ab: Jede Tabelle ist Objektart, Katalog oder mit Grund ausgeschlossen, jede Spalte
übertragen oder mit Grund ausgelassen, jede ID-Spalte hat einen Bezug.
- **NDJSON** für große Mengen: Export und Import laufen als Stream, ohne alles in den Speicher zu laden.
- **IDs:** Das Paket enthält die Quell-UUIDs. Beim Import bekommt *jedes* Objekt eine neue UUID; eine
  Zuordnungstabelle (Quell-ID → Ziel-ID) übersetzt alle Bezüge. Dadurch kann dasselbe Paket auch auf derselben
  Instanz als Kopie eingespielt werden.
- **Bezüge in JSON-Feldern** werden ausdrücklich mit übersetzt: `steps[].call.testCaseId`, `precondition_ids`,
  `pinned_refs`, Testset-Definitionen, Ansichten, eigene Felder vom Typ `user`. Eine zentrale Liste
  „wo stehen IDs“ je Typ ist Teil des Formatmoduls und hat einen Test, der neue Spalten mit `_id`/`uuid` ohne Eintrag
  meldet.
- **Formatversion** (eigene SemVer, unabhängig von DB-Migrationen): Gleiche Hauptversion wird importiert, ältere
  Nebenversionen über Upgrade-Funktionen im Formatmodul. Neuere Hauptversion → klare Ablehnung im Probelauf.

## Was mitkommt und was nicht

| Bereich | Komplett | Selektiv | Anmerkung |
|---|---|---|---|
| Projekt-Stammdaten, Regeln, Sensibilität, KI-Kontext | ✓ | ✓ | Sensibilität (ADR-0014) bleibt erhalten |
| Ordner | ✓ | betroffene Pfade | |
| Testfälle | ✓ | Ordner / Abfrage / Testset / Liste | Option: alle Versionen · nur aktuelle · nur freigegebene |
| Testfallversionen | ✓ | s. o. | unverändert übernommen (ADR-0004), inkl. Autor/Zeitpunkt/Freigabe |
| Aufgerufene Testfälle, Vorbedingungen, Bausteine | ✓ | automatisch nachgezogen | Aufruf in ein *anderes* Projekt → Hinweis, Schritt bleibt als Text |
| Testsets, Felder, Feld- und Fehlervorlagen | ✓ | benutzte | |
| Testpläne, Zyklen, Ausführungen, Ergebnisse, Sitzungen | optional | ausgewählte | referenzierte Testfallversionen werden immer mitgenommen |
| Kommentare, externe Referenzen (Jira/OpenProject/GitLab) | optional | zu ausgewählten Objekten | Referenzen als Verweis; Ziel prüft nicht nach |
| Anhänge | optional | zu ausgewählten Objekten | `SOURCE`-Anhänge (Altsystem) werden beim Export materialisiert oder als Verweis gekennzeichnet |
| Projektmitglieder | optional | – | per Login/E-Mail, siehe Personen |
| Gespeicherte Ansichten | optional | – | nur projektbezogene |
| Integrationen, Webhooks | nur Gerüst | – | **ohne** Tokens/Passwörter; im Ziel deaktiviert, bis neu eingerichtet |
| API-Tokens, Sitzungen, Protokolle (access/ai_call), Domain-Events, Migrationsdaten, Beobachtungen, Benachrichtigungen | nie | nie | Sicherheit, Datenschutz, nicht übertragbar |

## Personen
Personen stehen in Anemo als Text (Login) in `created_by`, `assignee`, `executed_by` usw.
- Export schreibt eine Personenliste (Login, Anzeigename, E-Mail) ins Manifest.
- Probelauf ordnet zu: gleicher Login → gleiche Person; sonst über E-Mail; sonst manuelle Zuordnung oder als
  „ehemalig: Name“ belassen (wie bei der Migration).
- Option **Personen pseudonymisieren** beim Export (für Partner): ersetzt Logins/Namen durch „Person 1…n“, entfernt
  E-Mails, nutzt die Anonymisierung der Migrationspipeline (ADR-0006).

## Globale Kataloge
Status, Workflow, Prioritäten, Testkonfigurationen und globale Felder gehören der Instanz. Der Probelauf gleicht per
Schlüssel ab: vorhanden → verwenden; fehlt → anlegen (nur Systemadministration) oder auf einen vorhandenen Eintrag
abbilden. Ohne Entscheidung bricht der Import nicht ab, sondern zeigt die offenen Punkte im Probelauf.

## Import
**Ziel:** (a) neues Projekt mit wählbarem Schlüssel und Namen, oder (b) bestehendes Projekt, optional unter einem
Zielordner.

**Schlüssel:** Testfall- und Vorbedingungsschlüssel (`ABC-T12`) werden auf den Zielprojektschlüssel umgeschrieben.
Bei (a) bleiben die Nummern erhalten und `next_number` wird übernommen; bei (b) gibt es neue Nummern. Die
Zuordnung alt → neu steht im Importbericht; Verweise in Texten (Wiki-Links auf Schlüssel) werden umgeschrieben.

**Wiederholter Import / Konflikte (nur b):** Eine neue Tabelle `package_identity (source_instance, source_id,
target_type, target_id)` merkt sich die Herkunft. Je Typ wählbar: *neu anlegen* · *aktualisieren* (neue
Testfallversion statt Überschreiben, ADR-0004) · *überspringen*.

**Alles ist auch in bestehende Projekte importierbar**, einschließlich Testplänen, Zyklen, Ausführungen,
Ergebnissen und Sitzungen. Regeln dafür:
- Ausführungen zeigen weiter auf die Testfallversion, mit der sie ausgeführt wurden; diese Version wird mit
  importiert, auch wenn der Testfall im Ziel schon neuere Versionen hat.
- Zyklen werden nie mit vorhandenen Zyklen vermischt: Ein Zyklus ist entweder neu oder (bei gleicher Herkunft)
  derselbe. Ausführungen in abgeschlossenen Zyklen des Ziels werden nicht überschrieben, sondern im Probelauf als
  Konflikt gemeldet.
- Abdeckung, Teststatusbericht und Cockpit berücksichtigen importierte Ausführungen mit ihrem ursprünglichen
  Zeitpunkt; der Importbericht weist aus, welche Kennzahlen sich dadurch ändern.

**Ablauf:**
1. Hochladen → Paket wird in einem Arbeitsbereich entpackt und geprüft (Prüfsummen, Formatversion, Schemata).
2. **Probelauf:** Zählungen je Typ, neu/aktualisiert/übersprungen, offene Zuordnungen (Personen, Kataloge),
   Warnungen (fremde Aufrufe, fehlende Anhänge). Nichts wird geschrieben.
3. **Einspielen:** eine Datenbanktransaktion für die Fachdaten; Anhänge vorher in einen Bereitstellungsordner, nach
   erfolgreichem Commit verschoben, bei Abbruch gelöscht. Läuft als Hintergrundauftrag mit Fortschritt; Abbruch
   jederzeit möglich, ohne Reste.
4. Ein zusammenfassendes Domain-Event `project.imported` (ADR-0007). Je Objekt werden **keine** Webhooks,
   Benachrichtigungen oder E-Mails ausgelöst.
5. Importbericht (HTML/JSON) mit Zuordnungen und Warnungen, im Projekt abrufbar.

## Rechte
Export und Import sind nicht an die Projektrolle allein gebunden, sondern brauchen ein **eigenes Recht
„Projekte übertragen“** (`PROJECT_TRANSFER`). Es gilt instanzweit, wird von der Systemadministration an Nutzer oder
Gruppen vergeben (Administration → Nutzer/Gruppen) und kommt nicht automatisch mit einer Projektrolle.
Systemadministratoren haben es wie alle Rechte implizit (ADR-0011).

| Aktion | Voraussetzung |
|---|---|
| Export (komplett oder selektiv) | `PROJECT_TRANSFER` **und** `PROJECT_ADMIN` im Quellprojekt |
| Export aus Projekt mit erhöhter Sensibilität (ADR-0014) | wie oben **plus Freigabe durch die Systemadministration**: Der Export entsteht als Auftrag „wartet auf Freigabe“; erst nach Freigabe ist das Paket 24 h für die anfordernde Person abrufbar |
| Import als neues Projekt | `PROJECT_TRANSFER`; die importierende Person wird `PROJECT_ADMIN` im neuen Projekt |
| Import in bestehendes Projekt | `PROJECT_TRANSFER` **und** `PROJECT_ADMIN` im Zielprojekt |
| Fehlende globale Katalogeinträge anlegen | Systemadministration; sonst nur auf vorhandene Einträge abbilden |

„Sensibel“ heißt: Sichtbarkeit *Eingeschränkt* oder externe Dienste gesperrt. Dasselbe gilt für REST, MCP und
API-Tokens (ein Token hat nie mehr Rechte als seine Person). Jeder Export und Import (auch abgelehnte Freigaben)
steht in `project_transfer` mit Person, Projekt, Umfang, Entscheidung, Zahl der Abrufe und Prüfsumme des Pakets;
dazu kommen die Ereignisse `PermissionChanged`, `ProjectExportRequested`, `ProjectExportDecided` und
`ProjectExported`. Beim Abruf werden Recht, Projektrolle und Sensibilität erneut geprüft.

Umsetzung: neue Tabelle `global_permission (principal_type, principal_id, permission)` für Nutzer und Gruppen,
`Principal` erhält `permissions: Set<string>`, Prüfung über `hasPermission(p, 'PROJECT_TRANSFER')`. Die Tabelle ist
bewusst allgemein gehalten, damit später weitere instanzweite Rechte dazukommen können, ohne das Rollenmodell je
Projekt zu ändern.

## Sicherheit und Grenzen
- ZIP-Leser ohne neue Abhängigkeit (Gegenstück zu `server/src/platform/zip.ts`), mit Schutz gegen Zip-Slip
  (Pfade nur aus Manifest, keine relativen Pfade), Zip-Bomben (Grenzen für Gesamtgröße, Anzahl Einträge,
  Kompressionsverhältnis) und Prüfung jeder JSON-Zeile gegen das Schema.
- **ZIP64:** Der vorhandene Schreiber (`platform/zip.ts`) wird um ZIP64 erweitert (Pakete und einzelne Einträge
  über 4 GiB, mehr als 65 535 Einträge); der neue Leser beherrscht ZIP64 von Anfang an. ZIP64-Felder werden nur
  geschrieben, wenn nötig, damit kleine Pakete und Lieferpakete unverändert bleiben.
- **Integrität:** SHA-256 je Datei im Manifest und eine Gesamtprüfsumme über das Manifest; der Import prüft beides
  vor dem Probelauf. Eine Signatur ist nicht vorgesehen; der Schutz vor unbefugtem Ein- und Ausspielen liegt beim
  Recht `PROJECT_TRANSFER`.
- Geheimnisse verlassen die Instanz nie (Integrations-Tokens, Webhook-Geheimnisse, API-Tokens).

## Schnittstellen
- **Oberfläche:** Projekteinstellungen → „Exportieren“ (Umfang, Optionen, Vorschau der Anzahl); Administration →
  Projekte → „Projekt importieren“; im Projekt → „In dieses Projekt importieren“. Auswahl auch aus der
  Testfallliste/Abfrage („Auswahl exportieren“).
- **REST (K1 umgesetzt):**
  - `POST /api/projects/:key/exports`: Export anfordern (bei sensiblen Projekten Status `pending`)
  - `GET /api/project-transfers`: eigene Vorgänge
  - `GET /api/project-transfers/:id/download`: Paket abrufen (nur anfordernde Person, 24 Stunden)
  - `GET /api/admin/project-transfers?status=pending`, `POST /api/admin/project-transfers/:id/decision`: Freigabe
  - `GET`/`PUT /api/admin/permissions`: Recht vergeben und entziehen
- **REST (geplant, K2/K4):** `POST /api/package-imports` (Hochladen + Probelauf),
  `POST /api/package-imports/:id/apply`, `GET /api/package-imports/:id` (Status, Bericht).
- **MCP:** `project_export`, `project_import_preview`, `project_import_apply` (Einspielen nur mit Bestätigung, wie
  Löschen).
- **CLI:** `tools/project-package.ts export|import` für sehr große Projekte und Umzüge ohne Browser-Upload.

## Umsetzung in Phasen

| Phase | Inhalt | Ergebnis / Abnahme |
|---|---|---|
| K1 | Recht `PROJECT_TRANSFER` (Tabelle, Prüfung, Vergabe in der Administration); Formatmodul (Typen, Schemata, ID-Fundstellen-Liste, Formatversion); ZIP64 in Schreiber und Leser; kompletter Export inkl. Freigabe bei sensiblen Projekten | Paket eines migrierten Projekts entsteht; Prüfsummen stimmen; ZIP64-Test mit > 65 535 Einträgen; ohne Recht 403; Test meldet unregistrierte ID-Spalten |
| K2 | Import als **neues Projekt** inkl. ID-Übersetzung, Schlüssel, Personen- und Katalogabgleich, Probelauf, Transaktion, Anhänge | **Rundlauftest:** Export → Import → Export ergibt bis auf IDs/Schlüssel identischen Inhalt; Berichte (Abdeckung, Teststatus) im Ziel gleich der Quelle |
| K3 | **Selektiver** Export mit Abhängigkeitsschluss; Optionen Versionen/Ausführungen/Anhänge/Kommentare; Pseudonymisierung | Auswahl per Ordner/Abfrage/Testset/Plan/Zyklus; Aufrufe und Vorbedingungen kommen mit; pseudonymisiertes Paket enthält keine Logins/E-Mails |
| K4 | Import in **bestehendes Projekt**: Zielordner, `package_identity`, neu/aktualisieren/überspringen, Konfliktanzeige | Zweiter Import desselben Pakets erzeugt keine Dubletten; Aktualisieren erzeugt neue Testfallversionen |
| K5 | Oberfläche, Hintergrundauftrag mit Fortschritt, MCP, CLI, Handbuch, E2E-Test | Ablauf im Browser vollständig; Handbuchkapitel „Projekte übertragen“ |

**Stand K1 (29.10.2026):** umgesetzt mit Tests (Schemaabdeckung, Rechte und Freigabe, Paketinhalt, ZIP64 mit
Python-Gegenprobe). Das Recht wird in der Oberfläche unter Benutzer bzw. Gruppen vergeben. Export und Freigabe
gibt es bisher nur über die API (Oberfläche folgt mit K5).

**Stand K2 (29.10.2026):** Import als neues Projekt umgesetzt (API):
- `POST /api/package-imports`: Paket als Rohdaten hochladen (`application/zip`, Grenze `ANEMO_TRANSFER_MAX_MB`, Standard
  10 GB). Anemo prüft Manifest, Prüfsummen und Formatversion. Das Paket bleibt 24 Stunden liegen und ist nur für
  die hochladende Person sichtbar.
- `POST /api/package-imports/:id/preview`: Probelauf. Der Import läuft vollständig in einer Transaktion und wird
  zurückgenommen. Er liefert Zählung, Personen- und Katalogabgleich, Warnungen und Hinderungsgründe.
- `POST /api/package-imports/:id/apply`: Einspielen mit denselben Angaben (`target`, optional `persons`,
  `executionStatuses`, `testCaseStatuses`, `priorities`). `DELETE` verwirft das Paket.
- Jedes Objekt bekommt eine neue ID. Schlüssel (`ABC-T12`, `ABC-P3`) werden auf das Zielprojekt umgeschrieben, auch
  in Texten, nicht aber in Fremdbezügen (Ticket-Schlüssel, Adressen, Altschlüssel). Nummernkreise bleiben erhalten.
- Personen: gleicher Login → gleiche Person, sonst eindeutige E-Mail, sonst als Text; Zuordnung im Probelauf
  wählbar. Fehlende Ergebnisstatus verhindern das Einspielen, bis sie zugeordnet sind; die Systemadministration
  legt fehlende Katalogeinträge an. Globale Felder legt ohne Systemadministration ein Projektfeld an.
- Webhooks kommen abgeschaltet mit neuem Geheimnis. Die importierende Person wird Projektadmin, die Sensibilität
  des Quellprojekts bleibt erhalten. Es entstehen keine Ereignisse je Objekt, nur `ProjectImported`.
- Abgesichert durch den Rundlauftest (Export → Import → Export ergibt denselben Inhalt bis auf IDs und Schlüssel)
  und den Vergleich des Testabschlussberichts in Quelle und Ziel.

**Stand K3 (29.10.2026):** Auswahl und Optionen beim Export (`scope`, `options` in `POST /api/projects/:key/exports`):
- Auswahl (`scope.kind = "selection"`) aus Ordnern samt Unterordnern, Testfällen (ID oder Schlüssel), Abfrage,
  Testsets, Plänen und Zyklen. Nachgezogen werden aufgerufene Testfälle (rekursiv), Vorbedingungen, übergeordnete
  Ordner und die Testfälle der gewählten Zyklen. Felder und Vorlagen kommen immer mit; Mitglieder, Anbindungen,
  Webhooks, Ansichten und Bausteine nur beim kompletten Export. Die Auswahl wird beim Anfordern geprüft, ihr Umfang
  steht im Antrag (`options.summary`).
- Optionen: `versions` (`all` oder `current`: aktuelle Version, dazu immer die freigegebene sowie die von
  Ausführungen und Aufrufen benutzten; eine Option „nur freigegebene“ gibt es nicht, weil sie den aktuellen Stand
  verlöre), `executions` (Pläne, Zyklen, Ausführungen, Ergebnisse, Sitzungen), `attachments`, `comments`,
  `pseudonymize`.
- Pseudonymisierung ersetzt Logins in allen Personenspalten, in Feldern vom Typ Person, in Beobachtungen und in
  Erwähnungen (`@login`) durch „Person 1…n“. Mitglieder entfallen, das Manifest nennt weder Namen noch E-Mails.
  Seit 30.10. auch vollständige Namen bekannter Konten in Freitexten („Tina Tester“, „Tester, Tina“) und
  E-Mail-Adressen. Grenze: einzelne Vornamen und Namen von Personen ohne Konto.
- Formatversion 1.1.0 (Umfang und Optionen im Manifest); Pakete 1.0 bleiben lesbar.

**Stand K4 (29.10.2026):** Import in ein bestehendes Projekt (`target.mode = "existing"`, optional `target.folderId`,
Regeln in `conflicts`):
- Ein Objekt gilt als vorhanden, wenn seine Herkunft aus einem früheren Import bekannt ist (`package_identity`,
  Migration 039), wenn das Paket aus derselben Instanz stammt und das Objekt im Ziel dieselbe ID hat, oder wenn ein
  natürlicher Schlüssel passt: Ordner (Elternordner + Name), Feld, Feldvorlage, Testset (Name), Ausführung (Zyklus +
  Testfall), Datensatz, Verweis. Die Herkunft wird bei jedem Import festgehalten, auch beim Import als neues Projekt.
- Regeln je Objektart: `update` (Standard für Inhalte: Testfälle, Vorbedingungen, Pläne, Zyklen, Ausführungen,
  Sitzungen, Kommentare, Verweise, Testsets, Bausteine), `skip` (Standard für Ordner, Felder, Vorlagen, Anhänge,
  Ansichten) oder `new` (als Kopie mit neuem Schlüssel; nicht für Objekte mit natürlichem Schlüssel).
- Aktualisieren: Die neuere Fassung gewinnt (`updated_at`). Testfälle und Vorbedingungen bekommen die neuen
  Versionen des Pakets angehängt, mit fortlaufender Nummer im Ziel; die bisher aktuelle Version bleibt in der
  Historie und steht im Bericht. Versionsnummern in Aufrufen und festgehaltenen Vorbedingungsfassungen werden
  entsprechend umgerechnet. Ergebnisse werden ergänzt, gleiche Erfassungen nicht doppelt.
- Abgeschlossene Zyklen im Ziel und ihre Ausführungen werden nie verändert (Konflikt im Bericht).
- Neue Testfälle und Vorbedingungen bekommen Schlüssel aus dem Nummernkreis des Ziels. Der Bericht enthält die
  Zuordnung (`keyMap`); Schlüssel in Texten werden entsprechend umgeschrieben.
- Mitglieder, Anbindungen und Webhooks des Ziels bleiben unverändert (Hinweis im Bericht).
- Recht: „Projekte übertragen“ und Projektadmin im Zielprojekt.

**Stand K5 (29.10.2026):**
- **Hintergrundaufträge:** Ein freigegebener Export wird sofort im Hintergrund gebaut (`running` → `ready`, Fortschritt in
  `progress`) und kann bis zum Ablauf mehrfach abgerufen werden; der Abruf wartet notfalls auf den laufenden Auftrag.
  Einspielen mit `?background=true` antwortet mit 202, Fortschritt und Bericht stehen im Vorgang
  (`GET /api/package-imports/:id`). Nach einem Neustart werden unterbrochene Aufträge wieder aufnehmbar (Export wird
  neu gebaut, Import kann erneut gestartet werden). Abgelaufene Pakete räumt Anemo beim nächsten Hochladen weg.
- **Oberfläche:** Seite *Projekte übertragen* (`#/transfer`; in der Navigation für Personen mit dem Recht, für die
  Systemadministration über *Administration → Projektübertragungen*): Export mit Umfang und Optionen, Import mit
  Hochladen (Fortschritt), Ziel, Personen- und Statuszuordnung, Regeln für Vorhandenes, Probelauf, Einspielen;
  eigene Vorgänge mit Abruf. Administration: offene Freigaben und Protokoll aller Vorgänge.
- **MCP:** `project_export`, `project_transfers`, `project_import_preview`, `project_import_apply` (nur mit
  `confirm: true`). Pakete lädt man über Oberfläche oder Kommandozeile hoch.
- **Kommandozeile:** `tools/project-package.ts export|download|import|status` (API-Token, Streaming, Prüfsumme,
  Warten auf Freigabe und Fortschritt).
- Handbuch: *Administration → Projekte übertragen*, Betrieb (Umzug eines Projekts, `ANEMO_TRANSFER_DIR`,
  `ANEMO_TRANSFER_MAX_MB`); E2E-Test für den ganzen Ablauf im Browser, Layout- und Barrierefreiheitsprüfung der
  neuen Seiten.

**Nachträge (30.10.2026):** liegende Pakete lassen sich fortsetzen (Übersicht in `options.package`), Testpläne als
Auswahl in der Oberfläche, Zuordnung fehlender Testfallstatus und Prioritäten im Import, stündliches Aufräumen
(`cleanupTransferFiles`), Pseudonymisierung auch von vollständigen Namen bekannter Konten und E-Mail-Adressen in
Freitexten.

**Messung an einem migrierten Zephyr-Bestand (30.10.2026, Kopie der Datenbank, MacBook, lokales PostgreSQL):**

| Projekt | Umfang | Export | Paket | Import neu (Probelauf ≈ gleich) | Rundlauf | 2. Import in die Kopie |
|---|---|---|---|---|---|---|
| Projekt A | 1.275 Testfälle, 16.550 Versionen, 2.561 Ausführungen, 3.426 Anhänge (≈ 1 GB) | 5 s | 852 MB | 34 s | identisch (41.983 Zeilen) | 12 s, nichts neu |
| Projekt B | 657 Testfälle, 16.445 Versionen, 8.643 Ausführungen, 325 fremde Testfälle | 3 s | 216 MB | 27 s | identisch bis auf 1 Zyklus mit Testplan aus einem anderen Projekt (gewarnt) | 16 s, nichts neu |
| synthetisch | 5 Anhänge à 1,1 GiB | 8 s | 5,37 GiB (ZIP64) | 3 s | Dateien bitgleich; Python `zipfile` und `unzip -t` lesen das Paket fehlerfrei | – |

Speicher beim Import höchstens ≈ 200 MB Heap bzw. 650 MB RSS, unabhängig von der Anhangsgröße (Streaming).

**Befund aus dem Realtest – fremde Testfälle (Formatversion 1.2):** Zyklen aus Zephyr enthalten Ausführungen von
Testfällen anderer Projekte (in Projekt B 731 Ausführungen aus 30 Projekten). Der Export nimmt diese Testfälle mit
den ausgeführten Versionen als `foreign-test-cases`/`foreign-test-case-versions` mit. Der Import verweist in derselben
Instanz bzw. bei früher übertragenen Projekten auf den vorhandenen Testfall, sonst legt er ihn als Kopie mit neuem
Schlüssel im Zielprojekt an. Ein Testplan aus einem anderen Projekt wird nicht mitgenommen; der Zyklus kommt ohne
Plan (Warnung).

Reihenfolge begründet: K1+K2 liefern früh den wertvollsten Fall (Umzug/Kopie eines ganzen Projekts) und den
Rundlauftest als Sicherheitsnetz, auf dem K3/K4 aufsetzen.

## Entscheidungen (29.10.2026)
1. Große Pakete: **ZIP64** im Schreiber nachrüsten, Leser von Anfang an mit ZIP64. Keine getrennten Anhangsdateien.
2. Import in bestehende Projekte: **alles**, auch Pläne, Zyklen, Ausführungen und Ergebnisse.
3. Export aus sensiblen Projekten: **Freigabe durch die Systemadministration** reicht, keine Sperre.
4. Keine Signatur, **Prüfsummen reichen**. Dafür gibt es das eigene Recht **„Projekte übertragen“**
   (`PROJECT_TRANSFER`), damit nicht jede Projektadministration exportieren und importieren kann.

## Nachtrag 30.10.2026: Review – Sicherheit und Formatversion 1.3
- **Fremde Testfälle** (Formatversion 1.2) sind unveränderlich: Ein Import aktualisiert nie Testfälle oder Versionen
  anderer Projekte, Regeln (`conflicts`) gelten nur für Objektarten des Zielprojekts, und jede Aktualisierung ist
  zusätzlich auf das Zielprojekt beschränkt. Ein Verweis auf einen vorhandenen fremden Testfall gilt nur, wenn die
  importierende Person dessen Projekt lesen darf – sonst entsteht eine Kopie (kein Lesen eingeschränkter Projekte
  über präparierte Pakete).
- **Nur durch die Systemadministration**: Anbindungen und Webhooks sowie Freigaben und Prüfvermerke (Vier-Augen-Prinzip)
  aus dem Paket. Webhook-Adressen werden nur als Ursprung (Schema, Host, Port) exportiert.
- **Import in bestehende Projekte**: „überspringen“ hängt keine Versionen an; ist das Ziel neuer, kommt die Fassung
  aus dem Paket nur in die Historie. Natürliche Schlüssel ordnen nur eindeutig und nur einmal zu (Wiederholungen
  desselben Testfalls im selben Zyklus bleiben getrennt). Abgeschlossene Zyklen bekommen weder neue Ausführungen
  noch Ergebnisse. Anhänge werden erst nach dem Commit abgelegt; der Probelauf sperrt das Zielprojekt nicht.
- **Formatversion 1.3**: Testpläne tragen zusätzlich Verfasser, Zeitpunkt und KI-Vermerk des Fazits sowie den
  Archivstand. Freigabestände (abgelegte Lieferpakete) bleiben in der Quellinstanz. Pakete 1.0–1.2 bleiben lesbar.
- Regressionstests: `server/test/project-transfer-security.test.ts`.

