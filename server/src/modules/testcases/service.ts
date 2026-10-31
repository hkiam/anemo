import { isGroup } from '../../../../shared/steps/groups.ts';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../platform/db.ts';
import { badRequest, conflict, notFound } from '../../platform/http.ts';
import { EventTypes, recordEvent } from '../events/index.ts';
import { nextNumber } from '../projects/index.ts';
import { deleteAttachmentsOf } from '../attachments/index.ts';
import { compileTestCaseQuery } from '../query/index.ts';
import { executableSteps, parseGherkin } from './gherkin.ts';
import { checkTransition, initialStatus, registerStatus } from './workflow.ts';
import {
  type Folder, type Step, type TestCase, type TestCaseContentInput, type TestCaseDetail, type TestCaseListItem,
  type Dataset, type TestCaseVersion, TestCaseContent,
} from './model.ts';

/** Schritte, die bei einer manuellen Ausführung abgehakt werden – für beide Formate einheitlich (ohne Aufrufe aufzulösen). */
export function executionSteps(v: Pick<TestCaseVersion, 'format' | 'gherkin' | 'steps'>): Step[] {
  if (v.format === 'PLAIN') return [];
  return v.format === 'GHERKIN' && v.gherkin ? executableSteps(v.gherkin) : v.steps;
}

const MAX_CALL_DEPTH = 5;

/**
 * Ausführbare Schritte mit aufgelösten Aufrufen (modulare Tests): Ein Aufruf-Schritt wird durch die Schritte der
 * aufgerufenen (festgelegten) Version ersetzt. IDs eingesetzter Schritte sind „Aufruf-ID>Schritt-ID“ und damit stabil.
 */
export async function resolveExecutionSteps(db: Db, v: Pick<TestCaseVersion, 'format' | 'gherkin' | 'steps'>, depth = 0, chain: string[] = []): Promise<Step[]> {
  const base = executionSteps(v);
  if (!base.some((s) => s.call)) return base;
  const out: Step[] = [];
  for (const s of base) {
    if (!s.call) { out.push(s); continue; }
    if (depth >= MAX_CALL_DEPTH || chain.includes(s.call.testCaseId)) {
      out.push({ ...s, call: null, action: `${s.action}\n(Aufruf nicht aufgelöst: zu tief verschachtelt oder zyklisch)` });
      continue;
    }
    const [tc] = await db<{ key: string; currentVersion: number }[]>`select key, current_version from test_case where id = ${s.call.testCaseId}`;
    if (!tc) { out.push({ ...s, call: null, action: `${s.action}\n(aufgerufener Testfall gelöscht)` }); continue; }
    const callee = await getVersion(db, s.call.testCaseId, s.call.versionNo ?? tc.currentVersion);
    if (callee.format === 'PLAIN') {
      // Freitext-Ziel (z. B. nachträglich umgestellt): Testanweisung als ein Schritt, statt still zu verschwinden
      out.push({ ...s, id: `${s.id}>freitext`, call: null, action: `Testanweisung von ${tc.key}:\n${callee.plainText ?? ''}`.trim(), data: '',
        expected: s.expected || `Alle Prüfungen von ${tc.key} wie beschrieben`, origin: { key: tc.key, title: callee.title, versionNo: callee.versionNo } });
      continue;
    }
    const inner = await resolveExecutionSteps(db, callee, depth + 1, [...chain, s.call.testCaseId]);
    // Abschnitte des aufgerufenen Testfalls würden den Abschnitt des Aufrufers zerteilen – sie entfallen beim Einsetzen
    for (const x of inner.filter((y) => !isGroup(y))) {
      out.push({ ...x, id: `${s.id}>${x.id}`, call: null, origin: x.origin ?? { key: tc.key, title: callee.title, versionNo: callee.versionNo } });
    }
  }
  return out;
}

/**
 * Aufruf-Schritte prüfen und festlegen (beim Speichern): gleicher Projekt, kein Selbst- oder Ringaufruf, Version
 * festschreiben (ohne Angabe die aktuelle), Anzeigetext aktualisieren.
 */
export async function prepareCalls(db: Db, projectId: string, selfId: string | null, steps: Step[]): Promise<Step[]> {
  const out: Step[] = [];
  for (const s of steps) {
    if (!s.call) { out.push(s); continue; }
    const callee = await findTestCase(db, s.call.testCaseId);
    if (!callee || callee.projectId !== projectId) throw badRequest('Aufgerufener Testfall nicht gefunden (nur Testfälle desselben Projekts)');
    if (callee.id === selfId) throw badRequest('Ein Testfall kann sich nicht selbst aufrufen');
    const versionNo = s.call.versionNo ?? callee.currentVersion;
    const v = await getVersion(db, callee.id, versionNo);
    // Freitext-Testfälle haben keine Schritte, die sich einsetzen ließen (Review Teil 3, Befund 18)
    if (v.format === 'PLAIN') throw badRequest(`${callee.key} ist ein Freitext-Testfall (ohne Schritte) und kann nicht aufgerufen werden – bitte als klassischen oder Gherkin-Testfall anlegen`);
    // Ringaufruf: ruft der aufgerufene (direkt oder indirekt) diesen Testfall auf?
    if (selfId) {
      const seen = new Set<string>();
      const walk = async (id: string, no: number, depth: number): Promise<boolean> => {
        if (depth > MAX_CALL_DEPTH || seen.has(`${id}@${no}`)) return false;
        seen.add(`${id}@${no}`);
        const ver = await getVersion(db, id, no);
        for (const c of ver.steps.filter((x) => x.call)) {
          if (c.call!.testCaseId === selfId) return true;
          const [t] = await db<{ currentVersion: number }[]>`select current_version from test_case where id = ${c.call!.testCaseId}`;
          if (t && await walk(c.call!.testCaseId, c.call!.versionNo ?? t.currentVersion, depth + 1)) return true;
        }
        return false;
      };
      if (await walk(callee.id, versionNo, 0)) throw badRequest(`${callee.key} ruft (indirekt) diesen Testfall auf – Ringaufrufe sind nicht möglich`);
    }
    out.push({ ...s, call: { testCaseId: callee.id, versionNo }, action: s.action.trim() || `Testfall ${callee.key} „${v.title}“ ausführen`, data: s.data, expected: s.expected || `Alle Schritte von ${callee.key} wie erwartet` });
  }
  return out;
}

/**
 * Wirksamer Datensatz einer Version: ausdrücklich gepflegt oder – bei Gherkin – die Beispiele des ersten
 * Szenariogrundrisses (Blöcke mit gleicher Kopfzeile zusammengefasst). Null = kein parametrisierter Test.
 */
export function effectiveDataset(v: Pick<TestCaseVersion, 'format' | 'gherkin' | 'dataset'>): Dataset | null {
  if (v.dataset?.rows.length) return v.dataset;
  if (v.format !== 'GHERKIN' || !v.gherkin) return null;
  const outline = parseGherkin(v.gherkin).scenarios.find((s) => s.examples.some((e) => e.rows.length));
  if (!outline) return null;
  const first = outline.examples.find((e) => e.rows.length)!;
  const rows = outline.examples.filter((e) => e.header.join('|') === first.header.join('|')).flatMap((e) => e.rows);
  return { columns: first.header, rows };
}

const TC_COLUMNS = (db: Db) => db`
  tc.id, tc.project_id, p.key as project_key, tc.key, tc.legacy_key, tc.folder_id, tc.status, tc.owner,
  tc.current_version, tc.created_at, tc.created_by, tc.updated_at, tc.approved_version, tc.approved_by, tc.approved_at,
  tc.archived_at, tc.archived_by, tc.estimate_minutes`;

const VERSION_COLUMNS = (db: Db) => db`
  v.id, v.test_case_id, v.version_no, v.title, v.format, v.gherkin, v.objective, v.preconditions, v.test_data, v.priority,
  v.labels, v.components, v.steps, v.sections, v.custom_fields, v.dataset, v.ai_assisted, v.change_note, v.created_at, v.created_by, v.precondition_ids, v.plain_text`;

/** Vergibt fehlende Schritt-IDs, damit Schritte über Versionen hinweg identifizierbar bleiben. */
function withStepIds(content: TestCaseContentInput) {
  const parsed = TestCaseContent.parse(content);
  // Freitext: alte Schritte verwerfen – sie gingen sonst in Suche, Export und Aufrufe ein (Review Teil 3, Befund 19)
  if (parsed.format === 'PLAIN') return { ...parsed, steps: [] };
  return { ...parsed, steps: parsed.steps.map((s) => ({ ...s, id: s.id ?? randomUUID() })) };
}

/** JSON mit sortierten Schlüsseln – jsonb speichert Objektschlüssel in eigener Reihenfolge. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v);
}

/** Vergleich ohne Schritt-IDs: neue IDs allein sind keine inhaltliche Änderung. */
function sameContent(a: TestCaseContentInput, b: TestCaseContentInput): boolean {
  const norm = (c: TestCaseContentInput) => {
    const p = TestCaseContent.parse(c);
    return canonical({ ...p, steps: p.format === 'PLAIN' ? [] : p.steps.map(({ id: _id, ...rest }) => rest) });
  };
  return norm(a) === norm(b);
}

async function insertVersion(
  db: Db, testCaseId: string, versionNo: number, content: ReturnType<typeof withStepIds>,
  changeNote: string | null, actor: string, createdAt?: Date, aiAssisted: string | null = null,
): Promise<TestCaseVersion> {
  const [v] = await db<TestCaseVersion[]>`
    insert into test_case_version(test_case_id, version_no, title, format, gherkin, objective, preconditions, test_data, priority,
      labels, components, steps, sections, custom_fields, dataset, ai_assisted, change_note, created_by, created_at, precondition_ids, plain_text)
    values (${testCaseId}, ${versionNo}, ${content.title}, ${content.format}, ${content.gherkin}, ${content.objective}, ${content.preconditions},
      ${content.testData}, ${content.priority}, ${content.labels}::text[], ${content.components}::text[],
      ${db.json(content.steps as never)}, ${db.json(content.sections as never)}, ${db.json(content.customFields as never)},
      ${content.dataset ? db.json(content.dataset as never) : null}, ${aiAssisted}, ${changeNote}, ${actor}, ${createdAt ?? new Date()},
      ${content.preconditionIds}::uuid[], ${content.format === 'PLAIN' ? content.plainText : null})
    returning id, test_case_id, version_no, title, format, gherkin, objective, preconditions, test_data, priority, labels, components,
      steps, sections, custom_fields, dataset, ai_assisted, change_note, created_at, created_by, precondition_ids, plain_text`;
  return v!;
}

export interface CreateTestCase {
  projectId: string;
  folderId?: string | null;
  status?: string;
  owner?: string | null;
  legacyKey?: string | null;
  content: TestCaseContentInput;
  changeNote?: string | null;
  createdAt?: Date;
  aiAssisted?: string | null;
}

export async function createTestCase(db: Db, cmd: CreateTestCase, actor: string, opts: { enforceWorkflow?: boolean } = {}): Promise<TestCaseDetail> {
  const content = withStepIds(cmd.content);
  const status = cmd.status ?? (await initialStatus(db));
  if (opts.enforceWorkflow) await checkTransition(db, null, status);
  else await registerStatus(db, status);
  const [project] = await db<{ key: string }[]>`select key from project where id = ${cmd.projectId}`;
  if (!project) throw notFound('Projekt', cmd.projectId);
  await assertFolderInProject(db, cmd.folderId, cmd.projectId);
  const key = `${project.key}-T${await nextNumber(db, cmd.projectId)}`;
  const [tc] = await db<{ id: string }[]>`
    insert into test_case(project_id, key, legacy_key, folder_id, status, owner, current_version, created_by, created_at, updated_at)
    values (${cmd.projectId}, ${key}, ${cmd.legacyKey ?? null}, ${cmd.folderId ?? null}, ${status},
      ${cmd.owner ?? null}, 1, ${actor}, ${cmd.createdAt ?? new Date()}, now())
    returning id`;
  await insertVersion(db, tc!.id, 1, content, cmd.changeNote ?? null, actor, cmd.createdAt, cmd.aiAssisted ?? null);
  await recordEvent(db, {
    type: EventTypes.TestCaseCreated, aggregateType: 'TestCase', aggregateId: tc!.id, actor,
    payload: { key, title: content.title, projectId: cmd.projectId },
  });
  return getTestCase(db, tc!.id);
}

/**
 * Erzeugt eine neue Version, sofern sich der Inhalt geändert hat. Liefert {@code changed=false},
 * wenn der Inhalt identisch ist (z. B. bei wiederholtem Import).
 */
export async function reviseTestCase(
  db: Db, idOrKey: string, content: TestCaseContentInput, changeNote: string | null, actor: string,
  expectedVersion?: number, aiAssisted: string | null = null, opts: { keepApproval?: boolean } = {},
): Promise<{ testCase: TestCaseDetail; changed: boolean }> {
  const current = await getTestCase(db, idOrKey, { forUpdate: true });
  if (expectedVersion !== undefined && expectedVersion !== current.currentVersion) {
    throw badRequest(`Testfall wurde zwischenzeitlich geändert (aktuell v${current.currentVersion}, erwartet v${expectedVersion})`);
  }
  if (sameContent(current.version, content)) return { testCase: current, changed: false };
  const next = withStepIds(content);
  const versionNo = current.currentVersion + 1;
  await insertVersion(db, current.id, versionNo, next, changeNote, actor, undefined, aiAssisted);
  await db`update test_case set current_version = ${versionNo}, updated_at = now() where id = ${current.id}`;
  // Freigabe gilt für eine Version: Eine neue Fassung eines freigegebenen Testfalls muss erneut geprüft werden
  if (!opts.keepApproval) {
    const [st] = await db<{ category: string }[]>`select category from test_case_status where code = ${current.status}`;
    if (st?.category === 'APPROVED') {
      const [review] = await db<{ code: string }[]>`select code from test_case_status where active and category = 'REVIEW' order by sort_order limit 1`;
      const back = review?.code ?? (await initialStatus(db));
      await db`update test_case set status = ${back}, approved_version = null, approved_by = null, approved_at = null where id = ${current.id}`;
      await recordEvent(db, { type: EventTypes.TestCaseMetaChanged, aggregateType: 'TestCase', aggregateId: current.id, actor,
        payload: { key: current.key, before: { status: current.status }, after: { status: back }, reason: `Neue Version v${versionNo} – Freigabe muss erneut erteilt werden` } });
    }
  }
  await recordEvent(db, {
    type: EventTypes.TestCaseChanged, aggregateType: 'TestCase', aggregateId: current.id, actor,
    payload: { key: current.key, fromVersion: current.currentVersion, toVersion: versionNo, changeNote },
  });
  return { testCase: await getTestCase(db, current.id), changed: true };
}

export interface MetaChange {
  folderId?: string | null | undefined;
  status?: string | undefined;
  owner?: string | null | undefined;
  /** geplanter Aufwand in Minuten (Schätzung) */
  estimateMinutes?: number | null | undefined;
}

/** Verwaltungsdaten ändern – erzeugt keine neue Version, aber ein Event (Audit). */
export async function updateTestCaseMeta(db: Db, idOrKey: string, change: MetaChange, actor: string, opts: { enforceWorkflow?: boolean } = {}): Promise<TestCaseDetail> {
  const tc = await getTestCase(db, idOrKey, { forUpdate: true });
  let approval: 'set' | 'clear' | null = null;
  if (change.status !== undefined && change.status !== tc.status) {
    if (opts.enforceWorkflow) await checkTransition(db, tc.status, change.status);
    else await registerStatus(db, change.status);
    const [target] = await db<{ category: string }[]>`select category from test_case_status where code = ${change.status}`;
    if (target?.category === 'APPROVED') {
      // Vier-Augen-Prinzip: Wer die aktuelle Fassung geschrieben hat, gibt sie nicht selbst frei
      if (opts.enforceWorkflow && tc.version.createdBy === actor) {
        throw badRequest(`Vier-Augen-Prinzip: Version v${tc.currentVersion} stammt von Ihnen – die Freigabe muss eine andere Person erteilen.`);
      }
      approval = 'set';
    } else approval = 'clear';
  }
  const next = {
    folderId: change.folderId === undefined ? tc.folderId : change.folderId,
    status: change.status ?? tc.status,
    owner: change.owner === undefined ? tc.owner : change.owner,
    estimateMinutes: change.estimateMinutes === undefined ? tc.estimateMinutes ?? null : change.estimateMinutes,
  };
  if (next.folderId === tc.folderId && next.status === tc.status && next.owner === tc.owner && next.estimateMinutes === (tc.estimateMinutes ?? null)) return tc;
  if (next.folderId !== tc.folderId) await assertFolderInProject(db, next.folderId, tc.projectId);
  await db`update test_case set folder_id = ${next.folderId}, status = ${next.status}, owner = ${next.owner}, estimate_minutes = ${next.estimateMinutes}, updated_at = now(),
           approved_version = ${approval === 'set' ? tc.currentVersion : approval === 'clear' ? null : db`approved_version`},
           approved_by = ${approval === 'set' ? actor : approval === 'clear' ? null : db`approved_by`},
           approved_at = ${approval === 'set' ? new Date() : approval === 'clear' ? null : db`approved_at`}
           where id = ${tc.id}`;
  await recordEvent(db, {
    type: EventTypes.TestCaseMetaChanged, aggregateType: 'TestCase', aggregateId: tc.id, actor,
    payload: { key: tc.key, before: { folderId: tc.folderId, status: tc.status, owner: tc.owner, estimateMinutes: tc.estimateMinutes ?? null }, after: next },
  });
  return getTestCase(db, tc.id);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Akzeptiert UUID, Anemo-Schlüssel (DEMO-T1) oder Altschlüssel aus Jira (DEMO-123). Der Anemo-Schlüssel hat Vorrang;
 * ein Altschlüssel, der in mehreren Projekten vorkommt, ist mehrdeutig (409) – so treffen Rechteprüfung
 * (`resolveProject`) und Handler immer denselben Testfall (Sicherheits-Review Teil 2, Befund 14).
 */
export async function findTestCase(db: Db, idOrKey: string, opts: { forUpdate?: boolean } = {}): Promise<TestCase | undefined> {
  const lock = opts.forUpdate ? db`for update of tc` : db``;
  if (UUID_RE.test(idOrKey)) {
    const [tc] = await db<TestCase[]>`select ${TC_COLUMNS(db)} from test_case tc join project p on p.id = tc.project_id where tc.id = ${idOrKey} ${lock}`;
    return tc;
  }
  const [exact] = await db<TestCase[]>`select ${TC_COLUMNS(db)} from test_case tc join project p on p.id = tc.project_id where tc.key = ${idOrKey} ${lock}`;
  if (exact) return exact;
  const legacy = await db<TestCase[]>`select ${TC_COLUMNS(db)} from test_case tc join project p on p.id = tc.project_id
    where tc.legacy_key = ${idOrKey} order by tc.project_id, tc.id limit 2 ${lock}`;
  if (legacy.length > 1) throw conflict(`Altschlüssel ${idOrKey} ist mehrdeutig (in mehreren Projekten) – bitte den Anemo-Schlüssel verwenden`);
  return legacy[0];
}

export async function getTestCase(db: Db, idOrKey: string, opts: { forUpdate?: boolean } = {}): Promise<TestCaseDetail> {
  const tc = await findTestCase(db, idOrKey, opts);
  if (!tc) throw notFound('Testfall', idOrKey);
  return { ...tc, version: await getVersion(db, tc.id, tc.currentVersion) };
}

export async function getVersion(db: Db, testCaseId: string, versionNo: number): Promise<TestCaseVersion> {
  const [v] = await db<TestCaseVersion[]>`
    select ${VERSION_COLUMNS(db)} from test_case_version v where v.test_case_id = ${testCaseId} and v.version_no = ${versionNo}`;
  if (!v) throw notFound('Testfallversion', `${testCaseId}@v${versionNo}`);
  return v;
}

export async function getVersionById(db: Db, versionId: string): Promise<TestCaseVersion> {
  const [v] = await db<TestCaseVersion[]>`select ${VERSION_COLUMNS(db)} from test_case_version v where v.id = ${versionId}`;
  if (!v) throw notFound('Testfallversion', versionId);
  return v;
}

export async function listVersions(db: Db, idOrKey: string) {
  const tc = await getTestCase(db, idOrKey);
  return db<{ versionNo: number; title: string; changeNote: string | null; createdAt: Date; createdBy: string }[]>`
    select version_no, title, change_note, created_at, created_by from test_case_version
    where test_case_id = ${tc.id} order by version_no desc`;
}

export interface SearchQuery {
  projectId: string;
  q?: string | undefined;
  folderId?: string | undefined;
  /** Inklusive Unterordner. */
  recursive?: boolean | undefined;
  status?: string | undefined;
  label?: string | undefined;
  component?: string | undefined;
  /** Testart aus Zephyr (custom_fields.testTypes), z. B. "System-Test" */
  testType?: string | undefined;
  priority?: string | undefined;
  /** Archivierte: nicht (Standard), mit (all) oder nur archivierte (only) */
  archived?: 'all' | 'only' | undefined;
  /** Abfragesprache (Stufe H2) – zusätzliche Bedingung und ggf. Sortierung */
  aql?: string | undefined;
  /** für ich() in der Abfrage */
  actor?: string | undefined;
  limit: number;
  offset: number;
}

export async function searchTestCases(db: Db, s: SearchQuery): Promise<{ total: number; items: TestCaseListItem[] }> {
  const q = s.q?.trim();
  const keyLike = q && /^[A-Z][A-Z0-9_]*-T?\d+$/i.test(q) ? q.toUpperCase() : null;
  const folderFilter = s.folderId
    ? s.recursive
      ? db`and tc.folder_id in (
            with recursive sub as (select id from folder where id = ${s.folderId}
              union all select f.id from folder f join sub on f.parent_id = sub.id)
            select id from sub)`
      : db`and tc.folder_id = ${s.folderId}`
    : db``;
  const textFilter = keyLike
    ? db`and (tc.key = ${keyLike} or tc.legacy_key = ${keyLike})`
    : q
      ? db`and (v.search @@ websearch_to_tsquery('german', ${q}) or v.title ilike ${'%' + q + '%'})`
      : db``;
  const aq = s.aql?.trim() ? await compileTestCaseQuery(db, s.aql, { projectId: s.projectId, actor: s.actor }) : null;
  const archived = s.archived ?? (aq?.mentionsArchived ? 'all' : undefined);
  const rows = await db<(TestCaseListItem & { total: string })[]>`
    select ${TC_COLUMNS(db)}, v.title, v.format, v.priority, v.labels, v.components, jsonb_array_length(v.steps) as step_count,
           count(*) over () as total
    from test_case tc
    join project p on p.id = tc.project_id
    join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
    where tc.project_id = ${s.projectId}
      ${folderFilter}
      ${textFilter}
      ${s.status ? db`and tc.status = ${s.status}` : db``}
      ${s.label ? db`and ${s.label} = any(v.labels)` : db``}
      ${s.testType ? db`and v.custom_fields->'testTypes' @> ${db.json([s.testType] as never)}` : db``}
      ${s.component ? db`and ${s.component} = any(v.components)` : db``}
      ${s.priority ? db`and v.priority = ${s.priority}` : db``}
      ${archived === 'all' ? db`` : archived === 'only' ? db`and tc.archived_at is not null` : db`and tc.archived_at is null`}
      ${aq ? aq.where : db``}
    order by ${aq?.order ? db`${aq.order},` : db``} ${q && !keyLike ? db`ts_rank(v.search, websearch_to_tsquery('german', ${q})) desc,` : db``} length(tc.key), tc.key
    limit ${s.limit} offset ${s.offset}`;
  return {
    total: Number(rows[0]?.total ?? 0),
    items: rows.map(({ total: _t, ...r }) => ({ ...r, stepCount: Number(r.stepCount) })),
  };
}

export async function cloneTestCase(db: Db, idOrKey: string, actor: string): Promise<TestCaseDetail> {
  const src = await getTestCase(db, idOrKey);
  const { id: _i, testCaseId: _t, versionNo: _v, changeNote: _c, createdAt: _ca, createdBy: _cb, ...content } = src.version;
  return createTestCase(db, {
    projectId: src.projectId, folderId: src.folderId, owner: src.owner, status: await initialStatus(db),
    content: { ...content, title: `${content.title} (Kopie)`, steps: content.steps.map(({ id: _id, ...s }) => s) },
    changeNote: `Kopie von ${src.key}@v${src.currentVersion}`,
  }, actor);
}

export interface BulkChange {
  ids: string[];
  status?: string | undefined;
  folderId?: string | null | undefined;
  owner?: string | null | undefined;
  addLabels?: string[] | undefined;
  removeLabels?: string[] | undefined;
  addComponents?: string[] | undefined;
  removeComponents?: string[] | undefined;
  /** bereits gegen die Werteliste geprüft; null = Priorität entfernen */
  priority?: string | null | undefined;
  /** eigene Felder (bereits geprüft); leere Werte entfernen das Feld */
  fields?: Record<string, unknown> | undefined;
  archive?: boolean | undefined;
  estimateMinutes?: number | null | undefined;
}

/**
 * Massenbearbeitung von Testfällen (Stufe H3). Verwaltungsdaten ohne neue Version; inhaltliche Änderungen
 * (Labels, Komponenten, Priorität, Felder) ergeben je Testfall genau eine neue Version mit Änderungsnotiz.
 * Fehler einzelner Testfälle (z. B. Workflow) werden gesammelt statt die ganze Aktion abzubrechen.
 */
export async function bulkUpdate(db: Db, change: BulkChange, actor: string, opts: { enforceWorkflow?: boolean } = {}): Promise<{ updated: number; skipped: { key: string; reason: string }[] }> {
  let updated = 0;
  const skipped: { key: string; reason: string }[] = [];
  const content = change.addLabels?.length || change.removeLabels?.length || change.addComponents?.length || change.removeComponents?.length
    || change.priority !== undefined || (change.fields && Object.keys(change.fields).length);
  for (const id of change.ids) {
    try {
      if (change.status !== undefined || change.folderId !== undefined || change.owner !== undefined || change.estimateMinutes !== undefined) {
        await updateTestCaseMeta(db, id, { status: change.status, folderId: change.folderId, owner: change.owner, estimateMinutes: change.estimateMinutes }, actor, opts);
      }
      if (content) {
        const tc = await getTestCase(db, id);
        const labels = new Set(tc.version.labels);
        change.addLabels?.forEach((l) => labels.add(l));
        change.removeLabels?.forEach((l) => labels.delete(l));
        const components = new Set(tc.version.components);
        change.addComponents?.forEach((l) => components.add(l));
        change.removeComponents?.forEach((l) => components.delete(l));
        const customFields = { ...tc.version.customFields };
        for (const [k, v] of Object.entries(change.fields ?? {})) {
          if (v === null || v === '' || (Array.isArray(v) && !v.length)) delete customFields[k]; else customFields[k] = v;
        }
        const parts = [
          change.addLabels?.length || change.removeLabels?.length ? 'Labels' : null,
          change.addComponents?.length || change.removeComponents?.length ? 'Komponenten' : null,
          change.priority !== undefined ? 'Priorität' : null,
          change.fields && Object.keys(change.fields).length ? 'Felder' : null,
        ].filter(Boolean);
        await reviseTestCase(db, id, {
          ...tc.version, labels: [...labels].sort(), components: [...components].sort(),
          priority: change.priority === undefined ? tc.version.priority : change.priority, customFields,
        }, `${parts.join(', ')} per Massenbearbeitung geändert`, actor);
      }
      if (change.archive !== undefined) await setArchived(db, [id], change.archive, actor);
      updated++;
    } catch (e) {
      const [tc] = await db<{ key: string }[]>`select key from test_case where id::text = ${id} or key = ${id}`;
      skipped.push({ key: tc?.key ?? id, reason: (e as Error).message });
    }
  }
  return { updated, skipped };
}

/**
 * Massenfreigabe: Testfälle in einen Freigabe-Status setzen – ohne die Zwischenschritte des Workflows (z. B. Entwurf →
 * Review → Freigegeben), deshalb nur für das Testmanagement (Recht „manage“, in der Route geprüft). Das
 * Vier-Augen-Prinzip gilt weiter: Testfälle, deren aktuelle Version von der freigebenden Person stammt, werden
 * übersprungen. Ebenso bereits freigegebene, archivierte und außer Kraft gesetzte Testfälle.
 */
export async function approveTestCases(db: Db, ids: string[], actor: string, opts: { status?: string | undefined; note?: string | undefined } = {}) {
  const [target] = opts.status
    ? await db<{ code: string; category: string }[]>`select code, category from test_case_status where code = ${opts.status} and active`
    : await db<{ code: string; category: string }[]>`select code, category from test_case_status where active and category = 'APPROVED' order by (code = 'APPROVED') desc, sort_order limit 1`;
  if (!target || target.category !== 'APPROVED') throw badRequest(opts.status ? `„${opts.status}“ ist kein aktiver Freigabe-Status` : 'Kein aktiver Freigabe-Status eingerichtet');
  const cats = new Map((await db<{ code: string; category: string }[]>`select code, category from test_case_status`).map((x) => [x.code, x.category]));
  const approved: string[] = [];
  const skipped = { own: [] as string[], already: [] as string[], deprecated: [] as string[], archived: [] as string[] };
  for (const id of ids) {
    const tc = await getTestCase(db, id, { forUpdate: true });
    if (tc.archivedAt) { skipped.archived.push(tc.key); continue; }
    const cat = cats.get(tc.status);
    if (cat === 'DEPRECATED') { skipped.deprecated.push(tc.key); continue; }
    if (cat === 'APPROVED' && tc.approvedVersion === tc.currentVersion) { skipped.already.push(tc.key); continue; }
    if (tc.version.createdBy === actor) { skipped.own.push(tc.key); continue; }
    await db`update test_case set status = ${target.code}, approved_version = ${tc.currentVersion}, approved_by = ${actor}, approved_at = now(), updated_at = now() where id = ${tc.id}`;
    await recordEvent(db, {
      type: EventTypes.TestCaseMetaChanged, aggregateType: 'TestCase', aggregateId: tc.id, actor,
      payload: { key: tc.key, before: { status: tc.status }, after: { status: target.code }, approval: { version: tc.currentVersion, bulk: true, note: opts.note ?? null } },
    });
    approved.push(tc.key);
  }
  return { status: target.code, approved: approved.length, approvedKeys: approved, skipped };
}

// ---- Schätzung (geplanter Aufwand) ----

/**
 * Schätzung aus Erfahrungswerten: Median der gemessenen Bearbeitungsdauer (mindestens zwei Messungen, aktuelle
 * oder vorige Version). Ohne Messwerte bleibt die Schätzung unverändert.
 */
export async function estimateFromHistory(db: Db, ids: string[], actor: string): Promise<{ updated: number; skipped: { key: string; reason: string }[] }> {
  let updated = 0;
  const skipped: { key: string; reason: string }[] = [];
  for (const id of ids) {
    const tc = await getTestCase(db, id);
    // nur Messungen der aktuellen und der vorigen Version (höchstens die letzten 20): Nach einer größeren Änderung
    // verzerren Messwerte alter Fassungen die Schätzung (Review Teil 3, Befund 26)
    const [m] = await db<{ n: number; median: number | null }[]>`select count(*)::int as n, percentile_cont(0.5) within group (order by d) as median from (
        select e.duration_seconds as d from test_execution e join test_case_version v on v.id = e.test_case_version_id
        where e.test_case_id = ${tc.id} and e.duration_seconds > 0 and v.version_no >= ${tc.currentVersion - 1}
        order by e.executed_at desc nulls last limit 20) x`;
    if (!m || m.n < 2 || !m.median) { skipped.push({ key: tc.key, reason: `nur ${m?.n ?? 0} gemessene Ausführung(en)` }); continue; }
    const minutes = Math.max(1, Math.round(m.median / 60));
    await updateTestCaseMeta(db, tc.id, { estimateMinutes: minutes }, actor);
    updated++;
  }
  return { updated, skipped };
}

// ---- Archivieren und Löschen (Stufe H4) ----

/** Archivieren blendet Testfälle aus Listen, Auswahl und Auswertungen aus; Inhalte und Ergebnisse bleiben erhalten. */
export async function setArchived(db: Db, ids: string[], archive: boolean, actor: string): Promise<{ updated: number }> {
  let updated = 0;
  for (const id of ids) {
    const tc = await getTestCase(db, id, { forUpdate: true });
    if (!!tc.archivedAt === archive) continue;
    await db`update test_case set archived_at = ${archive ? new Date() : null}, archived_by = ${archive ? actor : null}, updated_at = now() where id = ${tc.id}`;
    await recordEvent(db, { type: archive ? EventTypes.TestCaseArchived : EventTypes.TestCaseRestored, aggregateType: 'TestCase', aggregateId: tc.id, actor, payload: { key: tc.key } });
    updated++;
  }
  return { updated };
}

/**
 * Endgültig löschen – nur Testfälle, die nie eingeplant wurden (sonst archivieren: Nachvollziehbarkeit der
 * Ergebnisse). Versionen, Verweise, Anhänge und Testset-Mitgliedschaften gehen mit; der Schlüssel wird nicht neu vergeben.
 */
export async function deleteTestCase(db: Db, idOrKey: string, actor: string): Promise<{ key: string }> {
  const tc = await getTestCase(db, idOrKey, { forUpdate: true });
  const [used] = await db`select 1 from test_execution where test_case_id = ${tc.id} limit 1`;
  if (used) throw badRequest(`${tc.key} wurde bereits in Zyklen eingeplant – zum Ausblenden archivieren statt löschen.`);
  await deleteAttachmentsOf(db, 'TEST_CASE', tc.id);
  await db`delete from external_reference where owner_type = 'TEST_CASE' and owner_id = ${tc.id}`;
  // Reste ohne Fremdschlüssel (Sicherheits-Review Teil 2, Befund 12): Kommentare (Löschkonzept), Beobachtungen
  await db`delete from comment where owner_type = 'TEST_CASE' and owner_id = ${tc.id}`;
  // Beobachter in die Nutzlast des Löschereignisses: die Benachrichtigung erreicht sie so auch ohne die gelöschten Zeilen
  const watchers = (await db<{ username: string }[]>`delete from watch where object_type = 'TEST_CASE' and object_id = ${tc.id} returning username`).map((w) => w.username);
  await db`delete from dataset_override where test_case_id = ${tc.id}`;
  await db`update test_set set test_case_ids = array_remove(test_case_ids, ${tc.id}::uuid) where ${tc.id}::uuid = any(test_case_ids)`;
  await db`delete from test_case_version where test_case_id = ${tc.id}`;
  await db`delete from test_case where id = ${tc.id}`;
  await recordEvent(db, { type: EventTypes.TestCaseDeleted, aggregateType: 'TestCase', aggregateId: tc.id, actor,
    payload: { key: tc.key, title: tc.version.title, projectId: tc.projectId, versions: tc.currentVersion, watchers } });
  return { key: tc.key };
}

// ---- Ordner ----

export async function listFolders(db: Db, projectId: string): Promise<Folder[]> {
  const rows = await db<(Folder & { testCount: string })[]>`
    select f.id, f.project_id, f.parent_id, f.name, f.sort_order,
           (select count(*) from test_case tc where tc.folder_id = f.id) as test_count
    from folder f where f.project_id = ${projectId} order by f.sort_order, f.name`;
  return rows.map((r) => ({ ...r, testCount: Number(r.testCount) }));
}

/** Ordner muss zum Projekt gehören (Anlegen, Verschieben, Unterordner). */
export async function assertFolderInProject(db: Db, folderId: string | null | undefined, projectId: string): Promise<void> {
  if (!folderId) return;
  const [f] = await db`select 1 from folder where id = ${folderId} and project_id = ${projectId}`;
  if (!f) throw notFound('Ordner', folderId);
}

export async function createFolder(db: Db, projectId: string, parentId: string | null, name: string): Promise<Folder> {
  await assertFolderInProject(db, parentId, projectId);
  const [f] = await db<Folder[]>`
    insert into folder(project_id, parent_id, name) values (${projectId}, ${parentId}, ${name.trim()})
    returning id, project_id, parent_id, name, sort_order, 0 as test_count`;
  return f!;
}

/** Legt einen Ordnerpfad an (idempotent) und liefert die ID des letzten Ordners. */
export async function ensureFolderPath(db: Db, projectId: string, path: string[]): Promise<string | null> {
  let parentId: string | null = null;
  for (const name of path) {
    const [f]: { id: string }[] = await db<{ id: string }[]>`
      insert into folder(project_id, parent_id, name) values (${projectId}, ${parentId}, ${name})
      on conflict (project_id, parent_id, name) do update set name = excluded.name
      returning id`;
    parentId = f!.id;
  }
  return parentId;
}

export async function renameFolder(db: Db, folderId: string, name: string): Promise<void> {
  const r = await db`update folder set name = ${name.trim()} where id = ${folderId}`;
  if (r.count === 0) throw notFound('Ordner', folderId);
}

async function folderOf(db: Db, folderId: string) {
  const [f] = await db<{ id: string; projectId: string; parentId: string | null; name: string }[]>`select id, project_id, parent_id, name from folder where id = ${folderId}`;
  if (!f) throw notFound('Ordner', folderId);
  return f;
}

/** Ordner unter einen anderen Ordner (oder die oberste Ebene) verschieben – nicht in sich selbst oder einen Unterordner. */
export async function moveFolder(db: Db, folderId: string, parentId: string | null, actor: string): Promise<void> {
  const f = await folderOf(db, folderId);
  await assertFolderInProject(db, parentId, f.projectId);
  if (parentId) {
    const [loop] = await db`with recursive sub as (select id from folder where id = ${folderId}
      union all select c.id from folder c join sub on c.parent_id = sub.id) select 1 from sub where id = ${parentId}`;
    if (loop) throw badRequest('Ein Ordner kann nicht in sich selbst oder einen seiner Unterordner verschoben werden.');
  }
  const [dup] = await db`select 1 from folder where project_id = ${f.projectId} and parent_id is not distinct from ${parentId} and name = ${f.name} and id <> ${folderId}`;
  if (dup) throw badRequest(`Im Ziel gibt es bereits einen Ordner „${f.name}“.`);
  await db`update folder set parent_id = ${parentId} where id = ${folderId}`;
  await recordEvent(db, { type: EventTypes.FolderChanged, aggregateType: 'Folder', aggregateId: folderId, actor, payload: { action: 'moved', name: f.name, from: f.parentId, to: parentId, projectId: f.projectId } });
}

/**
 * Ordner löschen. Leere Ordner direkt; mit Inhalt nur mit {@code moveContents}: Testfälle und Unterordner wandern in
 * den übergeordneten Ordner (bzw. auf die oberste Ebene).
 */
export async function deleteFolder(db: Db, folderId: string, moveContents: boolean, actor: string): Promise<{ movedTestCases: number; movedFolders: number }> {
  const f = await folderOf(db, folderId);
  const [cnt] = await db<{ tcs: number; subs: number }[]>`select (select count(*)::int from test_case where folder_id = ${folderId}) as tcs,
    (select count(*)::int from folder where parent_id = ${folderId}) as subs`;
  const { tcs, subs } = cnt!;
  if ((tcs || subs) && !moveContents) throw badRequest(`Ordner „${f.name}“ enthält ${tcs} Testfälle und ${subs} Unterordner – Inhalt verschieben oder vorher leeren.`);
  if (subs) {
    const clash = await db<{ name: string }[]>`select c.name from folder c where c.parent_id = ${folderId}
      and exists (select 1 from folder o where o.project_id = ${f.projectId} and o.parent_id is not distinct from ${f.parentId} and o.name = c.name and o.id <> ${folderId})`;
    if (clash.length) throw badRequest(`Im übergeordneten Ordner gibt es bereits: ${clash.map((c) => c.name).join(', ')}`);
  }
  await db`update test_case set folder_id = ${f.parentId}, updated_at = now() where folder_id = ${folderId}`;
  await db`update folder set parent_id = ${f.parentId} where parent_id = ${folderId}`;
  await db`delete from folder where id = ${folderId}`;
  await recordEvent(db, { type: EventTypes.FolderChanged, aggregateType: 'Folder', aggregateId: folderId, actor, payload: { action: 'deleted', name: f.name, movedTestCases: tcs, movedFolders: subs, projectId: f.projectId } });
  return { movedTestCases: tcs, movedFolders: subs };
}

// ---- Versionskette ersetzen (Rekonstruktion aus Quellhistorie) ----

/** Änderungsnotizen, die ausschließlich von der Migration stammen – nur solche Ketten dürfen ersetzt werden. */
const MIGRATION_NOTE = /^(Migriert aus |Re-Import: |Rekonstruiert: )/;
const STAGE_OFFSET = 1_000_000;

export interface HistoricVersion { content: TestCaseContentInput; createdAt: Date; createdBy: string; changeNote: string }

/**
 * Stufe 1: legt die neue Versionskette mit vorläufigen Nummern an. Liefert null, wenn die bestehende Kette
 * manuelle Versionen enthält (dann wird nichts geändert) oder die neue Kette identisch ist.
 */
export async function stageVersionHistory(db: Db, testCaseId: string, versions: HistoricVersion[]):
  Promise<{ status: 'staged'; staged: { id: string; validFrom: Date }[] } | { status: 'manual' | 'unchanged' }> {
  const existing = await db<{ versionNo: number; changeNote: string | null; createdAt: Date; createdBy: string; title: string; format: string; gherkin: string | null;
    objective: string | null; preconditions: string | null; testData: string | null; priority: string | null; labels: string[]; components: string[];
    steps: unknown; sections: unknown; customFields: unknown }[]>`
    select * from test_case_version where test_case_id = ${testCaseId} order by version_no`;
  if (existing.some((v) => !MIGRATION_NOTE.test(v.changeNote ?? ''))) return { status: 'manual' };
  const same = existing.length === versions.length && existing.every((v, i) =>
    v.changeNote === versions[i]!.changeNote && v.createdAt.getTime() === versions[i]!.createdAt.getTime() && sameContent(v as TestCaseContentInput, versions[i]!.content));
  if (same) return { status: 'unchanged' };
  const staged: { id: string; validFrom: Date }[] = [];
  for (const [i, v] of versions.entries()) {
    const row = await insertVersion(db, testCaseId, STAGE_OFFSET + i + 1, withStepIds(v.content), v.changeNote, v.createdBy, v.createdAt);
    staged.push({ id: row.id, validFrom: v.createdAt });
  }
  return { status: 'staged', staged };
}

/** Stufe 3: alte Versionen entfernen (dürfen nicht mehr referenziert sein), vorläufige Nummern festschreiben. */
export async function commitVersionHistory(db: Db, testCaseId: string, actor: string): Promise<number> {
  await db`delete from test_case_version where test_case_id = ${testCaseId} and version_no < ${STAGE_OFFSET}`;
  const renumbered = await db<{ n: number }[]>`
    update test_case_version set version_no = version_no - ${STAGE_OFFSET}
    where test_case_id = ${testCaseId} and version_no > ${STAGE_OFFSET} returning version_no as n`;
  const r = { n: Math.max(...renumbered.map((x) => x.n)) };
  await db`update test_case set current_version = ${r.n}, updated_at = now() where id = ${testCaseId}`;
  await recordEvent(db, {
    type: EventTypes.TestCaseChanged, aggregateType: 'TestCase', aggregateId: testCaseId, actor,
    payload: { reconstructed: true, versions: r.n },
  });
  return r.n;
}

/** Filterwerte eines Projekts: Status, Labels, Komponenten, Testarten – mit Anzahl (aktuelle Versionen). */
export async function testCaseFacets(db: Db, projectId: string) {
  type F = { value: string; n: number }[];
  const cur = db`test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version`;
  return {
    priorities: await db<F>`select v.priority as value, count(*)::int as n from ${cur} where tc.project_id = ${projectId} and v.priority is not null and tc.archived_at is null group by 1 order by 2 desc`,
    archived: (await db<{ n: number }[]>`select count(*)::int as n from test_case where project_id = ${projectId} and archived_at is not null`)[0]?.n ?? 0,
    labels: await db<F>`select l as value, count(*)::int as n from ${cur} cross join unnest(v.labels) l where tc.project_id = ${projectId} group by 1 order by 2 desc limit 100`,
    components: await db<F>`select x as value, count(*)::int as n from ${cur} cross join unnest(v.components) x where tc.project_id = ${projectId} group by 1 order by 2 desc limit 100`,
    testTypes: await db<F>`select t as value, count(*)::int as n from ${cur}
      cross join jsonb_array_elements_text(case when jsonb_typeof(v.custom_fields->'testTypes') = 'array' then v.custom_fields->'testTypes' else '[]'::jsonb end) t
      where tc.project_id = ${projectId} group by 1 order by 2 desc`,
  };
}
