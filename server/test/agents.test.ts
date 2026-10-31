import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Agentische Ausführung mit QA-Freigabe (D3)', () => {
  let env: TestEnv;
  let planId: string;
  let cycleId: string;
  const mcp = async (name: string, args: object, user = 'robo') => {
    const res = await env.app.request('/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-anemo-user': user },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const r = (await res.json()) as any;
    return { error: !!r.result.isError, text: r.result.content[0].text as string, data: r.result.structuredContent };
  };
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/admin/users', { username: 'robo', displayName: 'Test-Agent', password: 'Sicheres-Passwort-1', isAgent: true });
    await env.call('POST', '/api/admin/users', { username: 'qa', displayName: 'QA', password: 'Sicheres-Passwort-1' });
    await env.call('POST', '/api/projects', { key: 'AG', name: 'Agenten' });
    for (const t of ['A', 'B', 'C']) await env.call('POST', '/api/projects/AG/test-cases', { content: { title: t, steps: [{ action: 'x', expected: 'y' }] } });
    planId = (await env.call('POST', '/api/projects/AG/plans', { name: 'R1' })).body.id;
    cycleId = (await env.call('POST', '/api/projects/AG/cycles', { name: 'Agentenlauf', planId })).body.id;
    await env.call('POST', `/api/cycles/${cycleId}/executions`, { testCaseIds: ['AG-T1', 'AG-T2', 'AG-T3'] });
  });
  after(() => env.close());

  it('Agent übernimmt Arbeit ohne Doppelvergabe und hängt Evidenzen an', async () => {
    const [a, b] = await Promise.all([mcp('claim_next', { cycleId, count: 2 }), mcp('claim_next', { cycleId, count: 2 }, 'robo2')]);
    const all = [...a.data.claimed, ...b.data.claimed];
    assert.equal(all.length, 3);
    assert.equal(new Set(all).size, 3, 'keine Ausführung doppelt vergeben');
    assert.ok(a.data.claimed.length <= 2 && b.data.claimed.length <= 2, 'nie mehr als angefordert');
    const mine = await mcp('my_assignments', { project: 'AG' });
    assert.equal(mine.data.items.length, a.data.claimed.length);
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const ev = await mcp('attach_evidence', { executionId: a.data.claimed[0], fileName: 'schritt-1.png', contentBase64: png, contentType: 'image/png' });
    assert.equal(ev.error, false, ev.text);
    const atts = (await env.call('GET', `/api/attachments?ownerType=TEST_EXECUTION&ownerId=${a.data.claimed[0]}`)).body;
    assert.equal(atts[0].fileName, 'schritt-1.png');
    assert.equal(atts[0].author, 'robo');
  });

  it('Agentenergebnis wartet auf Freigabe; Agent darf nicht freigeben; QA gibt frei oder lehnt ab', async () => {
    const items = (await env.call('GET', `/api/cycles/${cycleId}/executions`)).body.items;
    const [e1, e2, e3] = items.map((e: any) => e.id);
    for (const id of [e1, e2]) assert.equal((await mcp('record_result', { executionId: id, status: 'PASS', comment: 'Alle Schritte wie erwartet' })).error, false);
    assert.equal((await env.call('GET', `/api/executions/${e1}`)).body.reviewState, 'pending');
    const cockpit = (await env.call('GET', `/api/reports/completion/${planId}?format=json`)).body;
    assert.ok(cockpit.assessment.reasons.some((r: string) => /KI-Agenten noch nicht geprüft/.test(r)));
    assert.equal((await env.call('POST', `/api/executions/${e1}/review`, { decision: 'approve' }, 'robo')).status, 403, 'Agent gibt nicht frei');
    assert.equal((await env.call('POST', `/api/executions/${e1}/review`, { decision: 'approve', note: 'Stichprobe ok' }, 'qa')).status, 200);
    assert.equal((await env.call('GET', `/api/executions/${e1}`)).body.reviewState, 'approved');
    assert.equal((await env.call('POST', `/api/executions/${e2}/review`, { decision: 'reject', note: 'Screenshot fehlt', reassignTo: 'qa' }, 'qa')).status, 200);
    const d2 = (await env.call('GET', `/api/executions/${e2}`)).body;
    assert.deepEqual([d2.status, d2.assignee, d2.reviewState], ['NOT_EXECUTED', 'qa', 'rejected']);
    assert.match(d2.comment, /abgelehnt von qa: Screenshot fehlt/);
    // Eskalation
    assert.equal((await mcp('escalate', { executionId: e3, reason: 'Testdaten fehlen im System' }, 'robo2')).error, false);
    const queue = (await env.call('GET', '/api/projects/AG/reviews')).body;
    assert.deepEqual(queue.map((q: any) => q.reviewState), ['escalated']);
    // Ein Mensch führt aus → keine Freigabe nötig
    await env.call('POST', `/api/executions/${e3}/result`, { status: 'PASS' }, 'qa');
    assert.equal((await env.call('GET', `/api/executions/${e3}`)).body.reviewState, null);
  });
});

describe('KI-Ergebnisprüfung lässt sich nicht umgehen (Review 30.10.2026, F5; Modus on)', () => {
  let env: TestEnv;
  const PW = 'Sicheres-Passwort-1';
  const cookies = new Map<string, string>();
  const req = async (u: string, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', host: 'anemo.test' };
    if (cookies.get(u)) headers.cookie = cookies.get(u)!;
    const res = await env.app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, cookie: res.headers.get('set-cookie'), body: (res.headers.get('content-type') ?? '').includes('json') ? (await res.json()) as any : null };
  };
  const login = async (u: string) => cookies.set(u, (await req('', 'POST', '/api/auth/login', { username: u, password: PW })).cookie!.split(';')[0]!);
  let exec: string;
  before(async () => {
    env = await testEnv({ authMode: 'on' });
    process.env.ANEMO_ADMIN_PASSWORD = PW;
    const { bootstrapAdmin } = await import('../src/modules/auth/index.ts');
    await bootstrapAdmin(env.db, '/dev/null', () => {});
    await login('admin');
    await req('admin', 'POST', '/api/projects', { key: 'KP', name: 'KI-Prüfung' });
    for (const [u, role] of [['tess', 'TESTER'], ['lead', 'DESIGNER']] as const) {
      const id = (await req('admin', 'POST', '/api/admin/users', { username: u, displayName: u, password: PW })).body.id;
      await req('admin', 'PUT', '/api/projects/KP/members', { principalType: 'user', principalId: id, role });
      await login(u);
    }
    await req('admin', 'POST', '/api/projects/KP/test-cases', { content: { title: 'A', steps: [{ action: 'x', expected: 'y' }] } });
    const cyc = (await req('admin', 'POST', '/api/projects/KP/cycles', { name: 'Lauf' })).body.id;
    await req('admin', 'POST', `/api/cycles/${cyc}/executions`, { testCaseIds: ['KP-T1'] });
    exec = (await req('admin', 'GET', `/api/cycles/${cyc}/executions`)).body.items[0].id;
    // Ergebnis eines Agenten, noch nicht geprüft
    await env.db`update test_execution set status = 'PASS', executed_by = 'robo', executed_at = now(), review_state = 'pending' where id = ${exec}`;
  });
  after(() => env.close());

  it('Tester kann ein ungeprüftes Agentenergebnis weder bestätigen noch durch erneutes Speichern ersetzen', async () => {
    assert.equal((await req('tess', 'POST', `/api/executions/${exec}/result`, { status: 'PASS', comment: 'nur Kommentar' })).status, 403);
    assert.equal((await req('tess', 'POST', `/api/executions/${exec}/review`, { decision: 'approve' })).status, 403);
    const bulk = await req('tess', 'POST', '/api/executions/bulk', { ids: [exec], status: 'PASS' });
    assert.ok(bulk.status === 200 || bulk.status === 403, String(bulk.status));
    if (bulk.status === 200) assert.match(JSON.stringify(bulk.body.skipped), /wartet auf Prüfung/);
    assert.equal((await env.db`select review_state from test_execution where id = ${exec}`)[0]!.reviewState, 'pending');
  });

  it('die Testleitung ersetzt das Ergebnis (protokolliert als „overridden“)', async () => {
    assert.equal((await req('lead', 'POST', `/api/executions/${exec}/result`, { status: 'PASS', comment: 'selbst geprüft' })).status, 200);
    assert.equal((await env.db`select review_state from test_execution where id = ${exec}`)[0]!.reviewState, null);
    const [ev] = await env.db`select payload from domain_event where type = 'ResultReviewed' and aggregate_id = ${exec}`;
    assert.equal(ev!.payload.decision, 'overridden');
  });
});
