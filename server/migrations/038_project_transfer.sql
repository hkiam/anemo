-- Stufe K1: Projekte übertragen (ADR-0027).

-- Instanzweite Rechte neben den Rollen je Projekt (ADR-0011). Vergabe nur durch die Systemadministration;
-- Systemadministratoren haben alle Rechte implizit.
create table global_permission (
  principal_type text not null check (principal_type in ('user', 'group')),
  principal_id   uuid not null,
  permission     text not null check (permission in ('PROJECT_TRANSFER')),
  granted_by     text not null,
  granted_at     timestamptz not null default now(),
  primary key (principal_type, principal_id, permission)
);

-- Export- und Importvorgänge: Antrag, Freigabe (sensible Projekte), Abruf. Zugleich Nachweis, wer wann welches
-- Projekt übertragen hat (Prüfsumme und Größe des Pakets). Bleibt nach dem Löschen des Projekts erhalten.
create table project_transfer (
  id              uuid primary key default uuidv7(),
  direction       text not null check (direction in ('export', 'import')),
  project_id      uuid references project(id) on delete set null,
  project_key     text not null,
  status          text not null check (status in ('pending', 'approved', 'rejected', 'done', 'failed')),
  sensitive       boolean not null default false,
  options         jsonb not null default '{}',
  requested_by    text not null,
  requested_at    timestamptz not null default now(),
  decided_by      text,
  decided_at      timestamptz,
  decision_note   text,
  expires_at      timestamptz,
  downloads       integer not null default 0,
  package_sha256  text,
  package_bytes   bigint,
  counts          jsonb,
  error           text,
  finished_at     timestamptz
);
create index project_transfer_status_idx on project_transfer (status, requested_at desc);
create index project_transfer_project_idx on project_transfer (project_key, requested_at desc);

-- Kennung dieser Anemo-Instanz (Herkunft von Projektpaketen; eine wiederhergestellte Sicherung behält sie)
create table instance_info (
  singleton    boolean primary key default true check (singleton),
  instance_id  uuid not null default uuidv7(),
  created_at   timestamptz not null default now()
);
insert into instance_info default values;
