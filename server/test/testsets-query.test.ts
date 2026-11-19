import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

/**
 * Rückmeldung eines KI-Agenten: dynamische Testsets mit reiner AQL zeigten alle Testfälle des Projekts,
 * und Zyklen ließen sich nur mit einzelnen Testfall-IDs befüllen.
 */
describe('Dynamische Testsets: Filterformate; Zyklus per Abfrage bzw. Testset befüllen', () => {
  let env: TestEnv;
  let n = 0;
  const keys = (r: { body: { key: string }[] }) => r.body.map((t) => t.key).sort();
  const tool = async (name: string, args: object) => {
    const res = await env.app.request('/api/mcp', {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-anemo-user': 'tester' },
    });
    const result = ((await res.json()) as any).result;
    return { error: !!result.isError, text: result.content[0].text as string, data: result.structuredContent };
  };

  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'TQ', name: 'Testset-Abfragen' });
    await env.call('POST', '/api/projects', { key: 'TO', name: 'Anderes Projekt' });
    const mk = (title: string, labels: string[]) => env.call('POST', '/api/projects/TQ/test-cases', { content: { title, labels, steps: [{ action: 'a', expected: 'b' }] } });
    await mk('Eins', ['automatisiert']);
    await mk('Zwei', ['automatisiert', 'smoke']);
    await mk('Drei', ['manuell']);
    await mk('Vier', []);
  });
  after(() => env.close());

  it('reine AQL, Adresszeile, Objekt, JSON-Text und Kurzform aql werden ausgewertet und normalisiert gespeichert', async () => {
    const variants: [string, object][] = [
      ['rein', { query: 'label = "automatisiert"' }],
      ['adresszeile', { query: `aql=${encodeURIComponent('label = "automatisiert"')}` }],
      ['adresszeile-roh', { query: 'aql=label = "automatisiert"' }],
      ['objekt', { query: { aql: 'label = "automatisiert"' } }],
      ['json-text', { query: '{"aql": "label = \\"automatisiert\\""}' }],
      ['kurzform', { aql: 'label = "automatisiert"' }],
      ['einfach', { query: 'label=automatisiert' }],
      ['einfach-anfuehrung', { query: 'label="automatisiert"' }],
      ['objekt-alias', { query: { label: 'automatisiert' } }],
    ];
    for (const [name, payload] of variants) {
      const r = await env.call('POST', '/api/projects/TQ/test-sets', { name, kind: 'dynamic', ...payload });
      assert.equal(r.status, 201, `${name}: ${JSON.stringify(r.body)}`);
      assert.ok(/^(aql|label)=/.test(r.body.query), `${name}: gespeichert als ${r.body.query}`);
      assert.deepEqual(keys(await env.call('GET', `/api/test-sets/${r.body.id}/test-cases`)), ['TQ-T1', 'TQ-T2'], name);
    }
    const list = (await env.call('GET', '/api/projects/TQ/test-sets')).body;
    assert.ok(list.every((s: any) => s.count === 2), JSON.stringify(list.map((s: any) => [s.name, s.count])));
  });

  it('leere, unbekannte oder ungültige Filter werden mit 400 abgelehnt statt „alle Testfälle“', async () => {
    for (const query of ['', '   ', 'foo=bar', '{"filter": "x"}', '{kaputt', 'label = ', 'aql=', 'folder=Ordner A']) {
      const r = await env.call('POST', '/api/projects/TQ/test-sets', { name: `x-${query}`, kind: 'dynamic', query });
      assert.equal(r.status, 400, `${JSON.stringify(query)}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal((await env.call('POST', '/api/projects/TQ/test-sets', { name: 'y', kind: 'dynamic', query: { aql: 'label = "x"', foo: 1 } })).status, 400);
    assert.equal((await env.call('POST', '/api/projects/TQ/test-sets', { name: 'z', kind: 'dynamic', query: 'label=x', aql: 'label = "x"' })).status, 400);
    assert.equal((await env.call('POST', '/api/projects/TQ/test-sets', { name: 's', kind: 'static', aql: 'label = "x"' })).status, 400);
  });

  it('früher unverändert gespeicherte reine AQL wird beim Lesen ausgewertet; Unauswertbares liefert Fehler statt alle', async () => {
    const [p] = await env.db<{ id: string }[]>`select id from project where key = 'TQ'`;
    const [legacy] = await env.db<{ id: string }[]>`insert into test_set(project_id, name, kind, test_case_ids, query, created_by)
      values (${p!.id}, 'alt-aql', 'dynamic', '{}'::uuid[], 'label = "manuell"', 'tester') returning id`;
    assert.deepEqual(keys(await env.call('GET', `/api/test-sets/${legacy!.id}/test-cases`)), ['TQ-T3']);
    const [broken] = await env.db<{ id: string }[]>`insert into test_set(project_id, name, kind, test_case_ids, query, created_by)
      values (${p!.id}, 'alt-kaputt', 'dynamic', '{}'::uuid[], 'foo=bar', 'tester') returning id`;
    assert.equal((await env.call('GET', `/api/test-sets/${broken!.id}/test-cases`)).status, 400);
    const row = (await env.call('GET', '/api/projects/TQ/test-sets')).body.find((s: any) => s.name === 'alt-kaputt');
    assert.equal(row.count, null);
    assert.ok(row.error);
    // Ändern normalisiert ebenfalls; leerer Filter bleibt verboten
    assert.equal((await env.call('PUT', `/api/test-sets/${legacy!.id}`, { query: '' })).status, 400);
    const u = await env.call('PUT', `/api/test-sets/${legacy!.id}`, { query: 'label = "smoke"' });
    assert.equal(u.status, 200);
    assert.equal(u.body.query, `aql=${new URLSearchParams({ x: 'label = "smoke"' }).toString().slice(2)}`);
  });

  it('Zyklus per AQL oder Testset befüllen (REST), genau eine Auswahl, Projektgrenze', async () => {
    const cycle = (await env.call('POST', '/api/projects/TQ/cycles', { name: 'Per Abfrage' })).body;
    const r = await env.call('POST', `/api/cycles/${cycle.id}/executions`, { aql: 'label = "automatisiert"' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.added, 2);
    assert.equal(r.body.total, 2);
    const set = (await env.call('POST', '/api/projects/TQ/test-sets', { name: 'manuell', kind: 'dynamic', aql: 'label = "manuell"' })).body;
    const s = await env.call('POST', `/api/cycles/${cycle.id}/executions`, { testSetId: set.id });
    assert.equal(s.body.added, 1);
    const again = await env.call('POST', `/api/cycles/${cycle.id}/executions`, { aql: 'label in ("automatisiert", "manuell")' });
    assert.equal(again.body.added, 0);
    assert.equal(again.body.total, 3);
    assert.equal((await env.call('POST', `/api/cycles/${cycle.id}/executions`, {})).status, 400);
    assert.equal((await env.call('POST', `/api/cycles/${cycle.id}/executions`, { aql: 'label = "x"', testSetId: set.id })).status, 400);
    assert.equal((await env.call('POST', `/api/cycles/${cycle.id}/executions`, { aql: 'label = ' })).status, 400);
    const other = (await env.call('POST', '/api/projects/TO/cycles', { name: 'Fremd' })).body;
    assert.equal((await env.call('POST', `/api/cycles/${other.id}/executions`, { testSetId: set.id })).status, 400);
    // Abfrage wirkt nur im Projekt des Zyklus
    const o = await env.call('POST', `/api/cycles/${other.id}/executions`, { aql: 'label = "automatisiert"' });
    assert.equal(o.body.added, 0);
  });

  it('MCP: create_cycle und add_tests_to_cycle nehmen aql bzw. testSetId', async () => {
    const created = await tool('create_cycle', { project: 'TQ', name: 'Agent per AQL', aql: 'label = "automatisiert"' });
    assert.equal(created.error, false, created.text);
    assert.equal(created.data.added, 2);
    const set = (await env.call('GET', '/api/projects/TQ/test-sets')).body.find((s: any) => s.name === 'manuell');
    const added = await tool('add_tests_to_cycle', { cycleId: created.data.cycle.id, testSetId: set.id });
    assert.equal(added.error, false, added.text);
    assert.equal(added.data.added, 1);
    assert.equal((await tool('add_tests_to_cycle', { cycleId: created.data.cycle.id })).error, true);
    assert.equal((await tool('add_tests_to_cycle', { cycleId: created.data.cycle.id, testCases: ['TQ-T4'], aql: 'label = "x"' })).error, true);
  });
});
