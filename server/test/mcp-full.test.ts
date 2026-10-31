import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

/** MCP mit echten Rechten: Fachwerkzeuge für Projekte/Testfälle/Planung und Vollzugriff (api_operations/api_call) bis zur Administration. */
describe('MCP: alles, was die Oberfläche kann – mit den Rechten des Token-Benutzers', () => {
  let env: TestEnv;
  const PW = 'Sehr-geheim-12345';
  const cookies = new Map<string, string>();
  const tokens = new Map<string, string>();
  let n = 0;
  const req = async (user: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await env.app.request(path, { method, headers: { 'content-type': 'application/json', host: 'anemo.test', ...(user && cookies.has(user) ? { cookie: cookies.get(user)! } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') };
  };
  const login = async (u: string) => { const r = await req(null, 'POST', '/api/auth/login', { username: u, password: PW }); cookies.set(u, r.setCookie!.split(';')[0]!); };
  const tool = async (user: string, name: string, args: object) => {
    const r = await req(null, 'POST', '/api/mcp', { jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }, { authorization: `Bearer ${tokens.get(user)}` });
    const result = r.body.result;
    return { error: !!result.isError, text: result.content[0].text as string, data: result.structuredContent };
  };

  before(async () => {
    env = await testEnv({ authMode: 'on' });
    process.env.ANEMO_ADMIN_PASSWORD = PW;
    const { bootstrapAdmin } = await import('../src/modules/auth/index.ts');
    await bootstrapAdmin(env.db, '/dev/null', () => {});
    delete process.env.ANEMO_ADMIN_PASSWORD;
    await login('admin');
    const t = await req('admin', 'POST', '/api/admin/users', { username: 'tess', displayName: 'Tess', password: PW });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    await login('tess');
    for (const u of ['admin', 'tess']) tokens.set(u, (await req(u, 'POST', '/api/auth/tokens', { name: 'mcp', expiresDays: 1 })).body.token);
  });
  after(() => env.close());

  it('Projekt, Testfall (mit Abschnitt), Änderung, Status, Testplan, Zyklus, Aufnahme, Zuweisung über Fachwerkzeuge', async () => {
    assert.equal((await tool('admin', 'create_project', { key: 'MF', name: 'MCP voll' })).error, false);
    const tc = await tool('admin', 'create_test_case', { project: 'MF', title: 'Akte anlegen', objective: 'Ziel', steps: [
      { section: 'Vorbereitung' }, { action: 'Anmelden', expected: 'Start' }, { action: 'Akte anlegen', expected: 'angelegt' }] });
    assert.equal(tc.error, false, tc.text);
    assert.equal(tc.data.key, 'MF-T1');
    const upd = await tool('admin', 'update_test_case', { key: 'MF-T1', title: 'Akte anlegen (neu)', changeNote: 'per MCP' });
    assert.equal(upd.data.version, 2, upd.text);
    const v = (await req('admin', 'GET', '/api/test-cases/MF-T1')).body.version;
    assert.deepEqual([v.title, v.objective, v.steps.length, v.steps[0].kind, v.steps[0].title], ['Akte anlegen (neu)', 'Ziel', 3, 'group', 'Vorbereitung']);
    assert.equal((await tool('admin', 'set_test_case_status', { key: 'MF-T1', estimateMinutes: 15 })).error, false);
    const plan = await tool('admin', 'create_plan', { project: 'MF', name: 'Release 1' });
    const cycle = await tool('admin', 'create_cycle', { project: 'MF', name: 'Lauf 1', planId: plan.data.id });
    assert.equal(cycle.error, false, cycle.text);
    const cycleId = (cycle.data.cycle?.id ?? cycle.data.id) as string;
    assert.equal((await tool('admin', 'add_tests_to_cycle', { cycleId, testCases: ['MF-T1'] })).error, false);
    const exec = (await req('admin', 'GET', `/api/cycles/${cycleId}/executions`)).body.items[0].id;
    assert.equal((await tool('admin', 'assign_executions', { executionIds: [exec], assignee: 'tess' })).error, false);
    assert.equal((await req('admin', 'GET', `/api/executions/${exec}`)).body.assignee, 'tess');
  });

  it('Vollzugriff: Admin findet und nutzt Administrationsfunktionen; Löschen nur mit Bestätigung', async () => {
    const ops = await tool('admin', 'api_operations', { query: '/api/admin/users' });
    assert.ok(ops.data.operations.some((o: { op: string }) => o.op === 'POST /api/admin/users'));
    const detail = await tool('admin', 'api_operations', { operation: 'POST /api/admin/users' });
    assert.ok(detail.data.body, 'Eingabeschema');
    // Administration ändert Konten und Rechte: nur mit ausdrücklicher Bestätigung
    const userBody = { username: 'bob', displayName: 'Bob', password: PW };
    const unconfirmed = await tool('admin', 'api_call', { method: 'POST', path: '/api/admin/users', body: userBody });
    assert.equal(unconfirmed.error, true);
    assert.match(unconfirmed.text, /confirm: true/);
    const u = await tool('admin', 'api_call', { method: 'POST', path: '/api/admin/users', body: userBody, confirm: true });
    assert.equal(u.error, false, u.text);
    // Rolle im Projekt vergeben (wie in der Oberfläche) – ebenfalls mit Bestätigung
    assert.match((await tool('admin', 'api_call', { method: 'PUT', path: '/api/projects/MF/members', body: { principalType: 'user', principalId: u.data.id, role: 'TESTER' } })).text, /confirm: true/);
    const r = await tool('admin', 'api_call', { method: 'PUT', path: '/api/projects/MF/members', body: { principalType: 'user', principalId: u.data.id, role: 'TESTER' }, confirm: true });
    assert.equal(r.error, false, r.text);
    // keine API-Tokens und keine Kennwörter anderer Konten über MCP
    assert.match((await tool('admin', 'api_call', { method: 'POST', path: '/api/auth/tokens', body: { name: 'x' } })).text, /Keine Funktion|nicht verfügbar/);
    assert.match((await tool('admin', 'api_call', { method: 'PUT', path: `/api/admin/users/${u.data.id}/password`, body: { generate: true }, confirm: true })).text, /Keine Funktion|nicht verfügbar/);
    const tc2 = await tool('admin', 'create_test_case', { project: 'MF', title: 'Weg damit' });
    const del = await tool('admin', 'api_call', { method: 'DELETE', path: `/api/test-cases/${tc2.data.id}` });
    assert.equal(del.error, true);
    assert.match(del.text, /confirm: true/);
    assert.equal((await tool('admin', 'api_call', { method: 'DELETE', path: `/api/test-cases/${tc2.data.id}`, confirm: true })).error, false);
    // Berichte als Text
    const plans = (await req('admin', 'GET', '/api/projects/MF/plans')).body;
    const rep = await tool('admin', 'api_call', { method: 'GET', path: `/api/reports/completion/${plans[0].id}`, query: { format: 'md' } });
    assert.equal(rep.error, false, rep.text);
    assert.match(rep.data.text, /^# /m);
  });

  it('ohne Adminrechte: keine Administrationsfunktionen, Projektrechte gelten, Anmeldung/Kennwort gesperrt', async () => {
    const ops = await tool('tess', 'api_operations', { limit: 300 });
    assert.ok(!ops.data.operations.some((o: { op: string }) => o.op.includes('/api/admin/')), 'keine Admin-Funktionen');
    assert.match((await tool('tess', 'api_call', { method: 'GET', path: '/api/admin/users' })).text, /Keine Funktion/);
    // normale Projekte darf jeder lesen, Ändern braucht eine Rolle
    assert.equal((await tool('tess', 'api_call', { method: 'GET', path: '/api/projects/MF/plans' })).error, false);
    assert.match((await tool('tess', 'create_plan', { project: 'MF', name: 'Darf nicht' })).text, /^403/, 'ohne Rolle kein Anlegen');
    assert.equal((await tool('tess', 'create_project', { key: 'NOPE', name: 'x' })).error, true);
    assert.match((await tool('tess', 'api_call', { method: 'POST', path: '/api/auth/password', body: {} })).text, /Keine Funktion|nicht verfügbar/);
    assert.match((await tool('tess', 'api_call', { method: 'GET', path: '/api/../api/admin/users' })).text, /Keine Funktion/);
  });
});
