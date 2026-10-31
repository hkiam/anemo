/**
 * Modul query (Stufe H2): übersetzt die Anemo-Abfragesprache (shared/aql) in SQL-Bedingungen für Testfälle und
 * Ausführungen. Alle Werte werden als Parameter übergeben, nie als SQL-Text.
 *
 * Erwartete Tabellen-Aliase – Testfälle: tc (test_case), v (aktuelle Version);
 * Ausführungen: e (test_execution), c (test_cycle), pl (test_plan, left join), tc, v (Version der Ausführung).
 */
import type { PendingQuery, Row } from 'postgres';
import {
  AqlError, categoryOf, type FieldInfo, type Node, parse, parseBool, parseDate, type Query, type Scope, type SortKey, type Value,
} from '../../../../shared/aql/aql.ts';
import type { Db } from '../../platform/db.ts';
import { HttpError } from '../../platform/http.ts';
import { fieldDefinitions } from '../fields/index.ts';

type Frag = PendingQuery<Row[]>;
export interface Compiled { where: Frag; order: Frag | null; mentionsArchived: boolean }
interface Lookups {
  tcStatus: { code: string; name: string; category: string }[];
  exStatus: { code: string; name: string; category: string }[];
  priorities: { code: string; sortOrder: number }[];
  folders: { id: string; parentId: string | null; name: string }[];
  defs: Awaited<ReturnType<typeof fieldDefinitions>>;
  dims: { key: string; name: string }[];
}
interface Ctx { db: Db; scope: Scope; projectId: string; actor: string; now: Date; mentionsArchived: boolean; l: Lookups }

/** Fehler der Abfrage als 400 mit Position (für die Markierung in der Oberfläche). */
class QueryError extends HttpError {
  constructor(e: AqlError) {
    super(400, `Abfrage, Zeichen ${e.pos + 1}: ${e.message}`, { aql: { pos: e.pos, end: e.end, message: e.message } });
  }
}

export async function compileTestCaseQuery(db: Db, aql: string, o: { projectId: string; actor?: string }): Promise<Compiled> {
  return compile(db, aql, 'testcase', o.projectId, o.actor ?? '');
}
export async function compileExecutionQuery(db: Db, aql: string, o: { projectId: string; actor?: string }): Promise<Compiled> {
  return compile(db, aql, 'execution', o.projectId, o.actor ?? '');
}

async function compile(db: Db, aql: string, scope: Scope, projectId: string, actor: string): Promise<Compiled> {
  let q: Query;
  try {
    q = parse(aql, scope);
  } catch (e) {
    if (e instanceof AqlError) throw new QueryError(e);
    throw e;
  }
  // Nachschlagewerte vorab laden – danach wird SQL synchron zusammengesetzt (Fragmente nie awaiten: sie würden ausgeführt)
  const [tcStatus, exStatus, priorities, folders, defs, dims] = await Promise.all([
    db<Lookups['tcStatus']>`select code, name, category from test_case_status`,
    db<Lookups['exStatus']>`select code, name, category from execution_status`,
    db<Lookups['priorities']>`select code, sort_order from priority`,
    db<Lookups['folders']>`select id, parent_id, name from folder where project_id = ${projectId}`,
    fieldDefinitions(db, null, projectId),
    db<Lookups['dims']>`select key, name from config_dimension`,
  ]);
  const ctx: Ctx = { db, scope, projectId, actor, now: new Date(), mentionsArchived: false, l: { tcStatus, exStatus, priorities, folders, defs, dims } };
  try {
    const where = q.where ? node(ctx, q.where) : db`true`;
    const order = q.order.length ? join(db, q.order.map((k) => sortKey(ctx, k)), ', ') : null;
    return { where: db`and (${where})`, order, mentionsArchived: ctx.mentionsArchived };
  } catch (e) {
    if (e instanceof AqlError) throw new QueryError(e);
    throw e;
  }
}

function join(db: Db, parts: Frag[], sep: ', ' | ' and ' | ' or '): Frag {
  return parts.reduce((acc, p, i) => (i === 0 ? p : sep === ', ' ? db`${acc}, ${p}` : sep === ' and ' ? db`${acc} and ${p}` : db`${acc} or ${p}`));
}

function node(ctx: Ctx, n: Node): Frag {
  const { db } = ctx;
  switch (n.type) {
    case 'and': case 'or': return db`(${join(db, n.items.map((x) => node(ctx, x)), n.type === 'and' ? ' and ' : ' or ')})`;
    case 'not': return db`not coalesce((${node(ctx, n.item)}), false)`;
    case 'text': return fulltext(ctx, n.value);
    default: return cond(ctx, n);
  }
}

function fulltext(ctx: Ctx, text: string): Frag {
  const { db } = ctx;
  const like = `%${text}%`;
  return ctx.scope === 'testcase'
    ? db`(v.search @@ websearch_to_tsquery('german', ${text}) or v.title ilike ${like} or tc.key ilike ${like} or tc.legacy_key ilike ${like})`
    : db`(e.search @@ websearch_to_tsquery('german', ${text}) or v.title ilike ${like} or tc.key ilike ${like} or tc.legacy_key ilike ${like})`;
}

const str = (ctx: Ctx, v: Value) => (v.func === 'ich' ? ctx.actor : v.raw);
const err = (v: Value, msg: string) => new AqlError(msg, v.pos, v.pos + v.raw.length + (v.quoted ? 2 : 0));

/** Vergleich einer Text-Spalte (Groß-/Kleinschreibung egal). */
function textCmp(ctx: Ctx, col: Frag, op: string, values: Value[]): Frag {
  const { db } = ctx;
  const vals = values.map((v) => str(ctx, v).toLowerCase());
  switch (op) {
    case '=': return db`lower(${col}) = ${vals[0]!}`;
    case '!=': return db`coalesce(lower(${col}) <> ${vals[0]!}, true)`;
    case '~': return db`${col} ilike ${'%' + vals[0]! + '%'}`;
    case '!~': return db`coalesce(${col} not ilike ${'%' + vals[0]! + '%'}, true)`;
    case 'in': return db`lower(${col}) = any(${vals}::text[])`;
    case 'notin': return db`coalesce(lower(${col}) <> all(${vals}::text[]), true)`;
    case 'empty': return db`coalesce(${col}, '') = ''`;
    case 'notempty': return db`coalesce(${col}, '') <> ''`;
    default: throw new AqlError(`Vergleich „${op}“ nicht möglich`, 0);
  }
}

/** Vergleich gegen ein Text-Array (Labels, Komponenten). */
function listCmp(ctx: Ctx, col: Frag, op: string, values: Value[]): Frag {
  const { db } = ctx;
  const vals = values.map((v) => str(ctx, v).toLowerCase());
  const any = db`exists (select 1 from unnest(${col}) x where lower(x) = any(${vals}::text[]))`;
  switch (op) {
    case '=': case 'in': return any;
    case '!=': case 'notin': return db`not ${any}`;
    case '~': return db`exists (select 1 from unnest(${col}) x where x ilike ${'%' + vals[0]! + '%'})`;
    case 'empty': return db`coalesce(cardinality(${col}), 0) = 0`;
    case 'notempty': return db`coalesce(cardinality(${col}), 0) > 0`;
    default: throw new AqlError(`Vergleich „${op}“ nicht möglich`, 0);
  }
}

/** Vergleich gegen einen jsonb-Wert, der Einzelwert oder Liste sein kann (eigene bzw. übernommene Felder). */
function jsonCmp(ctx: Ctx, json: Frag, op: string, values: Value[], kind: 'text' | 'number' | 'date'): Frag {
  const { db } = ctx;
  const elems = db`jsonb_array_elements_text(case when jsonb_typeof(${json}) = 'array' then ${json} when ${json} is null or jsonb_typeof(${json}) = 'null' then '[]'::jsonb else jsonb_build_array(${json}) end)`;
  if (op === 'empty') return db`(${json} is null or jsonb_typeof(${json}) = 'null' or ${json} = '""'::jsonb or ${json} = '[]'::jsonb)`;
  if (op === 'notempty') return db`not (${json} is null or jsonb_typeof(${json}) = 'null' or ${json} = '""'::jsonb or ${json} = '[]'::jsonb)`;
  if (kind === 'number' || kind === 'date') {
    const x = kind === 'number'
      ? db`(case when x ~ '^-?[0-9]+([.,][0-9]+)?$' then replace(x, ',', '.')::numeric end)`
      : db`(case when x ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then substr(x, 1, 10)::date end)`;
    const vals = values.map((v) => (kind === 'number' ? Number(v.raw.replace(',', '.')) : isoDay(parseDate(v, ctx.now))));
    if (kind === 'number' && vals.some((n) => !Number.isFinite(n as number))) throw err(values[0]!, `Zahl erwartet, gefunden „${values[0]!.raw}“`);
    const v0 = kind === 'number' ? db`${vals[0]!}::numeric` : db`${vals[0]!}::date`;
    const cmp = {
      '=': db`${x} = ${v0}`, '!=': db`${x} <> ${v0}`, '<': db`${x} < ${v0}`, '<=': db`${x} <= ${v0}`, '>': db`${x} > ${v0}`, '>=': db`${x} >= ${v0}`,
      'in': kind === 'number' ? db`${x} = any(${vals as number[]}::numeric[])` : db`${x} = any(${vals as string[]}::date[])`,
      'notin': kind === 'number' ? db`${x} = any(${vals as number[]}::numeric[])` : db`${x} = any(${vals as string[]}::date[])`,
    }[op as '='];
    if (!cmp) throw new AqlError(`Vergleich „${op}“ nicht möglich`, 0);
    return ['!=', 'notin'].includes(op) && op === 'notin' ? db`not exists (select 1 from ${elems} x where ${cmp})` : db`exists (select 1 from ${elems} x where ${cmp})`;
  }
  const vals = values.map((v) => str(ctx, v).toLowerCase());
  switch (op) {
    case '=': case 'in': return db`exists (select 1 from ${elems} x where lower(x) = any(${vals}::text[]))`;
    case '!=': case 'notin': return db`not exists (select 1 from ${elems} x where lower(x) = any(${vals}::text[]))`;
    case '~': return db`exists (select 1 from ${elems} x where x ilike ${'%' + vals[0]! + '%'})`;
    case '!~': return db`not exists (select 1 from ${elems} x where x ilike ${'%' + vals[0]! + '%'})`;
    case '<': case '<=': case '>': case '>=': {
      const o = { '<': db`<`, '<=': db`<=`, '>': db`>`, '>=': db`>=` }[op];
      return db`exists (select 1 from ${elems} x where x ${o} ${str(ctx, values[0]!)})`;
    }
    default: throw new AqlError(`Vergleich „${op}“ nicht möglich`, 0);
  }
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function dateCmp(ctx: Ctx, col: Frag, op: string, values: Value[]): Frag {
  const { db } = ctx;
  if (op === 'empty') return db`${col} is null`;
  if (op === 'notempty') return db`${col} is not null`;
  const d = parseDate(values[0]!, ctx.now);
  // „= Datum“ meint den ganzen Tag
  const day = /[hH]$|std$/.test(values[0]!.raw.trim()) ? null : d;
  const end = day ? new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1) : d;
  switch (op) {
    case '=': return db`(${col} >= ${d} and ${col} < ${end})`;
    case '!=': return db`not coalesce(${col} >= ${d} and ${col} < ${end}, false)`;
    case '<': return db`${col} < ${d}`;
    case '<=': return db`${col} < ${end}`;
    case '>': return day && !/^[+-]/.test(values[0]!.raw.trim()) && !values[0]!.func ? db`${col} >= ${end}` : db`${col} >= ${d}`;
    case '>=': return db`${col} >= ${d}`;
    default: throw new AqlError(`Vergleich „${op}“ nicht möglich`, 0);
  }
}

function numCmp(ctx: Ctx, col: Frag, op: string, values: Value[]): Frag {
  const { db } = ctx;
  const nums = values.map((v) => {
    const n = Number(v.raw.replace(',', '.'));
    if (!Number.isFinite(n)) throw err(v, `Zahl erwartet, gefunden „${v.raw}“`);
    return n;
  });
  switch (op) {
    case '=': return db`${col} = ${nums[0]!}`;
    case '!=': return db`${col} <> ${nums[0]!}`;
    case '<': return db`${col} < ${nums[0]!}`;
    case '<=': return db`${col} <= ${nums[0]!}`;
    case '>': return db`${col} > ${nums[0]!}`;
    case '>=': return db`${col} >= ${nums[0]!}`;
    case 'in': return db`${col} = any(${nums}::numeric[])`;
    case 'notin': return db`${col} <> all(${nums}::numeric[])`;
    default: throw new AqlError(`Vergleich „${op}“ nicht möglich`, 0);
  }
}

function boolCmp(ctx: Ctx, expr: Frag, op: string, values: Value[]): Frag {
  const b = parseBool(values[0]!);
  const want = op === '!=' ? !b : b;
  return want ? ctx.db`coalesce(${expr}, false)` : ctx.db`not coalesce(${expr}, false)`;
}

/** Status-Werte → Codes (Code, Name oder Kategorie). */
function statusCodes(ctx: Ctx, kind: 'testcase' | 'execution', values: Value[], byCategory: boolean): string[] {
  const list = kind === 'testcase' ? ctx.l.tcStatus : ctx.l.exStatus;
  const codes = new Set<string>();
  for (const v of values) {
    const s = v.raw.toLowerCase();
    const cat = categoryOf(v.raw);
    const direct = byCategory ? [] : list.filter((x) => x.code.toLowerCase() === s || x.name.toLowerCase() === s);
    const viaCat = cat ? list.filter((x) => x.category === cat) : [];
    if (!direct.length && !viaCat.length) {
      throw err(v, byCategory
        ? `Unbekannte Kategorie „${v.raw}“`
        : `Unbekannter Status „${v.raw}“ (bekannt: ${list.slice(0, 12).map((x) => x.name).join(', ')}${list.length > 12 ? ' …' : ''})`);
    }
    for (const x of direct.length ? direct : viaCat) codes.add(x.code);
  }
  return [...codes];
}

function inCodes(ctx: Ctx, col: Frag, op: string, codes: string[]): Frag {
  const { db } = ctx;
  if (op === 'empty') return db`${col} is null`;
  if (op === 'notempty') return db`${col} is not null`;
  return ['!=', 'notin'].includes(op) ? db`coalesce(${col} <> all(${codes}::text[]), true)` : db`${col} = any(${codes}::text[])`;
}

function priorityCmp(ctx: Ctx, op: string, values: Value[]): Frag {
  const { db } = ctx;
  const col = db`v.priority`;
  if (['<', '<=', '>', '>='].includes(op)) {
    // „höher“ = wichtiger = kleinere Sortierzahl
    const p = ctx.l.priorities.find((x) => x.code.toLowerCase() === values[0]!.raw.toLowerCase());
    if (!p) throw err(values[0]!, `Unbekannte Priorität „${values[0]!.raw}“`);
    const rank = db`(select pr.sort_order from priority pr where pr.code = v.priority)`;
    return { '>': db`${rank} < ${p.sortOrder}`, '>=': db`${rank} <= ${p.sortOrder}`, '<': db`${rank} > ${p.sortOrder}`, '<=': db`${rank} >= ${p.sortOrder}` }[op as '>']!;
  }
  return textCmp(ctx, col, op, values);
}

function folderCmp(ctx: Ctx, op: string, values: Value[]): Frag {
  const { db } = ctx;
  if (op === 'empty') return db`tc.folder_id is null`;
  if (op === 'notempty') return db`tc.folder_id is not null`;
  if (op === '~' || op === '!~') {
    const m = db`exists (with recursive up as (select id, parent_id, name from folder where id = tc.folder_id
      union all select f.id, f.parent_id, f.name from folder f join up on f.id = up.parent_id) select 1 from up where name ilike ${'%' + values[0]!.raw + '%'})`;
    return op === '~' ? m : db`not ${m}`;
  }
  const ids: string[] = [];
  for (const v of values) {
    const path = v.raw.split('/').map((s) => s.trim()).filter(Boolean);
    let parents: string[] = [];
    for (const [i, name] of path.entries()) {
      // erster Teil darf auch tiefer liegen (eindeutiger Ordnername), weitere Teile sind Unterordner
      const lc = name.toLowerCase();
      parents = ctx.l.folders.filter((f) => f.name.toLowerCase() === lc && (i === 0 || parents.includes(f.parentId ?? ''))).map((f) => f.id);
      if (!parents.length) throw err(v, `Ordner „${v.raw}“ nicht gefunden`);
    }
    ids.push(...parents);
  }
  const sub = db`(with recursive sub as (select id from folder where id = any(${ids}::uuid[]) union all select f.id from folder f join sub on f.parent_id = sub.id) select id from sub)`;
  return ['!=', 'notin'].includes(op) ? db`coalesce(tc.folder_id not in ${sub}, true)` : db`tc.folder_id in ${sub}`;
}

const RELATIONS: Record<string, string[]> = {
  anforderung: ['REQUIREMENT', 'STORY', 'EPIC'], fehler: ['DEFECT'],
  verweis: ['REQUIREMENT', 'STORY', 'EPIC', 'DEFECT', 'SUBTASK', 'RELATED', 'AUTOMATION', 'DOCUMENTATION'],
};

function refCmp(ctx: Ctx, field: string, op: string, values: Value[]): Frag {
  const { db } = ctx;
  const rel = RELATIONS[field]!;
  // Fehler hängen an Ausführungen, Anforderungen am Testfall
  const owners = field === 'fehler'
    ? ctx.scope === 'execution'
      ? db`r.owner_type = 'TEST_EXECUTION' and r.owner_id = e.id`
      : db`r.owner_type = 'TEST_EXECUTION' and r.owner_id in (select x.id from test_execution x where x.test_case_id = tc.id)`
    : ctx.scope === 'execution' && field === 'verweis'
      ? db`((r.owner_type = 'TEST_EXECUTION' and r.owner_id = e.id) or (r.owner_type = 'TEST_CASE' and r.owner_id = tc.id))`
      : db`r.owner_type = 'TEST_CASE' and r.owner_id = tc.id`;
  const base = db`select 1 from external_reference r where ${owners} and r.relation = any(${rel}::text[])`;
  const vals = values.map((v) => v.raw.toUpperCase());
  switch (op) {
    case 'empty': return db`not exists (${base})`;
    case 'notempty': return db`exists (${base})`;
    case '=': case 'in': return db`exists (${base} and upper(r.external_key) = any(${vals}::text[]))`;
    case '!=': case 'notin': return db`not exists (${base} and upper(r.external_key) = any(${vals}::text[]))`;
    case '~': return db`exists (${base} and (r.external_key ilike ${'%' + values[0]!.raw + '%'} or r.title ilike ${'%' + values[0]!.raw + '%'}))`;
    default: throw new AqlError(`Vergleich „${op}“ nicht möglich`, 0);
  }
}

function customCmp(ctx: Ctx, path: string, op: string, values: Value[]): Frag {
  const { db } = ctx;
  const defs = ctx.l.defs;
  const lc = path.toLowerCase();
  const match = (scope: string) => defs.find((d) => d.scope === scope && (d.key.toLowerCase() === lc || d.name.toLowerCase() === lc));
  const def = ctx.scope === 'execution' ? match('execution') ?? match('cycle') ?? match('test_case') : match('test_case');
  const key = def?.key ?? path;
  const table = def?.scope === 'execution' ? db`e.custom_fields` : def?.scope === 'cycle' ? db`c.custom_fields` : db`v.custom_fields`;
  const kind = def?.type === 'number' ? 'number' : def?.type === 'date' ? 'date' : 'text';
  if (def?.type === 'checkbox' && (op === '=' || op === '!=')) {
    return boolCmp(ctx, db`(${table}->${key})::text = 'true'`, op, values);
  }
  return jsonCmp(ctx, db`(${table}->${key})`, op, values, kind);
}

function configCmp(ctx: Ctx, path: string, op: string, values: Value[]): Frag {
  const { db } = ctx;
  const dim = ctx.l.dims.find((d) => d.key.toLowerCase() === path.toLowerCase() || d.name.toLowerCase() === path.toLowerCase());
  if (!dim) throw new AqlError(`Unbekanntes Konfigurationsmerkmal „${path}“`, 0);
  return jsonCmp(ctx, db`(c.configuration->${dim.key})`, op, values, 'text');
}

const CYCLE_STATE: Record<string, string> = { geplant: 'planned', planned: 'planned', aktiv: 'active', active: 'active', abgeschlossen: 'closed', closed: 'closed' };
const REVIEW: Record<string, string> = { ausstehend: 'pending', pending: 'pending', freigegeben: 'approved', approved: 'approved', abgelehnt: 'rejected', rejected: 'rejected', eskaliert: 'escalated', escalated: 'escalated' };

function mapped(ctx: Ctx, col: Frag, op: string, values: Value[], map: Record<string, string>): Frag {
  const codes = values.map((v) => {
    const m = map[v.raw.toLowerCase()];
    if (!m) throw err(v, `Unbekannter Wert „${v.raw}“ (möglich: ${[...new Set(Object.keys(map).filter((k) => /[äöüa-z]/.test(k)))].slice(0, 6).join(', ')})`);
    return m;
  });
  return inCodes(ctx, col, op, codes);
}

function cond(ctx: Ctx, n: Extract<Node, { type: 'cond' }>): Frag {
  const { db } = ctx;
  const { op, values } = n;
  const ex = ctx.scope === 'execution';
  const f = n.field.name;
  switch (f) {
    case 'text': return ['!=', '!~'].includes(op) ? db`not ${fulltext(ctx, values[0]!.raw)}` : fulltext(ctx, values[0]!.raw);
    case 'schlüssel': {
      const vals = values.map((v) => v.raw.toUpperCase());
      if (op === '~' || op === '!~') {
        const m = db`(tc.key ilike ${'%' + values[0]!.raw + '%'} or tc.legacy_key ilike ${'%' + values[0]!.raw + '%'})`;
        return op === '~' ? m : db`not ${m}`;
      }
      const m = db`(tc.key = any(${vals}::text[]) or tc.legacy_key = any(${vals}::text[]))`;
      return ['!=', 'notin'].includes(op) ? db`not ${m}` : m;
    }
    case 'titel': return textCmp(ctx, db`v.title`, op, values);
    case 'status':
      return ex ? inCodes(ctx, db`e.status`, op, statusCodes(ctx, 'execution', values, false))
        : inCodes(ctx, db`tc.status`, op, statusCodes(ctx, 'testcase', values, false));
    case 'kategorie':
      return ex ? inCodes(ctx, db`e.status`, op, statusCodes(ctx, 'execution', values, true))
        : inCodes(ctx, db`tc.status`, op, statusCodes(ctx, 'testcase', values, true));
    case 'priorität': return priorityCmp(ctx, op, values);
    case 'label': return listCmp(ctx, db`v.labels`, op, values);
    case 'komponente': return listCmp(ctx, db`v.components`, op, values);
    case 'testart': return jsonCmp(ctx, db`(v.custom_fields->'testTypes')`, op, values, 'text');
    case 'ordner': return folderCmp(ctx, op, values);
    case 'owner': return textCmp(ctx, db`tc.owner`, op, values);
    case 'erstellt': return dateCmp(ctx, ex ? db`e.created_at` : db`tc.created_at`, op, values);
    case 'ersteller': return textCmp(ctx, db`tc.created_by`, op, values);
    case 'geändert': return dateCmp(ctx, db`v.created_at`, op, values);
    case 'geändertvon': return textCmp(ctx, db`v.created_by`, op, values);
    case 'version': return numCmp(ctx, db`tc.current_version`, op, values);
    case 'format': {
      const map: Record<string, string> = { klassisch: 'CLASSIC', classic: 'CLASSIC', schritte: 'CLASSIC', gherkin: 'GHERKIN', bdd: 'GHERKIN', freitext: 'PLAIN', plain: 'PLAIN', unstrukturiert: 'PLAIN' };
      return mapped(ctx, db`v.format`, op, values, map);
    }
    case 'schritte': return numCmp(ctx, db`jsonb_array_length(v.steps)`, op, values);
    case 'schätzung':
      if (op === 'empty') return db`tc.estimate_minutes is null`;
      if (op === 'notempty') return db`tc.estimate_minutes is not null`;
      return numCmp(ctx, db`tc.estimate_minutes`, op, values);
    case 'parametrisiert':
      return boolCmp(ctx, db`(v.dataset is not null or (v.format = 'GHERKIN' and (v.gherkin ilike '%Beispiele:%' or v.gherkin ilike '%Examples:%')))`, op, values);
    case 'anforderung': case 'fehler': case 'verweis': return refCmp(ctx, f, op, values);
    case 'ergebnis': {
      const last = db`(select x.status from test_execution x where x.test_case_id = tc.id and x.executed_at is not null order by x.executed_at desc limit 1)`;
      if (op === 'empty' || op === 'notempty') return inCodes(ctx, last, op, []);
      let codes: string[];
      try { codes = statusCodes(ctx, 'execution', values, false); } catch { codes = statusCodes(ctx, 'execution', values, true); }
      return inCodes(ctx, last, op, codes);
    }
    case 'ausgeführt':
      return dateCmp(ctx, ex ? db`e.executed_at` : db`(select max(x.executed_at) from test_execution x where x.test_case_id = tc.id)`, op, values);
    case 'ausgeführtvon':
      if (ex) return textCmp(ctx, db`e.executed_by`, op, values);
      {
        const vals = values.map((v) => str(ctx, v).toLowerCase());
        const m = db`exists (select 1 from test_execution x where x.test_case_id = tc.id and lower(x.executed_by) = any(${vals}::text[]))`;
        return ['!=', 'notin'].includes(op) ? db`not ${m}` : m;
      }
    case 'zyklus':
      if (ex) return textCmp(ctx, db`c.name`, op, values);
      {
        const inner = textCmp(ctx, db`c2.name`, ['!=', 'notin', '!~'].includes(op) ? ({ '!=': '=', notin: 'in', '!~': '~' } as Record<string, string>)[op]! : op, values);
        const m = db`exists (select 1 from test_execution x join test_cycle c2 on c2.id = x.cycle_id where x.test_case_id = tc.id and ${inner})`;
        return ['!=', 'notin', '!~'].includes(op) ? db`not ${m}` : m;
      }
    case 'archiviert':
      ctx.mentionsArchived = true;
      return boolCmp(ctx, ex ? db`(c.archived_at is not null)` : db`(tc.archived_at is not null)`, op, values);
    case 'zugewiesen': return textCmp(ctx, db`e.assignee`, op, values);
    case 'plan': return textCmp(ctx, db`pl.name`, op, values);
    case 'release': return textCmp(ctx, db`c.release`, op, values);
    case 'build': return textCmp(ctx, db`c.build`, op, values);
    case 'umgebung': return textCmp(ctx, db`c.environment`, op, values);
    case 'zyklusstatus': return mapped(ctx, db`c.state`, op, values, CYCLE_STATE);
    case 'kommentar': return textCmp(ctx, db`e.comment`, op, values);
    case 'dauer': return numCmp(ctx, db`(e.duration_seconds / 60.0)`, op, values);
    case 'prüfung': return mapped(ctx, db`e.review_state`, op, values, REVIEW);
    case 'veraltet': return boolCmp(ctx, db`(v.version_no <> tc.current_version)`, op, values);
    case 'feld': return customCmp(ctx, n.path!, op, values);
    case 'konfiguration': return configCmp(ctx, n.path!, op, values);
    default: throw new AqlError(`Feld „${f}“ wird hier nicht unterstützt`, n.pos);
  }
}

function sortKey(ctx: Ctx, k: SortKey): Frag {
  const { db } = ctx;
  const ex = ctx.scope === 'execution';
  const dir = k.desc ? db`desc nulls last` : db`asc nulls last`;
  const col: Record<string, Frag> = {
    'schlüssel': db`length(tc.key) ${dir}, tc.key`,
    'titel': db`lower(v.title)`,
    'status': ex ? db`e.status` : db`tc.status`,
    'priorität': db`(select pr.sort_order from priority pr where pr.code = v.priority)`,
    'erstellt': ex ? db`e.created_at` : db`tc.created_at`,
    'geändert': db`v.created_at`,
    'ausgeführt': ex ? db`e.executed_at` : db`(select max(x.executed_at) from test_execution x where x.test_case_id = tc.id)`,
    'zyklus': ex ? db`c.name` : db`tc.key`,
    'zugewiesen': db`e.assignee`,
  };
  const c = col[k.field.name];
  if (!c) throw new AqlError(`Nach „${k.field.name}“ kann hier nicht sortiert werden`, 0);
  return k.field.name === 'schlüssel' ? db`${c} ${dir}` : db`${c} ${dir}`;
}

export type { FieldInfo };
