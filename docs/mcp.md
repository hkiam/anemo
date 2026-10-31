# Anemo für KI-Agenten (MCP)

Anemo stellt einen **Model-Context-Protocol-Server** bereit: `POST /api/mcp` (Streamable HTTP, JSON-Antworten).
Agenten wie Claude Code, Claude Desktop oder eigene Agenten können damit alles tun, was die Oberfläche erlaubt:
Projekte und Testfälle anlegen und pflegen, Testpläne und Zyklen planen, Ergebnisse erfassen – und mit
Administrationsrechten auch die Anwendung administrieren (Benutzer, Gruppen, Rechte, Felder, Workflow, Anbindungen,
Einstellungen).

## Sicherheit
- Jeder Aufruf läuft mit dem **API-Token eines Benutzers** über die normale, rechtegeprüfte API. Ein Agent sieht
  und darf nie mehr als dieser Benutzer. Für Agenten empfiehlt sich ein eigener technischer Benutzer mit
  passender Rolle.
- Projekte mit **gesperrten externen Diensten** (Standard bei eingeschränkten Projekten, ADR-0014) sind für Agenten
  unsichtbar, denn Inhalte, die an ein KI-Modell gehen, verlassen das System.
- Ergebnisse, die ein Agent erfasst, tragen den Token-Benutzer als ausführende Person. Das Ereignisprotokoll zeigt
  jede Änderung.
- **Vollzugriff** (`api_operations`, `api_call`) nutzt dieselben Endpunkte wie die Oberfläche mit denselben Prüfungen:
  Administrationsfunktionen sind nur für Systemadministratoren sichtbar und aufrufbar, Projektfunktionen brauchen die
  passende Rolle. **Löschende Funktionen** (DELETE bzw. „löschen“/„endgültig“) laufen nur mit `confirm: true`.
  Nicht erreichbar sind Anmeldung, Kennwörter, Sitzungen, Kennwort-Rücksetzen und der MCP-Endpunkt selbst.

## Einrichten

Anemo spricht **Streamable HTTP** (kein SSE) und authentifiziert mit einem festen API-Token im Header
`Authorization: Bearer …` (kein OAuth). Das funktioniert mit allen Clients, die entfernte MCP-Server mit eigenen Headern
unterstützen.

**1. Token erzeugen:** in Anemo als der Benutzer, mit dessen Rechten der Agent arbeiten soll (am besten ein eigenes
Konto mit „🤖 KI-Agent“, siehe [agenten.md](agenten.md)): **Kontomenü → API-Tokens**. Das Token wird nur einmal
angezeigt.

**2. Token als Umgebungsvariable bereitstellen**, statt es in Konfigurationsdateien zu schreiben (diese landen leicht
in Git oder Sicherungen):

```bash
export ANEMO_TOKEN=anemo_…        # z. B. in ~/.zshrc, ~/.bashrc oder über einen Passwortmanager
```

**3. Client einrichten** – in den Beispielen ist `https://anemo.example` durch die Adresse Ihrer Instanz zu ersetzen
(`ANEMO_PUBLIC_URL`). Der Endpunkt ist immer `…/api/mcp`.

### Claude Code
```bash
claude mcp add --transport http --scope user anemo https://anemo.example/api/mcp \
  --header 'Authorization: Bearer ${ANEMO_TOKEN}'
claude mcp list                       # zeigt „✓ Connected“
```
`--scope user` gilt für alle Projekte; ohne Angabe nur für das aktuelle Verzeichnis. Für ein Team-Repository kann der
Eintrag als `.mcp.json` eingecheckt werden – das Token bleibt dank `${ANEMO_TOKEN}` außerhalb der Datei:
```json
{
  "mcpServers": {
    "anemo": {
      "type": "http",
      "url": "https://anemo.example/api/mcp",
      "headers": { "Authorization": "Bearer ${ANEMO_TOKEN}" }
    }
  }
}
```

### Claude Desktop
Claude Desktop bindet Server mit festem Token über eine lokale Brücke ein
([`mcp-remote`](https://www.npmjs.com/package/mcp-remote), braucht Node.js ≥ 18). *Einstellungen → Entwickler →
Konfiguration bearbeiten* öffnet `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows:
`%APPDATA%\Claude\`):
```json
{
  "mcpServers": {
    "anemo": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://anemo.example/api/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer anemo_…" }
    }
  }
}
```
Danach Claude Desktop neu starten. `Authorization:${AUTH_HEADER}` ohne Leerzeichen schreiben – Claude Desktop unter
Windows reicht Leerzeichen in Argumenten sonst falsch weiter. Bei einer Instanz ohne TLS (nur im lokalen Netz)
zusätzlich `"--allow-http"` an die Argumente anhängen; für `http://localhost` ist das nicht nötig. Protokolle von
mcp-remote stehen in den Logs von Claude Desktop (macOS: `~/Library/Logs/Claude/mcp-server-anemo.log`).

> Die *Connectors* in den Einstellungen (benutzerdefinierter Connector per URL) eignen sich nur bedingt: Sie verbinden
> sich aus der Cloud von Anthropic, die Instanz muss also aus dem Internet erreichbar sein, und feste Token-Header
> stehen dort bisher nur einem Teil der Organisationen (Beta) zur Verfügung. Für Instanzen im eigenen Netz ist die
> Brücke oben der richtige Weg.

### Codex (OpenAI)
```bash
codex mcp add anemo --url https://anemo.example/api/mcp --bearer-token-env-var ANEMO_TOKEN
codex mcp list
```
oder direkt in `~/.codex/config.toml`:
```toml
[mcp_servers.anemo]
url = "https://anemo.example/api/mcp"
bearer_token_env_var = "ANEMO_TOKEN"
```

### OpenCode
In `opencode.json` (Projekt) bzw. `~/.config/opencode/opencode.json` (global):
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "anemo": {
      "type": "remote",
      "url": "https://anemo.example/api/mcp",
      "headers": { "Authorization": "Bearer {env:ANEMO_TOKEN}" }
    }
  }
}
```
Prüfen mit `opencode mcp list` (zeigt „✓ anemo connected“).

### pi
pi bringt MCP selbst mit (kein Adapter nötig):
```bash
pi mcp add anemo --url https://anemo.example/api/mcp --bearer-token-env-var ANEMO_TOKEN
pi mcp list
```
Der Eintrag landet in `~/.pi/agent/mcp.json` (mit `-l` im Projekt unter `.pi/mcp.json`, wird erst nach
Projektfreigabe gelesen). Von Hand: `"anemo": { "url": "https://anemo.example/api/mcp", "headers": { "Authorization":
"Bearer ${ANEMO_TOKEN}" } }` unter `mcpServers`. In einer laufenden Sitzung zeigt `/mcp` den Verbindungsstatus.

### Gemini CLI
```bash
gemini mcp add --scope user --transport http anemo https://anemo.example/api/mcp \
  --header 'Authorization: Bearer $ANEMO_TOKEN'
gemini mcp list
```
bzw. in `~/.gemini/settings.json`: `"mcpServers": { "anemo": { "httpUrl": "https://anemo.example/api/mcp", "headers":
{ "Authorization": "Bearer $ANEMO_TOKEN" } } }`. Zeigt `gemini mcp list` „Disabled“, ist der Ordner nicht als
vertrauenswürdig markiert – Gemini startet dann keine MCP-Server. Den Ordner beim Start von `gemini` als
vertrauenswürdig bestätigen (gespeichert in `~/.gemini/trustedFolders.json`).

### Cursor, VS Code und andere
- **Cursor** (`~/.cursor/mcp.json` oder `.cursor/mcp.json`):
  `{ "mcpServers": { "anemo": { "url": "https://anemo.example/api/mcp", "headers": { "Authorization": "Bearer ${env:ANEMO_TOKEN}" } } } }`
- **VS Code / GitHub Copilot** (`.vscode/mcp.json`) – fragt das Token einmal ab und speichert es verschlüsselt:
  ```json
  {
    "inputs": [{ "type": "promptString", "id": "anemo-token", "description": "Anemo API-Token", "password": true }],
    "servers": {
      "anemo": {
        "type": "http",
        "url": "https://anemo.example/api/mcp",
        "headers": { "Authorization": "Bearer ${input:anemo-token}" }
      }
    }
  }
  ```
- **Andere Clients**: Streamable HTTP mit URL und Header `Authorization: Bearer <Token>` eintragen. Kann ein Client
  nur lokale (stdio-)Server starten, hilft dieselbe Brücke wie bei Claude Desktop (`npx -y mcp-remote <URL> --header
  "Authorization:${AUTH_HEADER}"`).

### Fehlersuche
| Meldung | Ursache |
|---|---|
| 401 / „Bitte anmelden“ | Token fehlt, ist abgelaufen oder die Umgebungsvariable ist im Client nicht gesetzt (Desktop-Apps sehen Variablen aus `~/.zshrc` oft nicht – dann den Wert in `env` der Konfiguration eintragen) |
| 403 „KI-Agenten sind in der Administration ausgeschaltet“ | *Administration → KI* → Schalter „KI-Agenten (MCP)“ einschalten (`AGENTS_ENABLED`) |
| Server verbunden, aber Projekt fehlt | Token-Benutzer ist nicht Mitglied, oder das Projekt sperrt externe Dienste (eingeschränkte Projekte) |
| mcp-remote: „Dynamic Client Registration rejected (HTTP 404)“, danach „SSE error: Non-200 status code (405)“ | Token falsch oder abgelaufen: Anemo antwortet mit 401, mcp-remote versucht daraufhin OAuth, das Anemo nicht anbietet. Token und `AUTH_HEADER` (`Bearer …`) prüfen. Ältere Anemo-Versionen melden stattdessen „Unexpected token '<' … is not valid JSON“ |
| Client versucht OAuth bzw. SSE | Client unterstützt kein Streamable HTTP mit festen Headern → Brücke `mcp-remote` verwenden |

Getestet am 31.10.2026 mit Claude Code 2.1, Codex CLI 0.154, OpenCode 1.17, Gemini CLI 0.55 und mcp-remote 0.15.2
(Brücke für Claude Desktop, mit der Konfiguration oben; Verbindung und Werkzeugaufruf). pi, Cursor und VS Code sind
nach deren Dokumentation beschrieben.

## Werkzeuge
| Werkzeug | Zweck |
|---|---|
| `search` | übergreifende Suche (Testfälle, Zyklen, Pläne, Kommentare, Ticketverweise, Anhänge) |
| `list_projects`, `list_test_cases`, `get_test_case` | Testbestand lesen (Texte sind Jira-Wiki-Markup) |
| `list_plans`, `list_cycles`, `get_cycle_results`, `get_execution` | Planung und Ergebnisse lesen |
| `find_tests_for_issue` | Tests zu einem Jira-/OpenProject-Ticket |
| `release_cockpit`, `test_health` | Freigabeempfehlung, Pflegebedarf |
| `create_cycle` | Zyklus anlegen und Testfälle aufnehmen |
| `record_result` | Ergebnis mit Schrittergebnissen (Schrittnummer) und Fehlerschlüsseln erfassen |
| `prepare_defect` | Fehlermeldung aus Vorlage vorbereiten (speichert nichts) |
| `create_project` | Projekt anlegen (Systemadministration) |
| `create_test_case`, `update_test_case` | Testfall anlegen bzw. ändern (neue Version; nur angegebene Felder ändern sich). Schritte als `{action, data, expected}`, Abschnitte als `{section}` |
| `set_test_case_status` | Status (Workflow), Ordner, Verantwortliche, Schätzung – ohne neue Version |
| `create_plan`, `add_tests_to_cycle`, `assign_executions` | Testplan anlegen, Testfälle in einen Zyklus aufnehmen, Ausführungen zuweisen |
| `api_operations` | **alle** Funktionen finden (Text, Bereich) bzw. Parameter und Eingabeschema einer Funktion anzeigen |
| `api_call` | **jede** Funktion aufrufen, z. B. `PUT /api/projects/DEMO/members`, `POST /api/admin/users`, `GET /api/reports/completion/<plan>?format=md` |

**Einheitliche Parameter:** Die Werkzeuge nennen Parameter so wie im jeweiligen Schema (`project`, `planId`,
`cycleId`, `executionId`, `key`). Gängige Varianten werden angenommen und abgebildet: `projectKey` → `project`,
`plan` → `planId`, `cycle` → `cycleId`, `execution` → `executionId`, `testCase`/`testCaseKey` → `key`,
`folder` → `folderId`. Jede Antwort steht zusätzlich strukturiert in `structuredContent` (Listen als `{ items }`),
jedes Werkzeug meldet dafür ein `outputSchema`.

**Massenfreigabe** (Testmanagement): `api_call` mit `POST /api/projects/<KEY>/test-cases/approve`, Körper
`{ "aql": "…" }` oder `{ "ids": [...] }`, optional `"dryRun": true` zum Zählen. Eigene Versionen werden übersprungen
(Vier-Augen-Prinzip).

Typischer Ablauf für alles, was kein eigenes Werkzeug hat: `api_operations` mit Suchtext (z. B. „Workflow“, „Benutzer“,
„Berichtsprofil“) → `api_operations` mit `operation` für das Eingabeschema → `api_call`.
