-- Dasselbe Ticket an mehreren Schritten einer Ausführung: Eindeutigkeit je Schritt (ohne Schritt = '').
-- Auswertungen zählen Fehler weiterhin je Ticket (distinct).
alter table external_reference drop constraint external_reference_owner_type_owner_id_provider_external_ke_key;
create unique index external_reference_unique_idx
  on external_reference(owner_type, owner_id, provider, external_key, relation, (coalesce(step_id, '')));
