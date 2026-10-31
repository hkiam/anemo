/**
 * Last- und Performancetest für Anemo – ohne Zusatzbibliotheken.
 *
 *   node tools/loadtest.ts --base http://localhost:8098 --db postgres://anemo:anemo@localhost:5433/anemo_last \
 *        --project DEMO --users 20 --duration 60 [--write] [--think 300-1500] [--out ergebnis.json]
 *
 * Virtuelle Benutzer arbeiten wie Testerinnen und Tester: Testfälle suchen und öffnen, Zyklen und Ausführungen
 * ansehen, Matrix/Cockpit/Berichte öffnen und – mit --write – Ergebnisse speichern (in einem eigens angelegten
 * Zyklus „Lasttest …“). Mit --db wird für den Lauf ein API-Token des Benutzers admin angelegt und danach entfernt
 * (nur gegen eine Testkopie der Datenbank verwenden!). Alternativ --token anemo_….
 */
import { connect } from '../server/src/platform/db.ts';
import { createApiToken } from '../server/src/modules/auth/service.ts';

const arg = (name: string, def?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? def : process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1] : 'true';
};
const BASE = arg('base', 'http://localhost:8098')!.replace(/\/+$/, '');
const PROJECT = arg('project', 'DEMO')!;
const USERS = Number(arg('users', '20'));
const DURATION = Number(arg('duration', '60')) * 1000;
const WRITE = arg('write') === 'true';
const [THINK_MIN, THINK_MAX] = (arg('think', '300-1500')!).split('-').map(Number) as [number, number];

let token = arg('token');
let cleanup = async () => {};
if (!token && arg('db')) {
  const db = connect(arg('db')!, { max: 1 });
  const [admin] = await db<{ id: string }[]>`select id from app_user where username = 'admin'`;
  if (!admin) throw new Error('Benutzer admin fehlt in der Datenbank');
  const t = await createApiToken(db, admin.id, `Lasttest ${new Date().toISOString()}`, 1);
  token = t.token;
  cleanup = async () => { await db`delete from api_token where id = ${t.id}`; await db.end(); };
}
if (!token) throw new Error('--token oder --db angeben');

const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const stats = new Map<string, number[]>();
const errors = new Map<string, number>();
const errorSamples: string[] = [];
async function call<T = any>(name: string, method: string, path: string, body?: unknown): Promise<T | null> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    const ms = performance.now() - t0;
    (stats.get(name) ?? stats.set(name, []).get(name)!).push(ms);
    if (!res.ok) {
      errors.set(name, (errors.get(name) ?? 0) + 1);
      if (errorSamples.length < 10) errorSamples.push(`${name} ${res.status} ${text.slice(0, 120)}`);
      return null;
    }
    return (res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T;
  } catch (e) {
    errors.set(name, (errors.get(name) ?? 0) + 1);
    if (errorSamples.length < 10) errorSamples.push(`${name} ${(e as Error).message}`);
    return null;
  }
}
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Daten für realistische Zugriffe ermitteln ----
const P = encodeURIComponent(PROJECT);
const tcs = (await call<{ items: { key: string }[] }>('setup', 'GET', `/api/projects/${P}/test-cases?limit=500`))?.items ?? [];
const cycles = (await call<{ items: { id: string }[] }>('setup', 'GET', `/api/projects/${P}/cycles?limit=200`))?.items ?? [];
const plans = (await call<{ id: string }[]>('setup', 'GET', `/api/projects/${P}/plans`)) ?? [];
const execs: string[] = [];
for (const c of cycles.slice(0, 30)) {
  const e = await call<{ items: { id: string }[] }>('setup', 'GET', `/api/cycles/${c.id}/executions?limit=50`);
  execs.push(...(e?.items ?? []).map((x) => x.id));
}
const WORDS = ['Akte', 'Dokument', 'Suche', 'Vorgang', 'Export', 'Druck', 'Benutzer', 'Rechte', 'PDF', 'Mail', 'Ablage', 'Workflow'];
if (!tcs.length || !cycles.length) throw new Error(`Projekt ${PROJECT}: keine Testfälle oder Zyklen gefunden`);

let writeExecs: string[] = [];
let writeCycle: string | null = null;
if (WRITE) {
  const c = await call<{ id: string }>('setup', 'POST', `/api/projects/${P}/cycles`, { name: `Lasttest ${new Date().toISOString().slice(0, 16)}` });
  writeCycle = c?.id ?? null;
  await call('setup', 'POST', `/api/cycles/${writeCycle}/executions`, { testCaseIds: tcs.slice(0, 100).map((t) => t.key) });
  writeExecs = ((await call<{ items: { id: string }[] }>('setup', 'GET', `/api/cycles/${writeCycle}/executions?limit=200`))?.items ?? []).map((x) => x.id);
}
stats.delete('setup');
errors.delete('setup');
console.log(`Lasttest gegen ${BASE}, Projekt ${PROJECT}: ${tcs.length} Testfälle, ${cycles.length} Zyklen, ${execs.length} Ausführungen; ${USERS} Benutzer, ${DURATION / 1000} s, Denkzeit ${THINK_MIN}–${THINK_MAX} ms${WRITE ? ', mit Schreibzugriffen' : ''}`);

// ---- Benutzerverhalten (gewichtete Aktionen) ----
const actions: [number, () => Promise<unknown>][] = [
  [14, () => call('Testfallliste (Suche)', 'GET', `/api/projects/${P}/test-cases?limit=50&q=${encodeURIComponent(pick(WORDS))}`)],
  [14, () => call('Testfall öffnen', 'GET', `/api/test-cases/${encodeURIComponent(pick(tcs).key)}`)],
  [8, () => call('Übergreifende Suche', 'GET', `/api/search?q=${encodeURIComponent(pick(WORDS))}`)],
  [8, () => call('Zyklenliste', 'GET', `/api/projects/${P}/cycles?limit=50`)],
  [14, () => call('Ausführungen eines Zyklus', 'GET', `/api/cycles/${pick(cycles).id}/executions?limit=50`)],
  [10, () => call('Ausführung öffnen', 'GET', `/api/executions/${pick(execs)}`)],
  [5, () => plans.length ? call('Ergebnis-Matrix', 'GET', `/api/plans/${pick(plans).id}/matrix`) : Promise.resolve()],
  [4, () => plans.length ? call('Release-Cockpit', 'GET', `/api/plans/${pick(plans).id}/cockpit`) : Promise.resolve()],
  [3, () => call('Testprotokoll (Bericht)', 'GET', `/api/reports/test-log/${pick(cycles).id}`)],
  [2, () => call('Duplikatanalyse', 'GET', `/api/projects/${P}/assist/similar`)],
  ...(WRITE ? [[12, () => call('Ergebnis speichern', 'POST', `/api/executions/${pick(writeExecs)}/result`, { status: pick(['PASS', 'PASS', 'PASS', 'FAIL', 'WIP']), comment: 'Lasttest', stepResults: [] })]] as [number, () => Promise<unknown>][] : []),
];
const total = actions.reduce((a, [w]) => a + w, 0);
const choose = () => { let r = Math.random() * total; for (const [w, f] of actions) { if ((r -= w) < 0) return f; } return actions[0]![1]; };

const end = Date.now() + DURATION;
const started = Date.now();
await Promise.all(Array.from({ length: USERS }, async (_, i) => {
  await sleep((i * 1000) / USERS); // Hochlauf über eine Sekunde
  while (Date.now() < end) {
    await choose()();
    if (THINK_MAX > 0) await sleep(THINK_MIN + Math.random() * (THINK_MAX - THINK_MIN));
  }
}));
const seconds = (Date.now() - started) / 1000;

// ---- Auswertung ----
const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]!;
const rows = [...stats.entries()].map(([name, a]) => {
  a.sort((x, y) => x - y);
  return { name, n: a.length, err: errors.get(name) ?? 0, p50: q(a, 50), p95: q(a, 95), p99: q(a, 99), max: a.at(-1)! };
}).sort((x, y) => y.p95 - x.p95);
const all = [...stats.values()].flat().sort((x, y) => x - y);
const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
console.log(`\n| Aktion | Anzahl | Fehler | p50 | p95 | p99 | max |\n|---|---:|---:|---:|---:|---:|---:|`);
for (const r of rows) console.log(`| ${r.name} | ${r.n} | ${r.err} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${fmt(r.max)} |`);
console.log(`| **gesamt** | ${all.length} | ${[...errors.values()].reduce((a, b) => a + b, 0)} | ${fmt(q(all, 50))} | ${fmt(q(all, 95))} | ${fmt(q(all, 99))} | ${fmt(all.at(-1) ?? 0)} |`);
console.log(`\nDurchsatz: ${(all.length / seconds).toFixed(1)} Anfragen/s über ${seconds.toFixed(0)} s`);
if (errorSamples.length) console.log(`Fehlerbeispiele:\n  ${errorSamples.join('\n  ')}`);
const out = arg('out');
if (out) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(out, JSON.stringify({ base: BASE, project: PROJECT, users: USERS, seconds, write: WRITE, rows, total: all.length, errors: Object.fromEntries(errors) }, null, 2));
}
if (writeCycle) console.log(`Schreibzugriffe im Zyklus ${writeCycle} (Testkopie).`);
await cleanup();
