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

/** Filter einer dynamischen Menge (Format der Adresszeile der Testfallliste: folder, q, status, label, type). */
function filterOf(query: string) {
  const p = new URLSearchParams(query);
  return {
    q: p.get('q') ?? undefined, folderId: p.get('folder') ?? undefined, recursive: !!p.get('folder'),
    status: p.get('status') ?? undefined, label: p.get('label') ?? undefined, testType: p.get('type') ?? undefined,
    priority: p.get('prio') ?? undefined, aql: p.get('aql') ?? undefined,
  };
}

/** Abfrage eines dynamischen Filters beim Speichern prüfen (Syntax und Komplexitätsgrenzen der Abfragesprache). */
function checkFilter(query: string): void {
  const aql = filterOf(query).aql;
  const e = aql ? validate(aql, 'testcase') : null;
  if (e) throw new HttpError(400, `Filter des Testsets, Abfrage Zeichen ${e.pos + 1}: ${e.message}`, { aql: { pos: e.pos, end: e.end, message: e.message } });
}

/** Testfälle einer Menge: IDs und Schlüssel (dynamisch: höchstens 2000). */
export async function resolveTestSet(db: Db, set: TestSet): Promise<{ id: string; key: string; title: string }[]> {
  if (set.kind === 'static') {
    if (!set.testCaseIds.length) return [];
    return db<{ id: string; key: string; title: string }[]>`
      select tc.id, tc.key, v.title from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
      where tc.id = any(${set.testCaseIds}::uuid[]) and tc.project_id = ${set.projectId} and tc.archived_at is null order by tc.key`;
  }
  const out: { id: string; key: string; title: string }[] = [];
  for (let offset = 0; offset < 2000; offset += 500) {
    const page = await searchTestCases(db, { projectId: set.projectId, ...filterOf(set.query ?? ''), limit: 500, offset });
    out.push(...page.items.map((t) => ({ id: t.id, key: t.key, title: t.title })));
    if (page.items.length < 500) break;
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
  kind: z.enum(['static', 'dynamic']), testCaseIds: z.array(z.uuid()).max(5000).optional(), query: z.string().max(2000).nullish(),
});

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
          return { ...s, count: (await searchTestCases(db, { projectId: s.projectId, ...filterOf(s.query ?? ''), limit: 1, offset: 0 })).total };
        } catch {
          return { ...s, count: null, error: 'Filter nicht mehr gültig (z. B. Ordner gelöscht)' };
        }
      })());
      return out;
    });
  route(app, { method: 'post', path: '/api/projects/:key/test-sets', tag, summary: 'Testset anlegen', status: 201, body: SetBody, access: { level: 'edit', project: ({ params }) => project(params.key!) } },
    async ({ params, body, actor }) => {
      const p = await getProject(db, params.key!);
      if (body.kind === 'dynamic' && !body.query) throw badRequest('Dynamisches Testset braucht einen Filter');
      if (body.kind === 'dynamic') checkFilter(body.query!);
      const ids = body.kind === 'static' ? body.testCaseIds ?? [] : [];
      if (ids.length) {
        const [r] = await db<{ n: number }[]>`select count(*)::int as n from test_case where id = any(${ids}::uuid[]) and project_id = ${p.id}`;
        if (r!.n !== new Set(ids).size) throw notFound('Testfall', 'nicht alle im Projekt');
      }
      const [dup] = await db`select 1 from test_set where project_id = ${p.id} and name = ${body.name}`;
      if (dup) throw conflict(`Testset „${body.name}“ gibt es bereits`);
      const [s] = await db<TestSet[]>`insert into test_set(project_id, name, description, kind, test_case_ids, query, created_by)
        values (${p.id}, ${body.name}, ${body.description ?? null}, ${body.kind}, ${[...new Set(ids)]}::uuid[], ${body.kind === 'dynamic' ? body.query ?? null : null}, ${actor}) returning *`;
      return s;
    });
  const setAccess = (level: 'read' | 'edit') => ({ level, project: ({ params }: { params: Record<string, string> }) => ({ kind: 'testSet' as const, id: params.id! }) });
  route(app, { method: 'get', path: '/api/test-sets/:id/test-cases', tag, summary: 'Testfälle eines Testsets (dynamisch: aktuell ausgewertet)', access: setAccess('read') },
    async ({ params }) => resolveTestSet(db, await getSet(db, params.id!)));

  route(app, { method: 'put', path: '/api/test-sets/:id', tag, summary: 'Testset ändern (Name, Beschreibung, Inhalt)', body: SetBody.partial(), access: setAccess('edit') },
    async ({ params, body }) => {
      const s = await getSet(db, params.id!);
      if (body.kind && body.kind !== s.kind) throw badRequest('Die Art eines Testsets (fest/dynamisch) lässt sich nicht ändern');
      if (s.kind === 'dynamic' && body.query !== undefined && !body.query) throw badRequest('Dynamisches Testset braucht einen Filter');
      if (s.kind === 'static' && body.query) throw badRequest('Ein festes Testset hat keinen Filter');
      if (s.kind === 'dynamic' && body.query) checkFilter(body.query);
      if (body.name && body.name !== s.name) {
        const [dup] = await db`select 1 from test_set where project_id = ${s.projectId} and name = ${body.name} and id <> ${s.id}`;
        if (dup) throw conflict(`Testset „${body.name}“ gibt es bereits`);
      }
      if (body.testCaseIds?.length) {
        const [r] = await db<{ n: number }[]>`select count(*)::int as n from test_case where id = any(${body.testCaseIds}::uuid[]) and project_id = ${s.projectId}`;
        if (r!.n !== new Set(body.testCaseIds).size) throw notFound('Testfall', 'nicht alle im Projekt');
      }
      const [u] = await db<TestSet[]>`update test_set set name = ${body.name ?? s.name}, description = ${body.description === undefined ? s.description : body.description ?? null},
        test_case_ids = ${body.testCaseIds ? [...new Set(body.testCaseIds)] : s.testCaseIds}::uuid[], query = ${body.query === undefined ? s.query : body.query ?? null}, updated_at = now()
        where id = ${s.id} returning *`;
      return u;
    });
  route(app, { method: 'delete', path: '/api/test-sets/:id', tag, summary: 'Testset löschen (Testfälle bleiben unverändert)', status: 204, access: setAccess('edit') },
    async ({ params }) => { await db`delete from test_set where id = ${params.id!}`; });
}

export async function getTestSet(db: Db, id: string): Promise<TestSet> {
  return getSet(db, id);
}
