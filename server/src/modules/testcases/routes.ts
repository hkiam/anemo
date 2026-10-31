import { CELL_FIELDS, cellHistory, cellSummary, type CellField } from './cells.ts';
import type { Hono } from 'hono';
import { z } from 'zod';
import { type Db, inTx } from '../../platform/db.ts';
import { badRequest, route } from '../../platform/http.ts';
import { getProject } from '../projects/index.ts';
import { checkPriority, validateCustomFields } from '../fields/index.ts';
import { classicToGherkin, gherkinToClassic, parseGherkin } from './gherkin.ts';
import { TestCaseContent } from './model.ts';
import {
  approveTestCases, bulkUpdate, cloneTestCase, createFolder, createTestCase, getTestCase, getVersion, listFolders, prepareCalls, resolveExecutionSteps,
  listVersions, renameFolder, reviseTestCase, searchTestCases, testCaseFacets, updateTestCaseMeta,
  setArchived, deleteTestCase, moveFolder, deleteFolder, estimateFromHistory,
} from './service.ts';
import { listWorkflow, setTransitions, upsertStatus } from './workflow.ts';
import { exportTestCases, importTestCases, ImportOptions, previewImport } from './transfer.ts';

const tag = 'Testfälle';

/** Vorbedingungen müssen zum Projekt gehören; neu verknüpfte dürfen nicht archiviert sein. */
async function checkPreconditions(db: Db, projectId: string, ids: string[], previous: string[] = []): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await db<{ id: string; archivedAt: Date | null; key: string }[]>`select id, archived_at, key from precondition where project_id = ${projectId} and id = any(${unique}::uuid[])`;
  if (rows.length !== unique.length) throw badRequest('Vorbedingung nicht gefunden (nur Vorbedingungen desselben Projekts)');
  const archived = rows.filter((r) => r.archivedAt && !previous.includes(r.id));
  if (archived.length) throw badRequest(`Archivierte Vorbedingung kann nicht neu verknüpft werden: ${archived.map((r) => r.key).join(', ')}`);
  return unique;
}

/** Probelauf: Änderungen in der Transaktion ausführen, Ergebnis zurückgeben, Transaktion verwerfen. */
class DryRun extends Error { result: unknown; constructor(result: unknown) { super('Probelauf'); this.result = result; } }

export function testCaseRoutes(app: Hono, db: Db): void {
  route(app, { method: 'get', path: '/api/projects/:key/folders', access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag, summary: 'Ordnerbaum eines Projekts (flach, mit parentId)' },
    async ({ params }) => listFolders(db, (await getProject(db, params.key!)).id));

  route(app, {
    method: 'post', path: '/api/projects/:key/folders', access: { level: 'edit', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag, summary: 'Ordner anlegen', status: 201,
    body: z.object({ name: z.string().min(1), parentId: z.uuid().nullish() }),
  }, async ({ params, body }) => {
    const project = await getProject(db, params.key!);
    return createFolder(db, project.id, body.parentId ?? null, body.name);
  });

  route(app, {
    method: 'patch', path: '/api/folders/:id', access: { level: 'edit', project: ({ params }) => ({ kind: 'folder', id: params.id! }) }, tag, summary: 'Ordner umbenennen', status: 204,
    body: z.object({ name: z.string().min(1) }),
  }, ({ params, body }) => renameFolder(db, params.id!, body.name));

  route(app, {
    method: 'get', path: '/api/projects/:key/test-cases', access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag, summary: 'Testfälle suchen (Volltext, Schlüssel, Filter)',
    query: z.object({
      q: z.string().optional(),
      folderId: z.uuid().optional(),
      recursive: z.stringbool().optional(),
      status: z.string().optional(),
      label: z.string().optional(),
      testType: z.string().optional(),
      component: z.string().optional(),
      priority: z.string().optional(),
      archived: z.enum(['all', 'only']).optional(),
      aql: z.string().max(4000).optional(),
      /** nur IDs (bis 5000) – für „alle Treffer“ in der Massenbearbeitung */
      idsOnly: z.stringbool().optional(),
      limit: z.coerce.number().int().min(1).max(5000).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  }, async ({ params, query, actor }) => {
    const { idsOnly, ...q } = query;
    const r = await searchTestCases(db, { projectId: (await getProject(db, params.key!)).id, ...q, limit: idsOnly ? q.limit : Math.min(q.limit, 500), actor });
    return idsOnly ? { total: r.total, ids: r.items.map((t) => t.id) } : r;
  });

  route(app, {
    method: 'post', path: '/api/projects/:key/test-cases', access: { level: 'edit', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag, summary: 'Testfall anlegen (Version 1)', status: 201,
    body: z.object({
      folderId: z.uuid().nullish(),
      owner: z.string().nullish(),
      status: z.string().optional(),
      content: TestCaseContent,
      changeNote: z.string().nullish(),
      /** Kennzeichnung „mit KI erstellt“ (Skill · Modell), z. B. nach einem KI-Entwurf */
      aiAssisted: z.string().max(200).nullish(),
    }),
  }, ({ params, body, actor }) => inTx(db, async (tx) => {
    const project = await getProject(tx, params.key!);
    const content = {
      ...body.content, priority: await checkPriority(tx, body.content.priority),
      customFields: await validateCustomFields(tx, 'test_case', project.id, body.content.customFields, { required: true }),
      steps: await prepareCalls(tx, project.id, null, body.content.steps),
      preconditionIds: await checkPreconditions(tx, project.id, body.content.preconditionIds),
    };
    return createTestCase(tx, { projectId: project.id, ...body, content }, actor, { enforceWorkflow: true });
  }));

  route(app, { method: 'get', path: '/api/test-cases/:id', access: { level: 'read', project: ({ params }) => ({ kind: 'testCase', id: params.id! }) }, tag, summary: 'Testfall mit aktueller Version (ID, Schlüssel oder Jira-Altschlüssel)' },
    async ({ params }) => {
      const tc = await getTestCase(db, params.id!);
      return { ...tc, executionSteps: await resolveExecutionSteps(db, tc.version) };
    });

  route(app, {
    method: 'put', path: '/api/test-cases/:id/content', access: { level: 'edit', project: ({ params }) => ({ kind: 'testCase', id: params.id! }) }, tag, summary: 'Inhalt ändern → neue Version (optimistische Sperre über expectedVersion)',
    body: z.object({ content: TestCaseContent, changeNote: z.string().nullish(), expectedVersion: z.number().int().optional(), aiAssisted: z.string().max(200).nullish() }),
  }, ({ params, body, actor }) => inTx(db, async (tx) => {
    const prev = await getTestCase(tx, params.id!);
    const content = {
      ...body.content, priority: await checkPriority(tx, body.content.priority, prev.version.priority),
      customFields: await validateCustomFields(tx, 'test_case', prev.projectId, body.content.customFields, { required: true, previous: prev.version.customFields }),
      steps: await prepareCalls(tx, prev.projectId, prev.id, body.content.steps),
      preconditionIds: await checkPreconditions(tx, prev.projectId, body.content.preconditionIds, prev.version.preconditionIds),
    };
    return reviseTestCase(tx, params.id!, content, body.changeNote ?? null, actor, body.expectedVersion, body.aiAssisted ?? null);
  }));

  route(app, {
    method: 'patch', path: '/api/test-cases/:id', access: { level: 'edit', project: ({ params }) => ({ kind: 'testCase', id: params.id! }) }, tag, summary: 'Verwaltungsdaten ändern (Ordner, Status, Owner) – keine neue Version',
    body: z.object({ folderId: z.uuid().nullish(), status: z.string().min(1).optional(), owner: z.string().nullish(), estimateMinutes: z.number().int().min(0).max(100000).nullish() }),
  }, ({ params, body, actor }) => inTx(db, (tx) => updateTestCaseMeta(tx, params.id!, body, actor, { enforceWorkflow: true })));

  route(app, { method: 'get', path: '/api/test-cases/:id/versions', access: { level: 'read', project: ({ params }) => ({ kind: 'testCase', id: params.id! }) }, tag, summary: 'Versionshistorie' },
    ({ params }) => listVersions(db, params.id!));

  route(app, { method: 'get', path: '/api/test-cases/:id/cells', access: { level: 'read', project: ({ params }) => ({ kind: 'testCase', id: params.id! }) }, tag,
    summary: 'Letzte Änderung je Schrittzelle (Person, Zeit, Version) bis zur angegebenen Version', query: z.object({ version: z.coerce.number().int().positive().optional() }) },
    async ({ params, query }) => cellSummary(db, (await getTestCase(db, params.id!)).id, query.version));
  route(app, { method: 'get', path: '/api/test-cases/:id/cells/:stepId/:field', access: { level: 'read', project: ({ params }) => ({ kind: 'testCase', id: params.id! }) }, tag,
    summary: 'Verlauf einer Schrittzelle (alle Fassungen)', query: z.object({ version: z.coerce.number().int().positive().optional() }) },
    async ({ params, query }) => {
      if (!(CELL_FIELDS as string[]).includes(params.field!)) throw badRequest('Feld: action, data, expected oder title');
      return cellHistory(db, (await getTestCase(db, params.id!)).id, params.stepId!, params.field as CellField, query.version);
    });
  route(app, { method: 'get', path: '/api/test-cases/:id/versions/:no', access: { level: 'read', project: ({ params }) => ({ kind: 'testCase', id: params.id! }) }, tag, summary: 'Bestimmte Version lesen' },
    async ({ params }) => {
      const tc = await getTestCase(db, params.id!);
      const v = await getVersion(db, tc.id, Number(params.no));
      return { ...v, executionSteps: await resolveExecutionSteps(db, v) };
    });

  route(app, { method: 'post', path: '/api/test-cases/:id/clone', access: { level: 'edit', project: ({ params }) => ({ kind: 'testCase', id: params.id! }) }, tag, summary: 'Testfall kopieren', status: 201 },
    ({ params, actor }) => inTx(db, (tx) => cloneTestCase(tx, params.id!, actor)));

  route(app, {
    method: 'post', path: '/api/test-cases/bulk', access: { level: 'edit', project: ({ body }) => (body as { ids: string[] }).ids.map((id) => ({ kind: 'testCase', id })) }, tag,
    summary: 'Massenbearbeitung: Status, Ordner, Owner, Labels, Komponenten, Priorität, eigene Felder, Archivieren',
    body: z.object({
      ids: z.array(z.string()).min(1).max(1000),
      status: z.string().optional(),
      folderId: z.uuid().nullish(),
      owner: z.string().max(200).nullish(),
      addLabels: z.array(z.string().trim().min(1)).optional(),
      removeLabels: z.array(z.string()).optional(),
      addComponents: z.array(z.string().trim().min(1)).optional(),
      removeComponents: z.array(z.string()).optional(),
      priority: z.string().nullish(),
      fields: z.record(z.string(), z.unknown()).optional(),
      archive: z.boolean().optional(),
      estimateMinutes: z.number().int().min(0).max(100000).nullish(),
    }),
  }, ({ body, actor }) => inTx(db, async (tx) => {
    if (body.status) {
      const [st] = await tx`select 1 from test_case_status where code = ${body.status} and active`;
      if (!st) throw badRequest(`Unbekannter oder inaktiver Status: ${body.status}`);
    }
    const first = await getTestCase(tx, body.ids[0]!);
    const priority = body.priority === undefined ? undefined : body.priority === null ? null : await checkPriority(tx, body.priority);
    // Felder einmal prüfen (gleiche Werte für alle); Pflichtfelder hier nicht erzwingen
    const fields = body.fields ? await validateCustomFields(tx, 'test_case', first.projectId, body.fields) : undefined;
    const blank = body.fields ? Object.fromEntries(Object.keys(body.fields).filter((k) => !(fields && k in fields)).map((k) => [k, null])) : {};
    return bulkUpdate(tx, { ...body, priority, fields: body.fields ? { ...blank, ...fields } : undefined }, actor, { enforceWorkflow: true });
  }));
  route(app, {
    method: 'post', path: '/api/projects/:key/test-cases/approve', access: { level: 'manage', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag,
    summary: 'Massenfreigabe (Testmanagement): Auswahl per ids oder AQL in den Freigabe-Status setzen; eigene Versionen, bereits freigegebene, archivierte und außer Kraft gesetzte werden übersprungen (dryRun: nur zählen)',
    body: z.object({
      ids: z.array(z.string()).min(1).max(5000).optional(),
      aql: z.string().max(4000).optional(),
      status: z.string().optional(),
      note: z.string().max(2000).optional(),
      dryRun: z.boolean().optional(),
    }).refine((b) => !!b.ids !== !!b.aql, 'Entweder ids oder aql angeben'),
  }, ({ params, body, actor }) => inTx(db, async (tx) => {
    const p = await getProject(tx, params.key!);
    let ids = body.ids;
    if (body.aql) {
      const r = await searchTestCases(tx, { projectId: p.id, aql: body.aql, limit: 5000, offset: 0, actor });
      if (r.total > 5000) throw badRequest(`Die Abfrage trifft ${r.total} Testfälle – höchstens 5000 je Freigabe, bitte eingrenzen`);
      ids = r.items.map((t) => t.id);
    }
    const own = await tx<{ id: string }[]>`select id from test_case where project_id = ${p.id} and (id::text = any(${ids!}::text[]) or key = any(${ids!}::text[]))`;
    if (own.length !== new Set(ids).size) throw badRequest('Auswahl enthält unbekannte Testfälle oder Testfälle anderer Projekte');
    const r = await approveTestCases(tx, own.map((x) => x.id), actor, { status: body.status, note: body.note });
    if (body.dryRun) throw new DryRun(r);
    return r;
  }).catch((e) => { if (e instanceof DryRun) return { ...(e.result as object), dryRun: true }; throw e; }));
  // ---- Export und Import (Stufe H1) ----
  const download = (f: { fileName: string; contentType: string; body: Buffer }) => new Response(new Uint8Array(f.body), {
    headers: { 'content-type': f.contentType, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.fileName)}`, 'cache-control': 'no-store' },
  });
  route(app, {
    method: 'get', path: '/api/projects/:key/test-cases/export', access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag,
    summary: 'Testfälle als Excel/CSV (je Schritt eine Zeile; gleiche Filter wie die Liste oder ids=…)',
    query: z.object({
      format: z.enum(['xlsx', 'csv']).default('xlsx'), ids: z.string().optional(),
      q: z.string().optional(), folderId: z.uuid().optional(), recursive: z.stringbool().optional(), status: z.string().optional(), label: z.string().optional(),
      testType: z.string().optional(), component: z.string().optional(), priority: z.string().optional(), archived: z.enum(['all', 'only']).optional(), aql: z.string().max(4000).optional(),
    }),
  }, async ({ params, query, actor }) => {
    const p = await getProject(db, params.key!);
    const { format, ids, ...filters } = query;
    const idList = ids ? ids.split(',').filter(Boolean).slice(0, 20_000) : undefined;
    if (idList) {
      const own = await db<{ id: string }[]>`select id from test_case where project_id = ${p.id} and id = any(${idList}::uuid[])`;
      if (own.length !== idList.length) throw badRequest('Auswahl enthält Testfälle anderer Projekte');
    }
    return download(await exportTestCases(db, { projectId: p.id, ...filters, actor, limit: 1000, offset: 0, ids: idList }, format, p.key));
  });
  const ImportFile = z.object({ fileName: z.string().min(1).max(255), contentBase64: z.string().min(1), sheet: z.number().int().min(0).optional() });
  route(app, {
    method: 'post', path: '/api/projects/:key/test-cases/import/preview', access: { level: 'edit', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag,
    summary: 'Import-Vorschau: Tabellenblätter, Spalten, erkannte Zuordnung, erste Zeilen', body: ImportFile,
  }, async ({ params, body }) => previewImport(db, (await getProject(db, params.key!)).id, body));
  route(app, {
    method: 'post', path: '/api/projects/:key/test-cases/import', access: { level: 'edit', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag,
    summary: 'Testfälle aus Excel/CSV anlegen bzw. per Schlüssel aktualisieren (dryRun: nur prüfen)', body: ImportFile.extend(ImportOptions.shape),
  }, async ({ params, body, actor }) => {
    const { mapping, mode, folderId, dryRun, changeNote, ...file } = body;
    return importTestCases(db, (await getProject(db, params.key!)).id, file, { mapping, mode, folderId, dryRun, changeNote }, actor);
  });
  route(app, {
    method: 'post', path: '/api/test-cases/estimate-from-history', access: { level: 'edit', project: ({ body }) => (body as { ids: string[] }).ids.map((id) => ({ kind: 'testCase', id })) }, tag,
    summary: 'Schätzung aus Erfahrungswerten (Median der gemessenen Dauer, ab zwei Messungen)', body: z.object({ ids: z.array(z.string()).min(1).max(1000) }),
  }, ({ body, actor }) => inTx(db, (tx) => estimateFromHistory(tx, body.ids, actor)));
  route(app, {
    method: 'post', path: '/api/test-cases/archive', access: { level: 'edit', project: ({ body }) => (body as { ids: string[] }).ids.map((id) => ({ kind: 'testCase', id })) }, tag,
    summary: 'Testfälle archivieren bzw. wiederherstellen', body: z.object({ ids: z.array(z.string()).min(1).max(1000), archived: z.boolean() }),
  }, ({ body, actor }) => inTx(db, (tx) => setArchived(tx, body.ids, body.archived, actor)));
  route(app, {
    method: 'delete', path: '/api/test-cases/:id', access: { level: 'manage', project: ({ params }) => ({ kind: 'testCase', id: params.id! }) }, tag,
    summary: 'Testfall endgültig löschen (Projektadmin; nur wenn nie eingeplant – sonst archivieren)',
  }, ({ params, actor }) => inTx(db, (tx) => deleteTestCase(tx, params.id!, actor)));
  route(app, {
    method: 'post', path: '/api/folders/:id/move', access: { level: 'edit', project: ({ params }) => ({ kind: 'folder', id: params.id! }) }, tag,
    summary: 'Ordner verschieben (parentId null = oberste Ebene)', status: 204, body: z.object({ parentId: z.uuid().nullable() }),
  }, ({ params, body, actor }) => inTx(db, (tx) => moveFolder(tx, params.id!, body.parentId, actor)));
  route(app, {
    method: 'delete', path: '/api/folders/:id', access: { level: 'edit', project: ({ params }) => ({ kind: 'folder', id: params.id! }) }, tag,
    summary: 'Ordner löschen (leer; mit moveContents=true wandern Testfälle und Unterordner eine Ebene nach oben)',
    query: z.object({ moveContents: z.stringbool().optional() }),
  }, ({ params, query, actor }) => inTx(db, (tx) => deleteFolder(tx, params.id!, query.moveContents ?? false, actor)));

  route(app, {
    method: 'get', path: '/api/projects/:key/test-case-facets', tag, summary: 'Filterwerte (Labels, Komponenten, Testarten) mit Anzahl',
    access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
  }, async ({ params }) => testCaseFacets(db, (await getProject(db, params.key!)).id));

  // ---- Workflow ----
  const wtag = 'Status & Workflow';
  route(app, { method: 'get', path: '/api/test-case-workflow', tag: wtag, summary: 'Testfall-Status mit Kategorie und erlaubte Übergänge' },
    () => listWorkflow(db));
  route(app, {
    method: 'put', path: '/api/admin/test-case-statuses/:code', access: 'admin', tag: wtag, summary: 'Testfall-Status anlegen/ändern', status: 204,
    body: z.object({
      name: z.string().min(1).max(60), category: z.enum(['DRAFT', 'REVIEW', 'APPROVED', 'DEPRECATED']),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/), sortOrder: z.number().int(), active: z.boolean(), isInitial: z.boolean(),
      description: z.string().max(500).nullable(),
    }),
  }, ({ params, body }) => {
    if (!/^[\p{L}\p{N} _!./-]{1,40}$/u.test(params.code!)) throw badRequest('Code: 1–40 Zeichen');
    return inTx(db, (tx) => upsertStatus(tx, params.code!, body));
  });
  route(app, {
    method: 'put', path: '/api/admin/test-case-transitions', access: 'admin', tag: wtag, summary: 'Erlaubte Übergänge ersetzen', status: 204,
    body: z.object({ transitions: z.array(z.object({ from: z.string(), to: z.string() })).max(2000) }),
  }, ({ body }) => inTx(db, (tx) => setTransitions(tx, body.transitions)));

  // ---- Gherkin ----
  const Gherkin = z.object({ gherkin: z.string() });

  route(app, { method: 'post', path: '/api/gherkin/validate', tag: 'Gherkin', summary: 'Gherkin prüfen (Fehler/Warnungen mit Zeilennummer)', body: Gherkin },
    async ({ body }) => parseGherkin(body.gherkin));

  route(app, {
    method: 'post', path: '/api/gherkin/from-classic', tag: 'Gherkin', summary: 'Vorschlag: klassische Schritte → Gherkin (speichert nichts)',
    body: z.object({
      title: z.string(), objective: z.string().nullish(), preconditions: z.string().nullish(),
      steps: z.array(z.object({ action: z.string().optional(), data: z.string().optional(), expected: z.string().optional() })),
      language: z.enum(['de', 'en']).default('de'),
    }),
  }, async ({ body }) => classicToGherkin(body, body.language));

  route(app, { method: 'post', path: '/api/gherkin/to-classic', tag: 'Gherkin', summary: 'Vorschlag: Gherkin → klassische Schritte (speichert nichts)', body: Gherkin },
    async ({ body }) => gherkinToClassic(body.gherkin));
}
