# ADR-0002: Modularer Monolith in TypeScript/Node ohne Build-Schritt

- Status: angenommen (ersetzt den ersten Entwurf „Java 21 / Spring Boot“ vom selben Tag)
- Datum: 2026-10-11

## Kontext
Anforderungen des Product Owners: schlanke Container, wenige Abhängigkeiten und damit wenige
Sicherheitsprobleme, schnelle Entwicklungsrunden mit Hot-Reload. Ab Wave 3 (MCP) und Wave 7 (Copilot)
sind TypeScript-SDKs (MCP, LLM) erstklassig. Rust wurde erwogen, bringt für eine CRUD-/Workflow-Plattform
mit ~10⁴ Testfällen aber vor allem langsamere Iteration.

## Entscheidung
- **Node ≥ 22.18 mit nativem Type-Stripping**: `.ts` wird direkt ausgeführt, kein Transpiler/Bundler
  im Backend. `node --watch` startet in < 1 s neu. `tsc --noEmit` dient nur der Typprüfung.
  Konsequenz: nur „erasable syntax“ (keine `enum`, keine Parameter-Properties, Importe mit `.ts`).
- **Laufzeitabhängigkeiten** (alle ohne transitive Abhängigkeiten): `hono` + `@hono/node-server` (HTTP),
  `zod` (Validierung, OpenAPI-Erzeugung), `postgres` (Treiber). Neue Abhängigkeiten nur mit Begründung.
- **Tests** mit dem eingebauten `node:test` gegen echte PostgreSQL (eine frische DB je Testdatei).
- **Modulgrenzen** wie bei Spring Modulith: `server/src/modules/<modul>/index.ts` ist die einzige
  öffentliche Schnittstelle; `test/modularity.test.ts` erzwingt das und verbietet Zyklen.
- **Frontend**: React + Vite (HMR), ohne Router-/State-Bibliotheken. Wird im Container vom Backend ausgeliefert.
- **Container**: distroless Node, non-root, read-only Dateisystem, keine Shell.

## Konsequenzen
Sehr kleine Angriffsfläche und schnelle Runden. Gemeinsame Sprache für UI, API, MCP und Agenten.
Fehlende Laufzeit-Typprüfung wird durch zod an allen Systemgrenzen ausgeglichen.
