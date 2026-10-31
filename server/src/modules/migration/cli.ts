/**
 * Migrations-CLI.
 *
 *   node src/modules/migration/cli.ts discover  [--deep ABC,XYZ]            (nur Mengen/Struktur, keine Inhalte)
 *   node src/modules/migration/cli.ts extract   --projects ABC,XYZ --out ../migration-snapshots/raw [--jql "..."]
 *                                               [--no-attachments] [--no-step-results] [--no-changelog]
 *   node src/modules/migration/cli.ts zephyr-snapshot --jira ../migration-snapshots/raw --out ../migration-snapshots/full
 *                                               [--statuses <Statusliste.json>] [--attachments <….attachments.tar.gz>] [--no-resolve]
 *                                               (Zephyr-Daten aus der lokalen Dump-DB `zephyr-db` ergänzen, siehe ADR-0009)
 *   node src/modules/migration/cli.ts migrate-projects --projects ALL|ABC,XYZ --work ../migration-snapshots/run-2026-10-11
 *                                               --attachments <….attachments.tar.gz> [--discovery <discovery.json>] [--concurrency 2]
 *                                               (Gesamtlauf: Extraktion, Zephyr-Daten, Import, Verifikation, globaler Abgleich)
 *   node src/modules/migration/cli.ts anonymize --in ../migration-snapshots/raw --out ../migration-snapshots/anon [--scrub-text]
 *   node src/modules/migration/cli.ts import    --in ../migration-snapshots/anon
 *   node src/modules/migration/cli.ts report    --run <runId>
 *   node src/modules/migration/cli.ts group-steps --mode dry-run|apply|revert [--projects ABC,XYZ] [--out <bericht.md>]
 *                                               (Stufe J1: Pfeil-Trennschritte im Bestand zu Abschnitten; ohne neue Versionen)
 *
 * Umgebung (aus ../.env): JIRA_BASE_URL oder JIRA_HOST; JIRA_BASIC_AUTH ("Basic …") oder JIRA_USER + JIRA_PASSWORD
 * oder JIRA_TOKEN; ANON_SALT; DATABASE_URL.
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { config } from '../../platform/config.ts';
import { connect } from '../../platform/db.ts';
import { migrate } from '../../platform/migrate.ts';
import { anonymizeSnapshot } from './anonymize.ts';
import { discover, extractSnapshot } from './extract.ts';
import { buildSnapshotFromZephyrDb, DockerMariaDb, jiraIssueResolver, readStatusConfig } from './zephyr-db.ts';
import { runImport } from './importer.ts';
import { buildReport, type MigrationReport } from './verify.ts';
import { groupSteps } from './grouping.ts';

/** Statusliste als Rückfall: instanzspezifische Liste unter intern/ (nicht veröffentlicht), sonst Zephyr-Standard. */
function defaultStatusFile(): string {
  const internal = new URL('../../../../intern/config/zephyr-statuses.json', import.meta.url).pathname;
  return existsSync(internal) ? internal : new URL('../../../../config/zephyr-statuses.json', import.meta.url).pathname;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    projects: { type: 'string' }, out: { type: 'string' }, in: { type: 'string' }, run: { type: 'string' },
    jql: { type: 'string' }, deep: { type: 'string' }, 'scrub-text': { type: 'boolean' }, 'keep-attachments': { type: 'boolean' },
    'no-step-results': { type: 'boolean' }, 'no-zephyr': { type: 'boolean' },
    jira: { type: 'string' }, statuses: { type: 'string' }, attachments: { type: 'string' }, 'no-resolve': { type: 'boolean' },
    work: { type: 'string' }, mode: { type: 'string' }, discovery: { type: 'string' }, concurrency: { type: 'string' }, 'no-changelog': { type: 'boolean' }, 'no-attachments': { type: 'boolean' },
  },
});

function need(name: string, v: string | undefined): string {
  if (!v) {
    console.error(`Fehlt: ${name}`);
    process.exit(2);
  }
  return v;
}

function printReport(r: MigrationReport) {
  console.log(`\nLauf ${r.run.id} – ${r.run.status} – Ergebnis: ${r.verdict}`);
  console.table(r.byType.map((t) => ({ typ: t.sourceType, gesamt: t.total, ...t.outcomes })));
  for (const c of r.checks) console.log(`${c.passed ? '✔' : '✘'} ${c.name}${c.details.length ? `\n    ${c.details.slice(0, 5).join('\n    ')}` : ''}`);
  const m = r.metrics;
  if (m.stepResults) console.log(`\nSchrittergebnisse passend zur referenzierten Version: ${m.stepResultsMatchingVersion}/${m.stepResults} (${(100 * m.stepResultsMatchingVersion / m.stepResults).toFixed(1)} %)`);
  if (m.reconstructedTestCases) console.log(`Versionshistorie: ${m.reconstructedTestCases} Testfälle, ${m.reconstructedVersions} Versionen`);
  if (r.preservedFields.length) {
    console.log('\nNur bewahrte Felder (Kandidaten für besseres Mapping):');
    console.table(r.preservedFields.slice(0, 20));
  }
}

function jiraConnection() {
  const host = process.env.JIRA_BASE_URL ?? (process.env.JIRA_HOST ? `http://${process.env.JIRA_HOST.replace(/^https?:\/\//, '')}` : undefined);
  const baseUrl = need('JIRA_BASE_URL oder JIRA_HOST', host);
  const header = process.env.JIRA_BASIC_AUTH;
  const auth = header
    ? { header: /^(Basic|Bearer) /.test(header) ? header : `Basic ${header.includes(':') ? Buffer.from(header).toString('base64') : header}` }
    : process.env.JIRA_TOKEN
      ? { token: process.env.JIRA_TOKEN }
      : { user: need('JIRA_USER', process.env.JIRA_USER), password: need('JIRA_PASSWORD', process.env.JIRA_PASSWORD) };
  return { baseUrl, auth };
}

const cmd = positionals[0];
if (cmd === 'discover') {
  const r = await discover({ ...jiraConnection(), deepProjects: values.deep?.split(',').map((p) => p.trim()), log: () => {} });
  console.log(JSON.stringify(r, null, 1));
} else if (cmd === 'extract') {
  const m = await extractSnapshot({
    ...jiraConnection(),
    projects: need('--projects', values.projects).split(',').map((p) => p.trim()),
    outDir: need('--out', values.out), jqlFilter: values.jql,
    withStepResults: !values['no-step-results'], withChangelog: !values['no-changelog'], withAttachments: !values['no-attachments'], withZephyr: !values['no-zephyr'],
    log: console.log,
  });
  console.log(`Snapshot geschrieben (${m.projects.join(', ')}): ${JSON.stringify(m.counts)}. Lücken: ${m.warnings?.length ?? 0}.`);
  console.log('Hinweis: Rohdaten enthalten Personen- und ggf. vertrauliche Daten – vor Weitergabe anonymisieren.');
} else if (cmd === 'zephyr-snapshot') {
  const { JiraClient } = await import('./extract.ts');
  const client = values['no-resolve'] ? null : new JiraClient(jiraConnection());
  const m = await buildSnapshotFromZephyrDb({
    db: new DockerMariaDb(),
    jiraSnapshotDir: need('--jira', values.jira),
    outDir: need('--out', values.out),
    statuses: await readStatusConfig(values.statuses ?? defaultStatusFile()),
    attachmentsArchive: values.attachments,
    resolveIssues: client ? jiraIssueResolver((path, params) => client.get(path, params)) : undefined,
    log: console.log,
  });
  console.log(`Snapshot geschrieben: ${JSON.stringify(m.counts)}`);
  if (m.warnings?.length) console.log(`Lücken/Hinweise (${m.warnings.length}):\n  ${m.warnings.join('\n  ')}`);
} else if (cmd === 'migrate-projects') {
  const { JiraClient } = await import('./extract.ts');
  const { migrateProjects } = await import('./orchestrate.ts');
  const jira = jiraConnection();
  const client = new JiraClient(jira);
  let projects = need('--projects', values.projects).split(',').map((p) => p.trim());
  if (projects.length === 1 && projects[0] === 'ALL') {
    // Alle Projekte mit Tests laut Discovery (oder live ermittelt)
    const d = values.discovery
      ? JSON.parse(await (await import('node:fs/promises')).readFile(values.discovery, 'utf8'))
      : await discover({ ...jira });
    projects = (d.projects as { key: string; tests: number }[]).filter((p) => p.tests > 0).map((p) => p.key);
  }
  const db = connect(config.databaseUrl, { max: 4, connection: { statement_timeout: 0 } });
  try {
    await migrate(db);
    const { results, reconciliation } = await migrateProjects({
      db, zephyrDb: new DockerMariaDb(), jira, projects, workDir: need('--work', values.work),
      statuses: await readStatusConfig(values.statuses ?? defaultStatusFile()),
      attachmentsArchive: values.attachments, attachmentDir: config.attachmentDir,
      resolveIssues: jiraIssueResolver((path, params) => client.get(path, params)),
      extractConcurrency: Number(values.concurrency ?? 2),
      log: (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`),
    });
    const passed = results.filter((r) => r.verdict === 'PASSED').length;
    console.log(`\nFertig: ${passed}/${results.length} Projekte PASSED; globaler Abgleich ${reconciliation.passed ? 'PASSED' : 'FAILED'}`);
    console.table(reconciliation.rows);
    console.log(`Zusammenfassung: ${values.work}/summary.md`);
  } finally {
    await db.end();
  }
} else if (cmd === 'anonymize') {
  const r = await anonymizeSnapshot(need('--in', values.in), need('--out', values.out), {
    salt: need('ANON_SALT', process.env.ANON_SALT), scrubText: values['scrub-text'] ?? false, keepAttachments: values['keep-attachments'] ?? false,
  });
  console.log(`${r.files} Dateien anonymisiert, ${r.people} Personen pseudonymisiert.`);
} else if (cmd === 'import' || cmd === 'report') {
  const db = connect(config.databaseUrl, { max: 2, connection: { statement_timeout: 0 } });
  try {
    await migrate(db);
    const runId = cmd === 'import' ? (await runImport(db, need('--in', values.in), { log: console.log, attachmentDir: config.attachmentDir })).runId : need('--run', values.run);
    const report = await buildReport(db, runId);
    printReport(report);
    process.exitCode = report.verdict === 'PASSED' ? 0 : 1;
  } finally {
    await db.end();
  }
} else if (cmd === 'group-steps') {
  const mode = need('--mode', values.mode);
  if (!['dry-run', 'apply', 'revert'].includes(mode)) { console.error('--mode dry-run | apply | revert'); process.exit(2); }
  const db = connect(config.databaseUrl, { max: 2, connection: { statement_timeout: 0 } });
  try {
    await migrate(db);
    const r = await groupSteps(db, { mode: mode as 'dry-run', projects: values.projects?.split(',').map((x) => x.trim()).filter(Boolean), report: values.out, log: console.log });
    const total = r.projects.reduce((a, p) => a + p.groups, 0);
    console.log(`\n${mode}: ${r.projects.length} Projekte, ${r.projects.reduce((a, p) => a + p.testCases, 0)} Testfälle, ${r.projects.reduce((a, p) => a + p.versions, 0)} Versionen${mode !== 'revert' ? `, ${total} Abschnitte, ${r.review.length} zur Sichtung` : ''}${values.out ? ` – Bericht: ${values.out}` : ''}`);
  } finally {
    await db.end();
  }
} else {
  console.error('Befehle: extract | anonymize | import | report | group-steps  (Details im Kopf von cli.ts)');
  process.exit(2);
}
