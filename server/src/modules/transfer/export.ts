/**
 * Export eines Projekts als Projektpaket (ADR-0027; K1 komplett, K3 Auswahl und Optionen).
 *
 * Liest in einer lesenden Transaktion mit Momentaufnahme (repeatable read), damit das Paket in sich stimmig ist, auch
 * wenn währenddessen gearbeitet wird. Große Objektarten kommen als NDJSON über einen Datenbank-Cursor, Anhänge
 * inhaltsadressiert unter files/<sha256> (Doppelte nur einmal). Das Paket entsteht in einer Arbeitsdatei; Aufrufer
 * liefern sie aus und löschen sie danach.
 *
 * Auswahl (K3): Aus Ordnern, Testfällen, Abfrage, Testsets, Plänen und Zyklen wird die Menge der Testfälle bestimmt;
 * nachgezogen werden aufgerufene Testfälle (rekursiv), Vorbedingungen, übergeordnete Ordner und die von Ausführungen
 * und Aufrufen benutzten Versionen. Projektweite Einstellungen (Felder, Vorlagen) kommen immer mit; Mitglieder,
 * Anbindungen, Webhooks, Ansichten und Bausteine nur beim kompletten Export.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import type postgres from 'postgres';
import type { Db } from '../../platform/db.ts';
import { HttpError } from '../../platform/http.ts';
import { versionInfo } from '../../platform/version.ts';
import { type ZipEntry, zipStream } from '../../platform/zip.ts';
import { searchTestCases } from '../testcases/index.ts';
import {
  CATALOG_TABLES, DEFAULT_EXPORT_OPTIONS, type ExportOptions, type ExportScope, fileOf, FORMAT, FORMAT_VERSION, type Manifest, OWNER_TYPES, type TypeName,
  type TypeSpec, TYPES, typeSpec,
} from './format.ts';

type Fragment = postgres.PendingQuery<postgres.Row[]>;

export interface ExportResult {
  path: string;
  fileName: string;
  sha256: string;
  bytes: number;
  manifest: Manifest;
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-');
const MENTION = /(^|[\s(])@([\p{L}\p{N}._-]{2,60})/gu;

async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) { h.update(chunk as Buffer); size += (chunk as Buffer).length; }
  return { sha256: h.digest('hex'), size };
}

/** Einschränkung je Objektart: fehlt ein Eintrag, kommen alle Objekte des Projekts mit; [] heißt keine. */
type Restrict = Map<TypeName, string[]>;

const ids = async (q: Promise<{ id: string }[]>) => (await q).map((r) => r.id);

/** Auswahl auflösen und Abhängiges nachziehen (K3). */
async function resolveScope(tx: Db, p: string, scope: ExportScope, opt: ExportOptions, actor: string): Promise<Restrict> {
  const r: Restrict = new Map();
  if (!opt.executions) for (const t of ['plans', 'cycles', 'executions', 'execution-results', 'sessions', 'dataset-overrides'] as const) r.set(t, []);
  if (!opt.comments) r.set('comments', []);
  if (!opt.attachments) r.set('attachments', []);
  if (opt.pseudonymize) r.set('members', []);
  /** Testfälle anderer Projekte, die die übertragenen Ausführungen benutzen (mit den ausgeführten Versionen) */
  const foreign = async (executions: string[] | null) => {
    const rows = !opt.executions ? [] : await tx<{ tc: string; v: string }[]>`
      select distinct e.test_case_id as tc, e.test_case_version_id as v from test_execution e join test_case t on t.id = e.test_case_id
      where t.project_id <> ${p} and ${executions === null ? tx`e.cycle_id in (select id from test_cycle where project_id = ${p})` : tx`e.id = any(${executions}::uuid[])`}`;
    r.set('foreign-test-cases', [...new Set(rows.map((x) => x.tc))]);
    r.set('foreign-test-case-versions', [...new Set(rows.map((x) => x.v))]);
  };

  if (scope.kind === 'complete') {
    if (opt.versions === 'current') {
      const all = await ids(tx<{ id: string }[]>`select id from test_case where project_id = ${p}`);
      r.set('test-case-versions', await versionsFor(tx, all, opt.executions ? null : []));
    }
    await foreign(null);
    return r;
  }

  // ---- Auswahl ----
  const tcs = new Set<string>();
  const keysOrIds = scope.testCases ?? [];
  if (keysOrIds.length) {
    const uuids = keysOrIds.filter((x) => UUID_RE.test(x));
    const keys = keysOrIds.filter((x) => !UUID_RE.test(x));
    const found = await tx<{ id: string; key: string }[]>`select id, key from test_case where project_id = ${p}
      and (id = any(${uuids}::uuid[]) or key = any(${keys}))`;
    const missing = keysOrIds.filter((x) => !found.some((f) => f.id === x || f.key === x));
    if (missing.length) throw new HttpError(400, `Testfälle nicht im Projekt: ${missing.slice(0, 10).join(', ')}`);
    found.forEach((f) => tcs.add(f.id));
  }
  const folderIds = scope.folders?.length
    ? await ids(tx<{ id: string }[]>`with recursive sub as (
        select id from folder where project_id = ${p} and id = any(${scope.folders}::uuid[])
        union select f.id from folder f join sub on f.parent_id = sub.id) select id from sub`)
    : [];
  if (scope.folders?.length && !folderIds.length) throw new HttpError(400, 'Ordner nicht im Projekt');
  if (folderIds.length) (await ids(tx<{ id: string }[]>`select id from test_case where project_id = ${p} and folder_id = any(${folderIds}::uuid[])`)).forEach((x) => tcs.add(x));
  if (scope.query?.trim()) {
    for (let offset = 0; ; offset += 500) {
      const page = await searchTestCases(tx, { projectId: p, aql: scope.query, actor, archived: 'all', limit: 500, offset } as Parameters<typeof searchTestCases>[1]);
      page.items.forEach((t) => tcs.add(t.id));
      if (page.items.length < 500) break;
    }
  }
  const sets = scope.testSets?.length
    ? await tx<{ id: string; kind: string; testCaseIds: string[]; query: string | null }[]>`select id, kind, test_case_ids, query from test_set where project_id = ${p} and id = any(${scope.testSets}::uuid[])`
    : [];
  if ((scope.testSets?.length ?? 0) !== sets.length) throw new HttpError(400, 'Testset nicht im Projekt');
  for (const s of sets) {
    if (s.kind === 'static') s.testCaseIds.forEach((x) => tcs.add(x));
    else {
      const aql = new URLSearchParams(s.query ?? '').get('aql') ?? '';
      const q = new URLSearchParams(s.query ?? '');
      for (let offset = 0; ; offset += 500) {
        const page = await searchTestCases(tx, { projectId: p, q: q.get('q') ?? undefined, status: q.get('status') ?? undefined, label: q.get('label') ?? undefined,
          priority: q.get('prio') ?? undefined, aql: aql || undefined, actor, limit: 500, offset } as Parameters<typeof searchTestCases>[1]);
        page.items.forEach((t) => tcs.add(t.id));
        if (page.items.length < 500) break;
      }
    }
  }
  let plans: string[] = [], cycles: string[] = [];
  if (opt.executions && (scope.plans?.length || scope.cycles?.length)) {
    cycles = await ids(tx<{ id: string }[]>`select id from test_cycle where project_id = ${p}
      and (id = any(${scope.cycles ?? []}::uuid[]) or plan_id = any(${scope.plans ?? []}::uuid[]))`);
    plans = await ids(tx<{ id: string }[]>`select id from test_plan where project_id = ${p}
      and (id = any(${scope.plans ?? []}::uuid[]) or id in (select plan_id from test_cycle where id = any(${cycles}::uuid[])))`);
    if ((scope.plans ?? []).some((x) => !plans.includes(x)) || (scope.cycles ?? []).some((x) => !cycles.includes(x))) throw new HttpError(400, 'Plan oder Zyklus nicht im Projekt');
    (await ids(tx<{ id: string }[]>`select distinct e.test_case_id as id from test_execution e join test_case t on t.id = e.test_case_id
      where e.cycle_id = any(${cycles}::uuid[]) and t.project_id = ${p}`)).forEach((x) => tcs.add(x));
  }
  const executions = await ids(tx<{ id: string }[]>`select id from test_execution where cycle_id = any(${cycles}::uuid[])`);
  const sessions = await ids(tx<{ id: string }[]>`select id from exploratory_session where cycle_id = any(${cycles}::uuid[])`);

  // aufgerufene Testfälle (rekursiv, nur innerhalb des Projekts)
  for (let frontier = [...tcs]; frontier.length;) {
    const called = await ids(tx<{ id: string }[]>`
      select distinct (s->'call'->>'testCaseId')::uuid as id
      from test_case_version v, jsonb_array_elements(case when jsonb_typeof(v.steps) = 'array' then v.steps else '[]'::jsonb end) s
      where v.test_case_id = any(${frontier}::uuid[]) and s->'call'->>'testCaseId' is not null
        and (s->'call'->>'testCaseId')::uuid in (select id from test_case where project_id = ${p})`);
    frontier = called.filter((x) => !tcs.has(x));
    frontier.forEach((x) => tcs.add(x));
  }
  const tcList = [...tcs];
  const versions = opt.versions === 'current' ? await versionsFor(tx, tcList, executions) : await ids(tx<{ id: string }[]>`select id from test_case_version where test_case_id = any(${tcList}::uuid[])`);
  const preconditions = await ids(tx<{ id: string }[]>`select distinct unnest(precondition_ids) as id from test_case_version where id = any(${versions}::uuid[])`);
  const folders = await ids(tx<{ id: string }[]>`with recursive up as (
      select id, parent_id from folder where id in (select folder_id from test_case where id = any(${tcList}::uuid[])) or id = any(${folderIds}::uuid[])
      union select f.id, f.parent_id from folder f join up on f.id = up.parent_id) select id from up`);

  r.set('test-cases', tcList);
  r.set('test-case-versions', versions);
  r.set('preconditions', preconditions);
  r.set('folders', folders);
  r.set('test-sets', sets.map((s) => s.id));
  if (opt.executions) { r.set('plans', plans); r.set('cycles', cycles); r.set('executions', executions); r.set('sessions', sessions); }
  await foreign(executions);
  for (const t of ['step-blocks', 'views', 'members', 'integrations', 'webhooks'] as const) r.set(t, []);
  return r;
}

/** Versionen bei „nur aktuelle“: aktuelle, freigegebene, von Ausführungen und von Aufrufen benutzte */
async function versionsFor(tx: Db, tcs: string[], executions: string[] | null): Promise<string[]> {
  const v = new Set(await ids(tx<{ id: string }[]>`select v.id from test_case_version v join test_case t on t.id = v.test_case_id
    where t.id = any(${tcs}::uuid[]) and (v.version_no = t.current_version or v.version_no = t.approved_version)`));
  const used = executions === null
    ? await ids(tx<{ id: string }[]>`select distinct e.test_case_version_id as id from test_execution e where e.test_case_id = any(${tcs}::uuid[])`)
    : await ids(tx<{ id: string }[]>`select distinct test_case_version_id as id from test_execution where id = any(${executions}::uuid[])`);
  used.forEach((x) => v.add(x));
  const pinned = await ids(tx<{ id: string }[]>`
    select distinct cv.id from test_case_version v, jsonb_array_elements(case when jsonb_typeof(v.steps) = 'array' then v.steps else '[]'::jsonb end) s
    join test_case_version cv on cv.test_case_id = (s->'call'->>'testCaseId')::uuid and cv.version_no = (s->'call'->>'versionNo')::int
    where v.id = any(${[...v]}::uuid[]) and s->'call'->>'versionNo' is not null`);
  pinned.forEach((x) => v.add(x));
  return [...v];
}

/** Auswahl beim Anfordern prüfen und ihren Umfang nennen (Anzahl je eingeschränkter Objektart) */
export async function scopeSummary(db: Db, o: { projectId: string; actor: string; scope: ExportScope; options?: Partial<ExportOptions> }): Promise<Partial<Record<TypeName, number>>> {
  return db.begin('isolation level repeatable read read only', async (sql) => {
    const r = await resolveScope(sql as unknown as Db, o.projectId, o.scope, { ...DEFAULT_EXPORT_OPTIONS, ...o.options }, o.actor);
    return Object.fromEntries([...r].map(([k, v]) => [k, v.length]));
  }) as Promise<Partial<Record<TypeName, number>>>;
}

/** Adresse eines Webhooks ohne Pfad, Parameter und Zugangsdaten (dort steckt bei Chat-Diensten das Geheimnis) */
export function webhookOrigin(url: string): string {
  try { return `${new URL(url).origin}/`; } catch { return 'https://ungueltig.invalid/'; }
}

export async function exportProject(db: Db, o: {
  projectId: string; transferId: string; actor: string; attachmentDir: string; workDir: string; scope?: ExportScope; options?: Partial<ExportOptions>;
  onProgress?: (p: { phase: string; type?: string; done?: number }) => void;
}): Promise<ExportResult> {
  const progress = o.onProgress ?? (() => {});
  const scope: ExportScope = o.scope ?? { kind: 'complete' };
  const opt: ExportOptions = { ...DEFAULT_EXPORT_OPTIONS, ...o.options };
  const path = join(o.workDir, `anemo-export-${o.transferId}.zip`);
  const result = await db.begin('isolation level repeatable read read only', async (sql) => {
    const tx = sql as unknown as Db;
    await tx`set local statement_timeout = 0`; // große Projekte: die Momentaufnahme darf dauern
    const p = o.projectId;
    const [project] = await tx<{ key: string; name: string; visibility: string; externalServices: string }[]>`
      select key, name, visibility, external_services from project where id = ${p}`;
    if (!project) throw new Error(`Projekt ${p} nicht gefunden`);
    const [instance] = await tx<{ instanceId: string }[]>`select instance_id from instance_info`;
    const userFields = new Set((await tx<{ key: string }[]>`
      select key from field_definition where type = 'user' and (project_id is null or project_id = ${p})`).map((r) => r.key));
    const restrict = await resolveScope(tx, p, scope, opt, o.actor);
    const preWarnings: string[] = [];
    const foreignCount = restrict.get('foreign-test-cases')?.length ?? 0;
    if (foreignCount) {
      const projects = await tx<{ key: string }[]>`select distinct p.key from test_case t join project p on p.id = t.project_id where t.id = any(${restrict.get('foreign-test-cases')!}::uuid[]) order by 1`;
      preWarnings.push(`${foreignCount} Testfälle aus anderen Projekten (${projects.map((x) => x.key).join(', ')}) mitgenommen, weil Ausführungen dieses Projekts sie benutzen`);
    }
    const cyc = restrict.get('cycles');
    const foreignPlans = await tx<{ name: string; key: string }[]>`select c.name, pp.key from test_cycle c join test_plan pl on pl.id = c.plan_id join project pp on pp.id = pl.project_id
      where c.project_id = ${p} and pl.project_id <> ${p} ${cyc ? tx`and c.id = any(${cyc}::uuid[])` : tx``}`;
    for (const f of foreignPlans) preWarnings.push(`Zyklus „${f.name}“ gehört zu einem Testplan aus Projekt ${f.key} – wird ohne Plan übertragen`);

    // Einschränkung als SQL (synchron aus den vorab bestimmten Mengen; Fragmente nie einzeln abwarten)
    const listOf = (t: TypeName) => restrict.get(t);
    const filter = (t: TypeSpec): Fragment => {
      const own = listOf(t.name);
      if (t.name === 'test-case-versions') {
        if (own) return tx`and id = any(${own}::uuid[])`;
        const tcs = listOf('test-cases');
        return tcs ? tx`and test_case_id = any(${tcs}::uuid[])` : tx``;
      }
      if (t.name === 'precondition-versions') { const l = listOf('preconditions'); return l ? tx`and precondition_id = any(${l}::uuid[])` : tx``; }
      if (t.name === 'execution-results') { const l = listOf('executions'); return l ? tx`and execution_id = any(${l}::uuid[])` : tx``; }
      if (t.name === 'dataset-overrides') {
        if (own) return tx`and false`;
        const tcs = listOf('test-cases'), plans = listOf('plans'), cycles = listOf('cycles');
        return tx`${tcs ? tx`and test_case_id = any(${tcs}::uuid[])` : tx``}
          ${plans ? tx`and (scope <> 'plan' or scope_id = any(${plans}::uuid[]))` : tx``}
          ${cycles ? tx`and (scope <> 'cycle' or scope_id = any(${cycles}::uuid[]))` : tx``}`;
      }
      if (t.name === 'comments' || t.name === 'references' || t.name === 'attachments') {
        if (own) return tx`and false`;
        // Besitzer: nur übertragene Objekte
        const parts = Object.entries(OWNER_TYPES).map(([ownerType, typeName]) => {
          const l = listOf(typeName);
          return l ? tx`(owner_type = ${ownerType} and owner_id = any(${l}::uuid[]))` : tx`owner_type = ${ownerType}`;
        });
        return tx`and (${parts.reduce((acc, f) => tx`${acc} or ${f}`)})`;
      }
      if (!own) return tx``;
      if (!t.columns.includes('id')) return tx`and false`;
      return tx`and id = any(${own}::uuid[])`;
    };

    const persons = new Set<string>();
    const groups = new Set<string>();
    const counts: Partial<Record<TypeName, number>> & { files: number } = { files: 0 };
    const sums: Manifest['files'] = [];
    const warnings: string[] = [...preWarnings];

    // Pseudonyme: in Reihenfolge des Auftretens; Erwähnungen nur für bekannte Logins
    const accounts = await tx<{ username: string; displayName: string }[]>`select username, display_name from app_user`;
    const knownLogins = new Set(accounts.map((r) => r.username.toLowerCase()));
    // Freitexte: vollständige Anzeigenamen (auch „Nachname, Vorname“) bekannter Konten → Pseudonym; E-Mail-Adressen entfernen.
    // Einzelne Vornamen bleiben (zu viele Fehltreffer) – das steht so im Handbuch.
    const byName = new Map<string, string>();
    for (const a of accounts) {
      const parts = a.displayName.trim().split(/\s+/);
      if (parts.length < 2 || a.displayName.trim().length < 5) continue;
      byName.set(a.displayName.trim().toLowerCase(), a.username);
      byName.set(`${parts.at(-1)}, ${parts.slice(0, -1).join(' ')}`.toLowerCase(), a.username);
    }
    const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRe = byName.size
      ? new RegExp(`(?<![\\p{L}\\p{N}])(${[...byName.keys()].sort((a, b) => b.length - a.length).map((n) => escape(n).replace(/\s+/g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`, 'giu')
      : null;
    const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
    const KEEP_TEXT = new Set(['id', 'key', 'legacyKey', 'externalKey', 'sourceKey', 'url', 'location', 'sha256']);
    const scrub = (v: unknown, field?: string): unknown => {
      if (typeof v === 'string') {
        if (field && KEEP_TEXT.has(field)) return v;
        let out = v.replace(EMAIL, '[E-Mail entfernt]');
        if (nameRe) out = out.replace(nameRe, (m) => pseudo(byName.get(m.toLowerCase().replace(/\s+/g, ' ')) ?? m));
        return out;
      }
      if (Array.isArray(v)) return v.map((x) => scrub(x));
      if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrub(x, k)]));
      return v;
    };
    const pseudonyms = new Map<string, string>();
    const pseudo = (login: string) => pseudonyms.get(login) ?? pseudonyms.set(login, `Person ${pseudonyms.size + 1}`).get(login)!;
    const person = (v: unknown) => {
      if (typeof v !== 'string' || !v) return v;
      persons.add(v);
      return opt.pseudonymize ? pseudo(v) : v;
    };
    const unmention = (text: string) => text.replace(MENTION, (all, pre: string, name: string) => (knownLogins.has(name.toLowerCase()) ? `${pre}@${pseudo(name.toLowerCase()).replace(' ', '')}` : all));

    // Anhänge vorab: Prüfsumme je lokaler Datei (bestimmt den Namen im Paket)
    const attachmentSha = new Map<string, string | null>();
    const files = new Map<string, { abs: string; size: number }>();
    const att = typeSpec('attachments');
    for (const a of await tx<{ id: string; location: string; fileName: string }[]>`
      select id, location, file_name from attachment where storage = 'LOCAL' and ${att.where(tx, p)} ${filter(att)} order by id`) {
      const abs = UUID_RE.test(a.location) ? join(o.attachmentDir, a.location) : null;
      try {
        if (!abs) throw Object.assign(new Error('ungültiger Speicherort'), { code: 'EINVAL' });
        const { sha256, size } = await sha256File(abs);
        attachmentSha.set(a.id, sha256);
        if (!files.has(sha256)) files.set(sha256, { abs, size });
      } catch (e) {
        attachmentSha.set(a.id, null);
        warnings.push(`Anhang „${a.fileName}“ (${a.id}) fehlt im Anhangsverzeichnis${(e as { code?: string }).code === 'ENOENT' ? '' : ` (${(e as Error).message})`} – nur die Angaben werden übertragen`);
      }
    }

    // Mitglieder: Benutzer und Gruppen über Login bzw. Namen (IDs gelten nur in der Quellinstanz)
    const principalNames = new Map<string, string>();
    for (const r of await tx<{ id: string; name: string; kind: 'user' | 'group' }[]>`
      select u.id, u.username as name, 'user' as kind from app_user u
        where u.id in (select principal_id from project_member where project_id = ${p} and principal_type = 'user')
      union all
      select g.id, g.name, 'group' from user_group g
        where g.id in (select principal_id from project_member where project_id = ${p} and principal_type = 'group')`) {
      principalNames.set(r.id, r.name);
    }

    const shape = (t: TypeSpec, row: Record<string, unknown>) => {
      if (t.name === 'attachments' && row.storage === 'LOCAL') {
        row.location = null;
        row.sha256 = attachmentSha.get(row.id as string) ?? null;
      }
      if (t.name === 'members') {
        const name = principalNames.get(row.principalId as string) ?? null;
        row.principal = name;
        if (name) (row.principalType === 'user' ? persons : groups).add(name);
      }
      for (const col of t.persons) row[camel(col)] = person(row[camel(col)]);
      const cf = row.customFields as Record<string, unknown> | undefined;
      if (cf && typeof cf === 'object') {
        row.customFields = Object.fromEntries(Object.entries(cf).map(([k, v]) => [k, userFields.has(k) ? (Array.isArray(v) ? v.map(person) : person(v)) : v]));
      }
      if (t.name === 'sessions' && Array.isArray(row.findings)) {
        row.findings = (row.findings as Record<string, unknown>[]).map((f) => (f?.by ? { ...f, by: person(f.by) } : f));
      }
      // Chat-Webhooks (Teams, Slack, Mattermost) tragen ihr Geheimnis in der Adresse: nur der Host verlässt die Instanz
      if (t.name === 'webhooks' && typeof row.url === 'string') row.url = webhookOrigin(row.url);
      if (opt.pseudonymize && t.name === 'comments' && typeof row.body === 'string') row.body = unmention(row.body);
      if (opt.pseudonymize) {
        const persons = new Set(t.persons.map(camel));
        for (const [k, v] of Object.entries(row)) if (!persons.has(k)) row[k] = scrub(v, k);
      }
      return row;
    };
    const select = (t: TypeSpec) => tx`select ${tx(t.columns)} from ${tx(t.table)} where ${t.where(tx, p)} ${filter(t)} order by ${tx.unsafe(t.order)}`;

    async function* ndjson(t: TypeSpec): AsyncGenerator<Buffer> {
      const h = createHash('sha256');
      let size = 0, n = 0;
      for await (const batch of select(t).cursor(500)) {
        let chunk = '';
        for (const row of batch) { chunk += `${JSON.stringify(shape(t, row as Record<string, unknown>))}\n`; n++; }
        const b = Buffer.from(chunk, 'utf8');
        h.update(b);
        size += b.length;
        yield b;
      }
      counts[t.name] = n;
      sums.push({ path: fileOf(t), sha256: h.digest('hex'), size });
      progress({ phase: 'Daten', type: t.name, done: n });
    }
    const json = (name: string, value: unknown): ZipEntry => {
      const data = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
      sums.push({ path: name, sha256: createHash('sha256').update(data).digest('hex'), size: data.length });
      return { name, data };
    };

    const catalog = async () => {
      const execs = tx`${typeSpec('executions').where(tx, p)} ${filter(typeSpec('executions'))}`;
      const tcFilter = filter(typeSpec('test-cases'));
      const verFilter = filter(typeSpec('test-case-versions'));
      const statuses = await tx`select * from execution_status where code in (
        select status from test_execution where ${execs}
        union select status from execution_result where execution_id in (select id from test_execution where ${execs})) order by sort_order, code`;
      const tcStatuses = await tx`select * from test_case_status where code in (select status from test_case where project_id = ${p} ${tcFilter}) order by sort_order, code`;
      const codes = tcStatuses.map((r) => r.code as string);
      const transitions = await tx`select * from test_case_transition where from_code = any(${codes}) and to_code = any(${codes}) order by from_code, to_code`;
      const priorities = await tx`select * from priority where code in (
        select v.priority from test_case_version v where ${typeSpec('test-case-versions').where(tx, p)} ${verFilter}) order by sort_order, code`;
      const cyc = typeSpec('cycles');
      const used = await tx<{ dim: string; value: string }[]>`
        select distinct d.key as dim, v.value from test_cycle c, jsonb_each(c.configuration) d, jsonb_array_elements_text(d.value) v
        where c.id in (select id from test_cycle where ${cyc.where(tx, p)} ${filter(cyc)}) and jsonb_typeof(c.configuration) = 'object' and jsonb_typeof(d.value) = 'array'`;
      const dims = [...new Set(used.map((u) => u.dim))];
      const dimensions = await tx`select * from config_dimension where key = any(${dims}) order by sort_order, key`;
      const values = (await tx`select * from config_value where dimension_key = any(${dims}) order by dimension_key, sort_order, value`)
        .filter((v) => used.some((u) => u.dim === v.dimensionKey && u.value === v.value));
      const fieldCols = typeSpec('field-definitions').columns;
      const globalFields = await tx`select ${tx(fieldCols)} from field_definition where project_id is null and (
           (scope = 'test_case' and key in (select jsonb_object_keys(v.custom_fields) from test_case_version v
                                            where ${typeSpec('test-case-versions').where(tx, p)} ${verFilter} and jsonb_typeof(v.custom_fields) = 'object'))
        or (scope = 'cycle' and key in (select jsonb_object_keys(custom_fields) from test_cycle where ${cyc.where(tx, p)} ${filter(cyc)} and jsonb_typeof(custom_fields) = 'object'))
        or (scope = 'execution' and key in (select jsonb_object_keys(custom_fields) from test_execution where ${execs} and jsonb_typeof(custom_fields) = 'object')))
        order by scope, sort_order, key`;
      return { tables: CATALOG_TABLES, executionStatuses: statuses, testCaseStatuses: tcStatuses, testCaseTransitions: transitions, priorities,
        configDimensions: dimensions, configValues: values, globalFields };
    };

    async function* entries(): AsyncGenerator<ZipEntry> {
      for (const t of TYPES) {
        if (t.single) {
          const [row] = await select(t);
          counts[t.name] = row ? 1 : 0;
          yield json(fileOf(t), row ? shape(t, row as Record<string, unknown>) : null);
        } else {
          yield { name: fileOf(t), stream: () => ndjson(t) };
        }
      }
      yield json('catalog.json', await catalog());
      progress({ phase: 'Anhänge', done: 0 });
      for (const [sha256, f] of files) {
        sums.push({ path: `files/${sha256}`, sha256, size: f.size });
        counts.files++;
        yield { name: `files/${sha256}`, path: f.abs };
      }
      const known = persons.size && !opt.pseudonymize
        ? await tx<{ username: string; displayName: string; email: string | null; active: boolean }[]>`
            select username, display_name, email, active from app_user where username = any(${[...persons]})`
        : [];
      const manifest: Manifest = {
        format: FORMAT, formatVersion: FORMAT_VERSION,
        anemo: { version: versionInfo().version, commit: versionInfo().commit },
        sourceInstance: instance!.instanceId, transferId: o.transferId,
        exportedAt: new Date().toISOString(), exportedBy: opt.pseudonymize ? 'pseudonymisiert' : o.actor,
        scope, options: opt,
        project: { key: project!.key, name: project!.name, visibility: project!.visibility, externalServices: project!.externalServices },
        counts,
        persons: opt.pseudonymize
          ? [...pseudonyms.values()].map((login) => ({ login, displayName: login, email: null, active: null }))
          : [...persons].sort().map((login) => {
            const u = known.find((k) => k.username === login);
            return { login, displayName: u?.displayName ?? null, email: u?.email ?? null, active: u ? u.active : null };
          }),
        groups: [...groups].sort().map((name) => ({ name })),
        warnings,
        files: sums,
      };
      const text = JSON.stringify(manifest, null, 2);
      yield { name: 'manifest.json', data: text };
      // Prüfsumme des Manifests (das Manifest enthält die Prüfsummen aller übrigen Dateien)
      yield { name: 'manifest.sha256', data: `${createHash('sha256').update(text).digest('hex')}  manifest.json\n` };
      result.manifest = manifest;
    }

    const result = { manifest: null as Manifest | null, sha256: '', bytes: 0 };
    const ws = createWriteStream(path, { mode: 0o600 });
    const h = createHash('sha256');
    try {
      for await (const chunk of zipStream(entries())) {
        h.update(chunk);
        result.bytes += chunk.length;
        if (!ws.write(chunk)) await once(ws, 'drain');
      }
      ws.end();
      await finished(ws);
    } catch (e) {
      ws.destroy();
      await rm(path, { force: true });
      throw e;
    }
    result.sha256 = h.digest('hex');
    return { ...result, key: project.key };
  });
  const date = new Date().toISOString().slice(0, 10);
  const part = scope.kind === 'selection' ? '-Auswahl' : '';
  return { path, fileName: `Projekt-${slug(result.key)}${part}-${date}.anemo.zip`, sha256: result.sha256, bytes: result.bytes, manifest: result.manifest! };
}
