/**
 * Release-Cockpit (C3) je Testplan: Fortschritt über die Zeit, aktueller Stand, offene Fehler,
 * Risiko „geändert, aber nicht (erneut) getestet“, Freigabeempfehlung (Regeln wie im Abschlussbericht).
 * Archivierte Zyklen zählen wie im Abschlussbericht nicht mit.
 */
import type { Db } from '../../platform/db.ts';
import { defectResolution } from '../references/index.ts';
import { completionReport } from './data.ts';

export async function cockpit(db: Db, planId: string, actor: string) {
  const r = await completionReport(db, planId, actor, { steps: false });
  const cat = new Map(r.statuses.map((s) => [s.code, s.category]));
  // Verlauf: je Tag ausgeführte Ergebnisse nach Kategorie (aktuellster Stand der Ausführung)
  const days = await db<{ day: string; status: string; n: number }[]>`
    select to_char(e.executed_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as day, e.status, count(*)::int as n
    from test_execution e join test_cycle c on c.id = e.cycle_id
    where c.plan_id = ${planId} and c.archived_at is null and e.executed_at is not null
    group by 1, 2 order by 1`;
  const burn = new Map<string, { day: string; passed: number; failed: number; other: number }>();
  for (const d of days) {
    const x = burn.get(d.day) ?? burn.set(d.day, { day: d.day, passed: 0, failed: 0, other: 0 }).get(d.day)!;
    const c = cat.get(d.status);
    if (c === 'PASSED' || c === 'PASSED_WITH_ISSUES') x.passed += d.n;
    else if (c === 'FAILED' || c === 'BLOCKED') x.failed += d.n;
    else x.other += d.n;
  }
  const openDefects = r.defects.filter((d) => defectResolution(d.status) === 'open');
  const [effort] = await db<{ measured: number }[]>`
    select count(*) filter (where e.duration_seconds > 0)::int as measured
    from test_execution e join test_cycle c on c.id = e.cycle_id where c.plan_id = ${planId} and c.archived_at is null`;
  return {
    plan: r.plan, project: r.project, assessment: r.assessment, current: r.current, statuses: r.statuses,
    cycles: r.cycles.map((c) => ({ id: c.id, name: c.name, build: c.build, configuration: c.configuration, summary: c.summary })),
    burn: [...burn.values()],
    problems: r.problems.map((e) => ({ id: e.id, cycleId: e.cycleId, cycleName: e.cycleName, key: e.testCaseKey, title: e.title, status: e.status, defects: e.defects })),
    knownFailures: r.knownFailures.map((e) => ({ id: e.id, cycleId: e.cycleId, cycleName: e.cycleName, key: e.testCaseKey, title: e.title, status: e.status, defects: e.defects, comment: e.comment })),
    retestPending: r.retestPending,
    byConfiguration: r.byConfiguration,
    openDefects, allDefects: r.defects.length,
    changedNotTested: r.changedNotTested,
    coverage: r.coverage,
    effort: { seconds: r.effortSeconds, measured: effort?.measured ?? 0 },
    archivedCycles: r.archivedCycles,
    criteria: r.criteria, risks: r.risks, knownDefects: r.knownDefects, openFindings: r.openFindings, releaseDecision: r.releaseDecision,
  };
}
