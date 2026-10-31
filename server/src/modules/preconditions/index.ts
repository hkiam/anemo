/**
 * Modul preconditions (Stufe H): wiederverwendbare, versionierte Vorbedingungen (Schlüssel PROJ-P1), z. B.
 * „Testmandant mit Akte vorbereitet“. Testfallversionen verweisen darauf; eine Änderung wirkt in allen
 * verwendenden Testfällen und ist über die Versionen nachvollziehbar.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { type Db, inTx } from '../../platform/db.ts';
import { badRequest, conflict, notFound, route } from '../../platform/http.ts';
import { getProject } from '../projects/index.ts';

export interface Precondition {
  id: string; projectId: string; key: string; title: string; content: string | null; currentVersion: number;
  archivedAt: Date | null; createdAt: Date; createdBy: string; updatedAt: Date; usage?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getPrecondition(db: Db, idOrKey: string): Promise<Precondition> {
  const [p] = UUID_RE.test(idOrKey)
    ? await db<Precondition[]>`select * from precondition where id = ${idOrKey}`
    : await db<Precondition[]>`select * from precondition where key = ${idOrKey.toUpperCase()}`;
  if (!p) throw notFound('Vorbedingung', idOrKey);
  return p;
}

/**
 * Vorbedingungen in der gewünschten Reihenfolge (für Testfallansicht, Durchführung, Berichte). Mit `pinned`
 * (Vorbedingung → Versionsnummer, z. B. festgehalten beim Einplanen einer Ausführung, Stufe J2) wird die damalige
 * Fassung gezeigt statt der aktuellen.
 */
export async function preconditionsByIds(db: Db, ids: string[], pinned?: Record<string, number> | null): Promise<{ id: string; key: string; title: string; content: string | null; versionNo: number; currentVersion: number; archived: boolean }[]> {
  if (!ids.length) return [];
  const rows = await db<{ id: string; key: string; title: string; content: string | null; currentVersion: number; archivedAt: Date | null }[]>`
    select id, key, title, content, current_version, archived_at from precondition where id = any(${ids}::uuid[])`;
  const wanted = Object.entries(pinned ?? {}).filter(([id, no]) => rows.some((r) => r.id === id && r.currentVersion !== no));
  const old = wanted.length ? (await db<{ preconditionId: string; versionNo: number; title: string; content: string | null }[]>`
    select precondition_id, version_no, title, content from precondition_version
    where precondition_id = any(${wanted.map(([id]) => id)}::uuid[]) and version_no = any(${wanted.map(([, no]) => no)}::int[])`)
    .filter((o) => pinned![o.preconditionId] === o.versionNo) : [];
  return ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean).map((r) => {
    const v = old.find((o) => o.preconditionId === r!.id);
    return { id: r!.id, key: r!.key, title: v?.title ?? r!.title, content: v ? v.content : r!.content, versionNo: v?.versionNo ?? r!.currentVersion,
      currentVersion: r!.currentVersion, archived: !!r!.archivedAt };
  });
}

const Body = z.object({ title: z.string().trim().min(1).max(300), content: z.string().max(50_000).nullish() });

export function preconditionRoutes(app: Hono, db: Db): void {
  const tag = 'Vorbedingungen';
  const proj = (level: 'read' | 'edit') => ({ level, project: ({ params }: { params: Record<string, string> }) => ({ kind: 'project' as const, key: params.key! }) });
  const one = (level: 'read' | 'edit') => ({ level, project: ({ params }: { params: Record<string, string> }) => ({ kind: 'precondition' as const, id: params.id! }) });
  // Verwendung: Testfälle, deren aktuelle Version auf die Vorbedingung verweist
  const usage = db`(select count(*)::int from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
      where p.id = any(v.precondition_ids) and tc.archived_at is null)`;

  route(app, {
    method: 'get', path: '/api/projects/:key/preconditions', access: proj('read'), tag, summary: 'Vorbedingungen des Projekts (Suche, mit Verwendung)',
    query: z.object({ q: z.string().optional(), archived: z.stringbool().optional(), ids: z.string().optional() }),
  }, async ({ params, query }) => {
    const p0 = await getProject(db, params.key!);
    const ids = query.ids?.split(',').filter((x) => UUID_RE.test(x)) ?? [];
    return db<Precondition[]>`select p.*, ${usage} as usage from precondition p where p.project_id = ${p0.id}
      ${ids.length ? db`and p.id = any(${ids}::uuid[])` : query.archived ? db`` : db`and p.archived_at is null`}
      ${query.q?.trim() ? db`and (p.title ilike ${`%${query.q.trim()}%`} or p.key ilike ${`%${query.q.trim()}%`} or p.content ilike ${`%${query.q.trim()}%`})` : db``}
      order by p.archived_at nulls first, length(p.key), p.key limit 500`;
  });
  route(app, { method: 'post', path: '/api/projects/:key/preconditions', access: proj('edit'), tag, summary: 'Vorbedingung anlegen', body: Body, status: 201 },
    ({ params, body, actor }) => inTx(db, async (tx) => {
      const p0 = await getProject(tx, params.key!);
      const [n] = await tx<{ n: number }[]>`update project set next_precondition = next_precondition + 1 where id = ${p0.id} returning next_precondition - 1 as n`;
      const key = `${p0.key}-P${n!.n}`;
      const [pc] = await tx<Precondition[]>`insert into precondition(project_id, key, title, content, created_by) values (${p0.id}, ${key}, ${body.title}, ${body.content ?? null}, ${actor}) returning *`;
      await tx`insert into precondition_version(precondition_id, version_no, title, content, change_note, created_by) values (${pc!.id}, 1, ${body.title}, ${body.content ?? null}, null, ${actor})`;
      return pc;
    }));
  route(app, { method: 'get', path: '/api/preconditions/:id', access: one('read'), tag, summary: 'Vorbedingung mit Versionen und verwendenden Testfällen' },
    async ({ params }) => {
      const p = await getPrecondition(db, params.id!);
      const versions = await db`select version_no, title, change_note, created_at, created_by from precondition_version where precondition_id = ${p.id} order by version_no desc`;
      const usedBy = await db<{ key: string; title: string }[]>`select tc.key, v.title from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
        where ${p.id}::uuid = any(v.precondition_ids) and tc.archived_at is null order by length(tc.key), tc.key limit 500`;
      return { ...p, versions, usedBy };
    });
  route(app, { method: 'get', path: '/api/preconditions/:id/versions/:no', access: one('read'), tag, summary: 'Bestimmte Version' },
    async ({ params }) => {
      const p = await getPrecondition(db, params.id!);
      const [v] = await db`select * from precondition_version where precondition_id = ${p.id} and version_no = ${Number(params.no)}`;
      if (!v) throw notFound('Version', params.no);
      return v;
    });
  route(app, {
    method: 'put', path: '/api/preconditions/:id', access: one('edit'), tag, summary: 'Vorbedingung ändern → neue Version (wirkt in allen verwendenden Testfällen)',
    body: Body.extend({ changeNote: z.string().max(500).nullish(), expectedVersion: z.number().int().optional() }),
  }, ({ params, body, actor }) => inTx(db, async (tx) => {
    const [p] = await tx<Precondition[]>`select * from precondition where id = ${(await getPrecondition(tx, params.id!)).id} for update`;
    if (body.expectedVersion !== undefined && body.expectedVersion !== p!.currentVersion) throw conflict(`Vorbedingung wurde zwischenzeitlich geändert (aktuell v${p!.currentVersion})`);
    if (p!.title === body.title && (p!.content ?? null) === (body.content ?? null)) return p;
    const next = p!.currentVersion + 1;
    await tx`insert into precondition_version(precondition_id, version_no, title, content, change_note, created_by) values (${p!.id}, ${next}, ${body.title}, ${body.content ?? null}, ${body.changeNote ?? null}, ${actor})`;
    const [u] = await tx<Precondition[]>`update precondition set title = ${body.title}, content = ${body.content ?? null}, current_version = ${next}, updated_at = now() where id = ${p!.id} returning *`;
    return u;
  }));
  route(app, {
    method: 'post', path: '/api/preconditions/:id/archive', access: one('edit'), tag, summary: 'Archivieren (nicht mehr neu verknüpfbar; bestehende Verweise bleiben) bzw. wiederherstellen',
    body: z.object({ archived: z.boolean() }),
  }, async ({ params, body }) => {
    const p = await getPrecondition(db, params.id!);
    const [u] = await db<Precondition[]>`update precondition set archived_at = ${body.archived ? new Date() : null}, updated_at = now() where id = ${p.id} returning *`;
    return u;
  });
  route(app, { method: 'delete', path: '/api/preconditions/:id', access: one('edit'), tag, summary: 'Löschen (nur wenn nie verwendet; sonst archivieren)', status: 204 },
    async ({ params }) => {
      const p = await getPrecondition(db, params.id!);
      const [used] = await db`select 1 from test_case_version where ${p.id}::uuid = any(precondition_ids) limit 1`;
      if (used) throw badRequest(`${p.key} wird in Testfällen (auch älteren Versionen) verwendet – bitte archivieren.`);
      await db`delete from precondition where id = ${p.id}`;
    });
}
