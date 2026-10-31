// API-Typen (Teilmenge der Server-Antworten). Quelle der Wahrheit: GET /api/openapi.json bzw. server/src.

export type Format = 'CLASSIC' | 'GHERKIN' | 'PLAIN';

export interface Project { id: string; key: string; name: string; description: string | null; visibility?: 'internal' | 'restricted' }

export interface Folder { id: string; parentId: string | null; name: string; testCount: number }

export interface Step {
  id?: string; action: string; data: string; expected: string;
  /** Aufruf eines anderen Testfalls (modularer Test) */
  call?: { testCaseId: string; versionNo?: number | null } | null;
  /** in der Ausführungssicht: Herkunft eines eingesetzten Schritts */
  origin?: { key: string; title: string; versionNo: number };
  /** Herkunft aus der Schrittbibliothek (Kopie eines Bausteins) */
  blockId?: string | null;
  /** Abschnitt (Stufe J1): kein Prüfschritt; gruppiert die folgenden Schritte (siehe shared/steps/groups.ts) */
  kind?: 'step' | 'group' | null;
  title?: string | null;
  subtitle?: string | null;
  marker?: string | null;
  note?: string | null;
  legacy?: { action: string; data: string; expected: string } | null;
}

/** Datensatz parametrisierter Tests: Spalten = Parameter (${spalte} bzw. <spalte>), Zeilen = Durchläufe */
export interface Dataset { columns: string[]; rows: string[][] }
export interface Iteration { index: number; values: Record<string, string>; status: string; comment?: string | null; stepResults: StepResult[] }

export interface Content {
  title: string;
  format: Format;
  gherkin: string | null;
  /** PLAIN: Testanweisung als Freitext (Jira-Wiki-Markup) */
  plainText?: string | null;
  objective: string | null;
  preconditions: string | null;
  testData: string | null;
  priority: string | null;
  labels: string[];
  components: string[];
  steps: Step[];
  sections: { title: string; content: string }[];
  customFields: Record<string, unknown>;
  dataset?: Dataset | null;
  /** wiederverwendbare Vorbedingungen (IDs, in Reihenfolge) */
  preconditionIds?: string[];
}

export interface PreconditionRef { id: string; key: string; title: string; content: string | null; versionNo: number; archived: boolean }

export interface Version extends Content {
  aiAssisted?: string | null;
  id: string;
  versionNo: number;
  changeNote: string | null;
  createdAt: string;
  createdBy: string;
  executionSteps?: Step[];
}

export interface TestCase {
  id: string;
  projectKey: string;
  key: string;
  legacyKey: string | null;
  folderId: string | null;
  status: string;
  owner: string | null;
  currentVersion: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  approvedVersion?: number | null; approvedBy?: string | null; approvedAt?: string | null;
  archivedAt?: string | null; archivedBy?: string | null;
  estimateMinutes?: number | null;
}

export interface TestCaseDetail extends TestCase { version: Version; executionSteps: Step[] }

export interface TestCaseListItem extends TestCase {
  title: string; format: Format; priority: string | null; labels: string[]; stepCount: number;
}

export interface Reference {
  id: string; provider: string; externalKey: string; relation: string; url: string | null; title: string | null; status: string | null;
  /** Fehler zu einem bestimmten Schritt der Ausführung */
  stepId?: string | null;
  severity?: Severity | null;
}

export interface Attachment { id: string; fileName: string; storage: 'LOCAL' | 'SOURCE'; location: string; sizeBytes: number | null; author: string | null }

export type StatusCategory = 'OPEN' | 'IN_PROGRESS' | 'PASSED' | 'PASSED_WITH_ISSUES' | 'KNOWN_FAILURE' | 'FAILED' | 'BLOCKED' | 'INVALID' | 'NOT_APPLICABLE';
export interface ExecutionStatus {
  code: string; name: string; color: string; isFinal: boolean; sortOrder: number;
  category: StatusCategory; appliesTo: 'execution' | 'step' | 'both'; active: boolean; description: string | null; inUse?: number;
}
export type TestCaseStatusCategory = 'DRAFT' | 'REVIEW' | 'APPROVED' | 'DEPRECATED';
export interface TestCaseStatus {
  code: string; name: string; category: TestCaseStatusCategory; color: string; sortOrder: number;
  active: boolean; isInitial: boolean; description: string | null; inUse?: number;
}
export interface Workflow { statuses: TestCaseStatus[]; transitions: { from: string; to: string }[] }

export interface Plan {
  id: string; name: string; release: string | null; description?: string | null;
  cycleCount?: number; total?: number; byStatus?: Record<string, number>; firstDate?: string | null; lastDate?: string | null;
  /** Lagebild des Testmanagements für den Teststatusbericht */
  statusNote?: string | null; statusNoteAt?: string | null; statusNoteBy?: string | null;
  /** archiviert: in der Planung ausgeblendet (Berichte bleiben) */
  archivedAt?: string | null; archivedBy?: string | null;
}

export interface Page<T> { total: number; items: T[] }

export interface ExecutionPage extends Page<ExecutionListItem> { byStatus: Record<string, number>; byAssignee: Record<string, number>; durationSeconds?: number; effort?: { plannedMinutes: number; remainingMinutes: number; withoutEstimate: number } }

export interface Facet { value: string; count: number }

export interface MatrixData {
  cycles: { id: string; name: string; environment: string | null; build: string | null; startDate: string | null }[];
  totalCycles: number;
  rows: { testCaseId: string; key: string; legacyKey: string | null; title: string; cells: Record<string, { status: string; executionId: string }> }[];
}

export type SearchType = 'testcase' | 'cycle' | 'plan' | 'execution' | 'reference' | 'attachment';
export interface SearchHit {
  type: SearchType; id: string; projectKey: string; title: string; subtitle: string | null;
  target: { testCase?: string; cycleId?: string; executionId?: string; planId?: string };
}
export interface SearchResult { query: string; groups: { type: SearchType; total: number; items: SearchHit[] }[] }

export type Configuration = Record<string, string[]>;

export interface ConfigValue { id: string; dimensionKey: string; value: string; description: string | null; patterns: string[]; sortOrder: number }
export interface ConfigDimension { key: string; name: string; description: string | null; sortOrder: number; extractPattern: string | null; values: ConfigValue[] }
export interface ConfigCount { dimension: string; value: string; cycles: number }

export interface Cycle {
  configuration?: Configuration; configurationSource?: 'auto' | 'manual'; configurationEvidence?: Record<string, { value: string; match: string }[]>;
  id: string; planId: string | null; planName?: string | null; lastExecutedAt?: string | null; name: string; description: string | null; release: string | null; build: string | null;
  environment: string | null; startDate: string | null; endDate: string | null; total: number; byStatus: Record<string, number>;
}

export interface ExecutionListItem {
  reviewState?: 'pending' | 'approved' | 'rejected' | 'escalated' | null;
  id: string; cycleId: string; testCaseId: string; testCaseKey: string; legacyKey: string | null; title: string; versionNo: number; currentVersion: number;
  status: string; executedBy: string | null; executedAt: string | null; assignee: string | null; comment: string | null; defects: Reference[];
  durationSeconds?: number; iterations?: Iteration[]; updatedAt?: string;
}

export interface StepResult { stepId: string; status: string; comment?: string; previous?: { status: string; comment: string | null; versionNo: number } }

export interface ExecutionDetail {
  id: string; cycleId: string; status: string; comment: string | null; executedBy: string | null; executedAt: string | null;
  stepResults: StepResult[]; steps: Step[]; defects: Reference[];
  version: Version; testCase: { id: string; key: string; legacyKey: string | null; currentVersion: number };
  dataset: Dataset | null; iterations: Iteration[]; durationSeconds: number; startedAt: string | null; updatedAt: string;
  reviewState?: string | null;
  preconditions?: PreconditionRef[];
  /** Herkunft des Datensatzes: Zyklus, Testplan oder Testfall */
  datasetSource?: 'cycle' | 'plan' | 'testcase' | null;
  customFields?: Record<string, unknown>;
}

export interface HistoryItem {
  id: string; cycleId: string; cycleName: string; release: string | null; status: string; versionNo: number;
  executedBy: string | null; executedAt: string | null; comment: string | null;
}

export interface GherkinDoc {
  errors: { line: number; message: string }[];
  warnings: { line: number; message: string }[];
  scenarios: { name: string }[];
}

export interface DomainEvent { seq: number; type: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown>; actor: string; occurredAt: string }

export interface MigrationRun { id: string; source: string; status: string; startedAt: string; finishedAt: string | null }

export interface MigrationReport {
  run: MigrationRun;
  verdict: 'PASSED' | 'FAILED';
  byType: { sourceType: string; total: number; outcomes: Record<string, number>; actions: Record<string, number> }[];
  preservedFields: { field: string; count: number }[];
  failures: { sourceType: string; sourceId: string; messages: string[] }[];
  checks: { name: string; passed: boolean; details: string[] }[];
}

export interface Mapping {
  id: string; sourceType: string; sourceId: string; targetType: string | null; targetId: string | null; targetKey: string | null;
  outcome: string; action: string; preservedFields: string[]; messages: string[];
}

/** Schweregrad eines Fehlers (Reihenfolge = absteigend) – bewusst andere Wörter als die Testfall-Priorität */
export const SEVERITIES = ['Gravierend', 'Hoch', 'Mittel', 'Gering', 'Kosmetisch'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Burn-down eines Testplans gegen das geplante Ende (remaining null = Tag in der Zukunft) */
export interface Burndown {
  start: string | null; end: string | null;
  /** Stichtag der Berechnung (YYYY-MM-DD) */
  asOf?: string;
  points: { day: string; remaining: number | null; total: number; ideal: number | null }[];
  velocity: number; remaining: number; forecast: string | null; onTrack: boolean | null; daysLate: number | null;
}

/** Excel-Rundlauf: Ergebnis des Einlesens (Probelauf bzw. Übernahme) */
export interface OfflineResult {
  dryRun: boolean; updated: number; unchanged: number; conflicts: number; errors: number;
  items: { key: string; action: 'updated' | 'unchanged' | 'conflict' | 'error'; message?: string; status?: string }[];
}

/** Angestoßener CI-Lauf (GitLab-Pipeline) eines Zyklus */
export interface CiRun { id: string; externalId: string; ref: string; url: string | null; status: string; triggeredBy: string; createdAt: string }
