# Betriebshandbuch

## Architektur
- **Ein Container** (distroless Node 22, ohne Shell, als non-root, Dateisystem schreibgeschützt) mit Backend
  (TypeScript, direkt ausgeführt) und gebauter Weboberfläche. Laufzeitabhängigkeiten: hono, zod, postgres.
- **PostgreSQL 18** als einziger Datenspeicher; Anhänge im Dateisystem (`ATTACHMENT_DIR`, im Container
  `/data/attachments`).
- Modularer Monolith (Module: auth, testcases, execution, reports, integrations, notifications, mcp …), siehe
  [ADRs](../adr) und [C4-Modell](../architecture/workspace.dsl).
- Hintergrundaufgaben im selben Prozess: Ereignis-Relay, Webhook- und Mail-Versand, Statusabgleich
  Jira/OpenProject/GitLab (dabei auch Abdeckungskommentare in OpenProject), Abgleich der Auswahlwerte eigener Felder, Aufräumen von Sitzungen und Zugriffsprotokoll.

## Installation
```bash
git clone <repo> anemo && cd anemo
cp .env.example .env            # Werte setzen, siehe Konfigurationsreferenz
docker compose --profile app up -d --build
```
- Anemo lauscht auf `127.0.0.1:8090` (Compose). Davor gehört ein **Reverse-Proxy mit HTTPS**, der `Host` und
  `X-Forwarded-Proto` weitergibt. Ändernde Anfragen müssen vom eigenen Ursprung kommen (Origin-Prüfung).
- **Erster Start**: Datenbankmigrationen laufen automatisch. Ohne Benutzer legt Anemo `admin` an; das Passwort steht
  nur in `/data/initial-admin-password.txt` (Rechte 0600) bzw. kommt aus `ANEMO_ADMIN_PASSWORD`. Nach der ersten
  Anmeldung ändern und die Datei löschen.
- `ANEMO_PUBLIC_URL` auf die Adresse im Browser setzen (Links in Mails, Rückverweise, SSO-Rücksprung).

## Konfigurationsreferenz
Umgebungsvariablen sind die **Vorbelegung**. Alle Werte der Abschnitte *Anmeldung*, *Integrationen* und *KI* sowie
die Abgleichtakte lassen sich zusätzlich in der Administration auf der jeweiligen Seite setzen (Anmeldung, E-Mail,
OpenProject, GitLab, Jira, KI, Allgemein; die Suche unter *System → Allgemein* findet jeden Wert). Dort
gespeicherte Werte haben Vorrang und wirken ohne Neustart.

| Variable | Standard | Bedeutung |
|---|---|---|
| `ANEMO_SECRET_KEY` | – | Schlüssel für in der Oberfläche gespeicherte Geheimnisse; ohne Angabe wird `secret.key` im Datenverzeichnis erzeugt (Teil der Sicherung!) |
| `ANEMO_SECRET_KEY_FILE` | `<Daten>/secret.key` | abweichender Ort der Schlüsseldatei |
| `AI_ENABLED` | `true` | KI-Funktionen insgesamt ein/aus |
| `AGENTS_ENABLED` | `true` | KI-Agenten über MCP zulassen |
| `AI_MAX_REQUESTS_PER_HOUR` | `200` | Kontingent für Sprachmodell-Anfragen (0 = unbegrenzt) |


### Grundbetrieb
| Variable | Standard | Bedeutung |
|---|---|---|
| `DATABASE_URL` | `postgres://anemo:anemo@localhost:5433/anemo` | PostgreSQL-Verbindung |
| `ANEMO_PORT` | `8090` (Container 8080) | HTTP-Port |
| `ANEMO_PUBLIC_URL` | – | öffentliche Adresse, z. B. `https://anemo.firma.de` |
| `ATTACHMENT_DIR` | `.data/attachments` (Container `/data/attachments`) | Ablage der Anhänge |
| `WEB_DIST` | – (Container gesetzt) | gebaute Weboberfläche |
| `ANEMO_AUTH` | `on` | `off` nur für lokale Entwicklung (keine Anmeldung) |
| `ANEMO_ADMIN_PASSWORD` | – | Passwort des ersten `admin` (sonst zufällig, in Datei) |
| `ANEMO_ACCESS_LOG_DAYS` | `730` | Aufbewahrung des Zugriffsprotokolls |
| `ANEMO_SIGNING_KEY_FILE` | – | Ed25519-Schlüssel (PEM) für signierte Lieferpakete |
| `ANEMO_TRUST_PROXY` | `false` | `true` hinter einem Reverse-Proxy: Absenderadresse aus `X-Forwarded-For` (Anmeldesperre je Adresse) |
| `ANEMO_TRANSFER_DIR` | Temp-Verzeichnis | Arbeitsverzeichnis für Projektpakete (Export bis zum Abruf, hochgeladene Pakete bis zum Einspielen; je höchstens 24 h). Platz für das größte Projekt einplanen |
| `ANEMO_TRANSFER_MAX_MB` | `10240` | größtes Projektpaket beim Hochladen |

### Anmeldung (siehe [anmeldung-sso.md](../anmeldung-sso.md))
| Variable | Bedeutung |
|---|---|
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | OIDC-Anbieter (Keycloak-Realm, Entra `…/v2.0`) |
| `OIDC_SCOPES` (`openid profile email`), `OIDC_USERNAME_CLAIM` (`preferred_username`), `OIDC_USERNAME_STRIP_DOMAIN` (`true`) | Konto |
| `OIDC_GROUPS_CLAIM` (`groups`; mehrere/Pfade: `groups,realm_access.roles`), `OIDC_GROUPS_FULL_PATH`, `OIDC_ADMIN_GROUP` | Gruppen, Admin |
| `OIDC_TOKEN_AUTH` (`basic`/`post`), `OIDC_LOGOUT` (`true`), `OIDC_LABEL` | Technik, Abmelden, Beschriftung |
| `LDAP_URL`, `LDAP_BASE_DN`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD` | Verzeichnis und Dienstkonto |
| `LDAP_USER_FILTER`, `LDAP_USERNAME_ATTR`, `LDAP_GROUP_FILTER`, `LDAP_GROUP_BASE_DN`, `LDAP_GROUP_PATTERN`, `LDAP_ADMIN_GROUP`, `LDAP_TLS_INSECURE` | Suche, Gruppen, Admin, TLS |

### Integrationen
| Variable | Bedeutung |
|---|---|
| `OPENPROJECT_URL`, `OPENPROJECT_API_KEY`, `ANEMO_OPENPROJECT_REFRESH_MINUTES` (`15`) | OpenProject und Statusabgleich (auch GitLab-MRs) |
| `GITLAB_URL`, `GITLAB_TOKEN` | GitLab (Token mit Bereich `api`) |
| `JIRA_HOST` bzw. `JIRA_BASE_URL`, `JIRA_BASIC_AUTH` (oder `JIRA_USER`/`JIRA_PASSWORD` bzw. `JIRA_TOKEN`), `ANEMO_JIRA_REFRESH_HOURS` (`6`) | Jira (Parallelbetrieb, Migration); Statusabgleich |
| `JIRA_CREATE_DEFECTS` (`false`) | `true`: Fehler in Jira anlegen für Projekte mit Jira-, aber ohne OpenProject-Zuordnung (*Fehler in Jira anlegen*) |
| `SMTP_HOST`, `SMTP_PORT` (`587`), `SMTP_SECURE` (`starttls`/`tls`/`none`), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_TLS_INSECURE` | E-Mail |
| `AI_PROVIDER` (`openai`/`anthropic`), `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `AI_ON_PREM`, `AI_EXTRA_BODY` (JSON) | optionales Sprachmodell; zweites Profil mit `AI_STRONG_…`. In `AI_EXTRA_BODY` sind `model`, `messages`, `system`, `stream`, `max_tokens` gesperrt (legt Anemo fest) |
| `ANEMO_FIELD_OPTIONS_REFRESH_HOURS` (`6`) | Auswahlwerte eigener Felder aus Jira/OpenProject abgleichen alle … Stunden (0 = aus); auch unter *System → Allgemein* |

### Migration
| Variable | Bedeutung |
|---|---|
| `SNAPSHOT_ROOT` | Verzeichnis der Migrations-Snapshots (nur daraus darf importiert werden) |
| `ANON_SALT` | Salz für die Pseudonymisierung beim Anonymisieren von Snapshots |

### Grenzen für Uploads
Anemo begrenzt die Größe von Anfragen; Dateien werden teils Base64-kodiert übertragen und dabei etwa ein Drittel
größer. Ein Reverse-Proxy davor muss mindestens diese Größen zulassen (z. B. `client_max_body_size 70m` bei nginx).

| Anfrage | Grenze |
|---|---|
| Anhänge und Evidenzen | 50 MB je Datei (Base64-Upload und MCP bis 70 MB Anfrage) |
| Excel/CSV-Import von Testfällen, Import automatisierter Ergebnisse in der Oberfläche | 30 MB Anfrage, Datei höchstens 20 MB |
| Excel-Rundlauf (Einlesen der ausgefüllten Arbeitsmappe) | 30 MB Anfrage, Datei etwa 20 MB |
| CI-Ergebnisse per API (`automation-results`) | 20 MB |
| alle übrigen Anfragen | 4 MB |

## Sicherung und Wiederherstellung
```bash
tools/backup.sh /sicherung                 # Datenbank (pg_dump -Fc) + Anhänge (tar) + SHA256SUMS
KEEP=14 tools/backup.sh /sicherung         # zusätzlich nur die letzten 14 Sicherungen behalten
ATTACHMENT_VOLUME=anemo_app-data tools/backup.sh /sicherung   # Anhänge aus dem Container-Volume
```
Wiederherstellen (Anwendung vorher stoppen):
```bash
docker compose stop app
CONFIRM=ja tools/restore.sh /sicherung/anemo-20261011-120000
docker compose start app
```
Die Sicherung der Anhänge enthält auch die **Freigabestände** (abgelegte Lieferpakete zu Freigabeentscheidungen,
Unterverzeichnis `.release-baselines`). Die Prüfsummen werden vor der Wiederherstellung kontrolliert. Probe ohne Risiko:
`CONFIRM=ja DB_NAME=anemo_probe SKIP_ATTACHMENTS=1 tools/restore.sh …` stellt in eine separate Datenbank wieder
her. Gemessen an einem migrierten Bestand mit einer Datenbank von knapp 2 GB: Sicherung in etwa 15 s, Wiederherstellung
in unter 2 min, alle Zählungen identisch. Empfehlung: täglich per cron, Sicherungen außerhalb des Servers aufbewahren,
Wiederherstellung vierteljährlich proben.

**Einzelnes Projekt umziehen** (z. B. aus der Erprobung in den Betrieb): Projektpaket statt Sicherung – siehe
*Administration → Projekte übertragen*. Von der Kommandozeile mit einem API-Token einer Person mit dem Recht
*Projekte übertragen*:
```bash
export ANEMO_TOKEN=anemo_…
node tools/project-package.ts export --url https://erprobung.firma.de --project SHOP --out shop.anemo.zip --wait
node tools/project-package.ts import --url https://anemo.firma.de --file shop.anemo.zip --new SHOP --name "Online-Shop" --dry-run
node tools/project-package.ts import --url https://anemo.firma.de --file shop.anemo.zip --new SHOP --name "Online-Shop"
```
`--dry-run` zeigt nur den Probelauf. `--into KEY` spielt in ein bestehendes Projekt ein; `--options datei.json`
übergibt Zuordnungen (Personen, Ergebnisstatus) und Regeln wie im Probelauf. Exporte eingeschränkter Projekte warten
auf die Freigabe der Systemadministration (`--wait` wartet darauf).

## Aktualisieren
**Versionsnummer:** steht in `package.json` (Wurzel) und wird für ein Release dort erhöht; Commit und Build-Zeitpunkt
gibt der Image-Bau mit (`--build-arg ANEMO_COMMIT=… --build-arg ANEMO_BUILT_AT=…`, in der CI automatisch). Sichtbar
im Kontomenü bzw. unter *Administration → Allgemein → Version* und über `GET /api/version`.

**Fester Name statt Servername:** Anemo am besten unter einem eigenen DNS-Namen betreiben (z. B. `anemo.firma.de` als
Alias auf den Docker-Host) und diesen als `ANEMO_PUBLIC_URL` eintragen. Links in OpenProject, E-Mails und Chat
(`…/go/…`) bleiben dann bei einem Umzug gültig – nur der Alias ändert sich. Ohne Alias: neue Adresse eintragen und unter
*Anbindungen → OpenProject* **Rückverweise aktualisieren …** ausführen.

```bash
tools/backup.sh /sicherung
git pull && docker compose --profile app up -d --build
```
Datenbankmigrationen laufen beim Start automatisch, in einer Transaktion mit Sperre. Ausgelieferte Migrationen
werden nie verändert (Prüfsummentest). Ein Zurückspielen geschieht über die Sicherung.

## Überwachung
- `GET /health` → `{"status":"UP"}` (prüft die Datenbank), geeignet für Load-Balancer und Docker-Healthcheck.
- Protokolle auf stdout/stderr (`docker compose logs app`): Start, Migrationen, Abgleichsläufe, Fehler bei
  Webhook- und Mail-Zustellung.
- In der Oberfläche: *Integrationen* (letzte Abgleiche, Mail-Fehler, Webhook-Zustellprotokoll), *Ereignisse*,
  *Zugriffsprotokoll*.

## Fremdkomponenten und SBOM

Jeder Build prüft die Fremdkomponenten und erzeugt eine Software-Stückliste (SBOM); siehe ADR-0026.

| Aufruf | Wirkung |
|---|---|
| `npm run third-party` | Lizenzen gegen `config/third-party.json`, bekannte Schwachstellen (npm audit) der ausgelieferten Komponenten, SBOM |
| `npm run sbom` | nur SBOM und Lizenzhinweise |
| `npm run build` | Prüfung (ohne Netz: Schwachstellenprüfung wird übersprungen) und Bau der Web-Oberfläche |

Ergebnis unter `build/third-party/`, im Container-Image unter `/app/third-party/`:

| Datei | Inhalt |
|---|---|
| `anemo.cdx.json` | CycloneDX 1.5: ausgelieferte Komponenten (Server, Web-Bundle, Basis-Image) mit Version, purl, SHA-512, Lizenz und Abhängigkeiten |
| `anemo.spdx.json` | dasselbe als SPDX 2.3 |
| `anemo-mit-entwicklung.cdx.json` | zusätzlich alle Werkzeuge zum Bauen und Testen |
| `THIRD-PARTY-NOTICES.md` | Lizenztexte der ausgelieferten Komponenten |
| `pruefbericht.md` | Bewertung je Komponente und gefundene Schwachstellen |

Regeln:
- Lizenzen ohne Auflagen sind erlaubt (MIT, BSD, Apache-2.0, ISC u. a.).
- Schwaches Copyleft (MPL, LGPL) ist bei ausgelieferten Komponenten prüfpflichtig.
- GPL, AGPL, SSPL und unbekannte Lizenzen brechen den Build ab.
- Begründete Ausnahmen trägt man in `config/third-party.json` unter `exceptions` ein (`"paket@version": "Begründung"`).
- Schwachstellen der Stufen „hoch“ und „kritisch“ brechen den Build ab.
- Docker-Build ohne Netz: `--build-arg THIRD_PARTY_AUDIT=--audit-optional`.

Die CI (GitLab und GitHub) legt die Ergebnisse als Artefakt ab. Zusätzlich scannt GitLab das fertige Image mit syft.
Diese Image-SBOM enthält auch Node.js und die Systembibliotheken des Basis-Images.

## Sicherheit
- Passwörter mit scrypt; Sitzungs- und API-Tokens nur als SHA-256-Hash gespeichert. Cookie HttpOnly, SameSite=Lax,
  Secure bei HTTPS.
- Rechte an jeder Route deklariert (Standard: angemeldet); eingeschränkte Projekte liefern für Nichtmitglieder 404.
- Content-Security-Policy ohne Inline-Skripte; Anhänge nur als Bild, PDF oder Text inline, alles andere (z. B. HTML,
  SVG) als Download.
- Eingefügte Texte und Wiki-Markup werden ohne `innerHTML` dargestellt; eingefügtes HTML wird bereinigt.
- Externe Dienste je Projekt sperrbar (KI, Agenten, Webhooks, Abgleiche); Zugriffsprotokoll für eingeschränkte
  Projekte.
- Container: distroless, non-root, schreibgeschütztes Dateisystem, `no-new-privileges`, alle Capabilities entzogen.
- `npm audit` läuft in der CI. Der Container enthält nur drei Laufzeitbibliotheken.

## Mengengerüst
Erprobt mit einem vollständig migrierten Jira/Zephyr-Bestand: rund hundert Projekte, mehrere tausend Testfälle mit
Zehntausenden Versionen und Ausführungen, Hunderttausende Schrittergebnisse, Anhänge im Gigabyte-Bereich, Datenbank
knapp 2 GB. Typische Antwortzeiten: Suche 0,1–0,3 s, Zyklen/Ausführungen/Matrix unter 15 ms, Ähnlichkeitsanalyse
eines Projekts mit mehreren hundert Testfällen unter 0,5 s, Lieferpaket eines Release unter 1 s ohne große Evidenzen.
Lasttest: 20 gleichzeitige Benutzer mit Denkzeit → Median 14 ms, p95 0,34 s; Überlast mit 50 Benutzern ohne Pause →
320 Anfragen/s ohne Fehler, p95 0,53 s. Details und Werkzeug: [Lasttest](../performance/lasttest-2026-10-11.md).

## Fehlerbehebung
| Symptom | Ursache / Lösung |
|---|---|
| „Anfrage von fremdem Ursprung abgelehnt“ | Reverse-Proxy gibt den `Host` nicht weiter bzw. `ANEMO_PUBLIC_URL`/Domain passt nicht |
| SSO: „Anmeldung abgelehnt / nicht für diese Anwendung“ | Client-ID, Redirect-URI (`…/api/auth/oidc/callback`) oder Issuer prüfen |
| SSO: „Konto existiert bereits (local)“ | Gleichnamiges lokales Konto; umbenennen oder deaktivieren, dann erneut anmelden |
| LDAP: „Verzeichnisdienst nicht erreichbar“ | `LDAP_URL`, Firewall, Zertifikat (`LDAP_TLS_INSECURE` nur zum Test) |
| Keine Mails | *Integrationen → E-Mail-Benachrichtigungen*: Testmail, letzter Fehler; Benutzer ohne E-Mail-Adresse erhalten nichts |
| OpenProject/GitLab „gesperrt“ | Projekt hat externe Dienste gesperrt (Absicht) – nur bewusst freigeben |
| Bild im Text „nicht vorhanden“ | Der Anhang fehlt bereits im Altsystem; der Link sucht gleichnamige Anhänge |
| Text im Markup-Modus statt visuell | Formatierung wäre nicht verlustfrei darstellbar (Schutz); im Markup bearbeiten |
