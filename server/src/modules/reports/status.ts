/**
 * Teststatusbericht (Zwischenbericht, „Test Status Report“ nach ISO/IEC/IEEE 29119-3) und Burn-down gegen das geplante
 * Ende: Fortschritt im Berichtszeitraum, Prognose, neue Fehler und Fehlschläge, Ausstiegskriterien, Risiken und das
 * Lagebild des Testmanagements (Hindernisse, nächste Schritte).
 */
import type { Db } from '../../platform/db.ts';
import { getPlan } from '../execution/index.ts';
import { defectResolution } from '../references/index.ts';
import { completionReport, type CompletionReport, type DefectRef } from './data.ts';
import { addDays, addWorkdays, berlinDay, dayNo, PLAUSIBLE, workdayWindowStart, workdays, workdaysLate } from './time.ts';

/** remaining null = Tag liegt in der Zukunft */
export interface BurnPoint { day: string; remaining: number | null; total: number; ideal: number | null }
export interface Burndown {
  start: string | null; end: string | null; points: BurnPoint[];
  /** erledigte Ausführungen je Arbeitstag: Mittel der letzten 10 Arbeitstage bis zum Stichtag (bzw. seit Beginn) */
  velocity: number; remaining: number; forecast: string | null; onTrack: boolean | null; daysLate: number | null;
  /** Stichtag (heute bzw. Ende des Berichtszeitraums) */
  asOf: string;
}

/** Fenster für das Tempo in Arbeitstagen */
export const VELOCITY_WINDOW = 10;
/** höchstens so viele Tage im Diagramm (die jüngsten bis zum geplanten Ende bzw. Stichtag) */
const MAX_POINTS = 400;

/**
 * Burn-down zum Stichtag `now` (Fach-Review Teil 3, Befunde 11/12; Sicherheitsreview Teil 2, Befund 8):
 * - Umfang: bis zum Stichtag angelegte Ausführungen nicht archivierter Zyklen (archivierte Zyklen gehören nicht zur
 *   Testbasis – gleiche Regel wie Abschlussbericht, Rückverfolgbarkeit und Cockpit).
 * - Erledigt am Tag d: Der letzte Stand bis Ende d (Europe/Berlin) ist abschließend. Wird eine Ausführung wieder auf
 *   offen/in Arbeit gesetzt, zählt sie ab diesem Tag wieder als offen. Ohne Ergebnisverlauf (übernommene Daten) gilt
 *   der aktuelle Status ab Ausführungsdatum.
 * - Ideallinie vom Start (frühester Zyklusbeginn bzw. erste Einplanung) bis zum geplanten Ende (spätestes Zyklusende);
 *   unplausible Zyklusdaten (außerhalb 2000–2100) werden ignoriert. Arbeitstage werden rechnerisch bestimmt.
 * - Tempo: netto erledigte Ausführungen in den letzten 10 Arbeitstagen bis zum Stichtag ÷ 10 (bei jüngerem Beginn ÷
 *   Arbeitstage seit Beginn); die Prognose schreitet in Arbeitstagen voran.
 */
/** Aktueller Zeitpunkt nach der Datenbankuhr. */
const dbNow = async (db: Db) => (await db<{ now: Date }[]>`select clock_timestamp() as now`)[0]!.now;

export async function burndown(db: Db, planId: string, now?: Date): Promise<Burndown> {
  // ohne Stichtag: „jetzt“ nach der Datenbankuhr (Zeitstempel der Ausführungen stammen von dort)
  const asOf = now ?? await dbNow(db);
  const rows = await db<{ id: string; created: Date; category: string; at: Date | null }[]>`
    select e.id, e.created_at as created, s.category, coalesce(e.executed_at, e.updated_at) as at
    from test_execution e join test_cycle c on c.id = e.cycle_id join execution_status s on s.code = e.status
    where c.plan_id = ${planId} and c.archived_at is null and e.created_at <= ${asOf}`;
  const results = rows.length ? await db<{ executionId: string; recordedAt: Date; done: boolean }[]>`
    select r.execution_id, r.recorded_at, s.category not in ('OPEN', 'IN_PROGRESS') as done
    from execution_result r join execution_status s on s.code = r.status
    join test_execution e on e.id = r.execution_id join test_cycle c on c.id = e.cycle_id
    where c.plan_id = ${planId} and c.archived_at is null and r.recorded_at <= ${asOf}
    order by r.execution_id, r.recorded_at, r.id` : [];
  const [span] = await db<{ start: string | null; end: string | null }[]>`
    select to_char(min(start_date) filter (where start_date between ${PLAUSIBLE.from}::date and ${PLAUSIBLE.to}::date), 'YYYY-MM-DD') as start,
           to_char(max(end_date) filter (where end_date between ${PLAUSIBLE.from}::date and ${PLAUSIBLE.to}::date), 'YYYY-MM-DD') as end
    from test_cycle where plan_id = ${planId} and archived_at is null`;
  const today = berlinDay(asOf);
  let firstCreated = Infinity;
  for (const r of rows) firstCreated = Math.min(firstCreated, new Date(r.created).getTime());
  const firstPlanned = rows.length ? berlinDay(new Date(firstCreated)) : null;
  const start = span?.start ?? firstPlanned;
  const end = span?.end ?? null;
  const empty: Burndown = { start, end, points: [], velocity: 0, remaining: 0, forecast: null, onTrack: null, daysLate: null, asOf: today };
  if (!start || !rows.length) return empty;

  // Zustandswechsel je Ausführung: +1 = wird erledigt, −1 = wieder offen (letzter Stand je Tag zählt)
  const changes = new Map<string, number>(); // tatsächlicher Tag → Saldo
  const add = (d: string, k: number) => changes.set(d, (changes.get(d) ?? 0) + k);
  const byExec = new Map<string, { day: string; done: boolean }[]>();
  for (const r of results) {
    const list = byExec.get(r.executionId) ?? byExec.set(r.executionId, []).get(r.executionId)!;
    const d = berlinDay(new Date(r.recordedAt));
    if (list.length && list.at(-1)!.day === d) list.at(-1)!.done = r.done; else list.push({ day: d, done: r.done });
  }
  let remaining = 0;
  for (const r of rows) {
    const hist = byExec.get(r.id);
    let state = false;
    if (hist) {
      for (const h of hist) if (h.done !== state) { add(h.day, h.done ? 1 : -1); state = h.done; }
    } else if (!['OPEN', 'IN_PROGRESS'].includes(r.category) && r.at && new Date(r.at) <= asOf) {
      add(berlinDay(new Date(r.at)), 1);
      state = true;
    }
    if (!state) remaining++;
  }
  const createdBy = new Map<string, number>();
  for (const r of rows) { const c = berlinDay(new Date(r.created)); createdBy.set(c, (createdBy.get(c) ?? 0) + 1); }
  const clamp = (d: string) => (d < start ? start : d);

  // Diagramm: höchstens MAX_POINTS Tage, die jüngsten bis zum geplanten Ende bzw. Stichtag
  const lastDay = end && end > today ? end : today;
  const firstDay = dayNo(lastDay) - dayNo(start) >= MAX_POINTS ? addDays(lastDay, -(MAX_POINTS - 1)) : start;
  let total = 0, done = 0;
  // Stand vor dem Diagrammfenster aufsummieren
  for (const [d, k] of createdBy) if (clamp(d) < firstDay) total += k;
  for (const [d, k] of changes) if (clamp(d) < firstDay) done += k;
  const createdIn = new Map<string, number>(), doneIn = new Map<string, number>();
  for (const [d, k] of createdBy) if (clamp(d) >= firstDay) createdIn.set(clamp(d), (createdIn.get(clamp(d)) ?? 0) + k);
  for (const [d, k] of changes) if (clamp(d) >= firstDay) doneIn.set(clamp(d), (doneIn.get(clamp(d)) ?? 0) + k);
  const totalAll = rows.length;
  const span_ = end ? Math.max(1, workdays(start, end)) : null;
  const points: BurnPoint[] = [];
  for (let d = firstDay; d <= lastDay; d = addDays(d, 1)) {
    total += createdIn.get(d) ?? 0;
    done += doneIn.get(d) ?? 0;
    const ideal = end && span_ ? Math.max(0, Math.round((totalAll * (1 - workdays(start, d) / span_)) * 10) / 10) : null;
    points.push({ day: d, remaining: d <= today ? total - done : null, total, ideal: d <= (end ?? d) ? ideal : 0 });
  }

  // Tempo: netto erledigt in den letzten 10 Arbeitstagen (inkl. Stichtag) ÷ Arbeitstage im Fenster
  const windowStart = workdayWindowStart(today, VELOCITY_WINDOW);
  const firstActivity = [start, ...changes.keys()].sort()[0]!;
  const from = windowStart > firstActivity ? windowStart : firstActivity;
  const divisor = Math.max(1, Math.min(VELOCITY_WINDOW, workdays(from, addDays(today, 1))));
  let net = 0;
  for (const [d, k] of changes) if (d >= from && d <= today) net += k;
  const velocity = Math.max(0, Math.round((net / divisor) * 10) / 10);
  let forecast: string | null = null;
  if (remaining === 0) forecast = today;
  else if (velocity > 0) {
    const needed = Math.ceil(remaining / velocity);
    // mehr als 50 Jahre: keine sinnvolle Prognose
    forecast = needed <= 50 * 261 ? addWorkdays(today, needed) : null;
  }
  const onTrack = forecast && end ? forecast <= end : null;
  const daysLate = forecast && end && forecast > end ? workdaysLate(end, forecast) : null;
  return { start, end, points, velocity, remaining, forecast, onTrack, daysLate, asOf: today };
}

export interface StatusReport extends Omit<CompletionReport, 'kind'> {
  kind: 'status';
  period: { from: Date; to: Date };
  burndown: Burndown;
  inPeriod: { executed: number; passed: number; failed: number; byTester: { tester: string; executed: number }[]; newDefects: (DefectRef & { resolution: string })[]; newFailures: { key: string; title: string; cycleName: string; status: string }[] };
  statusNote: { text: string; by: string | null; at: Date | null } | null;
}

/**
 * Teststatusbericht für den Zeitraum `from`–`to` (Standard: letzte 7 Tage). Kennzahlen im Zeitraum zählen
 * Ausführungen (letzter Stand im Zeitraum), nicht Speichervorgänge.
 */
export async function statusReport(db: Db, planId: string, actor: string, opts: { from?: Date | undefined; to?: Date | undefined; steps: boolean }): Promise<StatusReport> {
  // „jetzt“ nach der Datenbankuhr: Ergebnisse tragen deren Zeitstempel (weicht die Uhr der Anwendung ab, fielen frisch
  // erfasste Ergebnisse sonst aus dem Zeitraum)
  const to = opts.to ?? await dbNow(db);
  const from = opts.from ?? new Date(to.getTime() - 7 * 864e5);
  const c = await completionReport(db, planId, actor, { steps: opts.steps });
  const plan = await getPlan(db, planId) as Awaited<ReturnType<typeof getPlan>> & { statusNote?: string | null; statusNoteBy?: string | null; statusNoteAt?: Date | null };
  const cat = new Map(c.statuses.map((s) => [s.code, s.category]));
  const catOf = (code: string | null | undefined) => cat.get(code ?? '') ?? 'OPEN';
  const isDone = (code: string) => !['OPEN', 'IN_PROGRESS'].includes(catOf(code));
  const isProblem = (code: string | null | undefined) => ['FAILED', 'BLOCKED'].includes(catOf(code));
  // Je Ausführung zählt der letzte Stand im Zeitraum, nicht jeder Speichervorgang (Fach-Review Teil 3, Befund 8).
  // Archivierte Zyklen gehören nicht zur Testbasis (wie im Abschlussbericht).
  const res = await db<{ executionId: string; status: string; recordedBy: string; key: string; title: string; cycleName: string }[]>`
    select distinct on (r.execution_id) r.execution_id, r.status, r.recorded_by, tc.key, v.title, cy.name as cycle_name
    from execution_result r join test_execution e on e.id = r.execution_id join test_cycle cy on cy.id = e.cycle_id
    join test_case tc on tc.id = e.test_case_id join test_case_version v on v.id = e.test_case_version_id
    where cy.plan_id = ${planId} and cy.archived_at is null and r.recorded_at between ${from} and ${to}
    order by r.execution_id, r.recorded_at desc, r.id desc`;
  const done = res.filter((r) => isDone(r.status));
  const byTester = new Map<string, number>();
  for (const r of done) byTester.set(r.recordedBy, (byTester.get(r.recordedBy) ?? 0) + 1);
  // Neue Fehlschläge: Stand am Ende des Zeitraums fehlgeschlagen/blockiert, vor dem Zeitraum nicht
  const failedNow = done.filter((r) => isProblem(r.status));
  const before = failedNow.length ? await db<{ executionId: string; status: string }[]>`
    select distinct on (execution_id) execution_id, status from execution_result
    where execution_id = any(${failedNow.map((r) => r.executionId)}::uuid[]) and recorded_at < ${from}
    order by execution_id, recorded_at desc, id desc` : [];
  const wasProblem = new Set(before.filter((b) => isProblem(b.status)).map((b) => b.executionId));
  const newFailures = failedNow.filter((r) => !wasProblem.has(r.executionId))
    .map((r) => ({ key: r.key, title: r.title, cycleName: r.cycleName, status: r.status }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.cycleName.localeCompare(b.cycleName));
  // Neue Fehler: erstmals im Zeitraum verknüpft – an Ausführungen oder als Sitzungsfund (Fach-Review Teil 3, Befund 2)
  const newDefects = await db<DefectRef[]>`
    with refs as (
      select r.provider, r.external_key, r.title, r.status, r.url, r.created_at
      from external_reference r join test_execution e on e.id = r.owner_id join test_cycle cy on cy.id = e.cycle_id
      where r.owner_type = 'TEST_EXECUTION' and r.relation = 'DEFECT' and cy.plan_id = ${planId} and cy.archived_at is null
      union all
      select r.provider, r.external_key, r.title, r.status, r.url, r.created_at
      from external_reference r join exploratory_session x on x.id = r.owner_id join test_cycle cy on cy.id = x.cycle_id
      where r.owner_type = 'EXPLORATORY_SESSION' and r.relation = 'DEFECT' and cy.plan_id = ${planId} and cy.archived_at is null)
    select distinct on (n.provider, n.external_key) n.provider, n.external_key as key, n.title, n.status, n.url
    from refs n
    where n.created_at between ${from} and ${to}
      and not exists (select 1 from refs o where o.provider = n.provider and o.external_key = n.external_key and o.created_at < ${from})
    order by n.provider, n.external_key`;
  return {
    // Burn-down zum Ende des Zeitraums (vergangener Zeitraum: Rest und Prognose zu diesem Zeitpunkt)
    ...c, kind: 'status', period: { from, to }, burndown: await burndown(db, planId, opts.to ? to : undefined),
    inPeriod: {
      executed: done.length,
      passed: done.filter((r) => ['PASSED', 'PASSED_WITH_ISSUES'].includes(catOf(r.status))).length,
      failed: failedNow.length,
      byTester: [...byTester.entries()].map(([tester, executed]) => ({ tester, executed })).sort((a, b) => b.executed - a.executed),
      newDefects: newDefects.map((d) => ({ ...d, resolution: defectResolution(d.status) })),
      newFailures,
    },
    statusNote: plan.statusNote ? { text: plan.statusNote, by: plan.statusNoteBy ?? null, at: plan.statusNoteAt ?? null } : null,
  };
}
