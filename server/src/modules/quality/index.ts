/**
 * Modul quality: Test-Health je Projekt (Roadmap E). Regelbasierte Prüfungen über Testfälle und ihre
 * Ausführungshistorie; jede Prüfung liefert eine Pflege-Warteschlange. Keine KI, alles nachvollziehbar.
 */
import { checkSteps } from '../../../../shared/steps/groups.ts';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { route } from '../../platform/http.ts';
import { getProject } from '../projects/index.ts';
import { FLAKY_MIN_SWITCHES, FLAKY_WINDOW, flakyByConfiguration } from '../../../../shared/status/status.ts';

export interface HealthItem { key: string; title: string; status: string; detail: string; lastExecutedAt: Date | null }
export interface HealthCheck { id: string; title: string; description: string; severity: 'info' | 'warn' | 'bad'; count: number; items: HealthItem[] }

const CHECKS = {
  never: ['Nie ausgeführt', 'Testfälle ohne jede Ausführung (veraltete ausgenommen)', 'warn'],
  stale: ['Lange nicht ausgeführt', 'Letzte Ausführung älter als 12 Monate', 'info'],
  flaky: ['Wackelnd', `Mindestens ${FLAKY_MIN_SWITCHES} Wechsel zwischen bestanden und fehlgeschlagen in den letzten ${FLAKY_WINDOW} Ergebnissen derselben Konfiguration – oder in den letzten 90 Tagen erst im Wiederholungsversuch bestanden`, 'bad'],
  alwaysPass: ['Immer bestanden', 'Mindestens 5 Ergebnisse, alle bestanden – Kandidat für Automatisierung', 'info'],
  blocked: ['Häufig blockiert', 'Mindestens 30 % der Ergebnisse blockiert (ab 3 Ergebnissen)', 'warn'],
  noExpected: ['Ohne prüfbares Ergebnis', 'Klassische Schritte ohne erwartetes Ergebnis', 'warn'],
  remarks: ['Mit Mangel/ungültig', 'Letztes Ergebnis „bestanden mit Mangel/Einschränkung“ oder „ungültig“ – fachlich klären', 'warn'],
  duplicates: ['Mögliche Duplikate', 'Gleicher Titel (ohne Groß-/Kleinschreibung und Satzzeichen) mehrfach im Projekt', 'info'],
  legacy: ['Altlasten', 'Titel mit „(alt)“, „alt:“, „obsolet“ o. Ä., aber nicht als veraltet markiert', 'info'],
} as const;

const LIMIT = 300;
const norm = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export async function projectHealth(db: Db, projectId: string, now = new Date()): Promise<{ total: number; checks: HealthCheck[] }> {
  const tcs = await db<{ id: string; key: string; title: string; status: string; category: string | null; format: string; steps: { expected?: string }[] }[]>`
    select tc.id, tc.key, v.title, tc.status, s.category, v.format, v.steps
    from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
    left join test_case_status s on s.code = tc.status
    where tc.project_id = ${projectId} and tc.archived_at is null`;
  const execs = await db<{ testCaseId: string; code: string; name: string; category: string; executedAt: Date; configuration: string }[]>`
    select e.test_case_id, e.status as code, s.name, s.category, e.executed_at, coalesce(c.configuration, '{}'::jsonb)::text as configuration
    from test_execution e join test_case tc on tc.id = e.test_case_id join execution_status s on s.code = e.status
    join test_cycle c on c.id = e.cycle_id
    where tc.project_id = ${projectId} and e.executed_at is not null
    order by e.test_case_id, e.executed_at desc`;
  // erst im Wiederholungsversuch bestanden (Vermerk in der Ergebnis-Historie, z. B. aus dem Automatisierungsimport)
  const retries = new Map((await db<{ testCaseId: string; n: number }[]>`
    select e.test_case_id, count(*)::int as n from execution_result r join test_execution e on e.id = r.execution_id
    join test_case tc on tc.id = e.test_case_id
    where tc.project_id = ${projectId} and r.note like '%Wiederholung:%' and r.recorded_at > ${new Date(now.getTime() - 90 * 86400_000)}
    group by e.test_case_id`).map((r) => [r.testCaseId, r.n]));
  type Exec = (typeof execs)[number];
  const byTc = new Map<string, Exec[]>();
  for (const e of execs) (byTc.get(e.testCaseId) ?? byTc.set(e.testCaseId, []).get(e.testCaseId)!).push(e);

  const found: Record<keyof typeof CHECKS, HealthItem[]> = { never: [], stale: [], flaky: [], alwaysPass: [], blocked: [], noExpected: [], remarks: [], duplicates: [], legacy: [] };
  const yearAgo = new Date(now.getTime() - 365 * 86400_000);
  const titles = new Map<string, (typeof tcs)[number][]>();
  for (const t of tcs) {
    const deprecated = t.category === 'DEPRECATED';
    const h = byTc.get(t.id) ?? [];
    const last = h[0]?.executedAt ?? null;
    const item = (detail: string): HealthItem => ({ key: t.key, title: t.title, status: t.status, detail, lastExecutedAt: last });
    if (!deprecated) {
      if (!h.length) found.never.push(item('noch nie ausgeführt'));
      else if (last! < yearAgo) found.stale.push(item(`zuletzt ${last!.toLocaleDateString('de-DE')}`));
      // gemeinsame Definition mit der Risikobewertung, je Konfiguration (Review Teil 3, Befund 17)
      const fl = flakyByConfiguration(h);
      if (fl.flaky) found.flaky.push(item(`${fl.switches} Wechsel in den letzten Ergebnissen${fl.configuration && fl.configuration !== '{}' ? ` (Konfiguration ${fl.configuration})` : ''}`));
      else if (retries.get(t.id)) found.flaky.push(item(`${retries.get(t.id)}× erst im Wiederholungsversuch bestanden (90 Tage)`));
      if (h.length >= 5 && h.every((e) => e.category === 'PASSED')) found.alwaysPass.push(item(`${h.length}× bestanden`));
      const blocked = h.filter((e) => e.category === 'BLOCKED').length;
      if (h.length >= 3 && blocked / h.length >= 0.3) found.blocked.push(item(`${blocked} von ${h.length} blockiert`));
      if (h[0] && (h[0].category === 'INVALID' || (h[0].category === 'PASSED' && h[0].code !== 'PASS'))) found.remarks.push(item(`letztes Ergebnis: ${h[0].name}`));
      const checks = checkSteps(t.steps);
      if (t.format === 'CLASSIC' && checks.length) {
        const missing = checks.filter((s) => !s.expected?.trim()).length;
        if (missing === checks.length) found.noExpected.push(item(`keiner der ${missing} Schritte hat ein erwartetes Ergebnis`));
      }
      if (/\(alt\)|^alt[:\s-]|\bobsolet|\bveraltet|\bdeprecated|\bnicht mehr verwenden/i.test(t.title)) found.legacy.push(item('Titel deutet auf Altlast hin'));
    }
    const n = norm(t.title);
    if (n.length >= 8) (titles.get(n) ?? titles.set(n, []).get(n)!).push(t);
  }
  for (const group of titles.values()) {
    if (group.length < 2) continue;
    for (const t of group) {
      found.duplicates.push({ key: t.key, title: t.title, status: t.status, detail: `gleicher Titel wie ${group.filter((x) => x !== t).map((x) => x.key).join(', ')}`, lastExecutedAt: byTc.get(t.id)?.[0]?.executedAt ?? null });
    }
  }
  const sortKey = (a: HealthItem, b: HealthItem) => a.key.localeCompare(b.key, 'de', { numeric: true });
  return {
    total: tcs.length,
    checks: (Object.keys(CHECKS) as (keyof typeof CHECKS)[]).map((id) => {
      const [title, description, severity] = CHECKS[id];
      const items = found[id].sort(sortKey);
      return { id, title, description, severity, count: items.length, items: items.slice(0, LIMIT) };
    }),
  };
}

export function qualityRoutes(app: Hono, db: Db): void {
  route(app, {
    method: 'get', path: '/api/projects/:key/health', tag: 'Qualität', summary: 'Test-Health: regelbasierte Pflege-Warteschlangen',
    access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, query: z.object({}),
  }, async ({ params }) => projectHealth(db, (await getProject(db, params.key!)).id));
}
