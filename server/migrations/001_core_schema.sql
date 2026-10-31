-- Anemo Kernschema (Wave 1). Siehe ADR-0003 bis ADR-0007. Erfordert PostgreSQL >= 18 (uuidv7).

create table project (
    id            uuid primary key default uuidv7(),
    key           text not null unique,
    name          text not null,
    description   text,
    next_number   integer not null default 1,
    created_at    timestamptz not null default now()
);

create table folder (
    id          uuid primary key default uuidv7(),
    project_id  uuid not null references project(id),
    parent_id   uuid references folder(id),
    name        text not null,
    sort_order  integer not null default 0,
    created_at  timestamptz not null default now(),
    unique nulls not distinct (project_id, parent_id, name)
);

-- Identität und Verwaltungsdaten. Fachinhalt liegt ausschließlich in test_case_version (ADR-0004).
create table test_case (
    id               uuid primary key default uuidv7(),
    project_id       uuid not null references project(id),
    key              text not null unique,
    legacy_key       text,
    folder_id        uuid references folder(id),
    status           text not null,
    owner            text,
    current_version  integer not null,
    created_at       timestamptz not null default now(),
    created_by       text not null,
    updated_at       timestamptz not null default now()
);
create index test_case_project_idx on test_case(project_id);
create index test_case_folder_idx on test_case(folder_id);
create index test_case_legacy_key_idx on test_case(legacy_key);

create table test_case_version (
    id             uuid primary key default uuidv7(),
    test_case_id   uuid not null references test_case(id),
    version_no     integer not null,
    title          text not null,
    format         text not null default 'CLASSIC' check (format in ('CLASSIC', 'GHERKIN')),
    gherkin        text,
    objective      text,
    preconditions  text,
    test_data      text,
    priority       text,
    labels         text[] not null default '{}',
    components     text[] not null default '{}',
    steps          jsonb not null default '[]',
    sections       jsonb not null default '[]',
    custom_fields  jsonb not null default '{}',
    change_note    text,
    created_at     timestamptz not null default now(),
    created_by     text not null,
    search         tsvector generated always as (
        setweight(to_tsvector('german', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('german', coalesce(objective, '') || ' ' || coalesce(preconditions, '')), 'B') ||
        setweight(to_tsvector('german', coalesce(gherkin, '') || ' ' || steps::text || ' ' || sections::text), 'C')
    ) stored,
    unique (test_case_id, version_no)
);
create index test_case_version_search_idx on test_case_version using gin(search);
create index test_case_version_labels_idx on test_case_version using gin(labels);

-- Verweise auf fremde Arbeitspakete (ADR-0005).
create table external_reference (
    id           uuid primary key default uuidv7(),
    owner_type   text not null,
    owner_id     uuid not null,
    provider     text not null,
    external_key text not null,
    relation     text not null,
    url          text,
    title        text,
    status       text,
    created_at   timestamptz not null default now(),
    unique (owner_type, owner_id, provider, external_key, relation)
);
create index external_reference_owner_idx on external_reference(owner_type, owner_id);
create index external_reference_key_idx on external_reference(provider, external_key);

create table attachment (
    id            uuid primary key default uuidv7(),
    owner_type    text not null,
    owner_id      uuid not null,
    file_name     text not null,
    content_type  text,
    size_bytes    bigint,
    storage       text not null,
    location      text not null,
    author        text,
    created_at    timestamptz not null default now()
);
create index attachment_owner_idx on attachment(owner_type, owner_id);

create table execution_status (
    code        text primary key,
    name        text not null,
    color       text not null,
    is_final    boolean not null,
    sort_order  integer not null
);
insert into execution_status(code, name, color, is_final, sort_order) values
    ('NOT_EXECUTED', 'Nicht ausgeführt', '#A0A0A0', false, 0),
    ('WIP',          'In Arbeit',        '#F2B000', false, 1),
    ('PASS',         'Bestanden',        '#2E8B57', true,  2),
    ('FAIL',         'Fehlgeschlagen',   '#CC3333', true,  3),
    ('BLOCKED',      'Blockiert',        '#6693B0', true,  4);

create table test_plan (
    id           uuid primary key default uuidv7(),
    project_id   uuid not null references project(id),
    name         text not null,
    description  text,
    release      text,
    created_at   timestamptz not null default now(),
    created_by   text not null
);

create table test_cycle (
    id           uuid primary key default uuidv7(),
    project_id   uuid not null references project(id),
    plan_id      uuid references test_plan(id),
    name         text not null,
    description  text,
    release      text,
    build        text,
    environment  text,
    start_date   date,
    end_date     date,
    custom_fields jsonb not null default '{}',
    created_at   timestamptz not null default now(),
    created_by   text not null
);
create index test_cycle_project_idx on test_cycle(project_id);

create table test_execution (
    id                    uuid primary key default uuidv7(),
    cycle_id              uuid not null references test_cycle(id),
    test_case_id          uuid not null references test_case(id),
    test_case_version_id  uuid not null references test_case_version(id),
    order_no              integer not null default 0,
    status                text not null references execution_status(code),
    assignee              text,
    executed_by           text,
    executed_at           timestamptz,
    comment               text,
    step_results          jsonb not null default '[]',
    custom_fields         jsonb not null default '{}',
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    unique (cycle_id, test_case_id)
);
create index test_execution_case_idx on test_execution(test_case_id);

-- Event-Log / Outbox / Audit (ADR-0007).
create table domain_event (
    seq             bigserial primary key,
    id              uuid not null unique default uuidv7(),
    type            text not null,
    aggregate_type  text not null,
    aggregate_id    uuid not null,
    payload         jsonb not null,
    actor           text not null,
    occurred_at     timestamptz not null default now()
);
create index domain_event_aggregate_idx on domain_event(aggregate_type, aggregate_id);

-- Migration (ADR-0006).
create table migration_run (
    id           uuid primary key default uuidv7(),
    source       text not null,
    status       text not null,
    started_at   timestamptz not null default now(),
    finished_at  timestamptz,
    stats        jsonb not null default '{}'
);

create table source_record (
    id              uuid primary key default uuidv7(),
    source_system   text not null,
    source_type     text not null,
    source_id       text not null,
    payload         jsonb not null,
    payload_hash    text not null,
    first_run_id    uuid not null references migration_run(id),
    last_run_id     uuid not null references migration_run(id),
    updated_at      timestamptz not null default now(),
    unique (source_system, source_type, source_id)
);

-- Stabile Zuordnung Quelle -> Ziel für idempotenten Re-Import.
create table migration_identity (
    source_system  text not null,
    source_type    text not null,
    source_id      text not null,
    target_type    text not null,
    target_id      uuid not null,
    payload_hash   text,
    primary key (source_system, source_type, source_id, target_type)
);

create table migration_mapping (
    id                uuid primary key default uuidv7(),
    run_id            uuid not null references migration_run(id),
    source_record_id  uuid not null references source_record(id),
    target_type       text,
    target_id         uuid,
    outcome           text not null,
    action            text not null,
    preserved_fields  text[] not null default '{}',
    messages          jsonb not null default '[]',
    unique (run_id, source_record_id)
);
create index migration_mapping_run_idx on migration_mapping(run_id, outcome);
