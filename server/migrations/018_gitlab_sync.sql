-- GitLab-Abgleich (ADR-0022): zuletzt synchronisierter Stand je Gherkin-Testfall (Pfad, Version, Inhalts-Hash),
-- um zu erkennen, ob Anemo oder Git geändert hat.
create table gitlab_sync (
  test_case_id  uuid primary key references test_case(id) on delete cascade,
  path          text not null,
  version_no    integer not null,
  content_hash  text not null,
  synced_at     timestamptz not null default now(),
  synced_by     text not null
);
