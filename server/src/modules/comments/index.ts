/**
 * Modul comments (Stufe H): Diskussion an Testfällen (Review-Anmerkungen je Version, Rückfragen), mit Antworten,
 * „erledigt“ und Erwähnungen (@benutzer → Benachrichtigung). Erweiterbar auf weitere Objekte.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { type Db, inTx } from '../../platform/db.ts';
import { badRequest, HttpError, notFound, requireAccess, route } from '../../platform/http.ts';
import { can, principalOf } from '../auth/index.ts';
import { EventTypes, recordEvent } from '../events/index.ts';

const OWNERS = { TEST_CASE: 'test_case', PRECONDITION: 'precondition' } as const;
type OwnerType = keyof typeof OWNERS;

export interface Comment {
  id: string; ownerType: string; ownerId: string; versionNo: number | null; parentId: string | null; author: string; body: string;
  createdAt: Date; editedAt: Date | null; resolvedAt: Date | null; resolvedBy: string | null;
}

/** Erwähnte Namen im Text (Buchstaben, Ziffern, . _ -), kleingeschrieben */
const mentionedNames = (body: string) => [...new Set([...body.matchAll(/(?:^|[\s(])@([\p{L}\p{N}._-]{2,60})/gu)].map((m) => m[1]!.replace(/[.]+$/, '').toLowerCase()))];

/**
 * @erwähnungen: nur aktive Konten mit Leserecht am Projekt (Systemadministration, Mitglied direkt bzw. über eine Gruppe,
 * oder internes Projekt – dieselbe Regel wie die Rechteprüfung). Andere erfahren nichts vom Inhalt.
 */
async function mentions(db: Db, body: string, projectId: string): Promise<{ notify: string[]; unreachable: string[] }> {
  const names = mentionedNames(body);
  if (!names.length) return { notify: [], unreachable: [] };
  const rows = await db<{ username: string; canRead: boolean }[]>`
    select u.username, (u.is_system_admin
      or exists (select 1 from project p where p.id = ${projectId} and p.visibility = 'internal')
      or exists (select 1 from project_member m where m.project_id = ${projectId} and (
        (m.principal_type = 'user' and m.principal_id = u.id)
        or (m.principal_type = 'group' and m.principal_id in (select group_id from group_member where user_id = u.id))))) as can_read
    from app_user u where lower(u.username) = any(${names}::text[]) and u.active`;
  return { notify: rows.filter((r) => r.canRead).map((r) => r.username), unreachable: rows.filter((r) => !r.canRead).map((r) => r.username) };
}

export async function commentCounts(db: Db, ownerType: string, ownerIds: string[]): Promise<Map<string, { total: number; open: number }>> {
  if (!ownerIds.length) return new Map();
  const rows = await db<{ ownerId: string; total: number; open: number }[]>`
    select owner_id, count(*)::int as total, count(*) filter (where resolved_at is null and parent_id is null)::int as open
    from comment where owner_type = ${ownerType} and owner_id = any(${ownerIds}::uuid[]) group by owner_id`;
  return new Map(rows.map((r) => [r.ownerId, { total: r.total, open: r.open }]));
}

export function commentRoutes(app: Hono, db: Db): void {
  const tag = 'Diskussion';
  const ownerAccess = (level: 'read' | 'edit') => ({ level, project: ({ query, body }: { query: unknown; body: unknown }) => {
    const src = (body ?? query) as { ownerType: string; ownerId: string };
    return { kind: 'owner' as const, ownerType: src.ownerType, ownerId: src.ownerId };
  } });
  route(app, {
    method: 'get', path: '/api/comments', tag, summary: 'Diskussion eines Objekts (Testfall, Vorbedingung) – älteste zuerst, Antworten mit parentId',
    access: ownerAccess('read'), query: z.object({ ownerType: z.enum(['TEST_CASE', 'PRECONDITION']), ownerId: z.uuid() }),
  }, ({ query }) => db<Comment[]>`select * from comment where owner_type = ${query.ownerType} and owner_id = ${query.ownerId} order by created_at`);

  route(app, {
    method: 'post', path: '/api/comments', tag, summary: 'Anmerkung schreiben (Lesen genügt); @benutzer benachrichtigt', status: 201,
    access: ownerAccess('read'),
    body: z.object({ ownerType: z.enum(['TEST_CASE', 'PRECONDITION']), ownerId: z.uuid(), body: z.string().trim().min(1).max(10_000), versionNo: z.number().int().positive().nullish(), parentId: z.uuid().nullish() }),
  }, ({ body, actor }) => inTx(db, async (tx) => {
    const table = OWNERS[body.ownerType as OwnerType];
    const [owner] = await tx<{ key: string; projectId: string }[]>`select key, project_id from ${tx(table)} where id = ${body.ownerId}`;
    if (!owner) throw notFound('Objekt', body.ownerId);
    if (body.parentId) {
      const [parent] = await tx<{ ownerId: string; parentId: string | null }[]>`select owner_id, parent_id from comment where id = ${body.parentId}`;
      if (!parent || parent.ownerId !== body.ownerId) throw badRequest('Antwort auf unbekannte Anmerkung');
      if (parent.parentId) throw badRequest('Antworten sind nur auf oberster Ebene möglich');
    }
    const [c] = await tx<Comment[]>`insert into comment(owner_type, owner_id, version_no, parent_id, author, body)
      values (${body.ownerType}, ${body.ownerId}, ${body.versionNo ?? null}, ${body.parentId ?? null}, ${actor}, ${body.body}) returning *`;
    const m = await mentions(tx, body.body, owner.projectId);
    const who = m.notify.filter((u) => u !== actor);
    await recordEvent(tx, { type: EventTypes.CommentAdded, aggregateType: body.ownerType === 'TEST_CASE' ? 'TestCase' : 'Precondition', aggregateId: body.ownerId, actor,
      payload: { commentId: c!.id, key: owner.key, excerpt: body.body.slice(0, 200), mentions: who, versionNo: body.versionNo ?? null } });
    // Erwähnte ohne Zugriff auf das Projekt werden nicht benachrichtigt – die Oberfläche kann darauf hinweisen
    return { ...c!, unreachableMentions: m.unreachable };
  }));

  route(app, {
    method: 'patch', path: '/api/comments/:id', tag, summary: 'Eigene Anmerkung ändern; erledigt/wieder offen (Autor oder Pflegen)',
    access: { level: 'read', project: ({ params }) => ({ kind: 'comment', id: params.id! }) },
    body: z.object({ body: z.string().trim().min(1).max(10_000).optional(), resolved: z.boolean().optional() }),
  }, async ({ c, params, body, actor }) => {
    const [cm] = await db<(Comment & { projectId: string })[]>`select cm.*, coalesce(tc.project_id, pc.project_id) as project_id from comment cm
      left join test_case tc on cm.owner_type = 'TEST_CASE' and tc.id = cm.owner_id left join precondition pc on cm.owner_type = 'PRECONDITION' and pc.id = cm.owner_id
      where cm.id = ${params.id!}`;
    if (!cm) throw notFound('Anmerkung', params.id);
    const me = principalOf(c)!;
    if (body.body !== undefined && cm.author !== actor) throw new HttpError(403, 'Nur eigene Anmerkungen lassen sich ändern');
    if (body.resolved !== undefined && cm.author !== actor && !can(me, cm.projectId, 'edit')) throw new HttpError(403, 'Erledigen dürfen Autor oder Rolle „Pflegen“');
    const [u] = await db<Comment[]>`update comment set
      body = ${body.body ?? cm.body}, edited_at = ${body.body !== undefined && body.body !== cm.body ? new Date() : cm.editedAt},
      resolved_at = ${body.resolved === undefined ? cm.resolvedAt : body.resolved ? new Date() : null},
      resolved_by = ${body.resolved === undefined ? cm.resolvedBy : body.resolved ? actor : null}
      where id = ${cm.id} returning *`;
    return u;
  });

  route(app, {
    method: 'delete', path: '/api/comments/:id', tag, summary: 'Eigene Anmerkung löschen (Projektadmin: alle)', status: 204,
    access: { level: 'read', project: ({ params }) => ({ kind: 'comment', id: params.id! }) },
  }, async ({ c, params, actor }) => {
    const [cm] = await db<{ author: string; ownerType: string; ownerId: string }[]>`select author, owner_type, owner_id from comment where id = ${params.id!}`;
    if (!cm) throw notFound('Anmerkung', params.id);
    if (cm.author !== actor) await requireAccess(c, { level: 'manage', project: () => ({ kind: 'owner', ownerType: cm.ownerType, ownerId: cm.ownerId }) });
    await db`delete from comment where id = ${params.id!}`;
  });
}
