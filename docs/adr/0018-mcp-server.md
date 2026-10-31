# ADR-0018: MCP-Server über die rechtegeprüfte API

- Status: angenommen
- Datum: 2026-10-11

## Kontext
KI-Agenten sollen mit Anemo arbeiten: Tests zu einem Ticket finden, Zyklen planen, Ergebnisse erfassen. Das ist die
Grundlage für die agentische Ausführung (D3). Agenten dürfen weder Rechte noch Sensibilitätsregeln umgehen.

## Entscheidung
- MCP-Endpunkt `POST /api/mcp` (JSON-RPC 2.0, Streamable HTTP mit JSON-Antworten, ohne SDK). Unterstützt werden
  `initialize`, `ping`, `tools/list` und `tools/call`. `GET` antwortet mit 405, weil es keinen Server-Push gibt.
- **Jedes Werkzeug ruft intern die reguläre HTTP-API** mit der Identität des Aufrufers (Token bzw. Sitzung). Damit
  gelten dieselbe Validierung, Rechteprüfung, Ereignisprotokollierung und das Zugriffsprotokoll ohne zweite
  Implementierung.
- Interne Aufrufe tragen den Kanal „Agent“. Für diesen Kanal sind Projekte mit `external_services = blocked`
  weder in Listen noch im Direktzugriff sichtbar (404).
- Werkzeuge sind als lesend oder ändernd gekennzeichnet (`readOnlyHint`). Antworten werden auf 60.000 Zeichen
  begrenzt, mit der Aufforderung, die Abfrage einzugrenzen.

## Konsequenzen
Neue Fähigkeiten für Agenten entstehen durch neue Werkzeugdefinitionen auf bestehenden Endpunkten.
Agentische Ausführung (D3) und KI-Unterstützung (D4) bauen darauf auf und bleiben durch dieselben Regeln begrenzt.
