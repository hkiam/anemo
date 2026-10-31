/**
 * Projektpaket: Sicherheitsbefunde aus dem Review vom 30.10.2026 als Regressionstests (Modus on). Angreifer „mal“ hat das
 * Recht „Projekte übertragen“ und ist Projektadministration nur in OWN; GEH ist ein eingeschränktes Projekt ohne ihn.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { bootstrapAdmin } from '../src/modules/auth/index.ts';
import { TYPES } from '../src/modules/transfer/format.ts';
import { openZip, zipStream } from '../src/platform/zip.ts';
import { type TestEnv, testEnv } from './helpers.ts';

const PW = 'Sicheres-Passwort-1';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const ndjson = (rows: unknown[]) => Buffer.from(rows.map((r) => `${JSON.stringify(r)}\n`).join(''));

describe('Projektpaket: Sicherheit beim Import (Review 30.10.2026)', () => {
  let env: TestEnv;
  let dir: string;
  const cookies = new Map<string, string>();
  const req = async (u: string, method: string, path: string, body?: unknown, zip?: Buffer) => {
    const headers: Record<string, string> = { 'content-type': zip ? 'application/zip' : 'application/json', host: 'anemo.test' };
    if (cookies.get(u)) headers.cookie = cookies.get(u)!;
    const res = await env.app.request(path, { method, headers, body: zip ? new Uint8Array(zip) : body === undefined ? undefined : JSON.stringify(body) });
    const ct = res.headers.get('content-type') ?? '';
    return { status: res.status, cookie: res.headers.get('set-cookie'), body: ct.includes('json') ? (await res.json()) as any : null, raw: ct.includes('zip') ? Buffer.from(await res.arrayBuffer()) : null };
  };
  const login = async (u: string) => cookies.set(u, (await req('', 'POST', '/api/auth/login', { username: u, password: PW })).cookie!.split(';')[0]!);
  const ownPackage = async () => {
    const t = (await req('mal', 'POST', '/api/projects/OWN/exports', {})).body;
    return (await req('mal', 'GET', `/api/project-transfers/${t.id}/download`)).raw!;
  };
  /** Paket öffnen, verändern und mit stimmigen Prüfsummen neu packen – so, wie es ein Angreifer könnte */
  const forge = async (pkg: Buffer, mutate: (files: Map<string, Buffer>) => void) => {
    const p = join(dir, `${crypto.randomUUID()}.zip`);
    await writeFile(p, pkg);
    const z = await openZip(p);
    const files = new Map<string, Buffer>();
    for (const n of z.entries.keys()) files.set(n, await z.read(n));
    await z.close();
    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    mutate(files);
    manifest.files = [...files.keys()].filter((n) => !n.startsWith('manifest.')).map((path) => ({ path, sha256: sha(files.get(path)!), size: files.get(path)!.length }));
    const text = JSON.stringify(manifest);
    files.set('manifest.json', Buffer.from(text));
    files.set('manifest.sha256', Buffer.from(`${sha(text)}  manifest.json\n`));
    const parts: Buffer[] = [];
    for await (const c of zipStream([...files].map(([name, data]) => ({ name, data })))) parts.push(c);
    return Buffer.concat(parts);
  };
  const upload = async (pkg: Buffer) => {
    const up = await req('mal', 'POST', '/api/package-imports', undefined, pkg);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    return up.body.transfer.id as string;
  };
  const geh = async () => (await env.db`select t.id, t.archived_at, t.folder_id, v.id as vid, v.title, v.steps from test_case t join test_case_version v on v.test_case_id = t.id where t.key = 'GEH-T1'`)[0]!;

  before(async () => {
    env = await testEnv({ authMode: 'on' });
    dir = await mkdtemp(join(tmpdir(), 'anemo-transfer-sec-'));
    process.env.ANEMO_TRANSFER_DIR = dir;
    process.env.ANEMO_ADMIN_PASSWORD = PW;
    await bootstrapAdmin(env.db, '/dev/null', () => {});
    await login('admin');
    const uid = (await req('admin', 'POST', '/api/admin/users', { username: 'mal', displayName: 'Mal', password: PW })).body.id;
    await login('mal');
    await req('admin', 'PUT', '/api/admin/permissions', { principalType: 'user', principalId: uid, permission: 'PROJECT_TRANSFER', granted: true });
    await req('admin', 'POST', '/api/projects', { key: 'OWN', name: 'Eigenes' });
    await req('admin', 'PUT', '/api/projects/OWN/members', { principalType: 'user', principalId: uid, role: 'PROJECT_ADMIN' });
    await req('admin', 'POST', '/api/projects/OWN/test-cases', { content: { title: 'Eigener Fall', steps: [{ action: 'a', expected: 'b' }] } });
    const cyc = (await req('admin', 'POST', '/api/projects/OWN/cycles', { name: 'Lauf' })).body.id;
    await req('admin', 'POST', `/api/cycles/${cyc}/executions`, { testCaseIds: ['OWN-T1'] });
    await req('admin', 'POST', '/api/projects', { key: 'GEH', name: 'Geheim' });
    await req('admin', 'PUT', '/api/projects/GEH/visibility', { visibility: 'restricted' });
    await req('admin', 'POST', '/api/projects/GEH/test-cases', { content: { title: 'Geheimer Fall', steps: [{ action: 'geheim', expected: 'x' }] } });
    assert.ok((await req('mal', 'GET', '/api/test-cases/GEH-T1')).status >= 400, 'mal darf GEH nicht lesen');
  });
  after(async () => { delete process.env.ANEMO_TRANSFER_DIR; await env.close(); await rm(dir, { recursive: true, force: true }); });

  it('S1: fremde Testfälle sind nie veränderbar – auch nicht mit eingeschleusten Zeilen und Regel „aktualisieren“', async () => {
    const before = await geh();
    const spec = (n: string) => TYPES.find((x) => x.name === n)!;
    const [tc] = await env.db.unsafe(`select ${spec('foreign-test-cases').columns.join(',')} from test_case where key = 'GEH-T1'`);
    const [v] = await env.db.unsafe(`select ${spec('foreign-test-case-versions').columns.join(',')} from test_case_version where test_case_id = $1`, [tc!.id]);
    const pkg = await forge(await ownPackage(), (files) => {
      files.set('foreign-test-cases.ndjson', ndjson([{ ...tc, archivedAt: new Date().toISOString(), updatedAt: '2999-01-01T00:00:00Z' }]));
      files.set('foreign-test-case-versions.ndjson', ndjson([{ ...v, title: 'MANIPULIERT', steps: [{ action: 'manipuliert', expected: 'y' }] }]));
    });
    const id = await upload(pkg);
    // Regeln für fremde Objektarten gibt es nicht
    const bad = await req('mal', 'POST', `/api/package-imports/${id}/apply`, { target: { mode: 'existing', key: 'OWN' },
      conflicts: { 'foreign-test-cases': 'update', 'foreign-test-case-versions': 'update' } });
    assert.equal(bad.status, 400);
    const r = await req('mal', 'POST', `/api/package-imports/${id}/apply`, { target: { mode: 'existing', key: 'OWN' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await geh(), before, 'GEH-T1 unverändert');
  });

  it('S2: ein Paket bindet keine Testfälle fremder, nicht lesbarer Projekte ein – es verweist auf eine lesbare Kopie', async () => {
    const g = await geh();
    const pkg = await forge(await ownPackage(), (files) => {
      files.set('foreign-test-cases.ndjson', ndjson([{ id: g.id, key: 'GEH-T1', status: 'DRAFT', currentVersion: 1, createdAt: '2026-01-01' }]));
      files.set('foreign-test-case-versions.ndjson', ndjson([{ id: g.vid, testCaseId: g.id, versionNo: 1, title: 'nur geraten', createdAt: '2026-01-01' }]));
      const ex = files.get('executions.ndjson')!.toString().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      files.set('executions.ndjson', ndjson(ex.map((e) => ({ ...e, id: '0199aaaa-0000-7000-8000-000000000001', testCaseId: g.id, testCaseVersionId: g.vid }))));
    });
    const r = await req('mal', 'POST', `/api/package-imports/${await upload(pkg)}/apply`, { target: { key: 'NEU', name: 'Neu' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [e] = await env.db`select e.test_case_id, e.test_case_version_id from test_execution e join test_cycle c on c.id = e.cycle_id
      where c.project_id = (select id from project where key = 'NEU') and e.test_case_id <> (select id from test_case where key = 'NEU-T1')`;
    assert.notEqual(e!.testCaseId, g.id, 'kein Verweis auf GEH-T1');
    assert.notEqual(e!.testCaseVersionId, g.vid);
    const [copy] = await env.db`select p.key as project, v.title from test_case t join project p on p.id = t.project_id join test_case_version v on v.id = ${e!.testCaseVersionId} where t.id = ${e!.testCaseId}`;
    // eine Kopie in einem Projekt, das mal lesen darf (hier die aus S1 bekannte Kopie in OWN) – nie GEH und nie dessen Inhalt
    assert.ok(['NEU', 'OWN'].includes(copy!.project as string), copy!.project as string);
    assert.notEqual(copy!.title, 'Geheimer Fall');
  });

  it('S3/S5: ohne Systemadministration keine Anbindungen und Webhooks, keine Freigaben aus dem Paket', async () => {
    await req('admin', 'PUT', '/api/projects/OWN/integrations/gitlab', { externalProject: 'gruppe/repo' });
    await env.db`update test_case set approved_version = 1, approved_by = 'admin', approved_at = now() where key = 'OWN-T1'`;
    const r = await req('mal', 'POST', `/api/package-imports/${await upload(await ownPackage())}/apply`, { target: { key: 'NEU2', name: 'Neu 2' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await env.db`select count(*)::int as n from project_integration where project_id = (select id from project where key = 'NEU2')`)[0]!.n, 0);
    assert.ok(r.body.warnings.some((w: string) => /Anbindungen und Webhooks richtet die Systemadministration ein/.test(w)));
    const [t] = await env.db`select approved_version, approved_by from test_case where key = 'NEU2-T1'`;
    assert.deepEqual({ ...t }, { approvedVersion: null, approvedBy: null });
    assert.ok(r.body.warnings.some((w: string) => /Freigabe eines Testfalls nicht übernommen/.test(w)));
  });

  it('S4: von Webhooks verlässt nur der Host der Adresse die Instanz (Chat-Dienste tragen das Geheimnis im Pfad)', async () => {
    const w = await req('admin', 'POST', '/api/admin/webhooks', { name: 'Teams', url: 'https://chat.example.com/hooks/GEHEIM-TOKEN-123?sig=abc', format: 'chat', eventTypes: [], projectKey: 'OWN', active: true });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    const pkg = await ownPackage();
    const p = join(dir, 'webhook.zip');
    await writeFile(p, pkg);
    const z = await openZip(p);
    const hooks = (await z.read('webhooks.ndjson')).toString();
    await z.close();
    assert.match(hooks, /"url":"https:\/\/chat\.example\.com\/"/);
    assert.doesNotMatch(pkg.toString('latin1'), /GEHEIM-TOKEN-123/);
  });

  it('S7: Verweise aus dem Paket nur mit http(s)-Adressen', async () => {
    const tcId = (await env.db`select id from test_case where key = 'OWN-T1'`)[0]!.id;
    const pkg = await forge(await ownPackage(), (files) => {
      files.set('references.ndjson', ndjson([{ id: '0199bbbb-0000-7000-8000-000000000001', ownerType: 'TEST_CASE', ownerId: tcId, provider: 'jenkins', externalKey: 'build-1',
        relation: 'AUTOMATION', url: 'javascript:alert(1)', title: 'x', status: null, stepId: null, severity: null, createdAt: '2026-01-01T00:00:00Z', createdBy: 'mal' }]));
    });
    const r = await req('mal', 'POST', `/api/package-imports/${await upload(pkg)}/apply`, { target: { key: 'NEU3', name: 'Neu 3' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [ref] = await env.db`select url from external_reference where external_key = 'build-1'`;
    assert.equal(ref!.url, null);
  });
});
