import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Test-Health (E)', () => {
  let env: TestEnv;
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'QH', name: 'Health' });
    const mk = (title: string, steps = [{ action: 'a', expected: 'b' }]) => env.call('POST', '/api/projects/QH/test-cases', { content: { title, steps } });
    await mk('Wackelnder Test');                                  // T1
    await mk('Stabiler Test');                                    // T2
    await mk('Nie ausgeführter Test');                            // T3
    await mk('Ohne Erwartung', [{ action: 'nur tun', expected: '' }]); // T4
    await mk('Akte drucken (alt)');                               // T5
    await mk('Akte drucken!');                                    // T6 – Duplikat zu T7
    await mk('akte  DRUCKEN');                                    // T7
    const results: Record<string, string[]> = { 'QH-T1': ['PASS', 'FAIL', 'PASS', 'FAIL', 'PASS'], 'QH-T2': ['PASS', 'PASS', 'PASS', 'PASS', 'PASS'] };
    for (const [key, statuses] of Object.entries(results)) {
      for (const [i, status] of statuses.entries()) {
        const cycle = (await env.call('POST', '/api/projects/QH/cycles', { name: `Lauf ${key} ${i}` })).body;
        await env.call('POST', `/api/cycles/${cycle.id}/executions`, { testCaseIds: [key] });
        const [e] = (await env.call('GET', `/api/cycles/${cycle.id}/executions`)).body.items;
        await env.call('POST', `/api/executions/${e.id}/result`, { status, comment: 'Befund im Test' });
      }
    }
  });
  after(() => env.close());

  it('findet wackelnde, stabile, nie ausgeführte, unprüfbare Tests, Duplikate und Altlasten', async () => {
    const h = (await env.call('GET', '/api/projects/QH/health')).body;
    const keys = (id: string) => h.checks.find((c: any) => c.id === id).items.map((i: any) => i.key);
    assert.equal(h.total, 7);
    assert.deepEqual(keys('flaky'), ['QH-T1']);
    assert.deepEqual(keys('alwaysPass'), ['QH-T2']);
    assert.ok(keys('never').includes('QH-T3') && !keys('never').includes('QH-T1'));
    assert.deepEqual(keys('noExpected'), ['QH-T4']);
    assert.deepEqual(keys('legacy'), ['QH-T5']);
    assert.deepEqual(keys('duplicates'), ['QH-T6', 'QH-T7']);
  });

  it('veraltete Testfälle zählen nicht als „nie ausgeführt“', async () => {
    await env.call('PATCH', '/api/test-cases/QH-T3', { status: 'READY' });
    await env.call('PATCH', '/api/test-cases/QH-T3', { status: 'APPROVED' }, 'qa-lea');
    await env.call('PATCH', '/api/test-cases/QH-T3', { status: 'DEPRECATED' });
    const h = (await env.call('GET', '/api/projects/QH/health')).body;
    assert.ok(!h.checks.find((c: any) => c.id === 'never').items.some((i: any) => i.key === 'QH-T3'));
  });
});
