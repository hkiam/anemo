/**
 * Projektpaket (ADR-0027): Beschreibung des Formats. Je Objektart stehen hier die übertragenen Spalten, die bewusst
 * ausgelassenen (mit Grund), die Bezüge auf andere Objekte des Pakets (für die ID-Übersetzung beim Import) und die
 * Spalten mit Personen (Zuordnung beim Import, Pseudonymisierung).
 *
 * Ein Test vergleicht diese Beschreibung mit dem Datenbankschema: Jede Tabelle ist entweder eine Objektart, ein
 * Katalog oder ausdrücklich ausgeschlossen, jede Spalte ist übertragen oder ausgelassen, jede ID-Spalte hat einen
 * Bezug. Neue Tabellen und Spalten fallen so sofort auf.
 */
import type postgres from 'postgres';
import type { Db } from '../../platform/db.ts';

type Fragment = postgres.PendingQuery<postgres.Row[]>;

export const FORMAT = 'anemo-project';
/** Formatversion (SemVer): gleiche Hauptversion ist importierbar, ältere Nebenversionen über Upgrade-Funktionen */
export const FORMAT_VERSION = '1.3.0';

export type TypeName =
  | 'project' | 'folders' | 'field-definitions' | 'field-templates' | 'defect-templates'
  | 'preconditions' | 'precondition-versions' | 'step-blocks' | 'test-sets' | 'test-cases' | 'test-case-versions'
  | 'plans' | 'cycles' | 'executions' | 'execution-results' | 'sessions' | 'dataset-overrides'
  | 'comments' | 'references' | 'attachments' | 'views' | 'members' | 'integrations' | 'webhooks'
  | 'foreign-test-cases' | 'foreign-test-case-versions';

/** Besitzerarten (owner_type) → Objektart im Paket */
export const OWNER_TYPES: Record<string, TypeName> = {
  TEST_CASE: 'test-cases', TEST_EXECUTION: 'executions', TEST_CYCLE: 'cycles', TEST_PLAN: 'plans',
  EXPLORATORY_SESSION: 'sessions', PRECONDITION: 'preconditions',
};

/**
 * Bezug auf ein anderes Objekt des Pakets. `column` ist die Spalte; bei JSON-Feldern beschreibt `json` den Pfad
 * (`[]` = jedes Element, `{}` = jeder Schlüssel eines Objekts).
 */
export type Ref =
  | { column: string; to: TypeName }
  | { column: string; to: TypeName; array: true }
  | { column: string; json: string; to: TypeName }
  /** Ziel hängt von einer anderen Spalte ab (owner_type bzw. scope) */
  | { column: string; by: string; to: Record<string, TypeName> }
  /** Benutzer oder Gruppe der Zielinstanz (Zuordnung über Login bzw. Gruppennamen, nicht übersetzbar) */
  | { column: string; principal: string };

export interface TypeSpec {
  name: TypeName;
  table: string;
  /** übertragene Spalten (snake_case) */
  columns: string[];
  /** bewusst ausgelassene Spalten mit Grund */
  omitted: Record<string, string>;
  refs: Ref[];
  /** Spalten mit Logins */
  persons: string[];
  /** Zeilen des Projekts `p` (Projekt-ID) */
  where: (sql: Db, p: string) => Fragment;
  order: string;
  /** genau eine Zeile (project.json statt NDJSON) */
  single?: true;
  /** darf im Paket fehlen (ältere Formatversionen) */
  optional?: true;
}

const IMPLICIT = 'ergibt sich aus dem Zielprojekt';
const GENERATED = 'berechnete Spalte (Suchindex)';

/** Objekte mit Besitzerart/-ID, die zum Projekt gehören (Kommentare, Verweise, Anhänge) */
const ownedBy = (sql: Db, p: string) => sql`(
     (owner_type = 'TEST_CASE' and owner_id in (select id from test_case where project_id = ${p}))
  or (owner_type = 'TEST_EXECUTION' and owner_id in (select e.id from test_execution e join test_cycle c on c.id = e.cycle_id where c.project_id = ${p}))
  or (owner_type = 'TEST_CYCLE' and owner_id in (select id from test_cycle where project_id = ${p}))
  or (owner_type = 'TEST_PLAN' and owner_id in (select id from test_plan where project_id = ${p}))
  or (owner_type = 'EXPLORATORY_SESSION' and owner_id in (select s.id from exploratory_session s join test_cycle c on c.id = s.cycle_id where c.project_id = ${p}))
  or (owner_type = 'PRECONDITION' and owner_id in (select id from precondition where project_id = ${p})))`;
const ownerRef = (column = 'owner_id'): Ref => ({ column, by: 'owner_type', to: OWNER_TYPES });
const byProject = (sql: Db, p: string) => sql`project_id = ${p}`;

export const TYPES: TypeSpec[] = [
  {
    name: 'project', table: 'project', single: true, order: 'id',
    columns: ['id', 'key', 'name', 'description', 'next_number', 'next_precondition', 'created_at', 'visibility', 'external_services',
      'ai_context', 'require_failure_evidence', 'execute_only_assignee'],
    omitted: {}, refs: [], persons: [], where: (sql, p) => sql`id = ${p}`,
  },
  {
    name: 'folders', table: 'folder', order: 'created_at, id',
    columns: ['id', 'parent_id', 'name', 'sort_order', 'created_at'],
    omitted: { project_id: IMPLICIT }, refs: [{ column: 'parent_id', to: 'folders' }], persons: [], where: byProject,
  },
  {
    name: 'field-definitions', table: 'field_definition', order: 'scope, sort_order, id',
    columns: ['id', 'scope', 'key', 'name', 'type', 'options', 'required', 'description', 'sort_order', 'active', 'options_source', 'created_at'],
    omitted: { project_id: IMPLICIT, options_synced_at: 'Laufzustand des Werteabgleichs', options_sync_error: 'Laufzustand des Werteabgleichs' },
    refs: [], persons: [], where: byProject,
  },
  {
    name: 'field-templates', table: 'field_template', order: 'created_at, id',
    columns: ['id', 'name', 'fields', 'content', 'is_default', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    omitted: { project_id: IMPLICIT }, refs: [], persons: ['created_by', 'updated_by'], where: byProject,
  },
  {
    name: 'defect-templates', table: 'defect_template', order: 'created_at, id',
    columns: ['id', 'name', 'title_template', 'body_template', 'is_default', 'created_at'],
    omitted: { project_id: IMPLICIT }, refs: [], persons: [], where: byProject,
  },
  {
    name: 'preconditions', table: 'precondition', order: 'created_at, id',
    columns: ['id', 'key', 'title', 'content', 'current_version', 'archived_at', 'created_at', 'created_by', 'updated_at'],
    omitted: { project_id: IMPLICIT }, refs: [], persons: ['created_by'], where: byProject,
  },
  {
    name: 'precondition-versions', table: 'precondition_version', order: 'precondition_id, version_no',
    columns: ['id', 'precondition_id', 'version_no', 'title', 'content', 'change_note', 'created_at', 'created_by'],
    omitted: {}, refs: [{ column: 'precondition_id', to: 'preconditions' }], persons: ['created_by'],
    where: (sql, p) => sql`precondition_id in (select id from precondition where project_id = ${p})`,
  },
  {
    name: 'step-blocks', table: 'step_block', order: 'created_at, id',
    columns: ['id', 'name', 'description', 'steps', 'tags', 'created_at', 'created_by', 'updated_at', 'updated_by', 'archived_at'],
    omitted: { project_id: IMPLICIT }, refs: [{ column: 'steps', json: '[].call.testCaseId', to: 'test-cases' }],
    persons: ['created_by', 'updated_by'], where: byProject,
  },
  {
    name: 'test-sets', table: 'test_set', order: 'created_at, id',
    columns: ['id', 'name', 'description', 'kind', 'test_case_ids', 'query', 'created_by', 'created_at', 'updated_at'],
    omitted: { project_id: IMPLICIT }, refs: [{ column: 'test_case_ids', to: 'test-cases', array: true }], persons: ['created_by'], where: byProject,
  },
  {
    name: 'test-cases', table: 'test_case', order: 'created_at, id',
    columns: ['id', 'key', 'legacy_key', 'folder_id', 'status', 'owner', 'current_version', 'created_at', 'created_by', 'updated_at',
      'approved_version', 'approved_by', 'approved_at', 'archived_at', 'archived_by', 'estimate_minutes'],
    omitted: { project_id: IMPLICIT }, refs: [{ column: 'folder_id', to: 'folders' }],
    persons: ['owner', 'created_by', 'approved_by', 'archived_by'], where: byProject,
  },
  {
    name: 'test-case-versions', table: 'test_case_version', order: 'test_case_id, version_no',
    columns: ['id', 'test_case_id', 'version_no', 'title', 'format', 'gherkin', 'objective', 'preconditions', 'test_data', 'priority', 'labels',
      'components', 'steps', 'sections', 'custom_fields', 'change_note', 'created_at', 'created_by', 'dataset', 'ai_assisted', 'precondition_ids', 'plain_text'],
    omitted: { search: GENERATED },
    refs: [{ column: 'test_case_id', to: 'test-cases' }, { column: 'steps', json: '[].call.testCaseId', to: 'test-cases' },
      { column: 'precondition_ids', to: 'preconditions', array: true }],
    persons: ['created_by'], where: (sql, p) => sql`test_case_id in (select id from test_case where project_id = ${p})`,
  },
  // Testfälle anderer Projekte, die Ausführungen dieses Projekts benutzen (Produkt-Regressionszyklen aus Zephyr), mit den
  // ausgeführten Versionen (Formatversion 1.2). Werden unten aus den Beschreibungen der eigenen Testfälle abgeleitet.
  { name: 'foreign-test-cases' } as unknown as TypeSpec,
  { name: 'foreign-test-case-versions' } as unknown as TypeSpec,
  {
    name: 'plans', table: 'test_plan', order: 'created_at, id',
    columns: ['id', 'name', 'description', 'release', 'created_at', 'created_by', 'assessment', 'exit_criteria', 'release_decision', 'release_note',
      'release_by', 'release_at', 'status_note', 'status_note_at', 'status_note_by', 'assessment_by', 'assessment_at', 'assessment_ai', 'archived_at', 'archived_by'],
    omitted: { project_id: IMPLICIT }, refs: [], persons: ['created_by', 'release_by', 'status_note_by', 'assessment_by', 'archived_by'], where: byProject,
  },
  {
    name: 'cycles', table: 'test_cycle', order: 'created_at, id',
    columns: ['id', 'plan_id', 'name', 'description', 'release', 'build', 'environment', 'start_date', 'end_date', 'custom_fields', 'created_at',
      'created_by', 'configuration', 'configuration_source', 'configuration_evidence', 'state', 'closed_by', 'closed_at', 'archived_at', 'archived_by', 'is_adhoc'],
    omitted: { project_id: IMPLICIT, search: GENERATED }, refs: [{ column: 'plan_id', to: 'plans' }],
    persons: ['created_by', 'closed_by', 'archived_by'], where: byProject,
  },
  {
    name: 'executions', table: 'test_execution', order: 'cycle_id, order_no, id',
    columns: ['id', 'cycle_id', 'test_case_id', 'test_case_version_id', 'order_no', 'status', 'assignee', 'executed_by', 'executed_at', 'comment',
      'step_results', 'custom_fields', 'created_at', 'updated_at', 'review_state', 'reviewed_by', 'reviewed_at', 'review_note', 'iterations',
      'started_at', 'duration_seconds', 'pinned_refs'],
    omitted: { search: GENERATED },
    refs: [{ column: 'cycle_id', to: 'cycles' }, { column: 'test_case_id', to: 'test-cases' }, { column: 'test_case_version_id', to: 'test-case-versions' },
      { column: 'pinned_refs', json: 'preconditions.{}', to: 'preconditions' }],
    persons: ['assignee', 'executed_by', 'reviewed_by'],
    where: (sql, p) => sql`cycle_id in (select id from test_cycle where project_id = ${p})`,
  },
  {
    name: 'execution-results', table: 'execution_result', order: 'execution_id, recorded_at, id',
    columns: ['execution_id', 'status', 'comment', 'step_results', 'iterations', 'recorded_by', 'recorded_at', 'note'],
    omitted: { id: 'laufende Nummer der Quellinstanz, nichts verweist darauf' }, refs: [{ column: 'execution_id', to: 'executions' }], persons: ['recorded_by'],
    where: (sql, p) => sql`execution_id in (select e.id from test_execution e join test_cycle c on c.id = e.cycle_id where c.project_id = ${p})`,
  },
  {
    name: 'sessions', table: 'exploratory_session', order: 'created_at, id',
    columns: ['id', 'cycle_id', 'charter', 'areas', 'timebox_minutes', 'tester', 'status', 'started_at', 'running_since', 'ended_at', 'duration_seconds',
      'notes', 'summary', 'findings', 'created_by', 'created_at', 'updated_at', 'debrief_note', 'debriefed_by', 'debriefed_at', 'tbs'],
    omitted: {}, refs: [{ column: 'cycle_id', to: 'cycles' }], persons: ['tester', 'created_by', 'debriefed_by'],
    where: (sql, p) => sql`cycle_id in (select id from test_cycle where project_id = ${p})`,
  },
  {
    name: 'dataset-overrides', table: 'dataset_override', order: 'scope, scope_id, test_case_id',
    columns: ['id', 'scope', 'scope_id', 'test_case_id', 'dataset', 'updated_at', 'updated_by'],
    omitted: {}, refs: [{ column: 'scope_id', by: 'scope', to: { plan: 'plans', cycle: 'cycles' } }, { column: 'test_case_id', to: 'test-cases' }],
    persons: ['updated_by'],
    where: (sql, p) => sql`((scope = 'plan' and scope_id in (select id from test_plan where project_id = ${p}))
      or (scope = 'cycle' and scope_id in (select id from test_cycle where project_id = ${p})))`,
  },
  {
    name: 'comments', table: 'comment', order: 'created_at, id',
    columns: ['id', 'owner_type', 'owner_id', 'version_no', 'parent_id', 'author', 'body', 'created_at', 'edited_at', 'resolved_at', 'resolved_by'],
    omitted: {}, refs: [ownerRef(), { column: 'parent_id', to: 'comments' }], persons: ['author', 'resolved_by'], where: ownedBy,
  },
  {
    name: 'references', table: 'external_reference', order: 'created_at, id',
    columns: ['id', 'owner_type', 'owner_id', 'provider', 'external_key', 'relation', 'url', 'title', 'status', 'created_at', 'step_id', 'severity', 'created_by'],
    omitted: {}, refs: [ownerRef()], persons: ['created_by'], where: ownedBy,
  },
  {
    name: 'attachments', table: 'attachment', order: 'created_at, id',
    // location: bei LOCAL ersetzt durch sha256 (Datei unter files/<sha256>), bei SOURCE die Adresse im Quellsystem
    columns: ['id', 'owner_type', 'owner_id', 'file_name', 'content_type', 'size_bytes', 'storage', 'location', 'author', 'created_at', 'source_key', 'step_id'],
    omitted: {}, refs: [ownerRef()], persons: ['author'], where: ownedBy,
  },
  {
    name: 'views', table: 'saved_view', order: 'created_at, id',
    columns: ['id', 'owner_name', 'page', 'name', 'query', 'shared', 'created_at'],
    omitted: { project_id: IMPLICIT, user_id: 'Konto der Zielinstanz; Zuordnung über owner_name' },
    refs: [], persons: ['owner_name'], where: byProject,
  },
  {
    name: 'members', table: 'project_member', order: 'principal_type, principal_id',
    columns: ['principal_type', 'principal_id', 'role', 'created_at'],
    omitted: { project_id: IMPLICIT }, refs: [{ column: 'principal_id', principal: 'principal_type' }], persons: [], where: byProject,
  },
  {
    name: 'integrations', table: 'project_integration', order: 'provider',
    columns: ['provider', 'external_project', 'settings'],
    omitted: { project_id: IMPLICIT }, refs: [], persons: [], where: byProject,
  },
  {
    name: 'webhooks', table: 'webhook', order: 'created_at, id',
    columns: ['id', 'name', 'url', 'format', 'event_types', 'active', 'created_at', 'created_by'],
    omitted: {
      project_id: IMPLICIT, secret: 'Geheimnis – verlässt die Instanz nie; im Ziel neu setzen',
      // url: nur Ursprung (Schema, Host, Port) – Pfad und Parameter enthalten bei Chat-Diensten das Geheimnis
      cursor_seq: 'Zustellstand der Quellinstanz', failures: 'Zustellstand der Quellinstanz', next_attempt_at: 'Zustellstand der Quellinstanz',
    },
    refs: [], persons: ['created_by'], where: byProject,
  },
];

// fremde Testfälle: gleiche Spalten wie die eigenen, Auswahl immer über die Liste der benutzten (siehe export.ts)
for (const [name, base, where] of [
  ['foreign-test-cases', 'test-cases', (sql: Db, p: string) => sql`project_id <> ${p}`],
  ['foreign-test-case-versions', 'test-case-versions', (sql: Db, p: string) => sql`test_case_id in (select id from test_case where project_id <> ${p})`],
] as const) {
  const i = TYPES.findIndex((t) => t.name === name);
  const b = TYPES.find((t) => t.name === base)!;
  TYPES[i] = { ...b, name, where, optional: true };
}
/** Bezüge auf eigene oder fremde Testfälle bzw. Versionen gelten für beide Arten */
export const SHARED_IDS: Partial<Record<TypeName, TypeName>> = { 'foreign-test-cases': 'test-cases', 'foreign-test-case-versions': 'test-case-versions' };

/** Globale Kataloge: Das Paket enthält die benutzten Einträge (vollständige Zeilen) in catalog.json. */
export const CATALOG_TABLES = ['execution_status', 'test_case_status', 'test_case_transition', 'priority', 'config_dimension', 'config_value'] as const;

/** Tabellen, die nie in ein Projektpaket gehören – mit Grund. */
export const NOT_EXPORTED: Record<string, string> = {
  release_baseline: 'Freigabestand der Quellinstanz (abgelegte Datei mit Prüfsumme – nur dort nachweisbar)',
  access_log: 'Zugriffsprotokoll der Quellinstanz (personenbezogen, Aufbewahrungsfrist)',
  ai_call_log: 'Protokoll der KI-Aufrufe der Quellinstanz',
  ai_prompt: 'instanzweite Einstellung',
  api_token: 'Geheimnis',
  app_setting: 'instanzweite Einstellung, teils Geheimnisse',
  app_setting_log: 'instanzweites Änderungsprotokoll',
  app_user: 'Konten der Quellinstanz; Personen stehen mit Login, Name und E-Mail im Manifest',
  ci_run: 'Laufzustand von Pipelines im CI-System der Quellinstanz',
  coverage_push: 'Abgleichstand mit OpenProject (wird im Ziel neu ermittelt)',
  domain_event: 'Ereignisprotokoll der Quellinstanz',
  gitlab_sync: 'Abgleichstand mit GitLab (wird im Ziel neu ermittelt)',
  global_permission: 'Rechte der Quellinstanz',
  group_member: 'Gruppen der Quellinstanz',
  instance_info: 'Kennung der Quellinstanz (steht im Manifest)',
  mail_state: 'Versandstand der Quellinstanz',
  migration_identity: 'Migrationsdaten der Quellinstanz',
  migration_mapping: 'Migrationsdaten der Quellinstanz',
  migration_run: 'Migrationsdaten der Quellinstanz',
  oidc_login: 'Anmeldevorgang',
  package_identity: 'Herkunft importierter Objekte in der Zielinstanz',
  password_reset: 'Geheimnis',
  project_transfer: 'Übertragungsprotokoll der Quellinstanz',
  report_profile: 'instanzweite Berichtsprofile',
  schema_migration: 'Schemastand der Quellinstanz',
  source_record: 'Migrationsdaten der Quellinstanz',
  user_group: 'Gruppen der Quellinstanz; Mitgliedschaften werden über den Gruppennamen zugeordnet',
  user_notification: 'persönliche Einstellung',
  user_preference: 'persönliche Einstellung',
  user_session: 'Anmeldesitzung',
  watch: 'persönliche Beobachtungen',
  webhook_delivery: 'Zustellprotokoll der Quellinstanz',
};

export const typeSpec = (name: TypeName): TypeSpec => TYPES.find((t) => t.name === name)!;
export const fileOf = (t: TypeSpec) => (t.single ? `${t.name}.json` : `${t.name}.ndjson`);

/** Umfang eines Exports (Stufe K3): alles oder eine Auswahl, aus der Abhängiges nachgezogen wird */
export interface ExportScope {
  kind: 'complete' | 'selection';
  /** Ordner samt Unterordnern */
  folders?: string[];
  /** Testfälle per ID oder Schlüssel */
  testCases?: string[];
  /** Abfragesprache (wie in der Testfallliste) */
  query?: string;
  testSets?: string[];
  /** Pläne bzw. Zyklen mit ihren Ausführungen (nur mit Option „Ausführungen“) */
  plans?: string[];
  cycles?: string[];
}

export interface ExportOptions {
  /** alle Versionen oder nur aktuelle (dazu immer freigegebene und die von Ausführungen und Aufrufen benutzten) */
  versions: 'all' | 'current';
  /** Testpläne, Zyklen, Ausführungen, Ergebnisse, Sitzungen */
  executions: boolean;
  attachments: boolean;
  comments: boolean;
  /** Logins, Namen und E-Mails durch „Person 1…n“ ersetzen; Mitglieder entfallen */
  pseudonymize: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = { versions: 'all', executions: true, attachments: true, comments: true, pseudonymize: false };

/** Manifest eines Pakets */
export interface Manifest {
  format: typeof FORMAT;
  formatVersion: string;
  anemo: { version: string; commit: string | null };
  sourceInstance: string;
  transferId: string;
  exportedAt: string;
  exportedBy: string;
  scope: ExportScope;
  options: ExportOptions;
  project: { key: string; name: string; visibility: string; externalServices: string };
  counts: Partial<Record<TypeName, number>> & { files: number };
  persons: { login: string; displayName: string | null; email: string | null; active: boolean | null }[];
  groups: { name: string }[];
  warnings: string[];
  files: { path: string; sha256: string; size: number }[];
}
