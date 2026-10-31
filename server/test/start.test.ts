import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Startseite und persönliche Einstellungen', () => {
  let env: TestEnv;
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'ST', name: 'Start' });
    for (const title of ['Eins', 'Zwei']) await env.call('POST', '/api/projects/ST/test-cases', { content: { title, steps: [{ action: 'a', expected: 'b' }] } });
  });
  after(() => env.close());

  it('zeigt zugewiesene offene Ausführungen, Entwürfe und Fehlschläge', async () => {
    const cycle = (await env.call('POST', '/api/projects/ST/cycles', { name: 'Lauf' })).body;
    await env.call('POST', `/api/cycles/${cycle.id}/executions`, { testCaseIds: ['ST-T1', 'ST-T2'] });
    const ex = (await env.call('GET', `/api/cycles/${cycle.id}/executions`)).body.items.map((e: any) => e.id);
    await env.call('POST', '/api/executions/bulk-assign', { ids: ex, assignee: 'tester' });
    await env.call('POST', `/api/executions/${ex[1]}/result`, { status: 'FAIL', comment: 'kaputt' });
    const s = (await env.call('GET', '/api/projects/ST/start')).body;
    assert.equal(s.tasks.executions.count, 1, 'nur noch eine offen');
    assert.equal(s.tasks.drafts.length, 2, 'eigene Entwürfe');
    assert.equal(s.failures.length, 1);
    assert.equal(s.cycles[0].name, 'Lauf');
    assert.ok(s.lead, 'Pflegerecht sieht Aufgaben der Testleitung');
    // abgeschlossener Zyklus zählt nicht mehr als Aufgabe
    await env.call('POST', `/api/cycles/${cycle.id}/state`, { state: 'closed' });
    assert.equal((await env.call('GET', '/api/projects/ST/start')).body.tasks.executions.count, 0);
  });

  it('speichert die Anordnung je Benutzer; null stellt den Standard wieder her', async () => {
    assert.deepEqual((await env.call('GET', '/api/me/preferences/start')).body, { value: null });
    const layout = { order: ['cycles', 'tasks'], hidden: ['health'] };
    assert.equal((await env.call('PUT', '/api/me/preferences/start', { value: layout })).status, 204);
    assert.deepEqual((await env.call('GET', '/api/me/preferences/start')).body.value, layout);
    assert.deepEqual((await env.call('GET', '/api/me/preferences/start', undefined, 'qa-lea')).body.value, null, 'andere Benutzer unberührt');
    await env.call('PUT', '/api/me/preferences/start', { value: null });
    assert.equal((await env.call('GET', '/api/me/preferences/start')).body.value, null);
    assert.equal((await env.call('GET', '/api/me/preferences/Bad%20Name')).status, 400);
  });
});
