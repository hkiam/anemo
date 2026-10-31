-- Stufe G: Datensätze, Dauer, Testsets, explorative Sitzungen, KI-Arbeitshilfen.

-- G1 Parametrisierte Tests: Datensatz am Testfall (versioniert) {columns: [..], rows: [[..]]}; Platzhalter ${spalte}
alter table test_case_version add column dataset jsonb;
-- je Datenzeile ein Durchlauf: [{index, values, status, comment, stepResults}]
alter table test_execution add column iterations jsonb not null default '[]';

-- G4 Dauer je Ausführung: Beginn und aktive Bearbeitungszeit (Sekunden, aufsummiert)
alter table test_execution add column started_at timestamptz;
alter table test_execution add column duration_seconds integer not null default 0;

-- G4 Testsets: feste Liste oder gespeicherter Filter
create table test_set (
  id            uuid primary key default uuidv7(),
  project_id    uuid not null references project(id) on delete cascade,
  name          text not null,
  description   text,
  kind          text not null check (kind in ('static', 'dynamic')),
  test_case_ids uuid[] not null default '{}',
  query         text,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (project_id, name)
);

-- G2 Explorative Testsitzungen im Zyklus
create table exploratory_session (
  id               uuid primary key default uuidv7(),
  cycle_id         uuid not null references test_cycle(id) on delete cascade,
  charter          text not null,
  areas            text,
  timebox_minutes  integer not null default 60,
  tester           text,
  status           text not null default 'planned' check (status in ('planned', 'running', 'paused', 'done')),
  started_at       timestamptz,
  running_since    timestamptz,
  ended_at         timestamptz,
  duration_seconds integer not null default 0,
  notes            text,
  summary          text,
  findings         jsonb not null default '[]',
  created_by       text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index exploratory_session_cycle_idx on exploratory_session(cycle_id);

-- G5 KI: Projektkontext (Glossar, Stilregeln), Modellprofil je Skill, Kennzeichnung KI-gestützter Inhalte,
-- Bewertung/Fazit des Testplans (z. B. aus KI-Entwurf, vom Testmanagement geprüft)
alter table project add column ai_context text;
alter table ai_prompt add column profile text;
alter table ai_prompt alter column system drop not null;
alter table test_case_version add column ai_assisted text;
alter table test_plan add column assessment text;
