/**
 * Modul steplib (Stufe I): Schrittbibliothek – benannte, wiederkehrende Schrittfolgen („Anmelden als Sachbearbeitung“,
 * „Akte über die Suche öffnen“), die in Testfälle als Kopie eingefügt werden. Eingefügte Schritte tragen die Herkunft
 * (`blockId`), damit sich die Verwendung zeigen lässt. Anders als ein aufrufbarer Test (Call Test) bleiben die Schritte
 * danach im Testfall frei änderbar – für zentral gepflegte Abläufe ist der Aufruf die bessere Wahl.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { notFound, route } from '../../platform/http.ts';
import { getProject } from '../projects/index.ts';
import { fieldTemplateRoutes } from './templates.ts';

export interface StepBlock {
  id: string; projectId: string; name: string; description: string | null; steps: { action: string; data: string; expected: string }[];
  tags: string[]; createdAt: Date; createdBy: string; updatedAt: Date; updatedBy: string; archivedAt: Date | null; usage?: number;
}

const BlockStep = z.object({ action: z.string().max(20_000).default(''), data: z.string().max(20_000).default(''), expected: z.string().max(20_000).default('') });
const Body = z.object({
  name: z.string().trim().min(1).max(200), description: z.string().max(5000).nullish(),
  steps: z.array(BlockStep).min(1).max(100).refine((s) => s.some((x) => x.action.trim() || x.expected.trim()), 'Mindestens ein Schritt mit Inhalt'),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
});

export function stepLibraryRoutes(app: Hono, db: Db): void {
  fieldTemplateRoutes(app, db);
  const tag = 'Schrittbibliothek';
  const proj = (level: 'read' | 'edit') => ({ level, project: ({ params }: { params: Record<string, string> }) => ({ kind: 'project' as const, key: params.key! }) });
  const one = (level: 'read' | 'edit' | 'manage') => ({ level, project: ({ params }: { params: Record<string, string> }) => ({ kind: 'stepBlock' as const, id: params.id! }) });
  // Verwendung: Testfälle, deren aktuelle Version Schritte aus dem Baustein enthält
  const usage = db`(select count(*)::int from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
      where tc.project_id = b.project_id and tc.archived_at is null and v.steps @> jsonb_build_array(jsonb_build_object('blockId', b.id::text)))`;
  const get = async (id: string) => {
    const [b] = await db<StepBlock[]>`select b.*, ${usage} as usage from step_block b where b.id = ${id}`;
    if (!b) throw notFound('Baustein', id);
    return b;
  };

  route(app, {
    method: 'get', path: '/api/projects/:key/step-blocks', access: proj('read'), tag, summary: 'Bausteine der Schrittbibliothek (Suche in Name, Schlagworten und Schritten)',
    query: z.object({ q: z.string().max(200).optional(), archived: z.stringbool().optional() }),
  }, async ({ params, query }) => {
    const p = await getProject(db, params.key!);
    const q = query.q?.trim();
    return db<StepBlock[]>`select b.*, ${usage} as usage from step_block b where b.project_id = ${p.id}
      ${query.archived ? db`` : db`and b.archived_at is null`}
      ${q ? db`and (b.name ilike ${`%${q}%`} or ${q.toLowerCase()} = any(select lower(t) from unnest(b.tags) t) or b.steps::text ilike ${`%${q}%`})` : db``}
      order by b.archived_at nulls first, lower(b.name) limit 500`;
  });
  route(app, { method: 'post', path: '/api/projects/:key/step-blocks', access: proj('edit'), tag, summary: 'Baustein anlegen', body: Body, status: 201 },
    async ({ params, body, actor }) => {
      const p = await getProject(db, params.key!);
      const [b] = await db<{ id: string }[]>`insert into step_block(project_id, name, description, steps, tags, created_by, updated_by)
        values (${p.id}, ${body.name}, ${body.description ?? null}, ${db.json(body.steps as never)}, ${body.tags}::text[], ${actor}, ${actor}) returning id`;
      return get(b!.id);
    });
  route(app, { method: 'get', path: '/api/step-blocks/:id', access: one('read'), tag, summary: 'Baustein mit verwendenden Testfällen' }, async ({ params }) => {
    const b = await get(params.id!);
    const usedBy = await db<{ key: string; title: string }[]>`select tc.key, v.title from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
      where tc.project_id = ${b.projectId} and tc.archived_at is null and v.steps @> jsonb_build_array(jsonb_build_object('blockId', ${b.id}::text))
      order by length(tc.key), tc.key limit 500`;
    return { ...b, usedBy };
  });
  route(app, { method: 'put', path: '/api/step-blocks/:id', access: one('edit'), tag, summary: 'Baustein ändern (wirkt nur auf künftiges Einfügen)', body: Body },
    async ({ params, body, actor }) => {
      const r = await db`update step_block set name = ${body.name}, description = ${body.description ?? null}, steps = ${db.json(body.steps as never)},
        tags = ${body.tags}::text[], updated_at = now(), updated_by = ${actor} where id = ${params.id!}`;
      if (r.count === 0) throw notFound('Baustein', params.id);
      return get(params.id!);
    });
  route(app, {
    method: 'post', path: '/api/step-blocks/:id/archive', access: one('edit'), tag, summary: 'Baustein archivieren bzw. wiederherstellen', status: 204,
    body: z.object({ archived: z.boolean() }),
  }, async ({ params, body }) => {
    const r = await db`update step_block set archived_at = ${body.archived ? new Date() : null} where id = ${params.id!}`;
    if (r.count === 0) throw notFound('Baustein', params.id);
  });
  route(app, { method: 'delete', path: '/api/step-blocks/:id', access: one('manage'), tag, summary: 'Baustein löschen (eingefügte Schritte in Testfällen bleiben erhalten)', status: 204 },
    async ({ params }) => {
      const r = await db`delete from step_block where id = ${params.id!}`;
      if (r.count === 0) throw notFound('Baustein', params.id);
    });
}
