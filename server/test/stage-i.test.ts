import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { dispatchMail, dispatchWebhooks, setMailSender, setWebhookFetch } from '../src/modules/notifications/index.ts';
import { setJiraFetch } from '../src/modules/integrations/jira.ts';
import { refreshOpenProjectReferences } from '../src/modules/integrations/index.ts';
import { readXlsx, writeXlsx } from '../src/platform/xlsx.ts';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Stufe I', () => {
  let env: TestEnv;
  let plan: any;
  let cycle: any;
  let execs: any[];
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'SI', name: 'Stufe I' });
    for (const t of ['Anmelden', 'Akte drucken', 'Akte suchen']) await env.call('POST', '/api/projects/SI/test-cases', { content: { title: t, steps: [{ action: `${t} – Schritt 1`, expected: 'ok' }, { action: 'Schritt 2', expected: 'ok' }] } });
    plan = (await env.call('POST', '/api/projects/SI/plans', { name: 'Release 1' })).body;
    const today = new Date().toISOString().slice(0, 10);
    const in5 = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    cycle = (await env.call('POST', '/api/projects/SI/cycles', { name: 'Regression', planId: plan.id, startDate: today, endDate: in5 })).body;
    await env.call('POST', `/api/cycles/${cycle.id}/executions`, { testCaseIds: ['SI-T1', 'SI-T2', 'SI-T3'] });
    execs = (await env.call('GET', `/api/cycles/${cycle.id}/executions`)).body.items;
  });
  after(async () => {
    setMailSender(null); setWebhookFetch(null); setJiraFetch(null);
    for (const k of ['SMTP_HOST', 'SMTP_FROM', 'JIRA_BASE_URL', 'JIRA_TOKEN', 'JIRA_CREATE_DEFECTS', 'OPENPROJECT_URL', 'OPENPROJECT_API_KEY', 'GITLAB_URL', 'GITLAB_TOKEN']) delete process.env[k];
    await env.close();
  });

  it('Fehler je Schritt mit Schweregrad; fremde Schritt-ID abgewiesen', async () => {
    const ex = (await env.call('GET', `/api/executions/${execs[0].id}`)).body;
    const step = ex.steps[1].id;
    const bad = await env.call('POST', `/api/executions/${execs[0].id}/result`, { status: 'FAIL', comment: 'x', defects: [{ provider: 'jira', key: 'PROJ-1', stepId: 'gibt-es-nicht' }] });
    assert.equal(bad.status, 400);
    const r = await env.call('POST', `/api/executions/${execs[0].id}/result`, { status: 'FAIL', comment: 'Absturz', defects: [{ provider: 'jira', key: 'PROJ-1', stepId: step, severity: 'Hoch' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = r.body.defects.find((x: any) => x.externalKey === 'PROJ-1');
    assert.deepEqual([d.stepId, d.severity], [step, 'Hoch']);
    assert.equal((await env.call('PATCH', `/api/references/${d.id}`, { severity: 'Gering' })).status, 204);
    assert.equal((await env.call('GET', `/api/executions/${execs[0].id}`)).body.defects[0].severity, 'Gering');
  });

  it('Teststatusbericht und Burn-down mit Prognose; Lagebild', async () => {
    await env.call('POST', `/api/executions/${execs[1].id}/result`, { status: 'PASS' });
    assert.equal((await env.call('PUT', `/api/plans/${plan.id}/status-note`, { text: 'Hindernis: Testsystem zeitweise nicht erreichbar.' })).status, 204);
    const b = (await env.call('GET', `/api/plans/${plan.id}/burndown`)).body;
    assert.equal(b.remaining, 1);
    assert.ok(b.points.length >= 6, 'bis zum geplanten Ende');
    assert.ok(b.points.at(-1).ideal === 0);
    assert.ok(b.velocity > 0 && b.forecast);
    const r = (await env.call('GET', `/api/reports/status/${plan.id}?format=json`)).body;
    assert.equal(r.kind, 'status');
    assert.equal(r.inPeriod.executed, 2);
    assert.deepEqual(r.inPeriod.newDefects.map((d: any) => d.key), ['PROJ-1']);
    assert.match(r.statusNote.text, /Hindernis/);
    const md = await (await env.app.request(`/api/reports/status/${plan.id}?format=md`, { headers: { 'x-anemo-user': 'tester' } })).text();
    assert.match(md, /# Teststatusbericht/);
    assert.match(md, /Lagebild des Testmanagements/);
    const html = await (await env.app.request(`/api/reports/status/${plan.id}`, { headers: { 'x-anemo-user': 'tester' } })).text();
    assert.match(html, /<svg[^>]+aria-label="Burn-down"/);
    const pdf = await env.app.request(`/api/reports/status/${plan.id}?format=pdf`, { headers: { 'x-anemo-user': 'tester' } });
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal((await env.call('GET', `/api/reports/status/${plan.id}?from=2026-12-31&to=2026-01-01`)).status, 400);
  });

  it('Unstrukturierter Test (Freitext): Pflichttext, keine Schritte in der Ausführung, Suche und Abfrage', async () => {
    assert.equal((await env.call('POST', '/api/projects/SI/test-cases', { content: { title: 'Freitest', format: 'PLAIN' } })).status, 400);
    const tc = (await env.call('POST', '/api/projects/SI/test-cases', { content: { title: 'Freitest', format: 'PLAIN', plainText: 'Mandantenwechsel *dreimal* hintereinander ausführen', steps: [{ action: 'wird ignoriert' }] } })).body;
    assert.equal(tc.version.plainText, 'Mandantenwechsel *dreimal* hintereinander ausführen');
    const c = (await env.call('POST', '/api/projects/SI/cycles', { name: 'Frei' })).body;
    await env.call('POST', `/api/cycles/${c.id}/executions`, { testCaseIds: [tc.key] });
    const e = (await env.call('GET', `/api/cycles/${c.id}/executions`)).body.items[0];
    assert.deepEqual((await env.call('GET', `/api/executions/${e.id}`)).body.steps, []);
    assert.equal((await env.call('GET', '/api/projects/SI/test-cases?q=Mandantenwechsel')).body.items[0].key, tc.key);
    assert.deepEqual((await env.call('GET', `/api/projects/SI/test-cases?aql=${encodeURIComponent('format = freitext')}`)).body.items.map((x: any) => x.key), [tc.key]);
  });

  it('Schrittbibliothek: anlegen, suchen, Verwendung, archivieren, löschen', async () => {
    const b = await env.call('POST', '/api/projects/SI/step-blocks', { name: 'Anmelden als Sachbearbeitung', tags: ['Login'], steps: [{ action: 'Anmeldeseite öffnen', expected: 'Maske sichtbar' }, { action: 'Zugang eingeben', expected: 'Startseite' }] });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal((await env.call('POST', '/api/projects/SI/step-blocks', { name: 'Leer', steps: [{ action: '', expected: '' }] })).status, 400);
    assert.deepEqual((await env.call('GET', '/api/projects/SI/step-blocks?q=login')).body.map((x: any) => x.name), ['Anmelden als Sachbearbeitung']);
    const steps = b.body.steps.map((s: any) => ({ ...s, blockId: b.body.id }));
    await env.call('POST', '/api/projects/SI/test-cases', { content: { title: 'Nutzt Baustein', steps: [...steps, { action: 'Akte öffnen', expected: 'Akte' }] } });
    const one = (await env.call('GET', `/api/step-blocks/${b.body.id}`)).body;
    assert.equal(one.usage, 1);
    assert.equal(one.usedBy[0].title, 'Nutzt Baustein');
    assert.equal((await env.call('POST', `/api/step-blocks/${b.body.id}/archive`, { archived: true })).status, 204);
    assert.equal((await env.call('GET', '/api/projects/SI/step-blocks')).body.length, 0);
    assert.equal((await env.call('DELETE', `/api/step-blocks/${b.body.id}`)).status, 204);
  });

  it('Beobachten: Mail an Beobachter, nicht an den Auslöser; Zugriff geprüft', async () => {
    Object.assign(process.env, { SMTP_HOST: 'mail.example.test', SMTP_FROM: 'anemo@example.test' });
    const sent: any[] = [];
    setMailSender(async (_c, m) => { sent.push(m); });
    await env.db`insert into app_user(username, display_name, email) values ('wera', 'Wera', 'wera@example.test')`;
    await env.db`insert into user_notification(user_id, kind) select id, 'watched' from app_user where username = 'wera' on conflict do nothing`;
    await dispatchMail(env.db); // Lesezeiger ans Ende
    sent.length = 0;
    assert.equal((await env.call('PUT', `/api/watch/TEST_CYCLE/${cycle.id}`, undefined, 'wera')).status, 204);
    assert.equal((await env.call('PUT', '/api/watch/TEST_CYCLE/kein-uuid', undefined, 'wera')).status, 400);
    assert.equal((await env.call('PUT', `/api/watch/ANDERES/${cycle.id}`, undefined, 'wera')).status, 400);
    assert.deepEqual((await env.call('GET', `/api/watch/TEST_CYCLE/${cycle.id}`, undefined, 'wera')).body, { watching: true, watchers: 1 });
    await env.call('POST', `/api/executions/${execs[2].id}/result`, { status: 'FAIL', comment: 'kaputt' }, 'tina');
    await env.call('POST', `/api/executions/${execs[1].id}/result`, { status: 'FAIL', comment: 'eigene Aktion' }, 'wera');
    await dispatchMail(env.db);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Fehlgeschlagen: SI-T3 in „Regression“/);
    assert.doesNotMatch(sent[0].text, /SI-T2/, 'eigene Aktion nicht gemeldet');
    const mine = (await env.call('GET', '/api/watch', undefined, 'wera')).body;
    assert.deepEqual(mine.map((w: any) => [w.objectType, w.label, w.projectKey]), [['TEST_CYCLE', 'Regression', 'SI']]);
    assert.equal((await env.call('DELETE', `/api/watch/TEST_CYCLE/${cycle.id}`, undefined, 'wera')).status, 204);
  });

  it('Webhooks: Ereignisse gesperrter Projekte gehen nie hinaus – auch Testplan, Ordner und gelöschte Objekte', async () => {
    const got: any[] = [];
    setWebhookFetch(async (_u, init) => { got.push(JSON.parse(String(init!.body))); return new Response('ok'); });
    await env.call('POST', '/api/projects', { key: 'GS', name: 'Gesperrt' });
    await env.call('PUT', '/api/projects/GS/external-services', { externalServices: 'blocked' });
    await env.call('POST', '/api/admin/webhooks', { name: 'alle', url: 'https://hook.example.test/x', format: 'json', eventTypes: [], projectKey: null, active: true });
    const p = (await env.call('POST', '/api/projects/GS/plans', { name: 'Geheimplan' })).body;
    await env.call('POST', `/api/plans/${p.id}/release-decision`, { decision: 'rejected', note: 'geheime Begründung' });
    const f = (await env.call('POST', '/api/projects/GS/folders', { name: 'Geheimordner' })).body;
    await env.call('DELETE', `/api/folders/${f.id}`);
    await env.call('POST', '/api/projects/SI/cycles', { name: 'Offen' });
    await dispatchWebhooks(env.db);
    const text = JSON.stringify(got);
    assert.doesNotMatch(text, /geheime Begründung|Geheimordner|Geheimplan/);
    assert.ok(got.length > 0, 'Ereignisse erlaubter Projekte werden zugestellt');
  });

  it('Excel-Rundlauf: ausgeben, ausfüllen, Probelauf, Konflikt, übernehmen', async () => {
    const c = (await env.call('POST', '/api/projects/SI/cycles', { name: 'Offline' })).body;
    await env.call('POST', `/api/cycles/${c.id}/executions`, { testCaseIds: ['SI-T1', 'SI-T2'] });
    const res = await env.app.request(`/api/cycles/${c.id}/offline`, { headers: { 'x-anemo-user': 'tester' } });
    assert.equal(res.status, 200);
    const book = readXlsx(Buffer.from(await res.arrayBuffer()));
    const ex = book.find((s) => s.name === 'Ausführungen')!;
    const st = book.find((s) => s.name === 'Schritte')!;
    assert.equal(ex.rows.length, 3);
    const h = ex.rows[0]!, sh = st.rows[0]!;
    const set = (row: string[], header: string[], col: string, v: string) => { row[header.indexOf(col)] = v; };
    const r1 = [...ex.rows[1]!], r2 = [...ex.rows[2]!];
    set(r1, h, 'Neuer Status', 'Bestanden'); set(r1, h, 'Dauer (Min.)', '12');
    // T2: nur Schritte – Gesamtstatus wird abgeleitet
    const steps = st.rows.slice(1).map((r) => [...r]);
    for (const s of steps.filter((s) => s[sh.indexOf('Ausführungs-ID')] === r2[h.indexOf('Ausführungs-ID')])) { set(s, sh, 'Neuer Status', 'FAIL'); set(s, sh, 'Befund', 'Meldung fehlt'); }
    const file = async (rows: string[][], stepRows: string[][]) => (await writeXlsx([{ name: 'Ausführungen', header: h, rows }, { name: 'Schritte', header: sh, rows: stepRows }])).toString('base64');
    const b64 = await file([r1, r2], steps);
    const dry = (await env.call('POST', `/api/cycles/${c.id}/offline`, { contentBase64: b64, dryRun: true })).body;
    assert.deepEqual([dry.updated, dry.errors, dry.conflicts], [2, 0, 0], JSON.stringify(dry));
    assert.equal((await env.call('GET', `/api/cycles/${c.id}/executions`)).body.items.filter((e: any) => e.status !== 'NOT_EXECUTED').length, 0, 'Probelauf ändert nichts');
    // Konflikt: T1 wird zwischenzeitlich in Anemo geändert
    await new Promise((r) => setTimeout(r, 1100));
    await env.call('POST', `/api/executions/${r1[h.indexOf('Ausführungs-ID')]}/result`, { status: 'WIP' });
    const done = (await env.call('POST', `/api/cycles/${c.id}/offline`, { contentBase64: b64, dryRun: false })).body;
    assert.deepEqual([done.updated, done.conflicts], [1, 1], JSON.stringify(done));
    const items = (await env.call('GET', `/api/cycles/${c.id}/executions`)).body.items;
    assert.equal(items.find((e: any) => e.testCaseKey === 'SI-T2').status, 'FAIL');
    assert.equal(items.find((e: any) => e.testCaseKey === 'SI-T1').status, 'WIP');
    const forced = (await env.call('POST', `/api/cycles/${c.id}/offline`, { contentBase64: b64, dryRun: false, force: true })).body;
    assert.equal(forced.items.find((i: any) => i.key === 'SI-T1').action, 'updated');
    const bad = await file([[...r1.slice(0, h.indexOf('Neuer Status')), 'Quatsch', ...r1.slice(h.indexOf('Neuer Status') + 1)]], []);
    assert.equal((await env.call('POST', `/api/cycles/${c.id}/offline`, { contentBase64: bad, dryRun: true, force: true })).body.errors, 1);
    assert.equal((await env.call('POST', `/api/cycles/${c.id}/offline`, { contentBase64: Buffer.from('kein excel').toString('base64') })).status, 400);
  });

  it('Jira: Fehler nur nach Freischaltung und mit Zuordnung; Zugang aus Token', async () => {
    const created: any[] = [];
    setJiraFetch(async (url, init) => {
      created.push({ url: String(url), auth: (init!.headers as Record<string, string>).authorization, body: JSON.parse(String(init!.body)) });
      return new Response(JSON.stringify({ id: '1', key: 'JQA-77' }), { status: 201 });
    });
    Object.assign(process.env, { JIRA_BASE_URL: 'https://jira.example.test', JIRA_TOKEN: 'tok-123' });
    assert.equal((await env.call('PUT', '/api/projects/SI/integrations/jira', { externalProject: 'JQA', settings: { issueType: 'Fehler', priorities: { Hoch: 'Hoch' } } })).status, 204);
    const draft = (await env.call('POST', `/api/executions/${execs[2].id}/defect-draft`, {})).body;
    assert.equal(draft.target.available, false, 'ohne JIRA_CREATE_DEFECTS kein Schreiben');
    process.env.JIRA_CREATE_DEFECTS = 'true';
    const d2 = (await env.call('POST', `/api/executions/${execs[2].id}/defect-draft`, {})).body;
    assert.deepEqual([d2.target.provider, d2.target.available], ['jira', true]);
    const r = await env.call('POST', `/api/executions/${execs[2].id}/defects`, { title: d2.title, body: d2.body, severity: 'Hoch' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.provider, r.body.externalKey, r.body.severity], ['jira', 'JQA-77', 'Hoch']);
    assert.equal(created[0].url, 'https://jira.example.test/rest/api/2/issue');
    assert.equal(created[0].auth, 'Bearer tok-123');
    assert.deepEqual([created[0].body.fields.project.key, created[0].body.fields.issuetype.name, created[0].body.fields.priority.name], ['JQA', 'Fehler', 'Hoch']);
    assert.match(created[0].body.fields.description, /Schweregrad \(Anemo\):\* Hoch/);
    await env.call('PUT', '/api/projects/SI/external-services', { externalServices: 'blocked' });
    assert.equal((await env.call('POST', `/api/executions/${execs[2].id}/defects`, { title: 'x', body: 'y' })).status, 409);
    await env.call('PUT', '/api/projects/SI/external-services', { externalServices: 'allowed' });
    delete process.env.JIRA_CREATE_DEFECTS;
  });

  it('OpenProject: Sitzungsfund als Fehler, Zuordnung geprüft, Verknüpfen per Nummer, Abdeckung ins Ticket', async () => {
    const wps: any[] = [];
    const comments: { id: string; raw: string }[] = [];
    const op = new Hono();
    op.get('/api/v3/projects', (c) => c.json({ _embedded: { elements: [{ identifier: 'qa', name: 'QA' }] } }));
    op.get('/api/v3/projects/:p/types', (c) => c.json({ _embedded: { elements: [{ id: 7, name: 'Bug' }] } }));
    op.post('/api/v3/projects/:p/work_packages', async (c) => {
      const body = await c.req.json();
      wps.push(body);
      return c.json({ id: 900 + wps.length, subject: body.subject, _links: { status: { title: 'Neu' }, type: { title: 'Bug' } } }, 201);
    });
    op.get('/api/v3/work_packages/:id', (c) => c.json({ id: Number(c.req.param('id')), subject: 'Anforderung Druck', _links: { status: { title: 'Neu' }, type: { title: 'Feature' } } }));
    op.get('/api/v3/work_packages', (c) => c.json({ _embedded: { elements: [] } }));
    // Arbeitspakete im Projekt „qa“ (77 gehört zu einem fremden Projekt)
    op.get('/api/v3/projects/:p/work_packages', (c) => {
      const ids = (JSON.parse(c.req.query('filters') ?? '[]')[0]?.id?.values ?? []) as string[];
      return c.json({ _embedded: { elements: ids.filter((id) => id !== '77').map((id) => ({ id: Number(id), subject: 'Anforderung Druck', _links: { status: { title: 'Neu' }, type: { title: 'Feature' } } })) } });
    });
    op.post('/api/v3/work_packages/:id/activities', async (c) => { comments.push({ id: c.req.param('id'), raw: (await c.req.json()).comment.raw }); return c.json({}, 201); });
    const server = await new Promise<ReturnType<typeof serve>>((r) => { const s = serve({ fetch: op.fetch, port: 0 }, (i) => { process.env.OPENPROJECT_URL = `http://127.0.0.1:${i.port}`; r(s); }); });
    process.env.OPENPROJECT_API_KEY = 'k';
    try {
      // ohne Zuordnung: Status nennt den Grund; Nummer geht trotzdem, aber ohne Inhalte aus OpenProject (Sicherheit 3)
      const st = (await env.call('GET', '/api/projects/SI/integrations/openproject/status')).body;
      assert.deepEqual([st.available, st.configured, st.allowed], [false, true, true]);
      const byNo = (await env.call('GET', '/api/projects/SI/integrations/openproject/work-items/42')).body;
      assert.deepEqual([byNo.key, byNo.title, byNo.status, byNo.verified], ['42', null, null, false]);
      assert.match(byNo.url, /\/work_packages\/42$/);
      assert.equal((await env.call('GET', '/api/projects/SI/integrations/openproject/work-items/42%2F..')).status, 400);
      assert.equal((await env.call('PUT', '/api/projects/SI/integrations/openproject', { externalProject: 'gibtsnicht' })).status, 400);
      assert.equal((await env.call('PUT', '/api/projects/SI/integrations/openproject', { externalProject: 'qa', settings: { typeId: 7, coverageComments: true } })).status, 204);
      const admin = (await env.call('GET', '/api/admin/integrations/openproject/projects')).body;
      assert.equal(admin.links.find((l: any) => l.key === 'SI').externalProject, 'qa');
      // mit Zuordnung: Titel/Status nur für Arbeitspakete des zugeordneten Projekts
      assert.equal((await env.call('GET', '/api/projects/SI/integrations/openproject/work-items/42')).body.title, 'Anforderung Druck');
      assert.equal((await env.call('GET', '/api/projects/SI/integrations/openproject/work-items/77')).status, 404, 'fremdes Projekt');
      // Sitzungsfund → Fehler
      const s = (await env.call('POST', `/api/cycles/${cycle.id}/sessions`, { charter: 'Druckdialog erkunden', timeboxMinutes: 30 })).body;
      const withFinding = (await env.call('POST', `/api/sessions/${s.id}/findings`, { kind: 'bug', text: 'Druckvorschau leer bei A3' })).body;
      const fid = withFinding.findings[0].id;
      const r = await env.call('POST', `/api/sessions/${s.id}/findings/${fid}/defect`, { severity: 'Mittel' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(wps[0].subject, 'Druckvorschau leer bei A3');
      assert.match(wps[0].description.raw, /Druckdialog erkunden/);
      assert.equal((await env.call('GET', `/api/sessions/${s.id}`)).body.findings[0].defectKey, String(r.body.externalKey));
      assert.equal((await env.call('POST', `/api/sessions/${s.id}/findings/${fid}/defect`, {})).status, 409, 'nicht doppelt');
      // Abdeckung ins Ticket: nur bei Änderung
      const tc = (await env.call('GET', '/api/test-cases/SI-T2')).body;
      await env.call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: tc.id, provider: 'openproject', externalKey: '42', relation: 'REQUIREMENT' });
      comments.length = 0;
      await refreshOpenProjectReferences(env.db);
      const cov = comments.filter((c) => /Testabdeckung/.test(c.raw));
      assert.equal(cov.length, 1);
      assert.match(cov[0]!.raw, /SI-T2/);
      await refreshOpenProjectReferences(env.db);
      assert.equal(comments.filter((c) => /Testabdeckung/.test(c.raw)).length, 1, 'unverändert → kein neuer Kommentar');
    } finally {
      server.close();
    }
  });

  it('GitLab: Pipeline für den Zyklus starten, Status abfragen', async () => {
    const calls: any[] = [];
    const gl = new Hono();
    gl.post('/api/v4/projects/:p/pipeline', async (c) => { const b = await c.req.json(); calls.push({ p: c.req.param('p'), b }); return c.json({ id: 55, status: 'created', web_url: 'https://gitlab.example.test/qa/akte/-/pipelines/55', ref: b.ref }, 201); });
    gl.get('/api/v4/projects/:p/pipelines/:id', (c) => c.json({ id: 55, status: 'success', web_url: 'https://gitlab.example.test/qa/akte/-/pipelines/55', ref: 'main' }));
    const server = await new Promise<ReturnType<typeof serve>>((r) => { const s = serve({ fetch: gl.fetch, port: 0 }, (i) => { process.env.GITLAB_URL = `http://127.0.0.1:${i.port}`; r(s); }); });
    process.env.GITLAB_TOKEN = 'glpat-test';
    try {
      assert.equal((await env.call('POST', `/api/cycles/${cycle.id}/ci-runs`, {})).status, 409, 'ohne Zuordnung');
      await env.call('PUT', '/api/projects/SI/integrations/gitlab', { externalProject: 'qa/akte', settings: { branch: 'main', ciRef: 'release', ciRefs: ['release/2.x'], ciVariables: ['SUITE'] } });
      const noUrl = await env.call('POST', `/api/cycles/${cycle.id}/ci-runs`, {});
      assert.equal(noUrl.status, 409, 'ohne ANEMO_PUBLIC_URL kein Start (Adresse nie aus dem Host-Kopf)');
      assert.match(noUrl.body.detail, /ANEMO_PUBLIC_URL/);
      process.env.ANEMO_PUBLIC_URL = 'https://anemo.example.test/';
      assert.equal((await env.call('POST', `/api/cycles/${cycle.id}/ci-runs`, { variables: { 'böse name': 'x' } })).status, 400);
      for (const v of ['ANEMO_CYCLE_ID', 'CI_DEBUG_TRACE', 'GITLAB_FEATURES', 'TEST_DEBUG_TRACE', 'DEPLOY']) {
        assert.equal((await env.call('POST', `/api/cycles/${cycle.id}/ci-runs`, { variables: { [v]: 'x' } })).status, 400, v);
      }
      assert.equal((await env.call('POST', `/api/cycles/${cycle.id}/ci-runs`, { ref: 'main' })).status, 400, 'nicht freigegebener Zweig');
      assert.equal(calls.length, 0);
      const r = await env.call('POST', `/api/cycles/${cycle.id}/ci-runs`, { variables: { SUITE: 'smoke', TEST_BROWSER: 'firefox' } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(calls[0].p, 'qa/akte');
      assert.equal(calls[0].b.ref, 'release');
      const vars = Object.fromEntries(calls[0].b.variables.map((v: any) => [v.key, v.value]));
      assert.equal(vars.ANEMO_CYCLE_ID, cycle.id);
      assert.equal(vars.ANEMO_URL, 'https://anemo.example.test');
      assert.equal(vars.SUITE, 'smoke');
      assert.equal(vars.TEST_BROWSER, 'firefox');
      assert.equal(vars.ANEMO_PROJECT, 'SI');
      assert.equal((await env.call('POST', `/api/cycles/${cycle.id}/ci-runs`, { ref: 'release/2.x' })).status, 201, 'freigegebener Zweig aus ciRefs');
      const runs = (await env.call('GET', `/api/cycles/${cycle.id}/ci-runs`)).body;
      assert.equal(runs[0].status, 'success');
    } finally {
      delete process.env.ANEMO_PUBLIC_URL;
      server.close();
    }
  });
});
