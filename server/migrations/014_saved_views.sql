-- Gespeicherte Ansichten (Roadmap F): Filter/Ansichten als benannte Lesezeichen, privat oder für alle im Projekt.
create table saved_view (
  id          uuid primary key default uuidv7(),
  user_id     uuid references app_user(id) on delete cascade,  -- null im Modus ohne Anmeldung
  owner_name  text not null,
  project_id  uuid not null references project(id) on delete cascade,
  page        text not null check (page in ('repo', 'cycles', 'health')),
  name        text not null,
  query       text not null,            -- URL-Parameter der Ansicht (z. B. "status=FAIL&cfg=database:Oracle")
  shared      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index saved_view_project_idx on saved_view (project_id, page);
