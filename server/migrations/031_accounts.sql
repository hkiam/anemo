-- Konten und Kennwörter: Pflichtwechsel, dauerhafte Sperre nach Fehlversuchen, Links zum Zurücksetzen
alter table app_user
  add column must_change_password boolean not null default false,
  add column password_changed_at timestamptz,
  add column failed_logins integer not null default 0,
  add column locked_until timestamptz;

-- Einmal-Links zum Zurücksetzen (nur der SHA-256 des Tokens wird gespeichert)
create table password_reset (
  token_hash  text primary key,
  user_id     uuid not null references app_user(id) on delete cascade,
  created_at  timestamptz not null default now(),
  created_by  text,                -- null = selbst angefordert, sonst Benutzername der Administration
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index password_reset_user_idx on password_reset (user_id);
