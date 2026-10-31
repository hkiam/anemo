/**
 * OpenProject-Adapter (API v3) – vorbereitet, aktiv sobald OPENPROJECT_URL und OPENPROJECT_API_KEY gesetzt sind
 * (ADR-0015). Implementiert den Port IssueTrackerAdapter aus ADR-0005.
 */
import { wikiToMarkdown } from './markdown.ts';
import { settingsEnv } from '../../platform/settings.ts';
import { HttpError } from '../../platform/http.ts';

export interface WorkItem { key: string; title: string; status: string; type: string; url: string; resolved: boolean }

export interface OpenProjectConfig { url: string; apiKey: string }

export function openProjectConfig(env: NodeJS.ProcessEnv = settingsEnv()): OpenProjectConfig | null {
  const url = env.OPENPROJECT_URL?.trim().replace(/\/+$/, '');
  const apiKey = env.OPENPROJECT_API_KEY?.trim();
  return url && apiKey ? { url, apiKey } : null;
}

type Fetch = typeof fetch;

/** Nummer (4711) oder – ab OpenProject 17 – Projektschlüssel (PROJ-315, z. B. aus einer Jira-Migration). */
const WP_NUMBER = /^\d{1,12}$/;
const WP_IDENTIFIER = /^[A-Z][A-Z0-9_]{0,30}-\d{1,9}$/;
/** Nur Nummern bzw. Projektschlüssel – der Schlüssel landet im API-Pfad (keine Pfadmanipulation wie „99/../../api/v3/foo“). */
export const isWorkPackageKey = (key: string) => WP_NUMBER.test(key) || WP_IDENTIFIER.test(key);

/** Zugehörigkeit Arbeitspaket → OpenProject-Projekt (Zwischenspeicher, 10 Minuten; Verschieben ist selten). */
const membership = new Map<string, { ok: boolean; at: number }>();
const MEMBERSHIP_TTL = 10 * 60_000;
/** Felder je Projekt/Typ (Zwischenspeicher wie oben) */
const fieldCache = new Map<string, { at: number; fields: Map<string, { name: string; type: string }> }>();
/** Nur für Tests bzw. nach Änderung der Zuordnung */
export function forgetWorkPackageProjects(): void {
  membership.clear();
}

export class OpenProjectAdapter {
  readonly provider = 'openproject';
  private readonly cfg: OpenProjectConfig;
  private readonly http: Fetch;
  constructor(cfg: OpenProjectConfig, http: Fetch = fetch) {
    this.cfg = cfg;
    this.http = http;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.http(`${this.cfg.url}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`apikey:${this.cfg.apiKey}`).toString('base64')}`,
        accept: 'application/hal+json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let data: { message?: string } | null = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* keine JSON-Antwort (z. B. Proxy-Fehlerseite) */ }
    if (!res.ok) {
      const msg = data?.message ?? res.statusText;
      // Fehler der Gegenstelle als 502 mit verständlicher Meldung (statt 500), Zugangsprobleme mit Hinweis auf die Einstellung
      throw new HttpError(502, res.status === 401 || res.status === 403
        ? `OpenProject ${res.status}: ${msg} – bitte den API-Schlüssel unter Administration → Anbindungen → OpenProject prüfen`
        : `OpenProject ${res.status}: ${msg}`);
    }
    if (text && data === null) throw new HttpError(502, 'OpenProject: unerwartete Antwort (kein JSON) – Adresse prüfen');
    return data as T;
  }

  private toItem(wp: OpWorkPackage): WorkItem {
    return {
      key: String(wp.id), title: wp.subject, status: wp._links?.status?.title ?? '', type: wp._links?.type?.title ?? '',
      url: `${this.cfg.url}/work_packages/${wp.id}`,
      resolved: /erledigt|fertig|geschlossen|abgeschlossen|gelöst|behoben|abgelehnt|closed|done|resolved|fixed|rejected/i.test(wp._links?.status?.title ?? ''),
    };
  }

  /** Verbindung prüfen: angemeldeter technischer Benutzer */
  async whoAmI(): Promise<string> {
    const me = await this.call<{ name: string; login?: string }>('GET', '/api/v3/users/me');
    return me.login ?? me.name;
  }

  private async fetchWorkPackage(key: string): Promise<OpWorkPackage | null> {
    if (!isWorkPackageKey(key)) return null;
    try {
      return await this.call<OpWorkPackage>('GET', `/api/v3/work_packages/${encodeURIComponent(key)}`);
    } catch (e) {
      if (String(e).includes(' 404')) return null;
      throw e;
    }
  }

  /** Arbeitspaket per Nummer oder Projektschlüssel; der Schlüssel bleibt wie angefragt (PROJ-315 bzw. 4711). */
  async getWorkItem(key: string): Promise<WorkItem | null> {
    const wp = await this.fetchWorkPackage(key);
    if (!wp) return null;
    const item = this.toItem(wp);
    return WP_IDENTIFIER.test(key) ? { ...item, key, url: `${this.cfg.url}/work_packages/${key}` } : item;
  }

  /** Suche – mit Projekt nur in dessen Arbeitspaketen (nicht alles, was das Servicekonto sieht). */
  async searchWorkItems(query: string, limit = 20, project?: string | null): Promise<WorkItem[]> {
    const filters = JSON.stringify([{ subjectOrId: { operator: '**', values: [query] } }]);
    const base = project ? `/api/v3/projects/${encodeURIComponent(project)}/work_packages` : '/api/v3/work_packages';
    const r = await this.call<{ _embedded: { elements: OpWorkPackage[] } }>('GET', `${base}?pageSize=${limit}&filters=${encodeURIComponent(filters)}`);
    return r._embedded.elements.map((wp) => this.toItem(wp));
  }

  /** Fehler anlegen; Beschreibung kommt als Jira-Markup und wird nach Markdown übersetzt. */
  async createDefect(input: { externalProject: string; title: string; description: string; typeId?: number | undefined; fields?: Record<string, string> | undefined }): Promise<WorkItem> {
    const body: Record<string, unknown> = { subject: input.title.slice(0, 255), description: { format: 'markdown', raw: wikiToMarkdown(input.description) } };
    // Benutzerdefinierte Felder (z. B. Rückverweis „Anemo“ vom Typ Link): nur solche, die der Typ im Projekt kennt
    if (input.fields && Object.keys(input.fields).length) {
      const known = await this.fieldsOf(input.externalProject, input.typeId);
      for (const [k, v] of Object.entries(input.fields)) if (known.has(k) && v) body[k] = v;
    }
    if (input.typeId) body._links = { type: { href: `/api/v3/types/${input.typeId}` } };
    return this.toItem(await this.call<OpWorkPackage>('POST', `/api/v3/projects/${encodeURIComponent(input.externalProject)}/work_packages`, body));
  }

  /**
   * Mehrere Arbeitspakete per ID (für den Statusabgleich), höchstens 100 je Aufruf. Mit Projekt nur Arbeitspakete
   * dieses OpenProject-Projekts – was das Servicekonto sonst noch sieht, bleibt außen vor.
   */
  async getWorkItems(keys: string[], project?: string | null): Promise<WorkItem[]> {
    // Projektschlüssel (PROJ-315) erst in Nummern auflösen – der Filter kennt nur Nummern; Ergebnis trägt wieder den Schlüssel
    const byNumber = new Map<string, string>();
    for (const k of keys.filter((x) => WP_IDENTIFIER.test(x))) {
      const wp = await this.fetchWorkPackage(k);
      if (wp) byNumber.set(String(wp.id), k);
    }
    const ids = [...new Set([...keys.filter((x) => WP_NUMBER.test(x)), ...byNumber.keys()])];
    if (!ids.length) return [];
    const filters = JSON.stringify([{ id: { operator: '=', values: ids } }]);
    const base = project ? `/api/v3/projects/${encodeURIComponent(project)}/work_packages` : '/api/v3/work_packages';
    const r = await this.call<{ _embedded: { elements: OpWorkPackage[] } }>('GET', `${base}?pageSize=${ids.length}&filters=${encodeURIComponent(filters)}`);
    const items = r._embedded.elements.flatMap((wp) => {
      const item = this.toItem(wp);
      const ident = byNumber.get(item.key);
      // per Nummer und per Schlüssel angefragt: beide Einträge liefern
      return ident ? [...(keys.includes(item.key) ? [item] : []), { ...item, key: ident, url: `${this.cfg.url}/work_packages/${ident}` }] : [item];
    });
    if (project) {
      const found = new Set(items.map((w) => w.key));
      for (const k of keys.filter(isWorkPackageKey)) membership.set(`${project}|${k}`, { ok: found.has(k), at: Date.now() });
    }
    return items;
  }

  /** Gehört das Arbeitspaket zum (zugeordneten) OpenProject-Projekt? Ergebnis wird zwischengespeichert. */
  async inProject(key: string, project: string): Promise<boolean> {
    if (!isWorkPackageKey(key)) return false;
    const hit = membership.get(`${project}|${key}`);
    if (hit && Date.now() - hit.at < MEMBERSHIP_TTL) return hit.ok;
    if (membership.size > 20_000) membership.clear();
    return (await this.getWorkItems([key], project)).length > 0;
  }

  /**
   * Benutzerdefinierte Felder (customFieldN → Name, Typ) eines Projekts bzw. Typs; ohne Typ der erste Typ des Projekts.
   * Zwischengespeichert (10 Minuten).
   */
  async fieldsOf(project: string, typeId?: number | null): Promise<Map<string, { name: string; type: string }>> {
    const k = `${this.cfg.url}|${project}|${typeId ?? ''}`;
    const hit = fieldCache.get(k);
    if (hit && Date.now() - hit.at < MEMBERSHIP_TTL) return hit.fields;
    const p = await this.call<{ id: number }>('GET', `/api/v3/projects/${encodeURIComponent(project)}`);
    const t = typeId ?? (await this.call<{ _embedded: { elements: { id: number }[] } }>('GET', `/api/v3/projects/${p.id}/types`))._embedded.elements[0]?.id;
    const fields = new Map<string, { name: string; type: string }>();
    if (t) {
      const schema = await this.call<Record<string, { type?: string; name?: string; writable?: boolean }>>('GET', `/api/v3/work_packages/schemas/${p.id}-${t}`);
      for (const [key, v] of Object.entries(schema)) if (/^customField\d+$/.test(key) && v?.writable !== false) fields.set(key, { name: v.name ?? key, type: v.type ?? '' });
    }
    fieldCache.set(k, { at: Date.now(), fields });
    return fields;
  }

  /** Benutzerdefiniertes Feld eines Arbeitspakets setzen (mit Sperrversion; z. B. Rückverweis nach einem Umzug). */
  async setField(key: string, field: string, value: string | null): Promise<'set' | 'unchanged'> {
    if (!isWorkPackageKey(key) || !/^customField\d+$/.test(field)) throw new Error('Ungültiges Arbeitspaket bzw. Feld');
    const wp = await this.call<Record<string, unknown> & { lockVersion: number }>('GET', `/api/v3/work_packages/${encodeURIComponent(key)}`);
    if ((wp[field] ?? null) === value) return 'unchanged';
    await this.call('PATCH', `/api/v3/work_packages/${encodeURIComponent(key)}`, { lockVersion: wp.lockVersion, [field]: value });
    return 'set';
  }

  /** Aktueller Wert eines benutzerdefinierten Felds (null, wenn leer bzw. nicht vorhanden). */
  async fieldValue(key: string, field: string): Promise<string | null> {
    if (!isWorkPackageKey(key)) return null;
    const wp = await this.call<Record<string, unknown>>('GET', `/api/v3/work_packages/${encodeURIComponent(key)}`);
    const v = wp[field];
    return typeof v === 'string' ? v : null;
  }

  /** Projekte, die das Servicekonto sieht (für die Zuordnung in der Administration) */
  async projects(): Promise<{ identifier: string; name: string }[]> {
    const r = await this.call<{ _embedded: { elements: { identifier: string; name: string }[] } }>('GET', '/api/v3/projects?pageSize=500');
    return r._embedded.elements.map((p) => ({ identifier: p.identifier, name: p.name }));
  }
  /** Typen eines Projekts (für „Typ neuer Fehler“) */
  async types(project: string): Promise<{ id: number; name: string }[]> {
    const r = await this.call<{ _embedded: { elements: { id: number; name: string }[] } }>('GET', `/api/v3/projects/${encodeURIComponent(project)}/types`);
    return r._embedded.elements.map((t) => ({ id: t.id, name: t.name }));
  }

  /** Kommentar (z. B. Rückverweis oder Nachtestergebnis) am Arbeitspaket */
  async comment(key: string, text: string): Promise<void> {
    if (!isWorkPackageKey(key)) throw new Error(`Ungültige Nummer bzw. ungültiger Schlüssel eines Arbeitspakets: ${key.slice(0, 40)}`);
    await this.call('POST', `/api/v3/work_packages/${encodeURIComponent(key)}/activities`, { comment: { raw: wikiToMarkdown(text) } });
  }
}

interface OpWorkPackage {
  id: number;
  subject: string;
  _links?: { status?: { title?: string }; type?: { title?: string } };
}
