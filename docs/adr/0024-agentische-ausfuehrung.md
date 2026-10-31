# ADR-0024: Agentische Ausführung mit QA-Freigabe

- Status: angenommen
- Datum: 2026-10-11

## Kontext
KI-Agenten (z. B. Claude Code mit Playwright- und Anemo-MCP) sollen geeignete manuelle Tests ausführen,
Ergebnisse mit Evidenzen dokumentieren und Unklares an Menschen übergeben. Ihre Ergebnisse dürfen nicht
ungeprüft in Freigabeentscheidungen einfließen.

## Entscheidung
- **Agentenkonten**: Benutzer mit `is_agent`. Sie haben normale Projektrollen (in der Regel „Ausführen“) und
  greifen über API-Token bzw. MCP zu (ADR-0017/0018).
- **Freigabepflicht**: Ein Ergebnis, das ein Agentenkonto erfasst, erhält `review_state = pending`. Menschen mit
  „Ausführen“ geben es frei oder lehnen es ab. Ablehnen setzt das Ergebnis zurück, schreibt die Begründung in den
  Kommentar und weist neu zu. Agenten können nicht freigeben, und niemand gibt eigene Ergebnisse frei. Erfasst
  ein Mensch das Ergebnis neu, entfällt die Freigabe.
- **Eskalation**: Agenten übergeben unklare Fälle mit Begründung (`escalated`, Zuweisung entfernt).
- **Arbeitsverteilung**: `claim` vergibt die nächsten offenen Ausführungen atomar (`for update skip locked`).
  Mehrere Agenten bekommen nie dieselbe Ausführung.
- **Evidenzen** per Base64-Upload (MCP `attach_evidence`), einbettbar im Kommentar.
- Abschlussbericht und Cockpit weisen offene Freigaben und Eskalationen als Vorbehalt aus.

## Konsequenzen
Agenten skalieren die Ausführung, die Verantwortung bleibt bei QA. Welche Tests sich für Agenten eignen, ist eine
fachliche Entscheidung. Test-Health („immer bestanden“) liefert dafür Kandidaten.
