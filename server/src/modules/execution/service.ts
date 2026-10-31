import { checkSteps, groupTitle, isGroup, plainTitle, stepNumbers } from '../../../../shared/steps/groups.ts';
import type { Db } from '../../platform/db.ts';
import { badRequest, conflict, HttpError, notFound } from '../../platform/http.ts';
import { EventTypes, INSTANCE_AGGREGATE, recordChange, recordEvent } from '../events/index.ts';
import { linkReference, listReferencesForOwners, providerForKey, SEVERITIES, type ExternalReference, checkUrlLink, clientReference, urlReference } from '../references/index.ts';
import { type Dataset, effectiveDataset, getTestCase, getVersionById, resolveExecutionSteps, type Step } from '../testcases/index.ts';
import { autoClassifyCycle, setCycleConfiguration, type Configuration } from './configuration.ts';
import { deriveOverall, isOpen } from '../../../../shared/status/status.ts';
import { compileExecutionQuery } from '../query/index.ts';
import { deleteAttachmentsOf } from '../attachments/index.ts';
import { validateCustomFields } from '../fields/index.ts';
import { preconditionsByIds } from '../preconditions/index.ts';

export type StatusCategory = 'OPEN' | 'IN_PROGRESS' | 'PASSED' | 'PASSED_WITH_ISSUES' | 'KNOWN_FAILURE' | 'FAILED' | 'BLOCKED' | 'INVALID' | 'NOT_APPLICABLE';
export interface ExecutionStatus {
  code: string; name: string; color: string; isFinal: boolean; sortOrder: number;
  /** Bedeutung für Auswertungen und Vorschläge (ADR-0013) */
  category: StatusCategory; appliesTo: 'execution' | 'step' | 'both'; active: boolean; description: string | null;
}
/** Status-Codes einer Kategorie als SQL-Teilabfrage */
const codesOf = (db: Db, ...cats: StatusCategory[]) => db`(select code from execution_status where category in ${db(cats)})`;

export interface TestPlan {
  id: string; projectId: string; name: string; description: string | null; release: string | null;
  /** Fazit des Testmanagements für den Abschlussbericht (ggf. aus KI-Entwurf, geprüft) */
  assessment?: string | null;
  /** wer das Fazit wann gespeichert hat; Modell, falls ein KI-Entwurf übernommen wurde */
  assessmentBy?: string | null; assessmentAt?: Date | null; assessmentAi?: string | null;
  /** archiviert: aus der Planung ausgeblendet, Berichte und Freigabestände bleiben */
  archivedAt?: Date | null; archivedBy?: string | null;
  /** strukturierte Ausstiegskriterien (Bestehensquote, Durchführungsgrad, offene Fehler …) */
  exitCriteria?: Record<string, unknown>;
  /** Freigabeentscheidung der Testleitung */
  releaseDecision?: 'released' | 'conditional' | 'rejected' | null; releaseNote?: string | null; releaseBy?: string | null; releaseAt?: Date | null;
  createdAt: Date; createdBy: string;
}

export interface TestCycle {
  id: string; projectId: string; planId: string | null; name: string; description: string | null;
  release: string | null; build: string | null; environment: string | null;
  startDate: Date | null; endDate: Date | null; customFields: Record<string, unknown>;
  createdAt: Date; createdBy: string;
}

export interface CycleWithProgress extends TestCycle {
  total: number;
  byStatus: Record<string, number>;
}

/** Schrittergebnis; `previous`: Ergebnis vor einer Umstellung auf eine neue Testfallfassung (Stufe J2), nur zur Anzeige */
export interface StepResult { stepId: string; status: string; comment?: string | undefined; previous?: { status: string; comment: string | null; versionNo: number } | undefined }

/** Schweregrad eines Fehlerverweises (wie in der Datenbank) */
export type Severity = (typeof SEVERITIES)[number];

/**
 * Anbieter eines Fehlerschlüssels: reine Nummern (#4711) sind OpenProject-Arbeitspakete, sonst Jira-Schlüssel. Eine
 * Quelle für Excel-Rundlauf, Ergebnis-API und MCP (vorher je eigene Kopie bzw. fest „jira“).
 */
export function defectProviderOf(key: string): 'openproject' | 'jira' | 'url' {
  return /^https?:\/\//i.test(key.trim()) ? 'url' : /^#?\d+$/.test(key.trim()) ? 'openproject' : 'jira';
}

/**
 * Eingegebenen Fehlerschlüssel einordnen (mit Anbindungen): Anbieter und gespeicherter Schlüssel. Schlüssel wie PROJ-315
 * gehören zu OpenProject, wenn es sie kennt bzw. nur OpenProject angebunden ist (siehe providerForKey).
 */
export async function defectKey(key: string, provider?: string | null): Promise<{ provider: string; key: string }> {
  const p = provider ?? await providerForKey(key);
  const k = key.trim();
  return { provider: p, key: p === 'url' ? k : p === 'openproject' ? k.replace(/^#/, '').toUpperCase() : k.replace(/^#(?=\d)/, '') };
}

export interface TestExecution {
  id: string; cycleId: string; testCaseId: string; testCaseVersionId: string; orderNo: number;
  status: string; assignee: string | null; executedBy: string | null; executedAt: Date | null;
  comment: string | null; stepResults: StepResult[]; customFields: Record<string, unknown>;
  createdAt: Date; updatedAt: Date;
  /** Durchläufe eines parametrisierten Tests (je Datenzeile) */
  iterations: Iteration[];
  startedAt: Date | null; durationSeconds: number;
}

export interface Iteration { index: number; values: Record<string, string>; status: string; comment?: string | null; stepResults: StepResult[] }

export interface ExecutionListItem extends TestExecution {
  testCaseKey: string; legacyKey: string | null; title: string; versionNo: number; currentVersion: number;
  defects: ExternalReference[];
}

// ---- Status ----

export async function listStatuses(db: Db): Promise<(ExecutionStatus & { inUse: number })[]> {
  return db<(ExecutionStatus & { inUse: number })[]>`
    select s.*, (select count(*)::int from test_execution e where e.status = s.code) as in_use
    from execution_status s order by sort_order, code`;
}

/** Kategorie eines neu übernommenen Status aus seinem Namen ableiten (in der Administration korrigierbar). */
export function guessCategory(name: string, isFinal: boolean): StatusCategory {
  const n = name.toLowerCase();
  if (/bestanden|pass|ok\b|erfolgreich/.test(n)) return 'PASSED';
  if (/fehl|fail|error/.test(n)) return 'FAILED';
  if (/block/.test(n)) return 'BLOCKED';
  if (/invalid|ungültig|n\/a|nicht relevant/.test(n)) return 'INVALID';
  if (/arbeit|progress|wip/.test(n)) return 'IN_PROGRESS';
  return isFinal ? 'PASSED' : 'OPEN';
}

export async function upsertStatus(db: Db, code: string, s: Pick<ExecutionStatus, 'name' | 'color' | 'category' | 'appliesTo' | 'active' | 'sortOrder' | 'description'>, actor = 'system'): Promise<void> {
  if (code === 'NOT_EXECUTED' && (!s.active || s.category !== 'OPEN')) throw badRequest('„Nicht ausgeführt“ ist der Ausgangsstatus und bleibt aktiv und offen.');
  const isFinal = !['OPEN', 'IN_PROGRESS'].includes(s.category);
  // Die Kategorie wirkt instanzweit und rückwirkend auf alle Kennzahlen – jede Änderung gehört ins Protokoll
  const [before] = await db<Record<string, unknown>[]>`select name, color, category, applies_to, active, sort_order, description from execution_status where code = ${code}`;
  await recordChange(db, { type: EventTypes.StatusCatalogChanged, aggregateType: 'StatusCatalog', aggregateId: INSTANCE_AGGREGATE, actor, payload: { code, created: !before },
    before: before ?? {}, after: { name: s.name, color: s.color, category: s.category, appliesTo: s.appliesTo, active: s.active, sortOrder: s.sortOrder, description: s.description } });
  await db`
    insert into execution_status(code, name, color, is_final, sort_order, category, applies_to, active, description)
    values (${code}, ${s.name}, ${s.color}, ${isFinal}, ${s.sortOrder}, ${s.category}, ${s.appliesTo}, ${s.active}, ${s.description})
    on conflict (code) do update set name = excluded.name, color = excluded.color, is_final = excluded.is_final,
      sort_order = excluded.sort_order, category = excluded.category, applies_to = excluded.applies_to,
      active = excluded.active, description = excluded.description`;
}

/** Legt einen (z. B. aus Zephyr migrierten) eigenen Status an bzw. übernimmt Name und Farbe aus der Quelle. */
export async function ensureStatus(db: Db, s: { code: string; name: string; color?: string | undefined; isFinal?: boolean }): Promise<void> {
  await db`
    insert into execution_status(code, name, color, is_final, sort_order, category)
    values (${s.code}, ${s.name}, ${s.color ?? '#888888'}, ${s.isFinal ?? true},
            (select coalesce(max(sort_order), 0) + 1 from execution_status), ${guessCategory(s.name, s.isFinal ?? true)})
    on conflict (code) do update set name = excluded.name,
      color = case when ${s.color ?? null}::text is null then execution_status.color else excluded.color end`;
}

// ---- Pläne ----

export async function createPlan(db: Db, projectId: string, p: { name: string; description?: string | null; release?: string | null }, actor: string): Promise<TestPlan> {
  const [plan] = await db<TestPlan[]>`
    insert into test_plan(project_id, name, description, release, created_by)
    values (${projectId}, ${p.name}, ${p.description ?? null}, ${p.release ?? null}, ${actor}) returning *`;
  return plan!;
}

export async function getPlan(db: Db, id: string): Promise<TestPlan> {
  const [p] = await db<TestPlan[]>`select * from test_plan where id = ${id}`;
  if (!p) throw notFound('Testplan', id);
  return p;
}

export async function updatePlan(db: Db, id: string, p: { name: string; description?: string | null; release?: string | null }, actor = 'system'): Promise<TestPlan> {
  const [before] = await db<{ name: string; description: string | null; release: string | null }[]>`select name, description, release from test_plan where id = ${id}`;
  if (!before) throw notFound('Testplan', id);
  await recordChange(db, { type: EventTypes.PlanChanged, aggregateType: 'TestPlan', aggregateId: id, actor,
    before: { ...before }, after: { name: p.name, description: p.description ?? null, release: p.release ?? null } });
  const [plan] = await db<TestPlan[]>`
    update test_plan set name = ${p.name}, description = ${p.description ?? null}, release = ${p.release ?? null}
    where id = ${id} returning *`;
  if (!plan) throw notFound('Testplan', id);
  return plan;
}

/** Nur leere Testpläne lassen sich löschen – Zyklen und Ergebnisse gehen nie nebenbei verloren. */
export async function deletePlan(db: Db, id: string): Promise<void> {
  const [row] = await db<{ n: number }[]>`select count(*)::int as n from test_cycle where plan_id = ${id}`;
  const n = row?.n ?? 0;
  if (n > 0) throw conflict(`Der Testplan enthält ${n} Zyklen und kann nicht gelöscht werden.`);
  const r = await db`delete from test_plan where id = ${id}`;
  if (!r.count) throw notFound('Testplan', id);
  // Reste ohne Fremdschlüssel (Beobachtungen, Verweise, Datensatz-Überschreibungen des Plans)
  await db`delete from watch where object_type = 'TEST_PLAN' and object_id = ${id}`;
  await db`delete from external_reference where owner_type = 'TEST_PLAN' and owner_id = ${id}`;
  await db`delete from dataset_override where scope = 'plan' and scope_id = ${id}`;
}

export async function listPlans(db: Db, projectId: string): Promise<TestPlan[]> {
  return db<TestPlan[]>`select * from test_plan where project_id = ${projectId} order by created_at desc`;
}

// ---- Zyklen ----

export interface CycleInput {
  name: string; planId?: string | null | undefined; description?: string | null | undefined; release?: string | null | undefined;
  build?: string | null | undefined; environment?: string | null | undefined;
  startDate?: string | Date | null | undefined; endDate?: string | Date | null | undefined;
  customFields?: Record<string, unknown> | undefined; createdAt?: Date | undefined; createdBy?: string | undefined;
  /** Manuell gesetzte Konfiguration; ohne Angabe wird sie aus Name/Umgebung/Build erkannt. */
  configuration?: Configuration | null | undefined;
}

/** Testplan muss zum selben Projekt gehören – sonst ließen sich Zyklen in fremde (ggf. eingeschränkte) Pläne hängen. */
async function assertPlanInProject(db: Db, planId: string | null | undefined, projectId: string): Promise<void> {
  if (!planId) return;
  const [p] = await db`select 1 from test_plan where id = ${planId} and project_id = ${projectId}`;
  if (!p) throw notFound('Testplan', planId);
}

export async function createCycle(db: Db, projectId: string, c: CycleInput, actor: string): Promise<TestCycle> {
  await assertPlanInProject(db, c.planId, projectId);
  const [cycle] = await db<TestCycle[]>`
    insert into test_cycle(project_id, plan_id, name, description, release, build, environment, start_date, end_date,
                           custom_fields, created_by, created_at)
    values (${projectId}, ${c.planId ?? null}, ${c.name}, ${c.description ?? null}, ${c.release ?? null}, ${c.build ?? null},
            ${c.environment ?? null}, ${c.startDate ?? null}, ${c.endDate ?? null}, ${db.json((c.customFields ?? {}) as never)},
            ${c.createdBy ?? actor}, ${c.createdAt ?? new Date()})
    returning *`;
  if (c.configuration && Object.keys(c.configuration).length) await setCycleConfiguration(db, cycle!.id, c.configuration);
  else await autoClassifyCycle(db, cycle!.id);
  await recordEvent(db, {
    type: EventTypes.TestCycleCreated, aggregateType: 'TestCycle', aggregateId: cycle!.id, actor,
    payload: { name: c.name, release: c.release ?? null },
  });
  return cycle!;
}

export async function updateCycle(db: Db, id: string, c: CycleInput, actor = 'system'): Promise<TestCycle> {
  const [cur] = await db<{ projectId: string; name: string; planId: string | null; description: string | null; release: string | null; build: string | null;
    environment: string | null; startDate: string | null; endDate: string | null; customFields: Record<string, unknown>; configuration: unknown }[]>`
    select project_id, name, plan_id, description, release, build, environment, start_date::text, end_date::text, custom_fields, configuration from test_cycle where id = ${id}`;
  if (!cur) throw notFound('Testzyklus', id);
  await assertPlanInProject(db, c.planId, cur.projectId);
  const { projectId: _p, configuration: cfgBefore, ...before } = cur;
  // auch das Verschieben in einen anderen Testplan (planId) und geänderte Zeiträume landen im Protokoll
  await recordChange(db, { type: EventTypes.CycleChanged, aggregateType: 'TestCycle', aggregateId: id, actor,
    before: { ...before, ...(c.configuration !== undefined ? { configuration: cfgBefore } : {}) },
    after: { name: c.name, planId: c.planId ?? null, description: c.description ?? null, release: c.release ?? null, build: c.build ?? null, environment: c.environment ?? null,
      startDate: c.startDate ?? null, endDate: c.endDate ?? null, customFields: c.customFields ?? {}, ...(c.configuration !== undefined ? { configuration: c.configuration } : {}) } });
  const [cycle] = await db<TestCycle[]>`
    update test_cycle set name = ${c.name}, plan_id = ${c.planId ?? null}, description = ${c.description ?? null},
      release = ${c.release ?? null}, build = ${c.build ?? null}, environment = ${c.environment ?? null},
      start_date = ${c.startDate ?? null}, end_date = ${c.endDate ?? null},
      custom_fields = ${db.json((c.customFields ?? {}) as never)}
    where id = ${id} returning *`;
  if (!cycle) throw notFound('Testzyklus', id);
  if (c.configuration !== undefined) await setCycleConfiguration(db, id, c.configuration);
  else await autoClassifyCycle(db, id);
  return cycle;
}

export async function listCycles(db: Db, projectId: string): Promise<CycleWithProgress[]> {
  const rows = await db<(TestCycle & { byStatus: Record<string, number> | null })[]>`
    select c.*, (select jsonb_object_agg(status, n) from (
              select status, count(*)::int as n from test_execution e where e.cycle_id = c.id group by status) s) as by_status
    from test_cycle c where c.project_id = ${projectId}
    order by c.start_date desc nulls last, c.name`;
  return rows.map((r) => {
    const byStatus = r.byStatus ?? {};
    return { ...r, byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0) };
  });
}

export async function getCycle(db: Db, id: string): Promise<TestCycle & { planName: string | null }> {
  const [c] = await db<(TestCycle & { planName: string | null })[]>`
    select c.*, p.name as plan_name from test_cycle c left join test_plan p on p.id = c.plan_id where c.id = ${id}`;
  if (!c) throw notFound('Testzyklus', id);
  return c;
}

// ---- Ausführungen ----

export async function addTestsToCycle(db: Db, cycleId: string, testCaseIds: string[], actor: string): Promise<{ added: number; skipped: string[]; warnings: string[] }> {
  const cycle = await getCycle(db, cycleId);
  if ((cycle as { state?: string }).state === 'closed') throw conflict('Der Zyklus ist abgeschlossen – keine Tests mehr aufnehmen.');
  let added = 0;
  const skipped: string[] = [];
  const unreviewed: string[] = [];
  for (const idOrKey of testCaseIds) {
    const tc = await getTestCase(db, idOrKey);
    // nur Testfälle desselben Projekts – keine Inhalte aus fremden (eingeschränkten) Projekten einplanen
    if (tc.projectId !== cycle.projectId) throw notFound('Testfall', idOrKey);
    // Workflow: veraltete Testfälle nicht mehr einplanen, Entwürfe/Review nur mit Hinweis
    const [st] = await db<{ category: string }[]>`select category from test_case_status where code = ${tc.status}`;
    if (st?.category === 'DEPRECATED' || tc.archivedAt) { skipped.push(tc.key); continue; }
    if (st?.category === 'DRAFT' || st?.category === 'REVIEW') unreviewed.push(tc.key);
    const r = await db`
      insert into test_execution(cycle_id, test_case_id, test_case_version_id, order_no, status)
      select ${cycleId}, ${tc.id}, ${tc.version.id},
             (select coalesce(max(order_no), 0) + 1 from test_execution where cycle_id = ${cycleId}), 'NOT_EXECUTED'
      where not exists (select 1 from test_execution where cycle_id = ${cycleId} and test_case_id = ${tc.id})`;
    if (r.count > 0) {
      added++;
      await recordEvent(db, {
        type: EventTypes.TestAddedToCycle, aggregateType: 'TestCycle', aggregateId: cycleId, actor,
        payload: { testCaseId: tc.id, key: tc.key, versionNo: tc.currentVersion },
      });
    }
  }
  const warnings = [
    ...(skipped.length ? [`${skipped.length} veraltete bzw. archivierte Testfälle nicht eingeplant: ${skipped.slice(0, 10).join(', ')}`] : []),
    ...(unreviewed.length ? [`${unreviewed.length} Testfälle sind noch nicht freigegeben (Entwurf/Review): ${unreviewed.slice(0, 10).join(', ')}`] : []),
  ];
  return { added, skipped, warnings };
}

/**
 * Rohes Anlegen bzw. Aktualisieren einer Ausführung mit allen Feldern (für die Migration).
 * Mit {@code id} wird genau dieser Datensatz aktualisiert, sonst ein neuer angelegt – wiederholte Ausführungen
 * desselben Tests im selben Zyklus bleiben so getrennt.
 */
export async function upsertExecution(db: Db, e: {
  id?: string | null | undefined;
  cycleId: string; testCaseId: string; testCaseVersionId: string; orderNo: number; status: string;
  assignee?: string | null; executedBy?: string | null; executedAt?: Date | null; comment?: string | null;
  stepResults?: StepResult[]; customFields?: Record<string, unknown>;
}): Promise<string> {
  if (e.id) {
    const updated = await db<{ id: string }[]>`
      update test_execution set cycle_id = ${e.cycleId}, test_case_id = ${e.testCaseId}, status = ${e.status},
        assignee = ${e.assignee ?? null}, executed_by = ${e.executedBy ?? null}, executed_at = ${e.executedAt ?? null},
        comment = ${e.comment ?? null}, step_results = ${db.json((e.stepResults ?? []) as never)},
        custom_fields = ${db.json((e.customFields ?? {}) as never)}, order_no = ${e.orderNo}, updated_at = now()
      where id = ${e.id} returning id`;
    if (updated[0]) return updated[0].id;
  }
  const [row] = await db<{ id: string }[]>`
    insert into test_execution(cycle_id, test_case_id, test_case_version_id, order_no, status, assignee, executed_by,
                               executed_at, comment, step_results, custom_fields)
    values (${e.cycleId}, ${e.testCaseId}, ${e.testCaseVersionId}, ${e.orderNo}, ${e.status}, ${e.assignee ?? null},
            ${e.executedBy ?? null}, ${e.executedAt ?? null}, ${e.comment ?? null},
            ${db.json((e.stepResults ?? []) as never)}, ${db.json((e.customFields ?? {}) as never)})
    returning id`;
  return row!.id;
}

export async function listExecutions(db: Db, cycleId: string): Promise<ExecutionListItem[]> {
  const rows = await db<Omit<ExecutionListItem, 'defects'>[]>`
    select e.*, tc.key as test_case_key, tc.legacy_key, v.title, v.version_no, tc.current_version
    from test_execution e
    join test_case tc on tc.id = e.test_case_id
    join test_case_version v on v.id = e.test_case_version_id
    where e.cycle_id = ${cycleId}
    order by e.order_no, tc.key`;
  const defects = await listReferencesForOwners(db, 'TEST_EXECUTION', rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, defects: defects.filter((d) => d.ownerId === r.id) }));
}

/** Datensatz-Überschreibungen (Zyklus, Testplan) für einen Testfall – Zyklus vor Plan vor Testfall. */
export async function datasetOverrides(db: Db, cycleId: string, testCaseId: string): Promise<{ cycle: Dataset | null; plan: Dataset | null; planId: string | null }> {
  const [c] = await db<{ planId: string | null }[]>`select plan_id from test_cycle where id = ${cycleId}`;
  const rows = await db<{ scope: 'plan' | 'cycle'; dataset: Dataset }[]>`select scope, dataset from dataset_override where test_case_id = ${testCaseId}
    and ((scope = 'cycle' and scope_id = ${cycleId}) or (scope = 'plan' and scope_id = ${c?.planId ?? null}::uuid))`;
  return { cycle: rows.find((r) => r.scope === 'cycle')?.dataset ?? null, plan: rows.find((r) => r.scope === 'plan')?.dataset ?? null, planId: c?.planId ?? null };
}

/** Datensatz für Zyklus bzw. Plan setzen (null = Überschreibung entfernen). Platzhalter der Schritte müssen als Spalten vorkommen. */
export async function setDatasetOverride(db: Db, o: { scope: 'plan' | 'cycle'; scopeId: string; testCaseId: string; dataset: Dataset | null }, actor: string) {
  const tc = await getTestCase(db, o.testCaseId);
  const [owner] = o.scope === 'cycle'
    ? await db<{ projectId: string; state: string }[]>`select project_id, state from test_cycle where id = ${o.scopeId}`
    : await db<{ projectId: string; state: string }[]>`select project_id, 'active' as state from test_plan where id = ${o.scopeId}`;
  if (!owner || owner.projectId !== tc.projectId) throw notFound(o.scope === 'cycle' ? 'Testzyklus' : 'Testplan', o.scopeId);
  if (owner.state === 'closed') throw conflict('Der Zyklus ist abgeschlossen.');
  if (!o.dataset) {
    await db`delete from dataset_override where scope = ${o.scope} and scope_id = ${o.scopeId} and test_case_id = ${tc.id}`;
    return { removed: true };
  }
  const text = [...(await resolveExecutionSteps(db, tc.version)).flatMap((s) => [s.action, s.data, s.expected])].join('\n');
  const used = [...new Set([...text.matchAll(/\$\{([^}]+)\}|<([^<>\s]+)>/g)].map((m) => (m[1] ?? m[2])!.trim()))];
  const missing = used.filter((u) => !o.dataset!.columns.includes(u) && (tc.version.dataset?.columns.includes(u) || effectiveDataset(tc.version)?.columns.includes(u)));
  if (missing.length) throw badRequest(`Spalten fehlen, die in den Schritten verwendet werden: ${missing.join(', ')}`);
  await db`insert into dataset_override(scope, scope_id, test_case_id, dataset, updated_by) values (${o.scope}, ${o.scopeId}, ${tc.id}, ${db.json(o.dataset as never)}, ${actor})
    on conflict (scope, scope_id, test_case_id) do update set dataset = excluded.dataset, updated_by = excluded.updated_by, updated_at = now()`;
  return { removed: false };
}

export async function getExecution(db: Db, id: string) {
  const [e] = await db<TestExecution[]>`select * from test_execution where id = ${id}`;
  if (!e) throw notFound('Ausführung', id);
  const version = await getVersionById(db, e.testCaseVersionId);
  const tc = await getTestCase(db, e.testCaseId);
  const defects = await listReferencesForOwners(db, 'TEST_EXECUTION', [id]);
  return {
    ...e,
    testCase: { id: tc.id, key: tc.key, legacyKey: tc.legacyKey, currentVersion: tc.currentVersion },
    version,
    steps: (await resolveExecutionSteps(db, version)) as Step[],
    preconditions: await preconditionsByIds(db, version.preconditionIds ?? [], (e as { pinnedRefs?: { preconditions?: Record<string, number> } | null }).pinnedRefs?.preconditions),
    ...await (async () => {
      const ov = await datasetOverrides(db, e.cycleId, e.testCaseId);
      const own = effectiveDataset(version);
      return ov.cycle ? { dataset: ov.cycle, datasetSource: 'cycle' as const }
        : ov.plan ? { dataset: ov.plan, datasetSource: 'plan' as const }
          : { dataset: own, datasetSource: own ? 'testcase' as const : null };
    })(),
    defects,
  };
}

async function isAgent(db: Db, username: string): Promise<boolean> {
  const [u] = await db<{ isAgent: boolean }[]>`select is_agent from app_user where username = ${username}`;
  return !!u?.isAgent;
}

export interface ExecuteInput {
  status: string;
  comment?: string | null | undefined;
  stepResults?: StepResult[] | undefined;
  defects?: { provider: string; key: string; url?: string | null | undefined; title?: string | null | undefined; stepId?: string | null | undefined; severity?: Severity | null | undefined }[] | undefined;
  /** Optimistische Sperre: Stand, auf dem die Eingabe beruht */
  expectedUpdatedAt?: string | undefined;
  /** Begründung, wenn das Gesamtergebnis bewusst von der Ableitung abweicht */
  overrideReason?: string | null | undefined;
  /** Parametrisierter Test: Ergebnis je Datenzeile (Index in den Datensatz) */
  iterations?: { index: number; status: string; comment?: string | null | undefined; stepResults?: StepResult[] | undefined }[] | undefined;
  /** Aktive Bearbeitungszeit seit dem letzten Speichern (Sekunden) */
  durationSeconds?: number | undefined;
  /** Vermerk in der Ergebnis-Historie, z. B. „Wiederholung: …“ (zählt in Test-Health als wackelnd) */
  note?: string | undefined;
}

/**
 * Projektregel „Ausführung nur durch Zuständige“: Ergebnisse zugewiesener Ausführungen darf nur die zuständige Person
 * erfassen; nicht zugewiesene Ausführungen bleiben für alle mit Recht „Ausführen“ offen. Die Testleitung (Pflegen) ist
 * ausgenommen.
 */
export async function assertMayRecord(db: Db, executionIds: string[], actor: string, isLead: boolean): Promise<void> {
  if (isLead || !executionIds.length) return;
  const foreign = await db<{ key: string; assignee: string }[]>`
    select tc.key, e.assignee from test_execution e join test_cycle c on c.id = e.cycle_id join project p on p.id = c.project_id
    join test_case tc on tc.id = e.test_case_id
    where e.id = any(${executionIds}::uuid[]) and p.execute_only_assignee and e.assignee is not null and e.assignee <> ${actor}
    order by tc.key limit 5`;
  if (foreign.length) {
    throw new HttpError(403, `In diesem Projekt erfasst nur die zuständige Person Ergebnisse: ${foreign.map((f) => `${f.key} (${f.assignee})`).join(', ')}`);
  }
}

/**
 * Zuweisen unter der Projektregel „Ausführung nur durch Zuständige“ (Review Teil 3, Befund 3): Neu- und Umzuweisen
 * ist Aufgabe der Testleitung (Pflegen). Wer nur „Ausführen“ hat, darf nicht zugewiesene Ausführungen sich selbst
 * zuweisen („Übernehmen“, wie `claim`) und eigene Zuweisungen zurückgeben – sonst ließe sich die Regel durch
 * Selbstzuweisung fremder Ausführungen umgehen. Ohne Projektregel bleibt Zuweisen für alle mit „Ausführen“ offen.
 */
export async function assertMayAssign(db: Db, executionIds: string[], assignee: string | null, actor: string, isLead: boolean): Promise<void> {
  if (isLead || !executionIds.length) return;
  const rows = await db<{ key: string; assignee: string | null }[]>`
    select tc.key, e.assignee from test_execution e join test_cycle c on c.id = e.cycle_id join project p on p.id = c.project_id
    join test_case tc on tc.id = e.test_case_id
    where e.id = any(${executionIds}::uuid[]) and p.execute_only_assignee order by tc.key`;
  const own = assignee === null || assignee === actor;
  const denied = rows.filter((r) => !own || (r.assignee !== null && r.assignee !== actor));
  if (denied.length) {
    throw new HttpError(403, own
      ? `In diesem Projekt weist nur die Testleitung zu – übernehmen lassen sich nur nicht zugewiesene Ausführungen: ${denied.slice(0, 5).map((f) => `${f.key} (${f.assignee})`).join(', ')}`
      : 'In diesem Projekt weist nur die Testleitung (Recht „Pflegen“) Ausführungen anderen Personen zu.');
  }
}

/** Ausführungen, die (bei aktiver Projektregel) einer anderen Person zugewiesen sind – ID → zuständige Person. */
export async function foreignAssigned(db: Db, executionIds: string[], actor: string): Promise<Map<string, string>> {
  if (!executionIds.length) return new Map();
  const rows = await db<{ id: string; assignee: string }[]>`
    select e.id, e.assignee from test_execution e join test_cycle c on c.id = e.cycle_id join project p on p.id = c.project_id
    where e.id = any(${executionIds}::uuid[]) and p.execute_only_assignee and e.assignee is not null and e.assignee <> ${actor}`;
  return new Map(rows.map((r) => [r.id, r.assignee]));
}

/**
 * Teilschritt in einem Savepoint der laufenden Transaktion (postgres.js `savepoint`): Schlägt er fehl – auch mit einem
 * Datenbankfehler –, wird nur er zurückgerollt und die Transaktion bleibt nutzbar. Rohe `savepoint`-Befehle genügen
 * nicht, weil postgres.js jeden fehlgeschlagenen Befehl einer Transaktion am Ende erneut wirft. Ohne Transaktion
 * (kein `savepoint` vorhanden) läuft `fn` direkt.
 */
export async function withSavepoint<T>(db: Db, fn: (sp: Db) => Promise<T>): Promise<T> {
  const sp = (db as unknown as { savepoint?: (f: (s: unknown) => Promise<T>) => Promise<T> }).savepoint;
  return typeof sp === 'function' ? sp.call(db, (s) => fn(s as Db)) : fn(db);
}

/** Gruppen für den Abgleich Gesamtergebnis ↔ Teilergebnisse: „bestanden“ und „bestanden mit Einschränkung“ sind verträglich. */
/** „Fehlgeschlagen (bekannt)“ ist mit „fehlgeschlagen“ verträglich: Teilergebnisse dürfen unerwartet scheitern, das Gesamtergebnis dokumentiert den bekannten Fehler. */
const verdictGroup = (cat: string | undefined) => (cat === 'PASSED_WITH_ISSUES' ? 'PASSED' : cat === 'KNOWN_FAILURE' ? 'FAILED' : isOpen(cat) ? 'OPEN' : cat!);

export async function executeTest(db: Db, id: string, input: ExecuteInput, actor: string, opts: { requireEvidence?: boolean; mayOverrideReview?: boolean } = {}) {
  const [status] = await db<ExecutionStatus[]>`select * from execution_status where code = ${input.status}`;
  if (!status) throw badRequest(`Unbekannter Ausführungsstatus: ${input.status}`);
  // Sperre gegen gleichzeitiges Speichern derselben Ausführung (Tester/Agent/zweites Fenster)
  const [locked] = await db<{ updatedAt: Date; state: string }[]>`
    select e.updated_at, c.state from test_execution e join test_cycle c on c.id = e.cycle_id where e.id = ${id} for update of e`;
  if (!locked) throw notFound('Ausführung', id);
  if (locked.state === 'closed') throw conflict('Der Zyklus ist abgeschlossen – Ergebnisse sind gesperrt. Zum Ändern den Zyklus wieder öffnen.');
  if (input.expectedUpdatedAt && new Date(input.expectedUpdatedAt).getTime() !== new Date(locked.updatedAt).getTime()) {
    throw conflict('Die Ausführung wurde zwischenzeitlich von jemand anderem gespeichert – bitte neu laden.');
  }
  const current = await getExecution(db, id);
  // Neu gesetzte Status müssen aktiv und für den Zweck zugelassen sein; bestehende Werte bleiben gültig
  if (input.status !== current.status && (!status.active || status.appliesTo === 'step')) {
    throw badRequest(`Status „${status.name}“ ist für Ausführungen nicht (mehr) zugelassen`);
  }
  const statuses = new Map((await db<ExecutionStatus[]>`select * from execution_status`).map((x) => [x.code, x]));
  const categoryOf = (c: string) => statuses.get(c)?.category;
  const usableForExecution = (c: string) => statuses.get(c)?.appliesTo !== 'step';
  const checkStep = (code: string, previous: string | undefined) => {
    const st = statuses.get(code);
    if (!st) throw badRequest(`Unbekannter Schrittstatus: ${code}`);
    if (previous !== code && (!st.active || st.appliesTo === 'execution')) throw badRequest(`Status „${st.name}“ ist für Schritte nicht (mehr) zugelassen`);
  };
  // Abschnitte (J1) haben kein Ergebnis: Eingaben dazu werden ignoriert, Alt-Ergebnisse (aus Zephyr) bleiben unverändert
  const groupIds = new Set(current.steps.filter(isGroup).map((s) => s.id));
  // „vor Umstellung“ (J2) bleibt sichtbar, bis der Schritt neu bewertet ist; Eingaben dazu zählen nicht
  const withPrevious = (r: StepResult, prev: StepResult[]): StepResult => {
    const { previous: _p, ...rest } = r;
    const before = prev.find((x) => x.stepId === r.stepId)?.previous;
    return before && r.status === 'NOT_EXECUTED' ? { ...rest, previous: before } : rest;
  };
  const keepGroupResults = (rs: StepResult[] | undefined, prev: StepResult[]) => rs && [
    ...rs.filter((r) => !groupIds.has(r.stepId)).map((r) => withPrevious(r, prev)), ...prev.filter((r) => groupIds.has(r.stepId)),
  ];
  input = {
    ...input,
    stepResults: keepGroupResults(input.stepResults, current.stepResults) as StepResult[] | undefined,
    iterations: input.iterations?.map((it) => ({ ...it, stepResults: keepGroupResults(it.stepResults, current.iterations.find((i) => i.index === it.index)?.stepResults ?? []) as typeof it.stepResults })),
  };
  const before = new Map(current.stepResults.map((r) => [r.stepId, r.status]));
  for (const r of input.stepResults ?? []) if (!groupIds.has(r.stepId)) checkStep(r.status, before.get(r.stepId));
  const stepIds = new Set(current.steps.map((s) => s.id));
  for (const r of [...(input.stepResults ?? []), ...(input.iterations ?? []).flatMap((i) => i.stepResults ?? [])]) {
    if (!stepIds.has(r.stepId)) throw badRequest(`Schritt ${r.stepId} gehört nicht zur Version v${current.version.versionNo}`);
  }
  // Fehlerverweise vor jedem Schreibzugriff prüfen (Schritt der Version, gültiger Schweregrad) – auch für Aufrufer ohne Route
  for (const d of input.defects ?? []) {
    if (d.stepId && !stepIds.has(d.stepId)) throw badRequest(`Schritt ${d.stepId} gehört nicht zur Version v${current.version.versionNo}`);
    if (d.severity && !(SEVERITIES as readonly string[]).includes(d.severity)) throw badRequest(`Unbekannter Schweregrad: ${d.severity}`);
    if (d.provider === 'url') checkUrlLink(d.key, d.title);
  }
  // Durchläufe: nur gültige Datenzeilen, je Zeile höchstens einmal, zugelassene Status; Werte aus dem Datensatz
  let iterations: Iteration[] | null = null;
  if (input.iterations) {
    const ds = current.dataset;
    if (!ds) throw badRequest('Dieser Testfall hat keinen Datensatz – Durchläufe nicht möglich');
    const seen = new Set<number>();
    const prevIter = new Map(current.iterations.map((i) => [i.index, i]));
    iterations = input.iterations.map((it) => {
      if (!Number.isInteger(it.index) || it.index < 0 || it.index >= ds.rows.length || seen.has(it.index)) throw badRequest(`Ungültiger Durchlauf ${it.index + 1}`);
      seen.add(it.index);
      const st = statuses.get(it.status);
      if (!st) throw badRequest(`Unbekannter Status im Durchlauf ${it.index + 1}: ${it.status}`);
      if (prevIter.get(it.index)?.status !== it.status && (!st.active || st.appliesTo === 'step')) throw badRequest(`Status „${st.name}“ ist für Durchläufe nicht (mehr) zugelassen`);
      const prevSteps = new Map((prevIter.get(it.index)?.stepResults ?? []).map((r) => [r.stepId, r.status]));
      for (const r of it.stepResults ?? []) checkStep(r.status, prevSteps.get(r.stepId));
      return {
        index: it.index, values: Object.fromEntries(ds.columns.map((c, k) => [c, ds.rows[it.index]![k] ?? ''])),
        status: it.status, comment: it.comment ?? null, stepResults: it.stepResults ?? [],
      };
    }).sort((a, b) => a.index - b.index);
    // Gesamtergebnis muss zu den Durchläufen passen (schlechtestes zählt) – Abweichung nur mit Begründung
    const all = ds.rows.map((_, k) => iterations!.find((i) => i.index === k)?.status ?? 'NOT_EXECUTED');
    const derived = deriveOverall(all, categoryOf, usableForExecution);
    if (derived !== input.status && !input.overrideReason?.trim()) {
      throw badRequest(`Gesamtergebnis passt nicht zu den Durchläufen (abgeleitet: ${statuses.get(derived)?.name ?? derived}) – bitte begründen`);
    }
  } else if (!input.overrideReason?.trim() && ['PASSED', 'PASSED_WITH_ISSUES', 'KNOWN_FAILURE', 'FAILED', 'BLOCKED'].includes(status.category)) {
    // Review Teil 3, Befund 5/6: Ein abschließendes Gesamtergebnis darf den vorhandenen Teilergebnissen nicht widersprechen –
    // bei parametrisierten Tests den bisherigen Durchläufen, sonst den Schrittergebnissen. Abweichung nur mit Begründung.
    // Offene/in Arbeit befindliche Gesamtstatus (Zwischenspeichern) und „ungültig“ sind keine Aussage über das Ergebnis.
    const ds = current.dataset;
    let parts: string[] = [];
    let what = '';
    if (ds?.rows.length && current.iterations.length) {
      parts = ds.rows.map((_, k) => current.iterations.find((i) => i.index === k)?.status ?? 'NOT_EXECUTED');
      what = 'Durchläufen';
    } else {
      const given = (input.stepResults ?? current.stepResults).filter((r) => stepIds.has(r.stepId));
      if (given.length) parts = checkSteps(current.steps).map((s) => given.find((r) => r.stepId === s.id)?.status ?? 'NOT_EXECUTED');
      what = 'Schrittergebnissen';
    }
    if (parts.some((c) => !isOpen(categoryOf(c)))) {
      const derived = deriveOverall(parts, categoryOf, usableForExecution);
      if (verdictGroup(categoryOf(derived)) !== verdictGroup(status.category)) {
        throw badRequest(`Gesamtergebnis „${status.name}“ passt nicht zu den ${what} (abgeleitet: ${statuses.get(derived)?.name ?? derived}) – Teilergebnisse anpassen oder die Abweichung begründen`);
      }
    }
  }
  // Nachweis bei Fehlschlag/Blockade: Befund (Ausführung, Schritt oder Durchlauf) oder Fehlerverweis. „Fehlgeschlagen
  // (bekannt)“ braucht ihn immer – sonst wäre der Status ein bequemes Versteck für unerwartete Fehler.
  const known = status.category === 'KNOWN_FAILURE';
  if (((opts.requireEvidence && ['FAILED', 'BLOCKED'].includes(status.category)) || known) && input.status !== current.status) {
    const texts = [input.comment, ...(input.stepResults ?? []).map((r) => r.comment), ...(iterations ?? []).flatMap((i) => [i.comment, ...i.stepResults.map((r) => r.comment)])];
    const hasText = texts.some((t) => t && t.replace(/\s+/g, '').length >= 3);
    if (!hasText && !(input.defects?.length) && !current.defects.length) {
      throw badRequest(known ? `${status.name} braucht einen Verweis auf den bekannten Fehler: Ticket verknüpfen oder Befund angeben`
        : status.category === 'FAILED'
        ? 'Fehlgeschlagen braucht einen Nachweis: tatsächliches Ergebnis (Befund) oder einen verknüpften Fehler'
        : 'Blockiert braucht einen Grund (Befund) oder einen verknüpften Fehler');
    }
  }
  const agent = input.status !== 'NOT_EXECUTED' && (await isAgent(db, actor));
  const reviewState = (current as { reviewState?: string | null }).reviewState;
  // Ein ungeprüftes Agentenergebnis ersetzt nur, wer es auch prüfen darf (Rolle „Pflegen“, ADR-0024) – sonst würde
  // erneutes Speichern durch einen Tester die KI-Ergebnisprüfung umgehen
  if (!agent && (reviewState === 'pending' || reviewState === 'escalated') && opts.mayOverrideReview === false) {
    throw new HttpError(403, 'Ergebnis eines KI-Agenten wartet auf Prüfung – bestätigen, ablehnen oder ersetzen darf nur die Testleitung (Rolle „Pflegen“).');
  }
  // ---- ab hier nur noch Schreibzugriffe (alle Prüfungen liegen davor) ----
  const spent = Math.max(0, Math.min(86_400, Math.round(input.durationSeconds ?? 0)));
  const executed = input.status !== 'NOT_EXECUTED';
  const statusChanged = input.status !== current.status || !current.executedAt;
  // Ein Mensch überschreibt ein noch nicht freigegebenes Agentenergebnis – nachvollziehbar festhalten
  if (!agent && (reviewState === 'pending' || reviewState === 'escalated')) {
    await recordEvent(db, { type: EventTypes.ResultReviewed, aggregateType: 'TestExecution', aggregateId: id, actor,
      payload: { decision: 'overridden', previousStatus: current.status, status: input.status, key: current.testCase.key } });
  }
  const newSteps = input.stepResults ?? current.stepResults;
  const newIterations = iterations ?? current.iterations;
  await db`
    update test_execution set status = ${input.status}, comment = ${input.comment ?? null},
      step_results = ${db.json(newSteps as never)},
      iterations = ${db.json(newIterations as never)},
      started_at = coalesce(started_at, now() - make_interval(secs => ${spent})), duration_seconds = duration_seconds + ${spent},
      -- „ausgeführt am/von“ nur bei geändertem Ergebnis – eine Kommentarkorrektur verschiebt den Stand nicht
      executed_by = ${executed ? (statusChanged ? actor : current.executedBy ?? actor) : null},
      executed_at = ${executed ? (statusChanged ? new Date() : current.executedAt ?? new Date()) : null}, updated_at = now(),
      -- Ergebnisse von KI-Agenten brauchen eine QA-Freigabe (ADR-0024); ein Mensch ersetzt sie durch sein eigenes
      review_state = ${agent ? 'pending' : null}, reviewed_by = null, reviewed_at = null, review_note = null
    where id = ${id}`;
  // Ergebnis-Historie (revisionssicher): jedes Speichern mit Stand und ggf. Begründung
  await db`insert into execution_result(execution_id, status, comment, step_results, iterations, recorded_by, note)
    values (${id}, ${input.status}, ${input.comment ?? null}, ${db.json(newSteps as never)}, ${db.json(newIterations as never)}, ${actor}, ${[input.overrideReason?.trim(), input.note?.trim()].filter(Boolean).join(' · ') || null})`;
  for (const d of input.defects ?? []) {
    const ref = { ownerType: 'TEST_EXECUTION' as const, ownerId: id, provider: d.provider, externalKey: d.key, relation: 'DEFECT' as const,
      url: d.url ?? null, title: d.title ?? null, stepId: d.stepId ?? null, severity: (d.severity ?? null) as Severity | null };
    await linkReference(db, clientReference(ref), actor);
  }
  const payload = {
    testCaseId: current.testCaseId, key: current.testCase.key, versionNo: current.version.versionNo,
    cycleId: current.cycleId, status: input.status, previousStatus: current.status,
  };
  await recordEvent(db, { type: EventTypes.TestExecuted, aggregateType: 'TestExecution', aggregateId: id, actor, payload });
  if (status.category === 'FAILED' && statusChanged) {
    await recordEvent(db, { type: EventTypes.TestFailed, aggregateType: 'TestExecution', aggregateId: id, actor, payload });
  }
  return getExecution(db, id);
}

/** Ergebnis-Historie einer Ausführung (neueste zuerst). */
export async function resultHistory(db: Db, id: string) {
  return db<{ id: string; status: string; comment: string | null; recordedBy: string; recordedAt: Date; note: string | null }[]>`
    select id, status, comment, recorded_by, recorded_at, note from execution_result where execution_id = ${id} order by id desc limit 100`;
}

// ---------------------------------------------------------------------------------------------
// Stufe J2: laufende Ausführung auf die aktuelle Testfallfassung umstellen
// ---------------------------------------------------------------------------------------------

/** Inhalt eines Schritts zum Vergleich zweier Fassungen (Schritt-ID ist über Versionen stabil). */
const stepSignature = (s: Step) => JSON.stringify([(s as { kind?: string | null }).kind ?? null, (s as { title?: string | null }).title ?? null,
  s.action, s.data ?? '', s.expected ?? '', s.call?.testCaseId ?? null, s.call?.versionNo ?? null]);
const hasResult = (r: StepResult | undefined) => !!r && (r.status !== 'NOT_EXECUTED' || !!r.comment?.trim());
const stepLabel = (s: Step) => (isGroup(s) ? `Abschnitt „${groupTitle(s)}“` : plainTitle(s.action) || '(ohne Text)').slice(0, 120);

export interface VersionUpdatePlan {
  from: number; to: number; upToDate: boolean; canUpdate: boolean; reason: string | null;
  added: { no: number | null; text: string }[];
  changed: { no: number | null; text: string; hadResult: boolean }[];
  removed: { no: number | null; text: string; hadResult: boolean }[];
  moved: number;
  results: { kept: number; reset: number; dropped: number };
  preconditions: { key: string; from: number; to: number }[];
  datasetChanged: boolean;
}

/** Umstellung nur für offene bzw. begonnene Ausführungen in nicht abgeschlossenen Zyklen. */
async function updateBlocker(db: Db, e: { status: string; cycleId: string }): Promise<string | null> {
  const [st] = await db<{ category: string; name: string }[]>`select category, name from execution_status where code = ${e.status}`;
  const [c] = await db<{ state: string; archivedAt: Date | null }[]>`select state, archived_at from test_cycle where id = ${e.cycleId}`;
  if (c?.state === 'closed' || c?.archivedAt) return 'Der Zyklus ist abgeschlossen bzw. archiviert.';
  if (st && !['OPEN', 'IN_PROGRESS'].includes(st.category)) return `Ergebnis „${st.name}“ ist abgeschlossen – bitte erneut einplanen statt umstellen.`;
  return null;
}

async function buildUpdatePlan(db: Db, id: string) {
  const e = await getExecution(db, id);
  const tc = await getTestCase(db, e.testCaseId);
  const oldSteps = e.steps;
  const newSteps = (await resolveExecutionSteps(db, tc.version)) as Step[];
  const oldById = new Map(oldSteps.map((s) => [s.id!, s]));
  const newById = new Map(newSteps.map((s) => [s.id!, s]));
  const oldNo = stepNumbers(oldSteps);
  const newNo = stepNumbers(newSteps);
  const results = new Map(e.stepResults.map((r) => [r.stepId, r]));
  const iterResults = e.iterations.flatMap((i) => i.stepResults);
  const anyResult = (sid: string) => hasResult(results.get(sid)) || iterResults.some((r) => r.stepId === sid && hasResult(r));
  const plan: VersionUpdatePlan = {
    from: e.version.versionNo, to: tc.currentVersion, upToDate: e.version.versionNo === tc.currentVersion, canUpdate: true, reason: null,
    added: [], changed: [], removed: [], moved: 0, results: { kept: 0, reset: 0, dropped: 0 }, preconditions: [], datasetChanged: false,
  };
  newSteps.forEach((s, i) => {
    const o = oldById.get(s.id!);
    if (!o) plan.added.push({ no: newNo[i] ?? null, text: stepLabel(s) });
    else if (stepSignature(o) !== stepSignature(s)) plan.changed.push({ no: newNo[i] ?? null, text: stepLabel(s), hadResult: !isGroup(s) && anyResult(s.id!) });
  });
  oldSteps.forEach((s, i) => { if (!newById.has(s.id!)) plan.removed.push({ no: oldNo[i] ?? null, text: stepLabel(s), hadResult: anyResult(s.id!) }); });
  const common = newSteps.map((s) => s.id!).filter((sid) => oldById.has(sid));
  const oldOrder = oldSteps.map((s) => s.id!).filter((sid) => newById.has(sid));
  plan.moved = common.filter((sid, k) => oldOrder[k] !== sid).length;
  const classify = (r: StepResult) => {
    if (!hasResult(r)) return 'none';
    const o = oldById.get(r.stepId);
    const n = newById.get(r.stepId);
    if (!n) return 'dropped';
    if (isGroup(n)) return 'kept'; // Alt-Ergebnis auf (früherem) Trennschritt bleibt zur Information
    return o && stepSignature(o) === stepSignature(n) ? 'kept' : 'reset';
  };
  for (const r of e.stepResults) {
    const c = classify(r);
    if (c !== 'none') plan.results[c as 'kept' | 'reset' | 'dropped']++;
  }
  plan.datasetChanged = JSON.stringify(effectiveDataset(e.version) ?? null) !== JSON.stringify(effectiveDataset(tc.version) ?? null);
  for (const r of iterResults) {
    // geänderter Datensatz: Durchläufe entfallen ganz (bleiben in der Historie)
    const c = plan.datasetChanged && hasResult(r) ? 'dropped' : classify(r);
    if (c !== 'none') plan.results[c as 'kept' | 'reset' | 'dropped']++;
  }
  const nowPre = await preconditionsByIds(db, tc.version.preconditionIds ?? []);
  for (const p of nowPre) {
    const before = e.preconditions.find((x) => x.id === p.id);
    if (!before || before.versionNo !== p.versionNo) plan.preconditions.push({ key: p.key, from: before?.versionNo ?? 0, to: p.versionNo });
  }
  const blocker = plan.upToDate ? null : await updateBlocker(db, e);
  if (blocker) { plan.canUpdate = false; plan.reason = blocker; }
  return { plan, e, tc, newById, oldById, classify };
}

/** Vorschau: was sich durch die Umstellung ändert (Schritte, Ergebnisse, Vorbedingungen, Datensatz). */
export async function versionUpdatePlan(db: Db, id: string): Promise<VersionUpdatePlan> {
  return (await buildUpdatePlan(db, id)).plan;
}

/**
 * Ausführung auf die aktuelle Testfallfassung umstellen (auch begonnene): Ergebnisse unveränderter Schritte bleiben,
 * geänderte Schritte werden wieder offen (bisheriges Ergebnis als `previous` sichtbar), entfernte entfallen. Der Stand vor
 * der Umstellung bleibt in der Ergebnis-Historie.
 */
export async function updateExecutionToCurrentVersion(db: Db, id: string, actor = 'system') {
  const { plan, execution } = await applyVersionUpdate(db, id, actor);
  if (!execution) throw badRequest(plan.reason ?? 'Umstellung nicht möglich');
  return execution;
}

/** Umstellung samt Plan (für die Sammelumstellung). Aufruf in einer Transaktion: die Zeile wird zuerst gesperrt. */
async function applyVersionUpdate(db: Db, id: string, actor: string) {
  // gleichzeitiges Speichern eines Ergebnisses (executeTest sperrt ebenso) darf nicht mit einem veralteten Stand überschrieben werden
  const [locked] = await db`select 1 from test_execution where id = ${id} for update`;
  if (!locked) throw notFound('Ausführung', id);
  const { plan, e, tc, classify } = await buildUpdatePlan(db, id);
  if (plan.upToDate || !plan.canUpdate) return { plan, execution: plan.upToDate ? await getExecution(db, id) : null };
  const map = (rs: StepResult[]) => rs.flatMap((r): StepResult[] => {
    const c = classify(r);
    if (c === 'none' || c === 'dropped') return [];
    if (c === 'kept') return [r];
    return [{ stepId: r.stepId, status: 'NOT_EXECUTED', previous: { status: r.status, comment: r.comment ?? null, versionNo: plan.from } }];
  });
  const stepResults = map(e.stepResults);
  // Datensatz geändert: Durchläufe passen nicht mehr zu den Zeilen – sie bleiben nur in der Historie
  // Durchlauf mit zurückgesetzten oder entfallenen Schritten ist nicht mehr abgeschlossen: wieder in Arbeit bzw. offen
  const iterations = plan.datasetChanged ? [] : e.iterations.map((i) => {
    const stepResults = map(i.stepResults);
    const touched = i.stepResults.some((r) => { const c = classify(r); return c === 'reset' || c === 'dropped'; });
    if (!touched) return { ...i, stepResults };
    return { ...i, stepResults, status: stepResults.some(hasResult) ? 'WIP' : 'NOT_EXECUTED' };
  });
  if (e.stepResults.some(hasResult) || e.iterations.length) {
    await db`insert into execution_result(execution_id, status, comment, step_results, iterations, recorded_by, note)
      values (${id}, ${e.status}, ${e.comment}, ${db.json(e.stepResults as never)}, ${db.json(e.iterations as never)}, ${actor},
        ${`Stand vor Umstellung v${plan.from} → v${plan.to}`})`;
  }
  await db`update test_execution set test_case_version_id = ${tc.version.id}, step_results = ${db.json(stepResults as never)},
    iterations = ${db.json(iterations as never)}, updated_at = now() where id = ${id}`;
  return { plan, execution: await getExecution(db, id) };
}

/** Sammelumstellung: veraltete, offene bzw. begonnene Ausführungen eines Zyklus (optional nur die genannten). */
export async function updateCycleToCurrentVersions(db: Db, cycleId: string, o: { executionIds?: string[] | undefined; dryRun?: boolean | undefined }, actor: string) {
  const rows = await db<{ id: string; key: string }[]>`
    select e.id, tc.key from test_execution e join test_case tc on tc.id = e.test_case_id join test_case_version v on v.id = e.test_case_version_id
    where e.cycle_id = ${cycleId} and v.version_no <> tc.current_version ${o.executionIds?.length ? db`and e.id = any(${o.executionIds}::uuid[])` : db``}
    order by e.order_no`;
  const out = { updated: 0, resultsReset: 0, resultsDropped: 0, skipped: [] as { key: string; reason: string }[] };
  for (const r of rows) {
    const p = o.dryRun ? await versionUpdatePlan(db, r.id) : (await applyVersionUpdate(db, r.id, actor)).plan;
    if (!p.canUpdate) { out.skipped.push({ key: r.key, reason: p.reason ?? '' }); continue; }
    if (p.upToDate) continue;
    out.updated++; out.resultsReset += p.results.reset; out.resultsDropped += p.results.dropped;
  }
  return out;
}

/** Laufende Ausführungen (offen/begonnen, Zyklus offen) auf älteren Fassungen eines Testfalls – für den Hinweis im Editor. */
export async function executionsOnOlderVersions(db: Db, testCaseId: string) {
  const rows = await db<{ versionNo: number; n: number }[]>`
    select v.version_no, count(*)::int as n from test_execution e
    join test_case tc on tc.id = e.test_case_id join test_case_version v on v.id = e.test_case_version_id
    join test_cycle c on c.id = e.cycle_id join execution_status s on s.code = e.status
    where e.test_case_id = ${testCaseId} and v.version_no <> tc.current_version and c.state <> 'closed' and c.archived_at is null
      and s.category in ('OPEN', 'IN_PROGRESS')
    group by v.version_no order by v.version_no`;
  return { total: rows.reduce((a, r) => a + r.n, 0), byVersion: rows };
}

/** Alle Ausführungen eines Testfalls über alle Zyklen (neueste zuerst). */
export async function executionHistory(db: Db, testCaseId: string) {
  return db<{ id: string; cycleId: string; cycleName: string; release: string | null; status: string; versionNo: number;
    executedBy: string | null; executedAt: Date | null; comment: string | null }[]>`
    select e.id, e.cycle_id, c.name as cycle_name, c.release, e.status, v.version_no, e.executed_by, e.executed_at, e.comment
    from test_execution e
    join test_cycle c on c.id = e.cycle_id
    join test_case_version v on v.id = e.test_case_version_id
    where e.test_case_id = ${testCaseId}
    order by e.executed_at desc nulls last, c.created_at desc`;
}

export async function removeExecution(db: Db, id: string): Promise<void> {
  const r = await db`delete from test_execution where id = ${id} and status = 'NOT_EXECUTED'`;
  if (r.count === 0) throw badRequest('Nur nicht ausgeführte Einträge können entfernt werden (Nachvollziehbarkeit).');
}

// ---- Abfragen für große Datenmengen (Planung & Ausführung) ----

export interface PlanWithStats extends TestPlan {
  cycleCount: number;
  total: number;
  byStatus: Record<string, number>;
  firstDate: Date | null;
  lastDate: Date | null;
}

/** Testpläne mit Kennzahlen; neueste (nach letztem Zyklusdatum) zuerst. */
export async function listPlansWithStats(db: Db, projectId: string): Promise<PlanWithStats[]> {
  const rows = await db<(PlanWithStats & { byStatus: Record<string, number> | null })[]>`
    select p.*,
      (select count(*)::int from test_cycle c where c.plan_id = p.id) as cycle_count,
      (select min(c.start_date) from test_cycle c where c.plan_id = p.id) as first_date,
      -- Aktivität: geplantes Zyklusende oder (wenn Zyklen undatiert sind) die letzte tatsächliche Ausführung
      greatest((select max(coalesce(c.end_date, c.start_date)) from test_cycle c where c.plan_id = p.id),
               (select max(e.executed_at)::date from test_execution e join test_cycle c on c.id = e.cycle_id where c.plan_id = p.id)) as last_date,
      (select jsonb_object_agg(status, n) from (
         select e.status, count(*)::int as n from test_execution e join test_cycle c on c.id = e.cycle_id
         where c.plan_id = p.id group by e.status) s) as by_status
    from test_plan p where p.project_id = ${projectId}
    order by last_date desc nulls last, p.name desc`;
  return rows.map((r) => {
    const byStatus = r.byStatus ?? {};
    return { ...r, byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0) };
  });
}

export interface CycleQuery {
  projectId: string;
  planId?: string | undefined;
  /** "none" = Zyklen ohne Testplan */
  noPlan?: boolean | undefined;
  q?: string | undefined;
  environment?: string | undefined;
  build?: string | undefined;
  /** open = noch nicht ausgeführte Einträge; failed = mind. ein FAIL/BLOCKED; done = alles ausgeführt */
  state?: 'open' | 'failed' | 'done' | undefined;
  from?: string | undefined;
  to?: string | undefined;
  /** Konfigurationsfilter: je Merkmal die geforderten Werte (alle müssen zutreffen) */
  config?: Configuration | undefined;
  /** Archivierte Zyklen: ausgeblendet (Standard), mit (all) oder nur (only) */
  archived?: 'all' | 'only' | undefined;
  limit: number;
  offset: number;
}

export async function searchCycles(db: Db, q: CycleQuery): Promise<{ total: number; items: CycleWithProgress[] }> {
  const text = q.q?.trim();
  const stats = db`(select jsonb_object_agg(status, n) from (
      select status, count(*)::int as n from test_execution e where e.cycle_id = c.id group by status) s)`;
  const rows = await db<(TestCycle & { byStatus: Record<string, number> | null; total: string; planName: string | null; lastExecutedAt: Date | null })[]>`
    select c.*, p.name as plan_name, ${stats} as by_status, last.executed_at as last_executed_at, count(*) over () as total
    from test_cycle c left join test_plan p on p.id = c.plan_id
    left join lateral (select max(e.executed_at) as executed_at from test_execution e where e.cycle_id = c.id) last on true
    where c.project_id = ${q.projectId}
      ${q.planId ? db`and c.plan_id = ${q.planId}` : db``}
      ${q.noPlan ? db`and c.plan_id is null` : db``}
      ${text ? db`and (c.search @@ websearch_to_tsquery('german', ${text}) or c.name ilike ${'%' + text + '%'}
                       or c.build ilike ${'%' + text + '%'} or c.environment ilike ${'%' + text + '%'})` : db``}
      ${q.environment ? db`and c.environment = ${q.environment}` : db``}
      ${q.config && Object.keys(q.config).length ? db`and c.configuration @> ${db.json(q.config as never)}` : db``}
      ${q.build ? db`and c.build = ${q.build}` : db``}
      ${q.archived === 'all' ? db`` : q.archived === 'only' ? db`and c.archived_at is not null` : db`and c.archived_at is null`}
      ${q.from ? db`and coalesce(c.end_date, c.start_date) >= ${q.from}` : db``}
      ${q.to ? db`and c.start_date <= ${q.to}` : db``}
      ${q.state === 'open' ? db`and exists (select 1 from test_execution e where e.cycle_id = c.id and e.status in ${codesOf(db, 'OPEN', 'IN_PROGRESS')})` : db``}
      ${q.state === 'failed' ? db`and exists (select 1 from test_execution e where e.cycle_id = c.id and e.status in ${codesOf(db, 'FAILED', 'BLOCKED')})` : db``}
      ${q.state === 'done' ? db`and exists (select 1 from test_execution e where e.cycle_id = c.id)
                                and not exists (select 1 from test_execution e where e.cycle_id = c.id and e.status in ${codesOf(db, 'OPEN', 'IN_PROGRESS')})` : db``}
    order by coalesce(c.start_date, last.executed_at::date) desc nulls last, c.name
    limit ${q.limit} offset ${q.offset}`;
  return {
    total: Number(rows[0]?.total ?? 0),
    items: rows.map(({ total: _t, ...r }) => {
      const byStatus = r.byStatus ?? {};
      return { ...r, byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0) };
    }),
  };
}

/** Werte für Filter (Umgebungen, Builds) mit Häufigkeit. */
export async function cycleFacets(db: Db, projectId: string, planId?: string) {
  const facet = (col: string) => db<{ value: string; count: number }[]>`
    select ${db(col)} as value, count(*)::int as count from test_cycle
    where project_id = ${projectId} and ${db(col)} is not null and ${db(col)} <> ''
      ${planId ? db`and plan_id = ${planId}` : db``}
    group by 1 order by 2 desc, 1 limit 200`;
  return { environments: await facet('environment'), builds: await facet('build') };
}

export interface ExecutionQuery {
  cycleId: string;
  status?: string[] | undefined;
  q?: string | undefined;
  assignee?: string | undefined;
  executedBy?: string | undefined;
  withDefects?: boolean | undefined;
  outdated?: boolean | undefined;
  sort?: 'order' | 'key' | 'status' | 'executedAt' | undefined;
  limit: number;
  offset: number;
}

export async function queryExecutions(db: Db, q: ExecutionQuery) {
  const text = q.q?.trim();
  const filters = db`
      ${q.status?.length ? db`and e.status = any(${q.status}::text[])` : db``}
      ${text ? db`and (tc.key ilike ${'%' + text + '%'} or tc.legacy_key ilike ${'%' + text + '%'} or v.title ilike ${'%' + text + '%'}
                       or e.search @@ websearch_to_tsquery('german', ${text}))` : db``}
      ${q.assignee === '-' ? db`and e.assignee is null` : q.assignee ? db`and e.assignee = ${q.assignee}` : db``}
      ${q.executedBy ? db`and e.executed_by = ${q.executedBy}` : db``}
      ${q.withDefects ? db`and exists (select 1 from external_reference r where r.owner_type = 'TEST_EXECUTION' and r.owner_id = e.id and r.relation = 'DEFECT')` : db``}
      ${q.outdated ? db`and v.version_no <> tc.current_version` : db``}`;
  const order = {
    order: db`e.order_no, tc.key`,
    key: db`tc.key`,
    status: db`e.status, e.order_no`,
    executedAt: db`e.executed_at desc nulls last, e.order_no`,
  }[q.sort ?? 'order'];
  const rows = await db<(Omit<ExecutionListItem, 'defects'> & { total: string })[]>`
    select e.*, tc.key as test_case_key, tc.legacy_key, v.title, v.version_no, tc.current_version, count(*) over () as total
    from test_execution e
    join test_case tc on tc.id = e.test_case_id
    join test_case_version v on v.id = e.test_case_version_id
    where e.cycle_id = ${q.cycleId} ${filters}
    order by ${order}
    limit ${q.limit} offset ${q.offset}`;
  const defects = await listReferencesForOwners(db, 'TEST_EXECUTION', rows.map((r) => r.id));
  const [agg] = await db<{ byStatus: Record<string, number> | null; byAssignee: Record<string, number> | null; durationSeconds: number;
    plannedMinutes: number; remainingMinutes: number; withoutEstimate: number }[]>`
    select (select jsonb_object_agg(status, n) from (select status, count(*)::int as n from test_execution where cycle_id = ${q.cycleId} group by 1) s) as by_status,
           (select jsonb_object_agg(coalesce(assignee, '-'), n) from (select assignee, count(*)::int as n from test_execution where cycle_id = ${q.cycleId} group by 1) a) as by_assignee,
           (select coalesce(sum(duration_seconds), 0)::int from test_execution where cycle_id = ${q.cycleId}) as duration_seconds,
           -- geplanter Aufwand aus den Schätzungen der Testfälle; Rest = noch offene Ausführungen
           (select coalesce(sum(t.estimate_minutes), 0)::int from test_execution x join test_case t on t.id = x.test_case_id where x.cycle_id = ${q.cycleId}) as planned_minutes,
           (select coalesce(sum(t.estimate_minutes), 0)::int from test_execution x join test_case t on t.id = x.test_case_id join execution_status s on s.code = x.status
              where x.cycle_id = ${q.cycleId} and s.category in ('OPEN', 'IN_PROGRESS')) as remaining_minutes,
           (select count(*)::int from test_execution x join test_case t on t.id = x.test_case_id where x.cycle_id = ${q.cycleId} and t.estimate_minutes is null) as without_estimate`;
  return {
    total: Number(rows[0]?.total ?? 0),
    durationSeconds: agg?.durationSeconds ?? 0,
    effort: { plannedMinutes: agg?.plannedMinutes ?? 0, remainingMinutes: agg?.remainingMinutes ?? 0, withoutEstimate: agg?.withoutEstimate ?? 0 },
    byStatus: agg?.byStatus ?? {},
    byAssignee: agg?.byAssignee ?? {},
    items: rows.map(({ total: _t, ...r }) => ({ ...r, defects: defects.filter((d) => d.ownerId === r.id) })),
  };
}

export interface BulkExecutionChange {
  ids: string[];
  status?: string | undefined;
  comment?: string | undefined;
  /** undefined = unverändert, null = Zuweisung entfernen */
  assignee?: string | null | undefined;
  /** ohne provider: Nummer → OpenProject, sonst Jira */
  addDefects?: { provider?: string | undefined; key: string; title?: string | null | undefined }[] | undefined;
  fields?: Record<string, unknown> | undefined;
  remove?: boolean | undefined;
  moveToCycleId?: string | undefined;
}

/**
 * Massenbearbeitung von Ausführungen (Stufe H3): Ergebnis, Zuweisung, Fehler, Felder, Entfernen, Verschieben.
 * Jede Ausführung wird einzeln mit denselben Regeln wie in der Durchführung geprüft (abgeschlossene Zyklen,
 * Nachweispflicht, Historie); nicht Mögliches wird übersprungen und begründet.
 */
export async function bulkExecutions(db: Db, change: BulkExecutionChange, actor: string, opts: { requireEvidence?: (projectId: string) => Promise<boolean>; mayOverrideReview?: boolean } = {}) {
  const skipped: { id: string; key: string; reason: string }[] = [];
  let updated = 0, removed = 0, moved = 0;
  const rows = await db<{ id: string; key: string; status: string; cycleId: string; state: string; projectId: string; testCaseId: string; customFields: Record<string, unknown>; results: number }[]>`
    select e.id, tc.key, e.status, e.cycle_id, c.state, c.project_id, e.test_case_id, e.custom_fields,
      (select count(*)::int from execution_result r where r.execution_id = e.id) as results
    from test_execution e join test_cycle c on c.id = e.cycle_id join test_case tc on tc.id = e.test_case_id
    where e.id = any(${change.ids}::uuid[]) order by c.name, e.order_no`;
  let target: { id: string; projectId: string; state: string } | undefined;
  if (change.moveToCycleId) {
    [target] = await db<{ id: string; projectId: string; state: string }[]>`select id, project_id, state from test_cycle where id = ${change.moveToCycleId}`;
    if (!target) throw notFound('Testzyklus', change.moveToCycleId);
    if (target.state === 'closed') throw conflict('Der Zielzyklus ist abgeschlossen.');
  }
  const evidence = new Map<string, boolean>();
  /** Je Ausführung ein Ergebnis: Zähler oder Grund fürs Überspringen. */
  type Outcome = 'removed' | 'moved' | 'updated' | 'unchanged' | { skip: string };
  const one = async (db: Db, r: (typeof rows)[number]): Promise<Outcome> => {
    if (change.remove) {
      if (r.state === 'closed') return { skip: 'Zyklus abgeschlossen' };
      if (r.status !== 'NOT_EXECUTED' || r.results > 0) return { skip: 'bereits ausgeführt – bleibt zur Nachvollziehbarkeit erhalten' };
      await deleteAttachmentsOf(db, 'TEST_EXECUTION', r.id);
      await db`delete from external_reference where owner_type = 'TEST_EXECUTION' and owner_id = ${r.id}`;
      await db`delete from test_execution where id = ${r.id}`;
      await recordEvent(db, { type: EventTypes.ExecutionRemoved, aggregateType: 'TestCycle', aggregateId: r.cycleId, actor, payload: { executionId: r.id, key: r.key } });
      return 'removed';
    }
    if (target) {
      if (target.projectId !== r.projectId) return { skip: 'anderes Projekt' };
      if (r.cycleId === target.id) return { skip: 'bereits im Zielzyklus' };
      if (r.state === 'closed') return { skip: 'Zyklus abgeschlossen' };
      const [dup] = await db`select 1 from test_execution where cycle_id = ${target.id} and test_case_id = ${r.testCaseId}`;
      if (dup) return { skip: 'Testfall ist im Zielzyklus bereits enthalten' };
      await db`update test_execution set cycle_id = ${target.id}, updated_at = now(),
        order_no = (select coalesce(max(order_no), 0) + 1 from test_execution where cycle_id = ${target.id}) where id = ${r.id}`;
      await recordEvent(db, { type: EventTypes.ExecutionUpdated, aggregateType: 'TestExecution', aggregateId: r.id, actor, payload: { movedFrom: r.cycleId, movedTo: target.id, key: r.key } });
      return 'moved';
    }
    if (r.state === 'closed') return { skip: 'Zyklus abgeschlossen' };
    let touched = false;
    if (change.fields && Object.keys(change.fields).length) {
      const merged = await validateCustomFields(db, 'execution', r.projectId, { ...r.customFields, ...change.fields }, { previous: r.customFields });
      await db`update test_execution set custom_fields = ${db.json(merged as never)}, updated_at = now() where id = ${r.id}`;
      touched = true;
    }
    if (change.assignee !== undefined) {
      await db`update test_execution set assignee = ${change.assignee}, updated_at = now() where id = ${r.id}`;
      await recordEvent(db, { type: EventTypes.ExecutionAssigned, aggregateType: 'TestExecution', aggregateId: r.id, actor, payload: { assignee: change.assignee } });
      touched = true;
    }
    if (change.status && opts.mayOverrideReview === false) {
      const [rv] = await db<{ reviewState: string | null }[]>`select review_state from test_execution where id = ${r.id}`;
      if (rv?.reviewState === 'pending' || rv?.reviewState === 'escalated') return { skip: 'Ergebnis eines KI-Agenten wartet auf Prüfung (nur Testleitung)' };
    }
    if (change.status || change.addDefects?.length) {
      const [cur] = await db<{ comment: string | null }[]>`select comment from test_execution where id = ${r.id}`;
      if (!evidence.has(r.projectId)) evidence.set(r.projectId, (await opts.requireEvidence?.(r.projectId)) ?? false);
      if (change.status) {
        // Schritt- und Durchlaufergebnisse bleiben unverändert; die Abweichung von ihrer Ableitung ist mit
        // „Massenbearbeitung“ begründet und steht so in der Ergebnis-Historie (Review Teil 3, Befund 6).
        await executeTest(db, r.id, {
          status: change.status, comment: change.comment?.trim() ? change.comment : cur?.comment ?? null,
          defects: await Promise.all((change.addDefects ?? []).map(async (d) => ({ ...await defectKey(d.key, d.provider), title: d.title ?? null }))),
          overrideReason: 'Massenbearbeitung',
        }, actor, { requireEvidence: evidence.get(r.projectId) });
      } else {
        for (const d of change.addDefects ?? []) {
          const { provider, key } = await defectKey(d.key, d.provider);
          const ref = { ownerType: 'TEST_EXECUTION' as const, ownerId: r.id, provider, externalKey: key, relation: 'DEFECT' as const, url: null, title: d.title ?? null };
          await linkReference(db, provider === 'url' ? urlReference(ref) : ref, actor);
        }
      }
      touched = true;
    }
    return touched ? 'updated' : 'unchanged';
  };
  class SkipRow extends Error {}
  for (const r of rows) {
    // Savepoint je Ausführung: Ein Fehler (auch der Datenbank) verwirft nur diese Zeile vollständig, die übrigen laufen weiter
    let outcome: Outcome;
    try {
      outcome = await withSavepoint(db, async (sp) => {
        const o = await one(sp, r);
        if (typeof o === 'object') throw new SkipRow(o.skip);
        return o;
      });
    } catch (e) {
      skipped.push({ id: r.id, key: r.key, reason: (e as Error).message });
      continue;
    }
    if (outcome === 'removed') removed++;
    else if (outcome === 'moved') moved++;
    else if (outcome === 'updated') updated++;
  }
  const missing = change.ids.length - rows.length;
  return { updated, removed, moved, skipped, missing };
}

// ---- Ad-hoc-Ausführung und Testplan klonen (Stufe H) ----

/**
 * Testfall sofort ausführen, ohne vorher einen Zyklus anzulegen: Die Ausführung landet im Ad-hoc-Zyklus des Projekts
 * (bzw. des gewählten Testplans), der bei Bedarf entsteht. Jede Ad-hoc-Ausführung ist ein eigener Eintrag.
 */
export async function runAdhoc(db: Db, testCaseIdOrKey: string, o: { planId?: string | null | undefined }, actor: string) {
  const tc = await getTestCase(db, testCaseIdOrKey);
  if (tc.archivedAt) throw badRequest(`${tc.key} ist archiviert.`);
  // wie beim Einplanen: veraltete Testfälle nicht mehr ausführen (Review Teil 3, Befund 26)
  const [st] = await db<{ category: string }[]>`select category from test_case_status where code = ${tc.status}`;
  if (st?.category === 'DEPRECATED') throw badRequest(`${tc.key} ist als veraltet markiert und wird nicht mehr ausgeführt.`);
  await assertPlanInProject(db, o.planId ?? null, tc.projectId);
  // Sperre je Projekt, damit parallele Aufrufe nicht zwei Ad-hoc-Zyklen anlegen
  await db`select pg_advisory_xact_lock(hashtext(${`adhoc:${tc.projectId}:${o.planId ?? ''}`}))`;
  let [cycle] = await db<{ id: string; state: string }[]>`select id, state from test_cycle where project_id = ${tc.projectId} and is_adhoc
    and plan_id is not distinct from ${o.planId ?? null}::uuid and archived_at is null order by created_at desc limit 1`;
  if (!cycle || cycle.state === 'closed') {
    const [plan] = o.planId ? await db<{ name: string; release: string | null }[]>`select name, release from test_plan where id = ${o.planId}` : [];
    const created = await createCycle(db, tc.projectId, {
      name: plan ? `Ad hoc – ${plan.name}` : 'Ad hoc', planId: o.planId ?? null, release: plan?.release ?? null,
      description: 'Sofortausführungen ohne vorher geplanten Zyklus („Jetzt ausführen“ am Testfall).',
    }, actor);
    await db`update test_cycle set is_adhoc = true, state = 'active' where id = ${created.id}`;
    cycle = { id: created.id, state: 'active' };
  }
  const [row] = await db<{ id: string }[]>`
    insert into test_execution(cycle_id, test_case_id, test_case_version_id, order_no, status, assignee)
    values (${cycle.id}, ${tc.id}, ${tc.version.id}, (select coalesce(max(order_no), 0) + 1 from test_execution where cycle_id = ${cycle.id}), 'NOT_EXECUTED', ${actor})
    returning id`;
  await recordEvent(db, { type: EventTypes.TestAddedToCycle, aggregateType: 'TestCycle', aggregateId: cycle.id, actor, payload: { testCaseId: tc.id, key: tc.key, versionNo: tc.currentVersion, adhoc: true } });
  return { executionId: row!.id, cycleId: cycle.id };
}

/**
 * Testplan kopieren (z. B. für das nächste Release): Ziele, Ausstiegskriterien, Verweise und Datensatz-Anpassungen;
 * optional die Zyklen mit ihren Testfällen (aktuelle Version, Zuständige) – ohne Ergebnisse.
 */
export async function clonePlan(db: Db, planId: string, o: { name: string; release?: string | null | undefined; withCycles: boolean }, actor: string) {
  const plan = await getPlan(db, planId);
  const [p] = await db<{ id: string }[]>`insert into test_plan(project_id, name, description, release, created_by, exit_criteria)
    values (${plan.projectId}, ${o.name}, ${plan.description}, ${o.release ?? plan.release}, ${actor}, ${db.json((plan.exitCriteria ?? {}) as never)}) returning id`;
  const newId = p!.id;
  // Herkunft (created_by) mitkopieren – Altbestand/Migration werden weiter abgeglichen (Sicherheit 3)
  await db`insert into external_reference(owner_type, owner_id, provider, external_key, relation, url, title, status, created_by)
    select owner_type, ${newId}, provider, external_key, relation, url, title, status, created_by from external_reference where owner_type = 'TEST_PLAN' and owner_id = ${planId}`;
  await db`insert into dataset_override(scope, scope_id, test_case_id, dataset, updated_by)
    select scope, ${newId}, test_case_id, dataset, ${actor} from dataset_override where scope = 'plan' and scope_id = ${planId}`;
  let cycles = 0, executions = 0;
  if (o.withCycles) {
    const src = await db<{ id: string; name: string; description: string | null; build: string | null; environment: string | null; configuration: Configuration; customFields: Record<string, unknown> }[]>`
      select id, name, description, build, environment, configuration, custom_fields from test_cycle where plan_id = ${planId} and not is_adhoc and archived_at is null order by created_at`;
    for (const c of src) {
      const created = await createCycle(db, plan.projectId, {
        name: c.name, planId: newId, description: c.description, release: o.release ?? plan.release, build: null, environment: c.environment,
        customFields: c.customFields, configuration: Object.keys(c.configuration ?? {}).length ? c.configuration : null,
      }, actor);
      const r = await db`insert into test_execution(cycle_id, test_case_id, test_case_version_id, order_no, status, assignee)
        select ${created.id}, e.test_case_id, t.current_version_id, row_number() over (order by min(e.order_no)), 'NOT_EXECUTED', min(e.assignee)
        from test_execution e join (select tc.id, v.id as current_version_id from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
          where tc.archived_at is null) t on t.id = e.test_case_id
        where e.cycle_id = ${c.id} group by e.test_case_id, t.current_version_id`;
      cycles++;
      executions += r.count;
    }
  }
  return { planId: newId, cycles, executions };
}

// ---- Zyklen archivieren und löschen (Stufe H4) ----

/** Archivieren blendet den Zyklus aus Listen und Startseite aus und sperrt ihn (abgeschlossen); Ergebnisse bleiben. */
export async function setCycleArchived(db: Db, id: string, archive: boolean, actor: string) {
  const c = await getCycle(db, id);
  await db`update test_cycle set archived_at = ${archive ? new Date() : null}, archived_by = ${archive ? actor : null},
    state = ${archive ? 'closed' : db`state`}, closed_by = ${archive ? db`coalesce(closed_by, ${actor})` : db`closed_by`},
    closed_at = ${archive ? db`coalesce(closed_at, now())` : db`closed_at`} where id = ${id}`;
  await recordEvent(db, { type: EventTypes.TestCycleArchived, aggregateType: 'TestCycle', aggregateId: id, actor, payload: { name: c.name, archived: archive } });
  return getCycle(db, id);
}

/**
 * Testplan archivieren bzw. wiederherstellen (Review 30.10.2026, F11): ausgeblendet in der Planung, Berichte,
 * Freigabestände und Ergebnisse bleiben unverändert erreichbar.
 */
export async function setPlanArchived(db: Db, id: string, archive: boolean, actor: string) {
  const [p] = await db<{ name: string; archivedAt: Date | null }[]>`select name, archived_at from test_plan where id = ${id} for update`;
  if (!p) throw notFound('Testplan', id);
  if (!!p.archivedAt === archive) return getPlan(db, id);
  await db`update test_plan set archived_at = ${archive ? new Date() : null}, archived_by = ${archive ? actor : null} where id = ${id}`;
  await recordEvent(db, { type: archive ? EventTypes.PlanArchived : EventTypes.PlanRestored, aggregateType: 'TestPlan', aggregateId: id, actor, payload: { name: p.name } });
  return getPlan(db, id);
}

/** Löschen nur ohne Ergebnisse und ohne begonnene Sitzungen – sonst archivieren (Nachvollziehbarkeit). */
export async function deleteCycle(db: Db, id: string, actor: string) {
  const c = await getCycle(db, id);
  const [used] = await db<{ executed: number; sessions: number }[]>`
    select (select count(*)::int from test_execution e where e.cycle_id = ${id}
              and (e.status <> 'NOT_EXECUTED' or exists (select 1 from execution_result r where r.execution_id = e.id))) as executed,
           (select count(*)::int from exploratory_session s where s.cycle_id = ${id} and s.status <> 'planned') as sessions`;
  if (used!.executed || used!.sessions) {
    throw conflict(`Zyklus „${c.name}“ enthält ${used!.executed} Ergebnisse${used!.sessions ? ` und ${used!.sessions} Sitzungen` : ''} – bitte archivieren statt löschen.`);
  }
  const execs = await db<{ id: string }[]>`select id from test_execution where cycle_id = ${id}`;
  const execIds = execs.map((e) => e.id);
  const sessionIds = (await db<{ id: string }[]>`select id from exploratory_session where cycle_id = ${id}`).map((s) => s.id);
  for (const e of execIds) await deleteAttachmentsOf(db, 'TEST_EXECUTION', e);
  for (const s of sessionIds) await deleteAttachmentsOf(db, 'EXPLORATORY_SESSION', s);
  await deleteAttachmentsOf(db, 'TEST_CYCLE', id);
  await db`delete from external_reference where (owner_type = 'TEST_EXECUTION' and owner_id = any(${execIds}::uuid[])) or (owner_type = 'TEST_CYCLE' and owner_id = ${id})
    or (owner_type = 'EXPLORATORY_SESSION' and owner_id = any(${sessionIds}::uuid[]))`;
  // Reste ohne Fremdschlüssel mitlöschen (Sicherheits-Review Teil 2, Befund 12): Beobachtungen, Datensatz-Überschreibungen
  const watchers = (await db<{ username: string }[]>`delete from watch where object_type = 'TEST_CYCLE' and object_id = ${id} returning username`).map((w) => w.username);
  await db`delete from dataset_override where scope = 'cycle' and scope_id = ${id}`;
  await db`delete from test_execution where cycle_id = ${id}`;
  // Sitzungen und CI-Läufe hängen per „on delete cascade“ am Zyklus
  await db`delete from test_cycle where id = ${id}`;
  await recordEvent(db, { type: EventTypes.TestCycleDeleted, aggregateType: 'TestCycle', aggregateId: id, actor,
    // planId für Beobachter des Testplans, watchers für die (schon gelöschten) Beobachter des Zyklus
    payload: { name: c.name, projectId: c.projectId, planId: c.planId, executions: execs.length, watchers } });
  return { deleted: c.name, executions: execs.length };
}

/**
 * Massenänderung an Ausführungen (Zuweisung). Ergebnisse werden bewusst nicht per Masse gesetzt. Ausführungen in
 * abgeschlossenen bzw. archivierten Zyklen bleiben unverändert (gesperrt) und werden als übersprungen gezählt.
 */
export async function bulkAssign(db: Db, ids: string[], assignee: string | null, actor: string): Promise<{ updated: number; skipped: number }> {
  const rows = await db<{ id: string }[]>`update test_execution e set assignee = ${assignee}, updated_at = now() from test_cycle c
    where c.id = e.cycle_id and e.id = any(${ids}::uuid[]) and c.state <> 'closed' and c.archived_at is null returning e.id`;
  for (const r of rows) {
    await recordEvent(db, { type: EventTypes.ExecutionAssigned, aggregateType: 'TestExecution', aggregateId: r.id, actor, payload: { assignee } });
  }
  return { updated: rows.length, skipped: ids.length - rows.length };
}

/**
 * Ergebnis-Matrix eines Testplans: Testfälle (Zeilen) × Zyklen/Kontexte (Spalten), Zelle = Status.
 * Begrenzt auf die neuesten Zyklen, damit auch große Pläne lesbar bleiben.
 */
export async function planMatrix(db: Db, planId: string, opts: { maxCycles: number; q?: string | undefined; onlyProblems?: boolean | undefined }) {
  const cycles = await db<{ id: string; name: string; environment: string | null; build: string | null; startDate: Date | null }[]>`
    select id, name, environment, build, start_date from test_cycle where plan_id = ${planId}
    order by start_date desc nulls last, name limit ${opts.maxCycles}`;
  const cycleIds = cycles.map((c) => c.id);
  const text = opts.q?.trim();
  const cells = await db<{ testCaseId: string; key: string; legacyKey: string | null; title: string; cycleId: string; status: string; executionId: string }[]>`
    select tc.id as test_case_id, tc.key, tc.legacy_key, v.title, e.cycle_id, e.status, e.id as execution_id
    from test_execution e
    join test_case tc on tc.id = e.test_case_id
    join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
    where e.cycle_id = any(${cycleIds}::uuid[])
      ${text ? db`and (tc.key ilike ${'%' + text + '%'} or tc.legacy_key ilike ${'%' + text + '%'} or v.title ilike ${'%' + text + '%'})` : db``}
    -- bei Wiederholungen im selben Zyklus gewinnt die zuletzt ausgeführte
    order by e.executed_at nulls first, e.created_at`;
  const rows = new Map<string, { testCaseId: string; key: string; legacyKey: string | null; title: string; cells: Record<string, { status: string; executionId: string }> }>();
  for (const c of cells) {
    const row = rows.get(c.testCaseId) ?? rows.set(c.testCaseId, { testCaseId: c.testCaseId, key: c.key, legacyKey: c.legacyKey, title: c.title, cells: {} }).get(c.testCaseId)!;
    row.cells[c.cycleId] = { status: c.status, executionId: c.executionId };
  }
  let list = [...rows.values()];
  if (opts.onlyProblems) {
    const problem = new Set((await db<{ code: string }[]>`select code from execution_status where category in ('FAILED', 'BLOCKED')`).map((x) => x.code));
    list = list.filter((r) => Object.values(r.cells).some((x) => problem.has(x.status)));
  }
  list.sort((a, b) => (a.legacyKey ?? a.key).localeCompare(b.legacyKey ?? b.key, 'de', { numeric: true }));
  const [count] = await db<{ n: number }[]>`select count(*)::int as n from test_cycle where plan_id = ${planId}`;
  return { cycles, totalCycles: count!.n, rows: list };
}

/**
 * Projektweite Ausführungssuche mit der Abfragesprache (Stufe H2) – Grundlage für Massenbearbeitung und Export.
 * Archivierte Zyklen sind ausgeblendet, außer die Abfrage nennt „archiviert“.
 */
export async function searchExecutions(db: Db, projectId: string, q: { aql?: string | undefined; cycleId?: string | undefined; actor: string; limit: number; offset: number }) {
  const aq = q.aql?.trim() ? await compileExecutionQuery(db, q.aql, { projectId, actor: q.actor }) : null;
  const rows = await db<(Omit<ExecutionListItem, 'defects'> & { cycleName: string; cycleState: string; planName: string | null; release: string | null;
    build: string | null; environment: string | null; priority: string | null; total: string })[]>`
    select e.*, tc.key as test_case_key, tc.legacy_key, v.title, v.version_no, tc.current_version, v.priority,
           c.name as cycle_name, c.state as cycle_state, pl.name as plan_name, c.release, c.build, c.environment, count(*) over () as total
    from test_execution e
    join test_cycle c on c.id = e.cycle_id
    left join test_plan pl on pl.id = c.plan_id
    join test_case tc on tc.id = e.test_case_id
    join test_case_version v on v.id = e.test_case_version_id
    where c.project_id = ${projectId}
      ${q.cycleId ? db`and e.cycle_id = ${q.cycleId}` : db``}
      ${aq?.mentionsArchived ? db`` : db`and c.archived_at is null`}
      ${aq ? aq.where : db``}
    order by ${aq?.order ? db`${aq.order},` : db``} c.start_date desc nulls last, c.name, e.order_no
    limit ${q.limit} offset ${q.offset}`;
  const defects = await listReferencesForOwners(db, 'TEST_EXECUTION', rows.map((r) => r.id));
  return { total: Number(rows[0]?.total ?? 0), items: rows.map(({ total: _t, ...r }) => ({ ...r, defects: defects.filter((d) => d.ownerId === r.id) })) };
}

/** Ausführungen über alle Zyklen eines Projekts (z. B. "mir zugewiesen, offen"). */
export async function projectExecutions(db: Db, projectId: string, q: { assignee?: string | undefined; status?: string[] | undefined; limit: number; offset: number }) {
  const rows = await db<(Omit<ExecutionListItem, 'defects'> & { cycleName: string; release: string | null; environment: string | null; total: string })[]>`
    select e.*, tc.key as test_case_key, tc.legacy_key, v.title, v.version_no, tc.current_version,
           c.name as cycle_name, c.release, c.environment, count(*) over () as total
    from test_execution e
    join test_cycle c on c.id = e.cycle_id
    join test_case tc on tc.id = e.test_case_id
    join test_case_version v on v.id = e.test_case_version_id
    where c.project_id = ${projectId}
      ${q.assignee ? db`and e.assignee = ${q.assignee}` : db``}
      ${q.status?.length ? db`and e.status = any(${q.status}::text[])` : db``}
    order by c.start_date desc nulls last, c.name, e.order_no
    limit ${q.limit} offset ${q.offset}`;
  return { total: Number(rows[0]?.total ?? 0), items: rows.map(({ total: _t, ...r }) => r) };
}

/**
 * Stufe 2 der Versionsrekonstruktion: jede Ausführung eines Testfalls auf die Version legen, die zum
 * Ausführungszeitpunkt galt. Nicht ausgeführte Einträge zeigen auf die neueste Version.
 */
export async function remapExecutionVersions(db: Db, testCaseId: string, versions: { id: string; validFrom: Date }[]): Promise<number> {
  const execs = await db<{ id: string; status: string; executedAt: Date | null; customFields: { created?: { on?: string | null } } }[]>`
    select id, status, executed_at, custom_fields from test_execution where test_case_id = ${testCaseId}`;
  const latest = versions.at(-1)!;
  for (const e of execs) {
    const at = e.status === 'NOT_EXECUTED' ? null : e.executedAt ?? (e.customFields?.created?.on ? new Date(e.customFields.created.on) : null);
    let target = latest;
    if (at && !Number.isNaN(at.getTime())) {
      target = versions[0]!;
      for (const v of versions) if (v.validFrom.getTime() <= at.getTime()) target = v;
    }
    await db`update test_execution set test_case_version_id = ${target.id} where id = ${e.id}`;
  }
  return execs.length;
}
