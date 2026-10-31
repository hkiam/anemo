import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Hilfe (Handbuch in der Anwendung)', () => {
  let env: TestEnv;
  before(async () => { env = await testEnv(); });
  after(() => env.close());

  it('liefert Startseite, Kapitel und Anleitungen, aber nichts außerhalb', async () => {
    const res = await env.app.request('/api/help/README', { headers: { 'x-anemo-user': 'tester' } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Handbuch/);
    const list = (await env.call('GET', '/api/help')).body;
    assert.ok(list.handbuch.includes('01-erste-schritte'));
    for (const p of list.handbuch) assert.equal((await env.app.request(`/api/help/${p}`, { headers: { 'x-anemo-user': 't' } })).status, 200, p);
    for (const p of list.anleitungen) assert.equal((await env.app.request(`/api/help/${p}`, { headers: { 'x-anemo-user': 't' } })).status, 200, p);
    assert.equal((await env.call('GET', '/api/help/..%2F..%2Fpackage')).status, 404);
    assert.equal((await env.call('GET', '/api/help/roadmap')).status, 404);
  });
});
