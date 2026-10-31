-- Nachtrag zu 029: reference_owner_project fehlte in Datenbanken, auf denen 029 vor Aufnahme der Funktion lief
-- (Jira-, OpenProject- und GitLab-Abgleich brechen sonst ab). Idempotent.
create or replace function reference_owner_project(p_owner_type text, p_owner_id uuid) returns uuid language sql stable as $$
  select case p_owner_type
    when 'TEST_CASE' then (select project_id from test_case where id = p_owner_id)
    when 'TEST_EXECUTION' then (select c.project_id from test_execution e join test_cycle c on c.id = e.cycle_id where e.id = p_owner_id)
    when 'TEST_CYCLE' then (select project_id from test_cycle where id = p_owner_id)
    when 'TEST_PLAN' then (select project_id from test_plan where id = p_owner_id)
    when 'EXPLORATORY_SESSION' then (select c.project_id from exploratory_session s join test_cycle c on c.id = s.cycle_id where s.id = p_owner_id)
    when 'PRECONDITION' then (select project_id from precondition where id = p_owner_id)
  end
$$;
