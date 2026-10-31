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

## Einrichten (Claude Code)
```bash
claude mcp add --transport http anemo https://anemo.example/api/mcp --header "Authorization: Bearer anemo_…"
```

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
