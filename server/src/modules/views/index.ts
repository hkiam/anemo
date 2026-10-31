/** Modul views: gespeicherte Ansichten (Filter als benannte Lesezeichen), privat oder im Projekt geteilt. */
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { HttpError, notFound, route } from '../../platform/http.ts';
import { can, principalOf } from '../auth/index.ts';
import { getProject } from '../projects/index.ts';

const Page = z.enum(['repo', 'cycles', 'health']);

export function viewRoutes(app: Hono, db: Db): void {
  const tag = 'Ansichten';
  const read = { level: 'read' as const, project: ({ params }: { params: Record<string, string> }) => ({ kind: 'project' as const, key: params.key! }) };
  route(app, { method: 'get', path: '/api/projects/:key/views', tag, summary: 'Eigene und geteilte Ansichten', access: read, query: z.object({ page: Page.optional() }) },
    async ({ params, query, c }) => {
      const p = await getProject(db, params.key!);
      const me = principalOf(c);
      return db`select id, page, name, query, shared, owner_name, (owner_name = ${me?.username ?? ''}) as mine from saved_view
        where project_id = ${p.id} ${query.page ? db`and page = ${query.page}` : db``} and (shared or owner_name = ${me?.username ?? ''})
        order by shared, lower(name)`;
    });
  route(app, {
    method: 'post', path: '/api/projects/:key/views', tag, summary: 'Ansicht speichern (geteilt: Rolle „Pflegen“)', access: read, status: 201,
    body: z.object({ page: Page, name: z.string().trim().min(1).max(80), query: z.string().max(2000), shared: z.boolean().default(false) }),
  }, async ({ params, body, c }) => {
    const p = await getProject(db, params.key!);
    const me = principalOf(c)!;
    if (body.shared && !can(me, p.id, 'edit')) throw new HttpError(403, 'Geteilte Ansichten erfordern die Rolle „Pflegen“');
    const [v] = await db`insert into saved_view(user_id, owner_name, project_id, page, name, query, shared)
      values (${me.userId}, ${me.username}, ${p.id}, ${body.page}, ${body.name}, ${body.query.replace(/^\?/, '')}, ${body.shared}) returning id`;
    return v;
  });
  route(app, { method: 'delete', path: '/api/views/:id', tag, summary: 'Ansicht löschen (eigene; Systemadmin alle)', status: 204 }, async ({ params, c }) => {
    const me = principalOf(c)!;
    const [v] = await db<{ ownerName: string }[]>`select owner_name from saved_view where id = ${params.id!}`;
    if (!v) throw notFound('Ansicht', params.id);
    if (v.ownerName !== me.username && !me.isSystemAdmin) throw new HttpError(403, 'Nur eigene Ansichten löschen');
    await db`delete from saved_view where id = ${params.id!}`;
  });
}
