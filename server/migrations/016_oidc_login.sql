-- Unternehmensanmeldung (ADR-0021): laufende OIDC-Anmeldungen (state → PKCE-Verifier, Nonce), kurzlebig.
create table oidc_login (
  state       text primary key,
  verifier    text not null,
  nonce       text not null,
  return_to   text not null default '/',
  expires_at  timestamptz not null
);
-- Externe Kennung (z. B. OIDC "sub", LDAP-DN) für stabile Zuordnung auch bei Namensänderung
alter table app_user add column external_id text;
create unique index app_user_external_idx on app_user (source, external_id) where external_id is not null;
alter table user_group add column external_id text;
create unique index user_group_external_idx on user_group (source, external_id) where external_id is not null;
