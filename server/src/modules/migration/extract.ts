/**
 * Extraktor: liest Jira Server (REST v2) und Zephyr for Jira (ZAPI) und schreibt einen Snapshot
 * (Format siehe snapshot.ts). Nur lesende GET-Aufrufe. Zugangsdaten kommen aus der Umgebung,
 * niemals aus Dateien im Repository.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Manifest, SNAPSHOT_FORMAT } from './snapshot.ts';

type Json = Record<string, any>;

export interface ExtractOptions {
  baseUrl: string;
  /** Basic Auth (Jira 7.x kennt keine Personal Access Tokens) oder Bearer-Token. */
  auth: { user: string; password: string } | { token: string } | { header: string };
  projects: string[];
  outDir: string;
  /** Optional: weitere JQL-Einschränkung, z. B. "updated >= -30d". */
  jqlFilter?: string | undefined;
  /** Standard: alles an – verlustfreie Extraktion. */
  withStepResults?: boolean;
  withChangelog?: boolean;
  /** Binärdaten der Jira-Anhänge und ZAPI-Ausführungsanhänge herunterladen. */
  withAttachments?: boolean;
  /** Zephyr-Daten (Schritte, Zyklen, Ausführungen) über ZAPI lesen. false → nur Jira, Lücke wird vermerkt. */
  withZephyr?: boolean;
  concurrency?: number;
  log?: (m: string) => void;
  fetchImpl?: typeof fetch;
}

export class JiraClient {
  private readonly o: Pick<ExtractOptions, 'baseUrl' | 'auth' | 'fetchImpl'>;
  private readonly authHeader: string;

  constructor(o: Pick<ExtractOptions, 'baseUrl' | 'auth' | 'fetchImpl'>) {
    this.o = o;
    this.authHeader = 'header' in o.auth
      ? o.auth.header
      : 'token' in o.auth
        ? `Bearer ${o.auth.token}`
        : `Basic ${Buffer.from(`${o.auth.user}:${o.auth.password}`).toString('base64')}`;
  }

  async binary(absoluteUrl: string): Promise<Uint8Array> {
    const url = new URL(absoluteUrl);
    if (url.origin !== new URL(this.o.baseUrl).origin) throw new Error(`Fremde Herkunft ${url.origin} – Zugangsdaten werden nicht gesendet`);
    for (let attempt = 1; ; attempt++) {
      const res = await (this.o.fetchImpl ?? fetch)(url, { headers: { authorization: this.authHeader } });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
        continue;
      }
      throw new Error(`GET ${url.pathname} → HTTP ${res.status}`);
    }
  }

  async get<T = Json>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(this.o.baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    for (let attempt = 1; ; attempt++) {
      const res = await (this.o.fetchImpl ?? fetch)(url, { headers: { authorization: this.authHeader, accept: 'application/json' } });
      if (res.ok) {
        const body = (await res.json()) as T;
        // ZAPI meldet fehlende Rechte mit HTTP 200 und {"errorDesc": …, "errorId": …} – niemals als Daten speichern.
        if (body && typeof body === 'object' && !Array.isArray(body) && 'errorId' in body && 'errorDesc' in body) {
          throw new Error(`GET ${url.pathname}${url.search} → Fehler trotz HTTP 200: ${String((body as Json).errorDesc)}`);
        }
        return body;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
        continue;
      }
      throw new Error(`GET ${url.pathname}${url.search} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  }
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

export async function extractSnapshot(o: ExtractOptions): Promise<Manifest> {
  const log = o.log ?? (() => {});
  const client = new JiraClient(o);
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  const inc = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
  const write = async (path: string[], data: unknown) => {
    await mkdir(join(o.outDir, ...path.slice(0, -1)), { recursive: true });
    await writeFile(join(o.outDir, ...path), typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data, null, 1));
  };
  /** Optionale Endpunkte: Fehler werden als Lücke im Manifest vermerkt statt den Lauf abzubrechen. */
  const tryGet = async <T,>(what: string, path: string, params: Record<string, string | number> = {}): Promise<T | null> => {
    try {
      return await client.get<T>(path, params);
    } catch (e) {
      warnings.push(`${what}: ${(e as Error).message}`);
      return null;
    }
  };
  const download = async (what: string, url: string, target: string[]) => {
    try {
      await write(target, await client.binary(url));
      inc('attachmentFiles');
    } catch (e) {
      warnings.push(`${what}: ${(e as Error).message}`);
    }
  };
  const concurrency = o.concurrency ?? 4;
  const withChangelog = o.withChangelog ?? true;
  const withStepResults = o.withStepResults ?? true;
  const withAttachments = o.withAttachments ?? true;
  let withZephyr = o.withZephyr ?? true;

  await write(['fields.json'], await client.get('/rest/api/2/field'));
  if (withZephyr) {
    const statuses = await tryGet<Json[]>('Zephyr (ZAPI) nicht erreichbar – Schritte, Zyklen und Ausführungen FEHLEN', '/rest/zapi/latest/util/testExecutionStatus');
    if (statuses) await write(['execution-statuses.json'], statuses);
    else withZephyr = false;
  } else {
    warnings.push('Zephyr-Daten (Schritte, Zyklen, Ausführungen) bewusst nicht extrahiert (--no-zephyr)');
  }

  for (const key of o.projects) {
    const project = await client.get(`/rest/api/2/project/${encodeURIComponent(key)}`);
    await write(['projects', `${key}.json`], project);

    // Tests seitenweise
    const jql = `project = "${key}" AND issuetype = Test${o.jqlFilter ? ` AND (${o.jqlFilter})` : ''} ORDER BY key`;
    const issues: Json[] = [];
    for (let startAt = 0; ; ) {
      const page = await client.get<{ issues: Json[]; total: number }>('/rest/api/2/search', {
        jql, startAt, maxResults: 100, fields: '*all', ...(withChangelog ? { expand: 'changelog' } : {}),
      });
      issues.push(...page.issues);
      startAt += page.issues.length;
      log(`${key}: ${issues.length}/${page.total} Tests gelesen`);
      if (page.issues.length === 0 || startAt >= page.total) break;
    }
    inc('issues', issues.length);
    await pool(issues, concurrency, async (issue) => {
      const f = issue.fields ?? {};
      // Suchergebnisse kürzen Kommentare/Arbeitsprotokolle – vollständig nachladen.
      if (f.comment && f.comment.total > (f.comment.comments?.length ?? 0)) {
        const all = await tryGet<Json>(`${issue.key} Kommentare`, `/rest/api/2/issue/${issue.key}/comment`, { maxResults: 1000 });
        if (all) f.comment = all;
      }
      if (f.worklog && f.worklog.total > (f.worklog.worklogs?.length ?? 0)) {
        const all = await tryGet<Json>(`${issue.key} Arbeitsprotokoll`, `/rest/api/2/issue/${issue.key}/worklog`);
        if (all) f.worklog = all;
      }
      if (issue.changelog && issue.changelog.total > (issue.changelog.histories?.length ?? 0)) {
        warnings.push(`${issue.key}: Änderungshistorie unvollständig (${issue.changelog.histories?.length}/${issue.changelog.total})`);
      }
      await write(['issues', `${issue.key}.json`], issue);
      if (withZephyr) await write(['teststeps', `${issue.id}.json`], await client.get(`/rest/zapi/latest/teststep/${issue.id}`));
      if (withAttachments) {
        for (const a of f.attachment ?? []) await download(`${issue.key} Anhang ${a.filename}`, a.content, ['attachments', `jira-${a.id}`]);
      }
    });

    // Zyklen je Version (inkl. -1 = "nicht eingeplant") und deren Ausführungen
    const versionIds = withZephyr ? [...(project.versions ?? []).map((v: Json) => String(v.id)), '-1'] : [];
    for (const versionId of versionIds) {
      const cycles = await client.get<Json>('/rest/zapi/latest/cycle', { projectId: project.id, versionId });
      await write(['cycles', key, `${versionId}.json`], cycles);
      const cycleIds = Object.keys(cycles).filter((k) => k !== 'recordsCount');
      inc('cycles', cycleIds.length);
      await pool(cycleIds, concurrency, async (cycleId) => {
        const executions: Json[] = [];
        let status: unknown = null;
        for (let offset = 0; ; ) {
          const page = await client.get<Json>('/rest/zapi/latest/execution', {
            cycleId, projectId: project.id, versionId, offset, limit: 500, action: 'expand',
          });
          status ??= page.status;
          const batch = (page.executions ?? []) as Json[];
          executions.push(...batch);
          offset += batch.length;
          if (batch.length < 500 || (page.recordsCount !== undefined && offset >= Number(page.recordsCount))) break;
        }
        await write(['executions', `${versionId}_${cycleId}.json`], { status, executions });
        inc('executions', executions.length);
        for (const e of executions) {
          if (withStepResults) {
            const results = await tryGet<Json[]>(`Ausführung ${e.id} Schrittergebnisse`, '/rest/zapi/latest/stepResult', { executionId: e.id });
            if (results) await write(['stepresults', `${e.id}.json`], results);
          }
          if (withAttachments) {
            const att = await tryGet<Json>(`Ausführung ${e.id} Anhänge`, '/rest/zapi/latest/attachment/attachmentsByEntity', { entityId: e.id, entityType: 'EXECUTION' });
            const list = (att?.data ?? []) as Json[];
            if (list.length) {
              await write(['execution-attachments', `${e.id}.json`], list);
              for (const a of list) {
                await download(`Ausführung ${e.id} Anhang ${a.fileName}`, `${o.baseUrl.replace(/\/$/, '')}/rest/zapi/latest/attachment/${a.fileId}/file`, ['attachments', `zapi-${a.fileId}`]);
              }
            }
          }
        }
        log(`${key}: Zyklus ${cycleId} (Version ${versionId}): ${executions.length} Ausführungen`);
      });
    }
  }

  const manifest: Manifest = {
    format: SNAPSHOT_FORMAT,
    sourceSystem: 'jira-zephyr',
    baseUrl: o.baseUrl.replace(/\/$/, ''),
    extractedAt: new Date().toISOString(),
    anonymized: false,
    projects: o.projects,
    counts,
    warnings,
  };
  await write(['manifest.json'], manifest);
  if (warnings.length) log(`ACHTUNG: ${warnings.length} Lücken bei der Extraktion – siehe manifest.json`);
  return manifest;
}

export interface DiscoveryResult {
  server: Json;
  zephyr: Json | null;
  executionStatuses: Json[];
  customFields: { id: string; name: string; type: string | null }[];
  projects: { key: string; name: string; tests: number; versions: number; cycles: number | null; executions: number | null }[];
}

/**
 * Wave-0-Discovery: nur Mengen und Struktur, keine Inhalte. Zählt Tests je Projekt und – für die
 * angegebenen Projekte – Zyklen und Ausführungen.
 */
export async function discover(o: Pick<ExtractOptions, 'baseUrl' | 'auth' | 'fetchImpl'> & { deepProjects?: string[]; log?: (m: string) => void }): Promise<DiscoveryResult> {
  const client = new JiraClient(o);
  const log = o.log ?? (() => {});
  const server = await client.get<Json>('/rest/api/2/serverInfo');
  const zephyr = await client.get<Json>('/rest/zapi/latest/systemInfo').catch(() => null);
  const executionStatuses = await client.get<Json[]>('/rest/zapi/latest/util/testExecutionStatus').catch((e: Error): Json[] => [{ error: e.message.slice(0, 160) }]);
  const fields = await client.get<Json[]>('/rest/api/2/field');
  const projects = await client.get<Json[]>('/rest/api/2/project');
  const result: DiscoveryResult['projects'] = [];
  await pool(projects, 6, async (p) => {
    const r = await client.get<{ total: number }>('/rest/api/2/search', { jql: `project = "${p.key}" AND issuetype = Test`, maxResults: 0 }).catch(() => ({ total: -1 }));
    if (r.total === 0) return;
    const entry = { key: String(p.key), name: String(p.name), tests: r.total, versions: 0, cycles: null as number | null, executions: null as number | null };
    if (o.deepProjects?.includes(p.key) && !('error' in (executionStatuses[0] ?? {}))) {
      const full = await client.get<Json>(`/rest/api/2/project/${p.key}`);
      const versionIds = [...(full.versions ?? []).map((v: Json) => String(v.id)), '-1'];
      entry.versions = versionIds.length - 1;
      entry.cycles = 0;
      entry.executions = 0;
      for (const versionId of versionIds) {
        const cycles = await client.get<Json>('/rest/zapi/latest/cycle', { projectId: full.id, versionId });
        for (const [id, c] of Object.entries(cycles)) {
          if (id === 'recordsCount' || typeof c !== 'object' || c === null) continue;
          entry.cycles++;
          entry.executions += Number((c as Json).totalExecutions ?? 0);
        }
      }
    }
    result.push(entry);
    log(`${p.key}: ${r.total} Tests`);
  });
  return {
    server: { version: server.version, buildDate: server.buildDate },
    zephyr: zephyr ? Object.fromEntries(Object.entries(zephyr).filter(([k]) => /version|build|name/i.test(k))) : null,
    executionStatuses: executionStatuses.map((s) => (s.error ? s : { id: s.id, name: s.name })),
    customFields: fields.filter((f) => f.custom).map((f) => ({ id: f.id, name: f.name, type: f.schema?.custom ?? f.schema?.type ?? null })),
    projects: result.sort((a, b) => b.tests - a.tests),
  };
}
