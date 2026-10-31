-- Webhooks aus dem Ereignisprotokoll (ADR-0019): zuverlässige Zustellung mit eigenem Lesezeiger je Webhook.
create table webhook (
  id               uuid primary key default uuidv7(),
  name             text not null,
  url              text not null check (url ~ '^https?://'),
  format           text not null default 'json' check (format in ('json', 'chat')),
  event_types      text[] not null default '{}',     -- leer = alle
  project_id       uuid references project(id) on delete cascade,  -- null = alle Projekte
  secret           text not null,                    -- HMAC-SHA256-Signatur (X-Anemo-Signature)
  active           boolean not null default true,
  cursor_seq       bigint not null,                  -- zuletzt zugestelltes bzw. übersprungenes Ereignis
  failures         integer not null default 0,
  next_attempt_at  timestamptz,
  created_at       timestamptz not null default now(),
  created_by       text not null
);

create table webhook_delivery (
  id          bigint generated always as identity primary key,
  webhook_id  uuid not null references webhook(id) on delete cascade,
  event_seq   bigint not null,
  event_type  text not null,
  ok          boolean not null,
  status      integer,
  error       text,
  at          timestamptz not null default now()
);
create index webhook_delivery_idx on webhook_delivery (webhook_id, id desc);
