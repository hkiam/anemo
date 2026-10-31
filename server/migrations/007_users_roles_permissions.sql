-- Benutzer, Gruppen, Rollen je Projekt, Sitzungen (ADR-0011).

create table app_user (
  id              uuid primary key default uuidv7(),
  username        text not null,
  display_name    text not null,
  email           text,
  -- scrypt: "scrypt$N$r$p$salt$hash" (Base64); null bei externer Anmeldung (LDAP/OIDC)
  password_hash   text,
  source          text not null default 'local' check (source in ('local', 'ldap', 'oidc')),
  active          boolean not null default true,
  is_system_admin boolean not null default false,
  created_at      timestamptz not null default now(),
  last_login_at   timestamptz
);
create unique index app_user_username_idx on app_user (lower(username));

create table user_group (
  id           uuid primary key default uuidv7(),
  name         text not null,
  description  text,
  source       text not null default 'local' check (source in ('local', 'ldap', 'oidc')),
  created_at   timestamptz not null default now()
);
create unique index user_group_name_idx on user_group (lower(name));

create table group_member (
  group_id  uuid not null references user_group(id) on delete cascade,
  user_id   uuid not null references app_user(id) on delete cascade,
  primary key (group_id, user_id)
);

-- Rollen sind feste Stufen: VIEWER < TESTER < DESIGNER < PROJECT_ADMIN (Rechte siehe ADR-0011)
create table project_member (
  project_id      uuid not null references project(id) on delete cascade,
  principal_type  text not null check (principal_type in ('user', 'group')),
  principal_id    uuid not null,
  role            text not null check (role in ('VIEWER', 'TESTER', 'DESIGNER', 'PROJECT_ADMIN')),
  created_at      timestamptz not null default now(),
  primary key (project_id, principal_type, principal_id)
);
create index project_member_principal_idx on project_member (principal_type, principal_id);

-- internal: alle angemeldeten Benutzer dürfen lesen; restricted: nur Mitglieder sehen das Projekt überhaupt
alter table project add column visibility text not null default 'internal' check (visibility in ('internal', 'restricted'));

create table user_session (
  token_hash    text primary key,           -- SHA-256 des Sitzungstokens (Token selbst wird nie gespeichert)
  user_id       uuid not null references app_user(id) on delete cascade,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  user_agent    text
);
create index user_session_user_idx on user_session (user_id);
