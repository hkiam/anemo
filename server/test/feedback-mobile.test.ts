import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

/** Rückmeldungen aus der Nutzung im Mobilprojekt: bekannte Fehler, Gerätematrix, Massenfreigabe, MCP-Parameter. */
describe('Bekannte Fehler, Stand je Konfiguration, Massenfreigabe, MCP-Aliase', () => {
  let env: TestEnv;
  let planId: string;
  const ids: Record<string, string> = {};

  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'MO', name: 'Mobil' });
    for (const [i, user] of [[1, 'autor'], [2, 'autor'], [3, 'lead']] as const) {
      ids[`MO-T${i}`] = (await env.call('POST', '/api/projects/MO/test-cases', { content: { title: `Fall ${i}`, steps: [{ action: 'a', expected: 'b' }] } }, user)).body.id;
    }
    planId = (await env.call('POST', '/api/projects/MO/plans', { name: 'Release 3' })).body.id;
  });
  after(() => env.close());

  const cycle = async (name: string, device: string) => {
    const id = (await env.call('POST', '/api/projects/MO/cycles', { name, planId, configuration: { device: [device] } })).body.id;
    await env.call('POST', `/api/cycles/${id}/executions`, { testCaseIds: ['MO-T1', 'MO-T2'] });
    const execs = (await env.call('GET', `/api/cycles/${id}/executions`)).body.items;
    return Object.fromEntries(execs.map((e: any) => [e.testCaseKey, e.id])) as Record<string, string>;
  };

  it('„Fehlgeschlagen (bekannt)“ braucht einen Verweis und blockiert die Freigabeempfehlung nicht', async () => {
    const ipad = await cycle('iPad', 'iPad');
    const iphone = await cycle('iPhone', 'iPhone');
    const bare = await env.call('POST', `/api/executions/${ipad['MO-T1']}/result`, { status: 'FAIL_KNOWN' });
    assert.equal(bare.status, 400);
    assert.match(JSON.stringify(bare.body), /bekannten Fehler/);
    const ok = await env.call('POST', `/api/executions/${ipad['MO-T1']}/result`, { status: 'FAIL_KNOWN', comment: 'Darstellung im Querformat, Ticket folgt' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await env.call('POST', `/api/executions/${ipad['MO-T2']}/result`, { status: 'PASS' });
    await env.call('POST', `/api/executions/${iphone['MO-T1']}/result`, { status: 'PASS' });
    await env.call('POST', `/api/executions/${iphone['MO-T2']}/result`, { status: 'PASS' });

    const c = (await env.call('GET', `/api/plans/${planId}/cockpit`)).body;
    assert.deepEqual(c.knownFailures.map((k: any) => k.key), ['MO-T1']);
    assert.equal(c.problems.length, 0);
    assert.ok(c.risks.some((r: string) => /bekanntem Fehler/.test(r)));
    assert.notEqual(c.assessment.recommendation, 'not-recommended');
    // Stand je Gerät: auf dem iPad bekannter Fehler, auf dem iPhone alles bestanden
    const byLabel = Object.fromEntries(c.byConfiguration.configurations.map((x: any) => [x.label, x]));
    assert.deepEqual(Object.keys(byLabel).sort(), ['Gerät: iPad', 'Gerät: iPhone']);
    assert.equal(byLabel['Gerät: iPhone'].summary.passRate, 100);
    assert.equal(c.byConfiguration.matrix.length, 1);
    assert.deepEqual(Object.values(c.byConfiguration.matrix[0].cells).sort(), ['FAIL_KNOWN', 'PASS']);
  });

  it('Massenfreigabe: Vier-Augen-Prinzip überspringt eigene Versionen, Probelauf ändert nichts', async () => {
    const keys = ['MO-T1', 'MO-T2', 'MO-T3'];
    const dry = await env.call('POST', '/api/projects/MO/test-cases/approve', { ids: keys, dryRun: true }, 'lead');
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.deepEqual([dry.body.dryRun, dry.body.approved, dry.body.skipped.own], [true, 2, ['MO-T3']]);
    assert.equal((await env.call('GET', '/api/test-cases/MO-T1')).body.approvedVersion ?? null, null);
    const r = await env.call('POST', '/api/projects/MO/test-cases/approve', { ids: keys.map((k) => ids[k]), note: 'Abnahme Release 3' }, 'lead');
    assert.deepEqual([r.body.approved, r.body.approvedKeys], [2, ['MO-T1', 'MO-T2']]);
    const tc = (await env.call('GET', '/api/test-cases/MO-T1')).body;
    assert.deepEqual([tc.approvedVersion, tc.approvedBy], [1, 'lead']);
    const again = await env.call('POST', '/api/projects/MO/test-cases/approve', { ids: keys }, 'lead');
    assert.deepEqual([again.body.approved, again.body.skipped.already], [0, ['MO-T1', 'MO-T2']]);
    assert.equal((await env.call('POST', '/api/projects/MO/test-cases/approve', { ids: keys, aql: 'x' }, 'lead')).status, 400);
  });

  it('MCP: gängige Parameternamen werden abgebildet, outputSchema gemeldet', async () => {
    let n = 0;
    const rpc = async (method: string, params: object = {}) => (await (await env.app.request('/api/mcp', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-anemo-user': 'lead' },
    })).json() as any).result;
    const tools = (await rpc('tools/list')).tools;
    assert.ok(tools.every((t: any) => t.outputSchema?.type === 'object'));
    const r = await rpc('tools/call', { name: 'get_test_case', arguments: { testCaseKey: 'MO-T1' } });
    assert.equal(r.isError, undefined, r.content?.[0]?.text);
    assert.equal(r.structuredContent.key, 'MO-T1');
  });
});
