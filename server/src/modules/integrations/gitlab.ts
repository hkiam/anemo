/**
 * GitLab-Anbindung (Roadmap B4, ADR-0022): Gherkin-Testfälle ↔ .feature-Dateien im Repository und Verknüpfung mit
 * Merge-Requests/Commits. API v4 mit Projekt-/Gruppen-Token (Bereich „api“). Ein Testfall je Datei, gekennzeichnet
 * durch das Tag @<Testfallschlüssel> – darüber finden auch CI-Ergebnisse (Cucumber) zurück.
 */
import type { Db } from '../../platform/db.ts';
import { badRequest, HttpError } from '../../platform/http.ts';
import { createTestCase, getTestCase, reviseTestCase } from '../testcases/index.ts';
import { settingsEnv } from '../../platform/settings.ts';

export interface GitLabConfig { url: string; token: string }
export function gitlabConfig(env: NodeJS.ProcessEnv = settingsEnv()): GitLabConfig | null {
  const url = env.GITLAB_URL?.trim().replace(/\/+$/, '');
  return url && env.GITLAB_TOKEN ? { url, token: env.GITLAB_TOKEN } : null;
}

export interface GitLabLink { project: string; branch: string; folder: string }

export class GitLabClient {
  private readonly cfg: GitLabConfig;
  constructor(cfg: GitLabConfig) {
    this.cfg = cfg;
  }
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.url}/api/v4${path}`, {
      method, signal: AbortSignal.timeout(20_000),
      headers: { 'private-token': this.cfg.token, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`GitLab ${res.status}: ${typeof data?.message === 'string' ? data.message : JSON.stringify(data?.message ?? data?.error ?? res.statusText)}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return data as T;
  }
  private p = (project: string) => `/projects/${encodeURIComponent(project)}`;

  whoAmI() {
    return this.call<{ username: string }>('GET', '/user');
  }
  /** Pipeline starten (benötigt Token mit Recht „api“ und Rolle Developer im Repository) */
  triggerPipeline(project: string, ref: string, variables: Record<string, string>) {
    return this.call<{ id: number; status: string; web_url: string; ref: string }>('POST', `${this.p(project)}/pipeline`, {
      ref, variables: Object.entries(variables).map(([key, value]) => ({ key, value, variable_type: 'env_var' })),
    });
  }
  pipeline(project: string, id: string) {
    return this.call<{ id: number; status: string; web_url: string; ref: string }>('GET', `${this.p(project)}/pipelines/${encodeURIComponent(id)}`);
  }
  /** .feature-Dateien unter einem Ordner (rekursiv, seitenweise) */
  async featureFiles(l: GitLabLink): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page < 50; page++) {
      let items: { path: string; type: string }[];
      try {
        items = await this.call('GET', `${this.p(l.project)}/repository/tree?ref=${encodeURIComponent(l.branch)}&path=${encodeURIComponent(l.folder)}&recursive=true&per_page=100&page=${page}`);
      } catch (e) {
        if ((e as { status?: number }).status === 404) return out; // Ordner existiert (noch) nicht
        throw e;
      }
      out.push(...items.filter((i) => i.type === 'blob' && i.path.endsWith('.feature')).map((i) => i.path));
      if (items.length < 100) break;
    }
    return out;
  }
  async rawFile(l: GitLabLink, path: string): Promise<string> {
    const res = await fetch(`${this.cfg.url}/api/v4${this.p(l.project)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(l.branch)}`, {
      headers: { 'private-token': this.cfg.token }, signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GitLab ${res.status} beim Lesen von ${path}`);
    return res.text();
  }
  commit(l: GitLabLink, message: string, actions: { action: 'create' | 'update' | 'delete'; file_path: string; content?: string }[]) {
    return this.call<{ id: string; short_id: string; web_url: string }>('POST', `${this.p(l.project)}/repository/commits`, { branch: l.branch, commit_message: message, actions });
  }
  async lastCommit(l: GitLabLink): Promise<string | null> {
    const [c] = await this.call<{ id: string }[]>('GET', `${this.p(l.project)}/repository/commits?ref_name=${encodeURIComponent(l.branch)}&path=${encodeURIComponent(l.folder)}&per_page=1`).catch(() => []);
    return c?.id ?? null;
  }
  searchMergeRequests(project: string, q: string) {
    return this.call<{ iid: number; title: string; state: string; web_url: string; source_branch: string }[]>('GET', `${this.p(project)}/merge_requests?search=${encodeURIComponent(q)}&per_page=20&order_by=updated_at`);
  }
  mergeRequest(project: string, iid: string) {
    return this.call<{ iid: number; title: string; state: string; web_url: string }>('GET', `${this.p(project)}/merge_requests/${encodeURIComponent(iid)}`);
  }
  getCommit(project: string, sha: string) {
    return this.call<{ id: string; short_id: string; title: string; web_url: string }>('GET', `${this.p(project)}/repository/commits/${encodeURIComponent(sha)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Gherkin ↔ Datei
// ---------------------------------------------------------------------------------------------

const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 50) || 'szenario';
const FEATURE = /^(\s*)(Feature|Funktionalität|Funktion|Business Need|Ability):/m;

/** Testfall-Tag vor die Feature-Zeile setzen (vorhandene Tags bleiben), Zeilenenden vereinheitlichen. */
export function toFeatureFile(key: string, version: number, gherkin: string): string {
  const text = gherkin.replace(/\r\n?/g, '\n').trimEnd();
  const tag = `@${key}`;
  const m = FEATURE.exec(text);
  if (!m) return `# Anemo ${key} v${version}\n${tag}\n${text}\n`;
  const before = text.slice(0, m.index);
  const lines = before.split('\n');
  const tagLineIdx = lines.length - 2; // Zeile direkt vor der Feature-Zeile
  const hasTag = new RegExp(`(^|\\s)${tag}(\\s|$)`).test(before);
  const head = hasTag ? before : lines[tagLineIdx]?.trim().startsWith('@')
    ? [...lines.slice(0, tagLineIdx), `${lines[tagLineIdx]} ${tag}`, ''].join('\n')
    : `${before}${m[1]}${tag}\n`;
  return `${head}${text.slice(m.index)}\n`;
}

/** Schlüssel aus Datei lesen und Tag/Zeilenenden für den Vergleich mit Anemo entfernen. */
export function fromFeatureFile(content: string): { key: string | null; gherkin: string } {
  const text = content.replace(/\r\n?/g, '\n');
  const key = /(?:^|\s)@([A-Z][A-Z0-9_]+-T\d+)(?=\s|$)/m.exec(text)?.[1] ?? null;
  const withoutTag = key
    ? text.replace(new RegExp(`[ \\t]*@${key}(?=\\s|$)`), '').replace(/^# Anemo [A-Z0-9_]+-T\d+ v\d+\n/m, '').replace(/^[ \t]*\n(?=\s*(Feature|Funktionalität|Funktion):)/m, '')
    : text;
  return { key, gherkin: withoutTag.trimEnd() };
}

const norm = (s: string) => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();
export const fileName = (l: GitLabLink, key: string, title: string) => `${l.folder.replace(/\/+$/, '')}/${key}-${slug(title)}.feature`.replace(/^\//, '');

export interface CompareEntry { key: string | null; title: string; path: string | null; status: 'same' | 'changedInGit' | 'changedInAnemo' | 'onlyInGit' | 'onlyInAnemo'; version: number | null }

async function gherkinCases(db: Db, projectId: string) {
  return db<{ id: string; key: string; title: string; gherkin: string; versionNo: number; syncedVersion: number | null; syncedHash: string | null }[]>`
    select tc.id, tc.key, v.title, v.gherkin, v.version_no, g.version_no as synced_version, g.content_hash as synced_hash
    from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
    left join gitlab_sync g on g.test_case_id = tc.id
    where tc.project_id = ${projectId} and v.format = 'GHERKIN' and v.gherkin is not null
    order by tc.key`;
}

const hash = (s: string) => {
  let h = 0;
  for (const ch of norm(s)) h = (Math.imul(31, h) + ch.codePointAt(0)!) | 0;
  return (h >>> 0).toString(36);
};

/** Abgleich Repository ↔ Anemo. Merkt sich je Testfall den zuletzt synchronisierten Stand (Tabelle gitlab_sync). */
export async function compare(db: Db, gl: GitLabClient, l: GitLabLink, projectId: string): Promise<CompareEntry[]> {
  const cases = await gherkinCases(db, projectId);
  const files = await gl.featureFiles(l);
  const contents = new Map<string, { key: string | null; gherkin: string }>();
  for (const f of files) contents.set(f, fromFeatureFile(await gl.rawFile(l, f)));
  const out: CompareEntry[] = [];
  const seen = new Set<string>();
  for (const [path, c] of contents) {
    const tc = c.key ? cases.find((x) => x.key === c.key) : undefined;
    if (!tc) {
      out.push({ key: c.key, title: /(?:Feature|Funktionalität|Funktion):\s*(.*)/.exec(c.gherkin)?.[1]?.trim() ?? path, path, status: 'onlyInGit', version: null });
      continue;
    }
    seen.add(tc.key);
    let status: CompareEntry['status'] = 'same';
    if (norm(c.gherkin) !== norm(tc.gherkin)) {
      // Wer hat geändert? Git-Stand gleich dem zuletzt synchronisierten → Anemo hat geändert, sonst Git
      status = tc.syncedHash && hash(c.gherkin) === tc.syncedHash ? 'changedInAnemo' : 'changedInGit';
    }
    out.push({ key: tc.key, title: tc.title, path, status, version: tc.versionNo });
  }
  for (const tc of cases) if (!seen.has(tc.key)) out.push({ key: tc.key, title: tc.title, path: null, status: 'onlyInAnemo', version: tc.versionNo });
  return out.sort((a, b) => (a.key ?? '~').localeCompare(b.key ?? '~', 'de', { numeric: true }));
}

async function markSynced(db: Db, tcId: string, version: number, gherkin: string, path: string, actor: string) {
  await db`insert into gitlab_sync(test_case_id, path, version_no, content_hash, synced_by) values (${tcId}, ${path}, ${version}, ${hash(gherkin)}, ${actor})
           on conflict (test_case_id) do update set path = excluded.path, version_no = excluded.version_no, content_hash = excluded.content_hash,
             synced_at = now(), synced_by = excluded.synced_by`;
}

/*
 * Externe Aufrufe nie innerhalb einer offenen Datenbanktransaktion (Befund 15): Export = vergleichen (lesend) →
 * committen → Stand kurz speichern; Import = Dateien lesen → in einer kurzen Transaktion übernehmen.
 */
export interface FeatureExportPlan {
  actions: { action: 'create' | 'update'; file_path: string; content: string }[];
  done: { tcId: string; version: number; gherkin: string; path: string }[];
  skipped: string[];
}

/** Anemo → Git, Schritt 1: was zu schreiben ist. Dateien, die in Git geändert wurden, bleiben unangetastet. */
export async function planFeatureExport(db: Db, gl: GitLabClient, l: GitLabLink, projectId: string): Promise<FeatureExportPlan> {
  const cases = await gherkinCases(db, projectId);
  const state = await compare(db, gl, l, projectId);
  const plan: FeatureExportPlan = { actions: [], done: [], skipped: [] };
  for (const e of state) {
    const tc = cases.find((x) => x.key === e.key);
    if (!tc) continue;
    if (e.status === 'changedInGit') { plan.skipped.push(tc.key); continue; }
    if (e.status === 'same') { if (!tc.syncedHash) plan.done.push({ tcId: tc.id, version: tc.versionNo, gherkin: tc.gherkin, path: e.path! }); continue; }
    const path = e.path ?? fileName(l, tc.key, tc.title);
    plan.actions.push({ action: e.path ? 'update' : 'create', file_path: path, content: toFeatureFile(tc.key, tc.versionNo, tc.gherkin) });
    plan.done.push({ tcId: tc.id, version: tc.versionNo, gherkin: tc.gherkin, path });
  }
  return plan;
}

/** Schritt 2: ein Commit mit allen Änderungen (ohne Datenbank). */
export async function commitFeatures(gl: GitLabClient, l: GitLabLink, plan: FeatureExportPlan, actor: string) {
  if (!plan.actions.length) return null;
  return gl.commit(l, `Anemo: ${plan.actions.length} Gherkin-Testfall/-fälle aktualisiert (von ${actor})`, plan.actions);
}

/** Schritt 3: synchronisierten Stand merken. */
export async function markFeaturesSynced(db: Db, plan: FeatureExportPlan, actor: string): Promise<void> {
  for (const d of plan.done) await markSynced(db, d.tcId, d.version, d.gherkin, d.path, actor);
}

export interface FeatureFile { path: string; key: string | null; gherkin: string; sha: string }

/** Git → Anemo, Schritt 1: Dateien lesen (vor der Transaktion). */
export async function readFeatureFiles(gl: GitLabClient, l: GitLabLink, paths: string[]): Promise<FeatureFile[]> {
  const sha = (await gl.lastCommit(l))?.slice(0, 8) ?? l.branch;
  const out: FeatureFile[] = [];
  for (const path of paths) {
    if (!path.endsWith('.feature') || !path.startsWith(l.folder.replace(/^\//, ''))) throw badRequest(`Pfad außerhalb des Feature-Ordners: ${path}`);
    out.push({ path, sha, ...fromFeatureFile(await gl.rawFile(l, path)) });
  }
  return out;
}

/** Schritt 2: Änderungen als neue Versionen bzw. neue Testfälle übernehmen (in der Transaktion des Aufrufers). */
export async function applyFeatureImport(db: Db, l: GitLabLink, projectId: string, files: FeatureFile[], actor: string) {
  const results: { path: string; key: string; action: 'version' | 'created' | 'unchanged' | 'skipped'; reason?: string }[] = [];
  for (const { path, sha, ...file } of files) {
    if (!file.gherkin.trim()) continue;
    const title = /(?:Feature|Funktionalität|Funktion):\s*(.*)/.exec(file.gherkin)?.[1]?.trim() || path.split('/').pop()!.replace(/\.feature$/, '');
    if (file.key) {
      const tc = await getTestCase(db, file.key).catch(() => null);
      if (!tc || tc.projectId !== projectId) throw new HttpError(409, `${path}: Testfall ${file.key} gehört nicht zu diesem Projekt`);
      // klassische bzw. Freitext-Testfälle nicht stillschweigend zu Gherkin umstellen
      if (tc.version.format !== 'GHERKIN') {
        results.push({ path, key: tc.key, action: 'skipped', reason: `${tc.key} ist kein Gherkin-Testfall (${tc.version.format === 'PLAIN' ? 'Freitext' : 'klassisch mit Schritten'}) – nicht übernommen` });
        continue;
      }
      const r = await reviseTestCase(db, tc.id, { ...tc.version, format: 'GHERKIN', gherkin: file.gherkin }, `Aus Git übernommen (${l.project}@${sha}: ${path})`, actor);
      await markSynced(db, tc.id, r.testCase.currentVersion, file.gherkin, path, actor);
      results.push({ path, key: tc.key, action: r.changed ? 'version' : 'unchanged' });
    } else {
      const tc = await createTestCase(db, { projectId, content: { title, format: 'GHERKIN', gherkin: file.gherkin, steps: [] } } as never, actor);
      // Datei bekommt beim nächsten Export das Tag; Zuordnung schon jetzt merken
      await markSynced(db, tc.id, tc.currentVersion, file.gherkin, path, actor);
      results.push({ path, key: tc.key, action: 'created' });
    }
  }
  return { results };
}
