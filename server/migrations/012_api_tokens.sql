-- API-Tokens für CI-Pipelines, Skripte und Agenten (ADR-0017). Ein Token handelt mit den Rechten seines Benutzers.
create table api_token (
  id            uuid primary key default uuidv7(),
  user_id       uuid not null references app_user(id) on delete cascade,
  name          text not null,
  token_hash    text not null unique,      -- SHA-256; das Token selbst wird nur einmal angezeigt
  prefix        text not null,             -- erste Zeichen zur Wiedererkennung
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  last_used_at  timestamptz
);
create index api_token_user_idx on api_token (user_id);
