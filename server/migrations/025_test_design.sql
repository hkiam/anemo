-- Stufe H (Testdesign): wiederverwendbare Vorbedingungen, Anhänge an Schritten, Diskussion, Datensatz-Überschreibung.

-- Vorbedingungen als eigene, versionierte Objekte (Schlüssel PROJ-P1); Testfallversionen verweisen darauf
create table precondition (
  id              uuid primary key default uuidv7(),
  project_id      uuid not null references project(id) on delete cascade,
  key             text not null unique,
  title           text not null,
  content         text,
  current_version integer not null default 1,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  created_by      text not null,
  updated_at      timestamptz not null default now()
);
create index precondition_project_idx on precondition(project_id);
create table precondition_version (
  id              uuid primary key default uuidv7(),
  precondition_id uuid not null references precondition(id) on delete cascade,
  version_no      integer not null,
  title           text not null,
  content         text,
  change_note     text,
  created_at      timestamptz not null default now(),
  created_by      text not null,
  unique (precondition_id, version_no)
);
alter table project add column next_precondition integer not null default 1;
alter table test_case_version add column precondition_ids uuid[] not null default '{}';

-- Anhänge an einzelnen Schritten (Testfall: Schritt-ID; Ausführung: Evidenz zum Schrittergebnis)
alter table attachment add column step_id text;

-- Diskussion: Anmerkungen und Review-Kommentare (je Version), erledigt markierbar
create table comment (
  id           uuid primary key default uuidv7(),
  owner_type   text not null,
  owner_id     uuid not null,
  version_no   integer,
  parent_id    uuid references comment(id) on delete cascade,
  author       text not null,
  body         text not null,
  created_at   timestamptz not null default now(),
  edited_at    timestamptz,
  resolved_at  timestamptz,
  resolved_by  text
);
create index comment_owner_idx on comment(owner_type, owner_id, created_at);

-- Datensatz je Testplan bzw. Zyklus überschreiben (Zyklus vor Plan vor Testfall)
create table dataset_override (
  id           uuid primary key default uuidv7(),
  scope        text not null check (scope in ('plan', 'cycle')),
  scope_id     uuid not null,
  test_case_id uuid not null references test_case(id) on delete cascade,
  dataset      jsonb not null,
  updated_at   timestamptz not null default now(),
  updated_by   text not null,
  unique (scope, scope_id, test_case_id)
);
