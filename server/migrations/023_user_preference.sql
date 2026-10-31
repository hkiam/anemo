-- Persönliche Einstellungen je Benutzer (z. B. Aufbau der Startseite). Schlüssel ist der Anmeldename,
-- damit es auch im Betrieb ohne Benutzerkonten (Kopfzeilen-Identität) funktioniert.
create table user_preference (
  username   text not null,
  name       text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (username, name)
);
