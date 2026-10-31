-- Stufe H: geplanter Aufwand (Schätzung je Testfall) und Ad-hoc-Ausführung ohne vorher angelegten Zyklus.
alter table test_case add column estimate_minutes integer check (estimate_minutes is null or estimate_minutes between 0 and 100000);
alter table test_cycle add column is_adhoc boolean not null default false;
create index test_cycle_adhoc_idx on test_cycle(project_id, plan_id) where is_adhoc;
