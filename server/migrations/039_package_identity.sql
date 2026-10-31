-- Stufe K4/K5: Projektpaket in bestehende Projekte importieren, Hintergrundaufträge (ADR-0027).

-- Herkunft importierter Objekte: Ein erneuter Import desselben Pakets (oder eines späteren aus derselben Quelle)
-- aktualisiert statt zu verdoppeln.
create table package_identity (
  source_instance uuid not null,
  source_type     text not null,
  source_id       uuid not null,
  project_id      uuid not null references project(id) on delete cascade,
  target_id       uuid not null,
  created_at      timestamptz not null default now(),
  primary key (source_instance, source_type, source_id, project_id)
);
create index package_identity_target_idx on package_identity (project_id, source_type, target_id);

-- Export und Import laufen als Hintergrundauftrag mit Fortschritt
alter table project_transfer drop constraint project_transfer_status_check;
alter table project_transfer add constraint project_transfer_status_check
  check (status in ('pending', 'approved', 'rejected', 'running', 'ready', 'done', 'failed'));
alter table project_transfer add column progress jsonb;
alter table project_transfer add column report jsonb;
