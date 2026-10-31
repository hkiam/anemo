-- Agentische Ausführung (ADR-0024): Agentenkonten und QA-Freigabe ihrer Ergebnisse.
alter table app_user add column is_agent boolean not null default false;

alter table test_execution
  add column review_state text check (review_state in ('pending', 'approved', 'rejected', 'escalated')),
  add column reviewed_by  text,
  add column reviewed_at  timestamptz,
  add column review_note  text;
create index test_execution_review_idx on test_execution (review_state) where review_state in ('pending', 'escalated');
