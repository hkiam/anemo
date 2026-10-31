/**
 * Auswertungen (Stufe H): Abdeckungsverlauf, Top-Fehler, Team und Aufwand, projektübergreifendes Portfolio.
 */
import type { Db } from '../../platform/db.ts';
import { defectResolution } from '../references/index.ts';
import { traceabilitySeries } from './data.ts';
import { addDays, berlinDay, berlinDayEnd } from './time.ts';

/** höchstens so viele Wochen im Abdeckungsverlauf */
export const MAX_HISTORY_WEEKS = 26;
const historyCache = new Map<string, { at: number; value: Promise<CoverageWeek[]> }>();
type CoverageWeek = { date: string; OK: number; NOK: number; NOT_RUN: number; UNCOVERED: number };

/**
 * Abdeckung der Anforderungen eines Testplans je Woche, älteste zuerst. Stichtag: Ende (Europe/Berlin) des heutigen
 * Wochentags vor n Wochen; die aktuelle Woche zeigt den heutigen Stand. Daten werden einmal geladen und je Stichtag im
 * Speicher ausgewertet (Fach-Review Teil 3, Befund 21); das Ergebnis wird eine Minute zwischengespeichert.
 */
export async function coverageHistory(db: Db, planId: string, actor: string, weeks: number): Promise<CoverageWeek[]> {
  const n = Math.max(1, Math.min(MAX_HISTORY_WEEKS, Math.floor(weeks)));
  const today = berlinDay(new Date());
  const key = `${planId}|${n}|${today}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  if (historyCache.size > 500) historyCache.clear();
  const days = Array.from({ length: n }, (_, i) => addDays(today, -7 * (n - 1 - i)));
  const value = traceabilitySeries(db, planId, actor, days.map((d, i) => (i === n - 1 ? undefined : berlinDayEnd(d))))
    .then((ts) => ts.map((t, i) => ({ date: days[i]!, ...t.totals })));
  historyCache.set(key, { at: Date.now(), value });
  value.catch(() => historyCache.delete(key));
  return value;
}

/** Fehler nach Auswirkung: betroffene Testfälle, Ausführungen und Anforderungen (offene zuerst). */
export async function topDefects(db: Db, projectId: string, o: { planId?: string | undefined; days?: number | undefined; limit?: number | undefined }) {
  // Fehler an Ausführungen und als Fehler angelegte Sitzungsfunde (Fach-Review Teil 3, Befund 2)
  const rows = await db<{ provider: string; externalKey: string; title: string | null; status: string | null; url: string | null;
    executions: number; testCases: number; sessions: number; lastSeen: Date | null; cycles: string[]; tcIds: string[] }[]>`
    with refs as (
      select r.provider, r.external_key, r.title, r.status, r.url, e.id as execution_id, e.test_case_id, e.executed_at as seen,
        coalesce(e.executed_at, e.created_at) as at, c.name as cycle_name
      from external_reference r join test_execution e on e.id = r.owner_id join test_cycle c on c.id = e.cycle_id
      where r.owner_type = 'TEST_EXECUTION' and r.relation = 'DEFECT' and c.project_id = ${projectId}
        ${o.planId ? db`and c.plan_id = ${o.planId}` : db``}
      union all
      select r.provider, r.external_key, r.title, r.status, r.url, null, null, r.created_at, r.created_at, c.name
      from external_reference r join exploratory_session x on x.id = r.owner_id join test_cycle c on c.id = x.cycle_id
      where r.owner_type = 'EXPLORATORY_SESSION' and r.relation = 'DEFECT' and c.project_id = ${projectId}
        ${o.planId ? db`and c.plan_id = ${o.planId}` : db``})
    select provider, external_key, max(title) as title, max(status) as status, max(url) as url,
      count(distinct execution_id)::int as executions, count(distinct test_case_id)::int as test_cases,
      count(*) filter (where execution_id is null)::int as sessions, max(seen) as last_seen,
      (array_agg(distinct cycle_name))[1:5] as cycles, coalesce(array_agg(distinct test_case_id) filter (where test_case_id is not null), '{}') as tc_ids
    from refs
    ${o.days ? db`where at > now() - make_interval(days => ${o.days})` : db``}
    group by provider, external_key`;
  const reqs = rows.length ? await db<{ ownerId: string; externalKey: string }[]>`
    select owner_id, external_key from external_reference where owner_type = 'TEST_CASE' and relation in ('REQUIREMENT', 'STORY', 'EPIC')
      and owner_id = any(${[...new Set(rows.flatMap((r) => r.tcIds))]}::uuid[])` : [];
  const reqOf = new Map<string, Set<string>>();
  for (const r of reqs) (reqOf.get(r.ownerId) ?? reqOf.set(r.ownerId, new Set()).get(r.ownerId)!).add(r.externalKey);
  return rows.map(({ tcIds, ...r }) => ({
    ...r, resolution: defectResolution(r.status),
    requirements: [...new Set(tcIds.flatMap((id) => [...(reqOf.get(id) ?? [])]))].sort(),
  })).sort((a, b) => (a.resolution === 'open' ? 0 : 1) - (b.resolution === 'open' ? 0 : 1) || b.testCases - a.testCases || b.executions - a.executions)
    .slice(0, o.limit ?? 50);
}

/** Team und Aufwand: je zuständiger Person Umfang, Stand, erfasste und geplante Zeit; dazu Durchsatz je Tester. */
export async function workload(db: Db, projectId: string, o: { planId?: string | undefined; cycleId?: string | undefined }) {
  // archivierte Zyklen zählen beim Plan nicht mit (wie Abschlussbericht und Cockpit); ein ausdrücklich gewählter Zyklus schon
  const scope = o.cycleId ? db`c.id = ${o.cycleId}` : o.planId ? db`c.plan_id = ${o.planId} and c.archived_at is null` : db`c.state <> 'closed' and c.archived_at is null`;
  const byAssignee = await db<{ assignee: string | null; total: number; open: number; passed: number; problems: number; durationSeconds: number; plannedMinutes: number;
    remainingMinutes: number; withoutEstimate: number }[]>`
    select e.assignee, count(*)::int as total,
      count(*) filter (where s.category in ('OPEN', 'IN_PROGRESS'))::int as open,
      count(*) filter (where s.category in ('PASSED', 'PASSED_WITH_ISSUES'))::int as passed,
      count(*) filter (where s.category in ('FAILED', 'BLOCKED'))::int as problems,
      coalesce(sum(e.duration_seconds), 0)::int as duration_seconds,
      coalesce(sum(t.estimate_minutes), 0)::int as planned_minutes,
      coalesce(sum(t.estimate_minutes) filter (where s.category in ('OPEN', 'IN_PROGRESS')), 0)::int as remaining_minutes,
      count(*) filter (where t.estimate_minutes is null)::int as without_estimate
    from test_execution e join test_cycle c on c.id = e.cycle_id join test_case t on t.id = e.test_case_id join execution_status s on s.code = e.status
    where c.project_id = ${projectId} and ${scope}
    group by e.assignee order by e.assignee nulls last`;
  const byTester = await db<{ executedBy: string; week: number; month: number; durationSeconds: number; problems: number }[]>`
    select e.executed_by, count(*) filter (where e.executed_at > now() - interval '7 days')::int as week,
      count(*) filter (where e.executed_at > now() - interval '30 days')::int as month,
      coalesce(sum(e.duration_seconds) filter (where e.executed_at > now() - interval '30 days'), 0)::int as duration_seconds,
      count(*) filter (where e.executed_at > now() - interval '30 days' and s.category in ('FAILED', 'BLOCKED'))::int as problems
    from test_execution e join test_cycle c on c.id = e.cycle_id join execution_status s on s.code = e.status
    where c.project_id = ${projectId} and ${scope} and e.executed_by is not null and e.executed_at > now() - interval '30 days'
    group by e.executed_by order by month desc`;
  const byCycle = await db<{ id: string; name: string; total: number; open: number; durationSeconds: number; plannedMinutes: number; remainingMinutes: number }[]>`
    select c.id, c.name, count(*)::int as total, count(*) filter (where s.category in ('OPEN', 'IN_PROGRESS'))::int as open,
      coalesce(sum(e.duration_seconds), 0)::int as duration_seconds, coalesce(sum(t.estimate_minutes), 0)::int as planned_minutes,
      coalesce(sum(t.estimate_minutes) filter (where s.category in ('OPEN', 'IN_PROGRESS')), 0)::int as remaining_minutes
    from test_execution e join test_cycle c on c.id = e.cycle_id join test_case t on t.id = e.test_case_id join execution_status s on s.code = e.status
    where c.project_id = ${projectId} and ${scope}
    group by c.id, c.name order by max(coalesce(e.executed_at, e.created_at)) desc limit 50`;
  return { byAssignee, byTester, byCycle };
}

/** Portfolio über alle sichtbaren Projekte: Bestand, Aktivität, Bestehensquote, offene Fehler, aktuelles Release. */
export async function portfolio(db: Db, projectIds: string[] | null) {
  const projects = await db<{ id: string; key: string; name: string; visibility: string }[]>`
    select id, key, name, visibility from project ${projectIds ? db`where id = any(${projectIds}::uuid[])` : db``} order by key`;
  const ids = projects.map((p) => p.id);
  if (!ids.length) return [];
  const stats = await db<{ projectId: string; testCases: number; activeCycles: number; executed30: number; passed30: number; failed30: number; open: number; lastActivity: Date | null }[]>`
    select p.id as project_id,
      (select count(*)::int from test_case t where t.project_id = p.id and t.archived_at is null) as test_cases,
      (select count(*)::int from test_cycle c where c.project_id = p.id and c.state <> 'closed' and c.archived_at is null) as active_cycles,
      x.executed30, x.passed30, x.failed30, x.open, x.last_activity
    from project p left join lateral (
      select count(*) filter (where e.executed_at > now() - interval '30 days')::int as executed30,
        count(*) filter (where e.executed_at > now() - interval '30 days' and s.category in ('PASSED', 'PASSED_WITH_ISSUES'))::int as passed30,
        count(*) filter (where e.executed_at > now() - interval '30 days' and s.category = 'FAILED')::int as failed30,
        count(*) filter (where s.category in ('OPEN', 'IN_PROGRESS') and c.state <> 'closed' and c.archived_at is null)::int as open,
        max(e.executed_at) as last_activity
      from test_execution e join test_cycle c on c.id = e.cycle_id join execution_status s on s.code = e.status where c.project_id = p.id) x on true
    where p.id = any(${ids}::uuid[])`;
  const defects = await db<{ projectId: string; status: string | null }[]>`
    select distinct on (c.project_id, r.provider, r.external_key) c.project_id, r.status
    from external_reference r join test_execution e on e.id = r.owner_id join test_cycle c on c.id = e.cycle_id
    where r.owner_type = 'TEST_EXECUTION' and r.relation = 'DEFECT' and c.project_id = any(${ids}::uuid[])`;
  const plans = await db<{ projectId: string; name: string; release: string | null; releaseDecision: string | null }[]>`
    select distinct on (project_id) project_id, name, release, release_decision from test_plan where project_id = any(${ids}::uuid[]) order by project_id, created_at desc`;
  return projects.map((p) => {
    const s = stats.find((x) => x.projectId === p.id)!;
    const pl = plans.find((x) => x.projectId === p.id);
    return {
      key: p.key, name: p.name, visibility: p.visibility, testCases: s.testCases, activeCycles: s.activeCycles, openExecutions: s.open,
      executed30: s.executed30, passRate30: s.passed30 + s.failed30 ? Math.round((1000 * s.passed30) / (s.passed30 + s.failed30)) / 10 : null,
      openDefects: defects.filter((d) => d.projectId === p.id && defectResolution(d.status) === 'open').length,
      lastActivity: s.lastActivity, latestPlan: pl ? { name: pl.name, release: pl.release, releaseDecision: pl.releaseDecision } : null,
    };
  });
}
