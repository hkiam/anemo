/**
 * Testsets (Stufe G4): wiederkehrende Auswahlen wie „Smoke“ oder „Regression Kern“.
 * - statisch: feste Liste von Testfällen
 * - dynamisch: gespeicherter Filter der Testfallliste (Suche, Ordner inkl. Unterordner, Status, Label, Testart),
 *   wird bei jeder Verwendung neu ausgewertet
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { badRequest, conflict, HttpError, notFound, route } from '../../platform/http.ts';
import { validate } from '../../../../shared/aql/aql.ts';
import { getProject } from '../projects/index.ts';
import { searchTestCases } from './service.ts';

export interface TestSet {
  id: string; projectId: string; name: string; description: string | null; kind: 'static' | 'dynamic';
  testCaseIds: string[]; query: string | null; createdBy: string; createdAt: Date; updatedAt: Date;
}

/** Schlüssel der Adresszeile der Testfallliste (kanonisch) samt gängiger Alternativen (Namen der Such-API). */
const FILTER_KEYS: Record<string, 'q' | 'folder' | 'status' | 'label' | 'type' | 'prio' | 'aql'> = {
  q: 'q', folder: 'folder', folderId: 'folder', status: 'status', label: 'label', type: 'type', testType: 'type',
  prio: 'prio', priority: 'prio', aql: 'aql', query: 'aql',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUERY_HELP = 'Erwartet: Adresszeile der Testfallliste (z. B. „aql=label = \"smoke\"“ oder „label=smoke&status=APPROVED“), '
  + 'ein Objekt wie {"aql": "label = \\"smoke\\""} oder eine reine Abfrage (AQL) wie „label = \"smoke\"“. '
  + 'Erlaubte Schlüssel: q, folder, status, label, type, prio, aql.';

/**
 * Gespeicherten Filter einer dynamischen Menge in die kanonische Form (Adresszeile der Testfallliste) bringen.
 * Angenommen werden: Adresszeile (q=…&aql=…), Objekt bzw. JSON-Objekt ({aql: …}) und reine Abfrage (AQL).
 * Unbekannte Schlüssel, unauswertbare oder leere Filter werden mit 400 abgelehnt – nie stillschweigend „alle Testfälle“.
 */
export function normalizeTestSetQuery(input: string | Record<string, unknown>): string {
  let entries: [string, unknown][];
  if (typeof input === 'string') {
    const raw = input.trim();
    if (!raw) throw badRequest(`Dynamisches Testset braucht einen Filter. ${QUERY_HELP}`);
    if (raw.startsWith('{')) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw badRequest(`Filter des Testsets ist kein gültiges JSON-Objekt. ${QUERY_HELP}`); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw badRequest(`Filter des Testsets ist kein Objekt. ${QUERY_HELP}`);
      entries = Object.entries(parsed as Record<string, unknown>);
    } else {
      const p = [...new URLSearchParams(raw)];
      // Adresszeile nur, wenn alle Schlüssel bekannt sind – sonst ist es eine reine Abfrage (z. B. „label = "x"“ → Schlüssel „label “)
      entries = p.length && p.every(([k]) => k in FILTER_KEYS) ? p : [['aql', raw]];
    }
  } else entries = Object.entries(input);
  const unknown = entries.filter(([k]) => !(k in FILTER_KEYS)).map(([k]) => k);
  if (unknown.length) throw badRequest(`Unbekannte Schlüssel im Filter des Testsets: ${unknown.join(', ')}. ${QUERY_HELP}`);
  const out = new URLSearchParams();
  for (const [k, v] of entries) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' && typeof v !== 'number') throw badRequest(`Filterwert „${k}“ muss Text sein. ${QUERY_HELP}`);
    const key = FILTER_KEYS[k]!;
    // einfache Filter (label=smoke): umschließende Anführungszeichen wie in AQL gehören nicht zum Wert
    let val = String(v).trim();
    if (key !== 'aql' && key !== 'q' && /^"[^"]*"$/.test(val)) val = val.slice(1, -1);
    if (!val) continue;
    if (key === 'folder' && !UUID.test(val)) throw badRequest(`Filter des Testsets: folder muss eine Ordner-ID (UUID) sein, nicht „${val}“`);
    if (out.has(key)) throw badRequest(`Filter des Testsets: Schlüssel „${key}“ mehrfach angegeben`);
    out.set(key, val);
  }
  if (![...out.keys()].length) throw badRequest(`Dynamisches Testset braucht einen nicht leeren Filter. ${QUERY_HELP}`);
  const aql = out.get('aql');
  const e = aql ? validate(aql, 'testcase') : null;
  if (e) throw new HttpError(400, `Filter des Testsets, Abfrage Zeichen ${e.pos + 1}: ${e.message}`, { aql: { pos: e.pos, end: e.end, message: e.message } });
  return out.toString();
}

/** Filter einer dynamischen Menge (Format der Adresszeile der Testfallliste: folder, q, status, label, type, prio, aql). */
function filterOf(query: string | null) {
  // auch ältere, nicht normalisiert gespeicherte Filter (z. B. reine AQL) auswerten; unauswertbare → 400 statt „alle“
  const p = new URLSearchParams(normalizeTestSetQuery(query ?? ''));
  return {
    q: p.get('q') ?? undefined, folderId: p.get('folder') ?? undefined, recursive: !!p.get('folder'),
    status: p.get('status') ?? undefined, label: p.get('label') ?? undefined, testType: p.get('type') ?? undefined,
    priority: p.get('prio') ?? undefined, aql: p.get('aql') ?? undefined,
  };
}

/**
 * Testfälle einer Menge: IDs und Schlüssel. Dynamisch höchstens {@code max} (Standard 2000);
 * mit {@code strict} führt eine größere Treffermenge zu 400 statt zum Abschneiden.
 */
export async function resolveTestSet(db: Db, set: TestSet, opts: { max?: number; strict?: boolean } = {}): Promise<{ id: string; key: string; title: string }[]> {
  if (set.kind === 'static') {
    if (!set.testCaseIds.length) return [];
    return db<{ id: string; key: string; title: string }[]>`
      select tc.id, tc.key, v.title from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
      where tc.id = any(${set.testCaseIds}::uuid[]) and tc.project_id = ${set.projectId} and tc.archived_at is null order by tc.key`;
  }
  const max = opts.max ?? 2000;
  const filter = filterOf(set.query);
  const out: { id: string; key: string; title: string }[] = [];
  for (let offset = 0; offset < max; offset += 500) {
    const page = await searchTestCases(db, { projectId: set.projectId, ...filter, limit: Math.min(500, max - offset), offset });
    if (opts.strict && page.total > max) throw badRequest(`Das Testset „${set.name}“ umfasst ${page.total} Testfälle – höchstens ${max} auf einmal. Filter eingrenzen.`);
    out.push(...page.items.map((t) => ({ id: t.id, key: t.key, title: t.title })));
    if (out.length >= page.total || page.items.length === 0) break;
  }
  return out;
}

async function getSet(db: Db, id: string): Promise<TestSet> {
  const [s] = await db<TestSet[]>`select * from test_set where id = ${id}`;
  if (!s) throw notFound('Testset', id);
  return s;
}

const SetBody = z.object({
  name: z.string().trim().min(1).max(120), description: z.string().max(2000).nullish(),
  kind: z.enum(['static', 'dynamic']), testCaseIds: z.array(z.uuid()).max(5000).optional(),
  query: z.union([z.string().max(2000), z.record(z.string(), z.unknown())]).nullish()
    .describe('nur dynamisch: Filter der Testfallliste als Adresszeile (z. B. aql=label%20%3D%20%22smoke%22 oder label=smoke&status=APPROVED), '
      + 'als Objekt ({"aql": "label = \\"smoke\\""}) oder als reine AQL (label = "smoke"). Schlüssel: q, folder, status, label, type, prio, aql.'),
  aql: z.string().max(2000).optional().describe('nur dynamisch: Kurzform für query = {aql}'),
});

/** Filter aus Eingabe (query bzw. Kurzform aql) – normalisiert; undefined = nicht angegeben, null = entfernen. */
function queryOf(body: { query?: string | Record<string, unknown> | null | undefined; aql?: string | undefined }): string | null | undefined {
  if (body.aql !== undefined) {
    if (body.query) throw badRequest('Filter entweder als query oder als aql angeben, nicht beides');
    return normalizeTestSetQuery({ aql: body.aql });
  }
  if (body.query === undefined) return undefined;
  if (body.query === null || body.query === '') return null;
  return normalizeTestSetQuery(body.query);
}

export function testSetRoutes(app: Hono, db: Db): void {
  const tag = 'Testsets';
  const project = (key: string) => ({ kind: 'project' as const, key });
  route(app, { method: 'get', path: '/api/projects/:key/test-sets', tag, summary: 'Testsets des Projekts mit Anzahl', access: { level: 'read', project: ({ params }) => project(params.key!) } },
    async ({ params }) => {
      const p = await getProject(db, params.key!);
      const sets = await db<TestSet[]>`select * from test_set where project_id = ${p.id} order by name`;
      // Anzahl günstig: statisch = vorhandene Testfälle, dynamisch = Trefferzahl des Filters; Fehler je Set isoliert.
      // Nacheinander statt alle parallel: viele dynamische Sets dürfen den Verbindungspool nicht belegen
      // (Sicherheitsreview Teil 2, Befund 9; jede einzelne Abfrage ist zusätzlich durch statement_timeout begrenzt).
      const out = [];
      for (const s of sets) out.push(await (async () => {
        try {
          if (s.kind === 'static') {
            const [r] = await db<{ n: number }[]>`select count(*)::int as n from test_case where id = any(${s.testCaseIds}::uuid[]) and project_id = ${s.projectId}`;
            return { ...s, count: r?.n ?? 0 };
          }
          return { ...s, count: (await searchTestCases(db, { projectId: s.projectId, ...filterOf(s.query), limit: 1, offset: 0 })).total };
        } catch {
          return { ...s, count: null, error: 'Filter nicht mehr gültig (z. B. Ordner gelöscht oder Abfrage nicht auswertbar)' };
        }
      })());
      return out;
    });
  route(app, { method: 'post', path: '/api/projects/:key/test-sets', tag, summary: 'Testset anlegen', status: 201, body: SetBody, access: { level: 'edit', project: ({ params }) => project(params.key!) } },
    async ({ params, body, actor }) => {
      const p = await getProject(db, params.key!);
      const query = queryOf(body);
      if (body.kind === 'dynamic' && !query) throw badRequest('Dynamisches Testset braucht einen Filter (query oder aql)');
      if (body.kind === 'static' && query) throw badRequest('Ein festes Testset hat keinen Filter');
      const ids = body.kind === 'static' ? body.testCaseIds ?? [] : [];
      if (ids.length) {
        const [r] = await db<{ n: number }[]>`select count(*)::int as n from test_case where id = any(${ids}::uuid[]) and project_id = ${p.id}`;
        if (r!.n !== new Set(ids).size) throw notFound('Testfall', 'nicht alle im Projekt');
      }
      const [dup] = await db`select 1 from test_set where project_id = ${p.id} and name = ${body.name}`;
      if (dup) throw conflict(`Testset „${body.name}“ gibt es bereits`);
      const [s] = await db<TestSet[]>`insert into test_set(project_id, name, description, kind, test_case_ids, query, created_by)
        values (${p.id}, ${body.name}, ${body.description ?? null}, ${body.kind}, ${[...new Set(ids)]}::uuid[], ${body.kind === 'dynamic' ? query ?? null : null}, ${actor}) returning *`;
      return s;
    });
  const setAccess = (level: 'read' | 'edit') => ({ level, project: ({ params }: { params: Record<string, string> }) => ({ kind: 'testSet' as const, id: params.id! }) });
  route(app, { method: 'get', path: '/api/test-sets/:id/test-cases', tag, summary: 'Testfälle eines Testsets (dynamisch: aktuell ausgewertet)', access: setAccess('read') },
    async ({ params }) => resolveTestSet(db, await getSet(db, params.id!)));

  route(app, { method: 'put', path: '/api/test-sets/:id', tag, summary: 'Testset ändern (Name, Beschreibung, Inhalt)', body: SetBody.partial(), access: setAccess('edit') },
    async ({ params, body }) => {
      const s = await getSet(db, params.id!);
      if (body.kind && body.kind !== s.kind) throw badRequest('Die Art eines Testsets (fest/dynamisch) lässt sich nicht ändern');
      const query = queryOf(body);
      if (s.kind === 'dynamic' && query === null) throw badRequest('Dynamisches Testset braucht einen Filter (query oder aql)');
      if (s.kind === 'static' && query) throw badRequest('Ein festes Testset hat keinen Filter');
      if (body.name && body.name !== s.name) {
        const [dup] = await db`select 1 from test_set where project_id = ${s.projectId} and name = ${body.name} and id <> ${s.id}`;
        if (dup) throw conflict(`Testset „${body.name}“ gibt es bereits`);
      }
      if (body.testCaseIds?.length) {
        const [r] = await db<{ n: number }[]>`select count(*)::int as n from test_case where id = any(${body.testCaseIds}::uuid[]) and project_id = ${s.projectId}`;
        if (r!.n !== new Set(body.testCaseIds).size) throw notFound('Testfall', 'nicht alle im Projekt');
      }
      const [u] = await db<TestSet[]>`update test_set set name = ${body.name ?? s.name}, description = ${body.description === undefined ? s.description : body.description ?? null},
        test_case_ids = ${body.testCaseIds ? [...new Set(body.testCaseIds)] : s.testCaseIds}::uuid[], query = ${query === undefined ? s.query : query}, updated_at = now()
        where id = ${s.id} returning *`;
      return u;
    });
  route(app, { method: 'delete', path: '/api/test-sets/:id', tag, summary: 'Testset löschen (Testfälle bleiben unverändert)', status: 204, access: setAccess('edit') },
    async ({ params }) => { await db`delete from test_set where id = ${params.id!}`; });
}

export async function getTestSet(db: Db, id: string): Promise<TestSet> {
  return getSet(db, id);
}
