import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Jira-Parallelbetrieb (B3): Status verknüpfter Tickets aktualisieren', () => {
  let env: TestEnv;
  let mock: ReturnType<typeof serve>;
  const seen: { jql: string; auth: string | undefined; validate: boolean }[] = [];
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'JI', name: 'Jira' });
    // neu von Hand verknüpfte Tickets werden nur mit Projektbezug abgeglichen (Sicherheit 3): Jira-Projekt ABC zuordnen
    await env.call('PUT', '/api/projects/JI/integrations/jira', { externalProject: 'ABC' });
    const tc = (await env.call('POST', '/api/projects/JI/test-cases', { content: { title: 'T', steps: [{ action: 'a', expected: 'b' }] } })).body;
    for (const key of ['ABC-1', 'ABC-2', 'ABC-404']) {
      await env.call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: tc.id, provider: 'jira', externalKey: key, relation: 'DEFECT', status: 'Offen' });
    }
    const jira = new Hono();
    jira.post('/rest/api/2/search', async (c) => {
      const b = await c.req.json();
      seen.push({ jql: b.jql, auth: c.req.header('authorization'), validate: b.validateQuery });
      return c.json({ issues: [
        { key: 'ABC-1', fields: { summary: 'Speichern bricht ab', status: { name: 'Fertig' } } },
        { key: 'ABC-2', fields: { summary: 'Druck fehlt', status: { name: 'In Arbeit' } } },
      ] });
    });
    await new Promise<void>((r) => { mock = serve({ fetch: jira.fetch, port: 0 }, () => r()); });
  });
  after(async () => {
    mock.close();
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_BASIC_AUTH;
    await env.close();
  });

  it('ohne Einrichtung 409; mit Einrichtung werden Titel/Status übernommen', async () => {
    delete process.env.JIRA_HOST;
    assert.equal((await env.call('POST', '/api/admin/integrations/jira/refresh')).status, 409);
    process.env.JIRA_BASE_URL = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    process.env.JIRA_BASIC_AUTH = 'leser:geheim';
    const r = (await env.call('POST', '/api/admin/integrations/jira/refresh')).body;
    assert.deepEqual([r.checked, r.updated, r.missing, r.error], [3, 2, 1, null]);
    assert.equal(seen[0]!.jql, 'key in ("ABC-1","ABC-2","ABC-404")');
    assert.equal(seen[0]!.validate, false);
    assert.equal(seen[0]!.auth, `Basic ${Buffer.from('leser:geheim').toString('base64')}`);
    const ref = (await env.call('GET', '/api/references/by-key/jira/ABC-1')).body[0];
    assert.deepEqual([ref.title, ref.status], ['Speichern bricht ab', 'Fertig']);
    assert.match(ref.url, /\/browse\/ABC-1$/);
    const again = (await env.call('POST', '/api/admin/integrations/jira/refresh')).body;
    assert.equal(again.updated, 0, 'unveränderte Verweise werden nicht erneut geschrieben');
    const list = (await env.call('GET', '/api/admin/integrations')).body;
    assert.equal(list.find((i: any) => i.provider === 'jira').configured, true);
  });
});
