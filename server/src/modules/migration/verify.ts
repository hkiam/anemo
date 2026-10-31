/**
 * Migration Verification: weist für einen Lauf nach, was aus jedem Quellobjekt geworden ist,
 * und prüft fachliche Invarianten zwischen Raw Store und kanonischem Modell.
 */
import type { Db } from '../../platform/db.ts';
import { normalizeStatus } from './normalize.ts';

export interface Check { name: string; passed: boolean; details: string[] }

export interface MigrationReport {
  run: { id: string; source: string; status: string; startedAt: Date; finishedAt: Date | null };
  verdict: 'PASSED' | 'FAILED';
  byType: { sourceType: string; total: number; outcomes: Record<string, number>; actions: Record<string, number> }[];
  preservedFields: { field: string; count: number }[];
  failures: { sourceType: string; sourceId: string; messages: string[] }[];
  checks: Check[];
  /** Kennzahlen ohne Bestanden/Nicht-bestanden-Wertung. */
  metrics: { stepResults: number; stepResultsMatchingVersion: number; reconstructedTestCases: number; reconstructedVersions: number };
}

export async function buildReport(db: Db, runId: string): Promise<MigrationReport> {
  const [runRow] = await db<(MigrationReport['run'] & { stats: { snapshot?: { warnings?: string[]; counts?: Record<string, number> | null; attachmentsRemoved?: boolean } } })[]>`
    select id, source, status, started_at, finished_at, stats from migration_run where id = ${runId}`;
  if (!runRow) throw new Error(`Migrationslauf ${runId} nicht gefunden`);
  const { stats, ...run } = runRow;

  const rows = await db<{ sourceType: string; outcome: string; action: string; n: number }[]>`
    select s.source_type, m.outcome, m.action, count(*)::int as n
    from migration_mapping m join source_record s on s.id = m.source_record_id
    where m.run_id = ${runId} group by 1, 2, 3 order by 1`;
  const byTypeMap = new Map<string, MigrationReport['byType'][number]>();
  for (const r of rows) {
    const t = byTypeMap.get(r.sourceType) ?? { sourceType: r.sourceType, total: 0, outcomes: {}, actions: {} };
    t.total += r.n;
    t.outcomes[r.outcome] = (t.outcomes[r.outcome] ?? 0) + r.n;
    t.actions[r.action] = (t.actions[r.action] ?? 0) + r.n;
    byTypeMap.set(r.sourceType, t);
  }

  const preservedFields = await db<{ field: string; count: number }[]>`
    select f as field, count(*)::int as count
    from migration_mapping m, unnest(m.preserved_fields) f
    where m.run_id = ${runId} group by f order by count desc, f`;

  const failures = await db<{ sourceType: string; sourceId: string; messages: string[] }[]>`
    select s.source_type, s.source_id, m.messages from migration_mapping m join source_record s on s.id = m.source_record_id
    where m.run_id = ${runId} and m.outcome = 'FAILED' order by s.source_type, s.source_id limit 500`;

  const checks: Check[] = [];

  // 0) Der Snapshot selbst ist vollständig (Lücken der Extraktion stehen im Manifest).
  const snapshotWarnings = stats.snapshot?.warnings ?? [];
  checks.push({
    name: 'Snapshot vollständig extrahiert (keine Lücken)',
    passed: snapshotWarnings.length === 0,
    details: [...snapshotWarnings.slice(0, 30), ...(snapshotWarnings.length > 30 ? [`… und ${snapshotWarnings.length - 30} weitere`] : [])],
  });

  // 0b) Alle Objekte des Snapshots wurden verarbeitet (unabhängig von der Importer-Logik gezählt).
  const snapshotCounts = stats.snapshot?.counts ?? {};
  const seen = new Map((await db<{ sourceType: string; n: number }[]>`
    select s.source_type, count(*)::int as n from migration_mapping m join source_record s on s.id = m.source_record_id
    where m.run_id = ${runId} group by 1`).map((r) => [r.sourceType, r.n]));
  const countChecks: [string, string][] = [['issues', 'issue'], ['cycles', 'cycle'], ['executions', 'execution']];
  const countDetails: string[] = [];
  let countsOk = true;
  for (const [countKey, sourceType] of countChecks) {
    const expected = snapshotCounts[countKey];
    if (expected === undefined) continue;
    const actual = seen.get(sourceType) ?? 0;
    countDetails.push(`${sourceType}: Snapshot ${expected}, verarbeitet ${actual}`);
    if (actual !== expected) countsOk = false;
  }
  checks.push({ name: 'Alle Objekte des Snapshots verarbeitet', passed: countsOk, details: countDetails });

  // 0b2) Anhangsdateien: Ein Anhang, der nur als Verweis auf die Quelle übernommen wurde, ist eine Lücke –
  //      außer der Snapshot wurde bewusst ohne Binärdaten erzeugt (Anonymisierung).
  const linkOnly = await db<{ sourceType: string; sourceId: string; msg: string }[]>`
    select s.source_type, s.source_id, msg from migration_mapping m join source_record s on s.id = m.source_record_id,
      jsonb_array_elements_text(m.messages) msg
    where m.run_id = ${runId} and msg like '%nur Verweis auf Quelle%'`;
  checks.push({
    name: 'Anhangsdateien übernommen (nicht nur verlinkt)',
    passed: linkOnly.length === 0 || !!stats.snapshot?.attachmentsRemoved,
    details: [
      ...(stats.snapshot?.attachmentsRemoved ? ['Snapshot ohne Binärdaten (anonymisiert) – Verweise erwartet'] : []),
      ...linkOnly.slice(0, 20).map((l) => `${l.sourceType} ${l.sourceId}: ${l.msg}`),
      ...(linkOnly.length > 20 ? [`… insgesamt ${linkOnly.length}`] : []),
    ],
  });

  // 0c) Keine Zusammenlegung: zwei Quellobjekte desselben Typs dürfen nicht auf dasselbe Zielobjekt zeigen.
  const merged = await db<{ sourceType: string; targetId: string; sources: string[] }[]>`
    select s.source_type, m.target_id, array_agg(s.source_id order by s.source_id) as sources
    from migration_mapping m join source_record s on s.id = m.source_record_id
    where m.run_id = ${runId} and m.target_id is not null and s.source_type in ('issue', 'cycle', 'execution')
    group by 1, 2 having count(*) > 1`;
  checks.push({
    name: 'Keine Zusammenlegung von Quellobjekten',
    passed: merged.length === 0,
    details: merged.slice(0, 30).map((x) => `${x.sourceType} ${x.sources.join(', ')} → dasselbe Ziel`),
  });

  // 1) Vollständigkeit: jedes in diesem Lauf gesehene Rohobjekt hat eine Mapping-Zeile.
  const unmapped = await db<{ sourceType: string; sourceId: string }[]>`
    select s.source_type, s.source_id from source_record s
    where s.last_run_id = ${runId}
      and not exists (select 1 from migration_mapping m where m.run_id = ${runId} and m.source_record_id = s.id)`;
  checks.push({
    name: 'Jedes Quellobjekt hat ein dokumentiertes Ergebnis',
    passed: unmapped.length === 0,
    details: unmapped.slice(0, 50).map((u) => `${u.sourceType} ${u.sourceId} ohne Mapping`),
  });

  // 2) Zielobjekte existieren tatsächlich.
  const dangling = await db<{ sourceType: string; sourceId: string; targetType: string }[]>`
    select s.source_type, s.source_id, m.target_type from migration_mapping m join source_record s on s.id = m.source_record_id
    where m.run_id = ${runId} and m.target_id is not null and not (
      (m.target_type = 'TestCase' and exists (select 1 from test_case where id = m.target_id)) or
      (m.target_type = 'TestCaseVersion' and exists (select 1 from test_case_version where id = m.target_id)) or
      (m.target_type = 'TestCycle' and exists (select 1 from test_cycle where id = m.target_id)) or
      (m.target_type = 'TestExecution' and exists (select 1 from test_execution where id = m.target_id)) or
      (m.target_type = 'Project' and exists (select 1 from project where id = m.target_id)) or
      m.target_type not in ('TestCase', 'TestCaseVersion', 'TestCycle', 'TestExecution', 'Project'))`;
  checks.push({
    name: 'Alle Zielobjekte existieren',
    passed: dangling.length === 0,
    details: dangling.slice(0, 50).map((d) => `${d.sourceType} ${d.sourceId} → ${d.targetType} fehlt`),
  });

  // 3) Testschritte: Anzahl im Raw Store == Anzahl in der aktuellen Testfallversion.
  const stepMismatch = await db<{ sourceId: string; raw: number; mapped: number; key: string }[]>`
    select s.source_id, tc.key,
           jsonb_array_length(case when jsonb_typeof(s.payload) = 'array' then s.payload else coalesce(s.payload->'stepBeanCollection', '[]') end) as raw,
           jsonb_array_length(v.steps) as mapped
    from migration_mapping m
    join source_record s on s.id = m.source_record_id and s.source_type = 'teststeps'
    join migration_identity i on i.source_system = s.source_system and i.source_type = 'issue' and i.source_id = s.source_id and i.target_type = 'TestCase'
    join test_case tc on tc.id = i.target_id
    join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
    where m.run_id = ${runId}`;
  const badSteps = stepMismatch.filter((s) => s.raw !== s.mapped);
  checks.push({
    name: 'Schrittanzahl je Testfall stimmt mit Zephyr überein',
    passed: badSteps.length === 0,
    details: [`${stepMismatch.length} Testfälle geprüft`, ...badSteps.slice(0, 50).map((s) => `${s.key}: Zephyr ${s.raw}, Anemo ${s.mapped}`)],
  });

  // 4) Ausführungsstatus: Zephyr-Status-ID → abgebildeter Code stimmt (unabhängig vom Importer neu berechnet).
  // Statusdefinitionen sind projektübergreifende Rohobjekte; maßgeblich ist, was DIESER Lauf verarbeitet hat.
  const statusRecords = await db<{ payload: Record<string, unknown> }[]>`
    select s.payload from source_record s join migration_mapping m on m.source_record_id = s.id and m.run_id = ${runId}
    where s.source_type = 'execution-status'`;
  const expectedCode = new Map(statusRecords.map((r) => {
    const s = normalizeStatus(r.payload);
    return [s.sourceId, s.code];
  }));
  const executions = await db<{ sourceId: string; zephyrStatus: string | null; actual: string }[]>`
    select s.source_id, s.payload->>'executionStatus' as zephyr_status, e.status as actual
    from migration_mapping m
    join source_record s on s.id = m.source_record_id and s.source_type = 'execution'
    join test_execution e on e.id = m.target_id
    where m.run_id = ${runId}`;
  const badStatus = executions.filter((e) => (expectedCode.get(e.zephyrStatus ?? '-1') ?? 'NOT_EXECUTED') !== e.actual);
  checks.push({
    name: 'Ausführungsstatus korrekt abgebildet',
    passed: badStatus.length === 0,
    details: [`${executions.length} Ausführungen geprüft`, ...badStatus.slice(0, 50).map((e) => `Ausführung ${e.sourceId}: Zephyr ${e.zephyrStatus}, Anemo ${e.actual}`)],
  });

  // 5) Keine fehlgeschlagenen Objekte.
  checks.push({ name: 'Keine fehlgeschlagenen Objekte', passed: failures.length === 0, details: failures.slice(0, 20).map((f) => `${f.sourceType} ${f.sourceId}`) });

  // Kennzahl: passen die Schrittergebnisse zu den Schritten der Version, auf die ihre Ausführung zeigt?
  const [fit] = await db<{ total: number; matching: number }[]>`
    select count(*)::int as total,
           count(*) filter (where exists (select 1 from jsonb_array_elements(v.steps) st where st->>'id' = r->>'stepId'))::int as matching
    from migration_mapping m
    join source_record s on s.id = m.source_record_id and s.source_type = 'execution'
    join test_execution e on e.id = m.target_id
    join test_case_version v on v.id = e.test_case_version_id,
    jsonb_array_elements(e.step_results) r
    where m.run_id = ${runId}`;
  const [rec] = await db<{ cases: number; versions: number }[]>`
    select count(distinct m.target_id)::int as cases, coalesce(sum(tc.current_version), 0)::int as versions
    from migration_mapping m join source_record s on s.id = m.source_record_id and s.source_type = 'version-history'
    join test_case tc on tc.id = m.target_id where m.run_id = ${runId}`;

  return {
    metrics: { stepResults: fit!.total, stepResultsMatchingVersion: fit!.matching, reconstructedTestCases: rec!.cases, reconstructedVersions: rec!.versions },
    run,
    verdict: checks.every((c) => c.passed) && run.status === 'COMPLETED' ? 'PASSED' : 'FAILED',
    byType: [...byTypeMap.values()],
    preservedFields,
    failures,
    checks,
  };
}
