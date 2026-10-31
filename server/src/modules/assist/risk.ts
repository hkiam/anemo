/**
 * Risikobasierte Testauswahl (Stufe H-J): Jeder Testfall erhält einen nachvollziehbaren Risikowert aus Einzelfaktoren
 * (Priorität, Fehlerhistorie, Wackeln, Änderung seit der letzten Ausführung, Alter des letzten Ergebnisses, offene
 * Fehler, gefährdete Anforderungen, Treffer im Änderungsumfang). Aus der Rangfolge wird innerhalb eines Zeit- oder
 * Mengenbudgets eine Auswahl vorgeschlagen. Optional verfeinert ein Sprachmodell die Rangfolge anhand der
 * Änderungsbeschreibung – jede Anpassung ist begründet und als eigener Faktor sichtbar.
 */
import type { Db } from '../../platform/db.ts';
import { compileTestCaseQuery } from '../query/index.ts';
import { isResolvedStatus } from '../references/index.ts';
import { flakyByConfiguration } from '../../../../shared/status/status.ts';

export interface RiskFactor { key: string; label: string; points: number; detail?: string }
export interface RiskItem {
  id: string; key: string; title: string; priority: string | null; components: string[]; folder: string | null;
  score: number; factors: RiskFactor[]; lastStatus: string | null; lastExecutedAt: Date | null;
  minutes: number; estimated: boolean; selected: boolean; inCycle: boolean;
}
export interface RiskChange { text?: string | undefined; components?: string[] | undefined; requirements?: string[] | undefined }
export interface RiskOptions {
  aql?: string | undefined; cycleId?: string | undefined; budgetMinutes?: number | undefined; maxTests?: number | undefined;
  minScore?: number | undefined; change?: RiskChange | undefined; actor?: string | undefined;
}

/** Gewichte (Höchstpunkte je Faktor); Summe ohne Änderungsumfang 100. */
export const WEIGHTS = { priority: 20, lastFailed: 15, failRate: 15, flaky: 10, changed: 15, stale: 10, defects: 10, requirements: 5, scope: 25, text: 15 } as const;
const FAIL = new Set(['FAILED', 'BLOCKED', 'KNOWN_FAILURE']);
const DEFAULT_MINUTES = 10;
/** Höchstzahl bewerteter Kandidaten; darüber wird (deterministisch nach Schlüssel) abgeschnitten und `truncated` gemeldet. */
export const MAX_CANDIDATES = 5000;

const tsWords = (text: string) => [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []))].slice(0, 80);

/** Risikowert je Testfall und Auswahlvorschlag im Budget. */
export async function riskRanking(db: Db, projectId: string, o: RiskOptions) {
  const aq = o.aql?.trim() ? await compileTestCaseQuery(db, o.aql, { projectId, actor: o.actor }) : null;
  const words = tsWords(o.change?.text ?? '');
  const tsq = words.length ? words.join(' | ') : null;
  const cands = await db<{ id: string; key: string; title: string; priority: string | null; components: string[]; labels: string[]; folder: string | null;
    currentVersion: number; estimateMinutes: number | null; textRank: number; inCycle: boolean }[]>`
    select tc.id, tc.key, v.title, v.priority, v.components, v.labels, f.name as folder, tc.current_version, tc.estimate_minutes,
      ${tsq ? db`ts_rank(v.search, to_tsquery('german', ${tsq}), 32)` : db`0`}::float8 as text_rank,
      ${o.cycleId ? db`exists (select 1 from test_execution x where x.cycle_id = ${o.cycleId} and x.test_case_id = tc.id)` : db`false`} as in_cycle
    from test_case tc
    join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
    join test_case_status st on st.code = tc.status
    left join folder f on f.id = tc.folder_id
    where tc.project_id = ${projectId} and tc.archived_at is null and st.category <> 'DEPRECATED'
      ${aq ? aq.where : db``}
    order by length(tc.key), tc.key
    limit ${MAX_CANDIDATES + 1}`;
  const truncated = cands.length > MAX_CANDIDATES;
  if (truncated) cands.length = MAX_CANDIDATES;
  const meta = { truncated, candidateLimit: MAX_CANDIDATES,
    hint: truncated ? `Mehr als ${MAX_CANDIDATES} Testfälle – nur die ersten ${MAX_CANDIDATES} (nach Schlüssel) bewertet; bitte mit einer Abfrage eingrenzen.` : null };
  if (!cands.length) return { items: [] as RiskItem[], summary: summarize([], 0), weights: WEIGHTS, ...meta };
  const ids = cands.map((c) => c.id);

  // Ergebnisverlauf: letzte 10 ausgeführte Ergebnisse je Testfall (neueste zuerst)
  const hist = await db<{ testCaseId: string; category: string; status: string; executedAt: Date; versionNo: number; durationSeconds: number }[]>`
    select h.test_case_id, h.category, h.status, h.executed_at, h.version_no, h.duration_seconds from (
      select e.test_case_id, s.category, e.status, e.executed_at, v.version_no, e.duration_seconds,
        row_number() over (partition by e.test_case_id order by e.executed_at desc) as rn
      from test_execution e join execution_status s on s.code = e.status join test_case_version v on v.id = e.test_case_version_id
      where e.test_case_id = any(${ids}::uuid[]) and e.executed_at is not null) h
    where h.rn <= 10 order by h.test_case_id, h.executed_at desc`;
  const histOf = group(hist, (h) => h.testCaseId);

  // Wackeln: Ergebnisverlauf aus execution_result (auch Korrekturen innerhalb einer Ausführung, z. B. Fehlschlag →
  // Nachtest bestanden), je Konfiguration des Zyklus; migrierte Ausführungen ohne Verlauf mit ihrem Endergebnis.
  // Aufeinanderfolgende gleiche Ergebnisse derselben Ausführung (bloßes Nachspeichern) zählen einmal (Review Teil 3, Befund 17).
  const flakyHist = await db<{ testCaseId: string; configuration: string; category: string }[]>`
    select f.test_case_id, f.configuration, f.category from (
      select x.*, row_number() over (partition by x.test_case_id, x.configuration order by x.at desc, x.seq desc) as rn from (
        select e.test_case_id, coalesce(c.configuration, '{}'::jsonb)::text as configuration, s.category, r.recorded_at as at, r.id as seq,
          lag(r.status) over (partition by r.execution_id order by r.id) as prev, r.status
        from execution_result r join test_execution e on e.id = r.execution_id join test_cycle c on c.id = e.cycle_id
        join execution_status s on s.code = r.status
        where e.test_case_id = any(${ids}::uuid[])
        union all
        select e.test_case_id, coalesce(c.configuration, '{}'::jsonb)::text, s.category, e.executed_at, 0, null, e.status
        from test_execution e join test_cycle c on c.id = e.cycle_id join execution_status s on s.code = e.status
        where e.test_case_id = any(${ids}::uuid[]) and e.executed_at is not null
          and not exists (select 1 from execution_result r where r.execution_id = e.id)) x
      where x.prev is distinct from x.status) f
    where f.rn <= 16 order by f.test_case_id, f.configuration, f.rn`;
  const flakyOf = group(flakyHist, (h) => h.testCaseId);

  // offene Fehler: am Testfall oder an seinen Ausführungen
  const defects = await db<{ testCaseId: string; externalKey: string; status: string | null }[]>`
    select coalesce(e.test_case_id, r.owner_id) as test_case_id, r.external_key, r.status
    from external_reference r left join test_execution e on r.owner_type = 'TEST_EXECUTION' and e.id = r.owner_id
    where r.relation = 'DEFECT' and ((r.owner_type = 'TEST_CASE' and r.owner_id = any(${ids}::uuid[])) or e.test_case_id = any(${ids}::uuid[]))`;
  const openDefects = new Map<string, Set<string>>();
  for (const d of defects) if (!isResolvedStatus(d.status)) (openDefects.get(d.testCaseId) ?? openDefects.set(d.testCaseId, new Set()).get(d.testCaseId)!).add(d.externalKey);

  // Anforderungen: verknüpft und gefährdet (ein verknüpfter Testfall zuletzt fehlgeschlagen/blockiert)
  const reqs = await db<{ testCaseId: string; key: string; failing: boolean }[]>`
    with mine as (select owner_id as test_case_id, external_key as key from external_reference
      where owner_type = 'TEST_CASE' and relation in ('REQUIREMENT', 'STORY', 'EPIC') and owner_id = any(${ids}::uuid[]))
    select m.test_case_id, m.key, exists (
      select 1 from external_reference r2
      join lateral (select s.category from test_execution e join execution_status s on s.code = e.status
        where e.test_case_id = r2.owner_id and e.executed_at is not null order by e.executed_at desc limit 1) last on true
      where r2.owner_type = 'TEST_CASE' and r2.relation in ('REQUIREMENT', 'STORY', 'EPIC') and r2.external_key = m.key
        and last.category in ('FAILED', 'BLOCKED')) as failing
    from mine m`;
  const reqOf = group(reqs, (r) => r.testCaseId);

  // nur aktive Prioritäten bilden die Rangfolge (inaktive verzerren sonst die Abstufung)
  const prios = await db<{ code: string; isDefault: boolean }[]>`select code, is_default from priority where active order by sort_order, code`;
  const prioRank = new Map(prios.map((p, i) => [p.code.toLowerCase(), i]));
  const defaultRank = prios.findIndex((p) => p.isDefault);
  // Dauer: Schätzung, sonst Median der erfassten Zeiten des Testfalls, sonst Median des Projekts
  const [pm] = await db<{ m: number | null }[]>`
    select percentile_cont(0.5) within group (order by e.duration_seconds) as m from test_execution e join test_cycle c on c.id = e.cycle_id
    where c.project_id = ${projectId} and e.duration_seconds > 0`;
  const projectMinutes = pm?.m ? Math.max(1, Math.round(pm.m / 60)) : DEFAULT_MINUTES;

  const lc = (xs: string[] | undefined) => new Set((xs ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean));
  const chComp = lc(o.change?.components);
  const chReq = lc(o.change?.requirements);
  const now = Date.now();
  const items: RiskItem[] = cands.map((c) => {
    const f: RiskFactor[] = [];
    const add = (key: string, label: string, points: number, detail?: string) => { if (points > 0) f.push({ key, label, points: Math.round(points), ...(detail ? { detail } : {}) }); };
    // Priorität: höchste Stufe volle Punkte, linear bis zur niedrigsten
    const rank = c.priority ? prioRank.get(c.priority.toLowerCase()) ?? defaultRank : defaultRank;
    if (prios.length > 1 && rank >= 0) add('priority', 'Priorität', WEIGHTS.priority * (1 - rank / (prios.length - 1)), c.priority ?? `${prios[defaultRank]?.code ?? '–'} (Standard)`);
    const h = histOf.get(c.id) ?? [];
    const last = h[0];
    if (!last) add('never', 'Nie ausgeführt', WEIGHTS.changed);
    else {
      if (FAIL.has(last.category)) add('lastFailed', 'Zuletzt fehlgeschlagen/blockiert', WEIGHTS.lastFailed, last.status);
      const fails = h.filter((x) => FAIL.has(x.category)).length;
      if (fails) add('failRate', 'Fehlerquote', (WEIGHTS.failRate * fails) / h.length, `${fails} von ${h.length} Ergebnissen`);
      // gleiche Definition wie Test-Health, je Konfiguration
      const fl = flakyByConfiguration(flakyOf.get(c.id) ?? []);
      if (fl.flaky) add('flaky', 'Wackelnd', Math.min(WEIGHTS.flaky, 4 + 2 * fl.switches), `${fl.switches} Wechsel bestanden/fehlgeschlagen`);
      if (c.currentVersion > last.versionNo) add('changed', 'Geändert seit letzter Ausführung', WEIGHTS.changed, `v${last.versionNo} → v${c.currentVersion}`);
      const days = (now - new Date(last.executedAt).getTime()) / 864e5;
      if (days > 14) add('stale', 'Lange nicht ausgeführt', Math.min(WEIGHTS.stale, (WEIGHTS.stale * days) / 120), `${Math.round(days)} Tage`);
    }
    const od = openDefects.get(c.id);
    if (od?.size) add('defects', 'Offene Fehler', Math.min(WEIGHTS.defects, 6 + 2 * od.size), [...od].slice(0, 4).join(', '));
    const rq = reqOf.get(c.id) ?? [];
    const failingReq = rq.filter((r) => r.failing);
    if (failingReq.length) add('requirements', 'Gefährdete Anforderung', WEIGHTS.requirements, failingReq.slice(0, 3).map((r) => r.key).join(', '));
    // Änderungsumfang: Komponenten/Schlagworte bzw. Anforderungen, die geändert wurden
    const hitComp = [...c.components, ...c.labels].filter((x) => chComp.has(x.toLowerCase()));
    const hitReq = rq.filter((r) => chReq.has(r.key.toLowerCase())).map((r) => r.key);
    if (hitComp.length || hitReq.length) add('scope', 'Im Änderungsumfang', WEIGHTS.scope, [...new Set([...hitComp, ...hitReq])].join(', '));
    if (c.textRank > 0) add('text', 'Passt zur Änderungsbeschreibung', Math.min(WEIGHTS.text, c.textRank * 60));
    const durs = h.map((x) => x.durationSeconds).filter((x) => x > 0).sort((a, b) => a - b);
    const minutes = c.estimateMinutes ?? (durs.length ? Math.max(1, Math.round(durs[Math.floor(durs.length / 2)]! / 60)) : projectMinutes);
    return {
      id: c.id, key: c.key, title: c.title, priority: c.priority, components: c.components, folder: c.folder,
      score: f.reduce((a, x) => a + x.points, 0), factors: f.sort((a, b) => b.points - a.points),
      lastStatus: last?.status ?? null, lastExecutedAt: last?.executedAt ?? null, minutes, estimated: c.estimateMinutes !== null, selected: false, inCycle: c.inCycle,
    };
  });
  return { ...select(items, o), ...meta };
}

/** Sortieren und innerhalb des Budgets auswählen (Testfälle, die schon im Zyklus sind, werden nicht erneut vorgeschlagen). */
export function select(items: RiskItem[], o: Pick<RiskOptions, 'budgetMinutes' | 'maxTests' | 'minScore'>) {
  items.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key, 'de', { numeric: true }));
  let minutes = 0, count = 0;
  for (const it of items) {
    it.selected = false;
    if (it.inCycle || it.score < (o.minScore ?? 1)) continue;
    if (o.maxTests && count >= o.maxTests) continue;
    if (o.budgetMinutes && minutes + it.minutes > o.budgetMinutes) continue;
    it.selected = true;
    minutes += it.minutes;
    count++;
  }
  return { items, summary: summarize(items, minutes), weights: WEIGHTS };
}

function summarize(items: RiskItem[], minutes: number) {
  const total = items.reduce((a, x) => a + x.score, 0);
  const sel = items.filter((x) => x.selected);
  return {
    candidates: items.length, selected: sel.length, selectedMinutes: minutes, totalMinutes: items.reduce((a, x) => a + x.minutes, 0),
    // Anteil des Gesamtrisikos (Summe der Risikowerte), den die Auswahl abdeckt
    riskCovered: total ? Math.round((1000 * sel.reduce((a, x) => a + x.score, 0)) / total) / 10 : 0,
    withoutEstimate: sel.filter((x) => !x.estimated).length,
  };
}

function group<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) (m.get(key(r)) ?? m.set(key(r), []).get(key(r))!).push(r);
  return m;
}
