-- Stufe J2: Versionstreue laufender Ausführungen.
-- Eine Ausführung hält die Fassung ihrer wiederverwendbaren Vorbedingungen fest, die beim Einplanen galt (bzw. beim
-- Umstellen auf eine neue Testfallversion). Aufgerufene Testfälle sind bereits über die Version im Aufruf-Schritt fest.
alter table test_execution add column pinned_refs jsonb;

create function pin_execution_refs() returns trigger language plpgsql as $$
begin
  new.pinned_refs := jsonb_build_object('preconditions', coalesce((
    select jsonb_object_agg(p.id::text, p.current_version)
    from test_case_version v join precondition p on p.id = any(v.precondition_ids)
    where v.id = new.test_case_version_id), '{}'::jsonb));
  return new;
end $$;

create trigger test_execution_pin before insert or update of test_case_version_id on test_execution
  for each row execute function pin_execution_refs();

-- Bestand: Fassung zum Zeitpunkt der Einplanung (jüngste Version, die damals schon existierte)
update test_execution e set pinned_refs = jsonb_build_object('preconditions', coalesce((
  select jsonb_object_agg(p.id::text, coalesce(
    (select max(pv.version_no) from precondition_version pv where pv.precondition_id = p.id and pv.created_at <= e.created_at), 1))
  from test_case_version v join precondition p on p.id = any(v.precondition_ids)
  where v.id = e.test_case_version_id), '{}'::jsonb))
where e.pinned_refs is null;
