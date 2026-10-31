import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openZip } from '../src/platform/zip.ts';
import { CATALOG_TABLES, NOT_EXPORTED, TYPES } from '../src/modules/transfer/index.ts';
import { type TestEnv, testEnv } from './helpers.ts';

const PW = 'Sicheres-Passwort-1';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Paket in eine Datei schreiben und öffnen */
async function readPackage(dir: string, body: Buffer) {
  const path = join(dir, `${sha(body).slice(0, 12)}.zip`);
  await writeFile(path, body);
  const z = await openZip(path);
  const text = async (name: string) => (await z.read(name)).toString('utf8');
  const ndjson = async (name: string) => (await text(name)).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { z, text, ndjson, json: async (name: string) => JSON.parse(await text(name)) };
}

/** Beispielprojekt PK mit allen Objektarten (dazu XX als fremdes Projekt) */
async function seedProject(env: TestEnv): Promise<Record<string, string>> {
  const call = env.call;
  const ids: Record<string, string> = {};
    await call('POST', '/api/projects', { key: 'PK', name: 'Paket' });
    await call('POST', '/api/projects', { key: 'XX', name: 'Fremd' });
    await call('POST', '/api/admin/fields', { scope: 'test_case', key: 'Team', name: 'Team', type: 'select', options: ['Alpha', 'Beta'] });
    await call('POST', '/api/admin/fields', { scope: 'test_case', key: 'Unbenutzt', name: 'Unbenutzt', type: 'text' });
    ids.folder = (await call('POST', '/api/projects/PK/folders', { name: 'Akten' })).body.id;
    ids.subfolder = (await call('POST', '/api/projects/PK/folders', { name: 'Eingang', parentId: ids.folder })).body.id;
    ids.pre = (await call('POST', '/api/projects/PK/preconditions', { title: 'Angemeldet', content: 'Als Sachbearbeitung angemeldet' })).body.id;
    ids.callee = (await call('POST', '/api/projects/PK/test-cases', { content: { title: 'Anmelden', steps: [{ action: 'Login', expected: 'Start' }] } })).body.id;
    const content = { title: 'Akte öffnen', priority: 'Kritisch', customFields: { Team: 'Alpha' }, preconditionIds: [ids.pre],
      steps: [{ action: '', expected: '', call: { testCaseId: ids.callee } }, { action: 'Akte öffnen', expected: 'Akte sichtbar' }] };
    const created = await call('POST', '/api/projects/PK/test-cases', { folderId: ids.folder, content });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    ids.tc = created.body.id;
    assert.equal((await call('PUT', `/api/test-cases/${ids.tc}/content`, { expectedVersion: 1, changeNote: 'Version 2', content: { ...content, title: 'Akte öffnen (neu)' } })).status, 200);
    await call('POST', '/api/projects/XX/test-cases', { content: { title: 'Gehört nicht dazu', steps: [] } });
    const comment = (await call('POST', '/api/comments', { ownerType: 'TEST_CASE', ownerId: ids.tc, body: 'Bitte prüfen' })).body;
    await call('POST', '/api/comments', { ownerType: 'TEST_CASE', ownerId: ids.tc, body: 'Erledigt, siehe PK-T1', parentId: comment.id });
    await call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: ids.tc, externalKey: 'REQ-1', provider: 'jira', relation: 'REQUIREMENT' });
    await call('POST', '/api/attachments/base64', { ownerType: 'TEST_CASE', ownerId: ids.tc, fileName: 'bild.png', contentType: 'image/png', contentBase64: Buffer.from('PNG-Inhalt').toString('base64') });
    await call('POST', '/api/attachments/base64', { ownerType: 'TEST_CASE', ownerId: ids.callee, fileName: 'kopie.png', contentType: 'image/png', contentBase64: Buffer.from('PNG-Inhalt').toString('base64') });
    const plan = (await call('POST', '/api/projects/PK/plans', { name: 'Release 1' })).body;
    const cycle = (await call('POST', '/api/projects/PK/cycles', { name: 'Lauf 1', planId: plan.id, configuration: { device: ['iPad'] } })).body;
    ids.cycle = cycle.id;
    ids.plan = plan.id;
    await call('POST', `/api/cycles/${cycle.id}/executions`, { testCaseIds: ['PK-T2'] });
    const ex = (await call('GET', `/api/cycles/${cycle.id}/executions`)).body.items[0];
    await call('POST', `/api/executions/${ex.id}/result`, { status: 'PASS' });
    await call('POST', `/api/cycles/${cycle.id}/sessions`, { charter: 'Akten erkunden' });
    await call('POST', '/api/projects/PK/test-sets', { name: 'Smoke', kind: 'static', testCaseIds: [ids.tc] });
    await call('POST', '/api/projects/PK/views', { page: 'repo', name: 'Meine', query: 'priority = Kritisch', shared: true });
    await call('POST', '/api/admin/webhooks', { name: 'Chat', url: 'https://chat.example/hook', format: 'json', eventTypes: ['TestFailed'], projectKey: 'PK', active: true });

  return ids;
}

/** Export anfordern und abrufen (Modus off: jede Person ist Systemadministration) */
async function exportBytes(env: TestEnv, key: string): Promise<Buffer> {
  const t = (await env.call('POST', `/api/projects/${key}/exports`, {})).body;
  const res = await env.app.request(`/api/project-transfers/${t.id}/download`, { headers: { 'x-anemo-user': 'tester' } });
  assert.equal(res.status, 200);
  return Buffer.from(await res.arrayBuffer());
}

describe('Projektpaket: Format deckt das Datenbankschema ab (Stufe K1)', () => {
  let env: TestEnv;
  before(async () => { env = await testEnv(); });
  after(() => env.close());

  it('jede Tabelle ist Objektart, Katalog oder ausdrücklich ausgeschlossen', async () => {
    const tables = (await env.db<{ tableName: string }[]>`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`).map((r) => r.tableName);
    const known = new Set([...TYPES.map((t) => t.table), ...CATALOG_TABLES, ...Object.keys(NOT_EXPORTED)]);
    assert.deepEqual(tables.filter((t) => !known.has(t)).sort(), [], 'neue Tabelle: in transfer/format.ts als Objektart, Katalog oder NOT_EXPORTED eintragen');
    assert.deepEqual([...known].filter((t) => !tables.includes(t)).sort(), [], 'Beschreibung nennt Tabellen, die es nicht gibt');
  });

  it('jede Spalte ist übertragen oder mit Grund ausgelassen, jede ID-Spalte hat einen Bezug', async () => {
    const cols = await env.db<{ tableName: string; columnName: string; dataType: string; udtName: string }[]>`
      select table_name, column_name, data_type, udt_name from information_schema.columns where table_schema = 'public'`;
    const problems: string[] = [];
    for (const t of TYPES) {
      const actual = cols.filter((c) => c.tableName === t.table);
      const described = new Set([...t.columns, ...Object.keys(t.omitted)]);
      for (const c of actual) if (!described.has(c.columnName)) problems.push(`${t.table}.${c.columnName}: weder übertragen noch ausgelassen`);
      for (const c of described) if (!actual.some((a) => a.columnName === c)) problems.push(`${t.table}.${c}: gibt es nicht`);
      for (const c of t.columns) if (c in t.omitted) problems.push(`${t.table}.${c}: zugleich übertragen und ausgelassen`);
      for (const c of actual) {
        const isId = c.udtName === 'uuid' || c.udtName === '_uuid';
        if (isId && c.columnName !== 'id' && t.columns.includes(c.columnName) && !t.refs.some((r) => r.column === c.columnName)) {
          problems.push(`${t.table}.${c.columnName}: ID-Spalte ohne Bezug (refs)`);
        }
      }
      for (const p of t.persons) if (!t.columns.includes(p)) problems.push(`${t.table}.${p}: Personenspalte wird nicht übertragen`);
    }
    assert.deepEqual(problems, []);
  });
});

describe('Projektpaket: Recht „Projekte übertragen“ und Freigabe (Modus on)', () => {
  let env: TestEnv;
  let dir: string;
  const cookies = new Map<string, string>();
  const req = async (user: string, method: string, path: string, body?: unknown) => {
    const res = await env.app.request(path, { method, headers: { 'content-type': 'application/json', host: 'anemo.test', cookie: cookies.get(user) ?? '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const buf = Buffer.from(await res.arrayBuffer());
    const isJson = res.headers.get('content-type')?.includes('json');
    return { status: res.status, body: isJson && buf.length ? JSON.parse(buf.toString()) : null, raw: buf, headers: res.headers, setCookie: res.headers.get('set-cookie') };
  };
  const login = async (u: string) => cookies.set(u, (await req('', 'POST', '/api/auth/login', { username: u, password: PW })).setCookie!.split(';')[0]!);
  const uid: Record<string, string> = {};
  let groupId = '';

  before(async () => {
    env = await testEnv({ authMode: 'on' });
    dir = await mkdtemp(join(tmpdir(), 'anemo-transfer-'));
    process.env.ANEMO_TRANSFER_DIR = dir;
    process.env.ANEMO_ADMIN_PASSWORD = PW;
    const { bootstrapAdmin } = await import('../src/modules/auth/index.ts');
    await bootstrapAdmin(env.db, '/dev/null', () => {});
    delete process.env.ANEMO_ADMIN_PASSWORD;
    await login('admin');
    for (const u of ['pia', 'paul', 'tess']) { uid[u] = (await req('admin', 'POST', '/api/admin/users', { username: u, displayName: u, password: PW })).body.id; await login(u); }
    groupId = (await req('admin', 'POST', '/api/admin/groups', { name: 'Übertragung' })).body.id;
    await req('admin', 'PUT', `/api/admin/groups/${groupId}`, { memberIds: [uid.paul, uid.tess] });
    for (const key of ['OFF', 'GEH']) {
      await req('admin', 'POST', '/api/projects', { key, name: key });
      for (const [u, role] of [['pia', 'PROJECT_ADMIN'], ['paul', 'PROJECT_ADMIN'], ['tess', 'TESTER']] as const) {
        await req('admin', 'PUT', `/api/projects/${key}/members`, { principalType: 'user', principalId: uid[u], role });
      }
      await req('admin', 'POST', `/api/projects/${key}/test-cases`, { content: { title: `Fall in ${key}`, steps: [{ action: 'a', expected: 'b' }] } });
    }
    await req('admin', 'PUT', '/api/projects/GEH/visibility', { visibility: 'restricted' });
  });
  after(async () => { delete process.env.ANEMO_TRANSFER_DIR; await env.close(); await rm(dir, { recursive: true, force: true }); });

  it('ohne das Recht kein Export – auch nicht für die Projektadministration', async () => {
    const r = await req('pia', 'POST', '/api/projects/OFF/exports', {});
    assert.equal(r.status, 403);
    assert.match(r.body.detail, /Projekte übertragen/);
    assert.deepEqual((await req('pia', 'GET', '/api/auth/me')).body.permissions, []);
  });

  it('Vergabe nur durch die Systemadministration, auch an Gruppen; protokolliert', async () => {
    assert.equal((await req('pia', 'PUT', '/api/admin/permissions', { principalType: 'user', principalId: uid.pia, permission: 'PROJECT_TRANSFER', granted: true })).status, 403);
    assert.equal((await req('admin', 'PUT', '/api/admin/permissions', { principalType: 'group', principalId: groupId, permission: 'PROJECT_TRANSFER', granted: true })).status, 204);
    const list = (await req('admin', 'GET', '/api/admin/permissions')).body;
    assert.deepEqual(list.permissions, ['PROJECT_TRANSFER']);
    assert.equal(list.grants.length, 1);
    assert.equal(list.grants[0].name, 'Übertragung');
    assert.deepEqual((await req('paul', 'GET', '/api/auth/me')).body.permissions, ['PROJECT_TRANSFER']);
    assert.deepEqual((await req('admin', 'GET', '/api/auth/me')).body.permissions, ['PROJECT_TRANSFER'], 'Systemadministration implizit');
    const [ev] = await env.db`select payload from domain_event where type = 'PermissionChanged'`;
    assert.equal(ev!.payload.granted, true);
  });

  it('Recht allein genügt nicht: Projektadministration im Projekt ist nötig', async () => {
    assert.equal((await req('tess', 'POST', '/api/projects/OFF/exports', {})).status, 403);
  });

  it('nicht sensibles Projekt: sofort abrufbar, nur durch die anfordernde Person; Prüfsumme und Zählung im Protokoll', async () => {
    const t = (await req('paul', 'POST', '/api/projects/OFF/exports', {})).body;
    assert.equal(t.status, 'approved');
    assert.equal(t.sensitive, false);
    assert.ok(new Date(t.expiresAt).getTime() > Date.now() + 23 * 3600_000);
    assert.equal((await req('pia', 'GET', `/api/project-transfers/${t.id}/download`)).status, 404, 'fremder Antrag');
    const d = await req('paul', 'GET', `/api/project-transfers/${t.id}/download`);
    assert.equal(d.status, 200);
    assert.match(d.headers.get('content-disposition')!, /Projekt-OFF-.*\.anemo\.zip/);
    assert.equal(d.headers.get('x-anemo-sha256'), sha(d.raw));
    const pkg = await readPackage(dir, d.raw);
    try {
      assert.equal((await pkg.json('project.json')).key, 'OFF');
      assert.equal((await pkg.ndjson('test-cases.ndjson')).length, 1);
    } finally { await pkg.z.close(); }
    const [row] = await env.db`select * from project_transfer where id = ${t.id}`;
    assert.equal(row!.status, 'done');
    assert.equal(row!.downloads, 1);
    assert.equal(row!.packageSha256, sha(d.raw));
    assert.equal(Number(row!.packageBytes), d.raw.length);
    assert.equal(row!.counts['test-cases'], 1);
    assert.deepEqual((await req('paul', 'GET', '/api/project-transfers')).body.map((x: any) => x.id), [t.id]);
    assert.equal((await env.db`select count(*)::int as n from domain_event where type = 'ProjectExported'`)[0]!.n, 1);
  });

  it('sensibles Projekt: wartet auf Freigabe; Ablehnung und Freigabe durch die Systemadministration', async () => {
    const a = (await req('paul', 'POST', '/api/projects/GEH/exports', { note: 'Umzug in den Betrieb' })).body;
    assert.equal(a.status, 'pending');
    assert.equal(a.sensitive, true);
    assert.equal((await req('paul', 'GET', `/api/project-transfers/${a.id}/download`)).status, 409);
    assert.equal((await req('paul', 'POST', `/api/admin/project-transfers/${a.id}/decision`, { approve: true })).status, 403, 'keine Selbstfreigabe ohne Admin');
    const pending = (await req('admin', 'GET', '/api/admin/project-transfers?status=pending')).body;
    assert.deepEqual(pending.map((x: any) => x.id), [a.id]);
    assert.equal(pending[0].options.note, 'Umzug in den Betrieb');
    const rejected = (await req('admin', 'POST', `/api/admin/project-transfers/${a.id}/decision`, { approve: false, note: 'nicht ohne Auftrag' })).body;
    assert.equal(rejected.status, 'rejected');
    const denied = await req('paul', 'GET', `/api/project-transfers/${a.id}/download`);
    assert.equal(denied.status, 403);
    assert.match(denied.body.detail, /nicht ohne Auftrag/);
    assert.equal((await req('admin', 'POST', `/api/admin/project-transfers/${a.id}/decision`, { approve: true })).status, 409, 'nur einmal entscheiden');

    const b = (await req('paul', 'POST', '/api/projects/GEH/exports', {})).body;
    const ok = (await req('admin', 'POST', `/api/admin/project-transfers/${b.id}/decision`, { approve: true })).body;
    assert.equal(ok.status, 'approved');
    assert.equal(ok.decidedBy, 'admin');
    assert.equal((await req('paul', 'GET', `/api/project-transfers/${b.id}/download`)).status, 200);
    assert.equal((await req('paul', 'GET', `/api/project-transfers/${b.id}/download`)).status, 200, 'innerhalb der Frist erneut abrufbar');
    assert.equal((await env.db`select downloads from project_transfer where id = ${b.id}`)[0]!.downloads, 2);
  });

  it('Systemadministration: eigener Export eines sensiblen Projekts ist zugleich freigegeben', async () => {
    const t = (await req('admin', 'POST', '/api/projects/GEH/exports', {})).body;
    assert.equal(t.status, 'approved');
    assert.equal(t.decidedBy, 'admin');
  });

  it('beim Abruf zählt der aktuelle Stand: abgelaufen, Recht entzogen, Projekt inzwischen eingeschränkt', async () => {
    const t = (await req('paul', 'POST', '/api/projects/OFF/exports', {})).body;
    await env.db`update project_transfer set expires_at = now() - interval '1 minute' where id = ${t.id}`;
    assert.equal((await req('paul', 'GET', `/api/project-transfers/${t.id}/download`)).status, 410);

    const u = (await req('paul', 'POST', '/api/projects/OFF/exports', {})).body;
    await req('admin', 'PUT', '/api/projects/OFF/external-services', { externalServices: 'blocked' });
    assert.equal((await req('paul', 'GET', `/api/project-transfers/${u.id}/download`)).status, 409);
    await req('admin', 'PUT', '/api/projects/OFF/external-services', { externalServices: 'allowed' });

    assert.equal((await req('admin', 'PUT', '/api/admin/permissions', { principalType: 'group', principalId: groupId, permission: 'PROJECT_TRANSFER', granted: false })).status, 204);
    assert.equal((await req('paul', 'GET', `/api/project-transfers/${u.id}/download`)).status, 403);
    assert.equal((await req('paul', 'POST', '/api/projects/OFF/exports', {})).status, 403);
  });
});

describe('Projektpaket: Inhalt eines kompletten Exports (Stufe K1)', () => {
  let env: TestEnv;
  let dir: string;
  let pkg: Awaited<ReturnType<typeof readPackage>>;
  const ids: Record<string, string> = {};

  before(async () => {
    env = await testEnv();
    dir = await mkdtemp(join(tmpdir(), 'anemo-transfer-'));
    process.env.ANEMO_TRANSFER_DIR = dir;
    Object.assign(ids, await seedProject(env));
    pkg = await readPackage(dir, await exportBytes(env, 'PK'));
  });
  after(async () => { await pkg?.z.close(); delete process.env.ANEMO_TRANSFER_DIR; await env.close(); await rm(dir, { recursive: true, force: true }); });

  it('Manifest: Format, Herkunft, Zählung; Prüfsummen aller Dateien stimmen', async () => {
    const m = await pkg.json('manifest.json');
    assert.equal(m.format, 'anemo-project');
    assert.equal(m.formatVersion, '1.3.0');
    assert.match(m.sourceInstance, /^[0-9a-f-]{36}$/);
    assert.equal(m.project.key, 'PK');
    assert.equal(m.scope.kind, 'complete');
    assert.equal(m.counts['test-cases'], 2);
    assert.equal(m.counts['test-case-versions'], 3);
    assert.equal(m.counts.files, 1, 'gleicher Inhalt nur einmal');
    assert.deepEqual(m.warnings, []);
    for (const f of m.files) {
      const b = await pkg.z.read(f.path);
      assert.equal(sha(b), f.sha256, f.path);
      assert.equal(b.length, f.size, f.path);
    }
    const listed = new Set(m.files.map((f: any) => f.path));
    for (const name of pkg.z.entries.keys()) if (!['manifest.json', 'manifest.sha256'].includes(name)) assert.ok(listed.has(name), `${name} fehlt im Manifest`);
    assert.equal((await pkg.text('manifest.sha256')).split(' ')[0], sha(await pkg.z.read('manifest.json')));
    assert.ok(m.persons.some((p: any) => p.login === 'tester'));
  });

  it('nur Daten dieses Projekts; Bezüge in Schritten, Vorbedingungen und Ausführungen bleiben erhalten', async () => {
    const cases = await pkg.ndjson('test-cases.ndjson');
    assert.deepEqual(cases.map((c: any) => c.key).sort(), ['PK-T1', 'PK-T2']);
    assert.ok(cases.every((c: any) => !('projectId' in c)));
    const tc = cases.find((c: any) => c.key === 'PK-T2');
    assert.equal(tc.folderId, ids.folder);
    const versions = (await pkg.ndjson('test-case-versions.ndjson')).filter((v: any) => v.testCaseId === ids.tc);
    assert.deepEqual(versions.map((v: any) => v.versionNo), [1, 2]);
    assert.equal(versions[0].steps[0].call.testCaseId, ids.callee);
    assert.deepEqual(versions[0].preconditionIds, [ids.pre]);
    assert.ok(versions.every((v: any) => !('search' in v)), 'kein Suchindex');
    const [ex] = await pkg.ndjson('executions.ndjson');
    assert.equal(ex.testCaseVersionId, versions[1].id);
    assert.deepEqual(Object.keys(ex.pinnedRefs.preconditions), [ids.pre]);
    assert.equal((await pkg.ndjson('execution-results.ndjson'))[0].status, 'PASS');
    assert.equal((await pkg.ndjson('preconditions.ndjson'))[0].id, ids.pre);
    assert.equal((await pkg.ndjson('precondition-versions.ndjson')).length, 1);
    assert.equal((await pkg.ndjson('cycles.ndjson'))[0].configuration.device[0], 'iPad');
    assert.equal((await pkg.ndjson('sessions.ndjson')).length, 1);
    assert.deepEqual((await pkg.ndjson('test-sets.ndjson'))[0].testCaseIds, [ids.tc]);
    assert.equal((await pkg.ndjson('comments.ndjson'))[0].body, 'Bitte prüfen');
    assert.equal((await pkg.ndjson('references.ndjson'))[0].externalKey, 'REQ-1');
    assert.equal((await pkg.ndjson('views.ndjson'))[0].name, 'Meine');
  });

  it('Anhänge inhaltsadressiert; keine Geheimnisse im Paket', async () => {
    const atts = await pkg.ndjson('attachments.ndjson');
    assert.equal(atts.length, 2);
    for (const a of atts) {
      assert.equal(a.location, null, 'kein Speicherort der Quellinstanz');
      assert.equal(a.sha256, sha('PNG-Inhalt'));
    }
    assert.equal((await pkg.z.read(`files/${sha('PNG-Inhalt')}`)).toString(), 'PNG-Inhalt');
    const [hook] = await pkg.ndjson('webhooks.ndjson');
    assert.equal(hook.name, 'Chat');
    assert.ok(!('secret' in hook) && !('cursorSeq' in hook));
    const all = await Promise.all([...pkg.z.entries.keys()].filter((n) => !n.startsWith('files/')).map((n) => pkg.text(n)));
    assert.ok(!all.some((t) => /passwordHash|tokenHash|"secret"/.test(t)));
  });

  it('Katalog: nur benutzte globale Einträge', async () => {
    const c = await pkg.json('catalog.json');
    assert.ok(c.executionStatuses.some((s: any) => s.code === 'PASS'));
    assert.ok(!c.executionStatuses.some((s: any) => s.code === 'FAIL_KNOWN'), 'unbenutzte Status fehlen');
    assert.ok(c.priorities.some((p: any) => p.code === 'Kritisch'));
    assert.deepEqual(c.globalFields.map((f: any) => f.key), ['Team']);
    assert.deepEqual(c.configDimensions.map((d: any) => d.key), ['device']);
  });
});

const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Paket umpacken: Dateien ändern, Prüfsummen im Manifest neu berechnen (wie ein gültig erzeugtes Paket) */
async function repack(dir: string, body: Buffer, mutate: (files: Map<string, Buffer>, manifest: any) => void, opts: { keepSums?: boolean } = {}): Promise<Buffer> {
  const { z } = await readPackage(dir, body);
  const files = new Map<string, Buffer>();
  for (const name of z.entries.keys()) files.set(name, await z.read(name));
  await z.close();
  const manifest = JSON.parse(files.get('manifest.json')!.toString());
  mutate(files, manifest);
  if (!opts.keepSums) manifest.files = [...files.keys()].filter((n) => !n.startsWith('manifest.')).map((path) => ({ path, sha256: sha(files.get(path)!), size: files.get(path)!.length }));
  const text = JSON.stringify(manifest, null, 2);
  files.set('manifest.json', Buffer.from(text));
  files.set('manifest.sha256', Buffer.from(`${sha(text)}  manifest.json\n`));
  const { zipStream } = await import('../src/platform/zip.ts');
  const parts: Buffer[] = [];
  for await (const c of zipStream([...files].map(([name, data]) => ({ name, data })))) parts.push(c);
  return Buffer.concat(parts);
}

const ndjsonOf = (rows: unknown[]) => Buffer.from(rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
const parseNdjson = (b: Buffer) => b.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** Paketinhalt ohne IDs und Projektschlüssel: IDs werden in Reihenfolge des Auftretens durchnummeriert */
async function canonical(dir: string, body: Buffer, key: string): Promise<Record<string, unknown>> {
  const pkg = await readPackage(dir, body);
  try {
    const tokens = new Map<string, string>();
    const norm = (s: string) => s.replaceAll(`${key}-`, 'KEY-').replace(UUIDS, (u) => tokens.get(u) ?? tokens.set(u, `#${tokens.size}`).get(u)!);
    const out: Record<string, unknown> = {};
    for (const t of TYPES) {
      if (t.single) {
        const { id: _i, key: _k, name: _n, ...rest } = await pkg.json(`${t.name}.json`);
        out[t.name] = rest;
      } else {
        out[t.name] = (await pkg.ndjson(`${t.name}.ndjson`)).map((r: any) => JSON.parse(norm(JSON.stringify(t.name === 'webhooks' ? { ...r, active: '(Ziel: aus)' } : r))));
      }
    }
    out.catalog = await pkg.json('catalog.json');
    const m = await pkg.json('manifest.json');
    out.counts = m.counts;
    out.persons = m.persons;
    out.files = m.files.filter((f: any) => f.path.startsWith('files/'));
    return out;
  } finally { await pkg.z.close(); }
}

describe('Projektpaket: Import als neues Projekt (Stufe K2)', () => {
  let env: TestEnv;
  let dir: string;
  let source: Buffer;
  const ids: Record<string, string> = {};
  const upload = async (body: Buffer, user = 'tester') => {
    const res = await env.app.request('/api/package-imports', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-anemo-user': user }, body: new Uint8Array(body) });
    return { status: res.status, body: await res.json() as any };
  };

  before(async () => {
    env = await testEnv();
    dir = await mkdtemp(join(tmpdir(), 'anemo-transfer-'));
    process.env.ANEMO_TRANSFER_DIR = dir;
    Object.assign(ids, await seedProject(env));
    source = await exportBytes(env, 'PK');
  });
  after(async () => { delete process.env.ANEMO_TRANSFER_DIR; await env.close(); await rm(dir, { recursive: true, force: true }); });

  it('Hochladen prüft das Paket und schlägt einen freien Schlüssel vor', async () => {
    const up = await upload(source);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.transfer.status, 'pending');
    assert.equal(up.body.transfer.direction, 'import');
    assert.equal(up.body.package.project.key, 'PK');
    assert.equal(up.body.package.counts['test-cases'], 2);
    assert.deepEqual(up.body.suggestedTarget, { key: '', name: 'Paket' }, 'PK ist belegt');
    assert.equal(up.body.transfer.packageSha256, sha(source));
  });

  it('Probelauf: rechnet alles durch, schreibt nichts; belegter Schlüssel ist ein Hinderungsgrund', async () => {
    const up = (await upload(source)).body;
    const taken = (await env.call('POST', `/api/package-imports/${up.transfer.id}/preview`, { target: { key: 'PK', name: 'Kopie' } })).body;
    assert.match(taken.problems.join(), /PK gibt es bereits/);
    const r = await env.call('POST', `/api/package-imports/${up.transfer.id}/preview`, { target: { key: 'PKNEU', name: 'Kopie' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.dryRun, true);
    assert.deepEqual(r.body.problems, []);
    assert.equal(r.body.counts['test-cases'], 2);
    assert.equal(r.body.counts['test-case-versions'], 3);
    assert.equal(r.body.counts.executions, 1);
    assert.equal(r.body.counts.files, 2, 'zwei Anhänge mit demselben Inhalt');
    assert.deepEqual(r.body.keys, { from: 'PK-', to: 'PKNEU-' });
    assert.ok(r.body.persons.some((p: any) => p.login === 'tester' && p.how === 'als Text'));
    assert.ok(r.body.warnings.some((w: string) => /Webhooks sind abgeschaltet/.test(w)));
    assert.equal((await env.db`select count(*)::int as n from project where key = 'PKNEU'`)[0]!.n, 0);
    assert.equal((await env.db`select count(*)::int as n from project_transfer where id = ${up.transfer.id} and status = 'pending'`)[0]!.n, 1);
  });

  it('Einspielen: neue IDs, Schlüssel des Zielprojekts, Bezüge, Anhänge, Webhooks abgeschaltet', async () => {
    const up = (await upload(source)).body;
    const r = await env.call('POST', `/api/package-imports/${up.transfer.id}/apply`, { target: { key: 'PK2', name: 'Paket (Kopie)' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.dryRun, false);
    const [p] = await env.db`select id, name, next_number from project where key = 'PK2'`;
    assert.equal(p!.name, 'Paket (Kopie)');
    assert.equal(p!.nextNumber, 3, 'Nummernkreis übernommen');
    const tcs = await env.db`select id, key, folder_id from test_case where project_id = ${p!.id} order by key`;
    assert.deepEqual(tcs.map((t) => t.key), ['PK2-T1', 'PK2-T2']);
    assert.ok(!tcs.some((t) => t.id === ids.tc || t.id === ids.callee), 'neue IDs');
    const t2 = (await env.call('GET', '/api/test-cases/PK2-T2')).body;
    assert.equal(t2.version.versionNo, 2);
    assert.equal(t2.version.steps[0].call.testCaseId, tcs[0]!.id, 'Aufruf zeigt auf die Kopie');
    assert.equal(t2.version.preconditionIds.length, 1);
    assert.notEqual(t2.version.preconditionIds[0], ids.pre);
    const [folder] = await env.db`select f.name, parent.name as parent from folder f join folder parent on parent.id = f.parent_id where f.project_id = ${p!.id}`;
    assert.deepEqual({ ...folder }, { name: 'Eingang', parent: 'Akten' }, 'Ordnerbaum');
    const comments = await env.db`select body, parent_id from comment where owner_id = ${t2.id} order by created_at, id`;
    assert.equal(comments.length, 2);
    assert.equal(comments[1]!.parentId, (await env.db`select id from comment where owner_id = ${t2.id} and parent_id is null`)[0]!.id);
    assert.equal(comments[1]!.body, 'Erledigt, siehe PK2-T1', 'Schlüssel in Texten umgeschrieben');
    const [ex] = await env.db`select e.id, e.pinned_refs, e.test_case_version_id from test_execution e join test_cycle c on c.id = e.cycle_id where c.project_id = ${p!.id}`;
    assert.deepEqual(Object.keys(ex!.pinnedRefs.preconditions), [t2.version.preconditionIds[0]], 'festgehaltene Fassung übersetzt');
    assert.equal(ex!.testCaseVersionId, t2.version.id);
    assert.equal((await env.db`select count(*)::int as n from execution_result where execution_id = ${ex!.id}`)[0]!.n, 1);
    const [ref] = await env.db`select external_key from external_reference where owner_id = ${t2.id}`;
    assert.equal(ref!.externalKey, 'REQ-1');
    const atts = (await env.call('GET', `/api/attachments?ownerType=TEST_CASE&ownerId=${t2.id}`)).body;
    const att = (Array.isArray(atts) ? atts : atts.items)[0];
    const file = await env.app.request(`/api/attachments/${att.id}/content`, { headers: { 'x-anemo-user': 'tester' } });
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), 'PNG-Inhalt');
    const [hook] = await env.db`select active, secret, cursor_seq from webhook where project_id = ${p!.id}`;
    assert.equal(hook!.active, false);
    assert.ok(hook!.secret.length > 20);
    const [orig] = await env.db`select secret from webhook where project_id = (select id from project where key = 'PK')`;
    assert.notEqual(hook!.secret, orig!.secret);
    const [t] = await env.db`select status, project_key, counts from project_transfer where id = ${up.transfer.id}`;
    assert.equal(t!.status, 'done');
    assert.equal(t!.projectKey, 'PK2');
    assert.equal((await env.db`select count(*)::int as n from domain_event where type = 'ProjectImported'`)[0]!.n, 1);
    assert.equal((await env.db`select count(*)::int as n from domain_event where aggregate_id = ${t2.id}`)[0]!.n, 0, 'keine Ereignisse je Objekt');
    assert.equal((await env.call('POST', `/api/package-imports/${up.transfer.id}/apply`, { target: { key: 'PK3', name: 'x' } })).status, 409, 'nur einmal');
  });

  it('Rundlauf: Export → Import → Export ergibt denselben Inhalt (bis auf IDs und Schlüssel)', async () => {
    const copy = await exportBytes(env, 'PK2');
    const a = await canonical(dir, source, 'PK');
    const b = await canonical(dir, copy, 'PK2');
    for (const k of Object.keys(a)) assert.deepEqual(b[k], a[k], k);
  });

  it('Berichte im Ziel wie in der Quelle', async () => {
    const plans = await env.db`select p.id, pr.key from test_plan p join project pr on pr.id = p.project_id where pr.key in ('PK', 'PK2') order by pr.key`;
    const report = async (id: string) => {
      const r = (await env.call('GET', `/api/reports/completion/${id}?format=json`)).body;
      return JSON.parse(JSON.stringify({ current: r.current, cycles: r.cycles.map((c: any) => ({ name: c.name, summary: c.summary })), coverage: r.coverage,
        assessment: r.assessment, criteria: r.criteria, openItems: r.openItems.length, changedNotTested: r.changedNotTested })
        .replaceAll('PK2-', 'PK-').replace(UUIDS, 'id'));
    };
    const original = await report(plans[0]!.id);
    assert.equal(original.current.testCases, 1, 'Vergleich hat Inhalt');
    assert.equal(original.coverage.requirements, 1, 'REQ-1');
    assert.deepEqual(await report(plans[1]!.id), original);
  });

  it('veränderte oder fremde Pakete werden abgelehnt', async () => {
    const tampered = await repack(dir, source, (f) => { f.set('test-case-versions.ndjson', Buffer.from(f.get('test-case-versions.ndjson')!.toString().replace('Anmelden', 'Abmelden'))); }, { keepSums: true });
    const t = await upload(tampered);
    assert.equal(t.status, 400);
    assert.match(t.body.detail, /Prüfsumme stimmt nicht: test-case-versions.ndjson/);
    const future = await repack(dir, source, (_f, m) => { m.formatVersion = '2.0.0'; });
    assert.match((await upload(future)).body.detail, /Formatversion 2.0.0 wird nicht unterstützt/);
    const extra = await repack(dir, source, (f) => {
      f.set('folders.ndjson', ndjsonOf(parseNdjson(f.get('folders.ndjson')!).map((r) => ({ ...r, projectId: 'x' }))));
    });
    const up = (await upload(extra)).body;
    const r = await env.call('POST', `/api/package-imports/${up.transfer.id}/preview`, { target: { key: 'PKX', name: 'x' } });
    assert.equal(r.status, 400);
    assert.match(r.body.detail, /unbekannte Angaben projectId/);
    const junk = await upload(Buffer.from('kein Paket'));
    assert.equal(junk.status, 400);
  });

  it('Verwerfen löscht das hochgeladene Paket', async () => {
    const up = (await upload(source)).body;
    assert.equal((await env.call('DELETE', `/api/package-imports/${up.transfer.id}`)).status, 204);
    assert.ok(!(await readdirSafe(dir)).includes(`anemo-import-${up.transfer.id}.zip`));
    assert.equal((await env.call('POST', `/api/package-imports/${up.transfer.id}/preview`, { target: { key: 'PKY', name: 'y' } })).status, 409);
  });
});

async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return readdir(dir).catch(() => []);
}

describe('Projektpaket: Import mit Rechten, Personen und Katalogen (Modus on, Stufe K2)', () => {
  let env: TestEnv;
  let dir: string;
  const cookies = new Map<string, string>();
  const req = async (user: string, method: string, path: string, body?: unknown, raw?: Buffer) => {
    const res = await env.app.request(path, {
      method, headers: { 'content-type': raw ? 'application/zip' : 'application/json', host: 'anemo.test', cookie: cookies.get(user) ?? '' },
      ...(raw ? { body: new Uint8Array(raw) } : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') && buf.length ? JSON.parse(buf.toString()) : null, raw: buf, setCookie: res.headers.get('set-cookie') };
  };
  const login = async (u: string) => cookies.set(u, (await req('', 'POST', '/api/auth/login', { username: u, password: PW })).setCookie!.split(';')[0]!);
  const uid: Record<string, string> = {};
  let pkg: Buffer;

  before(async () => {
    env = await testEnv({ authMode: 'on' });
    dir = await mkdtemp(join(tmpdir(), 'anemo-transfer-'));
    process.env.ANEMO_TRANSFER_DIR = dir;
    process.env.ANEMO_ADMIN_PASSWORD = PW;
    const { bootstrapAdmin } = await import('../src/modules/auth/index.ts');
    await bootstrapAdmin(env.db, '/dev/null', () => {});
    delete process.env.ANEMO_ADMIN_PASSWORD;
    await login('admin');
    for (const u of ['pia', 'paul']) { uid[u] = (await req('admin', 'POST', '/api/admin/users', { username: u, displayName: u, password: PW })).body.id; await login(u); }
    await req('admin', 'PUT', '/api/admin/permissions', { principalType: 'user', principalId: uid.paul, permission: 'PROJECT_TRANSFER', granted: true });
    await req('admin', 'POST', '/api/projects', { key: 'QU', name: 'Quelle' });
    await req('admin', 'PUT', '/api/projects/QU/members', { principalType: 'user', principalId: uid.pia, role: 'TESTER' });
    await req('admin', 'PUT', '/api/projects/QU/members', { principalType: 'user', principalId: uid.paul, role: 'DESIGNER' });
    await req('admin', 'PUT', '/api/projects/QU/visibility', { visibility: 'restricted' });
    await req('admin', 'POST', '/api/projects/QU/test-cases', { content: { title: 'Fall', steps: [{ action: 'a', expected: 'b' }] } });
    const c = (await req('admin', 'POST', '/api/projects/QU/cycles', { name: 'Lauf' })).body;
    await req('admin', 'POST', `/api/cycles/${c.id}/executions`, { testCaseIds: ['QU-T1'] });
    const ex = (await req('admin', 'GET', `/api/cycles/${c.id}/executions`)).body.items[0];
    assert.equal((await req('pia', 'POST', `/api/executions/${ex.id}/result`, { status: 'PASS' })).status, 200);
    const t = (await req('admin', 'POST', '/api/projects/QU/exports', {})).body;
    const exported = (await req('admin', 'GET', `/api/project-transfers/${t.id}/download`)).raw;
    // Paket aus einer anderen Instanz nachbilden: Ergebnisstatus, den es hier nicht gibt
    pkg = await repack(dir, exported, (f) => {
      const swap = (name: string) => f.set(name, ndjsonOf(parseNdjson(f.get(name)!).map((r) => ({ ...r, status: 'GEPRUEFT' }))));
      swap('executions.ndjson'); swap('execution-results.ndjson');
      const cat = JSON.parse(f.get('catalog.json')!.toString());
      cat.executionStatuses = [{ ...cat.executionStatuses.find((s: any) => s.code === 'PASS'), code: 'GEPRUEFT', name: 'Geprüft' }];
      f.set('catalog.json', Buffer.from(JSON.stringify(cat)));
    });
  });
  after(async () => { delete process.env.ANEMO_TRANSFER_DIR; await env.close(); await rm(dir, { recursive: true, force: true }); });

  it('ohne das Recht kein Hochladen', async () => {
    const r = await req('pia', 'POST', '/api/package-imports', undefined, pkg);
    assert.equal(r.status, 403);
    assert.match(r.body.detail, /Projekte übertragen/);
  });

  it('fremde Uploads sind unsichtbar; fehlender Status hindert, Zuordnung von Status und Personen hilft', async () => {
    const up = (await req('paul', 'POST', '/api/package-imports', undefined, pkg)).body;
    assert.equal(up.transfer.sensitive, true);
    assert.equal((await req('pia', 'GET', `/api/package-imports/${up.transfer.id}`)).status, 404);
    const target = { key: 'QU2', name: 'Kopie' };
    const blocked = (await req('paul', 'POST', `/api/package-imports/${up.transfer.id}/preview`, { target })).body;
    assert.match(blocked.problems.join(), /Ergebnisstatus „GEPRUEFT“/);
    assert.deepEqual(blocked.persons.find((p: any) => p.login === 'pia'), { login: 'pia', displayName: 'pia', target: 'pia', how: 'gleich' });
    assert.equal((await req('paul', 'POST', `/api/package-imports/${up.transfer.id}/apply`, { target })).status, 409);
    const opts = { target, executionStatuses: { GEPRUEFT: 'PASS' }, persons: { pia: 'paul' } };
    const preview = (await req('paul', 'POST', `/api/package-imports/${up.transfer.id}/preview`, opts)).body;
    assert.deepEqual(preview.problems, []);
    assert.deepEqual(preview.catalog.find((c: any) => c.code === 'GEPRUEFT'), { kind: 'Ergebnisstatus', code: 'GEPRUEFT', action: 'zugeordnet', target: 'PASS' });
    assert.equal((await req('paul', 'POST', `/api/package-imports/${up.transfer.id}/preview`, { ...opts, persons: { pia: 'niemand' } })).body.problems.length, 1);
    const r = await req('paul', 'POST', `/api/package-imports/${up.transfer.id}/apply`, opts);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.warnings.some((w: string) => /doppelte Mitgliedschaft/.test(w)));
    const [p] = await env.db`select id, visibility from project where key = 'QU2'`;
    assert.equal(p!.visibility, 'restricted', 'Sensibilität bleibt');
    const members = await env.db`select u.username, m.role from project_member m join app_user u on u.id = m.principal_id where m.project_id = ${p!.id}`;
    assert.deepEqual(members.map((m) => `${m.username}:${m.role}`), ['paul:PROJECT_ADMIN'], 'Importierende(r) verwaltet das Projekt');
    const [ex] = await env.db`select e.status, e.executed_by from test_execution e join test_cycle c on c.id = e.cycle_id where c.project_id = ${p!.id}`;
    assert.deepEqual({ ...ex }, { status: 'PASS', executedBy: 'paul' });
    assert.equal((await req('paul', 'GET', '/api/test-cases/QU2-T1')).status, 200);
    assert.equal((await env.db`select count(*)::int as n from execution_status where code = 'GEPRUEFT'`)[0]!.n, 0, 'ohne Systemadministration kein neuer Katalogeintrag');
  });

  it('Systemadministration legt fehlende Katalogeinträge an', async () => {
    const up = (await req('admin', 'POST', '/api/package-imports', undefined, pkg)).body;
    const r = (await req('admin', 'POST', `/api/package-imports/${up.transfer.id}/apply`, { target: { key: 'QU3', name: 'Kopie 3' } })).body;
    assert.deepEqual(r.catalog.find((c: any) => c.code === 'GEPRUEFT'), { kind: 'Ergebnisstatus', code: 'GEPRUEFT', action: 'angelegt' });
    assert.equal((await env.db`select count(*)::int as n from execution_status where code = 'GEPRUEFT'`)[0]!.n, 1);
  });

  it('in ein bestehendes Projekt nur mit Projektadministration im Ziel (Stufe K4)', async () => {
    const up = (await req('paul', 'POST', '/api/package-imports', undefined, pkg)).body;
    const opts = { target: { mode: 'existing', key: 'QU' }, executionStatuses: { GEPRUEFT: 'PASS' } };
    assert.equal((await req('paul', 'POST', `/api/package-imports/${up.transfer.id}/preview`, opts)).status, 403, 'nur Designer in QU');
    assert.equal((await req('paul', 'POST', `/api/package-imports/${up.transfer.id}/preview`, { ...opts, target: { mode: 'existing', key: 'QU2' } })).status, 200, 'Projektadmin in QU2');
  });
});

describe('Projektpaket: Auswahl und Optionen (Stufe K3)', () => {
  let env: TestEnv;
  let dir: string;
  const ids: Record<string, string> = {};
  /** Export mit Umfang/Optionen anfordern und abrufen; liefert Paket und Antwort der Anforderung */
  const exportWith = async (body: Record<string, unknown>) => {
    const req = await env.call('POST', '/api/projects/PK/exports', body);
    assert.equal(req.status, 201, JSON.stringify(req.body));
    const res = await env.app.request(`/api/project-transfers/${req.body.id}/download`, { headers: { 'x-anemo-user': 'tester' } });
    assert.equal(res.status, 200);
    const raw = Buffer.from(await res.arrayBuffer());
    return { pkg: await readPackage(dir, raw), raw, request: req.body, name: res.headers.get('content-disposition')! };
  };
  const keysIn = async (pkg: Awaited<ReturnType<typeof readPackage>>) => (await pkg.ndjson('test-cases.ndjson')).map((t: any) => t.key).sort();

  before(async () => {
    env = await testEnv();
    dir = await mkdtemp(join(tmpdir(), 'anemo-transfer-'));
    process.env.ANEMO_TRANSFER_DIR = dir;
    Object.assign(ids, await seedProject(env));
    await env.call('POST', '/api/projects/PK/test-cases', { folderId: ids.subfolder, content: { title: 'Posteingang prüfen', steps: [{ action: 'a', expected: 'b' }] } });
  });
  after(async () => { delete process.env.ANEMO_TRANSFER_DIR; await env.close(); await rm(dir, { recursive: true, force: true }); });

  it('Testfall per Schlüssel: aufgerufener Testfall, Vorbedingung und Ordner kommen mit, Projekteinstellungen nicht', async () => {
    const { pkg, request, name } = await exportWith({ scope: { kind: 'selection', testCases: ['PK-T2'] } });
    try {
      assert.equal(request.options.summary['test-cases'], 2, 'Umfang schon bei der Anforderung');
      assert.match(name, /Projekt-PK-Auswahl-/);
      assert.deepEqual(await keysIn(pkg), ['PK-T1', 'PK-T2']);
      assert.equal((await pkg.ndjson('preconditions.ndjson')).length, 1);
      assert.deepEqual((await pkg.ndjson('folders.ndjson')).map((f: any) => f.name), ['Akten']);
      assert.equal((await pkg.ndjson('test-case-versions.ndjson')).length, 3);
      for (const f of ['executions', 'plans', 'cycles', 'views', 'members', 'webhooks', 'step-blocks', 'test-sets']) assert.equal((await pkg.ndjson(`${f}.ndjson`)).length, 0, f);
      assert.equal((await pkg.ndjson('comments.ndjson')).length, 2);
      assert.equal((await pkg.ndjson('attachments.ndjson')).length, 2);
      const m = await pkg.json('manifest.json');
      assert.equal(m.scope.kind, 'selection');
      assert.deepEqual(m.scope.testCases, ['PK-T2']);
    } finally { await pkg.z.close(); }
  });

  it('Zyklus mit „nur aktuelle Versionen“: Ausführungen samt Testfällen und ausgeführter Version', async () => {
    const { pkg } = await exportWith({ scope: { kind: 'selection', cycles: [ids.cycle] }, options: { versions: 'current' } });
    try {
      assert.deepEqual(await keysIn(pkg), ['PK-T1', 'PK-T2']);
      const versions = await pkg.ndjson('test-case-versions.ndjson');
      assert.deepEqual(versions.map((v: any) => v.versionNo).sort(), [1, 2], 'T1 v1 und T2 v2, nicht T2 v1');
      assert.equal((await pkg.ndjson('executions.ndjson')).length, 1);
      assert.equal((await pkg.ndjson('execution-results.ndjson')).length, 1);
      assert.equal((await pkg.ndjson('plans.ndjson')).length, 1, 'Plan des Zyklus');
      assert.equal((await pkg.ndjson('sessions.ndjson')).length, 1);
    } finally { await pkg.z.close(); }
  });

  it('Ordner samt Unterordnern, Abfrage und Testset', async () => {
    const byFolder = await exportWith({ scope: { kind: 'selection', folders: [ids.folder] } });
    try { assert.deepEqual(await keysIn(byFolder.pkg), ['PK-T1', 'PK-T2', 'PK-T3']); } finally { await byFolder.pkg.z.close(); }
    const byQuery = await exportWith({ scope: { kind: 'selection', query: 'titel ~ Posteingang' } });
    try {
      assert.deepEqual(await keysIn(byQuery.pkg), ['PK-T3']);
      assert.deepEqual((await byQuery.pkg.ndjson('folders.ndjson')).map((f: any) => f.name).sort(), ['Akten', 'Eingang'], 'übergeordnete Ordner');
    } finally { await byQuery.pkg.z.close(); }
    const [set] = await env.db`select id from test_set where name = 'Smoke'`;
    const bySet = await exportWith({ scope: { kind: 'selection', testSets: [set!.id] } });
    try {
      assert.deepEqual(await keysIn(bySet.pkg), ['PK-T1', 'PK-T2']);
      assert.equal((await bySet.pkg.ndjson('test-sets.ndjson')).length, 1);
    } finally { await bySet.pkg.z.close(); }
  });

  it('Optionen: ohne Ausführungen, Anhänge und Kommentare', async () => {
    const { pkg } = await exportWith({ options: { executions: false, attachments: false, comments: false } });
    try {
      for (const f of ['plans', 'cycles', 'executions', 'execution-results', 'sessions', 'attachments', 'comments']) assert.equal((await pkg.ndjson(`${f}.ndjson`)).length, 0, f);
      assert.ok(![...pkg.z.entries.keys()].some((n) => n.startsWith('files/')));
      assert.equal((await pkg.ndjson('test-cases.ndjson')).length, 3);
      assert.equal((await pkg.ndjson('references.ndjson')).length, 1, 'Anforderungsbezüge bleiben');
      const c = await pkg.json('catalog.json');
      assert.deepEqual(c.executionStatuses, []);
    } finally { await pkg.z.close(); }
  });

  it('ungültige Auswahl fällt schon beim Anfordern auf', async () => {
    assert.equal((await env.call('POST', '/api/projects/PK/exports', { scope: { kind: 'selection' } })).status, 400);
    const foreign = await env.call('POST', '/api/projects/PK/exports', { scope: { kind: 'selection', testCases: ['XX-T1'] } });
    assert.equal(foreign.status, 400);
    assert.match(foreign.body.detail, /XX-T1/);
    assert.equal((await env.call('POST', '/api/projects/PK/exports', { scope: { kind: 'selection', query: 'titel ~' } })).status, 400);
  });

  it('pseudonymisiert: keine Logins, Namen oder E-Mails; Import funktioniert', async () => {
    await env.db`insert into app_user(username, display_name, email, password_hash, source) values ('tester', 'Tina Tester', 'tina@example.org', 'x', 'local')`;
    await env.call('POST', '/api/comments', { ownerType: 'TEST_CASE', ownerId: ids.tc, body: 'Bitte @tester ansehen' });
    await env.call('POST', '/api/comments', { ownerType: 'TEST_CASE', ownerId: ids.tc, body: 'Mit Tina Tester besprochen (Rückfragen an tina@example.org, Vertretung: Tester, Tina). Der Tester prüft.' });
    const { pkg, raw } = await exportWith({ options: { pseudonymize: true } });
    try {
      const texts = await Promise.all([...pkg.z.entries.keys()].filter((n) => !n.startsWith('files/')).map((n) => pkg.text(n)));
      for (const t of texts) {
        const login = /:\s*"tester"|"tester"\s*[,\]]|@tester\b/; // Werte, nicht der Spaltenname „tester“ der Sitzungen
        assert.ok(!login.test(t), `kein Login: ${t.split('\n').find((l) => login.test(l))}`);
        assert.ok(!/Tina|tina@example/.test(t), 'kein Name, keine E-Mail');
      }
      const m = await pkg.json('manifest.json');
      assert.deepEqual(m.persons, [{ login: 'Person 1', displayName: 'Person 1', email: null, active: null }]);
      assert.equal(m.exportedBy, 'pseudonymisiert');
      assert.ok((await pkg.ndjson('comments.ndjson')).some((c: any) => c.body === 'Bitte @Person1 ansehen'));
      assert.ok((await pkg.ndjson('comments.ndjson')).some((c: any) => c.body === 'Mit Person 1 besprochen (Rückfragen an [E-Mail entfernt], Vertretung: Person 1). Der Tester prüft.'),
        'Namen und E-Mail in Freitexten; das Wort „Tester“ allein bleibt');
      assert.equal((await pkg.ndjson('members.ndjson')).length, 0);
      assert.equal((await pkg.ndjson('test-cases.ndjson'))[0].createdBy, 'Person 1');
    } finally { await pkg.z.close(); }
    const res = await env.app.request('/api/package-imports', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-anemo-user': 'tester' }, body: new Uint8Array(raw) });
    const up = await res.json() as any;
    const r = await env.call('POST', `/api/package-imports/${up.transfer.id}/apply`, { target: { key: 'PSEUDO', name: 'Pseudonymisiert' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await env.db`select created_by from test_case where key = 'PSEUDO-T1'`)[0]!.createdBy, 'Person 1');
  });

  it('Auswahl lässt sich als neues Projekt einspielen', async () => {
    const { raw } = await exportWith({ scope: { kind: 'selection', testCases: ['PK-T2'] }, options: { versions: 'current' } });
    const res = await env.app.request('/api/package-imports', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-anemo-user': 'tester' }, body: new Uint8Array(raw) });
    const up = await res.json() as any;
    const r = await env.call('POST', `/api/package-imports/${up.transfer.id}/apply`, { target: { key: 'TEIL', name: 'Teil' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t2 = (await env.call('GET', '/api/test-cases/TEIL-T2')).body;
    assert.equal(t2.version.versionNo, 2);
    assert.equal(t2.version.steps[0].call.testCaseId, (await env.db`select id from test_case where key = 'TEIL-T1'`)[0]!.id);
  });
});

describe('Projektpaket: Import in ein bestehendes Projekt (Stufe K4)', () => {
  let env: TestEnv;
  let dir: string;
  const ids: Record<string, string> = {};
  const upload = async (body: Buffer) => {
    const res = await env.app.request('/api/package-imports', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-anemo-user': 'tester' }, body: new Uint8Array(body) });
    assert.equal(res.status, 201);
    return ((await res.json()) as any).transfer.id as string;
  };
  const run = async (pkg: Buffer, options: Record<string, unknown>, dry = false) => {
    const id = await upload(pkg);
    const r = await env.call('POST', `/api/package-imports/${id}/${dry ? 'preview' : 'apply'}`, options);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const count = async (key: string, table: string) => (await env.db`select count(*)::int as n from ${env.db(table)} where project_id = (select id from project where key = ${key})`)[0]!.n;
  const into = (key: string, extra: Record<string, unknown> = {}) => ({ target: { mode: 'existing', key }, ...extra });

  before(async () => {
    env = await testEnv();
    dir = await mkdtemp(join(tmpdir(), 'anemo-transfer-'));
    process.env.ANEMO_TRANSFER_DIR = dir;
    Object.assign(ids, await seedProject(env));
    await run(await exportBytes(env, 'PK'), { target: { key: 'KOPIE', name: 'Kopie' } });
  });
  after(async () => { delete process.env.ANEMO_TRANSFER_DIR; await env.close(); await rm(dir, { recursive: true, force: true }); });

  it('erneuter Import desselben Pakets in die Kopie: keine Dubletten, nichts geändert', async () => {
    const r = await run(await exportBytes(env, 'PK'), into('KOPIE'));
    assert.equal(r.mode, 'existing');
    for (const [type, c] of Object.entries(r.changes) as [string, any][]) assert.equal(c.created, 0, `${type}: nichts neu`);
    assert.equal(r.changes['test-cases'].skipped, 2);
    assert.equal(await count('KOPIE', 'test_case'), 2);
    assert.equal(await count('KOPIE', 'folder'), 2);
    assert.deepEqual(r.problems, []);
  });

  it('Änderungen der Quelle kommen an: neue Version, neuer Testfall mit Schlüssel des Ziels, neues Ergebnis, neuer Kommentar', async () => {
    const call = env.call;
    const tc = (await call('GET', `/api/test-cases/${ids.tc}`)).body;
    assert.equal((await call('PUT', `/api/test-cases/${ids.tc}/content`, { expectedVersion: 2, changeNote: 'Version 3', content: { ...tc.version, title: 'Akte öffnen (v3)' } })).status, 200);
    await call('POST', '/api/projects/PK/test-cases', { folderId: ids.subfolder, content: { title: 'Neu in der Quelle', steps: [{ action: 'a', expected: 'b' }] } });
    const ex = (await call('GET', `/api/cycles/${ids.cycle}/executions`)).body.items[0];
    await call('POST', `/api/executions/${ex.id}/result`, { status: 'FAIL', comment: 'Absturz' });
    await call('POST', '/api/comments', { ownerType: 'TEST_CASE', ownerId: ids.tc, body: 'Neuer Hinweis zu PK-T1' });
    const before = await count('KOPIE', 'test_case');
    const r = await run(await exportBytes(env, 'PK'), into('KOPIE'));
    assert.equal(r.changes['test-cases'].created, 1);
    assert.equal(r.changes['test-case-versions'].created, 2, 'v3 von T2, v1 des neuen Testfalls');
    assert.equal(await count('KOPIE', 'test_case'), before + 1);
    assert.equal(r.keyMap['PK-T3'], 'KOPIE-T3');
    assert.equal(r.keyMap['PK-T2'], 'KOPIE-T2');
    const t2 = (await call('GET', '/api/test-cases/KOPIE-T2')).body;
    assert.equal(t2.version.versionNo, 3);
    assert.equal(t2.version.title, 'Akte öffnen (v3)');
    assert.ok(r.conflicts.some((c: string) => /KOPIE-T2: neue Version 3/.test(c)));
    const t3 = (await call('GET', '/api/test-cases/KOPIE-T3')).body;
    const [folder] = await env.db`select name from folder where id = ${t3.folderId}`;
    assert.equal(folder!.name, 'Eingang', 'vorhandener Ordner wiederverwendet');
    const [copyEx] = await env.db`select e.id, e.status from test_execution e join test_cycle c on c.id = e.cycle_id where c.project_id = (select id from project where key = 'KOPIE')`;
    assert.equal(copyEx!.status, 'FAIL');
    assert.equal((await env.db`select count(*)::int as n from execution_result where execution_id = ${copyEx!.id}`)[0]!.n, 2);
    const bodies = (await env.db`select body from comment where owner_id = ${t2.id} order by created_at`).map((c) => c.body);
    assert.deepEqual(bodies, ['Bitte prüfen', 'Erledigt, siehe KOPIE-T1', 'Neuer Hinweis zu KOPIE-T1']);
    // und noch einmal: nichts mehr zu tun
    const again = await run(await exportBytes(env, 'PK'), into('KOPIE'));
    for (const [type, c] of Object.entries(again.changes) as [string, any][]) assert.equal(c.created, 0, `${type}: nichts neu`);
  });

  it('lokale Änderungen im Ziel bleiben, wenn das Paket nicht neuer ist; abgeschlossene Zyklen werden nicht verändert', async () => {
    const pkg = await exportBytes(env, 'PK');
    const ex = (await env.db`select e.id, c.id as cycle from test_execution e join test_cycle c on c.id = e.cycle_id where c.project_id = (select id from project where key = 'KOPIE')`)[0]!;
    await env.call('POST', `/api/executions/${ex.id}/result`, { status: 'PASS' });
    const r1 = await run(pkg, into('KOPIE'));
    assert.equal(r1.changes.executions.updated, 0, 'Ziel ist neuer');
    assert.equal((await env.db`select status from test_execution where id = ${ex.id}`)[0]!.status, 'PASS');
    // Quelle ändert danach, Ziel-Zyklus ist abgeschlossen
    const srcEx = (await env.call('GET', `/api/cycles/${ids.cycle}/executions`)).body.items[0];
    await env.call('POST', `/api/executions/${srcEx.id}/result`, { status: 'BLOCKED', comment: 'Umgebung fehlt' });
    await env.call('POST', `/api/cycles/${ex.cycle}/state`, { state: 'closed' });
    const r2 = await run(await exportBytes(env, 'PK'), into('KOPIE'));
    assert.ok(r2.conflicts.some((c: string) => /abgeschlossen/.test(c)));
    assert.equal((await env.db`select status from test_execution where id = ${ex.id}`)[0]!.status, 'PASS');
  });

  it('Regeln je Objektart: überspringen und als Kopie anlegen', async () => {
    const tc = (await env.call('GET', `/api/test-cases/${ids.callee}`)).body;
    await env.call('PUT', `/api/test-cases/${ids.callee}/content`, { expectedVersion: 1, content: { ...tc.version, title: 'Anmelden (neu)' } });
    const pkg = await exportBytes(env, 'PK');
    const skipped = await run(pkg, into('KOPIE', { conflicts: { 'test-cases': 'skip' } }), true);
    assert.equal(skipped.dryRun, true);
    assert.equal(skipped.changes['test-cases'].skipped, 3);
    const copies = await run(pkg, into('KOPIE', { conflicts: { 'test-cases': 'new' } }), true);
    assert.equal(copies.changes['test-cases'].created, 3, 'alle als Kopie');
    assert.deepEqual(Object.values(copies.keyMap).filter((k) => /^KOPIE-T/.test(k as string)).length, 3);
    assert.equal(await count('KOPIE', 'test_case'), 3, 'Probelauf schreibt nichts');
  });

  it('Regel „überspringen“ hängt keine Versionen an und lässt die aktuelle Version (Review K1)', async () => {
    const [before] = await env.db`select t.current_version as cur, (select count(*)::int from test_case_version v where v.test_case_id = t.id) as n
      from test_case t where t.project_id = (select id from project where key = 'KOPIE') and t.key = 'KOPIE-T1'`;
    const r = await run(await exportBytes(env, 'PK'), into('KOPIE', { conflicts: { 'test-cases': 'skip' } }));
    assert.equal(r.changes['test-case-versions']?.created ?? 0, 0, 'keine neuen Versionen');
    const [after] = await env.db`select t.current_version as cur, (select count(*)::int from test_case_version v where v.test_case_id = t.id) as n
      from test_case t where t.project_id = (select id from project where key = 'KOPIE') and t.key = 'KOPIE-T1'`;
    assert.deepEqual(after, before);
  });

  it('Regeln nur für Objektarten des Zielprojekts; Testfälle anderer Projekte sind nie veränderbar', async () => {
    const id = await upload(await exportBytes(env, 'PK'));
    const r = await env.call('POST', `/api/package-imports/${id}/preview`, into('KOPIE', { conflicts: { 'foreign-test-cases': 'update' } }));
    assert.equal(r.status, 400);
  });

  it('Wiederholungen desselben Testfalls im selben Zyklus bleiben getrennt; abgeschlossene Zyklen bekommen nichts Neues (Review K2/K3)', async () => {
    const cyc = (await env.call('POST', '/api/projects/PK/cycles', { name: 'Wiederholungen' })).body.id;
    await env.call('POST', `/api/cycles/${cyc}/executions`, { testCaseIds: [ids.tc] });
    await run(await exportBytes(env, 'PK'), into('KOPIE'));
    const target = async () => env.db`select e.id from test_execution e join test_cycle c on c.id = e.cycle_id
      where c.name = 'Wiederholungen' and c.project_id = (select id from project where key = 'KOPIE') order by e.order_no`;
    assert.equal((await target()).length, 1);
    // zweiter Durchlauf desselben Testfalls in der Quelle (wie Ad-hoc-Wiederholungen aus Zephyr)
    await env.db`insert into test_execution (cycle_id, test_case_id, test_case_version_id, order_no, status)
      select cycle_id, test_case_id, test_case_version_id, order_no + 1, 'NOT_EXECUTED' from test_execution where cycle_id = ${cyc}`;
    const r = await run(await exportBytes(env, 'PK'), into('KOPIE'));
    assert.equal(r.changes.executions.created, 1, 'neue Wiederholung angelegt statt die vorhandene zu überschreiben');
    const two = await target();
    assert.equal(two.length, 2);
    const again = await run(await exportBytes(env, 'PK'), into('KOPIE'));
    assert.equal(again.changes.executions?.created ?? 0, 0);
    assert.deepEqual((await target()).map((x) => x.id), two.map((x) => x.id));
    // Ziel-Zyklus abgeschlossen: weder neue Ergebnisse im Verlauf noch neue Ausführungen
    const tcyc = (await env.db`select id from test_cycle where name = 'Wiederholungen' and project_id = (select id from project where key = 'KOPIE')`)[0]!.id;
    await env.call('POST', `/api/cycles/${tcyc}/state`, { state: 'closed' });
    const results = async () => (await env.db`select count(*)::int as n from execution_result where execution_id = any(${two.map((x) => x.id)}::uuid[])`)[0]!.n;
    const before = await results();
    const src = (await env.call('GET', `/api/cycles/${cyc}/executions`)).body.items;
    await env.call('POST', `/api/executions/${src[0].id}/result`, { status: 'PASS' });
    await env.db`insert into test_execution (cycle_id, test_case_id, test_case_version_id, order_no, status)
      select cycle_id, test_case_id, test_case_version_id, order_no + 10, 'NOT_EXECUTED' from test_execution where cycle_id = ${cyc} limit 1`;
    const closed = await run(await exportBytes(env, 'PK'), into('KOPIE'));
    assert.equal(await results(), before, 'Verlauf im abgeschlossenen Zyklus unverändert');
    assert.equal((await target()).length, 2, 'keine neue Ausführung im abgeschlossenen Zyklus');
    assert.ok(closed.conflicts.some((c: string) => /abgeschlossenen Zyklus – nicht angelegt/.test(c)));
  });

  it('Auswahl in ein anderes Projekt unter einen Zielordner; gleichnamige Testsets werden zusammengeführt', async () => {
    await env.call('POST', '/api/projects', { key: 'ZIEL', name: 'Ziel' });
    const target = (await env.call('POST', '/api/projects/ZIEL/folders', { name: 'Übernommen' })).body.id;
    await env.call('POST', '/api/projects/ZIEL/test-sets', { name: 'Smoke', kind: 'static', testCaseIds: [] });
    const req = (await env.call('POST', '/api/projects/PK/exports', { scope: { kind: 'selection', testSets: [(await env.db`select id from test_set where name = 'Smoke' and project_id = (select id from project where key = 'PK')`)[0]!.id] }, options: { executions: false } })).body;
    const res = await env.app.request(`/api/project-transfers/${req.id}/download`, { headers: { 'x-anemo-user': 'tester' } });
    const r = await run(Buffer.from(await res.arrayBuffer()), into('ZIEL', { target: { mode: 'existing', key: 'ZIEL', folderId: target } }));
    assert.deepEqual(r.problems, []);
    const folders = await env.db`select f.name, p.name as parent from folder f left join folder p on p.id = f.parent_id where f.project_id = (select id from project where key = 'ZIEL') order by f.name`;
    assert.deepEqual(folders.map((f) => `${f.parent ?? '-'}/${f.name}`), ['Übernommen/Akten', '-/Übernommen']);
    const keys = (await env.db`select key from test_case where project_id = (select id from project where key = 'ZIEL') order by key`).map((t) => t.key);
    assert.deepEqual(keys, ['ZIEL-T1', 'ZIEL-T2']);
    const sets = await env.db`select test_case_ids from test_set where project_id = (select id from project where key = 'ZIEL') and name = 'Smoke'`;
    assert.equal(sets.length, 1, 'zusammengeführt statt doppelt');
    assert.equal(sets[0]!.testCaseIds.length, 0, 'das Testset im Ziel ist neuer und bleibt');
    assert.equal(r.changes['test-sets'].skipped, 1);
  });
});

describe('Projektpaket: Hintergrundaufträge (Stufe K5)', () => {
  let env: TestEnv;
  let dir: string;
  const poll = async (path: string, done: (b: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const r = await env.call('GET', path);
      const row = Array.isArray(r.body) ? r.body[0] : r.body;
      if (done(row)) return row;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    throw new Error(`Zeitüberschreitung: ${path}`);
  };

  before(async () => {
    env = await testEnv();
    dir = await mkdtemp(join(tmpdir(), 'anemo-transfer-'));
    process.env.ANEMO_TRANSFER_DIR = dir;
    await seedProject(env);
  });
  after(async () => { delete process.env.ANEMO_TRANSFER_DIR; await env.close(); await rm(dir, { recursive: true, force: true }); });

  it('freigegebener Export entsteht im Hintergrund und ist danach mehrfach abrufbar', async () => {
    const t = (await env.call('POST', '/api/projects/PK/exports', {})).body;
    const ready = await poll('/api/project-transfers', (r) => r.id === t.id && r.status === 'ready');
    assert.equal(ready.counts['test-cases'], 2);
    assert.match(ready.packageSha256, /^[0-9a-f]{64}$/);
    assert.equal(ready.progress, null);
    for (let i = 0; i < 2; i++) {
      const res = await env.app.request(`/api/project-transfers/${t.id}/download`, { headers: { 'x-anemo-user': 'tester' } });
      assert.equal(res.status, 200);
      assert.equal(sha(Buffer.from(await res.arrayBuffer())), ready.packageSha256);
    }
    assert.equal((await env.db`select downloads from project_transfer where id = ${t.id}`)[0]!.downloads, 2);
  });

  it('Einspielen im Hintergrund: 202, Fortschritt im Vorgang, Bericht am Ende', async () => {
    const pkg = await exportBytes(env, 'PK');
    const res = await env.app.request('/api/package-imports', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-anemo-user': 'tester' }, body: new Uint8Array(pkg) });
    const id = ((await res.json()) as any).transfer.id;
    const started = await env.call('POST', `/api/package-imports/${id}/apply?background=true`, { target: { key: 'HINTER', name: 'Hintergrund' } });
    assert.equal(started.status, 202);
    assert.equal(started.body.status, 'running');
    assert.equal((await env.call('POST', `/api/package-imports/${id}/apply`, { target: { key: 'HINTER2', name: 'x' } })).status, 409, 'nicht doppelt');
    const done = await poll(`/api/package-imports/${id}`, (r) => r.status === 'done');
    assert.equal(done.report.counts['test-cases'], 2);
    assert.equal(done.projectKey, 'HINTER');
    assert.equal((await env.call('GET', '/api/test-cases/HINTER-T2')).status, 200);
  });

  it('liegendes Paket lässt sich wieder aufnehmen: Übersicht und Vorschlag für das Ziel', async () => {
    const pkg = await exportBytes(env, 'PK');
    const res = await env.app.request('/api/package-imports', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-anemo-user': 'tester' }, body: new Uint8Array(pkg) });
    const id = ((await res.json()) as any).transfer.id;
    const t = (await env.call('GET', `/api/package-imports/${id}`)).body;
    assert.equal(t.options.package.project.key, 'PK');
    assert.equal(t.options.package.counts['test-cases'], 2);
    assert.ok(t.options.package.persons.some((p: any) => p.login === 'tester'));
    assert.deepEqual(t.suggestedTarget, { key: '', name: 'Paket' });
  });

  it('Aufräumen: abgelaufene Pakete verschwinden aus dem Arbeitsverzeichnis', async () => {
    const { cleanupTransferFiles } = await import('../src/modules/transfer/index.ts');
    const { readdir } = await import('node:fs/promises');
    const t = (await env.call('POST', '/api/projects/PK/exports', {})).body;
    await poll('/api/project-transfers', (r) => r.id === t.id && r.status === 'ready');
    const pkg = await exportBytes(env, 'PK');
    const res = await env.app.request('/api/package-imports', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-anemo-user': 'tester' }, body: new Uint8Array(pkg) });
    const imp = ((await res.json()) as any).transfer.id;
    assert.ok((await readdir(dir)).includes(`anemo-export-${t.id}.zip`));
    assert.ok((await readdir(dir)).includes(`anemo-import-${imp}.zip`));
    await env.db`update project_transfer set expires_at = now() - interval '1 minute' where id in (${t.id}, ${imp})`;
    await cleanupTransferFiles(env.db);
    const files = await readdir(dir);
    assert.ok(!files.includes(`anemo-export-${t.id}.zip`), 'Export entfernt');
    assert.ok(!files.includes(`anemo-import-${imp}.zip`), 'Import entfernt');
    assert.equal((await env.db`select status from project_transfer where id = ${imp}`)[0]!.status, 'failed');
  });

  it('Hinderungsgrund im Hintergrund: Paket bleibt einspielbar, Bericht nennt den Grund', async () => {
    const pkg = await exportBytes(env, 'PK');
    const res = await env.app.request('/api/package-imports', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-anemo-user': 'tester' }, body: new Uint8Array(pkg) });
    const id = ((await res.json()) as any).transfer.id;
    assert.equal((await env.call('POST', `/api/package-imports/${id}/apply?background=true`, { target: { key: 'PK', name: 'belegt' } })).status, 202);
    const back = await poll(`/api/package-imports/${id}`, (r) => r.status === 'pending' && r.report);
    assert.match(back.error, /PK gibt es bereits/);
    assert.equal((await env.call('POST', `/api/package-imports/${id}/apply`, { target: { key: 'FREI', name: 'frei' } })).status, 200);
  });
});

describe('Projektpaket: MCP-Werkzeuge (Stufe K5)', () => {
  let env: TestEnv;
  let dir: string;
  let n = 0;
  const tool = async (name: string, args: object) => {
    const res = await env.app.request('/api/mcp', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-anemo-user': 'tester' },
    });
    const result = ((await res.json()) as any).result;
    const text = result.content[0].text as string;
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* Fehlertext */ }
    return { error: !!result.isError, text, data };
  };

  before(async () => {
    env = await testEnv();
    dir = await mkdtemp(join(tmpdir(), 'anemo-transfer-'));
    process.env.ANEMO_TRANSFER_DIR = dir;
    await seedProject(env);
    await env.call('PUT', '/api/projects/XX/external-services', { externalServices: 'blocked' });
  });
  after(async () => { delete process.env.ANEMO_TRANSFER_DIR; await env.close(); await rm(dir, { recursive: true, force: true }); });

  it('Export anfordern, Stand abfragen, Probelauf und Einspielen nur mit Bestätigung', async () => {
    const ex = await tool('project_export', { project: 'PK', testCases: ['PK-T2'], versions: 'current' });
    assert.equal(ex.error, false, ex.text);
    assert.equal(ex.data.summary['test-cases'], 2);
    assert.match(ex.data.downloadPath, /^\/api\/project-transfers\/.+\/download$/);
    const list = await tool('project_transfers', {});
    assert.equal(list.data[0].id, ex.data.id);
    const pkg = await env.app.request(ex.data.downloadPath, { headers: { 'x-anemo-user': 'tester' } });
    const up = await env.app.request('/api/package-imports', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-anemo-user': 'tester' }, body: new Uint8Array(await pkg.arrayBuffer()) });
    const importId = ((await up.json()) as any).transfer.id;
    const preview = await tool('project_import_preview', { importId, mode: 'new', key: 'AGENT', name: 'Vom Agenten' });
    assert.equal(preview.error, false, preview.text);
    assert.equal(preview.data.dryRun, true);
    const refused = await tool('project_import_apply', { importId, mode: 'new', key: 'AGENT', name: 'Vom Agenten', confirm: false });
    assert.equal(refused.error, true);
    assert.match(refused.text, /confirm: true/);
    const applied = await tool('project_import_apply', { importId, mode: 'new', key: 'AGENT', name: 'Vom Agenten', confirm: true });
    assert.equal(applied.error, false, applied.text);
    assert.equal(applied.data.counts['test-cases'], 2);
  });

  it('Projekte mit gesperrten externen Diensten sind für Agenten nicht exportierbar', async () => {
    const r = await tool('project_export', { project: 'XX' });
    assert.equal(r.error, true);
    assert.match(r.text, /404|gesperrt|nicht vorhanden/);
  });
});

describe('Projektpaket: Kommandozeile tools/project-package.ts (Stufe K5)', () => {
  let env: TestEnv;
  let dir: string;
  let server: { close: (cb?: () => void) => void };
  let url = '';
  const out: string[] = [];
  const io = { log: (s: string) => out.push(s), error: (s: string) => out.push(`FEHLER ${s}`), sleep: (ms: number) => new Promise<void>((ok) => setTimeout(ok, Math.min(ms, 50))) };

  before(async () => {
    env = await testEnv();
    dir = await mkdtemp(join(tmpdir(), 'anemo-transfer-'));
    process.env.ANEMO_TRANSFER_DIR = dir;
    await seedProject(env);
    const { serve } = await import('@hono/node-server');
    await new Promise<void>((ok) => {
      server = serve({ fetch: env.app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => { url = `http://127.0.0.1:${info.port}`; ok(); }) as never;
    });
  });
  after(async () => {
    delete process.env.ANEMO_TRANSFER_DIR;
    await new Promise<void>((ok) => server.close(() => ok()));
    await env.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('export → Datei mit geprüfter Prüfsumme; import als neues Projekt mit Fortschritt; Probelauf in bestehendes', async () => {
    const { run } = await import('../../tools/project-package.ts');
    const conn = ['--url', url, '--token', 'anemo_test_token_ohne_bedeutung_im_modus_off'];
    const file = join(dir, 'paket.anemo.zip');
    assert.equal(await run(['export', '--project', 'PK', '--out', file, ...conn], io, {}), 0, out.join('\n'));
    assert.ok(out.some((l) => l.startsWith(`Gespeichert: ${file}`)));
    out.length = 0;
    assert.equal(await run(['import', '--file', file, '--new', 'CLI', '--name', 'Von der Kommandozeile', ...conn], io, {}), 0, out.join('\n'));
    assert.ok(out.some((l) => /Eingespielt: PK → CLI/.test(l)), out.join('\n'));
    assert.equal((await env.call('GET', '/api/test-cases/CLI-T2')).status, 200);
    out.length = 0;
    assert.equal(await run(['import', '--file', file, '--into', 'CLI', '--dry-run', ...conn], io, {}), 0, out.join('\n'));
    assert.ok(out.some((l) => /Probelauf: PK → CLI \(bestehendes Projekt\)/.test(l)));
    out.length = 0;
    assert.equal(await run(['import', '--file', file, '--new', 'PK', '--name', 'x', ...conn], io, {}), 1, 'belegter Schlüssel');
    assert.ok(out.some((l) => /Hinderungsgrund: Projekt PK gibt es bereits/.test(l)));
    assert.equal(await run(['export', ...conn], io, {}), 1);
    assert.equal(await run(['export', '--project', 'PK'], io, {}), 1, 'ohne Verbindung');
  });
});

describe('Projektpaket: Ausführungen mit Testfällen anderer Projekte (Realbestand aus Zephyr)', () => {
  let env: TestEnv;
  let dir: string;
  let foreignId = '';
  const upload = async (body: Buffer) => {
    const res = await env.app.request('/api/package-imports', { method: 'POST', headers: { 'content-type': 'application/zip', 'x-anemo-user': 'tester' }, body: new Uint8Array(body) });
    const j = (await res.json()) as any;
    assert.equal(res.status, 201, JSON.stringify(j));
    return j.transfer.id as string;
  };

  before(async () => {
    env = await testEnv();
    dir = await mkdtemp(join(tmpdir(), 'anemo-transfer-'));
    process.env.ANEMO_TRANSFER_DIR = dir;
    const ids = await seedProject(env);
    // wie migriert: Zyklus in PK enthält einen Testfall aus XX (in Version 2)
    const [x] = await env.db`select id from test_case where key = 'XX-T1'`;
    foreignId = x!.id;
    const tc = (await env.call('GET', '/api/test-cases/XX-T1')).body;
    await env.call('PUT', `/api/test-cases/${foreignId}/content`, { expectedVersion: 1, content: { ...tc.version, title: 'Gehört nicht dazu (v2)' } });
    const [v2] = await env.db`select id from test_case_version where test_case_id = ${foreignId} and version_no = 2`;
    await env.db`insert into test_execution(cycle_id, test_case_id, test_case_version_id, order_no, status) values (${ids.cycle!}, ${foreignId}, ${v2!.id}, 9, 'PASS')`;
  });
  after(async () => { delete process.env.ANEMO_TRANSFER_DIR; await env.close(); await rm(dir, { recursive: true, force: true }); });

  it('Export nimmt den fremden Testfall mit der ausgeführten Version mit und sagt es', async () => {
    const pkg = await readPackage(dir, await exportBytes(env, 'PK'));
    try {
      const m = await pkg.json('manifest.json');
      assert.equal(m.formatVersion, '1.3.0');
      assert.ok(m.warnings.some((w: string) => /1 Testfälle aus anderen Projekten \(XX\)/.test(w)), JSON.stringify(m.warnings));
      assert.deepEqual((await pkg.ndjson('foreign-test-cases.ndjson')).map((t: any) => t.key), ['XX-T1']);
      assert.deepEqual((await pkg.ndjson('foreign-test-case-versions.ndjson')).map((v: any) => v.versionNo), [2]);
      assert.equal((await pkg.ndjson('executions.ndjson')).length, 2);
      assert.deepEqual((await pkg.ndjson('test-cases.ndjson')).map((t: any) => t.key).sort(), ['PK-T1', 'PK-T2'], 'eigene Testfälle unverändert');
    } finally { await pkg.z.close(); }
  });

  it('gleiche Instanz: die Kopie verweist auf den vorhandenen fremden Testfall, nichts geht verloren', async () => {
    const id = await upload(await exportBytes(env, 'PK'));
    const r = await env.call('POST', `/api/package-imports/${id}/apply`, { target: { key: 'GLEICH', name: 'Gleiche Instanz' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.counts.executions, 2);
    const ex = await env.db`select e.test_case_id from test_execution e join test_cycle c on c.id = e.cycle_id where c.project_id = (select id from project where key = 'GLEICH') order by e.order_no`;
    assert.equal(ex[1]!.testCaseId, foreignId);
    assert.equal((await env.db`select count(*)::int as n from test_case where project_id = (select id from project where key = 'GLEICH')`)[0]!.n, 2, 'keine Kopie');
  });

  it('andere Instanz: fremder Testfall wird als Kopie mit neuem Schlüssel angelegt, aktuelle Version ist die ausgeführte', async () => {
    const other = await repack(dir, await exportBytes(env, 'PK'), (_f, m) => { m.sourceInstance = '00000000-0000-7000-8000-000000000001'; });
    const id = await upload(other);
    const r = await env.call('POST', `/api/package-imports/${id}/apply`, { target: { key: 'FERN', name: 'Andere Instanz' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.counts.executions, 2);
    assert.ok(r.body.warnings.some((w: string) => /als Kopie angelegt/.test(w)));
    const tcs = await env.db`select key, current_version from test_case where project_id = (select id from project where key = 'FERN') order by key`;
    assert.deepEqual(tcs.map((t) => `${t.key}:${t.currentVersion}`), ['FERN-T1:1', 'FERN-T2:2', 'FERN-T3:2']);
    assert.equal((await env.db`select next_number from project where key = 'FERN'`)[0]!.nextNumber, 4);
    // zweiter Import derselben Quelle: Kopie wird wiedererkannt
    const again = await env.call('POST', `/api/package-imports/${await upload(other)}/apply`, { target: { mode: 'existing', key: 'FERN' } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    for (const [type, c] of Object.entries(again.body.changes) as [string, any][]) assert.equal(c.created, 0, `${type}: nichts neu`);
  });
});
