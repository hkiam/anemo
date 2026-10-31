import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { dispatchWebhooks, setWebhookFetch, sign } from '../src/modules/notifications/index.ts';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Webhooks (B6)', () => {
  let env: TestEnv;
  let up = true;
  const got: { url: string; body: any; headers: Record<string, string> }[] = [];
  before(async () => {
    env = await testEnv();
    setWebhookFetch(async (url, init) => {
      if (!up) return new Response('down', { status: 503 });
      got.push({ url: String(url), body: JSON.parse(String(init!.body)), headers: init!.headers as Record<string, string> });
      return new Response('ok');
    });
    for (const key of ['WH', 'SEC']) await env.call('POST', '/api/projects', { key, name: key });
    await env.call('PUT', '/api/projects/SEC/external-services', { externalServices: 'blocked' });
    for (const key of ['WH', 'SEC']) await env.call('POST', `/api/projects/${key}/test-cases`, { content: { title: 'T', steps: [{ action: 'a', expected: 'b' }] } });
  });
  after(async () => {
    setWebhookFetch(null);
    await env.close();
  });

  const fail = async (key: string) => {
    const cycle = (await env.call('POST', `/api/projects/${key}/cycles`, { name: `Lauf ${key}` })).body;
    await env.call('POST', `/api/cycles/${cycle.id}/executions`, { testCaseIds: [`${key}-T1`] });
    const [e] = (await env.call('GET', `/api/cycles/${cycle.id}/executions`)).body.items;
    await env.call('POST', `/api/executions/${e.id}/result`, { status: 'FAIL', comment: 'Absturz beim Speichern' }, 'tina');
  };

  it('stellt gefilterte Ereignisse signiert zu – nur ab Anlage, nie aus gesperrten Projekten', async () => {
    await fail('WH'); // vor Anlage: wird nicht nachgeliefert
    const json = (await env.call('POST', '/api/admin/webhooks', { name: 'CI', url: 'https://hooks.example/json', format: 'json', eventTypes: ['TestFailed'], projectKey: null, active: true })).body;
    await env.call('POST', '/api/admin/webhooks', { name: 'Teams', url: 'https://hooks.example/chat', format: 'chat', eventTypes: ['TestFailed'], projectKey: 'WH', active: true });
    await fail('WH');
    await fail('SEC');
    await dispatchWebhooks(env.db);
    assert.deepEqual(got.map((g) => g.url).sort(), ['https://hooks.example/chat', 'https://hooks.example/json']);
    const j = got.find((g) => g.url.endsWith('/json'))!;
    assert.equal(j.body.event.type, 'TestFailed');
    assert.equal(j.body.project.key, 'WH');
    assert.equal(j.headers['x-anemo-signature'], sign(json.secret, JSON.stringify(j.body)));
    const chat = got.find((g) => g.url.endsWith('/chat'))!;
    assert.match(chat.body.text, /^❌ WH-T1 fehlgeschlagen in „Lauf WH“ \(tina\)/);
  });

  it('wiederholt bei Ausfall in Reihenfolge und protokolliert', async () => {
    got.length = 0;
    up = false;
    await fail('WH');
    await dispatchWebhooks(env.db);
    let list = (await env.call('GET', '/api/admin/webhooks')).body.webhooks;
    assert.ok(list.every((w: any) => w.failures === 1 && w.nextAttemptAt));
    assert.equal(list[0].deliveries[0].ok, false);
    await dispatchWebhooks(env.db); // noch nicht fällig
    assert.equal(got.length, 0);
    up = true;
    await dispatchWebhooks(env.db, new Date(Date.now() + 60_000));
    assert.equal(got.length, 2);
    list = (await env.call('GET', '/api/admin/webhooks')).body.webhooks;
    assert.ok(list.every((w: any) => w.failures === 0));
    assert.equal(list[0].secret, undefined, 'Geheimnis nicht in der Liste');
  });

  it('Testnachricht und Validierung', async () => {
    const [w] = (await env.call('GET', '/api/admin/webhooks')).body.webhooks;
    assert.equal((await env.call('POST', `/api/admin/webhooks/${w.id}/test`)).body.ok, true);
    assert.equal((await env.call('POST', '/api/admin/webhooks', { name: 'x', url: 'file:///etc/passwd', format: 'json', eventTypes: [], projectKey: null, active: true })).status, 400);
  });
});
