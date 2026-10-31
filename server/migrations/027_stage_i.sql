-- Stufe I: Zwischenbericht, Beobachten, Schrittbibliothek, unstrukturierte Tests, Fehler je Schritt mit Schweregrad,
-- Ausführung nur durch Zuständige, CI-Läufe, Abdeckung im Ticket, Fehler in Jira.

-- Lagebild des Testmanagements für den Teststatusbericht (Hindernisse, nächste Schritte)
alter table test_plan add column status_note text, add column status_note_at timestamptz, add column status_note_by text;

-- Benachrichtigungsarten: Erwähnung (fehlte in der Prüfregel) und Beobachten
alter table user_notification drop constraint user_notification_kind_check;
alter table user_notification add constraint user_notification_kind_check check (kind in ('assigned', 'retest', 'failed_own', 'mentioned', 'watched'));
insert into user_notification(user_id, kind) select id, k from app_user, unnest(array['mentioned', 'watched']) k on conflict do nothing;

-- Beobachten: Testfall, Zyklus oder Testplan
create table watch (
  username     text not null,
  object_type  text not null check (object_type in ('TEST_CASE', 'TEST_CYCLE', 'TEST_PLAN')),
  object_id    uuid not null,
  created_at   timestamptz not null default now(),
  primary key (username, object_type, object_id)
);
create index watch_object_idx on watch(object_type, object_id);

-- Schrittbibliothek: benannte Schrittfolgen zum Einfügen (Kopie mit Herkunft)
create table step_block (
  id           uuid primary key default uuidv7(),
  project_id   uuid not null references project(id) on delete cascade,
  name         text not null,
  description  text,
  steps        jsonb not null default '[]',
  tags         text[] not null default '{}',
  created_at   timestamptz not null default now(),
  created_by   text not null,
  updated_at   timestamptz not null default now(),
  updated_by   text not null,
  archived_at  timestamptz
);
create index step_block_project_idx on step_block(project_id);

-- Unstrukturierter Test (Freitext statt Schritte)
alter table test_case_version drop constraint test_case_version_format_check;
alter table test_case_version add constraint test_case_version_format_check check (format in ('CLASSIC', 'GHERKIN', 'PLAIN'));

-- Fehler je Schritt und Schweregrad
alter table external_reference add column step_id text, add column severity text;

-- Ausführung nur durch Zuständige (Projekteinstellung)
alter table project add column execute_only_assignee boolean not null default false;

-- Angestoßene CI-Läufe je Zyklus
create table ci_run (
  id            uuid primary key default uuidv7(),
  cycle_id      uuid not null references test_cycle(id) on delete cascade,
  provider      text not null default 'gitlab',
  external_id   text not null,
  ref           text not null,
  url           text,
  status        text not null,
  triggered_by  text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index ci_run_cycle_idx on ci_run(cycle_id, created_at desc);

-- Zuletzt ins Ticket gemeldeter Abdeckungsstand je Anforderung
create table coverage_push (
  provider      text not null,
  external_key  text not null,
  state         text not null,
  detail        text not null,
  pushed_at     timestamptz not null default now(),
  primary key (provider, external_key)
);
