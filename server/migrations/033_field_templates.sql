-- Stufe J5: Feldvorlagen – formatierter Standardaufbau für Felder (z. B. Aktion „Vorbedingung / Vorgehen“), systemweit
-- (project_id null) oder je Projekt. Optional Standard für neue Schritte.
create table field_template (
  id          uuid primary key default uuidv7(),
  project_id  uuid references project(id) on delete cascade,
  name        text not null,
  fields      text[] not null,
  content     text not null,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  created_by  text not null,
  updated_at  timestamptz not null default now(),
  updated_by  text not null
);
create unique index field_template_name_idx on field_template(coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index field_template_project_idx on field_template(project_id);

-- Startvorlagen: das in übernommenen Testfällen verbreitete Muster und eine Variante mit echten Zwischenüberschriften
insert into field_template(project_id, name, fields, content, created_by, updated_by) values
  (null, 'Vorbedingung / Vorgehen', '{action}',
   E'{code} Vorbedingung {code}\n…\n{code} Vorgehen {code}\n* …', 'system', 'system'),
  (null, 'Vorbedingung / Vorgehen (mit Überschriften)', '{action}',
   E'*Vorbedingung*\n* …\n\n*Vorgehen*\n# …', 'system', 'system'),
  (null, 'Erwartet als Liste', '{expected}',
   E'* …\n* …', 'system', 'system');
