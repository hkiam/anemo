/**
 * Testfall-Workflow (ADR-0013): Status mit Kategorie und erlaubte Übergänge. Hat ein Status keine ausgehenden
 * Übergänge, ist der Wechsel frei – so bleiben migrierte Jira-Status nutzbar, bis ein Workflow festgelegt ist.
 */
import type { Db } from '../../platform/db.ts';
import { badRequest } from '../../platform/http.ts';

export type TestCaseStatusCategory = 'DRAFT' | 'REVIEW' | 'APPROVED' | 'DEPRECATED';
export interface TestCaseStatus {
  code: string; name: string; category: TestCaseStatusCategory; color: string; sortOrder: number;
  active: boolean; isInitial: boolean; description: string | null; inUse?: number;
}
export interface Transition { from: string; to: string }

export async function listWorkflow(db: Db): Promise<{ statuses: TestCaseStatus[]; transitions: Transition[] }> {
  const statuses = await db<TestCaseStatus[]>`
    select s.*, (select count(*)::int from test_case t where t.status = s.code) as in_use
    from test_case_status s order by s.sort_order, s.code`;
  const transitions = await db<Transition[]>`select from_code as from, to_code as to from test_case_transition order by 1, 2`;
  return { statuses, transitions };
}

/** Unbekannten Status (z. B. aus einem neuen Import) in den Katalog aufnehmen, damit er pflegbar ist. */
export async function registerStatus(db: Db, code: string): Promise<void> {
  await db`insert into test_case_status(code, name, category, sort_order) values (${code}, ${code}, 'DRAFT', 200) on conflict do nothing`;
}

export async function initialStatus(db: Db): Promise<string> {
  const [s] = await db<{ code: string }[]>`select code from test_case_status where is_initial and active`;
  return s?.code ?? 'DRAFT';
}

/** Prüft einen Statuswechsel durch einen Benutzer (Import und Systemvorgänge prüfen nicht). */
export async function checkTransition(db: Db, from: string | null, to: string): Promise<void> {
  if (from === to) return;
  const [target] = await db<{ active: boolean }[]>`select active from test_case_status where code = ${to}`;
  if (!target) throw badRequest(`Unbekannter Testfall-Status „${to}“`);
  if (!target.active) throw badRequest(`Der Status „${to}“ ist deaktiviert`);
  if (from === null) return;
  const allowed = await db<{ to: string; name: string }[]>`
    select t.to_code as to, s.name from test_case_transition t join test_case_status s on s.code = t.to_code
    where t.from_code = ${from} and s.active`;
  const [hasRules] = await db`select 1 from test_case_transition where from_code = ${from} limit 1`;
  if (hasRules && !allowed.some((a) => a.to === to)) {
    throw badRequest(`Wechsel von „${from}“ nach „${to}“ ist im Workflow nicht vorgesehen. Erlaubt: ${allowed.map((a) => a.name).join(', ') || 'keiner'}`);
  }
}

export async function upsertStatus(db: Db, code: string, s: Omit<TestCaseStatus, 'code' | 'inUse'>): Promise<void> {
  if (s.isInitial) await db`update test_case_status set is_initial = false where is_initial and code <> ${code}`;
  await db`
    insert into test_case_status(code, name, category, color, sort_order, active, is_initial, description)
    values (${code}, ${s.name}, ${s.category}, ${s.color}, ${s.sortOrder}, ${s.active}, ${s.isInitial}, ${s.description})
    on conflict (code) do update set name = excluded.name, category = excluded.category, color = excluded.color,
      sort_order = excluded.sort_order, active = excluded.active, is_initial = excluded.is_initial, description = excluded.description`;
}

export async function setTransitions(db: Db, transitions: Transition[]): Promise<void> {
  await db`delete from test_case_transition`;
  for (const t of transitions) {
    if (t.from === t.to) continue;
    await db`insert into test_case_transition(from_code, to_code) values (${t.from}, ${t.to}) on conflict do nothing`;
  }
}
