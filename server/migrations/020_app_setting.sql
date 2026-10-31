-- Einstellungen aus der Oberfläche: überschreiben gleichnamige Umgebungsvariablen (ADR-0025).
-- Geheimnisse (Passwörter, Tokens, API-Schlüssel) liegen nur verschlüsselt vor (AES-256-GCM).
create table app_setting (
  key         text primary key,
  value       text not null,           -- Klartext bzw. bei secret: iv.tag.ciphertext (base64url)
  secret      boolean not null default false,
  updated_by  text not null,
  updated_at  timestamptz not null default now()
);

-- Wer hat wann welche Einstellung gesetzt oder zurückgesetzt (ohne Werte)
create table app_setting_log (
  id          bigserial primary key,
  key         text not null,
  action      text not null check (action in ('set', 'reset')),
  changed_by  text not null,
  changed_at  timestamptz not null default now()
);

-- KI: Prompts (Skills) anpassbar; ohne Eintrag gilt der eingebaute Standard
create table ai_prompt (
  key         text primary key,
  system      text not null,
  updated_by  text not null,
  updated_at  timestamptz not null default now()
);

-- KI: Nutzung je Aufruf (ohne Inhalte) – Kostenbremse, Transparenz, Fehleranalyse
create table ai_call_log (
  id             bigserial primary key,
  at             timestamptz not null default now(),
  actor          text not null,
  project_id     uuid references project(id) on delete set null,
  feature        text not null,
  model          text not null,
  prompt_chars   int not null,
  response_chars int not null default 0,
  duration_ms    int not null,
  ok             boolean not null,
  error          text
);
create index ai_call_log_at on ai_call_log(at);
