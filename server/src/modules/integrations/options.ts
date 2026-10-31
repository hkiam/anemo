/**
 * Auswahlwerte eigener Felder aus Jira bzw. OpenProject übernehmen (Stufe H5): z. B. Versionen, Komponenten,
 * Kategorien oder die Werte eines Auswahlfelds. Nur lesend; gespeicherte Werte in Testfällen bleiben unberührt.
 */
import type { Db } from '../../platform/db.ts';
import { badRequest, notFound } from '../../platform/http.ts';
import { type JiraConfig, jiraConfig } from './jira.ts';
import { type OpenProjectConfig, openProjectConfig } from './openproject.ts';

export interface OptionSource {
  provider: 'jira' | 'openproject';
  /** Jira-Projektschlüssel bzw. OpenProject-Projektkennung */
  project?: string | null | undefined;
  kind: 'versions' | 'components' | 'priorities' | 'customfield' | 'categories' | 'types' | 'statuses';
  /** Jira: customfield_12345 bzw. 12345; OpenProject: customField7 bzw. 7 */
  fieldId?: string | null | undefined;
}

export const SOURCE_KINDS: Record<OptionSource['provider'], OptionSource['kind'][]> = {
  jira: ['versions', 'components', 'priorities', 'customfield'],
  openproject: ['versions', 'categories', 'types', 'priorities', 'statuses', 'customfield'],
};

type Fetch = typeof fetch;

async function getJson<T>(http: Fetch, url: string, headers: Record<string, string>, init: RequestInit = {}): Promise<T> {
  const res = await http(url, { ...init, headers: { accept: 'application/json', ...headers, ...(init.headers as Record<string, string> ?? {}) }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

export async function jiraValues(cfg: JiraConfig, src: OptionSource, http: Fetch = fetch): Promise<string[]> {
  const h = { authorization: cfg.authorization };
  const project = encodeURIComponent(src.project ?? '');
  switch (src.kind) {
    case 'versions': {
      const list = await getJson<{ name: string; archived?: boolean }[]>(http, `${cfg.baseUrl}/rest/api/2/project/${project}/versions`, h);
      return list.filter((v) => !v.archived).map((v) => v.name);
    }
    case 'components': return (await getJson<{ name: string }[]>(http, `${cfg.baseUrl}/rest/api/2/project/${project}/components`, h)).map((c) => c.name);
    case 'priorities': return (await getJson<{ name: string }[]>(http, `${cfg.baseUrl}/rest/api/2/priority`, h)).map((p) => p.name);
    case 'customfield': {
      const id = `customfield_${String(src.fieldId ?? '').replace(/^customfield_/, '')}`;
      // createmeta liefert die zulässigen Werte je Vorgangstyp (Jira Server 7+)
      const meta = await getJson<{ projects: { issuetypes: { fields: Record<string, { allowedValues?: { value?: string; name?: string; disabled?: boolean }[] }> }[] }[] }>(
        http, `${cfg.baseUrl}/rest/api/2/issue/createmeta?projectKeys=${project}&expand=projects.issuetypes.fields`, h);
      const values = new Set<string>();
      for (const p of meta.projects) for (const t of p.issuetypes) for (const v of t.fields[id]?.allowedValues ?? []) if (!v.disabled) values.add(v.value ?? v.name ?? '');
      values.delete('');
      if (!values.size) throw new Error(`Feld ${id} hat im Projekt ${src.project} keine Auswahlwerte`);
      return [...values];
    }
    default: throw badRequest(`Jira liefert keine „${src.kind}“`);
  }
}

export async function openProjectValues(cfg: OpenProjectConfig, src: OptionSource, http: Fetch = fetch): Promise<string[]> {
  const h = { authorization: `Basic ${Buffer.from(`apikey:${cfg.apiKey}`).toString('base64')}`, accept: 'application/hal+json' };
  const project = encodeURIComponent(src.project ?? '');
  type Coll = { _embedded: { elements: { name?: string; value?: string; status?: string }[] } };
  const names = (c: Coll) => c._embedded.elements.map((e) => e.name ?? e.value ?? '').filter(Boolean);
  switch (src.kind) {
    case 'versions': return (await getJson<Coll>(http, `${cfg.url}/api/v3/projects/${project}/versions`, h)).
      _embedded.elements.filter((v) => v.status !== 'closed').map((v) => v.name ?? '').filter(Boolean);
    case 'categories': return names(await getJson<Coll>(http, `${cfg.url}/api/v3/projects/${project}/categories`, h));
    case 'types': return names(await getJson<Coll>(http, `${cfg.url}/api/v3/projects/${project}/types`, h));
    case 'priorities': return names(await getJson<Coll>(http, `${cfg.url}/api/v3/priorities`, h));
    case 'statuses': return names(await getJson<Coll>(http, `${cfg.url}/api/v3/statuses`, h));
    case 'customfield': {
      const id = `customField${String(src.fieldId ?? '').replace(/^customField/i, '')}`;
      // Das Formular eines neuen Arbeitspakets enthält das Schema mit den zulässigen Werten
      const form = await getJson<{ _embedded: { schema: Record<string, { _embedded?: { allowedValues?: { value?: string; name?: string }[] } }> } }>(
        http, `${cfg.url}/api/v3/projects/${project}/work_packages/form`, { ...h, 'content-type': 'application/json' }, { method: 'POST', body: '{}' });
      const allowed = form._embedded.schema[id]?._embedded?.allowedValues;
      if (!allowed?.length) throw new Error(`Benutzerdefiniertes Feld ${id} hat im Projekt keine Auswahlwerte`);
      return allowed.map((v) => v.value ?? v.name ?? '').filter(Boolean);
    }
    default: throw badRequest(`OpenProject liefert keine „${src.kind}“`);
  }
}

/** Werte holen und als Auswahlliste des Felds speichern (Reihenfolge der Quelle, ohne Dubletten). */
export async function syncFieldOptions(db: Db, fieldId: string, http: Fetch = fetch): Promise<{ options: string[]; error: string | null }> {
  const [f] = await db<{ optionsSource: OptionSource | null; type: string }[]>`select options_source, type from field_definition where id = ${fieldId}`;
  if (!f) throw notFound('Feld', fieldId);
  if (!f.optionsSource) throw badRequest('Für dieses Feld ist keine Quelle für Auswahlwerte eingestellt.');
  try {
    const src = f.optionsSource;
    let values: string[];
    if (src.provider === 'jira') {
      const cfg = jiraConfig();
      if (!cfg) throw new Error('Jira ist nicht eingerichtet (Administration → Einstellungen)');
      values = await jiraValues(cfg, src, http);
    } else {
      const cfg = openProjectConfig();
      if (!cfg) throw new Error('OpenProject ist nicht eingerichtet (Administration → Einstellungen)');
      values = await openProjectValues(cfg, src, http);
    }
    const options = [...new Set(values.map((v) => v.trim()).filter(Boolean))].slice(0, 500);
    if (!options.length) throw new Error('Die Quelle liefert keine Werte');
    await db`update field_definition set options = ${options}::text[], options_synced_at = now(), options_sync_error = null where id = ${fieldId}`;
    return { options, error: null };
  } catch (e) {
    const error = (e as Error).message.slice(0, 500);
    await db`update field_definition set options_sync_error = ${error}, options_synced_at = now() where id = ${fieldId}`;
    return { options: [], error };
  }
}

/** Alle Felder mit Quelle abgleichen (regelmäßig, z. B. alle 6 Stunden). */
export async function syncAllFieldOptions(db: Db): Promise<{ synced: number; failed: number }> {
  const fields = await db<{ id: string }[]>`select id from field_definition where options_source is not null and active`;
  let synced = 0, failed = 0;
  for (const f of fields) (await syncFieldOptions(db, f.id)).error ? failed++ : synced++;
  return { synced, failed };
}
