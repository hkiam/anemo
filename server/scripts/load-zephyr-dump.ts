/**
 * Lädt einen mit tools/windows/export-zephyr.ps1 erzeugten Zephyr-Dump in die lokale MariaDB
 * (Compose-Service `zephyr-db`) und weist nach, dass nichts verloren ging:
 *   1. SHA-256 der .sql.gz-Datei == Manifest
 *   2. Datenbank wird frisch angelegt und der Dump gestreamt eingespielt (keine entpackte Zwischendatei)
 *   3. exakte Zeilenzahl jeder Tabelle == Manifest
 *
 *   npm run zephyr:load -- --manifest migration-snapshots/zephyr-dump-<stamp>.manifest.json
 *   npm run zephyr:load -- --dump altsystem/zephyr-dump.zip        (.sql, .sql.gz oder .zip; ohne Manifest)
 *
 * Zusätzlich werden die Zeilen beim Einspielen direkt im Dump-Strom gezählt (unabhängiger Nachweis:
 * Quelle-DB → Dump → geladene DB). Ergebnis: <dump>.load.json, Exit-Code 1 bei Abweichungen.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createGunzip } from 'node:zlib';

interface DumpManifest {
  format: string;
  createdAt: string;
  mysqlVersion: string;
  database: string;
  dumpFile: string;
  dumpBytes: number;
  dumpSha256: string;
  totalRows: number;
  tables: Record<string, number>;
  attachments?: {
    expected: number; found: number; exact?: number; heuristic?: number; archiveFile: string | null; archiveSha256: string | null;
    missing: { id: string; fileName: string; reason: string }[];
  } | null;
}

const ROOT = new URL('../../', import.meta.url).pathname;
const { values } = parseArgs({ options: { manifest: { type: 'string' }, dump: { type: 'string' }, database: { type: 'string', default: 'zephyr' } } });
if (!values.manifest === !values.dump) {
  console.error('Aufruf: npm run zephyr:load -- --manifest <….manifest.json>   oder   --dump <….sql|.sql.gz|.zip>');
  process.exit(2);
}
const db = values.database!;
if (!/^\w+$/.test(db)) throw new Error('Ungültiger Datenbankname');

function run(cmd: string, args: string[], opts: { input?: NodeJS.ReadableStream; capture?: boolean } = {}): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: [opts.input ? 'pipe' : 'ignore', opts.capture ? 'pipe' : 'inherit', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (err += d));
    if (opts.input) pipeline(opts.input, p.stdin!).catch(fail);
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok(out) : fail(new Error(`${cmd} ${args.slice(0, 4).join(' ')} … → Exit ${code}\n${err}`))));
  });
}

const mariadb = (sql: string, database = db) =>
  run('docker', ['compose', '--profile', 'zephyr', 'exec', '-T', 'zephyr-db', 'mariadb', '-uroot', '-pzephyr', '--batch', '--skip-column-names', '-e', sql, database], { capture: true });

/**
 * Zählt Datenzeilen in mysqldump-Ausgabe ("INSERT INTO `t` VALUES (…),(…);") direkt im Datenstrom,
 * inkl. korrekter Behandlung von Zeichenketten mit Klammern, Escapes und Zeilenumbrüchen.
 */
class RowCounter extends Transform {
  readonly rows = new Map<string, number>();
  private state: 'line' | 'header' | 'values' | 'skip' = 'line';
  private head = '';
  private table = '';
  private depth = 0;
  private quote = 0; // 0 oder Code des öffnenden Anführungszeichens
  private escape = false;

  override _transform(chunk: Buffer, _enc: string, done: () => void) {
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]!;
      switch (this.state) {
        case 'line':
          this.head = String.fromCharCode(b);
          this.state = b === 10 ? 'line' : 'header';
          break;
        case 'header':
          if (b === 10) {
            // MariaDB-Dumps brechen nach "VALUES" um, MySQL 5.5 nicht – beides zulassen.
            if (!this.startValues(/^INSERT INTO `([^`]+)` VALUES\s*$/)) {
              this.noteCreate();
              this.state = 'line';
            }
          } else if (this.head.length < 200) {
            this.head += String.fromCharCode(b);
            this.startValues(/^INSERT INTO `([^`]+)` VALUES $/);
          } else {
            this.state = 'skip';
          }
          break;
        case 'skip':
          if (b === 10) this.state = 'line';
          break;
        case 'values':
          if (this.quote) {
            if (this.escape) this.escape = false;
            else if (b === 92) this.escape = true; // Backslash
            else if (b === this.quote) this.quote = 0;
          } else if (b === 39 || b === 34) this.quote = b;
          else if (b === 40) {
            if (this.depth++ === 0) this.rows.set(this.table, (this.rows.get(this.table) ?? 0) + 1);
          } else if (b === 41) this.depth--;
          else if (b === 59 && this.depth === 0) this.state = 'skip';
          break;
      }
    }
    done();
    this.push(chunk);
  }

  private startValues(re: RegExp): boolean {
    const m = re.exec(this.head);
    if (!m) return false;
    this.table = m[1]!;
    this.depth = 0;
    this.state = 'values';
    return true;
  }

  private noteCreate() {
    const m = /^CREATE TABLE `([^`]+)`/.exec(this.head);
    if (m && !this.rows.has(m[1]!)) this.rows.set(m[1]!, 0);
  }
}

function openDump(path: string): NodeJS.ReadableStream {
  if (path.endsWith('.zip')) {
    const p = spawn('unzip', ['-p', path], { stdio: ['ignore', 'pipe', 'inherit'] });
    return p.stdout;
  }
  const file = createReadStream(path);
  return path.endsWith('.gz') ? file.pipe(createGunzip()) : file;
}

const manifestPath = values.manifest ? resolve(process.cwd(), values.manifest) : null;
const manifest = manifestPath ? (JSON.parse(await readFile(manifestPath, 'utf8')) as DumpManifest) : null;
if (manifest && manifest.format !== 'anemo-zephyr-db-dump/1') throw new Error(`Unbekanntes Format: ${manifest.format}`);
const dumpPath = manifest ? join(dirname(manifestPath!), manifest.dumpFile) : resolve(process.cwd(), values.dump!);
const started = Date.now();

if (manifest) {
  console.log(`1/4 Prüfsumme ${manifest.dumpFile} (${(manifest.dumpBytes / 1048576).toFixed(1)} MB) …`);
  const hash = createHash('sha256');
  await pipeline(createReadStream(dumpPath), hash);
  const sha = hash.digest('hex');
  if (sha !== manifest.dumpSha256) throw new Error(`SHA-256 stimmt nicht: Datei ${sha}, Manifest ${manifest.dumpSha256} – Übertragung beschädigt?`);
} else {
  console.log('1/4 Kein Manifest – Prüfung erfolgt über die im Dump gezählten Zeilen.');
}

console.log('2/4 Starte lokale MariaDB (zephyr-db) …');
await run('docker', ['compose', '--profile', 'zephyr', 'up', '-d', '--wait', 'zephyr-db']);
await mariadb(`DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4`, 'mysql');

console.log(`3/4 Spiele ${dumpPath} ein (gestreamt) …`);
const counter = new RowCounter();
await run('docker', ['compose', '--profile', 'zephyr', 'exec', '-T', 'zephyr-db', 'mariadb', '-uroot', '-pzephyr', '--default-character-set=utf8', db],
  { input: openDump(dumpPath).pipe(counter) });

// Anhänge: ZIP-Prüfsumme und Anzahl der Dateien gegen das Manifest
let attachmentCheck: { expected: number; found: number; inArchive: number; missing: number; ok: boolean } | null = null;
if (manifest?.attachments) {
  const a = manifest.attachments;
  let inArchive = 0;
  if (a.archiveFile) {
    const archivePath = join(dirname(manifestPath!), a.archiveFile);
    const h = createHash('sha256');
    await pipeline(createReadStream(archivePath), h);
    if (h.digest('hex') !== a.archiveSha256) throw new Error(`SHA-256 von ${a.archiveFile} stimmt nicht – Übertragung beschädigt?`);
    inArchive = (await run('tar', ['-tzf', archivePath], { capture: true })).split('\n').filter((l) => l.startsWith('attachments/')).length;
  }
  attachmentCheck = { expected: a.expected, found: a.found, inArchive, missing: a.missing.length, ok: a.missing.length === 0 && inArchive === a.found && a.found === a.expected };
  if (a.heuristic) console.log(`Hinweis: ${a.heuristic} Anhänge nicht am Zephyr-Ablageort, sondern per Rückfallsuche zugeordnet (index.json: match = heuristic) – bitte stichprobenartig prüfen.`);
  console.log(`Anhänge: ${inArchive}/${a.expected} im Archiv${a.missing.length ? ` – ${a.missing.length} fehlen: ${a.missing.slice(0, 5).map((m) => `${m.id} ${m.fileName} (${m.reason})`).join(', ')}` : ''}`);
}

console.log('4/4 Vergleiche Zeilenzahlen …');
const tables = [...new Set([...Object.keys(manifest?.tables ?? {}), ...counter.rows.keys()])].sort();
const sql = tables.map((t) => `SELECT '${t}', COUNT(*) FROM \`${t}\``).join(' UNION ALL ');
const actual = new Map((await mariadb(sql)).trim().split('\n').filter(Boolean).map((l) => {
  const [t, n] = l.split('\t');
  return [t!, Number(n)] as const;
}));
const rows = tables.map((t) => ({
  tabelle: t,
  ...(manifest ? { quelle: manifest.tables[t] ?? -1 } : {}),
  dump: counter.rows.get(t) ?? -1,
  geladen: actual.get(t) ?? -1,
}));
const mismatches = rows.filter((r) => r.dump !== r.geladen || ('quelle' in r && r.quelle !== r.dump));
console.table(rows.map((r) => ({ ...r, ok: mismatches.includes(r) ? '✘' : '✔' })));

const totalLoaded = rows.reduce((a, r) => a + Math.max(r.geladen, 0), 0);
const result = {
  dump: dumpPath.split('/').pop(),
  loadedAt: new Date().toISOString(),
  durationSeconds: Math.round((Date.now() - started) / 100) / 10,
  database: db,
  sha256Verified: !!manifest,
  totalRowsSource: manifest?.totalRows ?? null,
  totalRowsDump: [...counter.rows.values()].reduce((a, b) => a + b, 0),
  totalRowsLoaded: totalLoaded,
  tables: rows,
  attachments: attachmentCheck,
  mismatches,
  verdict: mismatches.length === 0 && (attachmentCheck?.ok ?? true) ? 'PASSED' : 'FAILED',
};
await writeFile(dumpPath.replace(/(\.manifest\.json|\.sql\.gz|\.sql|\.zip)$/, '') + '.load.json', JSON.stringify(result, null, 2));
console.log(`\nErgebnis: ${result.verdict} – ${result.totalRowsLoaded} Zeilen geladen (Dump: ${result.totalRowsDump}${manifest ? `, Quelle: ${manifest.totalRows}` : ''}), ${result.durationSeconds} s`);
process.exitCode = result.verdict === 'PASSED' ? 0 : 1;
