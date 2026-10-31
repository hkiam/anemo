-- Review-Befunde 11.10.2026 (Teil 3 / Sicherheit Teil 2):
-- Abdeckungsstand im Ticket je Anemo-Projekt, Herkunft von Verweisen, eigene Werte für den Schweregrad.

-- Abdeckung im Ticket: Stand je (Projekt, Anforderung) statt global je Anforderung. Vorhandene Stände werden den
-- Projekten zugeordnet, deren Testfälle die Anforderung verknüpfen (sonst gäbe es einmalig einen neuen Kommentar).
create table coverage_push_new (
  project_id    uuid not null references project(id) on delete cascade,
  provider      text not null,
  external_key  text not null,
  state         text not null,
  detail        text not null,
  pushed_at     timestamptz not null default now(),
  primary key (project_id, provider, external_key)
);
insert into coverage_push_new(project_id, provider, external_key, state, detail, pushed_at)
select distinct tc.project_id, c.provider, c.external_key, c.state, c.detail, c.pushed_at
from coverage_push c
join external_reference r on r.provider = c.provider and r.external_key = c.external_key and r.owner_type = 'TEST_CASE'
join test_case tc on tc.id = r.owner_id
on conflict do nothing;
drop table coverage_push;
alter table coverage_push_new rename to coverage_push;
alter table coverage_push rename constraint coverage_push_new_pkey to coverage_push_pkey;
create index coverage_push_key_idx on coverage_push(provider, external_key, pushed_at desc);

-- Herkunft eines Verweises: Konto, das ihn angelegt hat. Bestehende Verweise gelten als Altbestand (Migration bzw.
-- Parallelbetrieb) und werden weiter abgeglichen; neue, von Hand angelegte nur bei Projektbezug (siehe Jira-Abgleich).
alter table external_reference add column created_by text;
update external_reference set created_by = 'altbestand';

-- Schweregrad mit eigenen Werten (nicht mehr dieselben Begriffe wie die Testfallpriorität)
update external_reference set severity = case severity
    when 'Blocker' then 'Gravierend' when 'Kritisch' then 'Hoch' when 'Schwer' then 'Mittel'
    when 'Mittel' then 'Gering' when 'Gering' then 'Kosmetisch' else severity end
  where severity is not null;
update project_integration set settings = jsonb_set(settings, '{priorities}', coalesce((
    select jsonb_object_agg(case e.k
      when 'Blocker' then 'Gravierend' when 'Kritisch' then 'Hoch' when 'Schwer' then 'Mittel'
      when 'Mittel' then 'Gering' when 'Gering' then 'Kosmetisch' else e.k end, e.v)
    from jsonb_each(settings->'priorities') e(k, v)), '{}'::jsonb))
  where jsonb_typeof(settings->'priorities') = 'object';

-- Projekt des Besitzers eines Verweises (für den Abgleich nur mit Projektbezug)
create function reference_owner_project(p_owner_type text, p_owner_id uuid) returns uuid language sql stable as $$
  select case p_owner_type
    when 'TEST_CASE' then (select project_id from test_case where id = p_owner_id)
    when 'TEST_EXECUTION' then (select c.project_id from test_execution e join test_cycle c on c.id = e.cycle_id where e.id = p_owner_id)
    when 'TEST_CYCLE' then (select project_id from test_cycle where id = p_owner_id)
    when 'TEST_PLAN' then (select project_id from test_plan where id = p_owner_id)
    when 'EXPLORATORY_SESSION' then (select c.project_id from exploratory_session s join test_cycle c on c.id = s.cycle_id where s.id = p_owner_id)
    when 'PRECONDITION' then (select project_id from precondition where id = p_owner_id)
  end
$$;
