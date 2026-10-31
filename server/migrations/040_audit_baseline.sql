-- Review vom 30.10.2026 (fachlich): Revisionssicherheit, Freigabestand, „nicht anwendbar“, Testpläne archivieren.

-- ---- Ereignisprotokoll je Projekt (F3) ----
-- Projekt eines Ereignisses aus seinem Objekt (beide Schreibweisen: TestCase bzw. TEST_CASE)
create function event_project(t text, id uuid) returns uuid language sql stable as $$
  select case
    when t in ('Project', 'project') then (select p.id from project p where p.id = event_project.id)
    when t in ('TestCase', 'TEST_CASE') then (select project_id from test_case where test_case.id = event_project.id)
    when t in ('TestExecution', 'TEST_EXECUTION') then (select c.project_id from test_execution e join test_cycle c on c.id = e.cycle_id where e.id = event_project.id)
    when t in ('TestCycle', 'TEST_CYCLE') then (select project_id from test_cycle where test_cycle.id = event_project.id)
    when t in ('TestPlan', 'TEST_PLAN') then (select project_id from test_plan where test_plan.id = event_project.id)
    when t = 'Folder' then (select project_id from folder where folder.id = event_project.id)
    when t in ('ExploratorySession', 'EXPLORATORY_SESSION') then (select c.project_id from exploratory_session s join test_cycle c on c.id = s.cycle_id where s.id = event_project.id)
    when t in ('Precondition', 'PRECONDITION') then (select project_id from precondition where precondition.id = event_project.id)
  end
$$;

alter table domain_event add column project_id uuid;
update domain_event set project_id = event_project(aggregate_type, aggregate_id);
-- gelöschte Projekte: Ereignisse bleiben als Nachweis, ohne Zuordnung
update domain_event set project_id = aggregate_id where project_id is null and type = 'ProjectDeleted';
create index domain_event_project_idx on domain_event(project_id, seq);

create function domain_event_set_project() returns trigger language plpgsql as $$
begin
  if new.project_id is null then new.project_id := event_project(new.aggregate_type, new.aggregate_id); end if;
  return new;
end $$;
create trigger domain_event_project before insert on domain_event for each row execute function domain_event_set_project();

-- Ereignisse sind unveränderlich. Einzige Ausnahme: Beim Löschen eines Projekts werden Kommentarauszüge entfernt
-- (Datenschutz) – dafür setzt die Anwendung in derselben Transaktion anemo.event_redaction = 'on'.
create function domain_event_immutable() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('anemo.event_redaction', true), '') = 'on' and tg_op = 'UPDATE'
     and new.seq = old.seq and new.type = old.type and new.aggregate_id = old.aggregate_id and new.actor = old.actor and new.occurred_at = old.occurred_at then
    return new;
  end if;
  raise exception 'Das Ereignisprotokoll ist unveränderlich (%)', tg_op using errcode = 'P0001';
end $$;
create trigger domain_event_immutable before update or delete on domain_event for each row execute function domain_event_immutable();

-- ---- Freigabestand (F1): beim Entscheiden abgelegtes Lieferpaket mit Prüfsumme ----
create table release_baseline (
  id              uuid primary key default uuidv7(),
  plan_id         uuid not null references test_plan(id) on delete cascade,
  decision        text not null check (decision in ('released', 'conditional', 'rejected')),
  decided_by      text not null,
  decided_at      timestamptz not null,
  status          text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  package_name    text,
  package_sha256  text,
  package_bytes   bigint,
  error           text,
  created_at      timestamptz not null default now(),
  unique (plan_id, decided_at)
);

-- ---- Fazit mit Verfasser, Zeitpunkt und KI-Vermerk (F6) ----
alter table test_plan add column assessment_by text;
alter table test_plan add column assessment_at timestamptz;
-- mit KI erstellt: Name des Modells, dessen Entwurf übernommen wurde (null = von Hand)
alter table test_plan add column assessment_ai text;

-- ---- Testpläne archivieren (F11) ----
alter table test_plan add column archived_at timestamptz;
alter table test_plan add column archived_by text;

-- ---- „Nicht anwendbar“ (F8): Prüfpunkt trifft auf das Release nicht zu – zählt weder als ausgeführt noch als offen ----
alter table execution_status drop constraint execution_status_category_check;
alter table execution_status add constraint execution_status_category_check
  check (category in ('OPEN', 'IN_PROGRESS', 'PASSED', 'PASSED_WITH_ISSUES', 'KNOWN_FAILURE', 'FAILED', 'BLOCKED', 'INVALID', 'NOT_APPLICABLE'));
insert into execution_status(code, name, color, is_final, sort_order, category, applies_to, active, description)
values ('NA', 'Nicht anwendbar', '#8C8C8C', true, 9, 'NOT_APPLICABLE', 'both', true,
  'Prüfpunkt trifft in diesem Release bzw. dieser Konfiguration nicht zu (z. B. BITV-Kriterium ohne passende Inhalte) – zählt nicht in Quoten')
on conflict (code) do nothing;

-- ---- Testart pflegbar (F10): bisher nur aus Zephyr übernommen (custom_fields.testTypes), jetzt ein Auswahlfeld ----
insert into field_definition(scope, key, name, type, options, description, sort_order)
select 'test_case', 'testTypes', 'Testart', 'multiselect',
  array(select v from (
    select distinct t as v from test_case_version cv
      cross join jsonb_array_elements_text(case when jsonb_typeof(cv.custom_fields->'testTypes') = 'array' then cv.custom_fields->'testTypes' else '[]'::jsonb end) t
    union select unnest(array['Komponententest', 'Integrationstest', 'Systemtest', 'Abnahmetest', 'Regressionstest'])) x
    where v <> '' order by v),
  'Teststufe bzw. Testart (z. B. Systemtest, Abnahmetest) – auswertbar in Abfragen (testart = …) und Filtern', 0
where not exists (select 1 from field_definition where scope = 'test_case' and lower(key) = 'testtypes');
