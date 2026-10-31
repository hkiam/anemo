-- Konfigurierbare Ausführungs-/Schrittstatus und Testfall-Workflow (ADR-0013).

-- Bedeutung eines Status für Auswertungen und Vorschläge (statt fest verdrahteter Codes)
alter table execution_status
  add column category    text not null default 'OPEN'
    check (category in ('OPEN', 'IN_PROGRESS', 'PASSED', 'FAILED', 'BLOCKED', 'INVALID')),
  add column applies_to  text not null default 'both' check (applies_to in ('execution', 'step', 'both')),
  add column active      boolean not null default true,
  add column description text;

update execution_status set category = case
    when code = 'NOT_EXECUTED' then 'OPEN'
    when code = 'WIP' then 'IN_PROGRESS'
    when code in ('PASS', 'BESTANDEN_MIT_MANGEL', 'PASS_MIT_EINSCHRANKUNG') then 'PASSED'
    when code = 'FAIL' then 'FAILED'
    when code = 'BLOCKED' then 'BLOCKED'
    when code = 'INVALID' then 'INVALID'
    when is_final then 'PASSED'
    else 'OPEN' end;
-- Eigene Status, die im Bestand nie an Schritten vorkommen, nur für Ausführungen anbieten (Schrittknöpfe bleiben schlank)
update execution_status s set applies_to = 'execution'
where s.code not in ('NOT_EXECUTED', 'WIP', 'PASS', 'FAIL', 'BLOCKED')
  and not exists (select 1 from test_execution e, jsonb_array_elements(e.step_results) r where r->>'status' = s.code);
update execution_status set description = 'Bestanden, aber mit festgestelltem Mangel (aus Zephyr übernommen)' where code = 'BESTANDEN_MIT_MANGEL';

-- Testfall-Status (Workflow). Codes entsprechen den Werten in test_case.status (auch migrierte Jira-Status).
create table test_case_status (
  code        text primary key,
  name        text not null,
  category    text not null check (category in ('DRAFT', 'REVIEW', 'APPROVED', 'DEPRECATED')),
  color       text not null default '#888888',
  sort_order  integer not null default 0,
  active      boolean not null default true,
  is_initial  boolean not null default false,
  description text
);
create unique index test_case_status_initial_idx on test_case_status (is_initial) where is_initial;

-- Erlaubte Übergänge. Hat ein Status keine ausgehenden Übergänge, ist der Wechsel frei (z. B. migrierte Status).
create table test_case_transition (
  from_code  text not null references test_case_status(code) on delete cascade,
  to_code    text not null references test_case_status(code) on delete cascade,
  primary key (from_code, to_code),
  check (from_code <> to_code)
);

insert into test_case_status(code, name, category, color, sort_order, is_initial, description) values
  ('DRAFT',      'Entwurf',           'DRAFT',      '#8993a4', 1, true,  'In Bearbeitung'),
  ('READY',      'Bereit zum Review', 'REVIEW',     '#ff991f', 2, false, 'Fachlich prüfen lassen'),
  ('APPROVED',   'Freigegeben',       'APPROVED',   '#36b37e', 3, false, 'Darf eingeplant und ausgeführt werden'),
  ('DEPRECATED', 'Veraltet',          'DEPRECATED', '#6b778c', 4, false, 'Nicht mehr einplanen');

insert into test_case_transition(from_code, to_code) values
  ('DRAFT', 'READY'), ('READY', 'APPROVED'), ('READY', 'DRAFT'),
  ('APPROVED', 'DRAFT'), ('APPROVED', 'DEPRECATED'), ('DEPRECATED', 'DRAFT');

-- Migrierte Status übernehmen (Kategorie nach üblicher Jira-Bedeutung, später in der Administration anpassbar)
insert into test_case_status(code, name, category, sort_order)
select t.status, t.status,
  case
    when lower(t.status) in ('fertig', 'geschlossen', 'erledigt', 'done', 'closed', 'resolved') then 'APPROVED'
    when lower(t.status) like 'review%' or lower(t.status) in ('qa', 'test', 'in review') then 'REVIEW'
    when lower(t.status) in ('outdated', 'veraltet', 'obsolet') then 'DEPRECATED'
    else 'DRAFT' end,
  100 + row_number() over (order by count(*) desc)
from test_case t
where not exists (select 1 from test_case_status x where x.code = t.status)
group by t.status;
