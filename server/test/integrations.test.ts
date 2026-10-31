import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { backlinkComment, refreshOpenProjectReferences, renderTemplate, wikiToMarkdown } from '../src/modules/integrations/index.ts';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Vorlagen und Markdown', () => {
  it('ersetzt Platzhalter, Abschnitte und Kurzform', () => {
    const t = '[{{tc.key}}] {{fehler|kurz}}{{#step}} Schritt {{step.no}}{{/step}}{{^step}} ohne Schritt{{/step}}';
    assert.equal(renderTemplate(t, { tc: { key: 'X-T1' }, fehler: '*Absturz* beim Speichern\nDetails…', step: { no: 3 } }), '[X-T1] Absturz beim Speichern Schritt 3');
    assert.equal(renderTemplate(t, { tc: { key: 'X-T1' }, fehler: 'a', step: null }), '[X-T1] a ohne Schritt');
    assert.equal(renderTemplate('{{unbekannt}}x', {}), 'x');
  });
  it('übersetzt Jira-Markup nach Markdown', () => {
    const md = wikiToMarkdown('h3. Titel\n*fett* und _kursiv_\n# eins\n## zwei\n* Punkt\n{code}\na*b*c\n{code}\n[Anemo|https://x.test] [^log.txt]');
    assert.match(md, /^### Titel$/m);
    assert.match(md, /\*\*fett\*\* und \*kursiv\*/);
    assert.match(md, /^1\. eins$/m);
    assert.match(md, /^ {2}1\. zwei$/m);
    assert.match(md, /^- Punkt$/m);
    assert.match(md, /```\na\*b\*c\n```/);
    assert.match(md, /\[Anemo\]\(https:\/\/x\.test\) `log\.txt`/);
  });
});

describe('Fehler melden (OpenProject vorbereitet)', () => {
  let env: TestEnv;
  let execId: string;
  let stepIds: string[];
  const received: any[] = [];
  let mock: ReturnType<typeof serve>;
  const comments: { id: string; raw: string }[] = [];
  let wpStatus = 'Neu';

  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'DF', name: 'Defects' });
    await env.call('POST', '/api/projects/DF/test-cases', { content: { title: 'Akte speichern', preconditions: 'Benutzer angemeldet', steps: [
      { action: 'Akte öffnen', expected: 'Akte sichtbar' }, { action: 'Speichern klicken', expected: 'Gespeichert-Meldung' },
    ] } });
    const cycle = (await env.call('POST', '/api/projects/DF/cycles', { name: 'Regression ORA', release: '7.4', build: '7.4.2' })).body;
    await env.call('POST', `/api/cycles/${cycle.id}/executions`, { testCaseIds: ['DF-T1'] });
    execId = (await env.call('GET', `/api/cycles/${cycle.id}/executions`)).body.items[0].id;
    stepIds = (await env.call('GET', `/api/executions/${execId}`)).body.steps.map((s: any) => s.id);
    await env.call('POST', `/api/executions/${execId}/result`, { status: 'FAIL', comment: 'Speichern bricht ab', stepResults: [
      { stepId: stepIds[0], status: 'PASS' }, { stepId: stepIds[1], status: 'FAIL', comment: 'Fehlermeldung ORA-01400 statt Bestätigung' },
    ] }, 'tina');
    // simuliertes OpenProject
    const op = new Hono();
    op.get('/api/v3/users/me', (c) => c.json({ name: 'Anemo Technik', login: 'anemo' }));
    op.post('/api/v3/projects/:p/work_packages', async (c) => {
      const body = await c.req.json();
      received.push({ project: c.req.param('p'), auth: c.req.header('authorization'), body });
      return c.json({ id: 4711, subject: body.subject, _links: { status: { title: 'Neu' }, type: { title: 'Bug' } } }, 201);
    });
    op.post('/api/v3/work_packages/:id/activities', async (c) => {
      comments.push({ id: c.req.param('id'), raw: (await c.req.json()).comment.raw });
      return c.json({}, 201);
    });
    const list = (c: { req: { query: (k: string) => string | undefined } }) => {
      const ids = JSON.parse(c.req.query('filters')!)[0].id.values as string[];
      return { _embedded: { elements: ids.map((id) => ({ id: Number(id), subject: `Arbeitspaket ${id}`, _links: { status: { title: wpStatus }, type: { title: 'Bug' } } })) } };
    };
    op.get('/api/v3/work_packages', (c) => c.json(list(c)));
    // Abgleich und Rückverweis fragen nur im zugeordneten Projekt
    op.get('/api/v3/projects/:p/work_packages', (c) => c.json(list(c)));
    await new Promise<void>((r) => { mock = serve({ fetch: op.fetch, port: 0 }, () => r()); });
  });
  after(async () => {
    mock.close();
    delete process.env.OPENPROJECT_URL;
    delete process.env.OPENPROJECT_API_KEY;
    await env.close();
  });

  it('erzeugt aus der Standardvorlage einen Entwurf mit fehlgeschlagenem Schritt und Rückverweis', async () => {
    const r = await env.call('POST', `/api/executions/${execId}/defect-draft`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.title, '[DF-T1] Speichern klicken – Fehlermeldung ORA-01400 statt Bestätigung');
    assert.match(r.body.body, /h3\. Fehlgeschlagener Schritt 2/);
    assert.match(r.body.body, /\*Tatsächlich:\* Fehlermeldung ORA-01400/);
    assert.match(r.body.body, /Release\/Build: 7\.4 \/ 7\.4\.2/);
    assert.match(r.body.body, /← \*hier tritt der Fehler auf\*/);
    assert.match(r.body.body, /gemeldet von /, 'ohne öffentliche Adresse kein Link im Text');
    assert.deepEqual(r.body.target, { provider: 'openproject', available: false, reason: 'OpenProject ist noch nicht eingerichtet', externalProject: null });
    assert.equal((await env.call('POST', `/api/executions/${execId}/defects`, { title: 't', body: 'b' })).status, 409);
  });

  it('legt nach Einrichtung den Fehler in OpenProject an und verknüpft ihn', async () => {
    process.env.OPENPROJECT_URL = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/`;
    process.env.OPENPROJECT_API_KEY = 'test-schluessel';
    assert.deepEqual((await env.call('POST', '/api/admin/integrations/openproject/test')).body, { ok: true, user: 'anemo' });
    let d = (await env.call('POST', `/api/executions/${execId}/defect-draft`, {})).body;
    assert.equal(d.target.reason, 'Projekt ist keinem OpenProject-Projekt zugeordnet');
    assert.equal((await env.call('PUT', '/api/projects/DF/integrations/openproject', { externalProject: 'akte-dev', settings: { typeId: 7 } })).status, 204);
    d = (await env.call('POST', `/api/executions/${execId}/defect-draft`, {})).body;
    assert.equal(d.target.available, true);
    const created = await env.call('POST', `/api/executions/${execId}/defects`, { title: d.title, body: d.body });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual([created.body.provider, created.body.externalKey, created.body.relation], ['openproject', '4711', 'DEFECT']);
    assert.match(created.body.url, /\/work_packages\/4711$/);
    const sent = received[0];
    assert.equal(sent.project, 'akte-dev');
    assert.equal(sent.auth, `Basic ${Buffer.from('apikey:test-schluessel').toString('base64')}`);
    assert.equal(sent.body._links.type.href, '/api/v3/types/7');
    assert.match(sent.body.description.raw, /^### Fehlgeschlagener Schritt 2$/m);
    const back = (await env.call('GET', '/api/references/by-key/openproject/4711')).body;
    assert.equal(back[0].ownerId, execId);
  });

  it('Rückverweis als Kommentar beim Verknüpfen (nicht bei von Anemo angelegten Fehlern)', async () => {
    const tc = (await env.call('GET', '/api/test-cases/DF-T1')).body;
    const linkEvent = { aggregateType: 'TEST_CASE', aggregateId: tc.id, actor: 'tina', payload: { provider: 'openproject', externalKey: '815', relation: 'REQUIREMENT' } };
    const text = await backlinkComment(env.db, linkEvent);
    assert.match(text!, /Verknüpft in \*Anemo\* \(Anforderung\): Testfall DF-T1 „Akte speichern“ \(von tina\)/);
    assert.equal(comments.at(-1)!.id, '815');
    assert.equal(await backlinkComment(env.db, { ...linkEvent, payload: { ...linkEvent.payload, externalKey: '4711', relation: 'DEFECT' } }), null, 'von Anemo angelegt → kein zweiter Rückverweis');
  });

  it('Statusabgleich: erledigter Fehler erzeugt einen Nachtest im selben Zyklus, genau einmal', async () => {
    let r = await refreshOpenProjectReferences(env.db);
    assert.equal(r!.retests, 0);
    wpStatus = 'Geschlossen';
    r = await refreshOpenProjectReferences(env.db);
    assert.equal(r!.retests, 1);
    const e = (await env.call('GET', `/api/executions/${execId}`)).body;
    const items = (await env.call('GET', `/api/cycles/${e.cycleId}/executions`)).body.items;
    const retest = items.find((x: any) => x.id !== execId);
    assert.equal(retest.status, 'NOT_EXECUTED');
    assert.equal(retest.assignee, 'tina', 'an die Person, die den Fehler gefunden hat');
    const d = (await env.call('GET', `/api/executions/${retest.id}`)).body;
    assert.match(d.comment, /Nachtest: Fehler 4711/);
    wpStatus = 'Neu';
    await refreshOpenProjectReferences(env.db);
    wpStatus = 'Geschlossen';
    r = await refreshOpenProjectReferences(env.db);
    assert.equal(r!.retests, 0, 'kein zweiter Nachtest für denselben Fehler');
  });

  it('sendet nichts, wenn das Projekt externe Dienste sperrt', async () => {
    await env.call('PUT', '/api/projects/DF/visibility', { visibility: 'restricted' });
    const d = (await env.call('POST', `/api/executions/${execId}/defect-draft`, {})).body;
    assert.equal(d.target.reason, 'Für dieses Projekt sind externe Dienste gesperrt');
    assert.equal((await env.call('POST', `/api/executions/${execId}/defects`, { title: 't', body: 'b' })).status, 409);
    assert.equal(received.length, 1);
  });
});
