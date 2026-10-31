/**
 * Erzeugt die Übersicht eines Migrationslaufs:
 *  - <work>/uebersicht-projekte.md   je Projekt (enthält Projektkürzel → bleibt lokal, nicht versioniert)
 *  - --doc <datei>                    aggregierte Ergebnisse für die Dokumentation (ohne Projektkürzel)
 *
 *   node --env-file-if-exists=../.env scripts/migration-overview.ts --work ../migration-snapshots/<lauf> --doc ergebnis-<datum>.md
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { config } from '../src/platform/config.ts';
import { connect } from '../src/platform/db.ts';
import type { MigrationReport } from '../src/modules/migration/index.ts';

const { values } = parseArgs({ options: { work: { type: 'string' }, doc: { type: 'string' } } });
const work = values.work!;
const db = connect(config.databaseUrl, { max: 2 });
const n = (x: number | undefined) => (x ?? 0).toLocaleString("de-DE");

try {
  const summary = JSON.parse(await readFile(join(work, 'summary.json'), 'utf8'));
  const reports: { project: string; r: MigrationReport }[] = [];
  for (const f of (await readdir(join(work, 'reports'))).filter((x) => x.endsWith('.json')).sort()) {
    reports.push({ project: f.replace(/\.json$/, ''), r: JSON.parse(await readFile(join(work, 'reports', f), 'utf8')) });
  }

  // Bestand in Anemo (ohne Beispieldaten DEMO)
  const [t] = await db<Record<string, number | undefined>[]>`
    select
      (select count(*) from project where key <> 'DEMO')::int as projects,
      (select count(*) from test_case tc join project p on p.id = tc.project_id where p.key <> 'DEMO')::int as tests,
      (select count(*) from test_case_version v join test_case tc on tc.id = v.test_case_id join project p on p.id = tc.project_id where p.key <> 'DEMO')::int as versions,
      (select count(*) from test_plan t join project p on p.id = t.project_id where p.key <> 'DEMO')::int as plans,
      (select count(*) from test_cycle c join project p on p.id = c.project_id where p.key <> 'DEMO')::int as cycles,
      (select count(*) from test_execution e join test_cycle c on c.id = e.cycle_id join project p on p.id = c.project_id where p.key <> 'DEMO')::int as executions,
      (select count(*) from test_execution e join test_cycle c on c.id = e.cycle_id join project p on p.id = c.project_id where p.key <> 'DEMO' and e.status <> 'NOT_EXECUTED')::int as executed,
      (select coalesce(sum(jsonb_array_length(e.step_results)), 0) from test_execution e join test_cycle c on c.id = e.cycle_id join project p on p.id = c.project_id where p.key <> 'DEMO')::int as step_results,
      (select count(*) from external_reference)::int as refs,
      (select count(*) from external_reference where relation = 'DEFECT')::int as defects`;
  const att = await db<{ ownerType: string; storage: string; count: number; bytes: number }[]>`
    select a.owner_type, a.storage, count(*)::int as count, coalesce(sum(a.size_bytes), 0)::float8 as bytes from attachment a
    left join test_case tc on a.owner_type = 'TEST_CASE' and tc.id = a.owner_id
    left join test_execution e on a.owner_type = 'TEST_EXECUTION' and e.id = a.owner_id
    left join test_case tce on tce.id = e.test_case_id
    join project p on p.id = coalesce(tc.project_id, tce.project_id) where p.key <> 'DEMO'
    group by 1, 2 order by 1, 2`;

  const passed = reports.filter((x) => x.r.verdict === 'PASSED');
  const failed = reports.filter((x) => x.r.verdict !== 'PASSED');
  const metrics = reports.reduce((a, x) => ({
    stepResults: a.stepResults + x.r.metrics.stepResults,
    matching: a.matching + x.r.metrics.stepResultsMatchingVersion,
    recTests: a.recTests + x.r.metrics.reconstructedTestCases,
  }), { stepResults: 0, matching: 0, recTests: 0 });
  const preserved = new Map<string, number>();
  for (const x of reports) for (const p of x.r.preservedFields) preserved.set(p.field.replace(/^customfield_\d+ \((.+)\)$/, '$1'), (preserved.get(p.field.replace(/^customfield_\d+ \((.+)\)$/, '$1')) ?? 0) + p.count);
  const rec = summary.reconciliation;
  // Über Zephyr-IDs nachgeholte Tests stehen in den Manifesten der Jira-Snapshots
  const supplemented: string[] = [];
  for (const key of await readdir(join(work, 'raw'))) {
    const m = JSON.parse(await readFile(join(work, 'raw', key, 'manifest.json'), 'utf8').catch(() => '{}'));
    supplemented.push(...(m.supplemented ?? []));
  }
  const gb = (b: number) => `${(b / 1e9).toFixed(2)} GB`;
  const attRows = att.map((a) => `| ${a.ownerType === 'TEST_CASE' ? 'Testfälle (Jira)' : 'Ausführungen/Schrittergebnisse (Zephyr)'} | ${a.storage === 'LOCAL' ? 'Datei in Anemo' : 'nur Verweis'} | ${n(a.count)} | ${gb(a.bytes)} |`);

  const doc = [
    `# Migrationsergebnis Jira/Zephyr → Anemo`, '',
    `Lauf: \`${work.split('/').pop()}\` · Stand: ${new Date().toLocaleString('de-DE')} · Quelle: Jira 7.1.1 + Zephyr for JIRA 3.1.3 (Datenbank-Dump)`, '',
    '## Ergebnis', '',
    `- **${passed.length} von ${reports.length} Projekten bestehen die Verifikation** (je Projekt: Vollständigkeit, keine Zusammenlegung, Zielobjekte, Schrittzahlen, Ausführungsstatus, Anhangsdateien, keine Fehler).`,
    `- **Globaler Abgleich Zephyr-Datenbank ↔ Anemo: ${rec.passed ? 'bestanden' : 'NICHT bestanden'}**`, '',
    '| Objekt | Zephyr | Anemo | Differenz |', '|---|---:|---:|---:|',
    ...rec.rows.map((r: { object: string; zephyr: number; anemo: number; difference: number }) => `| ${r.object} | ${n(r.zephyr)} | ${n(r.anemo)} | ${r.difference} |`), '',
    '## Bestand in Anemo', '',
    '| | Anzahl |', '|---|---:|',
    `| Projekte | ${n(t!.projects)} |`, `| Testfälle | ${n(t!.tests)} |`, `| Testfallversionen (davon rekonstruiert aus der Historie: ${n(metrics.recTests)} Testfälle) | ${n(t!.versions)} |`,
    `| Testpläne (Zephyr-Versionen) | ${n(t!.plans)} |`, `| Testzyklen (inkl. je Version ein „Ad hoc“-Zyklus für Ausführungen ohne Zyklus; in Zephyr ein Pseudo-Zyklus) | ${n(t!.cycles)} |`, `| Ausführungen (davon ausgeführt) | ${n(t!.executions)} (${n(t!.executed)}) |`,
    `| Schrittergebnisse | ${n(t!.stepResults)} |`, `| Verweise auf Jira-Vorgänge (davon Defects) | ${n(t!.refs)} (${n(t!.defects)}) |`, '',
    `Schrittergebnisse passend zu den Schritten der Version, auf die ihre Ausführung zeigt: **${n(metrics.matching)} von ${n(metrics.stepResults)} (${(100 * metrics.matching / Math.max(1, metrics.stepResults)).toFixed(1)} %)**.`, '',
    '## Anhänge', '',
    '| Herkunft | Speicherung | Anzahl | Größe |', '|---|---|---:|---:|', ...attRows, '',
    '## Verbleibende Befunde', '',
    ...(failed.length ? failed.map((x) => `- ${x.r.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.details.slice(0, 2).join('; ')
      .replace(/[A-Z]{2,}[A-Z0-9_]*-\d+/g, '<Vorgang>').replace(/\b[A-Z][A-Z0-9_]+(?=: )/g, '<Projekt>')}`).join(' · ')}`) : ['- keine']),
    ...(supplemented.length ? [`- ${supplemented.length} Tests fehlten im Jira-Suchindex (JQL fand sie nicht, obwohl sie existieren) und wurden über ihre Zephyr-ID direkt gelesen. Empfehlung: Jira-Index vor dem finalen Export neu aufbauen; Tests ohne Zephyr-Daten wären sonst nicht erkennbar.`] : []),
    ...(rec.supplemented?.unreadable?.length ? [`- ${rec.supplemented.unreadable.length} von Zephyr referenzierte Vorgänge sind für den Jira-Zugang nicht lesbar.`] : []),
    '- Drei Jira-Projekte sind für den Migrationszugang gesperrt (keine Zephyr-Daten vorhanden; ob sie Tests enthalten, ist offen).', '',
    '## Nur bewahrte Felder (Kandidaten für strukturiertes Mapping)', '',
    '| Feld | Vorkommen |', '|---|---:|',
    ...[...preserved].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f, c]) => `| ${f} | ${n(c)} |`), '',
    'Die Tabelle je Projekt liegt lokal im Arbeitsordner (`uebersicht-projekte.md`), da sie Projektkürzel enthält.', '',
  ].join('\n');

  const perProject = [
    '# Übersicht je Projekt (lokal, nicht versioniert)', '',
    '| Projekt | Ergebnis | Tests | Versionen | Zyklen | Ausführungen | Schrittergebnis-Sätze | passende Schrittergebnisse | Hinweise |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|',
    ...reports.map(({ project, r }) => {
      const c = Object.fromEntries(r.byType.map((b) => [b.sourceType, b.total]));
      const notes = r.checks.filter((x) => !x.passed).map((x) => `${x.name}: ${x.details[0] ?? ''}`).join('; ').replace(/\|/g, '/');
      return `| ${project} | ${r.verdict} | ${c.issue ?? 0} | ${n(r.metrics.reconstructedVersions)} | ${c.cycle ?? 0} | ${c.execution ?? 0} | ${c.stepresults ?? 0} | ${r.metrics.stepResults ? `${(100 * r.metrics.stepResultsMatchingVersion / r.metrics.stepResults).toFixed(1)} %` : '–'} | ${notes.slice(0, 200)} |`;
    }), '',
  ].join('\n');

  await writeFile(join(work, 'uebersicht-projekte.md'), perProject);
  if (values.doc) await writeFile(values.doc, doc);
  console.log(doc);
} finally {
  await db.end();
}
