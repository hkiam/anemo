import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

const PW = 'Sicheres-Passwort-1';

describe('Ausführung nur durch Zuständige (Modus on)', () => {
  let env: TestEnv;
  const cookies = new Map<string, string>();
  const req = async (user: string, method: string, path: string, body?: unknown) => {
    const res = await env.app.request(path, { method, headers: { 'content-type': 'application/json', host: 'anemo.test', cookie: cookies.get(user) ?? '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') };
  };
  const login = async (u: string) => cookies.set(u, (await req('', 'POST', '/api/auth/login', { username: u, password: PW })).setCookie!.split(';')[0]!);
  let ids: string[] = [];

  before(async () => {
    env = await testEnv({ authMode: 'on' });
    process.env.ANEMO_ADMIN_PASSWORD = PW;
    const { bootstrapAdmin } = await import('../src/modules/auth/index.ts');
    await bootstrapAdmin(env.db, '/dev/null', () => {});
    delete process.env.ANEMO_ADMIN_PASSWORD;
    await login('admin');
    const uid: Record<string, string> = {};
    for (const u of ['tina', 'tom', 'lea']) { uid[u] = (await req('admin', 'POST', '/api/admin/users', { username: u, displayName: u, password: PW })).body.id; await login(u); }
    await req('admin', 'POST', '/api/projects', { key: 'ZU', name: 'Zuständig' });
    for (const [u, role] of [['tina', 'TESTER'], ['tom', 'TESTER'], ['lea', 'DESIGNER']] as const) await req('admin', 'PUT', '/api/projects/ZU/members', { principalType: 'user', principalId: uid[u], role });
    for (const t of ['A', 'B']) await req('admin', 'POST', '/api/projects/ZU/test-cases', { content: { title: t, steps: [] } });
    const c = (await req('admin', 'POST', '/api/projects/ZU/cycles', { name: 'Lauf' })).body;
    await req('admin', 'POST', `/api/cycles/${c.id}/executions`, { testCaseIds: ['ZU-T1', 'ZU-T2'] });
    ids = (await req('admin', 'GET', `/api/cycles/${c.id}/executions`)).body.items.map((e: any) => e.id);
    await req('admin', 'POST', '/api/executions/bulk-assign', { ids: [ids[0]], assignee: 'tina' });
  });
  after(() => env.close());

  it('ohne Projektregel darf jede Person mit „Ausführen“ erfassen', async () => {
    assert.equal((await req('tom', 'POST', `/api/executions/${ids[0]}/result`, { status: 'PASS' })).status, 200);
  });
  it('mit Projektregel: nur Zuständige, nicht zugewiesene bleiben offen, Testleitung ausgenommen', async () => {
    assert.equal((await req('admin', 'PUT', '/api/projects/ZU/settings', { executeOnlyAssignee: true })).status, 200);
    const denied = await req('tom', 'POST', `/api/executions/${ids[0]}/result`, { status: 'FAIL', comment: 'x' });
    assert.equal(denied.status, 403);
    assert.match(denied.body.detail, /ZU-T1 \(tina\)/);
    assert.equal((await req('tom', 'POST', '/api/executions/bulk', { ids, status: 'PASS' })).status, 403, 'auch per Massenbearbeitung');
    assert.equal((await req('tom', 'POST', `/api/executions/${ids[1]}/result`, { status: 'PASS' })).status, 200, 'nicht zugewiesen');
    assert.equal((await req('tina', 'POST', `/api/executions/${ids[0]}/result`, { status: 'FAIL', comment: 'Absturz' })).status, 200);
    assert.equal((await req('lea', 'POST', `/api/executions/${ids[0]}/result`, { status: 'PASS' })).status, 200, 'Testleitung');
    assert.equal((await req('tom', 'POST', '/api/executions/bulk', { ids: [ids[1]], assignee: 'tom' })).status, 200, 'Zuweisen bleibt erlaubt');
  });
});
