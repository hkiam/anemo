/**
 * Modul fields (Stufe H5): eigene Felder für Testfälle, Zyklen und Ausführungen sowie Prioritäten als Werteliste.
 * Werte liegen in custom_fields unter dem Feldschlüssel; übernommene Werte gleichen Schlüssels sind sofort zugeordnet.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { type Db, inTx } from '../../platform/db.ts';
import { badRequest, notFound, route } from '../../platform/http.ts';
import { getProject } from '../projects/index.ts';

export type FieldScope = 'test_case' | 'cycle' | 'execution';
export type FieldType = 'text' | 'textarea' | 'select' | 'multiselect' | 'number' | 'date' | 'checkbox' | 'user';
export interface FieldDefinition {
  id: string; scope: FieldScope; key: string; name: string; type: FieldType; options: string[]; required: boolean;
  projectId: string | null; projectKey?: string | null; description: string | null; sortOrder: number; active: boolean;
  /** Auswahlwerte aus Jira/OpenProject (Abgleich) */
  optionsSource?: { provider: 'jira' | 'openproject'; project?: string | null; kind: string; fieldId?: string | null } | null;
  optionsSyncedAt?: Date | null; optionsSyncError?: string | null;
}
export interface Priority { code: string; color: string; sortOrder: number; isDefault: boolean; active: boolean; description: string | null }

/** Technische Schlüssel aus der Migration (Herkunft, Kommentare, Arbeitsprotokoll) – keine fachlichen Felder. */
export const INTERNAL_KEYS = new Set(['jira', 'zephyr', 'comments', 'worklog', 'stepAttributes', 'created', 'retestFor', 'retestDefect', 'automation']);

/** Felddefinitionen für einen Bereich; mit Projekt: globale plus projekteigene. */
export async function fieldDefinitions(db: Db, scope: FieldScope | null, projectId: string | null, opts: { all?: boolean } = {}): Promise<FieldDefinition[]> {
  return db<FieldDefinition[]>`
    select f.id, f.scope, f.key, f.name, f.type, f.options, f.required, f.project_id, p.key as project_key, f.description, f.sort_order, f.active,
           f.options_source, f.options_synced_at, f.options_sync_error
    from field_definition f left join project p on p.id = f.project_id
    where true ${scope ? db`and f.scope = ${scope}` : db``}
      ${opts.all ? db`` : db`and f.active`}
      ${projectId ? db`and (f.project_id is null or f.project_id = ${projectId})` : opts.all ? db`` : db`and f.project_id is null`}
    order by f.scope, f.sort_order, lower(f.name)`;
}

const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Prüft Werte gegen die Definitionen (Typ, Auswahlwerte, Pflicht) und normalisiert sie. Unbekannte Schlüssel
 * (übernommene Werte) bleiben unverändert. Pflichtfelder nur, wenn {@code required} gesetzt ist (Oberfläche/Import).
 */
export async function validateCustomFields(db: Db, scope: FieldScope, projectId: string, values: Record<string, unknown>,
  opts: { required?: boolean; previous?: Record<string, unknown> } = {}): Promise<Record<string, unknown>> {
  const defs = await fieldDefinitions(db, scope, projectId);
  const out: Record<string, unknown> = { ...values };
  const errors: string[] = [];
  for (const d of defs) {
    const v = out[d.key];
    // unveränderte Altwerte nicht nachträglich beanstanden (z. B. übernommene Auswahlwerte außerhalb der Liste)
    const unchanged = opts.previous && JSON.stringify(opts.previous[d.key]) === JSON.stringify(v);
    if (empty(v)) {
      delete out[d.key];
      if (opts.required && d.required) errors.push(`„${d.name}“ ist ein Pflichtfeld`);
      continue;
    }
    if (unchanged) continue;
    switch (d.type) {
      case 'number': {
        const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
        if (!Number.isFinite(n)) errors.push(`„${d.name}“: Zahl erwartet`);
        else out[d.key] = n;
        break;
      }
      case 'checkbox': out[d.key] = v === true || v === 'true' || v === 'ja' || v === '1' || v === 1; break;
      case 'date': {
        const s = String(v).trim();
        const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
        const iso = de ? `${de[3]}-${de[2]!.padStart(2, '0')}-${de[1]!.padStart(2, '0')}` : s.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(Date.parse(iso))) errors.push(`„${d.name}“: Datum erwartet (TT.MM.JJJJ)`);
        else out[d.key] = iso;
        break;
      }
      case 'select': {
        const s = String(v).trim();
        const hit = d.options.find((o) => o.toLowerCase() === s.toLowerCase());
        if (d.options.length && !hit) errors.push(`„${d.name}“: „${s}“ ist kein zulässiger Wert (${d.options.join(', ')})`);
        else out[d.key] = hit ?? s;
        break;
      }
      case 'multiselect': {
        const list = (Array.isArray(v) ? v : String(v).split(/[,;\n]/)).map((x) => String(x).trim()).filter(Boolean);
        const mapped = list.map((s) => d.options.find((o) => o.toLowerCase() === s.toLowerCase()) ?? (d.options.length ? null : s));
        const bad = list.filter((_, i) => mapped[i] === null);
        if (bad.length) errors.push(`„${d.name}“: unzulässige Werte ${bad.join(', ')}`);
        else out[d.key] = [...new Set(mapped as string[])];
        break;
      }
      default: out[d.key] = typeof v === 'string' ? v : String(v);
    }
  }
  if (errors.length) throw badRequest(errors.join('; '));
  return out;
}

export async function listPriorities(db: Db, opts: { all?: boolean } = {}): Promise<Priority[]> {
  return db<Priority[]>`select * from priority ${opts.all ? db`` : db`where active`} order by sort_order, code`;
}

/** Priorität muss aktiv in der Werteliste stehen – außer sie ist unverändert (übernommene Altwerte). */
export async function checkPriority(db: Db, value: string | null | undefined, previous?: string | null): Promise<string | null> {
  if (!value) return null;
  if (value === previous) return value;
  const [p] = await db<{ code: string }[]>`select code from priority where active and lower(code) = lower(${value.trim()})`;
  if (!p) throw badRequest(`Priorität „${value}“ ist nicht in der Werteliste (Administration → Felder & Prioritäten)`);
  return p.code;
}

/** Übernommene Schlüssel ohne Definition – Kandidaten für eigene Felder, mit Typvorschlag (nur Anzahl und Werte). */
export async function fieldCandidates(db: Db) {
  const defined = new Set((await db<{ scope: string; key: string }[]>`select scope, lower(key) as key from field_definition`).map((d) => `${d.scope}:${d.key}`));
  const rows = await db<{ scope: FieldScope; key: string; kind: string; n: number; distinct: number; samples: string[] }[]>`
    with tc as (
      select k as key, jsonb_typeof(v.custom_fields->k) as kind, v.custom_fields->k as val
      from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version,
           jsonb_object_keys(v.custom_fields) k),
    vals as (select key, kind, case when kind = 'array' then x.value else val end as val
             from tc left join lateral jsonb_array_elements(case when kind = 'array' then val else '[]'::jsonb end) x on true)
    select 'test_case' as scope, key, max(kind) as kind, count(*)::int as n, count(distinct val)::int as distinct,
           (array_agg(distinct val #>> '{}') filter (where val is not null))[1:40] as samples
    from vals group by key
    union all
    select 'cycle', k, max(jsonb_typeof(c.custom_fields->k)), count(*)::int, count(distinct c.custom_fields->>k)::int,
           (array_agg(distinct c.custom_fields->>k))[1:40]
    from test_cycle c, jsonb_object_keys(c.custom_fields) k group by k
    union all
    select 'execution', k, max(jsonb_typeof(e.custom_fields->k)), count(*)::int, count(distinct e.custom_fields->>k)::int,
           (array_agg(distinct e.custom_fields->>k))[1:40]
    from test_execution e, jsonb_object_keys(e.custom_fields) k group by k`;
  return rows
    .filter((r) => !INTERNAL_KEYS.has(r.key) && !defined.has(`${r.scope}:${r.key.toLowerCase()}`))
    .map((r) => ({
      scope: r.scope, key: r.key, count: r.n, distinct: r.distinct,
      suggestedType: (r.kind === 'array' ? 'multiselect' : r.kind === 'number' ? 'number' : r.kind === 'boolean' ? 'checkbox'
        : r.distinct <= 30 ? 'select' : 'text') as FieldType,
      options: r.kind === 'array' || r.distinct <= 30 ? (r.samples ?? []).filter(Boolean).sort((a, b) => a.localeCompare(b, 'de')) : [],
    }))
    .sort((a, b) => b.count - a.count);
}

const FieldBody = z.object({
  scope: z.enum(['test_case', 'cycle', 'execution']),
  key: z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N}_ ./-]+$/u, 'Schlüssel: Buchstaben, Ziffern, Leerzeichen, _ . / -'),
  name: z.string().trim().min(1).max(80),
  type: z.enum(['text', 'textarea', 'select', 'multiselect', 'number', 'date', 'checkbox', 'user']),
  options: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
  required: z.boolean().default(false),
  projectKey: z.string().nullish(),
  description: z.string().max(500).nullish(),
  sortOrder: z.number().int().default(0),
  active: z.boolean().default(true),
  optionsSource: z.object({
    provider: z.enum(['jira', 'openproject']),
    project: z.string().trim().max(100).nullish(),
    kind: z.enum(['versions', 'components', 'priorities', 'customfield', 'categories', 'types', 'statuses']),
    fieldId: z.string().trim().max(60).nullish(),
  }).nullish(),
});

export function fieldRoutes(app: Hono, db: Db): void {
  const tag = 'Felder & Prioritäten';
  route(app, {
    method: 'get', path: '/api/fields', tag, summary: 'Eigene Felder (aktiv; ohne project nur globale, mit project zusätzlich die des Projekts – Leserecht nötig; all=true inkl. inaktiver und aller Projekte, nur Systemadministration)',
    // Felder eingeschränkter Projekte (Name, Auswahlwerte) nur mit Leserecht am Projekt; Gesamtliste nur für die Administration
    access: ({ query }) => {
      const q = query as { project?: string; all?: boolean };
      if (q.all) return 'admin';
      return q.project ? { level: 'read', project: () => ({ kind: 'project', key: q.project! }) } : 'authenticated';
    },
    query: z.object({ scope: z.enum(['test_case', 'cycle', 'execution']).optional(), project: z.string().optional(), all: z.stringbool().optional() }),
  }, async ({ query }) => fieldDefinitions(db, query.scope ?? null, query.project ? (await getProject(db, query.project)).id : null, { all: query.all }));
  route(app, { method: 'get', path: '/api/admin/field-candidates', access: 'admin', tag, summary: 'Übernommene Werte ohne Felddefinition (Typvorschlag)' },
    () => fieldCandidates(db));
  const save = async (tx: Db, id: string | null, body: z.infer<typeof FieldBody>) => {
    const projectId = body.projectKey ? (await getProject(tx, body.projectKey)).id : null;
    const src = body.optionsSource ?? null;
    if (src && body.type !== 'select' && body.type !== 'multiselect') throw badRequest('Eine Quelle für Auswahlwerte gibt es nur bei Auswahlfeldern');
    if (src && src.kind === 'customfield' && !src.fieldId) throw badRequest('Für ein Auswahlfeld der Quelle bitte die Feld-ID angeben');
    if (src && !['priorities', 'statuses'].includes(src.kind) && !src.project) throw badRequest('Bitte das Projekt in Jira bzw. OpenProject angeben');
    if ((body.type === 'select' || body.type === 'multiselect') && !body.options.length && !src) throw badRequest('Auswahlfelder brauchen mindestens einen Wert oder eine Quelle');
    const options = [...new Set(body.options)];
    const [dup] = await tx`select 1 from field_definition where scope = ${body.scope} and lower(key) = lower(${body.key})
      and coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${projectId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      ${id ? tx`and id <> ${id}` : tx``}`;
    if (dup) throw badRequest(`Feld mit Schlüssel „${body.key}“ gibt es in diesem Bereich bereits`);
    if (id) {
      const [r] = await tx<{ id: string }[]>`update field_definition set scope = ${body.scope}, key = ${body.key}, name = ${body.name}, type = ${body.type},
        options = ${options}::text[], required = ${body.required}, project_id = ${projectId}, description = ${body.description ?? null},
        sort_order = ${body.sortOrder}, active = ${body.active}, options_source = ${src ? tx.json(src as never) : null} where id = ${id} returning id`;
      if (!r) throw notFound('Feld', id);
      return r;
    }
    const [r] = await tx<{ id: string }[]>`insert into field_definition(scope, key, name, type, options, required, project_id, description, sort_order, active, options_source)
      values (${body.scope}, ${body.key}, ${body.name}, ${body.type}, ${options}::text[], ${body.required}, ${projectId}, ${body.description ?? null}, ${body.sortOrder}, ${body.active},
        ${src ? tx.json(src as never) : null})
      returning id`;
    return r!;
  };
  route(app, { method: 'post', path: '/api/admin/fields', access: 'admin', tag, summary: 'Feld anlegen', body: FieldBody, status: 201 },
    ({ body }) => inTx(db, (tx) => save(tx, null, body)));
  route(app, { method: 'put', path: '/api/admin/fields/:id', access: 'admin', tag, summary: 'Feld ändern', body: FieldBody },
    ({ params, body }) => inTx(db, (tx) => save(tx, params.id!, body)));
  route(app, { method: 'delete', path: '/api/admin/fields/:id', access: 'admin', tag, summary: 'Feld löschen (gespeicherte Werte bleiben erhalten)', status: 204 },
    async ({ params }) => { await db`delete from field_definition where id = ${params.id!}`; });

  route(app, { method: 'get', path: '/api/priorities', tag, summary: 'Prioritäten (aktiv; all=true alle)', query: z.object({ all: z.stringbool().optional() }) },
    ({ query }) => listPriorities(db, { all: query.all }));
  route(app, {
    method: 'put', path: '/api/admin/priorities/:code', access: 'admin', tag, summary: 'Priorität anlegen/ändern', status: 204,
    body: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/), sortOrder: z.number().int(), isDefault: z.boolean(), active: z.boolean(), description: z.string().max(300).nullish() }),
  }, ({ params, body }) => inTx(db, async (tx) => {
    const code = decodeURIComponent(params.code!).trim();
    if (!/^[\p{L}\p{N} _.!/-]{1,40}$/u.test(code)) throw badRequest('Bezeichnung: 1–40 Zeichen');
    if (body.isDefault) await tx`update priority set is_default = false where is_default and code <> ${code}`;
    await tx`insert into priority(code, color, sort_order, is_default, active, description)
      values (${code}, ${body.color}, ${body.sortOrder}, ${body.isDefault && body.active}, ${body.active}, ${body.description ?? null})
      on conflict (code) do update set color = excluded.color, sort_order = excluded.sort_order, is_default = excluded.is_default,
        active = excluded.active, description = excluded.description`;
  }));
  route(app, { method: 'delete', path: '/api/admin/priorities/:code', access: 'admin', tag, summary: 'Priorität löschen (nur unbenutzt; sonst deaktivieren)', status: 204 },
    async ({ params }) => {
      const code = decodeURIComponent(params.code!);
      const [used] = await db`select 1 from test_case_version where priority = ${code} limit 1`;
      if (used) throw badRequest('Priorität ist in Testfällen verwendet – bitte deaktivieren statt löschen.');
      await db`delete from priority where code = ${code}`;
    });
}
