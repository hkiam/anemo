/**
 * Anonymisierer für Snapshots (ADR-0006). Ersetzt Personen konsistent durch Pseudonyme
 * (HMAC mit geheimem Salt → nicht per Wörterbuch umkehrbar), entfernt E-Mail-Adressen und
 * Avatare und ersetzt Personennamen auch in Freitexten. Optional werden Freitexte vollständig
 * verfremdet, wobei Wiki-Markup (Panels, Tabellen) erhalten bleibt, damit der Normalizer weiter
 * getestet werden kann. Die Zuordnungstabelle wird bewusst NICHT geschrieben.
 */
import { createHmac } from 'node:crypto';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Manifest } from './snapshot.ts';

type Json = Record<string, any>;

const USERNAME_FIELDS = ['executedBy', 'assignedTo', 'createdBy', 'modifiedBy', 'executedByUserName', 'assignedToUserName', 'lead'];
const DISPLAY_FIELDS = ['executedByDisplay', 'assignedToDisplay', 'createdByDisplay', 'modifiedByDisplay'];
const TEXT_FIELDS = new Set(['summary', 'description', 'body', 'comment', 'htmlComment', 'step', 'data', 'result', 'htmlStep', 'htmlData', 'htmlResult', 'environment', 'issueSummary', 'issueDescription']);

export interface AnonymizeOptions {
  salt: string;
  scrubText?: boolean;
  /** Binäranhänge unverändert übernehmen (Screenshots können Personenbezug enthalten – Standard: nein). */
  keepAttachments?: boolean;
}

export class Anonymizer {
  private readonly salt: string;
  private readonly scrubText: boolean;
  /** Echte Namen/Benutzernamen → Pseudonym; nur im Speicher. */
  private readonly names = new Map<string, string>();

  constructor(o: AnonymizeOptions) {
    if (!o.salt || o.salt.length < 16) throw new Error('ANON_SALT muss mindestens 16 Zeichen haben');
    this.salt = o.salt;
    this.scrubText = o.scrubText ?? false;
  }

  private h(v: string, len = 6) {
    return createHmac('sha256', this.salt).update(v.toLowerCase()).digest('hex').slice(0, len);
  }

  get peopleCount(): number {
    return this.persons.size;
  }

  private pseudoUser(name: string) {
    return `user-${this.h(name)}`;
  }

  private pseudoDisplay(name: string) {
    return `Person ${this.h(name).toUpperCase()}`;
  }

  /** Eindeutige Personen (für die Statistik). */
  private readonly persons = new Set<string>();

  /**
   * Durchlauf 1a: Jira-Benutzerobjekte einsammeln. Sie verbinden Benutzername und Anzeigename
   * und müssen vor den ZAPI-Feldern gelesen werden, damit eine Person überall dasselbe Pseudonym erhält.
   */
  collectUsers(node: unknown): void {
    if (Array.isArray(node)) return node.forEach((n) => this.collectUsers(n));
    if (!node || typeof node !== 'object') return;
    const o = node as Json;
    if (typeof o.displayName === 'string' && (o.name || o.key || o.emailAddress)) {
      const id = String(o.name ?? o.key ?? o.emailAddress);
      this.persons.add(id);
      this.names.set(o.displayName, this.pseudoDisplay(id));
      if (o.name) this.names.set(String(o.name), this.pseudoUser(id));
      if (o.key && o.key !== o.name) this.names.set(String(o.key), this.pseudoUser(id));
    }
    Object.values(o).forEach((v) => this.collectUsers(v));
  }

  /** Durchlauf 1b: ZAPI-Felder mit Benutzer- bzw. Anzeigenamen; bekannte Personen behalten ihr Pseudonym. */
  collectZapi(node: unknown): void {
    if (Array.isArray(node)) return node.forEach((n) => this.collectZapi(n));
    if (!node || typeof node !== 'object') return;
    const o = node as Json;
    for (const f of USERNAME_FIELDS) {
      if (typeof o[f] === 'string' && o[f] && !this.names.has(o[f])) {
        this.names.set(o[f], this.pseudoUser(o[f]));
        this.persons.add(o[f]);
      }
    }
    for (const f of DISPLAY_FIELDS) {
      if (typeof o[f] === 'string' && o[f] && !this.names.has(o[f])) {
        this.names.set(o[f], this.pseudoDisplay(o[f]));
        this.persons.add(o[f]);
      }
    }
    Object.values(o).forEach((v) => this.collectZapi(v));
  }

  private replaceNames(text: string): string {
    let out = text.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (m) => `${this.pseudoUser(m)}@example.invalid`);
    out = out.replace(/\[~([^\]]+)\]/g, (_m, u: string) => `[~${this.names.get(u) ?? this.pseudoUser(u)}]`);
    // Längste Namen zuerst, damit "Max Mustermann" vor "Max" ersetzt wird.
    const sorted = [...this.names.keys()].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length);
    for (const name of sorted) {
      if (out.includes(name)) out = out.split(name).join(this.names.get(name)!);
    }
    return out;
  }

  /** Freitext verfremden, Wiki-Markup ({panel…}, ||Tabellen|, *fett*) bleibt stehen. */
  private scrub(text: string): string {
    return text.split(/(\{[^}]*\}|\[[^\]]*\]|![^!\s]+!|\|\|?|\*|\n)/).map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(/\p{L}{3,}/gu, (w) => {
        const h = this.h(w, 8);
        return (w[0] === w[0]!.toUpperCase() ? 'X' : 'x') + h.slice(0, Math.max(2, Math.min(w.length - 1, 8)));
      });
    }).join('');
  }

  /** Durchlauf 2: Objekt anonymisiert kopieren. */
  transform(node: unknown, key?: string): unknown {
    if (Array.isArray(node)) return node.map((n) => this.transform(n, key));
    if (typeof node === 'string') {
      if (key && USERNAME_FIELDS.includes(key)) return this.names.get(node) ?? this.pseudoUser(node);
      if (key && DISPLAY_FIELDS.includes(key)) return this.names.get(node) ?? this.pseudoDisplay(node);
      let s = this.replaceNames(node);
      if (this.scrubText && key && TEXT_FIELDS.has(key)) s = this.scrub(s);
      return s;
    }
    if (!node || typeof node !== 'object') return node;
    const o = node as Json;
    const out: Json = {};
    const isUser = typeof o.displayName === 'string' && (o.name || o.key || o.emailAddress);
    for (const [k, v] of Object.entries(o)) {
      if (isUser) {
        const id = String(o.name ?? o.key ?? o.emailAddress);
        if (k === 'displayName') { out[k] = this.pseudoDisplay(id); continue; }
        if (k === 'name' || k === 'key') { out[k] = this.pseudoUser(id); continue; }
        if (k === 'emailAddress') { out[k] = `${this.pseudoUser(id)}@example.invalid`; continue; }
        if (k === 'avatarUrls') continue;
        if (k === 'self') { out[k] = String(v).replace(/username=[^&]+/, `username=${this.pseudoUser(id)}`); continue; }
      }
      out[k] = this.transform(v, k);
    }
    return out;
  }
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    const p = join(dir, entry);
    if ((await stat(p)).isDirectory()) {
      if (entry !== 'attachments') out.push(...(await listJsonFiles(p)));
    }
    else if (entry.endsWith('.json')) out.push(p);
  }
  return out;
}

export async function anonymizeSnapshot(srcDir: string, outDir: string, o: AnonymizeOptions): Promise<{ files: number; people: number }> {
  const a = new Anonymizer(o);
  const files = await listJsonFiles(srcDir);
  const docs = new Map<string, unknown>();
  for (const f of files) {
    const doc = JSON.parse(await readFile(f, 'utf8'));
    docs.set(f, doc);
    a.collectUsers(doc);
  }
  for (const doc of docs.values()) a.collectZapi(doc);
  await mkdir(outDir, { recursive: true });
  for (const [f, doc] of docs) {
    const target = join(outDir, relative(srcDir, f));
    await mkdir(join(target, '..'), { recursive: true });
    const isManifest = relative(srcDir, f) === 'manifest.json';
    const data = isManifest ? { ...(doc as Manifest), anonymized: true, attachmentsRemoved: !o.keepAttachments } : a.transform(doc);
    await writeFile(target, JSON.stringify(data, null, 1));
  }
  if (o.keepAttachments) await cp(join(srcDir, 'attachments'), join(outDir, 'attachments'), { recursive: true }).catch(() => {});
  return { files: files.length, people: a.peopleCount };
}
