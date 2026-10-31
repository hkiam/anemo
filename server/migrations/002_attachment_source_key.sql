-- Herkunft migrierter Anhänge (z. B. jira-4711, zapi-12) für idempotenten Re-Import.
-- Regel: Bereits ausgelieferte Migrationen werden nie geändert, sondern durch neue ergänzt.
alter table attachment add column source_key text;
create index attachment_source_key_idx on attachment(owner_type, owner_id, source_key);
