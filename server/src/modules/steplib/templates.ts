/**
 * Stufe J5: Feldvorlagen – formatierter Standardaufbau, der sich per Knopfdruck in ein Feld einfügen lässt (z. B.
 * „Vorbedingung / Vorgehen“ in der Aktion). Systemweit (Systemadministration) oder je Projekt (Projektadministration);
 * Projektvorlagen ergänzen die systemweiten. Je Feld kann eine Vorlage Standard für neue Schritte sein.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { badRequest, conflict, notFound, requireAccess, route } from '../../platform/http.ts';
import { getProject } from '../projects/index.ts';

export const TEMPLATE_FIELDS = ['action', 'data', 'expected', 'objective', 'preconditions', 'testData'] as const;

export interface FieldTemplate {
  id: string; projectId: string | null; projectKey: string | null; name: string; fields: string[]; content: string; isDefault: boolean;
  createdAt: Date; createdBy: string; updatedAt: Date; updatedBy: string;
}

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  fields: z.array(z.enum(TEMPLATE_FIELDS)).min(1).max(TEMPLATE_FIELDS.length),
  content: z.string().max(20_000).refine((s) => s.trim().length > 0, 'Inhalt fehlt'),
  isDefault: z.boolean().default(false),
  /** Projekt (Schlüssel); ohne Angabe systemweit */
  project: z.string().trim().max(20).nullish(),
});

const SELECT = (db: Db) => db`select t.*, p.key as project_key from field_template t left join project p on p.id = t.project_id`;

async function getTemplate(db: Db, id: string): Promise<FieldTemplate> {
  const [t] = await db<FieldTemplate[]>`${SELECT(db)} where t.id = ${id}`;
  if (!t) throw notFound('Feldvorlage', id);
  return t;
}

/** Wer darf ändern: systemweit nur Systemadministration, Projektvorlagen die Projektadministration. */
const accessFor = (projectKey: string | null) => (projectKey ? { level: 'manage' as const, project: () => ({ kind: 'project' as const, key: projectKey }) } : 'admin' as const);

export function fieldTemplateRoutes(app: Hono, db: Db): void {
  const tag = 'Feldvorlagen';
  route(app, {
    method: 'get', path: '/api/field-templates', tag, summary: 'Feldvorlagen: systemweit und – mit project – die des Projekts (optional je Feld)',
    query: z.object({ project: z.string().max(20).optional(), field: z.enum(TEMPLATE_FIELDS).optional(), scope: z.enum(['all', 'system', 'project']).default('all') }),
    access: ({ query }) => ((query as { project?: string }).project ? { level: 'read', project: () => ({ kind: 'project', key: (query as { project: string }).project }) } : 'authenticated'),
  }, async ({ query }) => {
    const p = query.project ? await getProject(db, query.project) : null;
    const scope = query.scope === 'system' ? db`t.project_id is null` : query.scope === 'project' ? db`t.project_id = ${p?.id ?? null}`
      : p ? db`(t.project_id is null or t.project_id = ${p.id})` : db`t.project_id is null`;
    return db<FieldTemplate[]>`${SELECT(db)} where ${scope} ${query.field ? db`and ${query.field} = any(t.fields)` : db``}
      order by t.project_id nulls first, lower(t.name)`;
  });

  route(app, { method: 'post', path: '/api/field-templates', tag, summary: 'Feldvorlage anlegen (systemweit oder für ein Projekt)', body: Body, status: 201,
    access: ({ body }) => accessFor((body as { project?: string | null }).project ?? null) },
  ({ body, actor }) => db.begin(async (tx) => {
    const p = body.project ? await getProject(tx as unknown as Db, body.project) : null;
    if (body.isDefault) await clearDefaults(tx as unknown as Db, p?.id ?? null, body.fields);
    try {
      const [r] = await tx<{ id: string }[]>`insert into field_template(project_id, name, fields, content, is_default, created_by, updated_by)
        values (${p?.id ?? null}, ${body.name}, ${body.fields}::text[], ${body.content}, ${body.isDefault}, ${actor}, ${actor}) returning id`;
      return getTemplate(tx as unknown as Db, r!.id);
    } catch (e) { throw duplicate(e, body.name); }
  }));

  route(app, { method: 'put', path: '/api/field-templates/:id', tag, summary: 'Feldvorlage ändern', body: Body.omit({ project: true }) },
    async ({ params, body, actor, c }) => {
      const t = await getTemplate(db, params.id!);
      await requireAccess(c, accessFor(t.projectKey));
      return db.begin(async (tx) => {
        if (body.isDefault) await clearDefaults(tx as unknown as Db, t.projectId, body.fields, t.id);
        try {
          await tx`update field_template set name = ${body.name}, fields = ${body.fields}::text[], content = ${body.content}, is_default = ${body.isDefault},
            updated_by = ${actor}, updated_at = now() where id = ${t.id}`;
        } catch (e) { throw duplicate(e, body.name); }
        return getTemplate(tx as unknown as Db, t.id);
      });
    });

  route(app, { method: 'delete', path: '/api/field-templates/:id', tag, summary: 'Feldvorlage löschen', status: 204 },
    async ({ params, c }) => {
      const t = await getTemplate(db, params.id!);
      await requireAccess(c, accessFor(t.projectKey));
      await db`delete from field_template where id = ${t.id}`;
    });
}

/** Je Ebene (System bzw. Projekt) und Feld höchstens eine Standardvorlage. */
async function clearDefaults(db: Db, projectId: string | null, fields: readonly string[], except?: string) {
  const rows = await db<{ id: string; fields: string[] }[]>`
    select id, fields from field_template where is_default and ${projectId ? db`project_id = ${projectId}` : db`project_id is null`}
      ${except ? db`and id <> ${except}` : db``} and fields && ${fields as string[]}::text[]`;
  for (const r of rows) await db`update field_template set is_default = false where id = ${r.id}`;
}

function duplicate(e: unknown, name: string) {
  return (e as { code?: string }).code === '23505' ? conflict(`Eine Vorlage „${name}“ gibt es auf dieser Ebene schon`) : e instanceof Error ? e : badRequest(String(e));
}
