/**
 * Modul automation: Ergebnisse automatisierter Tests (JUnit-XML, Cucumber-JSON) aus CI-Pipelines als
 * Ausführungen übernehmen (Roadmap D1/B4, ADR-0017). Zuordnung zum Testfall über Automatisierungsverweis oder
 * Testfallschlüssel im Namen/Tag; gefundene Zuordnungen werden als Verweis gespeichert.
 */
import { checkSteps } from '../../../../shared/steps/groups.ts';
import type { Hono } from 'hono';
import { z } from 'zod';
import { type Db, inTx } from '../../platform/db.ts';
import { badRequest, HttpError, notFound, route } from '../../platform/http.ts';
import { addTestsToCycle, createCycle, defectKey, executeTest, foreignAssigned, getCycle, getExecution, isLead, setCycleConfiguration, withSavepoint } from '../execution/index.ts';
import { getVersionById, resolveExecutionSteps } from '../testcases/index.ts';
import { getProject } from '../projects/index.ts';
import { linkReference } from '../references/index.ts';
import { type AutoResult, type AutoStatus, type Format, FORMAT_LABEL, FORMATS, parseResults } from './parse.ts';
import { autoDefect, defectTargetAvailable } from '../integrations/index.ts';

/** Fehlschlag im selben Zyklus innerhalb dieses Zeitraums + jetzt bestanden = Wiederholungsversuch */
const RETRY_WINDOW_HOURS = 12;

export { parseCucumber, parseJUnit, parseResults, FORMATS } from './parse.ts';

const STATUS: Record<AutoStatus, string> = { passed: 'PASS', failed: 'FAIL', blocked: 'BLOCKED', skipped: 'NOT_EXECUTED' };
const RANK: Record<AutoStatus, number> = { failed: 3, blocked: 2, passed: 1, skipped: 0 };
const MAX_BYTES = 20 * 1024 * 1024;

export interface ImportOptions {
  cycleId?: string | undefined; cycleName?: string | undefined; planId?: string | undefined;
  build?: string | undefined; release?: string | undefined; environment?: string | undefined; format?: Format | undefined;
  /** Bei Fehlschlag Fehler in OpenProject anlegen (bzw. offenen Fehler des Testfalls wiederverwenden) */
  createDefects?: boolean | undefined;
  /** höchstens so viele neue Fehler je Import (Schutz vor Ticketflut) */
  maxNewDefects?: number | undefined;
  /**
   * Ohne cycleId: „new“ (Vorgabe) legt immer einen neuen Zyklus an – gibt es den Namen schon, mit Zusatz „(2)“ …;
   * „append“ ergänzt einen offenen Zyklus gleichen Namens (z. B. mehrere Ergebnisdateien einer Pipeline).
   */
  ifExists?: 'new' | 'append' | undefined;
  /** Testkonfiguration des Laufs, z. B. { device: ['iPad'] } – wird beim neuen Zyklus gesetzt, beim Anhängen verglichen */
  configuration?: Record<string, string[]> | undefined;
  /** Kurzform für configuration.device */
  device?: string | undefined;
}

export interface ImportResult {
  cycleId: string; format: Format; formatLabel: string; total: number; mapped: number; testCases: number;
  results: Record<string, number>;
  unmapped: { id: string; name: string; suite: string; status: AutoStatus }[];
  /** zugeordnet, aber nicht übernommen (archiviert, veraltet, einer anderen Person zugewiesen, …) */
  skipped: { key: string; reason: string }[];
  cycleName: string;
  /** true: neuer Zyklus angelegt; false: in einen bestehenden übernommen */
  cycleCreated: boolean;
  /** Hinweise, z. B. Name schon vergeben, abweichende Umgebung/Konfiguration beim Anhängen */
  warnings: string[];
  /** Testfälle, die erst in einem Wiederholungsversuch bestanden haben */
  retriedPassed: string[];
  /** als „fehlgeschlagen (bekannt)“ erfasst (@bekannter-fehler) */
  knownFailures: string[];
}

/**
 * Ergebnisse übernehmen (innerhalb einer Transaktion). Ohne Fehleranlage – die läuft erst nach dem Commit
 * (`createAutoDefects`), damit keine Tickets verwaisen, wenn der Import scheitert (Review Teil 3, Befund 15).
 * `isLead`: Import mit Pflegerecht; sonst bleiben Ausführungen, die (bei aktiver Projektregel „nur Zuständige“) einer
 * anderen Person zugewiesen sind, unverändert und werden als übersprungen gemeldet (Review Teil 3, Befund 3).
 */
export async function importResults(db: Db, projectKey: string, text: string, opts: ImportOptions, actor: string, ctx: { isLead?: boolean } = {}):
  Promise<ImportResult & { projectId: string; failedExecutions: string[] }> {
  const project = await getProject(db, projectKey);
  let parsed: ReturnType<typeof parseResults>;
  try {
    parsed = parseResults(text, opts.format);
  } catch (e) {
    throw badRequest(`Ergebnisdatei nicht lesbar: ${(e as Error).message}`);
  }
  if (!parsed.results.length) throw badRequest('Keine Testergebnisse gefunden');

  // Zielzyklus (Rückmeldung aus der Nutzung): ohne cycleId immer ein neuer Zyklus – nie stilles Zusammenführen zweier
  // Läufe über den Namen. Ergänzen eines bestehenden Zyklus nur ausdrücklich (cycleId bzw. ifExists=append), mit
  // Warnung bei abweichender Umgebung, Build oder Konfiguration.
  const warnings: string[] = [];
  const wantedCfg: Record<string, string[]> = { ...(opts.configuration ?? {}), ...(opts.device?.trim() ? { device: [opts.device.trim()] } : {}) };
  let cycleId = opts.cycleId;
  let cycleCreated = false;
  let existing: { id: string; name: string; environment: string | null; build: string | null; configuration: Record<string, string[]> | null } | undefined;
  if (cycleId) {
    const c = await getCycle(db, cycleId);
    if (c.projectId !== project.id) throw badRequest('Zyklus gehört zu einem anderen Projekt');
    existing = { id: c.id, name: c.name, environment: c.environment, build: c.build, configuration: (c as { configuration?: Record<string, string[]> | null }).configuration ?? null };
  } else {
    const base = opts.cycleName ?? `Automatisiert${opts.build ? ` ${opts.build}` : ''} ${new Date().toISOString().slice(0, 10)}`;
    if (opts.ifExists === 'append') {
      // abgeschlossene bzw. archivierte Zyklen gleichen Namens nicht wiederverwenden (Review Teil 3, Befund 4)
      [existing] = await db<{ id: string; name: string; environment: string | null; build: string | null; configuration: Record<string, string[]> | null }[]>`
        select id, name, environment, build, configuration from test_cycle where project_id = ${project.id} and name = ${base}
        and state <> 'closed' and archived_at is null and not is_adhoc
        ${opts.planId ? db`and plan_id = ${opts.planId}` : db``} order by created_at desc limit 1`;
      cycleId = existing?.id;
    }
    if (!existing) {
      const taken = new Set((await db<{ name: string }[]>`select name from test_cycle where project_id = ${project.id}
        and (name = ${base} or starts_with(name, ${`${base} (`}))`).map((r) => r.name));
      let name = base;
      for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;
      if (name !== base) warnings.push(`Einen Zyklus „${base}“ gibt es schon – die Ergebnisse stehen im neuen Zyklus „${name}“. Zum Ergänzen eines bestehenden Zyklus cycleId angeben (oder ifExists=append).`);
      const created = await createCycle(db, project.id, {
        name, planId: opts.planId ?? null, build: opts.build ?? null, release: opts.release ?? null, environment: opts.environment ?? null,
        customFields: { automated: true },
      }, actor);
      cycleId = created.id;
      cycleCreated = true;
      if (Object.keys(wantedCfg).length) {
        // automatisch erkannte Merkmale (aus Name/Umgebung) bleiben, angegebene kommen hinzu bzw. gehen vor
        const auto = ((await getCycle(db, cycleId)) as { configuration?: Record<string, string[]> | null }).configuration ?? {};
        await setCycleConfiguration(db, cycleId, { ...auto, ...wantedCfg });
      }
    }
  }
  if (existing) {
    const where = `Zyklus „${existing.name}“`;
    if (opts.environment && existing.environment && opts.environment.trim() !== existing.environment.trim()) {
      warnings.push(`Umgebung weicht ab: ${where} hat „${existing.environment}“, der Import „${opts.environment}“ – Ergebnisse überschreiben die bisherigen dieses Zyklus.`);
    }
    if (opts.build && existing.build && opts.build.trim() !== existing.build.trim()) warnings.push(`Build weicht ab: ${where} hat „${existing.build}“, der Import „${opts.build}“.`);
    for (const [k, v] of Object.entries(wantedCfg)) {
      const cur = existing.configuration?.[k] ?? [];
      if (cur.length && v.some((x) => !cur.includes(x))) warnings.push(`Konfiguration weicht ab (${k}): ${where} hat „${cur.join(', ')}“, der Import „${v.join(', ')}“.`);
    }
  }
  if (!cycleId) throw new Error('Zielzyklus fehlt');
  const [cycleRow] = await db<{ name: string }[]>`select name from test_cycle where id = ${cycleId}`;

  // Zuordnungsquellen (archivierte/veraltete Testfälle werden erkannt, aber als übersprungen gemeldet)
  const tcs = await db<{ id: string; key: string; legacyKey: string | null; archived: boolean; deprecated: boolean }[]>`
    select tc.id, tc.key, tc.legacy_key, tc.archived_at is not null as archived, coalesce(st.category = 'DEPRECATED', false) as deprecated
    from test_case tc left join test_case_status st on st.code = tc.status where tc.project_id = ${project.id}`;
  const tcById = new Map(tcs.map((t) => [t.id, t]));
  const byKey = new Map(tcs.map((t) => [t.key.toUpperCase(), t.id]));
  const byLegacy = new Map(tcs.filter((t) => t.legacyKey).map((t) => [t.legacyKey!.toUpperCase(), t.id]));
  const refs = await db<{ externalKey: string; ownerId: string }[]>`
    select r.external_key, r.owner_id from external_reference r join test_case tc on tc.id = r.owner_id
    where r.owner_type = 'TEST_CASE' and r.relation = 'AUTOMATION' and r.provider = 'automation' and tc.project_id = ${project.id}`;
  const byRef = new Map(refs.map((r) => [r.externalKey, r.ownerId]));

  const find = (r: AutoResult): { id: string; via: string } | null => {
    const ref = byRef.get(r.id.slice(0, 500));
    if (ref) return { id: ref, via: 'Verweis' };
    const hay = [...r.tags, r.name, r.suite].join(' ').toUpperCase();
    for (const m of hay.matchAll(/(?<![A-Z0-9])([A-Z][A-Z0-9]+)[-_]T[-_]?(\d+)(?![0-9])/g)) {
      const id = byKey.get(`${m[1]}-T${m[2]}`);
      if (id) return { id, via: 'Schlüssel' };
    }
    for (const m of hay.matchAll(/(?<![A-Z0-9])([A-Z][A-Z0-9]+)[-_](\d+)(?![0-9])/g)) {
      const id = byLegacy.get(`${m[1]}-${m[2]}`);
      if (id) return { id, via: 'Altschlüssel' };
    }
    // Fundstelle (Datei:Zeile) als letzte Stufe – Zeilen verschieben sich beim Bearbeiten, Schlüssel und Tag gehen vor
    const loc = r.location ? byRef.get(`loc:${r.location}`.slice(0, 500)) : undefined;
    if (loc) return { id: loc, via: 'Fundstelle' };
    return null;
  };

  const groups = new Map<string, AutoResult[]>();
  const unmapped: ImportResult['unmapped'] = [];
  const skipped: ImportResult['skipped'] = [];
  const toLink: { tcId: string; r: AutoResult }[] = [];
  const skippedTc = new Set<string>();
  for (const r of parsed.results) {
    const hit = find(r);
    if (!hit) {
      unmapped.push({ id: r.id.slice(0, 500), name: r.name, suite: r.suite, status: r.status });
      continue;
    }
    const tc = tcById.get(hit.id);
    if (tc && (tc.archived || tc.deprecated)) {
      if (!skippedTc.has(tc.id)) skipped.push({ key: tc.key, reason: tc.archived ? 'Testfall archiviert' : 'Testfall veraltet' });
      skippedTc.add(tc.id);
      continue;
    }
    (groups.get(hit.id) ?? groups.set(hit.id, []).get(hit.id)!).push(r);
    if (hit.via !== 'Verweis') toLink.push({ tcId: hit.id, r });
  }
  if (groups.size) await addTestsToCycle(db, cycleId, [...groups.keys()], actor);

  // Ausführungen gebündelt laden (statt getExecution je Ergebnis), Schritte einmal je Version auflösen
  const execs = groups.size ? await db<{ id: string; testCaseId: string; testCaseVersionId: string; category: string; executedAt: Date | null }[]>`
    select distinct on (e.test_case_id) e.id, e.test_case_id, e.test_case_version_id, s.category, e.executed_at from test_execution e join execution_status s on s.code = e.status
    where e.cycle_id = ${cycleId} and e.test_case_id = any(${[...groups.keys()]}::uuid[]) order by e.test_case_id, e.created_at desc` : [];
  const execOf = new Map(execs.map((e) => [e.testCaseId, e]));
  const foreign = ctx.isLead ? new Map<string, string>() : await foreignAssigned(db, execs.map((e) => e.id), actor);
  const stepCache = new Map<string, Promise<{ id?: string | undefined }[]>>();
  const stepsOf = (versionId: string) => {
    if (!stepCache.has(versionId)) stepCache.set(versionId, getVersionById(db, versionId).then((v) => resolveExecutionSteps(db, v)));
    return stepCache.get(versionId)!;
  };

  const counts: Record<string, number> = {};
  const failedExecutions: string[] = [];
  const retriedPassed: string[] = [];
  const knownFailures: string[] = [];
  const [knownStatus] = await db<{ code: string }[]>`select code from execution_status where category = 'KNOWN_FAILURE' and active order by sort_order limit 1`;
  const lineOf = (r: AutoResult) => Number(r.location?.split(':').pop() ?? 0);
  for (const [tcId, all] of groups) {
    const key = tcById.get(tcId)?.key ?? tcId;
    const exec = execOf.get(tcId);
    if (!exec) { skipped.push({ key, reason: 'nicht im Zyklus eingeplant' }); continue; }
    const assignee = foreign.get(exec.id);
    if (assignee) { skipped.push({ key, reason: `zugewiesen an ${assignee}` }); continue; }
    // Wiederholungsversuche: dieselbe Fundstelle (bzw. Kennung) mehrfach im Bericht – der letzte Versuch zählt
    const attempts = new Map<string, AutoResult[]>();
    for (const r of all) { const k = r.location ?? r.id; (attempts.get(k) ?? attempts.set(k, []).get(k)!).push(r); }
    const rs = [...attempts.values()].map((a) => a.at(-1)!);
    const worst = rs.reduce((a, r) => (RANK[r.status] > RANK[a] ? r.status : a), 'skipped' as AutoStatus);
    // erst im Wiederholungsversuch bestanden: im selben Bericht oder gegenüber dem bisherigen Ergebnis dieses Zyklus
    // Ein früherer Fehlschlag zählt nur als Wiederholung, wenn er kurz zurückliegt (erneut gestarteter CI-Job) – ein Fix,
    // der im nächsten regulären Lauf besteht, ist kein wackelnder Test
    const recentFail = exec.category === 'FAILED' && !!exec.executedAt && Date.now() - new Date(exec.executedAt).getTime() < RETRY_WINDOW_HOURS * 3600_000;
    const retried = worst === 'passed' && ([...attempts.values()].some((a) => a.length > 1 && a.slice(0, -1).some((x) => x.status === 'failed'))
      || recentFail);
    // bekannte Fehler: Tag @bekannter-fehler (optional @fehler:<Ticket oder Befund>)
    const tags = rs.flatMap((r) => r.tags);
    const lower = new Set(tags.map((t) => t.toLowerCase()));
    const befunde = [...new Set(tags.filter((t) => /^fehler:/i.test(t)).map((t) => t.slice(6).trim()).filter(Boolean))];
    const known = !!knownStatus && worst === 'failed' && ['bekannter-fehler', 'known-failure', 'known-bug'].some((t) => lower.has(t));
    const status = known ? knownStatus!.code : STATUS[worst];
    const steps = checkSteps(await stepsOf(exec.testCaseVersionId));
    // Grundriss: Beispiele werden Durchläufe, wenn der Testfall einen Datensatz mit genau so vielen Zeilen hat
    let iterations: { index: number; status: string; comment: string | null; stepResults: [] }[] | undefined;
    if (rs.length > 1) {
      const ds = (await getExecution(db, exec.id)).dataset;
      if (ds && ds.rows.length === rs.length) {
        iterations = [...rs].sort((a, b) => lineOf(a) - lineOf(b)).map((r, i) => ({ index: i, status: STATUS[r.status], comment: r.message?.slice(0, 2000) ?? null, stepResults: [] }));
      }
    }
    // Schrittergebnisse aus dem schlechtesten Lauf, wenn das Szenario genau so viele Schritte hat wie der Testfall (Gherkin)
    const src = iterations ? undefined : rs.find((r) => r.status === worst && r.steps.length > 0 && r.steps.length === steps.length);
    const failures = rs.filter((r) => r.message);
    const tickets = befunde.filter((b) => /^(#?\d+|[A-Za-z][A-Za-z0-9_]*-\d+)$/.test(b));
    const comment = [
      `_Automatisiert (${FORMAT_LABEL[parsed.format]})_: ${rs.length === 1 ? rs[0]!.name : `${rs.length} Ergebnisse`}${rs[0]!.durationMs !== null ? ` · ${rs.reduce((a, r) => a + (r.durationMs ?? 0), 0)} ms` : ''}`,
      known && `*Bekannter Fehler* (Kennzeichnung @bekannter-fehler)${befunde.length ? `: ${befunde.join(', ')}` : ''}`,
      retried && '_Im Wiederholungsversuch bestanden – vorher fehlgeschlagen._',
      ...failures.slice(0, 5).map((r) => `*${r.name}*\n{noformat}\n${r.message!.slice(0, 4000).replace(/\{noformat\}/g, '')}\n{noformat}`),
    ].filter(Boolean).join('\n');
    // je Testfall ein Savepoint: ein nicht übernehmbares Ergebnis (z. B. gesperrter Zyklus) bricht nicht den ganzen Import ab
    try {
      const defects = known && tickets.length ? await Promise.all(tickets.map((t) => defectKey(t))) : undefined;
      await withSavepoint(db, (sp) => executeTest(sp, exec.id, {
        status, comment, ...(iterations ? { iterations } : {}), ...(defects ? { defects } : {}),
        // ohne Schrittangaben im Lauf: alte Schrittergebnisse gehören zu einem früheren Lauf und werden geleert
        stepResults: src ? steps.map((s, i) => ({ stepId: s.id!, status: STATUS[src.steps[i]!.status], comment: src.steps[i]!.message?.slice(0, 2000) ?? undefined })) : [],
        // Gesamtergebnis = schlechtestes Ergebnis des Laufs; übersprungene Schritte bzw. ein bekannter Fehler weichen davon ab
        overrideReason: known ? 'Automatisierungsimport: bekannter Fehler (@bekannter-fehler)'
          : src?.steps.some((x) => x.status === 'skipped') ? 'Automatisierungsimport: übersprungene Schritte' : undefined,
        note: retried ? 'Wiederholung: im Wiederholungsversuch bestanden' : undefined,
      }, actor));
    } catch (e) {
      skipped.push({ key, reason: (e as Error).message });
      continue;
    }
    counts[status] = (counts[status] ?? 0) + 1;
    if (worst === 'failed' && !known) failedExecutions.push(exec.id);
    if (known) knownFailures.push(key);
    if (retried) retriedPassed.push(key);
  }
  for (const l of toLink) {
    await linkReference(db, { ownerType: 'TEST_CASE', ownerId: l.tcId, provider: 'automation', externalKey: l.r.id.slice(0, 500), relation: 'AUTOMATION', title: l.r.name.slice(0, 300) }, actor);
  }
  // Fundstellen sicher zugeordneter Ergebnisse merken (Grundlage für die Zuordnung über Datei:Zeile)
  for (const [tcId, rs] of groups) {
    for (const loc of new Set(rs.map((r) => r.location).filter((x): x is string => !!x))) {
      if (byRef.get(`loc:${loc}`.slice(0, 500)) === tcId) continue;
      await db`delete from external_reference where owner_type = 'TEST_CASE' and provider = 'automation' and relation = 'AUTOMATION' and external_key = ${`loc:${loc}`.slice(0, 500)}
        and owner_id in (select id from test_case where project_id = ${project.id})`;
      await linkReference(db, { ownerType: 'TEST_CASE', ownerId: tcId, provider: 'automation', externalKey: `loc:${loc}`.slice(0, 500), relation: 'AUTOMATION', title: `Fundstelle ${loc}`.slice(0, 300) }, actor);
    }
  }
  if (parsed.results.some((r) => r.tags.some((t) => /^bekannter-fehler$/i.test(t))) && !knownStatus) {
    warnings.push('Kennzeichnung @bekannter-fehler gefunden, aber kein aktiver Status der Kategorie „Fehlgeschlagen (bekannt)“ – als fehlgeschlagen übernommen.');
  }
  return { projectId: project.id, failedExecutions, cycleId, cycleName: cycleRow?.name ?? '', cycleCreated, warnings, retriedPassed, knownFailures,
    format: parsed.format, formatLabel: FORMAT_LABEL[parsed.format], total: parsed.results.length,
    mapped: parsed.results.length - unmapped.length,
    testCases: groups.size, results: counts, unmapped, skipped };
}

/**
 * Fehler automatisch – nach dem Commit des Imports, je Ausführung eine eigene kurze Transaktion (Ticket anlegen →
 * verknüpfen): offene Fehler des Testfalls wiederverwenden, sonst neu anlegen (begrenzt).
 */
export async function createAutoDefects(db: Db, projectId: string, failedExecutions: string[], opts: Pick<ImportOptions, 'createDefects' | 'maxNewDefects'>, actor: string) {
  const defects = { created: [] as string[], reused: [] as string[], skipped: 0, reason: null as string | null };
  if (!opts.createDefects || !failedExecutions.length) return defects;
  const avail = await defectTargetAvailable(db, projectId);
  if (!avail.available) defects.reason = avail.reason;
  for (const id of failedExecutions) {
    if (defects.created.length >= (opts.maxNewDefects ?? 20)) { defects.skipped++; continue; }
    try {
      const r = await inTx(db, (tx) => autoDefect(tx, id, actor));
      if (!r) { defects.skipped++; continue; }
      (r.created ? defects.created : defects.reused).push(r.key);
    } catch (err) {
      defects.skipped++;
      defects.reason = (err as Error).message;
    }
  }
  return defects;
}

/** Import und anschließende Fehleranlage (getrennte Transaktionen). */
export async function runImport(db: Db, projectKey: string, text: string, opts: ImportOptions, actor: string, ctx: { isLead?: boolean } = {}) {
  const { projectId, failedExecutions, ...result } = await inTx(db, (tx) => importResults(tx, projectKey, text, opts, actor, ctx));
  return { ...result, defects: await createAutoDefects(db, projectId, failedExecutions, opts, actor) };
}

/** Konfiguration aus der Abfrage: „device=iPad;os=iOS,macOS“ → { device: ['iPad'], os: ['iOS', 'macOS'] } */
export function parseConfiguration(raw: string | undefined): Record<string, string[]> | undefined {
  if (!raw?.trim()) return undefined;
  const out: Record<string, string[]> = {};
  for (const part of raw.split(';')) {
    const [k, v] = part.split('=');
    const values = (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (k?.trim() && values.length) out[k.trim()] = values;
  }
  return Object.keys(out).length ? out : undefined;
}

export function automationRoutes(app: Hono, db: Db): void {
  route(app, {
    method: 'post', path: '/api/projects/:key/automation-results', tag: 'Automatisierung',
    summary: 'Ergebnisse im Rumpf als Ausführungen übernehmen (JUnit, Cucumber, TestNG, NUnit, xUnit.net, MSTest/TRX, Robot, Behave, Playwright, Jest – automatisch erkannt)',
    access: { level: 'execute', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, status: 201,
    query: z.object({
      cycleId: z.uuid().optional(), cycle: z.string().max(200).optional(), planId: z.uuid().optional(), build: z.string().max(100).optional(),
      release: z.string().max(100).optional(), environment: z.string().max(200).optional(), format: z.enum(FORMATS).optional(),
      createDefects: z.stringbool().optional(), ifExists: z.enum(['new', 'append']).optional(),
      device: z.string().max(100).optional(), configuration: z.string().max(500).optional().describe('z. B. device=iPad;os=iOS'),
    }),
  }, async ({ params, query, c, actor }) => {
    const lead = await isLead(c, { kind: 'project', key: params.key! });
    if (Number(c.req.header('content-length') ?? 0) > MAX_BYTES) throw new HttpError(413, 'Ergebnisdatei größer als 20 MB');
    const text = await c.req.text();
    if (!text.trim()) throw badRequest('Leerer Rumpf – Ergebnisdatei als Request-Body senden');
    if (query.planId) {
      const [p] = await db`select 1 from test_plan where id = ${query.planId}`;
      if (!p) throw notFound('Testplan', query.planId);
    }
    return runImport(db, params.key!, text, { ...query, cycleName: query.cycle, configuration: parseConfiguration(query.configuration) }, actor, { isLead: lead });
  });
  route(app, {
    method: 'post', path: '/api/projects/:key/automation-import', tag: 'Automatisierung',
    summary: 'Ergebnisdatei aus der Oberfläche übernehmen (Base64; Format wird erkannt)', status: 201,
    access: { level: 'execute', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
    body: z.object({
      fileName: z.string().max(255), contentBase64: z.string().min(1), format: z.enum(FORMATS).optional(),
      cycleId: z.uuid().optional(), cycleName: z.string().max(200).optional(), planId: z.uuid().optional(), build: z.string().max(100).optional(),
      release: z.string().max(100).optional(), environment: z.string().max(200).optional(), createDefects: z.boolean().optional(),
      ifExists: z.enum(['new', 'append']).optional(), device: z.string().max(100).optional(),
      configuration: z.record(z.string().max(50), z.array(z.string().max(100)).max(20)).optional(),
    }),
  }, async ({ params, body, actor, c }) => {
    const buf = Buffer.from(body.contentBase64, 'base64');
    if (buf.length > MAX_BYTES) throw new HttpError(413, 'Ergebnisdatei größer als 20 MB');
    const { contentBase64: _c, fileName: _f, ...opts } = body;
    return runImport(db, params.key!, buf.toString('utf8'), opts, actor, { isLead: await isLead(c, { kind: 'project', key: params.key! }) });
  });
  route(app, {
    method: 'post', path: '/api/projects/:key/automation-mapping', tag: 'Automatisierung',
    summary: 'Nicht zugeordnetes Automatisierungsergebnis dauerhaft einem Testfall zuordnen (gilt ab dem nächsten Import)',
    access: { level: 'edit', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
    body: z.object({ resultId: z.string().min(1).max(500), name: z.string().max(300).optional(), testCaseId: z.string() }),
  }, async ({ params, body, actor }) => {
    const p = await getProject(db, params.key!);
    const [tc] = await db<{ id: string; key: string }[]>`select id, key from test_case where project_id = ${p.id} and (id::text = ${body.testCaseId} or key = ${body.testCaseId})`;
    if (!tc) throw notFound('Testfall', body.testCaseId);
    await linkReference(db, { ownerType: 'TEST_CASE', ownerId: tc.id, provider: 'automation', externalKey: body.resultId, relation: 'AUTOMATION', title: (body.name ?? body.resultId).slice(0, 300) }, actor);
    return { key: tc.key };
  });
}
