import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Freie Links (URL mit Kurznamen)', () => {
  let env: TestEnv;
  let tc: string;
  let exec: string;
  let plan: string;
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'UL', name: 'Links' });
    tc = (await env.call('POST', '/api/projects/UL/test-cases', { content: { title: 'A', steps: [{ action: 'a', expected: 'b' }] } })).body.id;
    plan = (await env.call('POST', '/api/projects/UL/plans', { name: 'R' })).body.id;
    const c = (await env.call('POST', '/api/projects/UL/cycles', { name: 'Z', planId: plan })).body;
    await env.call('POST', `/api/cycles/${c.id}/executions`, { testCaseIds: ['UL-T1'] });
    exec = (await env.call('GET', `/api/cycles/${c.id}/executions`)).body.items[0].id;
  });
  after(async () => { for (const k of ['ANEMO_URL_LINKS', 'ANEMO_URL_LINK_DOMAINS']) delete process.env[k]; await env.close(); });

  it('ausgeschaltet: abgelehnt; eingeschaltet: Kurzname Pflicht, nur http(s), Domainliste', async () => {
    const link = (externalKey: string, title?: string, relation = 'DOCUMENTATION') => env.call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: tc, provider: 'url', externalKey, title, relation });
    assert.deepEqual((await env.call('GET', '/api/link-settings')).body, { enabled: false, domains: [] });
    assert.equal((await link('https://wiki.firma.de/x', 'Spezifikation')).status, 400);
    process.env.ANEMO_URL_LINKS = 'true';
    assert.equal((await link('https://wiki.firma.de/x')).status, 400, 'ohne Kurzname');
    assert.equal((await link('javascript:alert(1)', 'böse')).status, 400);
    assert.equal((await link('https://nutzer:geheim@wiki.firma.de/x', 'Zugang')).status, 400);
    process.env.ANEMO_URL_LINK_DOMAINS = '*.firma.de, example.org';
    assert.equal((await link('https://fremd.example.com/x', 'Fremd')).status, 400);
    const ok = await link('https://wiki.firma.de/spec?id=7', 'Spezifikation 7');
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.provider, ok.body.title, ok.body.url], ['url', 'Spezifikation 7', 'https://wiki.firma.de/spec?id=7']);
    assert.equal((await link('https://example.org/a', 'Beispiel')).status, 201);
    assert.equal((await link('https://firma.de/a', 'Hauptdomain')).status, 201, '*.firma.de umfasst firma.de');
    // andere Anbieter: Domainliste gilt auch hier; bei Jira/OpenProject zählt eine mitgeschickte Adresse nicht (Review S7)
    const other = (provider: string, url: string) => env.call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: tc, provider, externalKey: `${provider}-1`, url, relation: 'AUTOMATION' });
    assert.equal((await other('jenkins', 'https://fremd.example.com/job/1')).status, 400);
    assert.equal((await other('jenkins', 'https://ci.firma.de/job/1')).status, 201);
    const jira = await env.call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: tc, provider: 'jira', externalKey: 'ABC-1', url: 'https://boese.example.com/', relation: 'REQUIREMENT' });
    assert.equal(jira.status, 201);
    assert.notEqual(jira.body.url, 'https://boese.example.com/');
  });

  it('Fehler als Link: Status von Hand, zählt in der Freigabe, Kurzname im Bericht', async () => {
    process.env.ANEMO_URL_LINK_DOMAINS = '';
    const r = await env.call('POST', `/api/executions/${exec}/result`, { status: 'FAIL', comment: 'Absturz beim Speichern', defects: [{ provider: 'url', key: 'https://bugs.example.net/123', title: 'Bug 123 (Altsystem)' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.defects[0];
    assert.deepEqual([d.provider, d.title, d.status], ['url', 'Bug 123 (Altsystem)', 'offen']);
    let cp = (await env.call('GET', `/api/plans/${plan}/cockpit`)).body;
    assert.equal(cp.openDefects.length, 1);
    assert.equal((await env.call('PATCH', `/api/references/${d.id}`, { status: 'behoben' })).status, 204);
    cp = (await env.call('GET', `/api/plans/${plan}/cockpit`)).body;
    assert.equal(cp.openDefects.length, 0, 'von Hand behoben');
    const html = await (await env.app.request(`/api/reports/completion/${plan}`, { headers: { 'x-anemo-user': 'tester' } })).text();
    assert.match(html, />Bug 123 \(Altsystem\)</);
    // Tickets: Status nicht von Hand
    const jira = (await env.call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: tc, provider: 'jira', externalKey: 'ABC-1', relation: 'DEFECT' })).body;
    assert.equal((await env.call('PATCH', `/api/references/${jira.id}`, { status: 'behoben' })).status, 400);
    // ohne Anbieter wird eine Adresse als Link erkannt; Massenbearbeitung mit Kurzname
    assert.equal((await env.call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: tc, externalKey: 'https://docs.example.net/x', title: 'Doku', relation: 'RELATED' })).body.provider, 'url');
    const b = await env.call('POST', '/api/executions/bulk', { ids: [exec], addDefects: [{ key: 'https://bugs.example.net/124', title: 'Bug 124' }] });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    process.env.ANEMO_URL_LINKS = 'false';
    assert.equal((await env.call('POST', `/api/executions/${exec}/result`, { status: 'FAIL', comment: 'nochmal', defects: [{ provider: 'url', key: 'https://bugs.example.net/9', title: 'x' }] })).status, 400);
  });
});

describe('Ticket-Adresse für von Hand verknüpfte Schlüssel', () => {
  it('Jira …/browse/KEY und OpenProject …/work_packages/NR aus der Konfiguration, sonst keine', async () => {
    const { ticketUrl } = await import('../src/modules/references/index.ts');
    assert.equal(ticketUrl('jira', 'PROJ-315', { JIRA_HOST: 'jira.firma.lan:8080' }), 'http://jira.firma.lan:8080/browse/PROJ-315');
    assert.equal(ticketUrl('jira', 'PROJ-315', { JIRA_BASE_URL: 'https://jira.firma.de/' }), 'https://jira.firma.de/browse/PROJ-315');
    assert.equal(ticketUrl('openproject', '4711', { OPENPROJECT_URL: 'http://op:8090/' }), 'http://op:8090/work_packages/4711');
    assert.equal(ticketUrl('jira', 'PROJ-315', {}), null);
    assert.equal(ticketUrl('jira', 'kein schlüssel', { JIRA_HOST: 'x' }), null);
  });
});

describe('Schlüssel wie PROJ-315: OpenProject (Projektschlüssel ab Version 17) statt Jira', () => {
  let env: TestEnv;
  let srv: import('node:http').Server;
  let exec: string;
  const saved = { ...process.env };
  before(async () => {
    const { createServer } = await import('node:http');
    srv = createServer((req, res) => {
      const m = /^\/api\/v3\/work_packages\/([^/?]+)/.exec(req.url ?? '');
      if (m && ['PROJ-315', '288'].includes(decodeURIComponent(m[1]!))) {
        res.writeHead(200, { 'content-type': 'application/hal+json' });
        res.end(JSON.stringify({ id: 288, subject: 'Server / Konfig', displayId: 'PROJ-315', _links: { status: { title: 'Neu' }, type: { title: 'Fehler' } } }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/hal+json' }); res.end(JSON.stringify({ message: 'nicht gefunden' }));
    });
    await new Promise<void>((r) => srv.listen(0, r));
    process.env.OPENPROJECT_URL = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`;
    process.env.OPENPROJECT_API_KEY = 'test';
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'OK', name: 'OP-Schlüssel' });
    const tc = (await env.call('POST', '/api/projects/OK/test-cases', { content: { title: 'A', steps: [{ action: 'a', expected: 'b' }] } })).body.id;
    const c = (await env.call('POST', '/api/projects/OK/cycles', { name: 'Z' })).body.id;
    await env.call('POST', `/api/cycles/${c}/executions`, { testCaseIds: [tc] });
    exec = (await env.call('GET', `/api/cycles/${c}/executions`)).body.items[0].id;
  });
  after(async () => { process.env = saved; srv.close(); await env.close(); });

  it('nur OpenProject angebunden: PROJ-315 wird OpenProject-Verweis mit Link; beide angebunden: unbekannter Schlüssel bleibt Jira', async () => {
    const r = await env.call('POST', `/api/executions/${exec}/result`, { status: 'FAIL', comment: 'kaputt', defects: [{ key: 'proj-315' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    let refs = (await env.call('GET', `/api/references?ownerType=TEST_EXECUTION&ownerId=${exec}`)).body;
    assert.deepEqual(refs.map((x: { provider: string; externalKey: string; url: string }) => [x.provider, x.externalKey, x.url]),
      [['openproject', 'PROJ-315', `${process.env.OPENPROJECT_URL}/work_packages/PROJ-315`]]);
    process.env.JIRA_HOST = 'jira.example'; process.env.JIRA_BASIC_AUTH = 'Basic eDp5';
    await env.call('POST', `/api/executions/${exec}/result`, { status: 'FAIL', comment: 'kaputt', defects: [{ key: 'ABC-1' }, { key: 'PROJ-315' }] });
    refs = (await env.call('GET', `/api/references?ownerType=TEST_EXECUTION&ownerId=${exec}`)).body;
    assert.deepEqual(refs.map((x: { provider: string; externalKey: string }) => [x.provider, x.externalKey]).sort(), [['jira', 'ABC-1'], ['openproject', 'PROJ-315']]);
    // „Verknüpfen“ am Schritt (Verweis-Route ohne Anbieter) entscheidet genauso
    delete process.env.JIRA_HOST; delete process.env.JIRA_BASIC_AUTH;
    const step = (await env.call('GET', `/api/executions/${exec}`)).body.steps[0].id;
    const r2 = await env.call('POST', '/api/references', { ownerType: 'TEST_EXECUTION', ownerId: exec, relation: 'DEFECT', externalKey: 'PROJ-315', stepId: step });
    assert.equal(r2.status, 201, JSON.stringify(r2.body));
    assert.deepEqual([r2.body.provider, r2.body.externalKey, r2.body.url], ['openproject', 'PROJ-315', `${process.env.OPENPROJECT_URL}/work_packages/PROJ-315`]);
  });
});

describe('Dasselbe Ticket an mehreren Schritten einer Ausführung', () => {
  let env: TestEnv;
  before(async () => { env = await testEnv(); await env.call('POST', '/api/projects', { key: 'MS', name: 'Mehrere Schritte' }); });
  after(() => env.close());
  it('ein Eintrag je Schritt, ohne Schritt keine Dublette, Schweregrad je Ticket, Bericht zählt einmal', async () => {
    const tc = (await env.call('POST', '/api/projects/MS/test-cases', { content: { title: 'A', steps: [{ action: 'a', expected: 'b' }, { action: 'c', expected: 'd' }] } })).body.id;
    const c = (await env.call('POST', '/api/projects/MS/cycles', { name: 'Z' })).body.id;
    await env.call('POST', `/api/cycles/${c}/executions`, { testCaseIds: [tc] });
    const exec = (await env.call('GET', `/api/cycles/${c}/executions`)).body.items[0].id;
    const [s1, s2] = (await env.call('GET', `/api/executions/${exec}`)).body.steps.map((s: { id: string }) => s.id);
    const link = (stepId?: string) => env.call('POST', '/api/references', { ownerType: 'TEST_EXECUTION', ownerId: exec, relation: 'DEFECT', provider: 'jira', externalKey: 'MS-1', ...(stepId ? { stepId } : {}) });
    assert.equal((await link()).status, 201);
    assert.equal((await link(s1)).body.stepId, s1, 'schrittloser Eintrag wird Schritt 1 zugeordnet');
    assert.equal((await link(s2)).body.stepId, s2);
    assert.equal((await link(s2)).status, 201, 'erneut: idempotent');
    await link();
    let refs = (await env.call('GET', `/api/references?ownerType=TEST_EXECUTION&ownerId=${exec}`)).body;
    assert.deepEqual(refs.map((r: { stepId: string }) => r.stepId).sort(), [s1, s2].sort());
    assert.equal((await env.call('PATCH', `/api/references/${refs[0].id}`, { severity: 'Hoch' })).status < 300, true);
    refs = (await env.call('GET', `/api/references?ownerType=TEST_EXECUTION&ownerId=${exec}`)).body;
    assert.deepEqual(refs.map((r: { severity: string }) => r.severity), ['Hoch', 'Hoch']);
    const { testLog } = await import('../src/modules/reports/data.ts');
    assert.equal((await testLog(env.db, c, 'admin', { steps: false })).executions[0]!.defects.length, 1);
  });
});
