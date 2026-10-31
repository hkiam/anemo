# Tests durch KI-Agenten ausführen lassen

1. **Agentenkonto** anlegen: *Administration → Benutzer → + Benutzer*, „🤖 KI-Agent“ ankreuzen, im Projekt die Rolle
   „Ausführen“ geben. Als dieses Konto ein **API-Token** erzeugen (Menü oben rechts).
2. **Agent einrichten**, z. B. Claude Code mit Anemo- und Browser-Werkzeugen (andere Clients wie Claude Desktop,
   Codex, OpenCode, pi, Gemini CLI, Cursor oder VS Code: [mcp.md](mcp.md#einrichten)):
```bash
export ANEMO_TOKEN=anemo_…
claude mcp add --transport http anemo https://anemo.example/api/mcp --header 'Authorization: Bearer ${ANEMO_TOKEN}'
claude mcp add playwright -- npx @playwright/mcp@latest
```
3. **Auftrag** an den Agenten, z. B.: *„Arbeite den Zyklus ‚Smoke 7.4‘ in Anemo ab: hole dir mit claim_next einen Test,
   lies ihn mit get_execution, führe die Schritte im Browser aus, hänge je Schritt einen Screenshot mit
   attach_evidence an und erfasse das Ergebnis mit record_result. Bei Unklarheit escalate.“*
4. **Freigabe**: Planung & Ausführung → *🤖 Freigaben* (oder Banner in der Ausführung) → *Freigeben* /
   *Ablehnen*. Offene Freigaben erscheinen im Cockpit und im Abschlussbericht als Vorbehalt.

Agentenwerkzeuge (MCP): `claim_next`, `my_assignments`, `get_execution`, `attach_evidence`, `record_result`,
`escalate`, `prepare_defect`. Projekte mit gesperrten externen Diensten sind für Agenten unsichtbar.
