/**
 * Datenmodelle der Testberichte (in Anlehnung an ISO/IEC/IEEE 29119-3):
 * - Testprotokoll (Test Log) je Zyklus
 * - Testabschlussbericht (Test Completion Report) je Testplan/Release
 * - Testfallspezifikation (Test Case Specification) je Projekt/Ordner
 * Die Modelle sind zugleich das maschinenlesbare Ergebnis (JSON) im Lieferpaket.
 */
import type { Db } from '../../platform/db.ts';
import { groupTitle, isGroup, stepNumbers as checkNumbers } from '../../../../shared/steps/groups.ts';
import { notFound } from '../../platform/http.ts';
import { getCycle, getPlan, listSessions, listStatuses, loadDimensions } from '../execution/index.ts';
import { defectResolution, isResolvedStatus } from '../references/index.ts';
import { isFailedOrBlocked, isNotOk, isOpen, isPassed, rank } from '../../../../shared/status/status.ts';
import { executionSteps, resolveExecutionSteps } from '../testcases/index.ts';
import type { StatusReport } from './status.ts';

export interface StatusCount { code: string; name: string; color: string; category: string; count: number }
/**
 * Kennzahlen (ISTQB): ausgeführt = Ergebnis bestanden/fehlgeschlagen/blockiert; Durchführungsgrad = ausgeführt /
 * (gesamt − ungültig); Bestehensquote = bestanden / (bestanden + fehlgeschlagen) – blockiert und ungültig getrennt.
 * `failed` = fehlgeschlagen + blockiert (Probleme), `failedOnly` = nur fehlgeschlagen.
 */
export interface Summary {
  total: number; executed: number; byStatus: StatusCount[]; passRate: number | null; executionRate: number | null;
  failed: number; failedOnly: number; blocked: number; invalid: number; notApplicable: number; passedWithIssues: number; open: number;
  /** „Fehlgeschlagen (bekannt)“: zählt als ausgeführt und nicht bestanden, blockiert die Freigabe aber nicht */
  knownFailures: number;
}
export interface DefectRef { provider: string; key: string; title: string | null; status: string | null; url: string | null }
export interface AttachmentRef { id: string; fileName: string; contentType: string | null; sizeBytes: number | null; sourceKey: string | null }
/** Schrittzeile im Bericht; Abschnitte (J1) haben `group` (Titel) und keine Nummer (no = 0). */
export interface StepRow { no: number; stepId: string; action: string; data: string; expected: string; status: string; comment: string | null; group?: string | null }
export interface ExecutionRow {
  id: string; testCaseKey: string; legacyKey: string | null; title: string; version: number; status: string;
  assignee: string | null; executedBy: string | null; executedAt: Date | null; comment: string | null;
  defects: DefectRef[]; attachments: AttachmentRef[]; testCaseAttachments: AttachmentRef[]; steps: StepRow[]; cycleId: string; cycleName: string;
  /** Schrittnummer je Schritt-ID – auch ohne Schrittdetails (aufgerufene Schritte „aufrufId>schrittId“ als „n.m“) */
  stepNos: Record<string, string>;
  /** Durchläufe parametrisierter Tests (Werte und Ergebnis je Datenzeile) */
  iterations: { index: number; values: Record<string, string>; status: string; comment: string | null; stepResults: { stepId: string; status: string; comment?: string }[] }[];
  durationSeconds: number;
  /** KI-Agentenergebnis: Freigabe ausstehend/eskaliert → zählt als offen */
  reviewState: string | null;
  /** Konfiguration des Zyklus (kanonisch) – Stand je Testfall × Konfiguration */
  configKey: string;
  /** Testfall seit der getesteten Version geändert */
  outdated: boolean;
  /** Workflow-Kategorie der Testspezifikation (DRAFT/REVIEW = ungeprüft) */
  specCategory: string | null;
  testCaseId: string;
}
export interface CycleInfo {
  id: string; name: string; description: string | null; release: string | null; build: string | null; environment: string | null;
  startDate: Date | null; endDate: Date | null; configuration: string; planName: string | null;
}
interface Meta { project: { key: string; name: string }; generatedAt: Date; generatedBy: string; statuses: StatusCount[] }

export interface SessionRow { id: string; charter: string; areas: string | null; tester: string | null; status: string; durationSeconds: number; timeboxMinutes: number; summary: string | null; findings: { kind: string; text: string; defectKey?: string | null; testCaseKey?: string | null }[] }
export interface TestLog extends Meta { kind: 'test-log'; cycle: CycleInfo; summary: Summary; executions: ExecutionRow[]; sessions: SessionRow[] }
export interface CompletionReport extends Meta {
  kind: 'completion';
  plan: { id: string; name: string; release: string | null; description: string | null; assessment: string | null;
    assessmentBy: string | null; assessmentAt: Date | null; assessmentAi: string | null };
  cycles: (CycleInfo & { summary: Summary })[];
  /** aktueller Stand je Testfall (letztes Ergebnis über alle Zyklen des Plans) */
  current: Summary & { testCases: number };
  problems: ExecutionRow[];
  /** „Fehlgeschlagen (bekannt)“ (aktueller Stand) – Restrisiko, blockiert nicht */
  knownFailures: ExecutionRow[];
  /** Fehler behoben (laut Ticket), der Testfall ist aber noch nicht wieder bestanden – Nachtest ausstehend */
  retestPending: { key: string; title: string; cycleName: string; defects: string[] }[];
  /** Stand je Konfiguration (z. B. Gerät iPad/iPhone) und Problem-Matrix Testfall × Konfiguration; leer bei nur einer Konfiguration */
  byConfiguration: { configurations: { key: string; label: string; summary: Summary & { testCases: number } }[]; matrix: { key: string; title: string; cells: Record<string, string | null> }[] };
  openItems: ExecutionRow[];
  /** verknüpfte Fehler: an Ausführungen (`executions`) bzw. als Sitzungsfund (`sessions`) */
  defects: (DefectRef & { executions: number; sessions: number })[];
  assessment: { recommendation: 'release' | 'conditional' | 'not-recommended' | 'insufficient'; reasons: string[] };
  /** Ausstiegskriterien mit Erfüllung */
  criteria: { label: string; target: string; actual: string; met: boolean }[];
  /** Restrisiken (strukturiert) */
  risks: string[];
  /** abgelehnte/zurückgestellte Fehler – bekannt, nicht behoben */
  knownDefects: (DefectRef & { executions: number; sessions: number })[];
  /** archivierte Zyklen des Plans – nicht Teil der Testbasis */
  archivedCycles: number;
  coverage: { totals: Record<CoverageState, number>; requirements: number; deferred: number; withoutRequirement: number };
  changedNotTested: { key: string; title: string; testedVersion: number; currentVersion: number; changedAt: Date; changedBy: string; changeNote: string | null; risk: number }[];
  unreviewedSpec: { key: string; title: string }[];
  openFindings: { session: string; text: string }[];
  effortSeconds: number;
  releaseDecision: {
    decision: string; note: string | null; by: string | null; at: Date | null;
    /** auf dem Server abgelegtes Lieferpaket zur Entscheidung (Freigabestand) */
    baseline: { id: string; status: string; sha256: string | null; name: string | null } | null;
    /** Änderungen am Testplan, seinen Zyklen und Ausführungen nach der Entscheidung */
    changesSince: number;
  } | null;
}
export interface Specification extends Meta {
  kind: 'specification';
  scope: { folder: string | null; count: number; truncated: boolean };
  testCases: {
    key: string; legacyKey: string | null; title: string; version: number; status: string; priority: string | null;
    labels: string[]; components: string[]; objective: string | null; preconditions: string | null; testData: string | null;
    format: string; gherkin: string | null; plainText: string | null; steps: { no: number; action: string; data: string; expected: string; group?: string | null }[]; folder: string | null;
    attachments: AttachmentRef[];
  }[];
}
export type CoverageState = 'OK' | 'NOK' | 'NOT_RUN' | 'UNCOVERED';
/** Rückverfolgbarkeit (Stufe G3): Anforderungen eines Release × Testfälle × letztes Ergebnis im Testplan. */
export interface Traceability extends Meta {
  kind: 'traceability';
  /** Stichtag (historische Abdeckung); fehlt = aktueller Stand */
  asOf?: Date;
  plan: { id: string; name: string; release: string | null };
  totals: Record<CoverageState, number>;
  requirements: {
    provider: string; key: string; title: string | null; status: string | null; url: string | null; relation: string; state: CoverageState;
    tests: { key: string; title: string; inPlan: boolean; status: string | null; cycleName: string | null; executedAt: Date | null; outdated: boolean }[];
  }[];
  /** abgelehnte bzw. zurückgestellte Anforderungen (nicht Teil der Abdeckung) */
  deferred: { key: string; title: string | null; status: string | null }[];
  testsWithoutRequirement: { key: string; title: string }[];
}

export type Report = TestLog | CompletionReport | Specification | Traceability | StatusReport;

/**
 * Anforderungen eines Release: am Testplan oder seinen Zyklen verknüpft sowie an den Testfällen des Plans.
 * Abdeckung je Anforderung: ohne Testfall = UNCOVERED; ein fehlgeschlagener/blockierter Test = NOK; alle bestanden =
 * OK; sonst NOT_RUN (nicht eingeplant oder noch offen).
 *
 * Testbasis (Fach-Review Teil 3, Befund 10): Archivierte Zyklen zählen nicht mit – dieselbe Regel gilt im
 * Abschlussbericht, im Cockpit, im Burn-down und im Teststatusbericht. Archivierte bzw. veraltete Testfälle
 * (Kategorie DEPRECATED) zählen nur zur Abdeckung, wenn sie im Plan ausgeführt werden.
 */
export async function traceability(db: Db, planId: string, actor: string, opts: { asOf?: Date | undefined; rows?: ExecutionRow[] } = {}): Promise<Traceability> {
  const base = await traceBase(db, planId, actor, opts.rows);
  return traceAt(base, opts.asOf ? await traceHistory(db, base) : null, opts.asOf);
}

/** Abdeckung zu mehreren Stichtagen: Daten einmal laden, je Stichtag im Speicher rechnen (undefined = aktueller Stand). */
export async function traceabilitySeries(db: Db, planId: string, actor: string, dates: (Date | undefined)[]): Promise<Traceability[]> {
  const base = await traceBase(db, planId, actor);
  const hist = dates.some(Boolean) ? await traceHistory(db, base) : null;
  return dates.map((d) => traceAt(base, d ? hist : null, d));
}

type ReqRow = { provider: string; externalKey: string; title: string | null; status: string | null; url: string | null; relation: string; planLevel: boolean; tcOwners: string[] };
type Link = { externalKey: string; provider: string; id: string; key: string; title: string; retired: boolean };
interface TraceBase {
  plan: Awaited<ReturnType<typeof getPlan>>; m: Meta; cat: Map<string, string>; rows: ExecutionRow[];
  reqs: ReqRow[]; links: Link[];
  /** Testfälle des Plans (aktueller Titel, ob irgendeine Anforderung verknüpft ist), nach Schlüssel sortiert */
  tcs: { id: string; key: string; title: string; hasReq: boolean }[];
}
interface TraceHistory {
  results: Map<string, { status: string; recordedAt: Date }[]>;
  exec: Map<string, { createdAt: Date; reviewState: string | null; reviewedAt: Date | null }>;
  versions: Map<string, { versionNo: number; createdAt: Date }[]>;
}

async function traceBase(db: Db, planId: string, actor: string, given?: ExecutionRow[]): Promise<TraceBase> {
  const plan = await getPlan(db, planId);
  const m = await meta(db, plan.projectId, actor);
  const cat = new Map(m.statuses.map((s) => [s.code, s.category]));
  const cycleIds = (await db<{ id: string }[]>`select id from test_cycle where plan_id = ${planId} and archived_at is null`).map((r) => r.id);
  // ohne Anhänge und Fehler laden (werden hier nicht gebraucht); im Abschlussbericht die schon geladenen Zeilen nutzen
  const rows = given ?? await executionRows(db, { cycleIds }, false, { light: true });
  const tcIds = [...new Set(rows.map((r) => r.testCaseId))];
  const reqs = await db<ReqRow[]>`
    select r.provider, r.external_key, max(r.title) as title, max(r.status) as status, max(r.url) as url, min(r.relation) as relation,
      bool_or(r.owner_type <> 'TEST_CASE') as plan_level,
      coalesce(array_agg(distinct r.owner_id) filter (where r.owner_type = 'TEST_CASE'), '{}') as tc_owners
    from external_reference r
    where r.relation in ('REQUIREMENT', 'STORY', 'EPIC') and (
      (r.owner_type = 'TEST_PLAN' and r.owner_id = ${planId})
      or (r.owner_type = 'TEST_CYCLE' and r.owner_id = any(${cycleIds}::uuid[]))
      or (r.owner_type = 'TEST_CASE' and r.owner_id = any(${tcIds}::uuid[])))
    group by r.provider, r.external_key order by r.external_key`;
  const links: Link[] = reqs.length ? await db<Link[]>`
    select r.external_key, r.provider, tc.id, tc.key, v.title,
      (tc.archived_at is not null or coalesce(st.category = 'DEPRECATED', false)) as retired
    from external_reference r join test_case tc on tc.id = r.owner_id
    join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
    left join test_case_status st on st.code = tc.status
    where r.owner_type = 'TEST_CASE' and tc.project_id = ${plan.projectId} and r.relation in ('REQUIREMENT', 'STORY', 'EPIC')
      and r.external_key = any(${reqs.map((r) => r.externalKey)})
    order by tc.key` : [];
  const tcs = tcIds.length ? await db<TraceBase['tcs']>`
    select tc.id, tc.key, v.title,
      exists (select 1 from external_reference r where r.owner_type = 'TEST_CASE' and r.owner_id = tc.id and r.relation in ('REQUIREMENT', 'STORY', 'EPIC')) as has_req
    from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
    where tc.id = any(${tcIds}::uuid[]) order by tc.key` : [];
  return { plan, m, cat, rows, reqs, links, tcs };
}

/** Verlauf für Stichtage: Ergebnisse, Anlage-/Freigabezeitpunkte der Ausführungen, Versionen der Testfälle. */
async function traceHistory(db: Db, base: TraceBase): Promise<TraceHistory> {
  const ids = base.rows.map((r) => r.id);
  const tcIds = [...new Set(base.rows.map((r) => r.testCaseId))];
  const results = new Map<string, { status: string; recordedAt: Date }[]>();
  const exec = new Map<string, { createdAt: Date; reviewState: string | null; reviewedAt: Date | null }>();
  const versions = new Map<string, { versionNo: number; createdAt: Date }[]>();
  if (!ids.length) return { results, exec, versions };
  for (const h of await db<{ executionId: string; status: string; recordedAt: Date }[]>`
    select execution_id, status, recorded_at from execution_result where execution_id = any(${ids}::uuid[]) order by execution_id, id`) {
    (results.get(h.executionId) ?? results.set(h.executionId, []).get(h.executionId)!).push(h);
  }
  for (const e of await db<{ id: string; createdAt: Date; reviewState: string | null; reviewedAt: Date | null }[]>`
    select id, created_at, review_state, reviewed_at from test_execution where id = any(${ids}::uuid[])`) exec.set(e.id, e);
  for (const v of await db<{ testCaseId: string; versionNo: number; createdAt: Date }[]>`
    select test_case_id, version_no, created_at from test_case_version where test_case_id = any(${tcIds}::uuid[]) order by test_case_id, version_no`) {
    (versions.get(v.testCaseId) ?? versions.set(v.testCaseId, []).get(v.testCaseId)!).push(v);
  }
  return { results, exec, versions };
}

function traceAt(base: TraceBase, hist: TraceHistory | null, asOf: Date | undefined): Traceability {
  const { plan, m, cat } = base;
  const rows = hist && asOf ? asOfRows(base.rows, hist, asOf) : base.rows;
  const state = currentState(rows, cat);
  const byTc = new Map([...state.values()].map((x) => [x.testCaseId, x]));
  const inPlan = new Set(byTc.keys());
  const reqs = base.reqs.filter((r) => r.planLevel || r.tcOwners.some((id) => inPlan.has(id)));
  const keys = new Set(reqs.map((r) => `${r.provider}|${r.externalKey}`));
  // archivierte/veraltete Testfälle nur, wenn sie im Plan ausgeführt werden
  const links = base.links.filter((l) => keys.has(`${l.provider}|${l.externalKey}`) && (!l.retired || inPlan.has(l.id)));
  const linksByReq = new Map<string, Link[]>();
  for (const l of links) {
    const k = `${l.provider}|${l.externalKey}`;
    (linksByReq.get(k) ?? linksByReq.set(k, []).get(k)!).push(l);
  }
  const totals: Record<CoverageState, number> = { OK: 0, NOK: 0, NOT_RUN: 0, UNCOVERED: 0 };
  const requirements: Traceability['requirements'] = [];
  const deferred: Traceability['deferred'] = [];
  for (const r of reqs) {
    // abgelehnte/zurückgestellte Anforderungen zählen nicht zur Abdeckung des Release
    if (defectResolution(r.status) === 'rejected') { deferred.push({ key: r.externalKey, title: r.title, status: r.status }); continue; }
    const tests = (linksByReq.get(`${r.provider}|${r.externalKey}`) ?? []).map((l) => {
      const x = byTc.get(l.id);
      return { key: l.key, title: l.title, inPlan: !!x, status: x?.status ?? null, cycleName: x?.row.cycleName ?? null, executedAt: x?.row.executedAt ?? null, outdated: x?.row.outdated ?? false };
    });
    // nicht anwendbare Tests zählen nicht; trifft keiner zu, ist die Anforderung für dieses Release erfüllt
    const cats = tests.map((t) => (t.status ? cat.get(t.status) ?? 'OPEN' : 'OPEN')).filter((c) => c !== 'NOT_APPLICABLE');
    // OK nur, wenn alle bestanden (ungültig zählt nicht als bestanden) und die aktuelle Version getestet wurde
    const st: CoverageState = !tests.length ? 'UNCOVERED' : cats.some(isNotOk) ? 'NOK'
      : cats.every(isPassed) && tests.every((t) => !t.outdated || (t.status ? cat.get(t.status) === 'NOT_APPLICABLE' : false)) ? 'OK' : 'NOT_RUN';
    totals[st]++;
    requirements.push({ provider: r.provider, key: r.externalKey, title: r.title, status: r.status, url: r.url, relation: r.relation, state: st, tests });
  }
  const covered = new Set(links.map((l) => l.id));
  const without = base.tcs.filter((t) => inPlan.has(t.id) && !covered.has(t.id) && !t.hasReq).map((t) => ({ key: t.key, title: t.title }));
  return { kind: 'traceability', ...m, plan: { id: plan.id, name: plan.name, release: plan.release }, totals, requirements, deferred, testsWithoutRequirement: without,
    ...(asOf ? { asOf } : {}) };
}

/**
 * Stand der Ausführungen zu einem Stichtag (Fach-Review Teil 3, Befund 9) – nach denselben Regeln wie der aktuelle Stand:
 * - Ergebnis: letztes Ergebnis aus dem Verlauf bis zum Stichtag; ohne Verlauf (ältere bzw. übernommene Daten) zählt das
 *   Ergebnis, wenn es vor dem Stichtag erfasst wurde. Später angelegte Ausführungen fehlen.
 * - Veraltet: Zum Stichtag gab es schon eine neuere Version des Testfalls als die getestete.
 * - KI-Agentenergebnisse: Noch ungeprüfte (bzw. erst nach dem Stichtag geprüfte) Ergebnisse zählen als offen.
 *   Der Freigabezeitpunkt (`reviewed_at`) ist nur für die letzte Prüfung bekannt; im Zweifel zählt das Ergebnis als offen.
 * Verknüpfungen von Anforderungen gelten mit dem heutigen Stand.
 */
function asOfRows(rows: ExecutionRow[], hist: TraceHistory, asOf: Date): ExecutionRow[] {
  const versionAt = (tcId: string) => {
    let v: number | null = null;
    for (const x of hist.versions.get(tcId) ?? []) if (new Date(x.createdAt) <= asOf) v = x.versionNo;
    return v;
  };
  const out: ExecutionRow[] = [];
  for (const r of rows) {
    const e = hist.exec.get(r.id);
    if (e && new Date(e.createdAt) > asOf) continue;
    const results = hist.results.get(r.id);
    let status: string, executedAt: Date | null;
    if (results?.length) {
      let last: { status: string; recordedAt: Date } | undefined;
      for (const h of results) if (new Date(h.recordedAt) <= asOf) last = h;
      status = last?.status ?? 'NOT_EXECUTED';
      executedAt = last?.recordedAt ?? null;
    } else if (r.executedAt && new Date(r.executedAt) <= asOf) {
      status = r.status; executedAt = r.executedAt;
    } else {
      status = 'NOT_EXECUTED'; executedAt = null;
    }
    const current = versionAt(r.testCaseId);
    const reviewState = e?.reviewState === 'pending' || e?.reviewState === 'escalated' ? e.reviewState
      : (e?.reviewState === 'approved' || e?.reviewState === 'rejected') && e.reviewedAt && new Date(e.reviewedAt) > asOf ? 'pending' : null;
    out.push({ ...r, status, executedAt, outdated: current !== null && current > r.version, reviewState });
  }
  return out;
}

/**
 * Aktueller Stand je Testfall: je Konfiguration das zuletzt ausgeführte Ergebnis, über die Konfigurationen das
 * schlechteste (ein Fehlschlag unter Oracle bleibt sichtbar, auch wenn SQL Server später bestanden hat).
 * Nicht freigegebene Agentenergebnisse zählen als offen.
 */
export function currentState(rows: ExecutionRow[], cat: Map<string, string>) {
  const effective = (r: ExecutionRow) => (r.reviewState === 'pending' || r.reviewState === 'escalated' ? 'NOT_EXECUTED' : r.status);
  const perCfg = new Map<string, ExecutionRow>();
  for (const r of rows) {
    const k = `${r.testCaseKey}|${r.configKey}`;
    const prev = perCfg.get(k);
    if (!prev || (r.executedAt && (!prev.executedAt || r.executedAt > prev.executedAt))) perCfg.set(k, r);
  }
  const out = new Map<string, { testCaseId: string; row: ExecutionRow; status: string; configs: number }>();
  for (const r of perCfg.values()) {
    const st = effective(r);
    const prev = out.get(r.testCaseKey);
    if (!prev) out.set(r.testCaseKey, { testCaseId: r.testCaseId, row: r, status: st, configs: 1 });
    else {
      prev.configs++;
      if (rank(cat.get(st)) < rank(cat.get(prev.status))) { prev.row = r; prev.status = st; }
    }
  }
  return out;
}

/**
 * Stand je Konfiguration: je Konfigurationsschlüssel der aktuelle Stand der Testfälle (wie `currentState`, nur innerhalb
 * dieser Konfiguration) und eine Matrix der Testfälle, die in mindestens einer Konfiguration fehlgeschlagen oder blockiert sind (Zelle leer =
 * dort nicht eingeplant).
 * Bei nur einer (oder keiner) Konfiguration leer – dann sagt der Gesamtstand bereits alles.
 */
export function configurationView(rows: ExecutionRow[], cat: Map<string, string>, statuses: StatusCount[], dims: { key: string; name: string }[]): CompletionReport['byConfiguration'] {
  const keys = [...new Set(rows.map((r) => r.configKey))].sort();
  if (keys.length < 2) return { configurations: [], matrix: [] };
  const label = (k: string) => {
    const pairs = JSON.parse(k) as [string, string[]][];
    return pairs.length ? pairs.map(([d, v]) => `${dims.find((x) => x.key === d)?.name ?? d}: ${v.join(', ')}`).join('; ') : 'ohne Konfiguration';
  };
  const perKey = new Map(keys.map((k) => [k, currentState(rows.filter((r) => r.configKey === k), cat)]));
  const configurations = keys.map((k) => {
    const st = [...perKey.get(k)!.values()];
    return { key: k, label: label(k), summary: { ...summarize(statuses, st.map((x) => x.status)), testCases: st.length } };
  });
  const bad = (code: string | undefined) => ['FAILED', 'BLOCKED', 'KNOWN_FAILURE'].includes(cat.get(code ?? '') ?? '');
  const tcs = new Map<string, string>();
  for (const st of perKey.values()) for (const [key, x] of st) if (bad(x.status)) tcs.set(key, x.row.title);
  const matrix = [...tcs].sort(([a], [b]) => a.localeCompare(b, 'de', { numeric: true })).slice(0, 500)
    .map(([key, title]) => ({ key, title, cells: Object.fromEntries(keys.map((k) => [k, perKey.get(k)!.get(key)?.status ?? null])) }));
  return { configurations, matrix };
}

/** Konfiguration kanonisch (Schlüssel und Werte sortiert) – leere Konfiguration = ein gemeinsamer Stand */
function canonicalCfg(c: Record<string, string[]> | null | undefined): string {
  return JSON.stringify(Object.keys(c ?? {}).filter((k) => c![k]?.length).sort().map((k) => [k, [...c![k]!].sort()]));
}

async function meta(db: Db, projectId: string, actor: string): Promise<Meta> {
  const [project] = await db<{ key: string; name: string }[]>`select key, name from project where id = ${projectId}`;
  const statuses = (await listStatuses(db)).map((s) => ({ code: s.code, name: s.name, color: s.color, category: s.category, count: 0 }));
  return { project: project!, generatedAt: new Date(), generatedBy: actor, statuses };
}

function summarize(statuses: StatusCount[], codes: string[]): Summary {
  const cat = new Map(statuses.map((s) => [s.code, s.category]));
  const byStatus = statuses.map((s) => ({ ...s, count: codes.filter((c) => c === s.code).length })).filter((s) => s.count > 0);
  const n = (...cs: string[]) => codes.filter((c) => cs.includes(cat.get(c) ?? 'OPEN')).length;
  const passed = n('PASSED', 'PASSED_WITH_ISSUES');
  const failedOnly = n('FAILED');
  const blocked = n('BLOCKED');
  const invalid = n('INVALID');
  // „nicht anwendbar“ ist wie „ungültig“ keine Aussage: nicht im Nenner des Durchführungsgrads, nicht in der Bestehensquote
  const notApplicable = n('NOT_APPLICABLE');
  const known = n('KNOWN_FAILURE');
  const executed = passed + failedOnly + blocked + known;
  const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : null);
  return {
    total: codes.length, executed, byStatus, passRate: pct(passed, passed + failedOnly + known), executionRate: pct(executed, codes.length - invalid - notApplicable),
    failed: failedOnly + blocked, failedOnly, blocked, invalid, notApplicable, passedWithIssues: n('PASSED_WITH_ISSUES'), open: n('OPEN', 'IN_PROGRESS'), knownFailures: known,
  };
}

async function configurationText(db: Db, cfg: Record<string, string[]> | null | undefined): Promise<string> {
  const dims = await loadDimensions(db);
  return Object.entries(cfg ?? {}).filter(([, v]) => v.length)
    .map(([k, v]) => `${dims.find((d) => d.key === k)?.name ?? k}: ${v.join(', ')}`).join('; ');
}

async function cycleInfo(db: Db, cycleId: string): Promise<CycleInfo & { projectId: string }> {
  const c = await getCycle(db, cycleId);
  return {
    id: c.id, projectId: c.projectId, name: c.name, description: c.description, release: c.release, build: c.build, environment: c.environment,
    startDate: c.startDate, endDate: c.endDate, planName: c.planName,
    configuration: await configurationText(db, (c as { configuration?: Record<string, string[]> }).configuration),
  };
}

async function attachmentsOf(db: Db, ownerType: string, ownerIds: string[]): Promise<Map<string, AttachmentRef[]>> {
  const rows = await db<{ ownerId: string; id: string; fileName: string; contentType: string | null; sizeBytes: string | null; sourceKey: string | null }[]>`
    select owner_id, id, file_name, content_type, size_bytes, source_key from attachment
    where owner_type = ${ownerType} and storage = 'LOCAL' and owner_id = any(${ownerIds}::uuid[]) order by created_at`;
  const out = new Map<string, AttachmentRef[]>();
  for (const r of rows) {
    const list = out.get(r.ownerId) ?? out.set(r.ownerId, []).get(r.ownerId)!;
    list.push({ id: r.id, fileName: r.fileName, contentType: r.contentType, sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes), sourceKey: r.sourceKey });
  }
  return out;
}

/**
 * Ausführungen mit Version, Schritten, Defects und Anhängen (eine Abfrage je Art, nicht je Zeile).
 * `light`: ohne Fehler und Anhänge (für Abdeckungsberechnungen).
 */
async function executionRows(db: Db, where: { cycleIds: string[] }, withSteps: boolean, o: { light?: boolean } = {}): Promise<ExecutionRow[]> {
  if (!where.cycleIds.length) return [];
  const rows = await db<{
    id: string; cycleId: string; cycleName: string; testCaseId: string; key: string; legacyKey: string | null; title: string; versionNo: number; format: 'CLASSIC' | 'GHERKIN' | 'PLAIN'; gherkin: string | null;
    steps: { id: string; action: string; data: string; expected: string }[]; status: string; assignee: string | null; executedBy: string | null;
    executedAt: Date | null; comment: string | null; stepResults: { stepId: string; status: string; comment?: string }[];
    iterations: { index: number; values: Record<string, string>; status: string; comment?: string | null; stepResults?: { stepId: string; status: string; comment?: string }[] }[]; durationSeconds: number;
    reviewState: string | null; configuration: Record<string, string[]> | null; currentVersion: number; specCategory: string | null; versionId: string;
  }[]>`
    select e.id, e.test_case_version_id as version_id, e.cycle_id, c.name as cycle_name, tc.id as test_case_id, tc.key, tc.legacy_key, v.title, v.version_no, v.format, v.gherkin, v.steps, e.status, e.assignee,
           e.executed_by, e.executed_at, e.comment, e.step_results, e.iterations, e.duration_seconds, e.review_state, c.configuration, tc.current_version,
           (select st.category from test_case_status st where st.code = tc.status) as spec_category
    from test_execution e join test_cycle c on c.id = e.cycle_id join test_case tc on tc.id = e.test_case_id
    join test_case_version v on v.id = e.test_case_version_id
    where e.cycle_id = any(${where.cycleIds}::uuid[])
    order by c.start_date nulls last, c.name, e.order_no, tc.key`;
  const ids = rows.map((r) => r.id);
  const defects = o.light ? [] : await db<{ ownerId: string; provider: string; externalKey: string; title: string | null; status: string | null; url: string | null }[]>`
    select owner_id, provider, external_key, title, status, url from external_reference
    where owner_type = 'TEST_EXECUTION' and relation = 'DEFECT' and owner_id = any(${ids}::uuid[]) order by external_key`;
  // je Ausführung gruppiert (statt defects.filter je Zeile)
  const defectsOf = new Map<string, DefectRef[]>();
  // je Ticket einmal, auch wenn es an mehreren Schritten hängt
  for (const d of defects) {
    const list = defectsOf.get(d.ownerId) ?? defectsOf.set(d.ownerId, []).get(d.ownerId)!;
    if (!list.some((x) => x.provider === d.provider && x.key === d.externalKey)) list.push({ provider: d.provider, key: d.externalKey, title: d.title, status: d.status, url: d.url });
  }
  const atts = o.light ? new Map<string, AttachmentRef[]>() : await attachmentsOf(db, 'TEST_EXECUTION', ids);
  const tcAtts = o.light ? new Map<string, AttachmentRef[]>() : await attachmentsOf(db, 'TEST_CASE', [...new Set(rows.map((r) => r.testCaseId))]);
  // Aufrufe anderer Testfälle (modulare Tests) einmal je Version auflösen
  const resolved = new Map<string, { id?: string; action: string; data?: string; expected?: string }[]>();
  if (withSteps) {
    for (const r of rows) {
      if (resolved.has(r.versionId) || !r.steps.some((s) => (s as { call?: unknown }).call)) continue;
      resolved.set(r.versionId, await resolveExecutionSteps(db, { format: r.format, gherkin: r.gherkin, steps: r.steps } as never));
    }
  }
  return rows.map((r) => {
    const results = new Map(r.stepResults.map((s) => [s.stepId, s]));
    return {
      id: r.id, cycleId: r.cycleId, cycleName: r.cycleName, testCaseKey: r.key, legacyKey: r.legacyKey, title: r.title, version: r.versionNo, status: r.status,
      assignee: r.assignee, executedBy: r.executedBy, executedAt: r.executedAt, comment: r.comment,
      defects: defectsOf.get(r.id) ?? [],
      attachments: atts.get(r.id) ?? [],
      testCaseAttachments: tcAtts.get(r.testCaseId) ?? [],
      iterations: (r.iterations ?? []).map((i) => ({ index: i.index, values: i.values, status: i.status, comment: i.comment ?? null, stepResults: i.stepResults ?? [] })),
      durationSeconds: r.durationSeconds ?? 0, testCaseId: r.testCaseId,
      reviewState: r.reviewState, configKey: canonicalCfg(r.configuration), outdated: r.versionNo !== r.currentVersion, specCategory: r.specCategory,
      stepNos: stepNumbers(r.steps as { id?: string }[]),
      steps: withSteps
        ? withNumbers(resolved.get(r.versionId) ?? executionSteps({ format: r.format, gherkin: r.gherkin, steps: r.steps } as never)).map(({ s, no }) => ({
          no, stepId: s.id!, action: s.action, data: s.data ?? '', expected: s.expected ?? '',
          status: results.get(s.id!)?.status ?? 'NOT_EXECUTED', comment: results.get(s.id!)?.comment ?? null,
          group: isGroup(s as { kind?: string }) ? groupTitle(s as { title?: string | null }) : null,
        }))
        : [],
    };
  });
}

/** Nummern der Schritte einer Version; Schritte aufgerufener Testfälle erhalten „n.m“ (Reihenfolge innerhalb des Aufrufs). */
function stepNumbers(steps: { id?: string; kind?: string | null }[]): Record<string, string> {
  const out: Record<string, string> = {};
  const nos = checkNumbers(steps);
  steps.forEach((s, i) => { if (s.id && nos[i] !== null) out[s.id] = String(nos[i]); });
  return out;
}

/** Schritte mit Nummer (nur Prüfschritte werden gezählt; Abschnitte: 0). */
function withNumbers<S extends object>(steps: S[]): { s: S; no: number }[] {
  const nos = checkNumbers(steps as { kind?: string | null }[]);
  return steps.map((s, i) => ({ s, no: nos[i] ?? 0 }));
}

/** Zahl mit Einzahl/Mehrzahl („1 Testfall“, „3 Testfälle“). */
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export async function testLog(db: Db, cycleId: string, actor: string, opts: { steps: boolean }): Promise<TestLog> {
  const { projectId, ...cycle } = await cycleInfo(db, cycleId);
  const m = await meta(db, projectId, actor);
  const executions = await executionRows(db, { cycleIds: [cycleId] }, opts.steps);
  const sessions = (await listSessions(db, [cycleId])).map((s) => ({
    id: s.id, charter: s.charter, areas: s.areas, tester: s.tester, status: s.status, durationSeconds: s.elapsedSeconds, timeboxMinutes: s.timeboxMinutes,
    summary: s.summary, findings: s.findings.map((f) => ({ kind: f.kind, text: f.text, defectKey: f.defectKey ?? null, testCaseKey: f.testCaseKey ?? null })),
  }));
  return { kind: 'test-log', ...m, cycle, summary: summarize(m.statuses, executions.map((e) => e.status)), executions, sessions };
}

export async function completionReport(db: Db, planId: string, actor: string, opts: { steps: boolean }): Promise<CompletionReport> {
  const plan = await getPlan(db, planId);
  const m = await meta(db, plan.projectId, actor);
  // Zyklen in einer Abfrage, Ausführungen je Zyklus gruppiert (statt je Zyklus einzeln laden – wichtig unter Last)
  // Archivierte Zyklen gehören nicht zur Testbasis (gleiche Regel in Rückverfolgbarkeit, Cockpit, Burn-down und
  // Teststatusbericht); sie werden im Bericht nur als Anzahl genannt.
  const rows = await db<{ id: string; name: string; description: string | null; release: string | null; build: string | null; environment: string | null; startDate: Date | null; endDate: Date | null; configuration: Record<string, string[]> | null }[]>`
    select id, name, description, release, build, environment, start_date, end_date, configuration
    from test_cycle where plan_id = ${planId} and archived_at is null order by start_date nulls last, name`;
  const [arch] = await db<{ n: number }[]>`select count(*)::int as n from test_cycle where plan_id = ${planId} and archived_at is not null`;
  const cycleIds = rows.map((r) => r.id);
  const all = await executionRows(db, { cycleIds }, opts.steps);
  const byCycle = new Map<string, string[]>();
  for (const e of all) (byCycle.get(e.cycleId) ?? byCycle.set(e.cycleId, []).get(e.cycleId)!).push(e.status);
  const dims = await loadDimensions(db);
  const cfgText = (cfg: Record<string, string[]> | null) => Object.entries(cfg ?? {}).filter(([, v]) => v.length)
    .map(([k, v]) => `${dims.find((d) => d.key === k)?.name ?? k}: ${v.join(', ')}`).join('; ');
  const cycles = rows.map((c) => ({
    id: c.id, name: c.name, description: c.description, release: c.release, build: c.build, environment: c.environment,
    startDate: c.startDate, endDate: c.endDate, planName: plan.name, configuration: cfgText(c.configuration),
    summary: summarize(m.statuses, byCycle.get(c.id) ?? []),
  }));
  // aktueller Stand je Testfall (je Konfiguration das letzte Ergebnis, über Konfigurationen das schlechteste)
  const cat = new Map(m.statuses.map((s) => [s.code, s.category]));
  const state = currentState(all, cat);
  const current = [...state.values()].map((x) => ({ ...x.row, status: x.status }));
  const problems = current.filter((e) => isFailedOrBlocked(cat.get(e.status)));
  const openItems = current.filter((e) => isOpen(cat.get(e.status)));
  const withIssues = current.filter((e) => cat.get(e.status) === 'PASSED_WITH_ISSUES');
  const knownFailures = current.filter((e) => cat.get(e.status) === 'KNOWN_FAILURE');
  const unreviewedSpec = current.filter((e) => e.specCategory === 'DRAFT' || e.specCategory === 'REVIEW');
  const defectMap = new Map<string, DefectRef & { executions: number; sessions: number }>();
  for (const e of all) for (const d of e.defects) {
    const k = `${d.provider}:${d.key}`;
    const x = defectMap.get(k) ?? { ...d, executions: 0, sessions: 0 };
    x.executions++;
    defectMap.set(k, x);
  }
  // Fehler aus explorativen Sitzungen (als Fehler angelegte Sitzungsfunde) gehören ebenso dazu (Fach-Review Teil 3,
  // Befund 2): offene Fehler, Kriterium „Offene Fehler ≤ n“, Restrisiken und Empfehlung.
  const sessions = await listSessions(db, cycleIds);
  const sessionDefects = sessions.length ? await db<{ provider: string; externalKey: string; title: string | null; status: string | null; url: string | null }[]>`
    select provider, external_key, title, status, url from external_reference
    where owner_type = 'EXPLORATORY_SESSION' and relation = 'DEFECT' and owner_id = any(${sessions.map((x) => x.id)}::uuid[]) order by external_key` : [];
  for (const d of sessionDefects) {
    const k = `${d.provider}:${d.externalKey}`;
    const x = defectMap.get(k) ?? { provider: d.provider, key: d.externalKey, title: d.title, status: d.status, url: d.url, executions: 0, sessions: 0 };
    x.sessions++;
    defectMap.set(k, x);
  }
  const defects = [...defectMap.values()];
  const retestPending = current.filter((e) => isNotOk(cat.get(e.status)) && e.defects.some((d) => defectResolution(d.status) === 'fixed'))
    .map((e) => ({ key: e.testCaseKey, title: e.title, cycleName: e.cycleName, defects: e.defects.filter((d) => defectResolution(d.status) === 'fixed').map((d) => d.key) }));
  const openDefects = defects.filter((d) => defectResolution(d.status) === 'open');
  const knownDefects = defects.filter((d) => defectResolution(d.status) === 'rejected');
  const [rev] = await db<{ pending: number; escalated: number }[]>`
    select count(*) filter (where e.review_state = 'pending')::int as pending, count(*) filter (where e.review_state = 'escalated')::int as escalated
    from test_execution e where e.cycle_id = any(${cycleIds}::uuid[])`;
  const trace = await traceability(db, planId, actor, { rows: all });
  const changed = await changedNotTested(db, planId);
  const openFindings = sessions.flatMap((s) => s.findings.filter((f) => f.kind === 'bug' && !f.defectKey).map((f) => ({ session: s.charter, text: f.text })));
  const summary = { ...summarize(m.statuses, current.map((e) => e.status)), testCases: current.length };
  const byConfiguration = configurationView(all, cat, m.statuses, dims);
  const [eff] = await db<{ seconds: number }[]>`select coalesce(sum(duration_seconds), 0)::int as seconds from test_execution where cycle_id = any(${cycleIds}::uuid[])`;

  // Ausstiegskriterien (strukturiert am Testplan) – je Kriterium erfüllt/nicht erfüllt
  const ec = (plan.exitCriteria ?? {}) as ExitCriteria;
  const criteria: CompletionReport['criteria'] = [];
  if (ec.minPassRate != null) criteria.push({ label: 'Bestehensquote', target: `≥ ${ec.minPassRate} %`, actual: summary.passRate === null ? '–' : `${summary.passRate} %`, met: summary.passRate !== null && summary.passRate >= ec.minPassRate });
  if (ec.minExecutionRate != null) criteria.push({ label: 'Durchführungsgrad', target: `≥ ${ec.minExecutionRate} %`, actual: summary.executionRate === null ? '–' : `${summary.executionRate} %`, met: summary.executionRate !== null && summary.executionRate >= ec.minExecutionRate });
  if (ec.maxOpenDefects != null) criteria.push({ label: 'Offene Fehler', target: `≤ ${ec.maxOpenDefects}`, actual: String(openDefects.length), met: openDefects.length <= ec.maxOpenDefects });
  if (ec.maxKnownFailures != null) criteria.push({ label: 'Bekannte Fehler (dokumentiert)', target: `≤ ${ec.maxKnownFailures}`, actual: String(knownFailures.length), met: knownFailures.length <= ec.maxKnownFailures });
  if (ec.maxFailed != null) criteria.push({ label: 'Fehlgeschlagene/blockierte Testfälle', target: `≤ ${ec.maxFailed}`, actual: String(problems.length), met: problems.length <= ec.maxFailed });
  if (ec.fullCoverage) criteria.push({ label: 'Anforderungsabdeckung', target: 'alle Anforderungen bestanden', actual: `${trace.totals.OK} von ${trace.requirements.length}`, met: trace.requirements.length > 0 && trace.totals.OK === trace.requirements.length });
  if (ec.noUntestedChanges) criteria.push({ label: 'Änderungen erneut getestet', target: '0 offen', actual: String(changed.length), met: changed.length === 0 });

  // Restrisiken (strukturiert, für Bericht und Freigabe)
  const risks: string[] = [];
  if (trace.totals.UNCOVERED) risks.push(`${n(trace.totals.UNCOVERED, 'Anforderung', 'Anforderungen')} ohne Testfall`);
  if (trace.totals.NOT_RUN) risks.push(`${n(trace.totals.NOT_RUN, 'Anforderung', 'Anforderungen')} nicht (vollständig) bzw. nur in einer Vorversion getestet`);
  if (changed.length) risks.push(`${n(changed.length, 'Testfall', 'Testfälle')} seit dem letzten Test geändert, nicht erneut getestet`);
  if (knownDefects.length) risks.push(`${n(knownDefects.length, 'bekannter, nicht behobener Fehler', 'bekannte, nicht behobene Fehler')} (abgelehnt/zurückgestellt): ${knownDefects.slice(0, 8).map((d) => d.key).join(', ')}`);
  if (knownFailures.length) risks.push(`${n(knownFailures.length, 'Testfall', 'Testfälle')} fehlgeschlagen mit dokumentiertem bekanntem Fehler: ${knownFailures.slice(0, 8).map((e) => e.testCaseKey).join(', ')}${knownFailures.length > 8 ? ' …' : ''}`);
  if (withIssues.length) risks.push(`${n(withIssues.length, 'Testfall', 'Testfälle')} bestanden mit Einschränkung/Mangel`);
  if (openFindings.length) risks.push(`${n(openFindings.length, 'Fehlerfund', 'Fehlerfunde')} aus explorativen Sitzungen ohne Ticket`);
  if (unreviewedSpec.length) risks.push(`${n(unreviewedSpec.length, 'Testfall', 'Testfälle')} mit ungeprüfter Testspezifikation (Entwurf/Review) ausgeführt`);

  // Empfehlung (regelbasiert): keine Aussage ohne bestandene Tests; Fehlschläge oder verfehlte Ausstiegskriterien
  // → nicht empfohlen; offene Punkte und Restrisiken → unter Vorbehalt
  const reasons: string[] = [];
  const unmet = criteria.filter((c) => !c.met);
  if (problems.length) reasons.push(`${n(problems.length, 'Testfall', 'Testfälle')} aktuell fehlgeschlagen oder blockiert`);
  for (const c of unmet) reasons.push(`Ausstiegskriterium nicht erfüllt: ${c.label} (${c.actual}, Ziel ${c.target})`);
  if (openItems.length) reasons.push(`${n(openItems.length, 'Testfall', 'Testfälle')} noch nicht abschließend ausgeführt`);
  if (retestPending.length) reasons.push(`${n(retestPending.length, 'Testfall', 'Testfälle')}: Fehler laut Ticket behoben, Nachtest steht aus`);
  if (openDefects.length) reasons.push(`${n(openDefects.length, 'verknüpfter Fehler', 'verknüpfte Fehler')} noch offen`);
  if (rev!.pending) reasons.push(`${n(rev!.pending, 'Ergebnis', 'Ergebnisse')} von KI-Agenten noch nicht geprüft (zählen als offen)`);
  if (rev!.escalated) reasons.push(`${n(rev!.escalated, 'von Agenten eskalierter Fall', 'von Agenten eskalierte Fälle')} offen`);
  reasons.push(...risks.filter((r) => !reasons.includes(r)));
  const passedAny = current.some((e) => isPassed(cat.get(e.status)));
  const recommendation: CompletionReport['assessment']['recommendation'] = problems.length || (unmet.length && passedAny) ? 'not-recommended'
    : !current.length || !passedAny ? 'insufficient'
    : reasons.length ? 'conditional' : 'release';
  if (recommendation === 'insufficient') reasons.unshift(current.length ? 'Kein Testfall bestanden – keine Aussage zur Freigabe möglich' : 'Keine Testfälle im Testplan – keine Aussage zur Freigabe möglich');
  if (!reasons.length) reasons.push('Alle Testfälle bestanden, keine offenen Fehler und keine bekannten Restrisiken');
  return {
    kind: 'completion', ...m,
    plan: { id: plan.id, name: plan.name, release: plan.release, description: plan.description, assessment: plan.assessment ?? null,
      assessmentBy: plan.assessmentBy ?? null, assessmentAt: plan.assessmentAt ?? null, assessmentAi: plan.assessmentAi ?? null },
    cycles, current: summary,
    problems, knownFailures, retestPending, byConfiguration, openItems, defects, assessment: { recommendation, reasons },
    criteria, risks, knownDefects, archivedCycles: arch?.n ?? 0, coverage: { totals: trace.totals, requirements: trace.requirements.length, deferred: trace.deferred.length, withoutRequirement: trace.testsWithoutRequirement.length },
    changedNotTested: changed, unreviewedSpec: unreviewedSpec.map((e) => ({ key: e.testCaseKey, title: e.title })), openFindings, effortSeconds: eff?.seconds ?? 0,
    releaseDecision: plan.releaseDecision ? { decision: plan.releaseDecision, note: plan.releaseNote ?? null, by: plan.releaseBy ?? null, at: plan.releaseAt ?? null,
      ...(await decisionState(db, planId, plan.releaseAt ?? null)) } : null,
  };
}

/**
 * Freigabestand und Änderungen nach der Entscheidung (Review 30.10.2026, F1): Ereignisse am Testplan, seinen Zyklen
 * und deren Ausführungen nach dem Zeitpunkt der Entscheidung (ohne Entscheidung und Ablage selbst).
 */
async function decisionState(db: Db, planId: string, at: Date | null) {
  if (!at) return { baseline: null, changesSince: 0 };
  const [b] = await db<{ id: string; status: string; packageSha256: string | null; packageName: string | null }[]>`
    select id, status, package_sha256, package_name from release_baseline where plan_id = ${planId} and decided_at = ${at}`;
  const [r] = await db<{ n: number }[]>`
    select count(*)::int as n from domain_event e
    where e.occurred_at > ${at} and e.type not in ('ReleaseDecided', 'ReleaseBaselineCreated')
      and (e.aggregate_id = ${planId}
        or e.aggregate_id in (select id from test_cycle where plan_id = ${planId})
        or e.aggregate_id in (select x.id from test_execution x join test_cycle c on c.id = x.cycle_id where c.plan_id = ${planId}))`;
  return { baseline: b ? { id: b.id, status: b.status, sha256: b.packageSha256, name: b.packageName } : null, changesSince: r?.n ?? 0 };
}

export interface ExitCriteria { minPassRate?: number | null; minExecutionRate?: number | null; maxOpenDefects?: number | null; maxFailed?: number | null; maxKnownFailures?: number | null; fullCoverage?: boolean; noUntestedChanges?: boolean }

/** Testfälle, deren aktuelle Version neuer ist als die zuletzt im Plan ausgeführte. */
export async function changedNotTested(db: Db, planId: string) {
  const rows = await db<{ key: string; title: string; testedVersion: number; currentVersion: number; changedAt: Date; changedBy: string; changeNote: string | null }[]>`
    with last as (
      select distinct on (e.test_case_id) e.test_case_id, v.version_no
      from test_execution e join test_cycle c on c.id = e.cycle_id join test_case_version v on v.id = e.test_case_version_id
      where c.plan_id = ${planId} and c.archived_at is null and e.executed_at is not null
      order by e.test_case_id, e.executed_at desc)
    select tc.key, cv.title, last.version_no as tested_version, tc.current_version, cv.created_at as changed_at, cv.created_by as changed_by, cv.change_note
    from last join test_case tc on tc.id = last.test_case_id
    join test_case_version cv on cv.test_case_id = tc.id and cv.version_no = tc.current_version
    where tc.current_version > last.version_no
    order by cv.created_at desc limit 200`;
  return rows.map((c) => ({ ...c, risk: c.currentVersion - c.testedVersion }));
}

export { isResolvedStatus };

const SPEC_LIMIT = 3000;
export async function specification(db: Db, projectKey: string, folderId: string | null, actor: string): Promise<Specification> {
  const [p] = await db<{ id: string }[]>`select id from project where key = ${projectKey}`;
  if (!p) throw notFound('Projekt', projectKey);
  const m = await meta(db, p.id, actor);
  const folders = await db<{ id: string; parentId: string | null; name: string }[]>`select id, parent_id, name from folder where project_id = ${p.id}`;
  const path = (id: string | null): string | null => {
    const f = folders.find((x) => x.id === id);
    return f ? [path(f.parentId), f.name].filter(Boolean).join(' / ') : null;
  };
  const inScope = new Set<string>();
  if (folderId) {
    const add = (id: string) => { inScope.add(id); folders.filter((f) => f.parentId === id).forEach((f) => add(f.id)); };
    add(folderId);
  }
  const rows = await db<{
    id: string; key: string; legacyKey: string | null; status: string; folderId: string | null; title: string; versionNo: number; priority: string | null;
    labels: string[]; components: string[]; objective: string | null; preconditions: string | null; testData: string | null;
    format: 'CLASSIC' | 'GHERKIN' | 'PLAIN'; gherkin: string | null; plainText: string | null; steps: { id: string; action: string; data: string; expected: string }[];
  }[]>`
    select tc.id, tc.key, tc.legacy_key, tc.status, tc.folder_id, v.title, v.version_no, v.priority, v.labels, v.components, v.objective,
           v.preconditions, v.test_data, v.format, v.gherkin, v.plain_text, v.steps
    from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
    where tc.project_id = ${p.id} and tc.archived_at is null ${folderId ? db`and tc.folder_id = any(${[...inScope]}::uuid[])` : db``}
    order by tc.key`;
  rows.sort((a, b) => a.key.localeCompare(b.key, 'de', { numeric: true }));
  const shown = rows.slice(0, SPEC_LIMIT);
  const atts = await attachmentsOf(db, 'TEST_CASE', shown.map((r) => r.id));
  return {
    kind: 'specification', ...m,
    scope: { folder: folderId ? path(folderId) : null, count: rows.length, truncated: rows.length > SPEC_LIMIT },
    testCases: shown.map((r) => ({
      key: r.key, legacyKey: r.legacyKey, title: r.title, version: r.versionNo, status: r.status, priority: r.priority, labels: r.labels,
      components: r.components, objective: r.objective, preconditions: r.preconditions, testData: r.testData, format: r.format, gherkin: r.gherkin, plainText: r.plainText,
      folder: path(r.folderId), attachments: atts.get(r.id) ?? [],
      steps: r.format === 'CLASSIC' ? withNumbers(r.steps).map(({ s, no }) => ({ no, action: s.action, data: s.data ?? '', expected: s.expected ?? '', group: isGroup(s as { kind?: string }) ? groupTitle(s as { title?: string | null }) : null })) : [],
    })),
  };
}
