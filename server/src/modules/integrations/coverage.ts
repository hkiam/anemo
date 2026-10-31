/**
 * Abdeckungsstatus im Ticket (Stufe I): Für Anforderungen in OpenProject meldet Anemo den Teststand als Kommentar am
 * Arbeitspaket – nur für Projekte mit Zuordnung, erlaubten externen Diensten und eingeschaltetem Schalter
 * `coverageComments`, und nur an Arbeitspakete des zugeordneten OpenProject-Projekts.
 *
 * Gegen Kommentarflut: Der gemeldete Stand wird je (Anemo-Projekt, Anforderung) gespeichert; kommentiert wird nur, wenn
 * sich der **Zustand** ändert (nicht bei jeder Änderung im Detail), und höchstens einmal je Anforderung und Tag
 * (Europe/Berlin, über alle Projekte). Ein Fehler bei einem Arbeitspaket (z. B. 404) bricht die übrigen nicht ab.
 *
 * Abdeckungsregel wie Cockpit und Rückverfolgbarkeit: je Testfall und Konfiguration das zuletzt ausgeführte Ergebnis
 * (archivierte Zyklen zählen nicht), über die Konfigurationen das schlechteste; ein Ergebnis auf einer älteren Version
 * gilt als nicht getestet, ungeprüfte Agentenergebnisse zählen als offen.
 */
import type { Db } from '../../platform/db.ts';
import { isFailedOrBlocked, isNotOk, isPassed, rank } from '../../../../shared/status/status.ts';
import { isWorkPackageKey, type OpenProjectAdapter } from './openproject.ts';
import { goPath } from '../../platform/links.ts';

export type CoverageState = 'failing' | 'passed' | 'partial' | 'untested';
const LABEL: Record<CoverageState, string> = { failing: '❌ Fehler', passed: '✅ bestanden', partial: '◐ teilweise getestet', untested: '⚪ noch nicht getestet' };

export interface RequirementCoverage { key: string; state: CoverageState; detail: string }

/** Konfiguration kanonisch (Schlüssel und Werte sortiert, leere Werte weg) – wie in den Berichten */
const canonicalCfg = (c: Record<string, string[]> | null | undefined) =>
  JSON.stringify(Object.keys(c ?? {}).filter((k) => c![k]?.length).sort().map((k) => [k, [...c![k]!].sort()]));

/** Teststand je OpenProject-Anforderung eines Projekts (nur nicht archivierte Testfälle). */
export async function requirementCoverage(db: Db, projectId: string): Promise<RequirementCoverage[]> {
  const links = await db<{ key: string; tcId: string; tcKey: string }[]>`
    select distinct r.external_key as key, tc.id as tc_id, tc.key as tc_key
    from external_reference r join test_case tc on tc.id = r.owner_id
    where r.owner_type = 'TEST_CASE' and r.provider = 'openproject' and r.relation in ('REQUIREMENT', 'STORY', 'EPIC')
      and tc.project_id = ${projectId} and tc.archived_at is null`;
  if (!links.length) return [];
  const tcIds = [...new Set(links.map((l) => l.tcId))];
  // je Testfall und Konfiguration das zuletzt ausgeführte Ergebnis (ohne archivierte Zyklen)
  const rows = await db<{ testCaseId: string; status: string; reviewState: string | null; outdated: boolean; configuration: Record<string, string[]> | null; executedAt: Date }[]>`
    select distinct on (e.test_case_id, coalesce(c.configuration, '{}'::jsonb)) e.test_case_id, e.status, e.review_state,
      (v.version_no <> tc.current_version) as outdated, c.configuration, e.executed_at
    from test_execution e join test_cycle c on c.id = e.cycle_id join test_case tc on tc.id = e.test_case_id
    join test_case_version v on v.id = e.test_case_version_id
    where e.test_case_id = any(${tcIds}::uuid[]) and e.executed_at is not null and c.archived_at is null
    order by e.test_case_id, coalesce(c.configuration, '{}'::jsonb), e.executed_at desc`;
  const statuses = await db<{ code: string; name: string; category: string }[]>`select code, name, category from execution_status`;
  const cat = new Map(statuses.map((s) => [s.code, s.category]));
  const name = new Map(statuses.map((s) => [s.code, s.name]));
  // je Testfall × Konfiguration (kanonisch) das jüngste, dann über die Konfigurationen das schlechteste
  const perCfg = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.testCaseId}|${canonicalCfg(r.configuration)}`;
    const prev = perCfg.get(k);
    if (!prev || r.executedAt > prev.executedAt) perCfg.set(k, r);
  }
  type TcState = { category: string; label: string; outdated: boolean };
  const byTc = new Map<string, TcState>();
  for (const r of perCfg.values()) {
    const unreviewed = r.reviewState === 'pending' || r.reviewState === 'escalated';
    const s: TcState = unreviewed
      ? { category: 'OPEN', label: 'Agentenergebnis noch nicht geprüft', outdated: false }
      : { category: cat.get(r.status) ?? 'OPEN', label: name.get(r.status) ?? r.status, outdated: r.outdated };
    if (s.outdated && !isFailedOrBlocked(s.category)) s.label += ' (ältere Version)';
    const prev = byTc.get(r.testCaseId);
    // schlechtestes gewinnt; bei gleichem Rang ist ein veraltetes Ergebnis das schlechtere
    if (!prev || rank(s.category) < rank(prev.category) || (rank(s.category) === rank(prev.category) && s.outdated && !prev.outdated)) byTc.set(r.testCaseId, s);
  }
  const by = new Map<string, { tcKey: string; s: TcState | undefined }[]>();
  for (const l of links) (by.get(l.key) ?? by.set(l.key, []).get(l.key)!).push({ tcKey: l.tcKey, s: byTc.get(l.tcId) });
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b, 'de', { numeric: true })).map(([key, list]) => {
    const tcs = list.sort((a, b) => a.tcKey.localeCompare(b.tcKey, 'de', { numeric: true }));
    const done = (t: (typeof tcs)[number]) => !!t.s && ((isPassed(t.s.category) && !t.s.outdated) || t.s.category === 'NOT_APPLICABLE');
    const state: CoverageState = tcs.some((t) => t.s && isNotOk(t.s.category)) ? 'failing'
      : tcs.every(done) ? 'passed' : tcs.some(done) ? 'partial' : 'untested';
    const detail = tcs.slice(0, 15).map((t) => `${t.tcKey}: ${t.s?.label ?? 'nicht ausgeführt'}`).join(', ') + (tcs.length > 15 ? ` … (${tcs.length} Testfälle)` : '');
    return { key, state, detail };
  });
}

/**
 * Geänderte Zustände als Kommentar melden (nur Arbeitspakete des zugeordneten OpenProject-Projekts).
 * Liefert die Zahl der Kommentare und der fehlgeschlagenen Versuche.
 */
export async function pushCoverage(db: Db, op: OpenProjectAdapter, projectId: string, externalProject: string, baseUrl: string | null, projectKey: string): Promise<{ comments: number; failed: number }> {
  const cov = (await requirementCoverage(db, projectId)).filter((c) => isWorkPackageKey(c.key));
  if (!cov.length) return { comments: 0, failed: 0 };
  // nur Arbeitspakete des zugeordneten Projekts (das Servicekonto sieht ggf. mehr)
  const own = new Set<string>();
  for (let i = 0; i < cov.length; i += 100) {
    for (const w of await op.getWorkItems(cov.slice(i, i + 100).map((c) => c.key), externalProject)) own.add(w.key);
  }
  const keys = cov.map((c) => c.key);
  const known = new Map((await db<{ externalKey: string; state: string; detail: string }[]>`
    select external_key, state, detail from coverage_push where project_id = ${projectId} and provider = 'openproject' and external_key = any(${keys})`).map((r) => [r.externalKey, r]));
  // heute (Europe/Berlin) schon kommentiert – egal aus welchem Projekt
  const today = new Set((await db<{ externalKey: string }[]>`
    select distinct external_key from coverage_push where provider = 'openproject' and external_key = any(${keys})
      and pushed_at >= (date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin')`).map((r) => r.externalKey));
  let comments = 0;
  let failed = 0;
  for (const c of cov) {
    if (!own.has(c.key)) continue;
    const k = known.get(c.key);
    if (k && k.state === c.state) {
      // nur das Detail hat sich geändert: Stand still nachführen, kein Kommentar
      if (k.detail !== c.detail) await db`update coverage_push set detail = ${c.detail} where project_id = ${projectId} and provider = 'openproject' and external_key = ${c.key}`;
      continue;
    }
    if (today.has(c.key)) continue; // morgen erneut versuchen (Stand bleibt ungespeichert)
    const link = baseUrl ? `\n\n[In Anemo ansehen|${baseUrl}${goPath('ticket', 'openproject', c.key)}]` : '';
    try {
      await op.comment(c.key, `*Testabdeckung (Anemo, ${projectKey}):* ${LABEL[c.state]}\n${c.detail}${link}`);
    } catch (e) {
      failed++;
      console.error(`Abdeckung ins Ticket ${c.key} (${projectKey})`, (e as Error).message);
      continue;
    }
    await db`insert into coverage_push(project_id, provider, external_key, state, detail) values (${projectId}, 'openproject', ${c.key}, ${c.state}, ${c.detail})
      on conflict (project_id, provider, external_key) do update set state = excluded.state, detail = excluded.detail, pushed_at = now()`;
    today.add(c.key);
    comments++;
  }
  return { comments, failed };
}
