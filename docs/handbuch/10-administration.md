# Administrationshandbuch

Die **Administration** (Kopfzeile) sehen nur Systemadministratoren. Projektadministratoren verwalten die
Mitglieder ihres Projekts unter *Mitglieder*.

**Aufbau:** Jede Einstellung wird dort gepflegt, wo sie wirkt – Zugangsdaten, Verbindungstest, Status und
Zuordnungen einer Anbindung stehen auf einer Seite.

| Bereich | Seiten |
|---|---|
| Benutzer & Rechte | Benutzer · Gruppen · Projekte & Rechte · Anmeldung (SSO/LDAP) |
| Testmanagement | Status & Workflow · Felder & Prioritäten · Testkonfigurationen · Fehlervorlagen · Berichtsprofile |
| Benachrichtigungen | E-Mail · Webhooks & Chat |
| Anbindungen | Übersicht · OpenProject · GitLab · Jira (Parallelbetrieb) · CI & KI-Agenten |
| KI | Modelle & Skills (Sprachmodelle, Skills, Nutzung) |
| System | Allgemein (mit Suche über alle Einstellungen und Änderungsprotokoll) · Migration · Ereignisse |

**Einstellungswerte** (überall gleich bedient):
- **Herkunft je Wert**: *Oberfläche* (hier festgelegt), *Umgebung* (Vorbelegung beim Containerstart, z. B. `.env`),
  *Standard* oder *nicht gesetzt*. Werte aus der Oberfläche überschreiben die Umgebung und wirken sofort.
- **↺ zurücksetzen**: Es gilt wieder die Umgebung bzw. der Standard. **⊘ abschalten**: Ein Umgebungswert wird außer
  Kraft gesetzt, z. B. um eine Anbindung zu deaktivieren.
- **Passwörter, Tokens, API-Schlüssel** werden verschlüsselt gespeichert und nie angezeigt. Ein leeres Feld behält
  den bisherigen Wert.
- **Verbindung prüfen** je Bereich, z. B. SSO-Anbieter erreichbar, LDAP-Dienstkonto, Testmail, OpenProject/GitLab.

## Benutzer
*Administration → Benutzer*
- **+ Benutzer**: lokales Konto mit Einmal-Kennwort oder vorgegebenem Anfangskennwort (siehe unten).
  Konten aus SSO/LDAP entstehen bei der ersten Anmeldung automatisch.
- **Bearbeiten**: Name, E-Mail, Systemadministrator, **Projekte übertragen** (siehe unten), **🤖 KI-Agent**
  (Ergebnisse brauchen QA-Freigabe), aktiv. Deaktivierte Konten können sich nicht anmelden, ihre Sitzungen enden sofort.
- Schutz: Das eigene Konto lässt sich nicht deaktivieren, und der letzte aktive Systemadministrator bleibt
  erhalten.
- Notzugang: Das lokale Konto `admin` bleibt auch mit SSO nutzbar.

### Kennwörter, Sperre und Sitzungen

Gilt für lokale Konten. Bei LDAP- und SSO-Konten verwaltet das Verzeichnis bzw. der Identitätsanbieter das Kennwort.

- **Neues Konto:** mit Einmal-Kennwort anlegen (wird genau einmal angezeigt) oder ein Kennwort vorgeben.
  „Beim ersten Anmelden ändern“ ist vorbelegt.
- **Kennwort zurücksetzen …** (im Benutzerdialog):
  - Einmal-Kennwort oder vorgegebenes Kennwort.
  - Optional „Beim nächsten Anmelden ändern“ und „Auch alle API-Tokens widerrufen“.
  - Alle Sitzungen enden sofort, eine Sperre wird aufgehoben.
  - Die Person erhält einen Hinweis per E-Mail, ohne Kennwort.
- **Link zum Zurücksetzen senden:** Der Link geht an die hinterlegte E-Mail-Adresse. Er ist begrenzt gültig (Standard 60
  Minuten) und nur einmal verwendbar. Voraussetzung sind E-Mail-Versand und `ANEMO_PUBLIC_URL`.
- **Pflichtwechsel:** Wer ein Kennwort ändern muss, kann nach der Anmeldung nichts anderes tun, als ein neues Kennwort
  festzulegen. Das setzt der Server durch. API-Tokens (CI, Agenten) sind davon nicht betroffen.
- **Sperre:** Nach mehreren Fehlversuchen (Standard 5) wird das Konto vorübergehend gesperrt, 1 bis 15 Minuten,
  wachsend. Die Liste zeigt „gesperrt bis …“, **Entsperren** hebt die Sperre auf. Die Person erhält einen Hinweis
  per E-Mail.
- **Sitzungen:** Der Benutzerdialog zeigt die angemeldeten Sitzungen (Browser, zuletzt aktiv). „Alle Sitzungen
  beenden“ meldet überall ab. Jede Person sieht ihre eigenen Sitzungen im Kontomenü unter „Sitzungen …“.
- **Kennwort vergessen?** Die Anmeldeseite bietet das an, wenn E-Mail-Versand und öffentliche Adresse eingerichtet
  sind. Die Antwort verrät nicht, ob es ein Konto gibt.
- **Regeln** unten auf der Seite unter „Konten und Kennwörter“:
  - Mindestlänge (Standard 12), Buchstaben und Ziffern bzw. Sonderzeichen, nicht der Benutzername.
  - Schwelle für die Sperre.
  - „Kennwort vergessen?“ an oder aus.
  - Gültigkeit des Links.
- **Protokoll:** Alle Vorgänge stehen im Ereignisprotokoll (*System → Ereignisse*), ohne Kennwörter und Tokens.

## Gruppen
*Administration → Gruppen*: lokale Gruppen mit Mitgliedern. Gruppen aus Keycloak, Entra ID oder LDAP erscheinen
automatisch und werden bei jeder Anmeldung abgeglichen. Projektrollen vergibt man am besten **an Gruppen**.

### Recht „Projekte übertragen“
Ganze Projekte als Projektpaket exportieren und importieren (siehe *Projekte übertragen*) darf nicht jede Projektadministration. Dafür gibt
es das instanzweite Recht **Projekte übertragen**, das nur die Systemadministration vergibt: im Dialog **Bearbeiten**
eines Benutzers oder einer Gruppe. Die Spalte *Rechte* zeigt, wer es hat. Systemadministratoren haben es immer.
- Export: Recht **und** Rolle *Projektadmin* im Projekt.
- Projekte mit Sichtbarkeit *Eingeschränkt* oder gesperrten externen Diensten: Der Export braucht zusätzlich eine
  **Freigabe durch die Systemadministration**. Danach kann die anfordernde Person das Paket 24 Stunden lang abrufen.
- Beim Abruf werden Recht, Rolle und Sensibilität erneut geprüft. Jede Vergabe, jeder Antrag, jede Entscheidung und
  jeder Abruf (mit Prüfsumme des Pakets) wird protokolliert.

## Projekte & Rechte
*Administration → Projekte & Rechte*
- **Sichtbarkeit**: *Intern* (alle Angemeldeten lesen) oder *Eingeschränkt* (nur Mitglieder; Nichtmitglieder
  sehen das Projekt nirgends, auch nicht in Suche, Berichten oder Anhängen).
- **Externe Dienste**: *gesperrt* heißt, dass keine Inhalte an KI-Agenten, externe Sprachmodelle,
  OpenProject/GitLab-Abgleich oder Webhooks gehen; E-Mails enthalten dann nur einen Hinweis. Ein Projekt, das
  eingeschränkt wird, ist zunächst gesperrt. Eine Freigabe ist eine bewusste Entscheidung mit Rückfrage.
- **Nachweispflicht**: Ist sie an (Standard), lassen sich *fehlgeschlagen* und *blockiert* nur mit Kommentar oder
  verknüpftem Fehler speichern.
- **Nur Zuständige** (Spalte *Nur Zuständige*, Standard aus): Zugewiesene Ausführungen darf nur die zuständige Person
  erfassen. Nicht zugewiesene bleiben für alle mit Rolle *Ausführen* offen, die Testleitung (Rolle *Pflegen*) ist
  ausgenommen. Die Regel gilt in der Durchführung, in der Massenbearbeitung und beim Excel-Rundlauf.
- **Mitglieder…**: Benutzer bzw. Gruppen mit Rolle (Lesen, Ausführen, Pflegen, Projektadmin).
- Im Menü **⋯** der Zeile: **✎ Umbenennen …**, **KI-Kontext …**, (bei eingeschränkten Projekten)
  **Zugriffsprotokoll …** und **🗑 Projekt löschen …**.
- **Umbenennen** ändert nur den Namen. Der Projektschlüssel bleibt, weil er in allen Testfallschlüsseln steckt (z. B.
  `DEMO-T1`).
- **Projekt löschen** entfernt das Projekt endgültig mit allen Testfällen und Versionen, Zyklen, Ausführungen, Anhängen
  und Verweisen. Zur Bestätigung den **Projektschlüssel** genau eingeben. Das Ereignisprotokoll bleibt erhalten. Nicht
  rückgängig zu machen, vorher sichern.
- **Zugriffsprotokoll** (bei eingeschränkten Projekten): Zugriffsprotokoll mit Zeitpunkt, Person, Aktion und Objekt,
  einschließlich abgelehnter Versuche. Aufbewahrung standardmäßig 2 Jahre.

**Wichtig nach der Migration:** Alle Projekte sind zunächst *intern*. Projekte mit besonderem Schutzbedarf (z. B. Behörden) auf
*Eingeschränkt* stellen und Mitglieder bzw. Gruppen zuordnen.

## Anmeldung
*Administration → Anmeldung (SSO/LDAP)*: Firmen-SSO über OpenID Connect (Keycloak, Microsoft Entra ID) und
LDAP/Active Directory. Gruppen werden übernommen und lassen sich unter *Projekte & Rechte* mit Rollen versehen.
Lokale Konten funktionieren immer. Details: [anmeldung-sso.md](../anmeldung-sso.md).

## Status & Workflow
*Administration → Status & Workflow*
- **Ausführung & Schritte**: Name, Farbe, **Kategorie** (offen, in Arbeit, bestanden, bestanden mit
  Einschränkungen, fehlgeschlagen (bekannter Fehler), fehlgeschlagen, blockiert, ungültig, nicht anwendbar), gilt für
  Ausführung/Schritt/beides, aktiv. Auswertungen richten sich nach der Kategorie – eine Änderung wirkt instanzweit
  und rückwirkend und steht deshalb mit altem und neuem Wert im Protokoll (*Administration → Ereignisse*).
  Deaktivierte Status bleiben an alten Ergebnissen erhalten.
- **Testfall-Workflow**: Status mit Kategorie (Entwurf, Review, Freigegeben, Veraltet), Ausgangsstatus, und die
  **Übergangsmatrix** (von → nach). Status ohne Regeln sind frei wechselbar, das gilt z. B. für übernommene
  Jira-Status.

## Felder & Prioritäten
*Administration → Testmanagement → Felder & Prioritäten*

**Eigene Felder** ergänzen projektspezifische Angaben, getrennt nach Bereich:
- **Testfälle**: versioniert mit dem Testfall; in Editor, Ansicht, Abfrage (`feld.Name`), Export und Import;
- **Testzyklen**: z. B. Testumgebung, Abnahmestufe (im Zyklusformular);
- **Ausführungen**: z. B. Datenstand, Testsystem-Version (in der Durchführung unter *Felder der Ausführung*).

**+ Feld** bzw. ✎ öffnet den Dialog:
- **Name**, **Schlüssel** (Speicherort der Werte; nach dem Anlegen fest), **Bereich**, **Typ**: Text, Text
  (mehrzeilig), Auswahl, Mehrfachauswahl, Zahl, Datum, Ja/Nein, Person.
- **Gilt für**: alle Projekte oder ein Projekt. **Reihenfolge** bestimmt die Anzeige.
- **Beschreibung / Hilfetext**, **Pflichtfeld** (beim Anlegen und Bearbeiten in der Oberfläche) und **aktiv**.
- Bei Auswahl und Mehrfachauswahl: **Werte (je Zeile einer)** oder
  **Auswahlwerte aus Jira bzw. OpenProject abgleichen**. Dann *System* (Jira oder OpenProject, nur eingerichtete),
  *Werte* (Jira: Versionen, Komponenten, Prioritäten, Auswahlfeld (ID); OpenProject zusätzlich Kategorien, Typen,
  Status), *Projekt* (Jira-Schlüssel bzw. OpenProject-Kennung) und bei Auswahlfeldern die *Feld-ID*
  (z. B. `customfield_10100` bzw. `customField7`). **Speichern & Werte abgleichen** holt die Werte sofort.

In der Liste steht bei abgeglichenen Feldern die Quelle mit Zeitpunkt des letzten Abgleichs bzw. dem Fehler; **⟳**
gleicht sofort ab. Der regelmäßige Abgleich läuft standardmäßig alle 6 Stunden (*System → Allgemein*, „Auswahlwerte
eigener Felder abgleichen alle … Stunden“, 0 = aus).

Werte werden beim Speichern geprüft (Typ, zulässige Auswahlwerte, Datum als TT.MM.JJJJ). Unveränderte Altwerte, etwa
übernommene Auswahlwerte außerhalb der Liste, bleiben erhalten. Ein gelöschtes Feld lässt die gespeicherten Werte in
den Daten stehen.

**Übernommene Werte ohne Felddefinition**: Angaben aus der Migration (Jira/Zephyr) mit Vorkommen und Beispielwerten.
**Als Feld anlegen …** macht sie mit demselben Schlüssel sofort sichtbar, bearbeitbar und abfragbar; die Werte selbst
bleiben unverändert.

**Prioritäten**: Werteliste für die Priorität von Testfällen mit Farbe, Reihenfolge (kleiner = wichtiger, gilt auch
für `priorität > …` in der Abfrage), **Standard** für neue Testfälle und *aktiv*. **+ Priorität** legt eine neue an;
löschen geht nur bei unbenutzten Prioritäten, sonst deaktivieren. Übernommene Werte, die nicht in der Liste stehen,
bleiben an den Testfällen erhalten.

## Testkonfigurationen
*Administration → Testkonfigurationen*: Merkmale (Datenbank, Client, Betriebssystem, Office, Browser, Testsystem,
Testart) mit Werten und Erkennungsregeln (reguläre Ausdrücke auf Zyklusname, Umgebung, Build). „Nicht erkannt“
zeigt Texte ohne Treffer. „Neu klassifizieren“ wendet geänderte Regeln an; manuell gesetzte Konfigurationen
bleiben unverändert.

## Fehlervorlagen
*Administration → Testmanagement → Fehlervorlagen*: Titel und Beschreibung mit Platzhaltern (`{{testCase.key}}`,
`{{step.actual}}`, `{{configuration}}`, `{{link}}` …), Abschnitte nur bei Inhalt (`{{#step}}…{{/step}}`), global oder
je Projekt. Eine Vorlage ist Standard.

## Feldvorlagen
*Administration → Testmanagement → Feldvorlagen* (systemweit) bzw. auf der Projektseite *Mitglieder* unter
**Feldvorlagen** (Projektadministration): formatierter Standardaufbau für Felder, z. B. „Vorbedingung / Vorgehen“ in der
Aktion. Im Editor fügt **📋** in der Werkzeugleiste eines Feldes die Vorlage an der Schreibmarke ein (ein leeres Feld
wird damit gefüllt).
- **Name**, **Für Felder** (Aktion, Testdaten, Erwartetes Ergebnis, Ziel, Vorbedingungen, Testdaten des Testfalls) und
  **Inhalt** (mit Formatierung). Projektvorlagen ergänzen die systemweiten; Namen sind je Ebene eindeutig.
- **Standard für neue Schritte**: füllt bei **+ Schritt** das Feld vor – je Feld höchstens eine Standardvorlage; die des
  Projekts hat Vorrang.
- Mitgeliefert: *Vorbedingung / Vorgehen* (das in übernommenen Testfällen verbreitete Muster mit `{code}`-Kästchen),
  dieselbe Gliederung *mit Überschriften* und *Erwartet als Liste*.
- Projektadministration kann im Editor über **📋 → ＋ Feldinhalt als Vorlage speichern …** eine Projektvorlage aus einem
  ausgefüllten Feld anlegen.
- Feldvorlagen geben nur den Aufbau **innerhalb** eines Feldes vor; ganze Schrittfolgen mit Inhalt bietet die
  [Schrittbibliothek](02-testfaelle.md#schrittbibliothek).

## Berichtsprofile
*Administration → Berichtsprofile*: Organisation (Kopfzeile), Akzentfarbe, Fußzeile, Normhinweis, Abschnitte
(z. B. Schrittergebnisse ein/aus) und Rollen im Freigabeblock. Ein Profil ist Standard.

## E-Mail
*Administration → Benachrichtigungen → E-Mail*: SMTP-Zugang (Server, Port, Verschlüsselung, Konto, Absender),
Testmail über „Verbindung prüfen“, Versandstatus mit letztem Fehler. Jede Person wählt ihre Benachrichtigungen
selbst (Kontomenü → Benachrichtigungen): zugewiesene Tests, fällige Nachtests, Fehlschläge in eigenen Zyklen,
Erwähnungen in Diskussionen und beobachtete Testfälle, Zyklen und Testpläne. Projekte mit gesperrten externen Diensten erhalten nur einen Hinweis ohne Inhalt.

## Webhooks & Chat
*Administration → Benachrichtigungen → Webhooks & Chat*: Name, URL, Format (Chat für Teams/Mattermost/Slack oder
JSON mit Signatur), Ereignisse, Projekt; Zustellprotokoll und Test.

## Anbindungen
*Administration → Anbindungen*: Die **Übersicht** zeigt, was eingerichtet ist. Je Anbindung eine Seite mit
Zugangsdaten, Verbindungstest, Status/Abgleich und Projektzuordnung:

| Anbindung | Zugang (oder Umgebung) | Auf der Seite |
|---|---|---|
| OpenProject | `OPENPROJECT_URL`, `OPENPROJECT_API_KEY`, Abgleichtakt | Status jetzt abgleichen; Projektzuordnung mit Typ neuer Fehler und Abdeckung ins Ticket |
| GitLab | `GITLAB_URL`, `GITLAB_TOKEN` | je Projekt Repository, Zweig, Ordner, Zweig für CI |
| Jira (Parallelbetrieb) | `JIRA_BASE_URL`/`JIRA_HOST`, Benutzer und Passwort oder persönliches Zugriffstoken, Abgleichtakt, *Fehler in Jira anlegen* | Jetzt aktualisieren; Status des letzten Abgleichs; Projektzuordnung für neue Fehler |
| CI & KI-Agenten | API-Token | Aufrufbeispiele; siehe [automation.md](../automation.md), [agenten.md](../agenten.md) |

### OpenProject: Rückverweis
*Administration → Anbindungen → OpenProject*, Karte **Rückverweis in OpenProject**: Beim Anlegen eines Fehlers füllt Anemo
in OpenProject ein **Link-Feld** mit einem dauerhaften Link auf die Herkunft (Ausführung bzw. Sitzung) und optional ein
**Textfeld** mit dem Testfallschlüssel. Der Bezug steht dann in den Attributen des Arbeitspakets – klickbar und filterbar –
statt als Adresse im Beschreibungstext. Die Beschreibung endet nur noch mit „Aus Anemo: [DEMO-T29 – Titel](Link) ·
gemeldet von …“.
- **Einrichten in OpenProject:** *Administration → Benutzerdefinierte Felder → Arbeitspakete*: neues Feld im Format
  **Link** (z. B. „Anemo“), optional ein Textfeld „Testfall“; beide dem Typ neuer Fehler zuordnen und in den Projekten
  aktivieren. Dann in Anemo die Felder auswählen und speichern (die Liste zeigt die Felder der zugeordneten Projekte).
- **Dauerhafte Links:** Alle Links nach außen (OpenProject, E-Mails, Chat) haben die Form `…/go/ausfuehrung/<id>`,
  `…/go/testfall/DEMO-T29`, `…/go/zyklus/<id>`, `…/go/plan/<id>`, `…/go/sitzung/<id>` bzw. `…/go/ticket/openproject/PROJ-315`
  (alle Stellen eines Tickets). Sie leiten nach der Anmeldung zur jeweiligen Ansicht und bleiben gültig, auch wenn sich
  die Oberfläche ändert.
- **Rückverweise aktualisieren …** (nach einem Umzug bzw. einer neuen öffentlichen Adresse): setzt das Link-Feld in allen
  verknüpften Arbeitspaketen auf den aktuellen Link – mit Probelauf und Rückfrage. Überschrieben werden nur leere Felder
  und Anemo-Links; Felder mit fremdem Inhalt bleiben unverändert.
- Empfehlung: Anemo unter einem festen Namen betreiben (z. B. DNS-Alias `anemo.firma.de`), siehe
  [Betrieb](20-betrieb.md#aktualisieren) – dann genügt bei einem Umzug die Änderung des Alias.

### OpenProject: Projektzuordnung
*Administration → Anbindungen → OpenProject*, Abschnitt **Projektzuordnung (n von m Projekten zugeordnet)**: eine
Übersicht aller Anemo-Projekte (filterbar, „nur zugeordnete“) mit den Spalten *OpenProject-Projekt*, *Typ neuer
Fehler* und *Abdeckung ins Ticket*. Gesperrte Projekte tragen „gesperrt“.
- **Zuordnen** bzw. **Ändern**: das OpenProject-Projekt aus der Liste der Projekte wählen, die das Servicekonto sieht.
  Nicht (mehr) gefundene Projekte sind mit ⚠ markiert.
- **Typ neuer Fehler**: Typ des Arbeitspakets für „Fehler melden“ (Auswahl aus den Typen des Projekts, sonst
  *Standardtyp*).
- **Abdeckung ins Ticket** (*melden*): Ändert sich der Teststand einer verknüpften Anforderung, kommentiert Anemo das
  Arbeitspaket (siehe [Zusammenarbeit](05-zusammenarbeit.md#openproject)).
- **Speichern**, **Entfernen** (Zuordnung löschen) oder **Abbrechen**.

Nur zugeordnete Projekte können Arbeitspakete suchen und Fehler in OpenProject anlegen. Ohne Zuordnung lassen sich
Arbeitspakete nur über ihre Nummer verknüpfen.

### Freie Links (URL mit Kurznamen)
*Administration → Anbindungen*, Karte **Freie Links (URL mit Kurznamen)**:
- **Freie Links erlauben** (`ANEMO_URL_LINKS`, Standard aus): Beim Verknüpfen von Fehlern (Ausführung, Schritt,
  Massenaktion, Sitzungsfund) und unter *🔗 Verknüpfen…* lassen sich dann neben Tickets auch beliebige Adressen mit
  einem angezeigten Kurznamen hinterlegen – etwa für Fehler in Systemen ohne Anbindung.
- **Erlaubte Domänen** (`ANEMO_URL_LINK_DOMAINS`, optional, kommagetrennt, `*.beispiel.de` für Unterdomänen): ohne
  Angabe sind alle Domänen erlaubt. Zulässig sind nur `http(s)`-Adressen ohne Zugangsdaten; der Kurzname hat höchstens
  80 Zeichen.
- Abschalten verhindert neue Links; vorhandene bleiben sichtbar.

### GitLab: Zweig für CI
Bei der Repository-Zuordnung je Projekt optional **Zweig für CI**: Auf diesem Zweig starten Pipelines aus dem Zyklus
(*⋯ Mehr → ▶ CI-Pipeline starten…*); ohne Angabe gilt der Zweig der Gherkin-Ablage. Das Token braucht dafür
mindestens die Rolle *Developer* im Repository.

### Jira: Fehler in Jira anlegen
*Administration → Anbindungen → Jira (Parallelbetrieb)*
- **Zugang**: *Adresse* und entweder *Benutzer* und *Passwort* oder ein *Persönliches Zugriffstoken*.
- **Fehler in Jira anlegen** (`JIRA_CREATE_DEFECTS`, Standard aus): Erst damit schreibt Anemo in Jira. Ohne den
  Schalter wird Jira nur gelesen (Status verknüpfter Tickets).
- **Fehler in Jira anlegen – Projektzuordnung**: Anemo-Projekt wählen, dann *Jira-Projekt* (Schlüssel, z. B. `PROJ`),
  *Vorgangstyp* (Standard `Bug`) und optional je Schweregrad die Jira-Priorität (*Blocker →*, *Kritisch →*,
  *Schwer →*, *Mittel →*, *Gering →*). **Speichern** bzw. **Zuordnung entfernen**.
- **OpenProject hat Vorrang**: Ist das Projekt auch einem OpenProject-Projekt zugeordnet, gehen neue Fehler dorthin;
  die Seite weist darauf hin. Bei gesperrten externen Diensten legt Anemo keine Fehler in Jira an.

## KI
*Administration → KI → Modelle & Skills*
- **KI-Funktionen** (Hauptschalter): aus bedeutet, es geht keine Anfrage an ein Sprachmodell, und KI-Schaltflächen
  verschwinden. Die regelbasierten Analysen (Duplikate, Fehlerursachen-Cluster, Abdeckung) bleiben.
- **KI-Agenten (MCP)**: Externe Agenten zulassen oder sperren.
- **Sprachmodell**:
  - Schnittstelle *OpenAI-kompatibel* (on-prem: vLLM, Ollama, LM Studio, LocalAI; extern: OpenAI, Azure OpenAI)
    oder *Anthropic*, dazu Basis-URL, Modell und API-Schlüssel.
  - **on-prem** kennzeichnen, wenn das Modell im eigenen Netz läuft. Nur solche Modelle verarbeiten Inhalte von
    Projekten mit gesperrten externen Diensten.
  - **Zusätzliche Anfrageparameter (JSON)**: Felder, die jede Anfrage mitschickt, z. B. für Qwen3 auf vLLM
    `{"chat_template_kwargs": {"enable_thinking": false}}`. Damit entfällt die Denkphase, Antworten kommen
    schneller. Eine Denkphase (`<think>…</think>`) in der Antwort entfernt Anemo ohnehin.
  - **Kontingent**: höchstens n Anfragen pro Stunde.
  - **Verbindung prüfen** schickt eine kurze Testanfrage. Antwortet das Modell nur mit einer Denkphase, nennt der
    Test die Abhilfe.
- **Wo KI wirkt**: Funktionen mit Ort in der Oberfläche, Arbeitsweise und Status (aktiv, ohne Modell,
  regelbasiert, aus).
- **Nutzung**: Anfragen, Fehler und Dauer je Funktion der letzten 30 Tage. Protokolliert wird ohne Inhalte.
- **Profil „stark“** (optional): ein zweites Modell, z. B. extern und leistungsfähiger. Es wird je Skill gewählt.
  Projekte mit gesperrten externen Diensten fallen automatisch auf ein on-prem-Modell zurück.
- **Prompts (Skills)**: Anweisung an das Modell je Funktion und **Modellprofil**, beides anpassbar. „Standard
  wiederherstellen“ setzt den Text zurück. Mitgeliefert sind: Testfall aus Anforderung, Testfall prüfen,
  Fehlermeldung formulieren, Fazit für den Abschlussbericht, Fehlerursache zusammenfassen, Risikobasierte
  Testauswahl.
- **KI-Kontext je Projekt** (*Projekte & Rechte → KI-Kontext…*, für Projektadmins unter *Mitglieder*): Glossar,
  Fachbegriffe und Stilregeln. Sie werden an jeden Prompt des Projekts angehängt. Konzept und weitere Skills: [ki-konzept.md](../ki-konzept.md).

## Allgemein
*Administration → System → Allgemein*: öffentliche Adresse (Links in Mails, SSO-Rücksprung), Aufbewahrung des
Zugriffsprotokolls, Abgleich der Auswahlwerte eigener Felder (Takt in Stunden). Die **Suche** findet jede Einstellung und führt auf
die Seite, auf der sie gepflegt wird. Darunter das **Änderungsprotokoll** aller Einstellungen (ohne Werte).

**Version:** Die Karte *Version* zeigt Versionsnummer, Commit, Build- und Startzeitpunkt, den Datenbankstand (letzte
Migration) sowie Node- und PostgreSQL-Version. Alle Benutzer sehen die Versionsnummer unten im Kontomenü
(„Anemo 0.9.1 · a67f870“); für Systemadministratoren führt sie zu dieser Karte.

## Projekte übertragen
*Übertragen* in der Navigation (Systemadministration: *Administration → Projektübertragungen → Selbst exportieren
oder importieren*). Ein Projekt oder eine Auswahl daraus wird als **Projektpaket** (`*.anemo.zip`) exportiert und in
diese oder eine andere Anemo-Instanz eingespielt – als neues Projekt oder in ein bestehendes. Voraussetzung ist das
Recht *Projekte übertragen* (siehe oben) und die Rolle *Projektadmin* im Quell- bzw. Zielprojekt.

### Exportieren
- **Umfang**: *komplettes Projekt* oder *Auswahl* aus Testfällen (Schlüssel), Abfrage, Ordnern (mit Unterordnern),
  Testsets, Testplänen und Zyklen. Was die Auswahl braucht, kommt automatisch mit: aufgerufene Testfälle, Vorbedingungen,
  übergeordnete Ordner, Felder und Vorlagen.
- **Optionen**: alle oder nur aktuelle Versionen (die freigegebene und die ausgeführte Version kommen immer mit),
  Pläne/Zyklen/Ausführungen, Anhänge, Kommentare, **Personen pseudonymisieren** (z. B. für Partner): Logins, Erwähnungen
  und vollständige Namen bekannter Konten – auch in Freitexten und als „Nachname, Vorname“ – werden zu „Person 1…n“,
  E-Mail-Adressen entfallen. Einzelne Vornamen oder Namen von Personen ohne Konto erkennt Anemo nicht; Paket vor der
  Weitergabe stichprobenartig prüfen.
- **Export anfordern**: Das Paket entsteht im Hintergrund; sobald es *bereit* ist, steht in *Meine Vorgänge*
  **Herunterladen** (24 Stunden lang, nur für die anfordernde Person). Beim Herunterladen werden Recht und Rolle
  erneut geprüft.
- **Eingeschränkte Projekte** (bzw. gesperrte externe Dienste): Der Export *wartet auf Freigabe*. Die
  Systemadministration gibt ihn unter *Administration → Projektübertragungen* frei oder lehnt ihn mit Begründung ab.
  Geheimnisse (Tokens, Webhook-Geheimnisse, Kennwörter) und Protokolle verlassen die Instanz nie.

### Importieren
1. **Paket hochladen …**: Anemo prüft Prüfsummen und Formatversion. Ein verändertes oder beschädigtes Paket wird
   abgelehnt.
2. **Ziel**: *neues Projekt* (Schlüssel und Name) oder *bestehendes Projekt* (optional ein Zielordner für neue
   Ordner und Testfälle).
3. **Personen**: automatisch über gleichen Login bzw. E-Mail; sonst einem Konto zuordnen oder als Text übernehmen.
   Ergebnisstatus, Testfallstatus und Prioritäten, die es hier nicht gibt, lassen sich nach dem Probelauf einem
   vorhandenen Eintrag zuordnen (die Systemadministration legt sie sonst beim Einspielen an).
4. **Probelauf**: rechnet den Import vollständig durch, ohne etwas zu speichern – je Art *neu*, *aktualisiert*,
   *unverändert*, dazu Hinderungsgründe (z. B. ein Ergebnisstatus, den es hier nicht gibt: zuordnen) und Hinweise.
5. **Einspielen** (nach dem Probelauf): läuft im Hintergrund mit Fortschritt, alles oder nichts. Danach führt
   *Zum Projekt …* in das Ergebnis.

Ein hochgeladenes Paket bleibt 24 Stunden liegen: In *Meine Vorgänge* setzt **Fortsetzen** den Import ohne
erneutes Hochladen fort. Abgelaufene Pakete entfernt Anemo stündlich.

**Testfälle anderer Projekte**: Zyklen aus Zephyr enthalten oft Testfälle mehrerer Projekte. Der Export nimmt sie mit
der ausgeführten Fassung mit (Hinweis im Paket). Beim Import in dieselbe Instanz bleibt die Ausführung mit dem
Original verbunden – aber nur, wenn die importierende Person das andere Projekt lesen darf; sonst entsteht wie
in einer anderen Instanz eine Kopie im Zielprojekt. Testfälle anderer Projekte verändert ein Import nie. Ein Testplan aus einem anderen Projekt kommt nicht mit – der Zyklus wird ohne Plan
übertragen.

Beim Import entstehen neue Schlüssel im Zielprojekt; Verweise in Texten (z. B. „siehe DEMO-T1“) werden mit
umgeschrieben. In ein neues Projekt kommen auch Mitglieder (über Login bzw. Gruppenname). Wer importiert, wird
Projektadmin. Es gehen keine Benachrichtigungen oder Webhooks je Testfall hinaus.

**Was nur die Systemadministration übernimmt** (Schutz gegen präparierte Pakete):
- **Anbindungen** (GitLab, Jira, OpenProject) und **Webhooks** – sie lenken Servicekonten bzw. senden nach außen.
  Bei anderen Personen meldet der Probelauf sie nur; die Systemadministration richtet sie im Ziel ein.
- **Freigaben und Prüfvermerke**: Testfall-Freigaben (Vier-Augen-Prinzip) und geprüfte Agentenergebnisse. Ohne
  Systemadministration kommen Testfälle ohne Freigabe an, geprüfte Agentenergebnisse stehen wieder zur Prüfung.
- Webhook-Adressen verlassen die Instanz nur als Host (bei Teams, Slack und Mattermost steckt das Geheimnis im
  Pfad); im Ziel sind Webhooks abgeschaltet, haben ein neues Geheimnis und brauchen die vollständige Adresse.
- Verweise mit anderen Adressen als http(s) werden beim Import entfernt.

**In ein bestehendes Projekt** (z. B. Stand aus einer anderen Instanz nachziehen): Was schon da ist, wird erkannt –
aus einem früheren Import, an derselben ID (gleiche Instanz) oder am Namen (Ordner, Testsets, Felder; Ausführung
desselben Testfalls im selben Zyklus). Unter *Regeln für Objekte, die es im Ziel schon gibt* je Art:
*aktualisieren* (die neuere Fassung gewinnt; Testfälle bekommen neue Versionen, die bisherige bleibt in der
Historie), *überspringen* oder *als Kopie neu anlegen*. *Überspringen* lässt auch die Versionen vorhandener
Testfälle unverändert; ist der Testfall im Ziel neuer, landet die Fassung aus dem Paket nur in der Historie.
Abgeschlossene Zyklen werden nie verändert – auch nicht durch neue Ausführungen oder Ergebnisse aus dem Paket.
Mehrere Durchläufe desselben Testfalls im selben Zyklus bleiben getrennt. Mitglieder, Anbindungen und Webhooks des
Ziels bleiben, wie sie sind. Anhänge werden erst nach dem erfolgreichen Einspielen abgelegt; ein abgebrochener Import
hinterlässt keine Dateien.

### Kommandozeile und KI-Agenten
Für sehr große Projekte oder Umzüge ohne Browser: `tools/project-package.ts` mit API-Token (siehe *Betrieb*).
KI-Agenten (MCP) können Exporte anfordern (`project_export`), den Stand abfragen (`project_transfers`) und
hochgeladene Pakete prüfen bzw. – nur mit ausdrücklicher Bestätigung – einspielen. Projekte mit gesperrten externen
Diensten sind für Agenten nicht sichtbar.

Allgemein gilt für Agenten über `api_call`: API-Tokens erzeugen und Kennwörter anderer Konten setzen ist gesperrt;
Löschen, ändernde Funktionen der Administration, Einspielen von Paketen, Mitglieder, Anbindungen und die
Freigabeentscheidung brauchen `confirm: true`.

### Projektübertragungen (Administration)
*Administration → Projektübertragungen*: offene Freigaben mit Anlass und anfordernder Person, *Freigeben* bzw.
*Ablehnen* (mit Begründung); mit *alle Vorgänge* das Protokoll aller Exporte und Importe mit Umfang, Größe und
Stand. Jeder Vorgang steht zusätzlich im Ereignisprotokoll.

## Migration
*Administration → Migration*: Importläufe aus Jira/Zephyr-Snapshots mit Verifikationsbericht und Herkunft je
Objekt. Export aus dem Altsystem: [zephyr-export.md](../migration/zephyr-export.md). Ein Lauf über alle Projekte
schreibt eine Zusammenfassung (`summary.md`) mit globalem Abgleich Zephyr ↔ Anemo. Wiederholte Importe sind
idempotent.

## Ereignisse
*Administration → Ereignisse*: Protokoll aller fachlichen Änderungen (wer, was, wann), z. B. Testfall geändert,
Ergebnis erfasst, Verweis verknüpft, Agentenergebnis freigegeben.
