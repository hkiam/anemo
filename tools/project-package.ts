/**
 * Projektpakete von der Kommandozeile übertragen (ADR-0027) – für große Projekte und Umzüge ohne Browser.
 * Spricht die REST-API mit einem API-Token (Recht „Projekte übertragen“ nötig), ohne Zusatzbibliotheken.
 *
 *   node tools/project-package.ts export --project DEMO [--out paket.zip] [--wait]
 *        [--tests DEMO-T1,DEMO-T2] [--query 'titel ~ Akte'] [--cycles ID,ID] [--versions current]
 *        [--no-executions] [--no-attachments] [--no-comments] [--pseudonymize] [--note 'Umzug']
 *   node tools/project-package.ts download --id TRANSFER-ID [--out paket.zip]
 *   node tools/project-package.ts import --file paket.zip (--new KEY --name 'Name' | --into KEY [--folder ID])
 *        [--options optionen.json] [--dry-run]
 *   node tools/project-package.ts status [--id TRANSFER-ID]
 *
 * Verbindung: --url bzw. ANEMO_URL (z. B. https://anemo.firma.de), --token bzw. ANEMO_TOKEN (anemo_…).
 * --options: JSON mit persons, executionStatuses, testCaseStatuses, priorities, conflicts (siehe Probelauf).
 * Rückgabewert: 0 ok, 1 Fehler bzw. Hinderungsgründe, 2 Export wartet auf Freigabe (ohne --wait).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

type Json = Record<string, any>;
interface Io { log: (s: string) => void; error: (s: string) => void; sleep?: (ms: number) => Promise<void> }

class CliError extends Error {}

function parse(argv: string[]) {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new CliError(`Unerwartetes Argument: ${a}`);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags.set(a.slice(2), next); i++; } else flags.set(a.slice(2), 'true');
  }
  return { command, flags };
}

const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export async function run(argv: string[], io: Io = { log: console.log, error: console.error }, env: Record<string, string | undefined> = process.env): Promise<number> {
  const sleep = io.sleep ?? ((ms: number) => new Promise((ok) => setTimeout(ok, ms)));
  try {
    const { command, flags } = parse(argv);
    if (!command || command === 'help' || flags.has('help')) { io.log(USAGE); return 0; }
    const base = (flags.get('url') ?? env.ANEMO_URL ?? '').replace(/\/+$/, '');
    const token = flags.get('token') ?? env.ANEMO_TOKEN;
    if (!base) throw new CliError('Adresse fehlt: --url oder ANEMO_URL');
    if (!token) throw new CliError('API-Token fehlt: --token oder ANEMO_TOKEN');
    const auth = { authorization: `Bearer ${token}` };

    const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> => {
      const res = await fetch(`${base}${path}`, { method, headers: { ...auth, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      let json: Json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { detail: text }; }
      if (res.status >= 400 && res.status !== 409) throw new CliError(`${res.status}: ${json.detail ?? text}`);
      return { status: res.status, body: json };
    };
    const download = async (id: string, out?: string) => {
      const res = await fetch(`${base}/api/project-transfers/${id}/download`, { headers: auth });
      if (!res.ok || !res.body) throw new CliError(`${res.status}: ${((await res.json().catch(() => ({}))) as Json).detail ?? 'Abruf fehlgeschlagen'}`);
      const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') ?? '')?.[1];
      const path = out ?? (name ? decodeURIComponent(name) : `anemo-${id}.zip`);
      const h = createHash('sha256');
      const counted = Readable.fromWeb(res.body as never).on('data', (c: Buffer) => h.update(c));
      await pipeline(counted, createWriteStream(path));
      const sum = h.digest('hex');
      const expected = res.headers.get('x-anemo-sha256');
      if (expected && expected !== sum) { await rm(path, { force: true }); throw new CliError('Prüfsumme stimmt nicht – Übertragung fehlerhaft, bitte erneut abrufen'); }
      io.log(`Gespeichert: ${path} (${mb((await stat(path)).size)}, SHA-256 ${sum})`);
      return path;
    };
    const summary = (r: Json) => {
      io.log(`${r.dryRun ? 'Probelauf' : 'Eingespielt'}: ${r.source?.key} → ${r.target?.key} (${r.mode === 'existing' ? 'bestehendes Projekt' : 'neues Projekt'})`);
      for (const [type, c] of Object.entries((r.changes ?? {}) as Record<string, Json>)) {
        if (c.created || c.updated || c.skipped) io.log(`  ${type.padEnd(22)} neu ${String(c.created).padStart(6)}  aktualisiert ${String(c.updated).padStart(6)}  unverändert ${String(c.skipped).padStart(6)}`);
      }
      const unmatched = (r.persons ?? []).filter((p: Json) => p.how === 'als Text');
      if (unmatched.length) io.log(`  Personen ohne Konto (als Text): ${unmatched.map((p: Json) => p.login).join(', ')}`);
      for (const c of r.conflicts ?? []) io.log(`  Konflikt: ${c}`);
      for (const w of r.warnings ?? []) io.log(`  Hinweis: ${w}`);
      for (const p of r.problems ?? []) io.error(`  Hinderungsgrund: ${p}`);
    };

    switch (command) {
      case 'status': {
        const rows = flags.get('id')
          ? [(await api('GET', '/api/project-transfers')).body.find?.((t: Json) => t.id === flags.get('id'))].filter(Boolean)
          : (await api('GET', '/api/project-transfers')).body as unknown as Json[];
        for (const t of rows as Json[]) {
          const p = t.progress ? ` – ${t.progress.phase}${t.progress.type ? ` ${t.progress.type}` : ''}${t.progress.done ? ` (${t.progress.done})` : ''}` : '';
          io.log(`${t.id}  ${t.direction === 'export' ? 'Export' : 'Import'}  ${t.projectKey}  ${t.status}${p}${t.error ? `  Fehler: ${t.error}` : ''}`);
        }
        return 0;
      }
      case 'download': {
        const id = flags.get('id');
        if (!id) throw new CliError('--id fehlt');
        await download(id, flags.get('out'));
        return 0;
      }
      case 'export': {
        const project = flags.get('project');
        if (!project) throw new CliError('--project fehlt');
        const selection = { testCases: list(flags.get('tests')), query: flags.get('query'), cycles: list(flags.get('cycles')), folders: list(flags.get('folders')) };
        const isSelection = Object.values(selection).some((v) => v !== undefined);
        const options = {
          ...(flags.has('versions') ? { versions: flags.get('versions') } : {}), executions: !flags.has('no-executions'), attachments: !flags.has('no-attachments'),
          comments: !flags.has('no-comments'), pseudonymize: flags.has('pseudonymize'),
        };
        const t = (await api('POST', `/api/projects/${encodeURIComponent(project)}/exports`, {
          scope: isSelection ? { kind: 'selection', ...selection } : { kind: 'complete' }, options, ...(flags.get('note') ? { note: flags.get('note') } : {}),
        })).body;
        io.log(`Export angefordert: ${t.id} (${t.status === 'pending' ? 'wartet auf Freigabe der Systemadministration' : 'wird erstellt'})`);
        for (;;) {
          const cur = ((await api('GET', '/api/project-transfers')).body as unknown as Json[]).find((x) => x.id === t.id);
          if (!cur) throw new CliError('Vorgang nicht gefunden');
          if (cur.status === 'rejected') throw new CliError(`Export abgelehnt${cur.decisionNote ? `: ${cur.decisionNote}` : ''}`);
          if (cur.status === 'failed') throw new CliError(`Export fehlgeschlagen: ${cur.error}`);
          if (cur.status === 'pending' && !flags.has('wait')) { io.log(`Nach der Freigabe abrufen: node tools/project-package.ts download --id ${t.id}`); return 2; }
          if (cur.status === 'ready' || cur.status === 'done') break;
          await sleep(cur.status === 'pending' ? 10_000 : 500);
        }
        await download(t.id, flags.get('out'));
        return 0;
      }
      case 'import': {
        const file = flags.get('file');
        if (!file) throw new CliError('--file fehlt');
        const existing = flags.get('into');
        const key = existing ?? flags.get('new');
        if (!key) throw new CliError('Ziel fehlt: --new KEY --name NAME oder --into KEY');
        if (!existing && !flags.get('name')) throw new CliError('--name fehlt (Name des neuen Projekts)');
        const extra = flags.get('options') ? JSON.parse(await readFile(flags.get('options')!, 'utf8')) as Json : {};
        const size = (await stat(file)).size;
        io.log(`Lade ${file} hoch (${mb(size)}) …`);
        const res = await fetch(`${base}/api/package-imports`, {
          method: 'POST', headers: { ...auth, 'content-type': 'application/zip', 'content-length': String(size) },
          body: Readable.toWeb(createReadStream(file)) as never, duplex: 'half',
        } as RequestInit);
        const up = (await res.json()) as Json;
        if (res.status !== 201) throw new CliError(`${res.status}: ${up.detail ?? 'Hochladen fehlgeschlagen'}`);
        const pkg = up.package as Json;
        io.log(`Paket: ${pkg.project.key} „${pkg.project.name}“ aus ${pkg.anemo.version}, exportiert ${pkg.exportedAt} von ${pkg.exportedBy}`);
        const options = {
          ...extra,
          target: existing ? { mode: 'existing', key, ...(flags.get('folder') ? { folderId: flags.get('folder') } : {}) } : { mode: 'new', key, name: flags.get('name') },
        };
        const preview = (await api('POST', `/api/package-imports/${up.transfer.id}/preview`, options)).body;
        summary(preview);
        if (preview.problems?.length) return 1;
        if (flags.has('dry-run')) {
          await api('DELETE', `/api/package-imports/${up.transfer.id}`);
          return 0;
        }
        const started = await api('POST', `/api/package-imports/${up.transfer.id}/apply?background=true`, options);
        if (started.status === 409) throw new CliError(started.body.detail);
        let last = '';
        for (;;) {
          await sleep(500);
          const cur = (await api('GET', `/api/package-imports/${up.transfer.id}`)).body;
          if (cur.status === 'running') {
            const p = cur.progress ? `${cur.progress.phase}${cur.progress.type ? ` ${cur.progress.type}` : ''}${cur.progress.done ? ` (${cur.progress.done})` : ''}` : '';
            if (p && p !== last) { io.log(`  … ${p}`); last = p; }
            continue;
          }
          if (cur.status === 'done') { summary(cur.report); return 0; }
          if (cur.report) summary(cur.report);
          throw new CliError(`Einspielen fehlgeschlagen: ${cur.error ?? cur.status}`);
        }
      }
      default:
        throw new CliError(`Unbekannter Befehl: ${command}\n${USAGE}`);
    }
  } catch (e) {
    io.error(e instanceof CliError ? e.message : `Fehler: ${(e as Error).message}`);
    return 1;
  }
}

const USAGE = `Projektpakete übertragen (Anemo)
  export   --project KEY [--out DATEI] [--wait] [--tests K1,K2] [--query ABFRAGE] [--cycles ID,ID] [--folders ID,ID]
           [--versions all|current] [--no-executions] [--no-attachments] [--no-comments] [--pseudonymize] [--note TEXT]
  download --id ID [--out DATEI]
  import   --file DATEI (--new KEY --name NAME | --into KEY [--folder ID]) [--options DATEI.json] [--dry-run]
  status   [--id ID]
Verbindung: --url/ANEMO_URL, --token/ANEMO_TOKEN`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
