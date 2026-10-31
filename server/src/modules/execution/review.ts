/**
 * Agentische Ausführung mit QA-Freigabe (Roadmap D3, ADR-0024): Agenten holen sich Arbeit, erfassen Ergebnisse
 * (Status „Freigabe ausstehend“) oder eskalieren Unklares; Menschen geben frei oder lehnen ab.
 */
import type { Db } from '../../platform/db.ts';
import { badRequest, HttpError, notFound } from '../../platform/http.ts';
import { EventTypes, recordEvent } from '../events/index.ts';

async function userFlags(db: Db, username: string) {
  const [u] = await db<{ isAgent: boolean }[]>`select is_agent from app_user where username = ${username}`;
  return { isAgent: !!u?.isAgent };
}

/** Offene Agentenergebnisse und Eskalationen eines Projekts */
export async function reviewQueue(db: Db, projectId: string) {
  return db<{ id: string; cycleId: string; cycleName: string; key: string; title: string; status: string; executedBy: string | null; executedAt: Date | null;
    reviewState: string; comment: string | null; evidence: number }[]>`
    select e.id, c.id as cycle_id, c.name as cycle_name, tc.key, v.title, e.status, e.executed_by, e.executed_at, e.review_state, e.comment,
      (select count(*)::int from attachment a where a.owner_type = 'TEST_EXECUTION' and a.owner_id = e.id) as evidence
    from test_execution e join test_cycle c on c.id = e.cycle_id join test_case tc on tc.id = e.test_case_id
    join test_case_version v on v.id = e.test_case_version_id
    where c.project_id = ${projectId} and e.review_state in ('pending', 'escalated')
    order by e.review_state desc, e.executed_at nulls last limit 500`;
}

export async function reviewResult(db: Db, id: string, input: { decision: 'approve' | 'reject'; note?: string | null | undefined; reassignTo?: string | null | undefined }, actor: string) {
  const [e] = await db<{ reviewState: string | null; executedBy: string | null; comment: string | null }[]>`select review_state, executed_by, comment from test_execution where id = ${id}`;
  if (!e) throw notFound('Ausführung', id);
  if (e.reviewState !== 'pending') throw badRequest('Für diese Ausführung steht keine Freigabe aus');
  if ((await userFlags(db, actor)).isAgent) throw new HttpError(403, 'Agenten können keine Ergebnisse freigeben');
  if (e.executedBy === actor) throw new HttpError(403, 'Eigene Ergebnisse können nicht selbst freigegeben werden');
  if (input.decision === 'approve') {
    await db`update test_execution set review_state = 'approved', reviewed_by = ${actor}, reviewed_at = now(), review_note = ${input.note ?? null} where id = ${id}`;
  } else {
    // Abgelehnt: Ergebnis zurücksetzen, Begründung im Kommentar, Test geht an eine Person
    const note = `Agentenergebnis (${e.executedBy}) abgelehnt von ${actor}${input.note ? `: ${input.note}` : ''}`;
    await db`update test_execution set status = 'NOT_EXECUTED', executed_by = null, executed_at = null, review_state = 'rejected',
      reviewed_by = ${actor}, reviewed_at = now(), review_note = ${input.note ?? null}, assignee = ${input.reassignTo ?? null},
      comment = ${[e.comment, `_${note}_`].filter(Boolean).join('\n\n')}, updated_at = now() where id = ${id}`;
  }
  await recordEvent(db, { type: EventTypes.ResultReviewed, aggregateType: 'TestExecution', aggregateId: id, actor, payload: { decision: input.decision, agent: e.executedBy, note: input.note ?? null } });
  return { id, decision: input.decision };
}

/** Agent übergibt an Menschen: unklarer Fall, fehlende Voraussetzung, Ergebnis nicht sicher beurteilbar. */
export async function escalate(db: Db, id: string, reason: string, actor: string) {
  const [e] = await db<{ comment: string | null }[]>`select comment from test_execution where id = ${id}`;
  if (!e) throw notFound('Ausführung', id);
  await db`update test_execution set review_state = 'escalated', assignee = null, reviewed_by = null, reviewed_at = null,
    review_note = ${reason}, comment = ${[e.comment, `_Eskaliert durch ${actor}: ${reason}_`].filter(Boolean).join('\n\n')}, updated_at = now() where id = ${id}`;
  await recordEvent(db, { type: EventTypes.ResultReviewed, aggregateType: 'TestExecution', aggregateId: id, actor, payload: { decision: 'escalate', note: reason } });
  return { id, escalated: true };
}

/** Nächste offene, nicht zugewiesene Ausführungen eines Zyklus übernehmen (atomar, ohne Doppelvergabe). */
export async function claimNext(db: Db, cycleId: string, count: number, actor: string) {
  // Nur die Ausführungen sperren (OF e): ohne OF sperrt FOR UPDATE auch die Statuszeile, und eine gleichzeitige
  // Übernahme überspringt dann alle Ausführungen mit diesem Status. Die Auswahl als CTE wird genau einmal ausgewertet
  // (in „id in (…)“ kann der Planer sie mehrfach auswerten und mehr als count vergeben).
  const rows = await db<{ id: string }[]>`
    with picked as (
      select e.id from test_execution e join execution_status s on s.code = e.status
      where e.cycle_id = ${cycleId} and e.assignee is null and s.category in ('OPEN', 'IN_PROGRESS') and coalesce(e.review_state, '') <> 'escalated'
      order by e.order_no limit ${count} for update of e skip locked)
    update test_execution t set assignee = ${actor}, updated_at = now() from picked where t.id = picked.id
    returning t.id`;
  for (const r of rows) await recordEvent(db, { type: EventTypes.ExecutionAssigned, aggregateType: 'TestExecution', aggregateId: r.id, actor, payload: { assignee: actor } });
  return rows.map((r) => r.id);
}
