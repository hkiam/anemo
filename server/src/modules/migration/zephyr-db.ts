/**
 * Source-Adapter "Zephyr-Datenbank" (ADR-0009): Zephyr for JIRA 3.1.3 hat keine ZAPI. Die Zephyr-Daten
 * kommen deshalb aus einem Dump der AO_7DEABF_*-Tabellen (geladen mit `npm run zephyr:load`).
 *
 * Der Adapter erzeugt daraus dieselben Snapshot-Dateien, die sonst die ZAPI liefert (teststeps, cycles,
 * executions, stepresults, execution-attachments, execution-statuses) und ergänzt damit einen
 * Jira-Snapshot (issues, projects, fields). Normalizer, Import und Verifikation bleiben unverändert.
 */
import { spawn } from 'node:child_process';
import { copyFile, cp, link, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { estimateStepCreation } from './history.ts';
import { type Manifest, SnapshotReader } from './snapshot.ts';

type Json = Record<string, any>;

/** Zeilenquelle: eine SQL-Abfrage, die je Zeile genau eine JSON-Spalte liefert. */
export interface RowSource {
  rows(sql: string): AsyncIterable<Json>;
}

/** Liest aus der lokalen MariaDB `zephyr-db` (Compose-Profil `zephyr`) über den mariadb-Client im Container. */
export class DockerMariaDb implements RowSource {
  readonly database: string;
  readonly cwd: string;

  constructor(database = 'zephyr', cwd = new URL('../../../../', import.meta.url).pathname) {
    this.database = database;
    this.cwd = cwd;
  }

  async *rows(sql: string): AsyncIterable<Json> {
    const p = spawn('docker', ['compose', '--profile', 'zephyr', 'exec', '-T', 'zephyr-db', 'mariadb', '-uroot', '-pzephyr',
      '--batch', '--raw', '--skip-column-names', '--default-character-set=utf8mb4', this.database, '-e', sql],
    { cwd: this.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    const exit = new Promise<number>((ok) => p.on('close', (code) => ok(code ?? 1)));
    for await (const line of createInterface({ input: p.stdout, crlfDelay: Infinity })) {
      if (line) yield JSON.parse(line) as Json;
    }
    if ((await exit) !== 0) throw new Error(`Zephyr-DB-Abfrage fehlgeschlagen: ${err.trim()}`);
  }
}

export interface IssueInfo { key: string; summary: string | null; status: string | null }

export interface ZephyrDbSnapshotOptions {
  db: RowSource;
  /** Jira-Snapshot (issues, projects, fields), z. B. aus `extract --no-zephyr`. */
  jiraSnapshotDir: string;
  outDir: string;
  /** Statusdefinitionen; `provisional: true` wird als Lücke im Manifest vermerkt. */
  statuses: { provisional?: boolean; source?: string; statuses: { id: number; name: string; description?: string; color?: string | null }[] };
  /** Anhangsarchiv aus export-zephyr.ps1 (attachments/<id> + index.json). */
  attachmentsArchive?: string | undefined;
  /** Löst Jira-Issue-IDs (Defects) in Schlüssel auf; fehlt der Resolver, bleiben IDs stehen (Lücke). */
  resolveIssues?: ((ids: string[]) => Promise<Map<string, IssueInfo>>) | undefined;
  log?: (m: string) => void;
}

/** Globale Nachweise "Schritt existierte zum Zeitpunkt t" (früheste Änderung bzw. frühestes Schrittergebnis) je Schritt-ID. */
const firstSeenCache = new WeakMap<RowSource, Promise<Map<string, number>>>();
function stepFirstSeen(db: RowSource): Promise<Map<string, number>> {
  let p = firstSeenCache.get(db);
  if (!p) {
    p = (async () => {
      const m = new Map<string, number>();
      for await (const r of db.rows(`
        SELECT JSON_OBJECT('id', id, 't', MIN(t)) FROM (
          SELECT ZEPHYR_ENTITY_ID AS id, CREATED AS t FROM ao_7deabf_change_zjegroup WHERE ZEPHYR_ENTITY_TYPE = 'TESTSTEP'
          UNION ALL SELECT STEP_ID, EXECUTED_ON FROM ao_7deabf_step_result WHERE EXECUTED_ON > 0
          -- Zephyr löscht Schrittergebnisse mit ihrem Schritt: Jedes (auch unausgeführte) Schrittergebnis beweist,
          -- dass der Schritt existierte, als die Ausführung angelegt bzw. ausgeführt wurde.
          UNION ALL SELECT r.STEP_ID, LEAST(COALESCE(NULLIF(s.EXECUTED_ON, 0), UNIX_TIMESTAMP(s.DATE_CREATED) * 1000),
                                            COALESCE(UNIX_TIMESTAMP(s.DATE_CREATED) * 1000, s.EXECUTED_ON))
            FROM ao_7deabf_step_result r JOIN ao_7deabf_schedule s ON s.ID = r.SCHEDULE_ID
          ) x WHERE t IS NOT NULL GROUP BY id`)) {
        m.set(String(r.id), Number(r.t));
      }
      for await (const r of db.rows(`SELECT JSON_OBJECT('id', ID) FROM ao_7deabf_teststep`)) if (!m.has(String(r.id))) m.set(String(r.id), Number.NaN);
      return m;
    })();
    firstSeenCache.set(db, p);
  }
  return p;
}

const list = (ids: Iterable<string | number>) => [...ids].map((i) => String(Number(i))).join(',') || 'NULL';

async function group<T extends Json>(rows: AsyncIterable<T>, key: (r: T) => string): Promise<Map<string, T[]>> {
  const m = new Map<string, T[]>();
  for await (const r of rows) {
    const k = key(r);
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  return m;
}

export async function buildSnapshotFromZephyrDb(o: ZephyrDbSnapshotOptions): Promise<Manifest> {
  const log = o.log ?? (() => {});
  const jira = new SnapshotReader(o.jiraSnapshotDir);
  const base = await jira.manifest();
  await rm(o.outDir, { recursive: true, force: true });
  await mkdir(o.outDir, { recursive: true });
  for (const part of ['fields.json', 'projects', 'issues']) {
    await cp(join(o.jiraSnapshotDir, part), join(o.outDir, part), { recursive: true }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    });
  }
  // Jira-Anhänge der Testfälle (jira-<id>) übernehmen – als Hardlink, damit große Bestände nicht doppelt Platz belegen
  const jiraFiles = await readdir(join(o.jiraSnapshotDir, 'attachments')).catch(() => [] as string[]);
  if (jiraFiles.length) await mkdir(join(o.outDir, 'attachments'), { recursive: true });
  for (const f of jiraFiles) {
    const from = join(o.jiraSnapshotDir, 'attachments', f);
    const to = join(o.outDir, 'attachments', f);
    await link(from, to).catch(() => copyFile(from, to));
  }
  const write = async (path: string[], data: unknown) => {
    await mkdir(join(o.outDir, ...path.slice(0, -1)), { recursive: true });
    await writeFile(join(o.outDir, ...path), JSON.stringify(data));
  };

  // Hinweise aus dem Jira-Snapshot übernehmen – außer dem Vermerk, dass Zephyr fehlt (das liefern wir jetzt).
  const warnings = (base.warnings ?? []).filter((w) => !/Zephyr-Daten .* nicht extrahiert|ZAPI\) nicht erreichbar/.test(w));
  const counts: Record<string, number> = { ...(base.counts ?? {}) };
  const inc = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

  // Statusdefinitionen: bevorzugt aus Zephyrs Einstellungen im Dump (ab Exportskript 1.1), sonst Konfiguration
  const fromDb = new Map<string, Json[]>();
  try {
    for await (const r of o.db.rows(`
      SELECT JSON_OBJECT('key', e.PROPERTY_KEY, 'value', t.propertyvalue) FROM propertyentry e JOIN propertytext t ON t.ID = e.ID
      WHERE e.PROPERTY_KEY IN ('zephyr.testcase.execution.statuses', 'zephyr.testcase.step.execution.statuses')`)) {
      fromDb.set(String(r.key), JSON.parse(String(r.value)) as Json[]);
    }
  } catch {
    // Älterer Dump ohne Jira-Eigenschaftstabellen
  }
  const configured = o.statuses.statuses.map((s) => ({ id: s.id, name: s.name, description: s.description ?? '', color: s.color ?? null, type: s.id > 4 ? 1 : 0 }));
  const statusList = fromDb.get('zephyr.testcase.execution.statuses') ?? configured;
  const stepStatusList = fromDb.get('zephyr.testcase.step.execution.statuses') ?? statusList;
  await write(['execution-statuses.json'], statusList);
  await write(['step-statuses.json'], stepStatusList);
  if (!fromDb.has('zephyr.testcase.execution.statuses') && o.statuses.provisional) {
    warnings.push(`Statusdefinitionen vorläufig (${o.statuses.source ?? 'manuell erfasst'}) – mit Export ab Skriptversion 1.1 aus der Quelle ersetzen`);
  }
  log(`Statusdefinitionen: ${fromDb.size ? 'aus Zephyr-Einstellungen im Dump' : 'aus Konfiguration'}`);
  const statusMap = Object.fromEntries(statusList.map((s) => [String(s.id), s]));

  // Anhangsarchiv einmalig entpacken (Cache neben dem Archiv); je Projekt werden nur benötigte Dateien kopiert.
  const archiveIds = new Set<string>();
  let archiveDir: string | null = null;
  if (o.attachmentsArchive) {
    archiveDir = `${o.attachmentsArchive}.d`;
    if (!(await readdir(join(archiveDir, 'attachments')).then(() => true, () => false))) {
      await mkdir(archiveDir, { recursive: true });
      await new Promise<void>((ok, fail) => {
        const p = spawn('tar', ['-xzf', o.attachmentsArchive!, '-C', archiveDir!], { stdio: 'inherit' });
        p.on('close', (c) => (c === 0 ? ok() : fail(new Error(`tar -xzf ${o.attachmentsArchive} → Exit ${c}`))));
      });
    }
    for (const id of await readdir(join(archiveDir, 'attachments'))) archiveIds.add(id);
  }

  for (const projectKey of base.projects) {
    const project = (await jira.json('projects', `${projectKey}.json`))!;
    const projectId = Number(project.id);
    const issueIds = new Set<string>();
    for (const f of await jira.list('issues')) {
      if (f.startsWith(`${projectKey}-`)) issueIds.add(String((await jira.json('issues', f))!.id));
    }
    log(`${projectKey}: ${issueIds.size} Tests im Jira-Snapshot, lese Zephyr-Daten …`);

    // Testschritte – für jeden Test eine Datei (leer, wenn Zephyr keine Schritte hat)
    const steps = await group(o.db.rows(`
      SELECT JSON_OBJECT('id', ID, 'orderId', ORDER_ID, 'step', STEP, 'data', DATA, 'result', RESULT,
                         'createdBy', CREATED_BY, 'modifiedBy', MODIFIED_BY, 'issueId', ISSUE_ID)
      FROM ao_7deabf_teststep WHERE ISSUE_ID IN (${list(issueIds)}) ORDER BY ISSUE_ID, ORDER_ID`), (r) => String(r.issueId));
    for (const id of issueIds) {
      const s = (steps.get(id) ?? []).map(({ issueId: _i, ...rest }) => rest);
      await write(['teststeps', `${id}.json`], s);
      inc('teststeps', s.length);
    }

    // Schritthistorie je Test (für die Versionsrekonstruktion) und geschätzter Anlegezeitpunkt je Schritt
    const seen = await stepFirstSeen(o.db);
    const known = new Map([...seen].filter(([, t]) => Number.isFinite(t)));
    const created = estimateStepCreation(known, seen.keys());
    const history = await group(o.db.rows(`
      SELECT JSON_OBJECT('issueId', g.ISSUE_ID, 't', g.CREATED, 'author', g.AUTHOR, 'event', g.ZEPHYR_ENTITY_EVENT, 'stepId', g.ZEPHYR_ENTITY_ID,
                         'items', JSON_ARRAYAGG(JSON_OBJECT('field', i.ZEPHYR_FIELD, 'old', i.OLD_VALUE, 'new', i.NEW_VALUE)))
      FROM ao_7deabf_change_zjegroup g JOIN ao_7deabf_change_zjeitem i ON i.CHANGE_ZJEGROUP_ID = g.ID
      WHERE g.ZEPHYR_ENTITY_TYPE = 'TESTSTEP' AND g.ISSUE_ID IN (${list(issueIds)})
      GROUP BY g.ID ORDER BY g.ISSUE_ID, g.CREATED`), (r) => String(r.issueId));
    let historyCount = 0;
    for (const id of issueIds) {
      const changes = (history.get(id) ?? []).map(({ issueId: _i, ...c }) => ({ ...c, stepId: String(c.stepId) }));
      const stepIds = new Set([...(steps.get(id) ?? []).map((st) => String(st.id)), ...changes.map((c) => c.stepId)]);
      const stepCreated = Object.fromEntries([...stepIds].filter((sid) => created.has(sid)).map((sid) => [sid, created.get(sid)!]));
      await write(['teststep-history', `${id}.json`], { changes, stepCreated });
      historyCount += changes.length;
    }
    inc('teststepChanges', historyCount);

    // Ausführungen (inkl. Ad hoc: CYCLE_ID NULL → Zyklus -1 je Version)
    const executions: Json[] = [];
    for await (const e of o.db.rows(`
      SELECT JSON_OBJECT('id', ID, 'orderId', ORDER_ID, 'executionStatus', STATUS, 'executedOnVal', NULLIF(EXECUTED_ON, 0),
                         'executedBy', EXECUTED_BY, 'assignedTo', ASSIGNED_TO, 'comment', COMMENT, 'cycleId', IFNULL(CYCLE_ID, -1),
                         'issueId', ISSUE_ID, 'versionId', VERSION_ID, 'projectId', PROJECT_ID, 'createdBy', CREATED_BY,
                         'creationDate', DATE_CREATED, 'modifiedBy', MODIFIED_BY, 'actualExecutionTime', ACTUAL_EXECUTION_TIME)
      FROM ao_7deabf_schedule WHERE PROJECT_ID = ${projectId} ORDER BY ID`)) executions.push(e);
    const execIds = executions.map((e) => e.id);

    // Defects (Ausführung + Schritt); Jira-Issue-IDs → Schlüssel
    const execDefects = await group(o.db.rows(`
      SELECT JSON_OBJECT('scheduleId', d.SCHEDULE_ID, 'defectId', d.DEFECT_ID)
      FROM ao_7deabf_schedule_defect d JOIN ao_7deabf_schedule s ON s.ID = d.SCHEDULE_ID WHERE s.PROJECT_ID = ${projectId}`), (r) => String(r.scheduleId));
    const stepDefects = await group(o.db.rows(`
      SELECT JSON_OBJECT('scheduleId', d.SCHEDULE_ID, 'stepId', d.STEP_ID, 'stepResultId', d.STEP_RESULT_ID, 'defectId', d.DEFECT_ID)
      FROM ao_7deabf_step_defect d JOIN ao_7deabf_schedule s ON s.ID = d.SCHEDULE_ID WHERE s.PROJECT_ID = ${projectId}`), (r) => String(r.scheduleId));
    const defectIds = new Set<string>();
    for (const l of [...execDefects.values(), ...stepDefects.values()]) for (const d of l) defectIds.add(String(d.defectId));
    const resolved = o.resolveIssues ? await o.resolveIssues([...defectIds]) : new Map<string, IssueInfo>();
    const unresolved = [...defectIds].filter((id) => !resolved.has(id));
    if (unresolved.length) {
      warnings.push(`${projectKey}: ${unresolved.length} von ${defectIds.size} Defect-IDs nicht in Jira auflösbar (gelöscht oder ohne Leserecht), z. B. ${unresolved.slice(0, 5).join(', ')}`);
    }
    const defectRef = (id: string) => {
      const r = resolved.get(id);
      return r ? { key: r.key, summary: r.summary, status: r.status } : { key: `jira-id:${id}`, summary: null, status: 'nicht auflösbar' };
    };

    const byFile = new Map<string, Json[]>();
    for (const e of executions) {
      e.defects = (execDefects.get(String(e.id)) ?? []).map((d) => defectRef(String(d.defectId)));
      const sd = stepDefects.get(String(e.id));
      if (sd) e.stepDefects = sd.map((d) => ({ stepId: d.stepId, stepResultId: d.stepResultId, defect: defectRef(String(d.defectId)) }));
      const k = `${e.versionId}_${e.cycleId}`;
      (byFile.get(k) ?? byFile.set(k, []).get(k)!).push(e);
    }
    for (const [k, list_] of byFile) await write(['executions', `${k}.json`], { status: statusMap, executions: list_ });
    inc('executions', executions.length);

    // Zyklen je Version; Ad-hoc-Zyklen nur, wenn es Ad-hoc-Ausführungen gibt
    const cycles = await group(o.db.rows(`
      SELECT JSON_OBJECT('id', ID, 'name', NAME, 'description', DESCRIPTION, 'build', BUILD, 'environment', ENVIRONMENT,
                         'startDate', START_DATE, 'endDate', END_DATE, 'versionId', VERSION_ID, 'projectId', PROJECT_ID,
                         'createdBy', CREATED_BY, 'modifiedBy', MODIFIED_BY, 'sprintId', SPRINT_ID)
      FROM ao_7deabf_cycle WHERE PROJECT_ID = ${projectId} ORDER BY ID`), (r) => String(r.versionId));
    for (const e of executions) {
      if (e.cycleId === -1) {
        const v = String(e.versionId);
        const l = cycles.get(v) ?? cycles.set(v, []).get(v)!;
        if (!l.some((c) => c.id === -1)) l.push({ id: -1, name: 'Ad hoc', versionId: Number(v), projectId });
      }
    }
    let cycleCount = 0;
    for (const [versionId, l] of cycles) {
      const resp: Json = { recordsCount: l.length };
      for (const c of l) {
        const { id, ...rest } = c;
        resp[String(id)] = rest;
      }
      await write(['cycles', projectKey, `${versionId}.json`], resp);
      cycleCount += l.length;
    }
    inc('cycles', cycleCount);

    // Schrittergebnisse je Ausführung
    const results = await group(o.db.rows(`
      SELECT JSON_OBJECT('id', ID, 'stepId', STEP_ID, 'executionId', SCHEDULE_ID, 'status', STATUS, 'comment', COMMENT,
                         'executedBy', EXECUTED_BY, 'executedOn', NULLIF(EXECUTED_ON, 0), 'createdBy', CREATED_BY, 'modifiedBy', MODIFIED_BY)
      FROM ao_7deabf_step_result WHERE PROJECT_ID = ${projectId} ORDER BY SCHEDULE_ID, ID`), (r) => String(r.executionId));
    for (const [execId, l] of results) await write(['stepresults', `${execId}.json`], l);
    inc('stepResults', [...results.values()].reduce((a, l) => a + l.length, 0));

    // Anhänge an Ausführungen und Schrittergebnissen → je Ausführung
    const attachments = await group(o.db.rows(`
      SELECT JSON_OBJECT('fileId', a.ID, 'fileName', a.FILE_NAME, 'fileSize', a.FILESIZE, 'author', a.AUTHOR, 'mimeType', a.MIMETYPE,
                         'dateCreated', a.DATE_CREATED, 'comment', a.COMMENT, 'entityType', a.TYPE, 'entityId', a.ENTITY_ID,
                         'executionId', IF(a.TYPE = 'SCHEDULE', a.ENTITY_ID, r.SCHEDULE_ID))
      FROM ao_7deabf_attachment a LEFT JOIN ao_7deabf_step_result r ON a.TYPE = 'TESTSTEPRESULT' AND r.ID = a.ENTITY_ID
      WHERE IF(a.TYPE = 'SCHEDULE', a.ENTITY_ID, r.SCHEDULE_ID) IN (${list(execIds)})`), (r) => String(r.executionId));
    let attachmentCount = 0;
    const missingFiles: string[] = [];
    for (const [execId, l] of attachments) {
      await write(['execution-attachments', `${execId}.json`], l);
      attachmentCount += l.length;
      for (const a of l) {
        const id = String(a.fileId);
        if (archiveDir && archiveIds.has(id)) {
          await mkdir(join(o.outDir, 'attachments'), { recursive: true });
          await copyFile(join(archiveDir, 'attachments', id), join(o.outDir, 'attachments', `zapi-${id}`));
        } else {
          missingFiles.push(id);
        }
      }
    }
    inc('executionAttachments', attachmentCount);
    if (missingFiles.length) {
      warnings.push(`${projectKey}: ${missingFiles.length} Anhangsdateien nicht im Snapshot${o.attachmentsArchive ? '' : ' (kein Anhangsarchiv angegeben)'}`);
    }
    log(`${projectKey}: ${cycleCount} Zyklen, ${executions.length} Ausführungen, ${counts.stepResults ?? 0} Schrittergebnisse, ${defectIds.size} Defects, ${attachmentCount} Anhänge`);
  }

  const manifest: Manifest = {
    ...base,
    sourceSystem: base.sourceSystem,
    extractedAt: base.extractedAt,
    counts,
    warnings,
  };
  await write(['manifest.json'], { ...manifest, zephyrSource: 'zephyr-db-dump' });
  return manifest;
}

/** Defect-Auflösung über Jira REST: `id in (…)` in Blöcken, unbekannte IDs werden ignoriert. */
export function jiraIssueResolver(get: <T>(path: string, params: Record<string, string | number>) => Promise<T>) {
  return async (ids: string[]): Promise<Map<string, IssueInfo>> => {
    const out = new Map<string, IssueInfo>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const r = await get<{ issues: Json[] }>('/rest/api/2/search', {
        jql: `id in (${chunk.join(',')})`, fields: 'summary,status', maxResults: 100, validateQuery: 'false',
      });
      for (const issue of r.issues) out.set(String(issue.id), { key: issue.key, summary: issue.fields?.summary ?? null, status: issue.fields?.status?.name ?? null });
    }
    return out;
  };
}

export async function readStatusConfig(path: string): Promise<ZephyrDbSnapshotOptions['statuses']> {
  return JSON.parse(await readFile(path, 'utf8'));
}
