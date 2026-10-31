/**
 * Modul search: übergreifende Suche (Lesemodell). Fragt Testfälle, Zyklen, Testpläne, Ausführungskommentare,
 * externe Verweise (z. B. Jira-Defects, Anforderungen) und Anhänge in einem Aufruf ab – projektübergreifend
 * oder auf ein Projekt beschränkt. Liest bewusst direkt aus den Tabellen der anderen Module (nur lesend).
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { route, visibleProjectIdsOf } from '../../platform/http.ts';

export const SearchTypes = ['testcase', 'cycle', 'plan', 'execution', 'reference', 'attachment'] as const;
export type SearchType = (typeof SearchTypes)[number];

export interface SearchHit {
  type: SearchType;
  id: string;
  projectKey: string;
  title: string;
  subtitle: string | null;
  /** Zielobjekt für die Navigation (Testfall-Schlüssel, Zyklus-ID …) */
  target: { testCase?: string; cycleId?: string; executionId?: string; planId?: string };
}

export interface SearchResult {
  query: string;
  groups: { type: SearchType; total: number; items: SearchHit[] }[];
}

const KEY_RE = /^[A-Z][A-Z0-9_]*-T?\d+$/i;

export async function search(db: Db, q: { text: string; projectKey?: string | undefined; visible?: string[] | null; types?: SearchType[] | undefined; limit: number }): Promise<SearchResult> {
  const text = q.text.trim();
  const like = `%${text}%`;
  const types = new Set(q.types?.length ? q.types : SearchTypes);
  const projectFilter = (alias: string) => db`${q.projectKey ? db`and ${db(alias)}.key = ${q.projectKey}` : db``}
    ${q.visible ? db`and ${db(alias)}.id = any(${q.visible}::uuid[])` : db``}`;
  const isKey = KEY_RE.test(text);
  const upper = text.toUpperCase();
  const groups: SearchResult['groups'] = [];
  const add = async <T extends { total: string | number }>(type: SearchType, run: () => Promise<T[]>, map: (r: T) => Omit<SearchHit, 'type'>) => {
    if (!types.has(type)) return;
    const rows = await run();
    groups.push({ type, total: Number(rows[0]?.total ?? 0), items: rows.map((r) => ({ type, ...map(r) })) });
  };

  await add('testcase', () => db<{ id: string; key: string; legacyKey: string | null; title: string; projectKey: string; status: string; total: string }[]>`
    select tc.id, tc.key, tc.legacy_key, v.title, p.key as project_key, tc.status, count(*) over () as total
    from test_case tc join project p on p.id = tc.project_id
    join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
    where (${isKey ? db`tc.key = ${upper} or tc.legacy_key = ${upper} or` : db``}
           v.search @@ websearch_to_tsquery('german', ${text}) or v.title ilike ${like} or tc.legacy_key ilike ${like} or tc.key ilike ${like})
      ${projectFilter('p')}
    order by (tc.key = ${upper} or tc.legacy_key = ${upper}) desc,
             ts_rank(v.search, websearch_to_tsquery('german', ${text})) desc, similarity(v.title, ${text}) desc, tc.key
    limit ${q.limit}`,
  (r) => ({ id: r.id, projectKey: r.projectKey, title: r.title, subtitle: `${r.key}${r.legacyKey ? ` · Jira ${r.legacyKey}` : ''} · ${r.status}`, target: { testCase: r.key } }));

  await add('cycle', () => db<{ id: string; name: string; release: string | null; build: string | null; environment: string | null; projectKey: string; total: string }[]>`
    select c.id, c.name, c.release, c.build, c.environment, p.key as project_key, count(*) over () as total
    from test_cycle c join project p on p.id = c.project_id
    where (c.search @@ websearch_to_tsquery('german', ${text}) or c.name ilike ${like} or c.build ilike ${like} or c.environment ilike ${like})
      ${projectFilter('p')}
    order by ts_rank(c.search, websearch_to_tsquery('german', ${text})) desc, similarity(c.name, ${text}) desc, c.start_date desc nulls last
    limit ${q.limit}`,
  (r) => ({ id: r.id, projectKey: r.projectKey, title: r.name, subtitle: [r.release, r.build, r.environment].filter(Boolean).join(' · ') || null, target: { cycleId: r.id } }));

  await add('plan', () => db<{ id: string; name: string; release: string | null; projectKey: string; total: string }[]>`
    select t.id, t.name, t.release, p.key as project_key, count(*) over () as total
    from test_plan t join project p on p.id = t.project_id
    where (t.name ilike ${like} or t.release ilike ${like}) ${projectFilter('p')}
    order by similarity(t.name, ${text}) desc, t.name desc limit ${q.limit}`,
  (r) => ({ id: r.id, projectKey: r.projectKey, title: r.name, subtitle: r.release, target: { planId: r.id } }));

  await add('execution', () => db<{ id: string; cycleId: string; comment: string; status: string; key: string; cycleName: string; projectKey: string; total: string }[]>`
    select e.id, e.cycle_id, e.comment, e.status, tc.key, c.name as cycle_name, p.key as project_key, count(*) over () as total
    from test_execution e join test_cycle c on c.id = e.cycle_id join project p on p.id = c.project_id
    join test_case tc on tc.id = e.test_case_id
    where e.search @@ websearch_to_tsquery('german', ${text}) ${projectFilter('p')}
    order by e.executed_at desc nulls last limit ${q.limit}`,
  (r) => ({ id: r.id, projectKey: r.projectKey, title: r.comment.slice(0, 140), subtitle: `${r.key} · ${r.cycleName} · ${r.status}`, target: { cycleId: r.cycleId, executionId: r.id } }));

  // Externe Verweise: z. B. "DEMO-17860" → welche Testfälle/Ausführungen verweisen auf diesen Defect/diese Anforderung?
  await add('reference', () => db<{ id: string; externalKey: string; relation: string; title: string | null; ownerType: string; ownerKey: string | null; cycleId: string | null; executionId: string | null; projectKey: string; total: string }[]>`
    select r.id, r.external_key, r.relation, r.title, r.owner_type,
           coalesce(tc.key, tce.key) as owner_key, e.cycle_id, e.id as execution_id, p.key as project_key, count(*) over () as total
    from external_reference r
    left join test_case tc on r.owner_type = 'TEST_CASE' and tc.id = r.owner_id
    left join test_execution e on r.owner_type = 'TEST_EXECUTION' and e.id = r.owner_id
    left join test_case tce on tce.id = e.test_case_id
    join project p on p.id = coalesce(tc.project_id, tce.project_id)
    where (r.external_key ilike ${like} or r.title ilike ${like}) ${projectFilter('p')}
    order by (upper(r.external_key) = ${upper}) desc, r.external_key limit ${q.limit}`,
  (r) => ({
    id: r.id, projectKey: r.projectKey, title: `${r.externalKey}${r.title ? ` – ${r.title}` : ''}`,
    subtitle: `${r.relation} · ${r.ownerType === 'TEST_CASE' ? 'Testfall' : 'Ausführung'} ${r.ownerKey ?? ''}`,
    target: r.ownerType === 'TEST_CASE' ? { testCase: r.ownerKey ?? undefined } : { cycleId: r.cycleId ?? undefined, executionId: r.executionId ?? undefined },
  }));

  await add('attachment', () => db<{ id: string; fileName: string; ownerType: string; ownerKey: string | null; cycleId: string | null; executionId: string | null; projectKey: string; total: string }[]>`
    select a.id, a.file_name, a.owner_type, coalesce(tc.key, tce.key) as owner_key, e.cycle_id, e.id as execution_id,
           p.key as project_key, count(*) over () as total
    from attachment a
    left join test_case tc on a.owner_type = 'TEST_CASE' and tc.id = a.owner_id
    left join test_execution e on a.owner_type = 'TEST_EXECUTION' and e.id = a.owner_id
    left join test_case tce on tce.id = e.test_case_id
    join project p on p.id = coalesce(tc.project_id, tce.project_id)
    where a.file_name ilike ${like} ${projectFilter('p')}
    order by a.file_name limit ${q.limit}`,
  (r) => ({
    id: r.id, projectKey: r.projectKey, title: r.fileName, subtitle: `${r.ownerType === 'TEST_CASE' ? 'Testfall' : 'Ausführung'} ${r.ownerKey ?? ''}`,
    target: r.ownerType === 'TEST_CASE' ? { testCase: r.ownerKey ?? undefined } : { cycleId: r.cycleId ?? undefined, executionId: r.executionId ?? undefined },
  }));

  return { query: text, groups };
}

export function searchRoutes(app: Hono, db: Db): void {
  route(app, {
    method: 'get', path: '/api/search', tag: 'Suche',
    summary: 'Übergreifende Suche über Testfälle, Zyklen, Pläne, Ausführungskommentare, Verweise und Anhänge',
    query: z.object({
      q: z.string().trim().min(2, 'Mindestens 2 Zeichen'),
      project: z.string().optional(),
      types: z.string().optional().transform((v) => (v ? (v.split(',').filter((t) => (SearchTypes as readonly string[]).includes(t)) as SearchType[]) : undefined)),
      limit: z.coerce.number().int().min(1).max(100).default(8),
    }),
  }, ({ query, c }) => search(db, { text: query.q, projectKey: query.project, visible: visibleProjectIdsOf(c), types: query.types, limit: query.limit }));
}
