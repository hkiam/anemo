import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

describe('MCP-Server (D2)', () => {
  let env: TestEnv;
  let n = 0;
  const rpc = async (method: string, params: object = {}) => {
    const res = await env.app.request('/api/mcp', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-anemo-user': 'claude-agent' },
    });
    return { status: res.status, body: await res.json() as any };
  };
  const call = async (name: string, args: object) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const result = r.body.result;
    return { error: !!result.isError, text: result.content[0].text as string, data: result.structuredContent };
  };

  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'MC', name: 'MCP' });
    await env.call('POST', '/api/projects', { key: 'SEC', name: 'Geheim' });
    await env.call('POST', '/api/projects/MC/test-cases', { content: { title: 'Login prüfen', steps: [{ action: 'Anmelden', expected: 'Start' }, { action: 'Abmelden', expected: 'Login' }] } });
    await env.call('POST', '/api/projects/SEC/test-cases', { content: { title: 'Vertraulicher Ablauf', steps: [{ action: 'a', expected: 'b' }] } });
    await env.call('PUT', '/api/projects/SEC/external-services', { externalServices: 'blocked' });
  });
  after(() => env.close());

  it('initialize, tools/list, Benachrichtigungen und Fehler nach JSON-RPC', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.body.result.protocolVersion, '2025-06-18');
    assert.equal(init.body.result.serverInfo.name, 'anemo');
    const note = await env.app.request('/api/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), headers: { 'content-type': 'application/json', 'x-anemo-user': 'x' } });
    assert.equal(note.status, 202);
    const tools = (await rpc('tools/list')).body.result.tools.map((t: any) => t.name);
    for (const t of ['search', 'get_test_case', 'create_cycle', 'record_result', 'release_cockpit']) assert.ok(tools.includes(t), t);
    assert.equal((await rpc('gibt/es/nicht')).body.error.code, -32601);
    assert.equal((await env.app.request('/api/mcp', { headers: { 'x-anemo-user': 'x' } })).status, 405);
  });

  it('Agent plant, führt aus und erfasst Ergebnisse – als Akteur mit seinen Rechten', async () => {
    const tc = await call('get_test_case', { key: 'MC-T1' });
    assert.equal(tc.error, false);
    assert.equal(tc.data.version.title, 'Login prüfen');
    const created = await call('create_cycle', { project: 'MC', name: 'Agentenlauf', build: '2.0', testCaseKeys: ['MC-T1'] });
    assert.equal(created.data.added, 1);
    const results = await call('get_cycle_results', { cycleId: created.data.cycle.id });
    const execId = results.data.items[0].id;
    const rec = await call('record_result', { executionId: execId, status: 'FAIL', comment: 'Abmelden hängt', stepResults: [{ step: 1, status: 'PASS' }, { step: 2, status: 'FAIL', comment: 'Timeout' }] });
    assert.equal(rec.error, false, rec.text);
    assert.deepEqual([rec.data.status, rec.data.executedBy], ['FAIL', 'claude-agent']);
    const draft = await call('prepare_defect', { executionId: execId });
    assert.match(draft.data.title, /MC-T1/);
    const bad = await call('record_result', { executionId: execId, status: 'PASS', stepResults: [{ step: 9, status: 'PASS' }] });
    assert.equal(bad.error, true);
    assert.match(bad.text, /Schritt 9 gibt es nicht/);
    const found = await call('search', { query: 'Login' });
    assert.ok(found.text.includes('MC-T1'));
  });

  it('Projekte mit gesperrten externen Diensten sind für Agenten unsichtbar', async () => {
    const projects = await call('list_projects', {});
    assert.deepEqual(projects.data.items.map((p: any) => p.key), ['MC']);
    const tc = await call('get_test_case', { key: 'SEC-T1' });
    assert.equal(tc.error, true);
    assert.match(tc.text, /^404/);
    const s = await call('search', { query: 'Vertraulicher' });
    assert.ok(!s.text.includes('SEC-T1'));
    assert.equal((await env.call('GET', '/api/test-cases/SEC-T1')).status, 200, 'in der Oberfläche weiterhin sichtbar');
  });
});
