import type { Hono } from 'hono';
import { z } from 'zod';
import { type Db, inTx } from '../../platform/db.ts';
import { badRequest, HttpError, notFound, requireAccess, route } from '../../platform/http.ts';
import type { Context } from 'hono';
import { EventTypes, recordChange, recordEvent } from '../events/index.ts';
import { getProject } from '../projects/index.ts';
import { validateCustomFields } from '../fields/index.ts';
import { getTestCase, getTestSet, resolveTestSet } from '../testcases/index.ts';
import { HttpUrl, SEVERITIES } from '../references/index.ts';
import {
  addTestsToCycle, bulkAssign, createCycle, resultHistory, createPlan, deletePlan, updatePlan, cycleFacets, executeTest, executionHistory, getCycle, getExecution,
  getPlan, listPlansWithStats, listStatuses, upsertStatus, planMatrix, projectExecutions, queryExecutions, removeExecution, searchCycles,
  updateCycle, setPlanArchived, updateExecutionToCurrentVersion, versionUpdatePlan, updateCycleToCurrentVersions, executionsOnOlderVersions, searchExecutions, bulkExecutions, setCycleArchived, deleteCycle, datasetOverrides, setDatasetOverride, runAdhoc, clonePlan,
  assertMayRecord, assertMayAssign, defectKey,
} from './service.ts';

/** Hat die Person Pflegerechte (Testleitung) für die Objekte? Nur 403 bedeutet „nein“. */
export async function isLead(c: Context, project: unknown): Promise<boolean> {
  try {
    await requireAccess(c, { level: 'edit', project: () => project });
    return true;
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) return false;
    throw e;
  }
}
import { Dataset, effectiveDataset } from '../testcases/index.ts';
import { compareCycles, distribute, repeatCycle } from './planning.ts';
import { exportExecutions, exportMatrix } from './exports.ts';
import { exportOffline, importOffline } from './offline.ts';
import { claimNext, escalate, reviewQueue, reviewResult } from './review.ts';

import {
  configurationCounts, configurationStats, deleteConfigValue, loadDimensions, reclassifyCycles, setCycleConfiguration,
  unclassifiedTexts, upsertConfigValue,
} from './configuration.ts';

/** "database:Oracle,client:Desktop" → { database: ['Oracle'], client: ['Desktop'] } */
const configFilter = z.string().optional().transform((v) => {
  if (!v) return undefined;
  const out: Record<string, string[]> = {};
  for (const part of v.split(',').filter(Boolean)) {
    const i = part.indexOf(':');
    if (i > 0) (out[part.slice(0, i)] ??= []).push(part.slice(i + 1));
  }
  return out;
});
const ConfigurationBody = z.record(z.string(), z.array(z.string()));

const statusList = z.string().optional().transform((v) => (v ? v.split(',').filter(Boolean) : undefined));

const CycleBody = z.object({
  name: z.string().min(1),
  configuration: z.record(z.string(), z.array(z.string())).nullish(),
  planId: z.uuid().nullish(),
  description: z.string().nullish(),
  release: z.string().nullish(),
  build: z.string().nullish(),
  environment: z.string().nullish(),
  // plausible Jahre (2000–2100): Tippfehler wie „0021“ blähen sonst Burn-down-Schleifen über Jahrhunderte auf
  startDate: z.iso.date().refine((d) => d >= '2000-01-01' && d <= '2100-12-31', 'Datum außerhalb 2000–2100').nullish(),
  endDate: z.iso.date().refine((d) => d >= '2000-01-01' && d <= '2100-12-31', 'Datum außerhalb 2000–2100').nullish(),
  /** Eigene Felder (Stufe H5); übernommene Werte bleiben erhalten */
  customFields: z.record(z.string(), z.unknown()).optional(),
});

export function executionRoutes(app: Hono, db: Db): void {
  const tag = 'Planung & Ausführung';
  route(app, { method: 'get', path: '/api/execution-statuses', tag, summary: 'Ausführungsstatus-Katalog' },
    () => listStatuses(db));
  route(app, {
    method: 'put', path: '/api/admin/execution-statuses/:code', access: 'admin', tag: 'Status & Workflow', summary: 'Ausführungs-/Schrittstatus anlegen oder ändern', status: 204,
    body: z.object({
      name: z.string().min(1).max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      category: z.enum(['OPEN', 'IN_PROGRESS', 'PASSED', 'PASSED_WITH_ISSUES', 'KNOWN_FAILURE', 'FAILED', 'BLOCKED', 'INVALID', 'NOT_APPLICABLE']),
      appliesTo: z.enum(['execution', 'step', 'both']), active: z.boolean(), sortOrder: z.number().int(), description: z.string().max(500).nullable(),
    }),
  }, ({ params, body, actor }) => {
    if (!/^[A-Z0-9_]{2,40}$/.test(params.code!)) throw badRequest('Code: 2–40 Zeichen A–Z, 0–9, _');
    return inTx(db, (tx) => upsertStatus(tx, params.code!, body, actor));
  });

  // ---- Testkonfigurationen ----
  const ctag = 'Testkonfigurationen';
  route(app, { method: 'get', path: '/api/configuration/dimensions', tag: ctag, summary: 'Merkmale mit Werten und Erkennungsregeln' },
    () => loadDimensions(db));
  route(app, {
    method: 'get', path: '/api/configuration/counts', access: ({ query }) => { const p = (query as { project?: string }).project; return p ? { level: 'read', project: () => ({ kind: 'project', key: p }) } : 'admin'; }, tag: ctag, summary: 'Anzahl Zyklen je Merkmalswert (optional je Projekt/Testplan)',
    query: z.object({ project: z.string().optional(), planId: z.uuid().optional() }),
  }, async ({ query }) => configurationCounts(db, query.project ? (await getProject(db, query.project)).id : undefined, query.planId));
  route(app, {
    method: 'put', path: '/api/configuration/dimensions/:key/values', access: 'admin', tag: ctag, summary: 'Merkmalswert mit Erkennungsregeln anlegen/ändern',
    body: z.object({ value: z.string().min(1), description: z.string().nullish(), patterns: z.array(z.string().min(1)), sortOrder: z.number().int().optional() }),
  }, ({ params, body }) => upsertConfigValue(db, params.key!, body));
  route(app, { method: 'delete', path: '/api/configuration/values/:id', access: 'admin', tag: ctag, summary: 'Merkmalswert löschen', status: 204 },
    ({ params }) => deleteConfigValue(db, params.id!));
  route(app, {
    method: 'post', path: '/api/configuration/reclassify', access: 'admin', tag: ctag, summary: 'Konfiguration aller automatisch erkannten Zyklen neu bestimmen',
    body: z.object({ project: z.string().optional() }),
  }, async ({ body }) => inTx(db, async (tx) => reclassifyCycles(tx, body.project ? (await getProject(tx, body.project)).id : undefined)));
  route(app, {
    method: 'get', path: '/api/configuration/unclassified', access: 'admin', tag: ctag, summary: 'Zyklustexte ohne erkannten Wert für ein Merkmal',
    query: z.object({ dimension: z.string(), project: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
  }, async ({ query }) => unclassifiedTexts(db, query.project ? (await getProject(db, query.project)).id : undefined, query.dimension, query.limit));
  route(app, {
    method: 'get', path: '/api/projects/:key/configuration-stats', access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag: ctag, summary: 'Ergebnisse je Merkmalswert (z. B. Fehlerquote je Datenbank)',
    query: z.object({ planId: z.uuid().optional() }),
  }, async ({ params, query }) => configurationStats(db, (await getProject(db, params.key!)).id, query.planId));
  route(app, {
    method: 'put', path: '/api/cycles/:id/configuration', access: { level: 'edit', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag: ctag, summary: 'Konfiguration eines Zyklus manuell setzen (null = wieder automatisch)',
    body: z.object({ configuration: ConfigurationBody.nullable() }),
  }, ({ params, body }) => inTx(db, async (tx) => {
    await setCycleConfiguration(tx, params.id!, body.configuration);
    return getCycle(tx, params.id!);
  }));

  route(app, { method: 'get', path: '/api/projects/:key/plans', access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag, summary: 'Testpläne mit Kennzahlen (neueste zuerst)' },
    async ({ params }) => listPlansWithStats(db, (await getProject(db, params.key!)).id));
  route(app, { method: 'get', path: '/api/plans/:id', access: { level: 'read', project: ({ params }) => ({ kind: 'plan', id: params.id! }) }, tag, summary: 'Testplan lesen' },
    ({ params }) => getPlan(db, params.id!));
  route(app, {
    method: 'get', path: '/api/plans/:id/matrix', access: { level: 'read', project: ({ params }) => ({ kind: 'plan', id: params.id! }) }, tag, summary: 'Ergebnis-Matrix Testfall × Zyklus (neueste Zyklen)',
    query: z.object({ maxCycles: z.coerce.number().int().min(1).max(100).default(30), q: z.string().optional(), onlyProblems: z.stringbool().optional() }),
  }, ({ params, query }) => planMatrix(db, params.id!, query));
  route(app, {
    method: 'post', path: '/api/projects/:key/plans', access: { level: 'edit', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag, summary: 'Testplan anlegen', status: 201,
    body: z.object({ name: z.string().min(1), description: z.string().nullish(), release: z.string().nullish() }),
  }, ({ params, body, actor }) => inTx(db, async (tx) => createPlan(tx, (await getProject(tx, params.key!)).id, body, actor)));

  const PlanBody = z.object({ name: z.string().min(1), description: z.string().nullish(), release: z.string().nullish() });
  route(app, { method: 'put', path: '/api/plans/:id', access: { level: 'edit', project: ({ params }) => ({ kind: 'plan', id: params.id! }) }, tag, summary: 'Testplan ändern', body: PlanBody },
    ({ params, body, actor }) => inTx(db, (tx) => updatePlan(tx, params.id!, body, actor)));
  route(app, {
    method: 'put', path: '/api/plans/:id/assessment', access: { level: 'edit', project: ({ params }) => ({ kind: 'plan', id: params.id! }) }, tag,
    summary: 'Fazit des Testmanagements für den Abschlussbericht speichern (null = entfernen); aiModel: Modell, dessen Entwurf übernommen wurde',
    body: z.object({ assessment: z.string().max(20_000).nullable(), aiModel: z.string().trim().max(200).nullish() }),
  }, ({ params, body, actor }) => inTx(db, async (tx) => {
    const [before] = await tx<{ assessment: string | null; assessmentAi: string | null }[]>`select assessment, assessment_ai from test_plan where id = ${params.id!} for update`;
    if (!before) throw badRequest('Testplan nicht gefunden');
    const text = body.assessment?.trim() || null;
    // Verfasser, Zeitpunkt und KI-Vermerk gehören zum Fazit; das Protokoll hält jede Fassung vollständig fest
    await tx`update test_plan set assessment = ${text}, assessment_by = ${text ? actor : null}, assessment_at = ${text ? new Date() : null},
      assessment_ai = ${text ? body.aiModel || null : null} where id = ${params.id!}`;
    await recordChange(tx, { type: EventTypes.AssessmentChanged, aggregateType: 'TestPlan', aggregateId: params.id!, actor,
      before: { assessment: before.assessment, aiModel: before.assessmentAi }, after: { assessment: text, aiModel: text ? body.aiModel || null : null } });
    return getPlan(tx, params.id!);
  }));
  route(app, {
    method: 'put', path: '/api/plans/:id/exit-criteria', access: { level: 'edit', project: ({ params }) => ({ kind: 'plan', id: params.id! }) }, tag,
    summary: 'Ausstiegskriterien des Testplans (Bestehensquote, Durchführungsgrad, offene Fehler, Fehlschläge, Abdeckung, Änderungen)',
    body: z.object({
      minPassRate: z.number().min(0).max(100).nullish(), minExecutionRate: z.number().min(0).max(100).nullish(),
      maxOpenDefects: z.number().int().min(0).nullish(), maxFailed: z.number().int().min(0).nullish(), maxKnownFailures: z.number().int().min(0).nullish(),
      fullCoverage: z.boolean().optional(), noUntestedChanges: z.boolean().optional(),
    }),
  }, ({ params, body, actor }) => inTx(db, async (tx) => {
    const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null && v !== undefined && v !== false));
    const [before] = await tx<{ exitCriteria: Record<string, unknown> }[]>`select exit_criteria from test_plan where id = ${params.id!} for update`;
    if (!before) throw badRequest('Testplan nicht gefunden');
    // Schwellen der Freigabe: jede Änderung mit altem und neuem Wert (z. B. Bestehensquote 95 → 80 %)
    await recordChange(tx, { type: EventTypes.ExitCriteriaChanged, aggregateType: 'TestPlan', aggregateId: params.id!, actor, before: before.exitCriteria ?? {}, after: clean });
    await tx`update test_plan set exit_criteria = ${tx.json(clean as never)} where id = ${params.id!}`;
    return getPlan(tx, params.id!);
  }));
  route(app, {
    method: 'put', path: '/api/plans/:id/release-decision', access: { level: 'edit', project: ({ params }) => ({ kind: 'plan', id: params.id! }) }, tag,
    summary: 'Freigabeentscheidung festhalten (freigegeben, mit Auflagen, nicht freigegeben; Begründung Pflicht) oder zurücknehmen (null)',
    body: z.object({ decision: z.enum(['released', 'conditional', 'rejected']).nullable(), note: z.string().max(20_000).nullish() }),
  }, ({ params, body, actor }) => inTx(db, async (tx) => {
    if (body.decision && (body.note ?? '').trim().length < 3) throw badRequest('Bitte die Entscheidung begründen (Auflagen, Restrisiken).');
    await tx`update test_plan set release_decision = ${body.decision}, release_note = ${body.decision ? body.note!.trim() : null},
      release_by = ${body.decision ? actor : null}, release_at = ${body.decision ? new Date() : null} where id = ${params.id!}`;
    await recordEvent(tx, { type: EventTypes.ReleaseDecided, aggregateType: 'TestPlan', aggregateId: params.id!, actor, payload: { decision: body.decision, note: body.note ?? null } });
    return getPlan(tx, params.id!);
  }));
  route(app, {
    method: 'post', path: '/api/cycles/:id/state', access: { level: 'edit', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag,
    summary: 'Zyklus abschließen (Ergebnisse gesperrt) bzw. wieder öffnen', body: z.object({ state: z.enum(['planned', 'active', 'closed']) }),
  }, ({ params, body, actor }) => inTx(db, async (tx) => {
    const [before] = await tx<{ state: string; closedBy: string | null; closedAt: Date | null }[]>`select state, closed_by, closed_at from test_cycle where id = ${params.id!} for update`;
    if (!before) throw badRequest('Testzyklus nicht gefunden');
    const closedAt = body.state === 'closed' ? new Date() : null;
    // Wiederöffnen löscht closed_by/closed_at am Zyklus – das Ereignis behält, wer wann abgeschlossen hatte
    await recordChange(tx, { type: EventTypes.CycleStateChanged, aggregateType: 'TestCycle', aggregateId: params.id!, actor,
      before: { ...before }, after: { state: body.state, closedBy: body.state === 'closed' ? actor : null, closedAt } });
    await tx`update test_cycle set state = ${body.state}, closed_by = ${body.state === 'closed' ? actor : null}, closed_at = ${closedAt} where id = ${params.id!}`;
    return getCycle(tx, params.id!);
  }));
  route(app, {
    method: 'post', path: '/api/cycles/:id/executions/from-test-set', access: { level: 'edit', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag,
    summary: 'Alle Testfälle eines Testsets in den Zyklus aufnehmen (ohne Größengrenze, bereits enthaltene werden übersprungen)', body: z.object({ testSetId: z.uuid() }),
  }, ({ params, body, actor }) => inTx(db, async (tx) => {
    const cycle = await getCycle(tx, params.id!);
    const set = await getTestSet(tx, body.testSetId);
    if (set.projectId !== cycle.projectId) throw badRequest('Testset gehört zu einem anderen Projekt');
    const tcs = await resolveTestSet(tx, set);
    return { ...(await addTestsToCycle(tx, params.id!, tcs.map((t) => t.id), actor)), total: tcs.length };
  }));
  route(app, { method: 'delete', path: '/api/plans/:id', access: { level: 'edit', project: ({ params }) => ({ kind: 'plan', id: params.id! }) }, tag, summary: 'Leeren Testplan löschen (409, solange Zyklen zugeordnet sind)', status: 204 },
    async ({ params }) => { await inTx(db, (tx) => deletePlan(tx, params.id!)); });

  route(app, {
    method: 'get', path: '/api/projects/:key/cycles', access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag, summary: 'Testzyklen suchen/filtern (seitenweise, mit Fortschritt)',
    query: z.object({
      planId: z.string().optional(), q: z.string().optional(), environment: z.string().optional(), build: z.string().optional(),
      state: z.enum(['open', 'failed', 'done']).optional(), from: z.iso.date().optional(), to: z.iso.date().optional(),
      config: configFilter, archived: z.enum(['all', 'only']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0),
    }),
  }, async ({ params, query }) => {
    const projectId = (await getProject(db, params.key!)).id;
    const { planId, ...rest } = query;
    return searchCycles(db, { projectId, ...rest, ...(planId === 'none' ? { noPlan: true } : { planId }) });
  });
  route(app, {
    method: 'get', path: '/api/projects/:key/cycle-facets', access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag, summary: 'Filterwerte für Zyklen (Umgebungen, Builds)',
    query: z.object({ planId: z.uuid().optional() }),
  }, async ({ params, query }) => cycleFacets(db, (await getProject(db, params.key!)).id, query.planId));
  route(app, {
    method: 'get', path: '/api/projects/:key/executions', access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag, summary: 'Ausführungen projektweit (z. B. mir zugewiesen, offen)',
    query: z.object({
      assignee: z.string().optional(), status: statusList,
      limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0),
    }),
  }, async ({ params, query, actor }) =>
    projectExecutions(db, (await getProject(db, params.key!)).id, { ...query, assignee: query.assignee === 'me' ? actor : query.assignee }));
  route(app, { method: 'post', path: '/api/projects/:key/cycles', access: { level: 'edit', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag, summary: 'Testzyklus anlegen', body: CycleBody, status: 201 },
    ({ params, body, actor }) => inTx(db, async (tx) => {
      const projectId = (await getProject(tx, params.key!)).id;
      const customFields = await validateCustomFields(tx, 'cycle', projectId, body.customFields ?? {}, { required: true });
      return createCycle(tx, projectId, { ...body, customFields }, actor);
    }));
  route(app, { method: 'get', path: '/api/cycles/:id', access: { level: 'read', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag, summary: 'Testzyklus lesen' },
    ({ params }) => getCycle(db, params.id!));
  route(app, { method: 'put', path: '/api/cycles/:id', access: { level: 'edit', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag, summary: 'Testzyklus ändern', body: CycleBody },
    ({ params, body, actor }) => inTx(db, async (tx) => {
      const { planName: _p, ...existing } = await getCycle(tx, params.id!);
      const merged = { ...existing.customFields, ...(body.customFields ?? {}) };
      const customFields = body.customFields
        ? await validateCustomFields(tx, 'cycle', existing.projectId, merged, { required: true, previous: existing.customFields })
        : existing.customFields;
      return updateCycle(tx, params.id!, { ...body, customFields }, actor);
    }));
  route(app, {
    method: 'get', path: '/api/cycles/:id/executions', access: { level: 'read', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag, summary: 'Ausführungen eines Zyklus (filterbar, seitenweise, mit Kennzahlen)',
    query: z.object({
      status: statusList, q: z.string().optional(), assignee: z.string().optional(), executedBy: z.string().optional(),
      withDefects: z.stringbool().optional(), outdated: z.stringbool().optional(),
      sort: z.enum(['order', 'key', 'status', 'executedAt']).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0),
    }),
  }, ({ params, query }) => queryExecutions(db, { cycleId: params.id!, ...query }));
  route(app, {
    method: 'get', path: '/api/projects/:key/execution-search', access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag,
    summary: 'Ausführungen projektweit mit der Abfragesprache suchen (idsOnly: nur IDs, bis 5000 – für Massenbearbeitung)',
    query: z.object({
      aql: z.string().max(4000).optional(), cycleId: z.uuid().optional(), idsOnly: z.stringbool().optional(),
      limit: z.coerce.number().int().min(1).max(5000).default(100), offset: z.coerce.number().int().min(0).default(0),
    }),
  }, async ({ params, query, actor }) => {
    const projectId = (await getProject(db, params.key!)).id;
    const r = await searchExecutions(db, projectId, { aql: query.aql, cycleId: query.cycleId, actor, limit: query.idsOnly ? Math.min(query.limit, 5000) : Math.min(query.limit, 500), offset: query.offset });
    return query.idsOnly ? { total: r.total, ids: r.items.map((e) => e.id) } : r;
  });
  const download = (f: { fileName: string; contentType: string; body: Buffer }) => new Response(new Uint8Array(f.body), {
    headers: { 'content-type': f.contentType, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.fileName)}`, 'cache-control': 'no-store' },
  });
  route(app, {
    method: 'get', path: '/api/projects/:key/execution-export', access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag,
    summary: 'Ausführungen als Excel (mit Blatt Schrittergebnisse) bzw. CSV – Abfrage und/oder Zyklus, bis 20 000',
    query: z.object({ aql: z.string().max(4000).optional(), cycleId: z.uuid().optional(), format: z.enum(['xlsx', 'csv']).default('xlsx') }),
  }, async ({ params, query, actor }) => {
    const p = await getProject(db, params.key!);
    return download(await exportExecutions(db, p.id, p.key, { aql: query.aql, cycleId: query.cycleId, actor }, query.format));
  });
  route(app, {
    method: 'get', path: '/api/plans/:id/matrix/export', access: { level: 'read', project: ({ params }) => ({ kind: 'plan', id: params.id! }) }, tag,
    summary: 'Ergebnis-Matrix (Testfall × Zyklus) als Excel/CSV', query: z.object({ format: z.enum(['xlsx', 'csv']).default('xlsx') }),
  }, async ({ params, query }) => download(await exportMatrix(db, params.id!, query.format)));
  route(app, {
    method: 'get', path: '/api/executions/:id/datasets', access: { level: 'read', project: ({ params }) => ({ kind: 'execution', id: params.id! }) }, tag,
    summary: 'Datensätze für eine Ausführung: Testfall, Überschreibung im Testplan und im Zyklus (Zyklus vor Plan vor Testfall)',
  }, async ({ params }) => {
    const e = await getExecution(db, params.id!);
    const ov = await datasetOverrides(db, e.cycleId, e.testCaseId);
    return { testCase: effectiveDataset(e.version), plan: ov.plan, cycle: ov.cycle, planId: ov.planId, cycleId: e.cycleId, testCaseId: e.testCaseId };
  });
  route(app, {
    method: 'put', path: '/api/dataset-overrides', tag, summary: 'Datensatz eines Testfalls für einen Zyklus bzw. Testplan überschreiben (null = entfernen)',
    access: ({ body }) => { const b = body as { scope: string; scopeId: string }; return { level: 'edit', project: () => ({ kind: b.scope === 'plan' ? 'plan' : 'cycle', id: b.scopeId }) }; },
    body: z.object({ scope: z.enum(['plan', 'cycle']), scopeId: z.uuid(), testCaseId: z.uuid(), dataset: Dataset.nullable() }),
  }, ({ body, actor }) => inTx(db, (tx) => setDatasetOverride(tx, body, actor)));
  route(app, {
    method: 'post', path: '/api/test-cases/:id/run-adhoc', access: { level: 'execute', project: ({ params }) => ({ kind: 'testCase', id: params.id! }) }, tag,
    summary: 'Jetzt ausführen: neue Ausführung im Ad-hoc-Zyklus (des Projekts bzw. Testplans), zugewiesen an mich', status: 201,
    body: z.object({ planId: z.uuid().nullish() }),
  }, ({ params, body, actor }) => inTx(db, (tx) => runAdhoc(tx, params.id!, body, actor)));
  route(app, {
    method: 'post', path: '/api/plans/:id/clone', access: { level: 'edit', project: ({ params }) => ({ kind: 'plan', id: params.id! }) }, tag,
    summary: 'Testplan kopieren (Ziele, Kriterien, Verweise, Datensätze; optional Zyklen mit Testfällen ohne Ergebnisse)', status: 201,
    body: z.object({ name: z.string().trim().min(1).max(200), release: z.string().max(100).nullish(), withCycles: z.boolean().default(true) }),
  }, ({ params, body, actor }) => inTx(db, (tx) => clonePlan(tx, params.id!, body, actor)));
  route(app, {
    method: 'post', path: '/api/executions/bulk', tag,
    summary: 'Massenbearbeitung von Ausführungen: Ergebnis, Kommentar, Zuweisung, Fehler, Felder (Ausführen); Entfernen/Verschieben (Pflegen)',
    access: ({ body }) => {
      const b = body as { ids: string[]; remove?: boolean; moveToCycleId?: string };
      return { level: b.remove || b.moveToCycleId ? 'edit' : 'execute', project: () => b.ids.map((id) => ({ kind: 'execution' as const, id })) };
    },
    body: z.object({
      ids: z.array(z.uuid()).min(1).max(1000),
      status: z.string().optional(), comment: z.string().max(20_000).optional(),
      assignee: z.string().nullable().optional(),
      addDefects: z.array(z.object({ provider: z.string().min(1).optional(), key: z.string().min(1).max(2000), title: z.string().max(80).nullish() })).max(20).optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
      remove: z.boolean().optional(), moveToCycleId: z.uuid().optional(),
    }),
  }, async ({ body, actor, c }) => inTx(db, async (tx) => {
    const lead = body.status !== undefined || body.comment !== undefined || body.assignee !== undefined
      ? await isLead(c, body.ids.map((id) => ({ kind: 'execution' as const, id }))) : true;
    if (body.status !== undefined || body.comment !== undefined) await assertMayRecord(tx, body.ids, actor, lead);
    // Regel „nur Zuständige“: Zuweisen in der Massenbearbeitung wie bei bulk-assign (Review Teil 3, Befund 3)
    if (body.assignee !== undefined) await assertMayAssign(tx, body.ids, body.assignee, actor, lead);
    return bulkExecutions(tx, body, actor, {
      mayOverrideReview: lead,
    requireEvidence: async (projectId) => (await tx<{ r: boolean }[]>`select require_failure_evidence as r from project where id = ${projectId}`)[0]?.r ?? true,
    });
  }));
  route(app, {
    method: 'get', path: '/api/cycles/:id/offline', access: { level: 'read', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag,
    summary: 'Excel-Rundlauf: Arbeitsmappe zum Ausfüllen ohne Anemo (Ausführungen, Schritte, Statuswerte)',
    query: z.object({ assignee: z.string().max(200).optional(), onlyOpen: z.stringbool().optional() }),
  }, async ({ params, query }) => download(await exportOffline(db, params.id!, query)));
  route(app, {
    method: 'post', path: '/api/cycles/:id/offline', access: { level: 'execute', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag,
    summary: 'Excel-Rundlauf: ausgefüllte Arbeitsmappe einlesen (Probelauf, Konflikterkennung, je Zeile einzeln)',
    body: z.object({ contentBase64: z.string().min(1).max(28_000_000), dryRun: z.boolean().default(true), force: z.boolean().optional() }),
  }, async ({ params, body, actor, c }) => {
    const [cy] = await db<{ state: string; requireEvidence: boolean }[]>`select c.state, p.require_failure_evidence as require_evidence from test_cycle c join project p on p.id = c.project_id where c.id = ${params.id!}`;
    if (cy?.state === 'closed') throw badRequest('Der Zyklus ist abgeschlossen – Ergebnisse sind gesperrt.');
    return importOffline(db, params.id!, Buffer.from(body.contentBase64, 'base64'), actor, {
      dryRun: body.dryRun, force: body.force, isLead: await isLead(c, { kind: 'cycle', id: params.id! }), requireEvidence: cy?.requireEvidence ?? true,
    });
  });
  route(app, {
    method: 'post', path: '/api/plans/:id/archive', access: { level: 'edit', project: ({ params }) => ({ kind: 'plan', id: params.id! }) }, tag,
    summary: 'Testplan archivieren (in der Planung ausgeblendet; Berichte und Freigabestände bleiben) bzw. wiederherstellen', body: z.object({ archived: z.boolean() }),
  }, ({ params, body, actor }) => inTx(db, (tx) => setPlanArchived(tx, params.id!, body.archived, actor)));
  route(app, {
    method: 'post', path: '/api/cycles/:id/archive', access: { level: 'edit', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag,
    summary: 'Zyklus archivieren (ausgeblendet und gesperrt) bzw. wiederherstellen', body: z.object({ archived: z.boolean() }),
  }, ({ params, body, actor }) => inTx(db, (tx) => setCycleArchived(tx, params.id!, body.archived, actor)));
  route(app, {
    method: 'delete', path: '/api/cycles/:id', access: { level: 'edit', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag,
    summary: 'Zyklus löschen (nur ohne Ergebnisse; sonst archivieren)',
  }, ({ params, actor }) => inTx(db, (tx) => deleteCycle(tx, params.id!, actor)));
  route(app, {
    method: 'post', path: '/api/executions/bulk-assign', access: { level: 'execute', project: ({ body }) => (body as { ids: string[] }).ids.map((id) => ({ kind: 'execution', id })) }, tag, summary: 'Ausführungen zuweisen (Masse)',
    body: z.object({ ids: z.array(z.uuid()).min(1).max(2000), assignee: z.string().nullable() }),
  }, async ({ body, actor, c }) => inTx(db, async (tx) => {
    // Regel „nur Zuständige“: Neu-/Umzuweisen nur Testleitung, sonst nur nicht zugewiesene sich selbst (Review Teil 3, Befund 3)
    await assertMayAssign(tx, body.ids, body.assignee, actor, await isLead(c, body.ids.map((id) => ({ kind: 'execution' as const, id }))));
    return bulkAssign(tx, body.ids, body.assignee, actor);
  }));
  route(app, {
    method: 'post', path: '/api/cycles/:id/executions', access: { level: 'edit', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag, summary: 'Testfälle (aktuelle Version) in Zyklus aufnehmen',
    body: z.object({ testCaseIds: z.array(z.string()).min(1).max(1000) }),
  }, ({ params, body, actor }) => inTx(db, (tx) => addTestsToCycle(tx, params.id!, body.testCaseIds, actor)));

  route(app, {
    method: 'post', path: '/api/cycles/:id/repeat', access: { level: 'edit', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag,
    summary: 'Zyklus wiederholen: neuer Build, optional nur Nachtest, optional je Konfiguration ein Zyklus', status: 201,
    body: z.object({
      name: z.string().min(1), build: z.string().nullish(), release: z.string().nullish(), onlyProblems: z.boolean().optional(),
      configurations: z.array(z.record(z.string(), z.array(z.string()))).max(20).optional(), keepAssignees: z.boolean().optional(),
    }),
  }, ({ params, body, actor }) => inTx(db, (tx) => repeatCycle(tx, params.id!, body, actor)));
  route(app, {
    // Verteilen ist Aufgabe der Testleitung (Pflegen)
    method: 'post', path: '/api/cycles/:id/distribute', access: { level: 'edit', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag,
    summary: 'Offene Ausführungen nach Auslastung auf Personen verteilen',
    body: z.object({ assignees: z.array(z.string().min(1)).min(1).max(50), onlyUnassigned: z.boolean().default(true), weight: z.enum(['count', 'steps', 'duration']).default('steps') }),
  }, ({ params, body, actor }) => inTx(db, (tx) => distribute(tx, params.id!, body, actor)));
  // ---- Agentische Ausführung und QA-Freigabe (ADR-0024) ----
  route(app, { method: 'get', path: '/api/projects/:key/reviews', access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag,
    summary: 'Freigabe ausstehender Agentenergebnisse und Eskalationen' }, async ({ params }) => reviewQueue(db, (await getProject(db, params.key!)).id));
  route(app, {
    // Prüfung von KI-Agentenergebnissen durch die Testleitung (Pflegen), nie durch Agenten oder die ausführende Person
    method: 'post', path: '/api/executions/:id/review', access: { level: 'edit', project: ({ params }) => ({ kind: 'execution', id: params.id! }) }, tag,
    summary: 'Agentenergebnis freigeben oder ablehnen', body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(2000).nullish(), reassignTo: z.string().nullish() }),
  }, ({ params, body, actor }) => inTx(db, (tx) => reviewResult(tx, params.id!, body, actor)));
  route(app, {
    method: 'post', path: '/api/executions/:id/escalate', access: { level: 'execute', project: ({ params }) => ({ kind: 'execution', id: params.id! }) }, tag,
    summary: 'An einen Menschen übergeben (unklarer Fall)', body: z.object({ reason: z.string().min(3).max(2000) }),
  }, async ({ params, body, actor, c }) => inTx(db, async (tx) => {
    // Eskalieren hebt die Zuweisung auf – unter der Regel „nur Zuständige“ nur für eigene bzw. nicht zugewiesene Ausführungen
    await assertMayRecord(tx, [params.id!], actor, await isLead(c, { kind: 'execution', id: params.id! }));
    return escalate(tx, params.id!, body.reason, actor);
  }));
  route(app, {
    method: 'post', path: '/api/cycles/:id/claim', access: { level: 'execute', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag,
    summary: 'Nächste offene Ausführungen übernehmen (für Agenten und Tester)', body: z.object({ count: z.number().int().min(1).max(50).default(1) }),
  }, async ({ params, body, actor }) => ({ claimed: await inTx(db, (tx) => claimNext(tx, params.id!, body.count, actor)) }));
  route(app, {
    method: 'get', path: '/api/cycle-comparison', tag, summary: 'Zwei Zyklen vergleichen (Regressionen, Behebungen, Unterschiede)',
    access: { level: 'read', project: ({ query }) => [{ kind: 'cycle', id: (query as { a: string }).a }, { kind: 'cycle', id: (query as { b: string }).b }] },
    query: z.object({ a: z.uuid(), b: z.uuid() }),
  }, ({ query }) => compareCycles(db, query.a, query.b));

  route(app, { method: 'get', path: '/api/executions/:id', access: { level: 'read', project: ({ params }) => ({ kind: 'execution', id: params.id! }) }, tag, summary: 'Ausführung inkl. Schritte der referenzierten Version' },
    ({ params }) => getExecution(db, params.id!));
  route(app, {
    method: 'post', path: '/api/executions/:id/result', access: { level: 'execute', project: ({ params }) => ({ kind: 'execution', id: params.id! }) }, tag, summary: 'Ergebnis erfassen (Status, Schrittergebnisse, Defects)',
    body: z.object({
      status: z.string().min(1),
      comment: z.string().nullish(),
      stepResults: z.array(z.object({ stepId: z.string(), status: z.string(), comment: z.string().optional() })).optional(),
      // ohne Anbieter: aus dem Schlüssel abgeleitet (Nummer = OpenProject, sonst Jira)
      defects: z.array(z.object({ provider: z.string().min(1).optional(), key: z.string().min(1), url: HttpUrl.nullish(), title: z.string().nullish(), stepId: z.string().max(200).nullish(), severity: z.enum(SEVERITIES).nullish() })).optional(),
      iterations: z.array(z.object({
        index: z.number().int().min(0), status: z.string().min(1), comment: z.string().nullish(),
        stepResults: z.array(z.object({ stepId: z.string(), status: z.string(), comment: z.string().optional() })).optional(),
      })).max(200).optional(),
      durationSeconds: z.number().min(0).max(86_400).optional(),
      expectedUpdatedAt: z.string().optional(),
      overrideReason: z.string().max(2000).nullish(),
    }),
  }, async ({ params, body, actor, c }) => inTx(db, async (tx) => {
    const lead = await isLead(c, { kind: 'execution', id: params.id! });
    await assertMayRecord(tx, [params.id!], actor, lead);
    // Nachweispflicht bei Fehlschlag/Blockade je Projekt (Standard: an)
    const [p] = await tx<{ requireFailureEvidence: boolean }[]>`select p.require_failure_evidence from test_execution e join test_cycle c on c.id = e.cycle_id join project p on p.id = c.project_id where e.id = ${params.id!}`;
    const defects = body.defects && await Promise.all(body.defects.map(async (d) => ({ ...d, ...await defectKey(d.key, d.provider) })));
    return executeTest(tx, params.id!, { ...body, defects }, actor, { requireEvidence: p?.requireFailureEvidence ?? true, mayOverrideReview: lead });
  }));
  route(app, {
    method: 'put', path: '/api/executions/:id/fields', access: { level: 'execute', project: ({ params }) => ({ kind: 'execution', id: params.id! }) }, tag,
    summary: 'Eigene Felder einer Ausführung setzen (zusammengeführt; leere Werte entfernen das Feld)',
    body: z.object({ values: z.record(z.string(), z.unknown()) }),
  }, ({ params, body, actor }) => inTx(db, async (tx) => {
    const [e] = await tx<{ customFields: Record<string, unknown>; projectId: string; state: string }[]>`
      select e.custom_fields, c.project_id, c.state from test_execution e join test_cycle c on c.id = e.cycle_id where e.id = ${params.id!} for update of e`;
    if (!e) throw badRequest('Ausführung nicht gefunden');
    if (e.state === 'closed') throw badRequest('Der Zyklus ist abgeschlossen – Felder sind gesperrt.');
    const merged = await validateCustomFields(tx, 'execution', e.projectId, { ...e.customFields, ...body.values }, { previous: e.customFields });
    await tx`update test_execution set custom_fields = ${tx.json(merged as never)}, updated_at = now() where id = ${params.id!}`;
    await recordEvent(tx, { type: EventTypes.ExecutionUpdated, aggregateType: 'TestExecution', aggregateId: params.id!, actor, payload: { fields: Object.keys(body.values) } });
    return { customFields: merged };
  }));
  route(app, { method: 'get', path: '/api/executions/:id/results', access: { level: 'read', project: ({ params }) => ({ kind: 'execution', id: params.id! }) }, tag, summary: 'Ergebnis-Historie einer Ausführung (jedes Speichern)' },
    ({ params }) => resultHistory(db, params.id!));
  // Dauerhafte Links (/go/…, siehe platform/links.ts): Ziel in der Oberfläche auflösen (mit den üblichen Leserechten)
  const goAccess = ({ params }: { params: Record<string, string> }) => {
    const kind = ({ ausfuehrung: 'execution', zyklus: 'cycle', plan: 'plan', sitzung: 'session' } as const)[params.kind as 'ausfuehrung'];
    if (!kind) throw badRequest('Unbekannte Art eines Links');
    return { level: 'read' as const, project: () => ({ kind, id: params.id! }) };
  };
  route(app, { method: 'get', path: '/api/go/:kind/:id', tag, summary: 'Dauerhaften Link (/go/ausfuehrung|zyklus|plan|sitzung/<id>) in eine Ansicht auflösen', access: goAccess },
    async ({ params }) => {
      const id = params.id!;
      const [r] = params.kind === 'ausfuehrung'
        ? await db<{ key: string; path: string }[]>`select p.key, 'cycles/' || c.id || '?exec=' || e.id as path from test_execution e join test_cycle c on c.id = e.cycle_id join project p on p.id = c.project_id where e.id = ${id}`
        : params.kind === 'zyklus'
          ? await db<{ key: string; path: string }[]>`select p.key, 'cycles/' || c.id as path from test_cycle c join project p on p.id = c.project_id where c.id = ${id}`
          : params.kind === 'plan'
            ? await db<{ key: string; path: string }[]>`select p.key, 'cycles?plan=' || x.id || '&tab=cockpit' as path from test_plan x join project p on p.id = x.project_id where x.id = ${id}`
            : await db<{ key: string; path: string }[]>`select p.key, 'cycles/' || c.id || '?session=' || x.id as path from exploratory_session x join test_cycle c on c.id = x.cycle_id join project p on p.id = c.project_id where x.id = ${id}`;
      if (!r) throw notFound('Ziel des Links', id);
      return { hash: `#/p/${r.key}/${r.path}` };
    });
  route(app, { method: 'get', path: '/api/executions/:id/update-preview', access: { level: 'read', project: ({ params }) => ({ kind: 'execution', id: params.id! }) }, tag, summary: 'Vorschau: Umstellung auf die aktuelle Testfallfassung (Schritte, Ergebnisse, Vorbedingungen)' },
    ({ params }) => versionUpdatePlan(db, params.id!));
  route(app, { method: 'post', path: '/api/executions/:id/update-version', access: { level: 'execute', project: ({ params }) => ({ kind: 'execution', id: params.id! }) }, tag, summary: 'Offene bzw. begonnene Ausführung auf die aktuelle Testfallfassung umstellen (unveränderte Schrittergebnisse bleiben)' },
    ({ params, actor }) => inTx(db, (tx) => updateExecutionToCurrentVersion(tx, params.id!, actor)));
  route(app, { method: 'post', path: '/api/cycles/:id/update-versions', access: { level: 'execute', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) }, tag, summary: 'Veraltete offene/begonnene Ausführungen eines Zyklus umstellen (dryRun: nur zählen)',
    body: z.object({ executionIds: z.array(z.uuid()).max(5000).optional(), dryRun: z.boolean().optional() }) },
    ({ params, body, actor }) => inTx(db, (tx) => updateCycleToCurrentVersions(tx, params.id!, body, actor)));
  route(app, { method: 'get', path: '/api/test-cases/:id/older-executions', access: { level: 'read', project: ({ params }) => ({ kind: 'testCase', id: params.id! }) }, tag, summary: 'Laufende Ausführungen auf älteren Fassungen des Testfalls' },
    async ({ params }) => executionsOnOlderVersions(db, (await getTestCase(db, params.id!)).id));
  route(app, { method: 'delete', path: '/api/executions/:id', access: { level: 'edit', project: ({ params }) => ({ kind: 'execution', id: params.id! }) }, tag, summary: 'Nicht ausgeführten Eintrag entfernen', status: 204 },
    ({ params }) => removeExecution(db, params.id!));

  route(app, { method: 'get', path: '/api/test-cases/:id/executions', access: { level: 'read', project: ({ params }) => ({ kind: 'testCase', id: params.id! }) }, tag, summary: 'Ausführungshistorie eines Testfalls' },
    async ({ params }) => executionHistory(db, (await getTestCase(db, params.id!)).id));
}
