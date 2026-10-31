# ADR-0001: Architekturentscheidungen als ADRs dokumentieren

- Status: angenommen
- Datum: 2026-10-11

## Kontext
Die Plattform wird über viele Waves und teilweise durch Agenten entwickelt. Entscheidungen müssen
nachvollziehbar bleiben, auch für Agenten, die den Code später erweitern.

## Entscheidung
Wesentliche Entscheidungen werden als ADR im Format *Kontext / Entscheidung / Konsequenzen* unter
`docs/adr/NNNN-titel.md` abgelegt. ADRs werden nicht gelöscht, sondern durch neue ersetzt
("ersetzt durch ADR-XXXX"). Die Architektur wird zusätzlich als C4-Modell in
`docs/architecture/workspace.dsl` (Structurizr DSL) gepflegt.

## Konsequenzen
Jede Wave aktualisiert C4-Modell und ADRs (Teil der Definition of Done).
