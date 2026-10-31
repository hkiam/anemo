/**
 * Modul start: persönliche Startseite je Projekt („Meine Aufgaben“ + Überblick) und persönliche Einstellungen
 * (z. B. welche Kacheln in welcher Reihenfolge erscheinen).
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { HttpError, route } from '../../platform/http.ts';
import { can, principalOf } from '../auth/index.ts';
import { getProject } from '../projects/index.ts';

const OPEN = ['OPEN', 'IN_PROGRESS'];
const BAD = ['FAILED', 'BLOCKED', 'KNOWN_FAILURE'];

export async function startPage(db: Db, projectId: string, me: string, canEdit: boolean) {
  const [executions, openCount, sessions, drafts, kpis, cycles, failures, changes] = await Promise.all([
    // offene, mir zugewiesene Ausführungen – zuerst die von Zyklen mit nahem Ende
    db<{ id: string; cycleId: string; cycleName: string; key: string; title: string; status: string; endDate: string | null }[]>`
      select e.id, e.cycle_id, c.name as cycle_name, tc.key, v.title, e.status, c.end_date
      from test_execution e join test_cycle c on c.id = e.cycle_id join test_case tc on tc.id = e.test_case_id
      join test_case_version v on v.id = e.test_case_version_id join execution_status s on s.code = e.status
      where c.project_id = ${projectId} and e.assignee = ${me} and s.category in ${db(OPEN)} and c.state <> 'closed'
      order by c.end_date nulls last, c.created_at, e.order_no limit 8`,
    db<{ n: number; cycles: number }[]>`
      select count(*)::int as n, count(distinct e.cycle_id)::int as cycles
      from test_execution e join test_cycle c on c.id = e.cycle_id join execution_status s on s.code = e.status
      where c.project_id = ${projectId} and e.assignee = ${me} and s.category in ${db(OPEN)} and c.state <> 'closed'`,
    db<{ id: string; cycleId: string; cycleName: string; charter: string; status: string; timeboxMinutes: number }[]>`
      select x.id, x.cycle_id, c.name as cycle_name, x.charter, x.status, x.timebox_minutes
      from exploratory_session x join test_cycle c on c.id = x.cycle_id
      where c.project_id = ${projectId} and coalesce(x.tester, x.created_by) = ${me} and x.status in ('planned', 'running', 'paused')
      order by x.status = 'running' desc, x.created_at limit 6`,
    db<{ key: string; title: string; status: string; updatedAt: Date }[]>`
      select tc.key, v.title, tc.status, tc.updated_at
      from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
      join test_case_status s on s.code = tc.status
      where tc.project_id = ${projectId} and s.category = 'DRAFT' and coalesce(tc.owner, tc.created_by) = ${me} and tc.archived_at is null
      order by tc.updated_at desc limit 6`,
    db<{ testCases: number; openExecutions: number; executedToday: number; executedWeek: number; myToday: number }[]>`
      select (select count(*)::int from test_case where project_id = ${projectId} and archived_at is null) as test_cases,
        count(*) filter (where s.category in ${db(OPEN)} and c.state <> 'closed')::int as open_executions,
        count(*) filter (where e.executed_at >= date_trunc('day', now()))::int as executed_today,
        count(*) filter (where e.executed_at >= now() - interval '7 days')::int as executed_week,
        count(*) filter (where e.executed_at >= date_trunc('day', now()) and e.executed_by = ${me})::int as my_today
      from test_execution e join test_cycle c on c.id = e.cycle_id join execution_status s on s.code = e.status
      where c.project_id = ${projectId}`,
    // aktive Zyklen: nicht abgeschlossen, mit Ausführungen; zuletzt bearbeitete zuerst
    db<{ id: string; name: string; planId: string | null; planName: string | null; endDate: string | null; total: number; open: number; byStatus: Record<string, number> }[]>`
      select c.id, c.name, c.plan_id, p.name as plan_name, c.end_date, count(e.id)::int as total,
        count(e.id) filter (where s.category in ${db(OPEN)})::int as open,
        (select jsonb_object_agg(status, n) from (select e2.status, count(*)::int n from test_execution e2 where e2.cycle_id = c.id group by 1) t) as by_status
      from test_cycle c left join test_plan p on p.id = c.plan_id
      join test_execution e on e.cycle_id = c.id join execution_status s on s.code = e.status
      where c.project_id = ${projectId} and c.state <> 'closed' and c.archived_at is null
      group by c.id, p.name
      having count(e.id) filter (where s.category in ${db(OPEN)}) > 0 or max(e.executed_at) > now() - interval '14 days'
      order by max(coalesce(e.executed_at, e.updated_at)) desc nulls last limit 6`,
    db<{ id: string; cycleId: string; cycleName: string; key: string; title: string; status: string; executedAt: Date; executedBy: string | null }[]>`
      select e.id, e.cycle_id, c.name as cycle_name, tc.key, v.title, e.status, e.executed_at, e.executed_by
      from test_execution e join test_cycle c on c.id = e.cycle_id join test_case tc on tc.id = e.test_case_id
      join test_case_version v on v.id = e.test_case_version_id join execution_status s on s.code = e.status
      where c.project_id = ${projectId} and s.category in ${db(BAD)} and e.executed_at > now() - interval '30 days'
      order by e.executed_at desc limit 8`,
    db<{ key: string; title: string; versionNo: number; createdBy: string; createdAt: Date; changeNote: string | null }[]>`
      select tc.key, v.title, v.version_no, v.created_by, v.created_at, v.change_note
      from test_case_version v join test_case tc on tc.id = v.test_case_id
      where tc.project_id = ${projectId} and v.version_no = tc.current_version
      order by v.created_at desc limit 8`,
  ]);
  // Aufgaben der Testleitung: Vier-Augen-Freigaben, KI-Ergebnisse, Nachbesprechungen
  let lead = null;
  if (canEdit) {
    const [approvals, approvalCount, agent, debriefs] = await Promise.all([
      db<{ key: string; title: string; status: string; createdBy: string; createdAt: Date }[]>`
        select tc.key, v.title, tc.status, v.created_by, v.created_at
        from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
        join test_case_status s on s.code = tc.status
        where tc.project_id = ${projectId} and s.category = 'REVIEW' and v.created_by <> ${me} and tc.archived_at is null
        order by v.created_at limit 6`,
      db<{ n: number }[]>`
        select count(*)::int as n from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
        join test_case_status s on s.code = tc.status where tc.project_id = ${projectId} and s.category = 'REVIEW' and v.created_by <> ${me} and tc.archived_at is null`,
      db<{ n: number }[]>`
        select count(*)::int as n from test_execution e join test_cycle c on c.id = e.cycle_id
        where c.project_id = ${projectId} and e.review_state in ('pending', 'escalated')`,
      db<{ id: string; cycleId: string; charter: string; tester: string | null }[]>`
        select x.id, x.cycle_id, x.charter, x.tester from exploratory_session x join test_cycle c on c.id = x.cycle_id
        where c.project_id = ${projectId} and x.status = 'done' order by x.updated_at desc limit 6`,
    ]);
    lead = { approvals: { count: approvalCount[0]?.n ?? 0, items: approvals }, agentReviews: agent[0]?.n ?? 0, debriefs };
  }
  return {
    me,
    tasks: { executions: { count: openCount[0]?.n ?? 0, cycles: openCount[0]?.cycles ?? 0, items: executions }, sessions, drafts },
    lead,
    kpis: kpis[0] ?? { testCases: 0, openExecutions: 0, executedToday: 0, executedWeek: 0, myToday: 0 },
    cycles: cycles.map((c) => ({ ...c, byStatus: c.byStatus ?? {} })),
    failures,
    changes,
  };
}

const PrefName = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);

export function startRoutes(app: Hono, db: Db): void {
  const tag = 'Startseite';
  route(app, {
    method: 'get', path: '/api/projects/:key/start', tag, summary: 'Startseite: meine Aufgaben, aktive Zyklen, Fehlschläge, Änderungen',
    access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
  }, async ({ params, c }) => {
    const p = await getProject(db, params.key!);
    const me = principalOf(c)!;
    return startPage(db, p.id, me.username, can(me, p.id, 'edit'));
  });
  route(app, { method: 'get', path: '/api/me/preferences/:name', tag, summary: 'Persönliche Einstellung lesen (null = Standard)' }, async ({ params, c }) => {
    const name = PrefName.parse(params.name);
    const [r] = await db<{ value: unknown }[]>`select value from user_preference where username = ${principalOf(c)!.username} and name = ${name}`;
    return { value: r?.value ?? null };
  });
  route(app, {
    method: 'put', path: '/api/me/preferences/:name', tag, summary: 'Persönliche Einstellung speichern (null = zurück zum Standard)', status: 204,
    body: z.object({ value: z.unknown().nullable() }),
  }, async ({ params, body, c }) => {
    const name = PrefName.parse(params.name);
    const user = principalOf(c)!.username;
    if (body.value === null || body.value === undefined) {
      await db`delete from user_preference where username = ${user} and name = ${name}`;
      return;
    }
    if (JSON.stringify(body.value).length > 20_000) throw new HttpError(400, 'Einstellung zu groß');
    await db`insert into user_preference(username, name, value) values (${user}, ${name}, ${db.json(body.value as never)})
      on conflict (username, name) do update set value = excluded.value, updated_at = now()`;
  });
}
