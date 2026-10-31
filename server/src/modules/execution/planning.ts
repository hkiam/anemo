/**
 * Planungshilfen (Roadmap F): Zyklus wiederholen (neuer Build, Nachtest, je Konfiguration) und Zyklusvergleich.
 */
import type { Db } from '../../platform/db.ts';
import { badRequest } from '../../platform/http.ts';
import type { Configuration } from './configuration.ts';
import { EventTypes, recordEvent } from '../events/index.ts';
import { getTestCase } from '../testcases/index.ts';
import { addTestsToCycle, createCycle, getCycle, getExecution, upsertExecution } from './service.ts';

export interface RepeatInput {
  name: string;
  build?: string | null | undefined;
  release?: string | null | undefined;
  /** nur Tests, die im Ausgangszyklus fehlgeschlagen, blockiert oder offen sind (Nachtest) */
  onlyProblems?: boolean | undefined;
  /** je Eintrag ein eigener Zyklus mit dieser Konfiguration (z. B. Oracle / SQL Server) */
  configurations?: Configuration[] | undefined;
  keepAssignees?: boolean | undefined;
}

export async function repeatCycle(db: Db, sourceId: string, input: RepeatInput, actor: string) {
  const src = await getCycle(db, sourceId);
  // je Testfall das jüngste Ergebnis des Ausgangszyklus (wiederholte Ad-hoc-Ausführungen zusammengefasst)
  const tests = await db<{ testCaseId: string; category: string; assignee: string | null }[]>`
    select distinct on (e.test_case_id) e.test_case_id, s.category, e.assignee, e.order_no
    from test_execution e join execution_status s on s.code = e.status
    where e.cycle_id = ${sourceId}
    order by e.test_case_id, e.executed_at desc nulls last`;
  const order = await db<{ testCaseId: string }[]>`
    select test_case_id from test_execution where cycle_id = ${sourceId} group by test_case_id order by min(order_no)`;
  const byId = new Map(tests.map((t) => [t.testCaseId, t]));
  const chosen = order.map((o) => byId.get(o.testCaseId)!)
    .filter((t) => !input.onlyProblems || ['FAILED', 'BLOCKED', 'OPEN', 'IN_PROGRESS'].includes(t.category));
  if (!chosen.length) throw badRequest(input.onlyProblems ? 'Keine fehlgeschlagenen, blockierten oder offenen Tests im Ausgangszyklus' : 'Der Ausgangszyklus enthält keine Tests');
  const variants: (Configuration | null)[] = input.configurations?.length ? input.configurations : [null];
  const created = [];
  for (const cfg of variants) {
    const suffix = cfg ? ` – ${Object.values(cfg).flat().join(', ')}` : '';
    const cycle = await createCycle(db, src.projectId, {
      name: `${input.name}${variants.length > 1 ? suffix : ''}`, planId: src.planId, description: src.description,
      release: input.release === undefined ? src.release : input.release, build: input.build === undefined ? src.build : input.build,
      environment: src.environment, configuration: cfg ?? ((src as { configuration?: Configuration }).configuration ?? null),
      customFields: { repeatedFrom: sourceId, onlyProblems: !!input.onlyProblems },
    } as never, actor);
    const r = await addTestsToCycle(db, cycle.id, chosen.map((t) => t.testCaseId), actor);
    if (input.keepAssignees !== false) {
      for (const t of chosen.filter((x) => x.assignee)) {
        await db`update test_execution set assignee = ${t.assignee} where cycle_id = ${cycle.id} and test_case_id = ${t.testCaseId}`;
      }
    }
    created.push({ id: cycle.id, name: cycle.name, added: r.added });
  }
  return { cycles: created };
}

export type Change = 'regression' | 'fixed' | 'stillFailing' | 'same' | 'onlyA' | 'onlyB' | 'other';

/** Zwei Zyklen vergleichen (je Testfall jüngstes Ergebnis). */
export async function compareCycles(db: Db, a: string, b: string) {
  const [ca, cb] = [await getCycle(db, a), await getCycle(db, b)];
  if (ca.projectId !== cb.projectId) throw badRequest('Zyklen aus verschiedenen Projekten');
  const rows = await db<{ cycleId: string; testCaseId: string; key: string; title: string; status: string; category: string; executionId: string; versionNo: number }[]>`
    select distinct on (e.cycle_id, e.test_case_id) e.cycle_id, e.test_case_id, tc.key, v.title, e.status, s.category, e.id as execution_id, v.version_no
    from test_execution e join test_case tc on tc.id = e.test_case_id join test_case_version v on v.id = e.test_case_version_id
    join execution_status s on s.code = e.status
    where e.cycle_id in (${a}, ${b})
    order by e.cycle_id, e.test_case_id, e.executed_at desc nulls last`;
  const map = new Map<string, { key: string; title: string; a: (typeof rows)[number] | null; b: (typeof rows)[number] | null }>();
  for (const r of rows) {
    const x = map.get(r.testCaseId) ?? map.set(r.testCaseId, { key: r.key, title: r.title, a: null, b: null }).get(r.testCaseId)!;
    if (r.cycleId === a) x.a = r; else x.b = r;
  }
  const bad = (c?: string) => c === 'FAILED' || c === 'BLOCKED';
  const items = [...map.values()].map((x) => {
    let change: Change;
    if (!x.a) change = 'onlyB';
    else if (!x.b) change = 'onlyA';
    else if (x.a.category === 'PASSED' && bad(x.b.category)) change = 'regression';
    else if (bad(x.a.category) && x.b.category === 'PASSED') change = 'fixed';
    else if (bad(x.a.category) && bad(x.b.category)) change = 'stillFailing';
    else if (x.a.status === x.b.status) change = 'same';
    else change = 'other';
    const side = (s: (typeof rows)[number] | null) => (s ? { status: s.status, executionId: s.executionId, version: s.versionNo } : null);
    return { key: x.key, title: x.title, a: side(x.a), b: side(x.b), change };
  }).sort((p, q) => p.key.localeCompare(q.key, 'de', { numeric: true }));
  const counts = items.reduce<Record<string, number>>((acc, i) => ((acc[i.change] = (acc[i.change] ?? 0) + 1), acc), {});
  return { a: { id: ca.id, name: ca.name, build: ca.build }, b: { id: cb.id, name: cb.name, build: cb.build }, counts, items };
}

/**
 * Nachtest nach behobenem Fehler (B2): offene Ausführung desselben Testfalls (aktuelle Version), zugewiesen an die
 * Person, die den Fehler festgestellt hat. Ziel ist der jüngste nicht abgeschlossene Zyklus des Testplans mit
 * gleicher Konfiguration (sonst der ursprüngliche, falls nicht abgeschlossen) – nie eine andere Konfiguration: ein
 * Oracle-Fehler wird nicht unter SQL Server „nachgetestet“. Gibt es kein Ziel, wird das als RetestMissing
 * protokolliert (Cockpit und Bericht führen den Fall unter „behoben, aber nicht nachgetestet“).
 * Nur einmal je Testfall × Fehler; entfällt, wenn der Testfall nach dem Fehlschlag bereits wieder bestanden hat
 * oder im Ziel ohnehin eine offene Ausführung wartet.
 */
export async function createRetest(db: Db, executionId: string, defect: { provider: string; key: string; title: string | null; status: string | null }, actor: string) {
  const e = await getExecution(db, executionId);
  const marker = `${defect.provider}:${defect.key}`;
  const origin = await getCycle(db, e.cycleId);
  const [already] = await db`select 1 from test_execution x join test_cycle c on c.id = x.cycle_id
    where x.test_case_id = ${e.testCaseId} and x.custom_fields->>'retestDefect' = ${marker}
      and (c.plan_id = ${origin.planId} or (${origin.planId}::uuid is null and c.id = ${origin.id}))`;
  if (already) return null;
  const [passedSince] = await db`select 1 from test_execution x join test_cycle c on c.id = x.cycle_id join execution_status s on s.code = x.status
    where x.test_case_id = ${e.testCaseId} and x.id <> ${executionId} and s.category in ('PASSED', 'PASSED_WITH_ISSUES')
      and x.executed_at > coalesce(${e.executedAt}, '-infinity'::timestamptz)
      and (c.plan_id = ${origin.planId} or (${origin.planId}::uuid is null and c.id = ${origin.id}))`;
  if (passedSince) return null;
  const candidates = origin.planId ? await db<{ id: string; sameCfg: boolean }[]>`
    select id, configuration = ${db.json(((origin as { configuration?: unknown }).configuration ?? {}) as never)} as same_cfg from test_cycle
    where plan_id = ${origin.planId} and state <> 'closed' and archived_at is null
      and configuration = ${db.json(((origin as { configuration?: unknown }).configuration ?? {}) as never)}
    order by coalesce(start_date, created_at::date) desc, created_at desc limit 1` : [];
  const targetId = candidates[0]?.id ?? ((origin as { state?: string }).state !== 'closed' ? origin.id : null);
  if (!targetId) {
    const [noted] = await db`select 1 from domain_event where type = 'RetestMissing' and aggregate_id = ${executionId} and payload->>'defect' = ${marker}`;
    if (!noted) {
      await recordEvent(db, { type: EventTypes.RetestMissing, aggregateType: 'TestExecution', aggregateId: executionId, actor,
        payload: { key: e.testCase.key, defect: marker, defectTitle: defect.title, reason: 'Kein offener Zyklus mit gleicher Konfiguration im Testplan' } });
    }
    return null;
  }
  const [waiting] = await db`select 1 from test_execution x join execution_status s on s.code = x.status
    where x.cycle_id = ${targetId} and x.test_case_id = ${e.testCaseId} and s.category in ('OPEN', 'IN_PROGRESS')`;
  if (waiting) return null;
  const tc = await getTestCase(db, e.testCaseId);
  const [o] = await db<{ n: number }[]>`select coalesce(max(order_no), 0) + 1 as n from test_execution where cycle_id = ${targetId}`;
  const id = await upsertExecution(db, {
    cycleId: targetId, testCaseId: e.testCaseId, testCaseVersionId: tc.version.id, orderNo: o!.n, status: 'NOT_EXECUTED',
    assignee: e.executedBy ?? e.assignee,
    comment: `Nachtest: Fehler ${defect.key}${defect.title ? ` („${defect.title}“)` : ''} ist ${defect.status ?? 'erledigt'}.`,
    customFields: { retestFor: executionId, retestDefect: marker },
  });
  await recordEvent(db, {
    type: EventTypes.RetestCreated, aggregateType: 'TestExecution', aggregateId: id, actor,
    payload: { key: e.testCase.key, testCaseId: e.testCaseId, cycleId: targetId, retestFor: executionId, defect: marker, defectTitle: defect.title, assignee: e.executedBy ?? e.assignee },
  });
  return id;
}

/**
 * Verteilung nach Auslastung (F): offene Ausführungen eines Zyklus auf Tester verteilen. Ausgangslast ist die Zahl
 * offener Ausführungen (bzw. Schritte) je Person im ganzen Projekt; vergeben wird jeweils an die am wenigsten
 * ausgelastete Person – größere Tests zuerst, damit die Verteilung ausgeglichen bleibt.
 */
export async function distribute(db: Db, cycleId: string, opts: { assignees: string[]; onlyUnassigned: boolean; weight: 'count' | 'steps' | 'duration' }, actor: string) {
  const cycle = await getCycle(db, cycleId);
  const people = [...new Set(opts.assignees.map((a) => a.trim()).filter(Boolean))];
  if (!people.length) throw badRequest('Mindestens eine Person angeben');
  // Gewicht: Anzahl, Schritte oder Erfahrungswert (mittlere gemessene Dauer des Testfalls; sonst 2 min je Schritt)
  const weightSql = opts.weight === 'steps' ? db`greatest(1, jsonb_array_length(v.steps))`
    // Schätzung des Testfalls, sonst Erfahrungswert (Median der gemessenen Dauer), sonst Schritte × Durchläufe × 2 min
    : opts.weight === 'duration' ? db`coalesce((select t.estimate_minutes * 60 from test_case t where t.id = e.test_case_id),
        (select percentile_cont(0.5) within group (order by x.duration_seconds) from test_execution x where x.test_case_id = e.test_case_id and x.duration_seconds > 0),
        greatest(1, jsonb_array_length(v.steps)) * greatest(1, coalesce(jsonb_array_length(v.dataset->'rows'), 1)) * 120)`
    : db`1`;
  const load = new Map(people.map((p) => [p, 0]));
  const current = await db<{ assignee: string; w: number }[]>`
    select e.assignee, sum(${weightSql})::int as w
    from test_execution e join test_cycle c on c.id = e.cycle_id join test_case_version v on v.id = e.test_case_version_id
    join execution_status s on s.code = e.status
    where c.project_id = ${cycle.projectId} and e.assignee = any(${people}) and s.category in ('OPEN', 'IN_PROGRESS')
      ${opts.onlyUnassigned ? db`` : db`and e.cycle_id <> ${cycleId}`}
    group by e.assignee`;
  for (const c of current) load.set(c.assignee, c.w);
  const open = await db<{ id: string; w: number }[]>`
    select e.id, ${weightSql}::int as w from test_execution e join test_case_version v on v.id = e.test_case_version_id
    join execution_status s on s.code = e.status
    where e.cycle_id = ${cycleId} and s.category in ('OPEN', 'IN_PROGRESS') ${opts.onlyUnassigned ? db`and e.assignee is null` : db``}
    order by w desc, e.order_no`;
  const plan = new Map<string, string[]>(people.map((p) => [p, []]));
  for (const e of open) {
    const [who] = [...load.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]!;
    plan.get(who)!.push(e.id);
    load.set(who, load.get(who)! + e.w);
  }
  for (const [who, ids] of plan) {
    if (!ids.length) continue;
    await db`update test_execution set assignee = ${who}, updated_at = now() where id = any(${ids}::uuid[])`;
    for (const id of ids) await recordEvent(db, { type: EventTypes.ExecutionAssigned, aggregateType: 'TestExecution', aggregateId: id, actor, payload: { assignee: who } });
  }
  return { assigned: Object.fromEntries([...plan].map(([k, v]) => [k, v.length])), loadAfter: Object.fromEntries(load) };
}
