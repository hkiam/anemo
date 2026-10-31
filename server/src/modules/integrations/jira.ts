/**
 * Jira-Adapter für den Parallelbetrieb bis zum Cut-over (Roadmap B3): hält Titel und Status der in Anemo
 * verknüpften Jira-Tickets (Anforderungen, Fehler) aktuell. Schreibt nur, wenn JIRA_CREATE_DEFECTS eingeschaltet ist
 * (Fehler anlegen, Stufe I).
 */
import type { Db } from '../../platform/db.ts';
import { applyReferenceUpdates } from './refs.ts';
import { settingsEnv } from '../../platform/settings.ts';

export interface JiraConfig { baseUrl: string; authorization: string }

export function jiraConfig(env: NodeJS.ProcessEnv = settingsEnv()): JiraConfig | null {
  const base = env.JIRA_BASE_URL ?? (env.JIRA_HOST ? `http://${env.JIRA_HOST.replace(/^https?:\/\//, '')}` : undefined);
  // Zugang: JIRA_BASIC_AUTH (Umgebung) oder aus der Oberfläche Token bzw. Benutzer + Kennwort
  const header = env.JIRA_BASIC_AUTH?.trim()
    || (env.JIRA_TOKEN?.trim() ? `Bearer ${env.JIRA_TOKEN.trim()}` : env.JIRA_USER?.trim() && env.JIRA_PASSWORD ? `${env.JIRA_USER.trim()}:${env.JIRA_PASSWORD}` : '');
  if (!base || !header) return null;
  const authorization = /^(Basic|Bearer) /.test(header) ? header : `Basic ${header.includes(':') ? Buffer.from(header).toString('base64') : header}`;
  return { baseUrl: base.replace(/\/+$/, ''), authorization };
}

interface JiraIssue { key: string; fields: { summary?: string; status?: { name?: string }; issuetype?: { name?: string } } }

type Fetch = typeof fetch;
let http: Fetch = (...a) => fetch(...a);
/** Nur für Tests: HTTP-Client ersetzen */
export function setJiraFetch(f: Fetch | null): void {
  http = f ?? ((...a) => fetch(...a));
}
export const jiraCreateEnabled = (env: NodeJS.ProcessEnv = settingsEnv()) => env.JIRA_CREATE_DEFECTS === 'true';

/** Fehler in Jira anlegen (REST v2, Beschreibung als Jira-Markup). */
export async function createJiraIssue(cfg: JiraConfig, input: { project: string; issueType: string; summary: string; description: string; priority?: string | undefined }) {
  const fields: Record<string, unknown> = {
    project: { key: input.project }, issuetype: { name: input.issueType }, summary: input.summary.replace(/\s+/g, ' ').slice(0, 255), description: input.description,
  };
  if (input.priority) fields.priority = { name: input.priority };
  const res = await http(`${cfg.baseUrl}/rest/api/2/issue`, {
    method: 'POST', headers: { authorization: cfg.authorization, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ fields }), signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> }; msg = [...(j.errorMessages ?? []), ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join('; ') || msg; } catch { /* Text */ }
    throw new Error(`Jira ${res.status}: ${msg}`);
  }
  const { key } = JSON.parse(text) as { key: string };
  return { key, title: input.summary.slice(0, 255), status: 'Offen', type: input.issueType, url: `${cfg.baseUrl}/browse/${key}`, resolved: false };
}

export async function fetchIssues(cfg: JiraConfig, keys: string[]): Promise<JiraIssue[]> {
  const res = await http(`${cfg.baseUrl}/rest/api/2/search`, {
    method: 'POST',
    headers: { authorization: cfg.authorization, 'content-type': 'application/json', accept: 'application/json' },
    // validateQuery=false: unbekannte/gelöschte Schlüssel lassen die Abfrage nicht scheitern
    body: JSON.stringify({ jql: `key in (${keys.map((k) => `"${k.replace(/"/g, '')}"`).join(',')})`, fields: ['summary', 'status', 'issuetype'], maxResults: keys.length, validateQuery: false }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { issues: JiraIssue[] }).issues;
}

export interface RefreshResult { at: Date; checked: number; updated: number; missing: number; retests: number; error: string | null }
let last: RefreshResult | null = null;
export const lastJiraRefresh = () => last;

/**
 * Titel/Status der Jira-Verweise aktualisieren (in Paketen zu 100 Schlüsseln).
 *
 * Projektbezug (Sicherheit 3): Abgeglichen werden der Altbestand (vor dieser Regel angelegt) und Verweise aus der
 * Migration – sie bilden den Parallelbetrieb ab und dürfen beliebige Jira-Projekte betreffen. Neu von Hand angelegte
 * Verweise nur, wenn das Jira-Projekt zum Anemo-Projekt passt: zugeordnetes Jira-Projekt, gleicher Projektschlüssel
 * oder ein Jira-Projekt, das schon im Altbestand bzw. in der Migration dieses Anemo-Projekts vorkommt. Andere bleiben
 * ohne Titel/Status (sonst ließe sich über das Servicekonto jedes Ticket lesen).
 */
export async function refreshJiraReferences(db: Db, cfg: JiraConfig): Promise<RefreshResult> {
  const eligible = (await db<{ id: string; externalKey: string }[]>`
    with refs as (
      select r.id, r.external_key, r.created_by, reference_owner_project(r.owner_type, r.owner_id) as project_id
      from external_reference r where r.provider = 'jira'),
    allowed as (
      select project_id, upper(split_part(external_key, '-', 1)) as prefix from refs where created_by in ('altbestand', 'migration')
      union select project_id, upper(external_project) from project_integration where provider = 'jira'
      union select id, upper(key) from project)
    select r.id, r.external_key from refs r
    where r.created_by in ('altbestand', 'migration')
       or exists (select 1 from allowed a where a.project_id = r.project_id and a.prefix = upper(split_part(r.external_key, '-', 1)))
    order by r.external_key`).filter((r) => /^[A-Z][A-Z0-9_]+-\d+$/.test(r.externalKey));
  const keys = [...new Set(eligible.map((r) => r.externalKey))];
  const refIds = eligible.map((r) => r.id);
  let updated = 0;
  let retests = 0;
  let found = 0;
  try {
    for (let i = 0; i < keys.length; i += 100) {
      const issues = await fetchIssues(cfg, keys.slice(i, i + 100));
      found += issues.length;
      const r = await applyReferenceUpdates(db, 'jira', issues.map((is) => ({
        key: is.key, title: is.fields.summary ?? null, status: is.fields.status?.name ?? null, url: `${cfg.baseUrl}/browse/${is.key}`,
      })), refIds);
      updated += r.updated;
      retests += r.retests;
    }
    last = { at: new Date(), checked: keys.length, updated, missing: keys.length - found, retests, error: null };
  } catch (e) {
    last = { at: new Date(), checked: keys.length, updated, missing: 0, retests, error: (e as Error).message };
  }
  return last;
}
