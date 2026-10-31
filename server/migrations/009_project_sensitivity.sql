-- Sensibilität je Projekt (ADR-0014): Zugriffsprotokoll für eingeschränkte Projekte, Sperre für externe Dienste.

-- 'blocked': keine Inhalte an externe Dienste (KI-Funktionen, Integrationen, die Inhalte übertragen)
alter table project add column external_services text not null default 'allowed'
  check (external_services in ('allowed', 'blocked'));
update project set external_services = 'blocked' where visibility = 'restricted';

create table access_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  project_id  uuid not null references project(id) on delete cascade,
  user_id     uuid references app_user(id) on delete set null,
  username    text not null,
  action      text not null,           -- read | execute | edit | manage
  object_kind text not null,           -- project | testCase | execution | attachment | …
  object_id   text,
  path        text not null
);
create index access_log_project_idx on access_log (project_id, at desc);
