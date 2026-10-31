-- Befunde aus technischem, fachlichem und UX-Review (11.10.2026).

-- F3: „Bestanden mit Einschränkung/Mangel“ ist eigene Kategorie – zählt als bestanden, begründet aber einen Vorbehalt
alter table execution_status drop constraint execution_status_category_check;
alter table execution_status add constraint execution_status_category_check
  check (category in ('OPEN', 'IN_PROGRESS', 'PASSED', 'PASSED_WITH_ISSUES', 'FAILED', 'BLOCKED', 'INVALID'));
update execution_status set category = 'PASSED_WITH_ISSUES' where code in ('BESTANDEN_MIT_MANGEL', 'PASS_MIT_EINSCHRANKUNG');
update execution_status set name = 'Bestanden mit Einschränkung' where code = 'PASS_MIT_EINSCHRANKUNG' and name = upper(name);
update execution_status set name = 'Bestanden mit Mangel' where code = 'BESTANDEN_MIT_MANGEL' and name = upper(name);

-- F2: Ausstiegskriterien je Testplan (strukturiert), U4: Freigabeentscheidung
alter table test_plan add column exit_criteria jsonb not null default '{}';
alter table test_plan add column release_decision text check (release_decision in ('released', 'conditional', 'rejected'));
alter table test_plan add column release_note text;
alter table test_plan add column release_by text;
alter table test_plan add column release_at timestamptz;

-- F7: Freigabe eines Testfalls gilt für eine Version
alter table test_case add column approved_version integer;
alter table test_case add column approved_by text;
alter table test_case add column approved_at timestamptz;

-- F11: Ergebnis-Historie je Ausführung (revisionssicher, jedes Speichern)
create table execution_result (
  id              bigserial primary key,
  execution_id    uuid not null references test_execution(id) on delete cascade,
  status          text not null,
  comment         text,
  step_results    jsonb not null default '[]',
  iterations      jsonb not null default '[]',
  recorded_by     text not null,
  recorded_at     timestamptz not null default now(),
  note            text
);
create index execution_result_exec_idx on execution_result(execution_id, id);

-- F20: Zyklus-Status; abgeschlossene Zyklen sind gegen Änderungen gesperrt
alter table test_cycle add column state text not null default 'active' check (state in ('planned', 'active', 'closed'));
alter table test_cycle add column closed_by text;
alter table test_cycle add column closed_at timestamptz;

-- F16: SBTM – Nachbesprechung (Debriefing) und Zeitanteile (Test/Bug/Setup)
alter table exploratory_session drop constraint exploratory_session_status_check;
alter table exploratory_session add constraint exploratory_session_status_check check (status in ('planned', 'running', 'paused', 'done', 'debriefed'));
alter table exploratory_session add column debrief_note text;
alter table exploratory_session add column debriefed_by text;
alter table exploratory_session add column debriefed_at timestamptz;
alter table exploratory_session add column tbs jsonb;

-- F13: Fehlschlag/Blockade nur mit Nachweis (Befund oder Fehlerverweis) – je Projekt abschaltbar
alter table project add column require_failure_evidence boolean not null default true;
