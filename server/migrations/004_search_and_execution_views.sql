-- Suche und Filter für große Mengen an Zyklen und Ausführungen (≈ 1.500 Zyklen, 21.000 Ausführungen aus Zephyr).

-- Unscharfe Suche (Teilwörter, Schlüssel) über Trigramme
create extension if not exists pg_trgm;

alter table test_cycle add column search tsvector generated always as (
  setweight(to_tsvector('german', coalesce(name, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(release, '') || ' ' || coalesce(build, '') || ' ' || coalesce(environment, '')), 'B') ||
  setweight(to_tsvector('german', coalesce(description, '')), 'C')
) stored;
create index test_cycle_search_idx on test_cycle using gin(search);
create index test_cycle_name_trgm_idx on test_cycle using gin(name gin_trgm_ops);
create index test_cycle_plan_idx on test_cycle(plan_id);
create index test_cycle_start_idx on test_cycle(project_id, start_date desc nulls last);

alter table test_execution add column search tsvector generated always as (
  to_tsvector('german', coalesce(comment, ''))
) stored;
create index test_execution_search_idx on test_execution using gin(search);
create index test_execution_cycle_status_idx on test_execution(cycle_id, status);
create index test_execution_assignee_idx on test_execution(assignee);
create index test_execution_executed_at_idx on test_execution(executed_at desc);

create index test_case_version_title_trgm_idx on test_case_version using gin(title gin_trgm_ops);
create index test_case_legacy_key_trgm_idx on test_case using gin(legacy_key gin_trgm_ops);
create index external_reference_key_trgm_idx on external_reference using gin(external_key gin_trgm_ops);
create index attachment_file_name_trgm_idx on attachment using gin(file_name gin_trgm_ops);
create index test_plan_project_idx on test_plan(project_id);
