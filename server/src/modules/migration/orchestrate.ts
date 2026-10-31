/**
 * Gesamtlauf über viele Projekte: je Projekt Jira-Extraktion → Zephyr-Daten aus der Dump-DB → Import →
 * Verifikation. Fortsetzbar (fertige Extraktionen werden wiederverwendet), mit zweitem Importdurchgang
 * für projektübergreifende Bezüge und globalem Abgleich gegen die Zephyr-Datenbank.
 */
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../../platform/db.ts';
import { extractSnapshot, JiraClient, type ExtractOptions } from './extract.ts';
import { type Manifest, SnapshotReader } from './snapshot.ts';
import { runImport } from './importer.ts';
import { buildReport, type MigrationReport } from './verify.ts';
import { buildSnapshotFromZephyrDb, type RowSource, type ZephyrDbSnapshotOptions } from './zephyr-db.ts';

export interface ProjectResult {
  project: string;
  phase: 'extract' | 'zephyr' | 'import' | 'done';
  error?: string;
  runId?: string;
  verdict?: 'PASSED' | 'FAILED';
  counts?: Record<string, number>;
  failures?: number;
  failedChecks?: string[];
  warnings?: string[];
}

export interface MigrateProjectsOptions {
  db: Db;
  zephyrDb: RowSource;
  jira: Pick<ExtractOptions, 'baseUrl' | 'auth'>;
  projects: string[];
  workDir: string;
  statuses: ZephyrDbSnapshotOptions['statuses'];
  attachmentsArchive?: string | undefined;
  resolveIssues?: ZephyrDbSnapshotOptions['resolveIssues'];
  attachmentDir: string;
  extractConcurrency?: number;
  log?: (m: string) => void;
}

const exists = (p: string) => access(p).then(() => true, () => false);

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

function summarize(project: string, runId: string, report: MigrationReport, warnings: string[]): ProjectResult {
  const counts: Record<string, number> = {};
  for (const t of report.byType) counts[t.sourceType] = t.total;
  return {
    project, phase: 'done', runId, verdict: report.verdict, counts, failures: report.failures.length,
    failedChecks: report.checks.filter((c) => !c.passed).map((c) => c.name), warnings,
  };
}

export async function migrateProjects(o: MigrateProjectsOptions): Promise<{ results: ProjectResult[]; reconciliation: Reconciliation }> {
  const log = o.log ?? (() => {});
  const results = new Map<string, ProjectResult>();
  await mkdir(join(o.workDir, 'reports'), { recursive: true });

  // 1) Jira-Extraktion (parallel, fortsetzbar)
  await pool(o.projects, o.extractConcurrency ?? 2, async (key) => {
    const rawDir = join(o.workDir, 'raw', key);
    if (await exists(join(rawDir, 'manifest.json'))) {
      log(`${key}: Jira-Extraktion vorhanden – übersprungen`);
      return;
    }
    try {
      const started = Date.now();
      await extractSnapshot({ ...o.jira, projects: [key], outDir: rawDir, withZephyr: false, withAttachments: true, withChangelog: true });
      log(`${key}: Jira-Extraktion fertig (${Math.round((Date.now() - started) / 1000)} s)`);
    } catch (e) {
      results.set(key, { project: key, phase: 'extract', error: (e as Error).message });
      log(`${key}: Jira-Extraktion FEHLGESCHLAGEN – ${(e as Error).message}`);
    }
  });

  // 1a) Ergänzen: Tests, die Zephyr kennt, die aber in keinem Snapshot stehen. Ursache kann ein veralteter
  //     Jira-Suchindex sein (JQL findet den Vorgang nicht, obwohl er existiert). Solche Tests werden direkt
  //     über ihre ID gelesen und dem passenden Projekt hinzugefügt.
  const supplement = await supplementFromZephyr(o, log);
  if (supplement.added.length || supplement.unreadable.length) {
    log(`Ergänzung über Zephyr-IDs: ${supplement.added.length} Tests nachgeholt (${supplement.added.join(', ')}), ${supplement.unreadable.length} nicht lesbar`);
  }

  // 1b) Nachholen: Anhänge, deren Download bei einer früheren Extraktion scheiterte (z. B. vorübergehender HTTP 500)
  for (const key of o.projects) {
    if (results.has(key)) continue;
    const repaired = await repairAttachments(join(o.workDir, 'raw', key), new JiraClient(o.jira));
    if (repaired) log(`${key}: ${repaired.fixed} fehlende Anhänge nachgeladen, ${repaired.remaining} weiterhin fehlend`);
  }

  // 2) Zephyr-Daten ergänzen und importieren (sequentiell)
  const imported: string[] = [];
  for (const key of o.projects) {
    if (results.has(key)) continue;
    const fullDir = join(o.workDir, 'full', key);
    try {
      const m = await buildSnapshotFromZephyrDb({
        db: o.zephyrDb, jiraSnapshotDir: join(o.workDir, 'raw', key), outDir: fullDir, statuses: o.statuses,
        attachmentsArchive: o.attachmentsArchive, resolveIssues: o.resolveIssues,
      });
      const r = await runImport(o.db, fullDir, { attachmentDir: o.attachmentDir });
      const report = await buildReport(o.db, r.runId);
      await writeFile(join(o.workDir, 'reports', `${key}.json`), JSON.stringify(report, null, 1));
      results.set(key, summarize(key, r.runId, report, m.warnings ?? []));
      imported.push(key);
      log(`${key}: ${report.verdict} – ${Object.entries(results.get(key)!.counts!).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    } catch (e) {
      results.set(key, { project: key, phase: 'import', error: (e as Error).stack ?? String(e) });
      log(`${key}: Import FEHLGESCHLAGEN – ${(e as Error).message}`);
    }
  }

  // 3) Zweiter Durchgang: Ausführungen, deren Test erst durch ein später importiertes Projekt bekannt wurde
  for (const key of imported) {
    const res = results.get(key)!;
    if (!res.failures) continue;
    const r = await runImport(o.db, join(o.workDir, 'full', key), { attachmentDir: o.attachmentDir });
    const report = await buildReport(o.db, r.runId);
    await writeFile(join(o.workDir, 'reports', `${key}.json`), JSON.stringify(report, null, 1));
    results.set(key, summarize(key, r.runId, report, res.warnings ?? []));
    log(`${key}: zweiter Durchgang – ${report.verdict}, ${report.failures.length} Fehler`);
  }

  const reconciliation = await reconcile(o.db, o.zephyrDb);
  reconciliation.supplemented = supplement;
  const all = o.projects.map((k) => results.get(k)!);
  await writeFile(join(o.workDir, 'summary.json'), JSON.stringify({ finishedAt: new Date().toISOString(), results: all, reconciliation }, null, 1));
  await writeFile(join(o.workDir, 'summary.md'), renderSummary(all, reconciliation));
  return { results: all, reconciliation };
}

export interface Reconciliation {
  rows: { object: string; zephyr: number; anemo: number; difference: number }[];
  /** Zephyr-Projekt-IDs mit Daten, die in keinem migrierten Projekt angekommen sind. */
  unmigratedProjects: { projectId: string; cycles: number; executions: number }[];
  passed: boolean;
  /** Über Zephyr-IDs nachgeholte Tests (fehlten im Jira-Suchindex) bzw. nicht lesbare. */
  supplemented?: { added: string[]; unreadable: { id: string; reason: string }[] };
}

/**
 * Globaler Abgleich Zephyr-DB ↔ Anemo über die Migrationsidentitäten: Was in Zephyr existiert, muss in Anemo
 * als Zielobjekt angekommen sein – unabhängig davon, welchem Projekt es zugeordnet war.
 */
export async function reconcile(db: Db, zephyr: RowSource): Promise<Reconciliation> {
  const zephyrIds = async (sql: string) => {
    const ids = new Set<string>();
    for await (const r of zephyr.rows(sql)) ids.add(String(r.id));
    return ids;
  };
  const migrated = async (sourceType: string) =>
    new Set((await db<{ sourceId: string }[]>`select source_id from migration_identity where source_type = ${sourceType}`).map((r) => r.sourceId));

  const schedules = await zephyrIds(`SELECT JSON_OBJECT('id', ID) FROM ao_7deabf_schedule`);
  const cycles = await zephyrIds(`SELECT JSON_OBJECT('id', CONCAT(VERSION_ID, ':', ID)) FROM ao_7deabf_cycle`);
  const testIssues = await zephyrIds(`SELECT DISTINCT JSON_OBJECT('id', ISSUE_ID) FROM ao_7deabf_teststep`);
  const migratedExec = await migrated('execution');
  const migratedCycles = await migrated('cycle');
  const migratedIssues = await migrated('issue');

  // Schritte und Schrittergebnisse: Zephyr-Zeilen vs. in Anemo gespeicherte Einträge
  let zephyrSteps = 0;
  for await (const r of zephyr.rows(`SELECT JSON_OBJECT('n', COUNT(*)) FROM ao_7deabf_teststep`)) zephyrSteps = Number(r.n);
  let zephyrStepResults = 0;
  for await (const r of zephyr.rows(`SELECT JSON_OBJECT('n', COUNT(*)) FROM ao_7deabf_step_result`)) zephyrStepResults = Number(r.n);
  // Nur Objekte zählen, die es in Zephyr gibt (z. B. keine Beispieldaten in derselben Datenbank)
  const [anemoSteps] = await db<{ n: number }[]>`
    select coalesce(sum(jsonb_array_length(s.payload)), 0)::int as n from source_record s
    join migration_identity i on i.source_type = 'issue' and i.source_id = s.source_id
    where s.source_type = 'teststeps' and jsonb_typeof(s.payload) = 'array' and s.source_id = any(${[...testIssues]}::text[])`;
  const [anemoStepResults] = await db<{ n: number }[]>`
    select coalesce(sum(jsonb_array_length(e.step_results)), 0)::int as n from test_execution e
    where e.id in (select target_id from migration_identity where source_type = 'execution' and source_id = any(${[...schedules]}::text[]))`;

  const count = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;
  const rows = [
    { object: 'Zyklen', zephyr: cycles.size, anemo: count(cycles, migratedCycles) },
    { object: 'Ausführungen', zephyr: schedules.size, anemo: count(schedules, migratedExec) },
    { object: 'Tests mit Zephyr-Schritten', zephyr: testIssues.size, anemo: count(testIssues, migratedIssues) },
    { object: 'Testschritte', zephyr: zephyrSteps, anemo: anemoSteps!.n },
    { object: 'Schrittergebnisse', zephyr: zephyrStepResults, anemo: anemoStepResults!.n },
  ].map((r) => ({ ...r, difference: r.zephyr - r.anemo }));

  const unmigratedProjects: Reconciliation['unmigratedProjects'] = [];
  const byProject = new Map<string, { cycles: number; executions: number }>();
  for await (const r of zephyr.rows(`SELECT JSON_OBJECT('id', CONCAT(VERSION_ID, ':', ID), 'p', PROJECT_ID) FROM ao_7deabf_cycle`)) {
    if (!migratedCycles.has(String(r.id))) (byProject.get(String(r.p)) ?? byProject.set(String(r.p), { cycles: 0, executions: 0 }).get(String(r.p))!).cycles++;
  }
  for await (const r of zephyr.rows(`SELECT JSON_OBJECT('id', ID, 'p', PROJECT_ID) FROM ao_7deabf_schedule`)) {
    if (!migratedExec.has(String(r.id))) (byProject.get(String(r.p)) ?? byProject.set(String(r.p), { cycles: 0, executions: 0 }).get(String(r.p))!).executions++;
  }
  for (const [projectId, v] of byProject) unmigratedProjects.push({ projectId, ...v });
  return { rows, unmigratedProjects: unmigratedProjects.sort((a, b) => b.executions - a.executions), passed: rows.every((r) => r.difference === 0) };
}

async function supplementFromZephyr(o: MigrateProjectsOptions, log: (m: string) => void) {
  const known = new Set<string>();
  const projectIds = new Map<string, string>(); // Jira-Projekt-ID -> Schlüssel
  // Alle vorhandenen Snapshots zählen als bekannt – auch Projekte, die in diesem (Teil-)Lauf nicht importiert werden
  const allExtracted = await readdir(join(o.workDir, 'raw')).catch(() => [] as string[]);
  for (const key of allExtracted) {
    const reader = new SnapshotReader(join(o.workDir, 'raw', key));
    if (!(await reader.exists('manifest.json'))) continue;
    const project = await reader.json('projects', `${key}.json`);
    if (project) projectIds.set(String(project.id), key);
    for (const f of await reader.list('issues')) known.add(String((await reader.json('issues', f))!.id));
  }
  const zephyrIds = new Set<string>();
  for await (const r of o.zephyrDb.rows(`SELECT JSON_OBJECT('id', ISSUE_ID) FROM (SELECT ISSUE_ID FROM ao_7deabf_teststep UNION SELECT ISSUE_ID FROM ao_7deabf_schedule) x`)) zephyrIds.add(String(r.id));
  const missing = [...zephyrIds].filter((id) => !known.has(id));
  const client = new JiraClient(o.jira);
  const added: string[] = [];
  const unreadable: { id: string; reason: string }[] = [];
  for (const id of missing) {
    try {
      const issue = await client.get<Record<string, any>>(`/rest/api/2/issue/${id}`, { fields: '*all', expand: 'changelog' });
      const key = projectIds.get(String(issue.fields?.project?.id));
      if (!key || !o.projects.includes(key)) {
        unreadable.push({ id, reason: `${issue.key}: Projekt ${issue.fields?.project?.key} ist nicht Teil dieses Laufs` });
        continue;
      }
      const rawDir = join(o.workDir, 'raw', key);
      await writeFile(join(rawDir, 'issues', `${issue.key}.json`), JSON.stringify(issue, null, 1));
      let files = 0;
      for (const a of issue.fields?.attachment ?? []) {
        await mkdir(join(rawDir, 'attachments'), { recursive: true });
        await writeFile(join(rawDir, 'attachments', `jira-${a.id}`), await client.binary(a.content));
        files++;
      }
      const reader = new SnapshotReader(rawDir);
      const m = await reader.manifest();
      const note = `${issue.key} fehlte im Jira-Suchindex – über Zephyr-ID ${id} direkt gelesen`;
      await writeFile(join(rawDir, 'manifest.json'), JSON.stringify({
        ...m, counts: { ...(m.counts ?? {}), issues: (m.counts?.issues ?? 0) + 1, attachmentFiles: (m.counts?.attachmentFiles ?? 0) + files },
        supplemented: [...((m as Manifest & { supplemented?: string[] }).supplemented ?? []), note],
      }, null, 1));
      added.push(issue.key);
      log(note);
    } catch (e) {
      unreadable.push({ id, reason: (e as Error).message.slice(0, 200) });
    }
  }
  return { added, unreadable };
}

function renderSummary(results: ProjectResult[], rec: Reconciliation): string {
  const ok = results.filter((r) => r.verdict === 'PASSED').length;
  const lines = [
    `# Migrationslauf – Zusammenfassung`, '',
    `Stand: ${new Date().toISOString()} · Projekte: ${results.length} · PASSED: ${ok} · nicht bestanden/fehlgeschlagen: ${results.length - ok}`, '',
    '## Globaler Abgleich Zephyr-Datenbank ↔ Anemo', '',
    '| Objekt | Zephyr | Anemo | Differenz |', '|---|---:|---:|---:|',
    ...rec.rows.map((r) => `| ${r.object} | ${r.zephyr} | ${r.anemo} | ${r.difference} |`), '',
    rec.supplemented?.added.length ? `Über Zephyr-IDs nachgeholt (fehlten im Jira-Suchindex): ${rec.supplemented.added.join(', ')}` : '',
    rec.supplemented?.unreadable.length ? `Nicht lesbar: ${rec.supplemented.unreadable.map((u) => `${u.id} (${u.reason})`).join('; ')}` : '', '',
    rec.unmigratedProjects.length
      ? `Nicht migrierte Zephyr-Daten nach Projekt-ID: ${rec.unmigratedProjects.map((p) => `${p.projectId} (${p.cycles} Zyklen, ${p.executions} Ausführungen)`).join('; ')}`
      : 'Alle Zyklen und Ausführungen der Zephyr-Datenbank sind migriert.', '',
    '## Projekte', '',
    '| Projekt | Ergebnis | Tests | Zyklen | Ausführungen | Schrittergebnis-Sätze | Fehler | Nicht bestandene Prüfungen / Hinweise |',
    '|---|---|---:|---:|---:|---:|---:|---|',
    ...results.map((r) => r.error
      ? `| ${r.project} | **${r.phase}-Fehler** | | | | | | ${r.error.split('\n')[0]!.replace(/\|/g, '/').slice(0, 160)} |`
      : `| ${r.project} | ${r.verdict === 'PASSED' ? 'PASSED' : '**FAILED**'} | ${r.counts?.issue ?? 0} | ${r.counts?.cycle ?? 0} | ${r.counts?.execution ?? 0} | ${r.counts?.stepresults ?? 0} | ${r.failures} | ${[...(r.failedChecks ?? []), ...(r.warnings ?? [])].join('; ').replace(/\|/g, '/').slice(0, 300)} |`),
    '',
  ];
  return lines.join('\n');
}

/** Lädt Jira-Anhänge nach, die im Snapshot fehlen, und aktualisiert die Lückenliste im Manifest. */
export async function repairAttachments(rawDir: string, client: JiraClient): Promise<{ fixed: number; remaining: number } | null> {
  const reader = new SnapshotReader(rawDir);
  const manifest = await reader.manifest();
  if (!(manifest.warnings ?? []).some((w) => / Anhang /.test(w))) return null;
  let fixed = 0;
  const stillMissing = new Set<string>();
  for (const file of await reader.list('issues')) {
    const issue = (await reader.json('issues', file))!;
    for (const a of issue.fields?.attachment ?? []) {
      if (await reader.exists('attachments', `jira-${a.id}`)) continue;
      try {
        const data = await client.binary(a.content);
        await mkdir(join(rawDir, 'attachments'), { recursive: true });
        await writeFile(join(rawDir, 'attachments', `jira-${a.id}`), data);
        fixed++;
      } catch {
        stillMissing.add(`${issue.key} Anhang ${a.filename}`);
      }
    }
  }
  const warnings = (manifest.warnings ?? []).filter((w) => {
    const m = /^(\S+ Anhang .+?): /.exec(w);
    return !m || stillMissing.has(m[1]!);
  });
  const updated: Manifest = { ...manifest, warnings, counts: { ...(manifest.counts ?? {}), attachmentFiles: (manifest.counts?.attachmentFiles ?? 0) + fixed } };
  await writeFile(join(rawDir, 'manifest.json'), JSON.stringify(updated, null, 1));
  return { fixed, remaining: stillMissing.size };
}
