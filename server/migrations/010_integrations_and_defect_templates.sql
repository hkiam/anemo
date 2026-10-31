-- Vorbereitung Integrationen (ADR-0015): Zuordnung Anemo-Projekt ↔ Projekt im Fremdsystem, Fehlervorlagen.

create table project_integration (
  project_id        uuid not null references project(id) on delete cascade,
  provider          text not null,                 -- z. B. openproject, jira, gitlab
  external_project  text not null,                 -- Kennung im Fremdsystem (OpenProject-Projekt-Identifier)
  settings          jsonb not null default '{}',   -- z. B. Typ/Priorität für neue Fehler
  primary key (project_id, provider)
);

-- Vorlagen für Fehlermeldungen; project_id null = für alle Projekte
create table defect_template (
  id              uuid primary key default uuidv7(),
  project_id      uuid references project(id) on delete cascade,
  name            text not null,
  title_template  text not null,
  body_template   text not null,
  is_default      boolean not null default false,
  created_at      timestamptz not null default now()
);

insert into defect_template(project_id, name, title_template, body_template, is_default) values
(null, 'Standard: fehlgeschlagener Test',
 '[{{testCase.key}}] {{step.action|kurz}}{{^step}}{{testCase.title}}{{/step}} – {{fehler|kurz}}',
 'h3. Zusammenfassung
{{fehler}}

h3. Umgebung
* Release/Build: {{cycle.release}} / {{cycle.build}}
* Umgebung: {{cycle.environment}}
* Konfiguration: {{configuration}}
* Testzyklus: {{cycle.name}}

h3. Testfall
{{testCase.key}} v{{testCase.version}} – {{testCase.title}}
{{#preconditions}}
*Vorbedingungen:*
{{preconditions}}
{{/preconditions}}

h3. Schritte zur Reproduktion
{{steps}}

{{#step}}
h3. Fehlgeschlagener Schritt {{step.no}}
*Aktion:* {{step.action}}
*Erwartet:* {{step.expected}}
*Tatsächlich:* {{step.actual}}
{{/step}}

h3. Evidenzen
{{evidence}}

Gemeldet aus Anemo von {{executedBy}}: {{link}}', true);
