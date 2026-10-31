-- Unstrukturierter Test: Freitext (Jira-Markup) als Testanweisung statt Schritten – auch in der Volltextsuche
alter table test_case_version add column plain_text text;
alter table test_case_version drop column search;
alter table test_case_version add column search tsvector generated always as (
    setweight(to_tsvector('german', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('german', coalesce(objective, '') || ' ' || coalesce(preconditions, '')), 'B') ||
    setweight(to_tsvector('german', coalesce(gherkin, '') || ' ' || coalesce(plain_text, '') || ' ' || steps::text || ' ' || sections::text), 'C')
) stored;
create index test_case_version_search_idx on test_case_version using gin(search);
