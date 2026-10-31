-- Stufe H: Umstieg komfortabel machen (eigene Felder, Prioritäten, Archivieren).

-- H5 Eigene Felder: Definitionen je Bereich, global (project_id null) oder je Projekt. Die Werte stehen wie bisher in
-- custom_fields (Testfall: versioniert in test_case_version; Zyklus; Ausführung) unter dem Schlüssel des Felds –
-- übernommene Zephyr-/Jira-Werte mit gleichem Schlüssel sind damit sofort zugeordnet.
create table field_definition (
  id          uuid primary key default uuidv7(),
  scope       text not null check (scope in ('test_case', 'cycle', 'execution')),
  key         text not null,
  name        text not null,
  type        text not null check (type in ('text', 'textarea', 'select', 'multiselect', 'number', 'date', 'checkbox', 'user')),
  options     text[] not null default '{}',
  required    boolean not null default false,
  project_id  uuid references project(id) on delete cascade,
  description text,
  sort_order  integer not null default 0,
  active      boolean not null default true,
  -- Auswahlwerte aus Jira/OpenProject abgleichen: {provider, project, kind, fieldId}
  options_source    jsonb,
  options_synced_at timestamptz,
  options_sync_error text,
  created_at  timestamptz not null default now()
);
create unique index field_definition_key_idx
  on field_definition (scope, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(key));

-- H5 Prioritäten als Werteliste (Wert = Anzeigename, wie bisher als Text an der Testfallversion)
create table priority (
  code        text primary key,
  color       text not null default '#888888',
  sort_order  integer not null default 0,
  is_default  boolean not null default false,
  active      boolean not null default true,
  description text
);
create unique index priority_default_idx on priority (is_default) where is_default;
insert into priority (code, color, sort_order, is_default) values
  ('Blocker', '#b42318', 10, false), ('Kritisch', '#d92d20', 20, false), ('Schwer', '#f79009', 30, true),
  ('Unwesentlich', '#2e90fa', 40, false), ('Trivial', '#98a2b3', 50, false);
insert into priority (code, sort_order)
  select distinct v.priority, 100 from test_case_version v where v.priority is not null and v.priority <> ''
  on conflict do nothing;

-- H4 Archivieren: ausgeblendet, aber vollständig erhalten und wiederherstellbar
alter table test_case add column archived_at timestamptz, add column archived_by text;
alter table test_cycle add column archived_at timestamptz, add column archived_by text;
create index test_case_active_idx on test_case (project_id) where archived_at is null;
