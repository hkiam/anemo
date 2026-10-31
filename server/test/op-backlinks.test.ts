import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

describe('OpenProject: Rückverweis als Feld, dauerhafte Links, Rückverweise aktualisieren', () => {
  let env: TestEnv;
  let srv: Server;
  let exec: string;
  const created: Record<string, unknown>[] = [];
  const comments: { wp: string; raw: string }[] = [];
  const wp: Record<string, Record<string, unknown>> = { '900': { id: 900, subject: 'Fremd', lockVersion: 1, customField34: 'https://fremd.example/x' } };
  const saved = { ...process.env };
  before(async () => {
    srv = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/hal+json' }); res.end(JSON.stringify(body)); };
        const u = req.url ?? '';
        if (u === '/api/v3/projects/akte') return send(200, { id: 5, identifier: 'akte' });
        if (u === '/api/v3/projects/5/types') return send(200, { _embedded: { elements: [{ id: 7, name: 'Fehler' }] } });
        if (u.startsWith('/api/v3/work_packages/schemas/5-7')) return send(200, { customField34: { type: 'Link', name: 'Anemo', writable: true }, customField35: { type: 'String', name: 'Testfall', writable: true } });
        if (req.method === 'POST' && u === '/api/v3/projects/akte/work_packages') {
          const body = JSON.parse(raw); created.push(body);
          wp['4711'] = { id: 4711, subject: body.subject, lockVersion: 1, customField34: body.customField34 ?? null };
          return send(201, { id: 4711, subject: body.subject, _links: { status: { title: 'Neu' } } });
        }
        const act = /^\/api\/v3\/work_packages\/(\d+)\/activities$/.exec(u);
        if (act && req.method === 'POST') { comments.push({ wp: act[1]!, raw: JSON.parse(raw).comment.raw }); return send(201, {}); }
        const m = /^\/api\/v3\/work_packages\/(\d+)$/.exec(u);
        if (m && wp[m[1]!]) {
          if (req.method === 'PATCH') { Object.assign(wp[m[1]!]!, JSON.parse(raw)); return send(200, wp[m[1]!]); }
          return send(200, wp[m[1]!]);
        }
        if (u.startsWith('/api/v3/projects/akte/work_packages?')) {
          const ids = JSON.parse(decodeURIComponent(u.split('filters=')[1]!))[0].id.values as string[];
          return send(200, { _embedded: { elements: ids.filter((i) => wp[i]).map((i) => ({ id: Number(i), subject: wp[i]!.subject })) } });
        }
        send(404, { message: 'nicht gefunden' });
      });
    });
    await new Promise<void>((r) => srv.listen(0, r));
    Object.assign(process.env, { OPENPROJECT_URL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, OPENPROJECT_API_KEY: 'k',
      ANEMO_PUBLIC_URL: 'http://anemo.test', OPENPROJECT_LINK_FIELD: 'customField34', OPENPROJECT_TESTCASE_FIELD: 'customField35' });
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'RB', name: 'Rückverweis' });
    await env.call('PUT', '/api/projects/RB/integrations/openproject', { externalProject: 'akte', settings: { typeId: 7 } });
    const tc = (await env.call('POST', '/api/projects/RB/test-cases', { content: { title: 'Akte speichern', steps: [{ action: 'a', expected: 'b' }] } })).body.id;
    const c = (await env.call('POST', '/api/projects/RB/cycles', { name: 'Z' })).body.id;
    await env.call('POST', `/api/cycles/${c}/executions`, { testCaseIds: [tc] });
    exec = (await env.call('GET', `/api/cycles/${c}/executions`)).body.items[0].id;
  });
  after(async () => { process.env = saved; srv.close(); await env.close(); });

  it('Anlegen: Link-Feld und Testfall-Feld gesetzt, Beschreibung mit lesbarem dauerhaften Link', async () => {
    const d = (await env.call('POST', `/api/executions/${exec}/defect-draft`, {})).body;
    assert.match(d.body, /Aus Anemo: \[RB-T1 – Akte speichern\|http:\/\/anemo\.test\/go\/ausfuehrung\//);
    const r = await env.call('POST', `/api/executions/${exec}/defects`, { title: d.title, body: d.body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const sent = created[0]!;
    assert.equal(sent.customField34, `http://anemo.test/go/ausfuehrung/${exec}`);
    assert.equal(sent.customField35, 'RB-T1');
    assert.match((sent.description as { raw: string }).raw, /Aus Anemo: \[RB-T1 – Akte speichern\]\(http:\/\/anemo\.test\/go\/ausfuehrung\//);
  });

  it('Felder zur Auswahl; Rückverweise aktualisieren nach Umzug (Probelauf, dann setzen), fremde Werte bleiben', async () => {
    const f = (await env.call('GET', '/api/admin/integrations/openproject/fields')).body;
    assert.deepEqual(f.fields.map((x: { id: string; type: string }) => [x.id, x.type]), [['customField34', 'Link'], ['customField35', 'String']]);
    await env.call('POST', '/api/references', { ownerType: 'TEST_EXECUTION', ownerId: exec, relation: 'DEFECT', provider: 'openproject', externalKey: '900' });
    process.env.ANEMO_PUBLIC_URL = 'https://anemo.neu.test';
    const dry = (await env.call('POST', '/api/admin/integrations/openproject/backlinks', { dryRun: true })).body;
    assert.deepEqual([dry.set, dry.foreign, dry.errors], [1, 1, []]);
    assert.equal(wp['4711']!.customField34, `http://anemo.test/go/ausfuehrung/${exec}`, 'Probelauf ändert nichts');
    const run = (await env.call('POST', '/api/admin/integrations/openproject/backlinks', { dryRun: false })).body;
    assert.equal(run.set, 1);
    assert.equal(wp['4711']!.customField34, `https://anemo.neu.test/go/ausfuehrung/${exec}`);
    assert.equal(wp['900']!.customField34, 'https://fremd.example/x');
    assert.equal((await env.call('POST', '/api/admin/integrations/openproject/backlinks', { dryRun: false })).body.unchanged, 1);
  });

  it('dauerhafte Links: /go/… leitet relativ in die Oberfläche, /api/go löst auf', async () => {
    const res = await env.app.request(`/go/ausfuehrung/${exec}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/#/go/ausfuehrung/${exec}`);
    const r = (await env.call('GET', `/api/go/ausfuehrung/${exec}`)).body;
    assert.match(r.hash, /^#\/p\/RB\/cycles\/[0-9a-f-]+\?exec=/);
    assert.equal((await env.call('GET', '/api/go/kaputt/x')).status, 400);
  });

  it('Nachtest-Ergebnis geht als Kommentar an das Ticket des behobenen Fehlers (Review F4)', async () => {
    const { retestComment } = await import('../src/modules/integrations/index.ts');
    // Nachtest-Ausführung zu Fehler #4711 (wie von createRetest angelegt)
    await env.db`update test_execution set custom_fields = custom_fields || ${env.db.json({ retestFor: exec, retestDefect: 'openproject:4711' } as never)} where id = ${exec}`;
    await env.call('POST', `/api/executions/${exec}/result`, { status: 'WIP' });
    assert.equal(await retestComment(env.db, { aggregateId: exec, actor: 'tester' }), null, 'nur abschließende Ergebnisse');
    await env.call('POST', `/api/executions/${exec}/result`, { status: 'PASS' });
    const text = await retestComment(env.db, { aggregateId: exec, actor: 'tester' });
    assert.match(text ?? '', /Nachtest bestanden.*RB-T1/);
    assert.equal(comments.at(-1)?.wp, '4711');
    assert.match(comments.at(-1)!.raw, /Nachtest bestanden/);
  });
});
