/**
 * Regressionstests zu den Review-Befunden vom 11.10.2026 (Fachreview Teil 3 und Sicherheitsreview Teil 2), Bereich
 * Integrationen, Benachrichtigungen, Verweise, Felder, Projektlöschen und Einstellungen. Die Nachweise aus dem
 * Sicherheitsreview (Prüfskript verify-teil2) sind hier als Erwartungen übernommen.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { listEvents } from '../src/modules/events/index.ts';
import { backlinkComment, jiraConfig, refreshGitlabReferences, refreshJiraReferences, refreshOpenProjectReferences, wikiToMarkdown } from '../src/modules/integrations/index.ts';
import { requirementCoverage } from '../src/modules/integrations/coverage.ts';
import { collectMails } from '../src/modules/notifications/mail.ts';
import { watchNotes } from '../src/modules/notifications/watch.ts';
import { SEVERITIES } from '../src/modules/references/index.ts';
import { type TestEnv, testEnv } from './helpers.ts';

// ---- Gegenstellen (OpenProject, GitLab, Jira, Webhook) in einem Stub ----
const seen: { method: string; url: string; body: string }[] = [];
const comments: { id: string; raw: string }[] = [];
const created: string[] = [];
/** Arbeitspaket → OpenProject-Projekt (unbekannte Nummern gehören zu „qa“) */
const wpProject: Record<string, string> = { 99: 'fremd', 77: 'fremd' };
const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const url = new URL(req.url!, 'http://stub');
    seen.push({ method: req.method!, url: req.url!, body });
    const wp = (id: string) => ({ id: Number(id), subject: `Arbeitspaket ${id}`, _links: { status: { title: 'Neu' }, type: { title: 'Anforderung' } } });
    let m: RegExpExecArray | null;
    if (req.method === 'GET' && url.pathname === '/api/v3/projects') return json(res, 200, { _embedded: { elements: ['qa', 'qa2', 'fremd'].map((identifier) => ({ identifier, name: identifier })) } });
    if (req.method === 'GET' && (m = /^\/api\/v3\/projects\/([^/]+)\/work_packages$/.exec(url.pathname))) {
      const ids = (JSON.parse(url.searchParams.get('filters') ?? '[]')[0]?.id?.values ?? []) as string[];
      return json(res, 200, { _embedded: { elements: ids.filter((id) => (wpProject[id] ?? 'qa') === decodeURIComponent(m![1]!)).map(wp) } });
    }
    if (req.method === 'POST' && (m = /^\/api\/v3\/projects\/([^/]+)\/work_packages$/.exec(url.pathname))) {
      const b = JSON.parse(body);
      if (String(b.subject).includes('FEHLER500')) return json(res, 500, { message: 'kaputt' });
      await new Promise((r) => setTimeout(r, 150)); // langsame Gegenstelle: Zeitfenster für Doppelklick
      created.push(b.subject);
      return json(res, 201, { id: 900 + created.length, subject: b.subject, _links: { status: { title: 'Neu' }, type: { title: 'Bug' } } });
    }
    if (url.pathname.startsWith('/api/v3/work_packages') && req.method === 'GET') {
      // ungefilterter Zugriff über das Servicekonto – darf nicht mehr vorkommen
      return json(res, 200, url.pathname === '/api/v3/work_packages' ? { _embedded: { elements: [{ id: 42, subject: 'GEHEIM', _links: {} }] } } : { id: 42, subject: 'GEHEIM: Fremdprojekt', _links: { status: { title: 'Neu' } } });
    }
    if (req.method === 'POST' && (m = /^\/api\/v3\/work_packages\/([^/]+)\/activities$/.exec(url.pathname))) {
      if (m[1] === '41') return json(res, 404, { message: 'Arbeitspaket gelöscht' });
      comments.push({ id: decodeURIComponent(m[1]!), raw: JSON.parse(body).comment.raw });
      return json(res, 201, {});
    }
    if ((m = /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)$/.exec(url.pathname))) return json(res, 200, { iid: Number(m[2]), title: `MR aus ${decodeURIComponent(m[1]!)}`, state: 'opened', web_url: 'https://gitlab.example.test/mr' });
    if ((m = /^\/api\/v4\/projects\/([^/]+)\/pipeline$/.exec(url.pathname))) { const b = JSON.parse(body); return json(res, 201, { id: 7, status: 'created', web_url: 'https://gitlab.example.test/p/7', ref: b.ref }); }
    if (url.pathname === '/rest/api/2/search') {
      const keys = [...String(JSON.parse(body).jql).matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
      return json(res, 200, { issues: keys.map((key) => ({ key, fields: { summary: `Ticket ${key}`, status: { name: 'Offen' } } })) });
    }
    if (url.pathname === '/hook') { res.statusCode = 500; return res.end('INTERN-GEHEIMNIS: Datenbankpasswort 1234'); }
    json(res, 404, { message: 'unbekannt' });
  });
});

before(async () => {
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  Object.assign(process.env, { OPENPROJECT_URL: base, OPENPROJECT_API_KEY: 'k', GITLAB_URL: base, GITLAB_TOKEN: 't', JIRA_BASE_URL: base, JIRA_BASIC_AUTH: 'leser:geheim' });
  delete process.env.ANEMO_PUBLIC_URL;
});
after(() => {
  stub.close();
  for (const k of ['OPENPROJECT_URL', 'OPENPROJECT_API_KEY', 'GITLAB_URL', 'GITLAB_TOKEN', 'JIRA_BASE_URL', 'JIRA_BASIC_AUTH', 'ANEMO_PUBLIC_URL']) delete process.env[k];
});

describe('Review Teil 3 / Sicherheit Teil 2 – mit Anmeldung', () => {
  let env: TestEnv;
  const PW = 'Sicheres-Passwort-1';
  const cookies = new Map<string, string>();
  const uid: Record<string, string> = {};
  const req = async (user: string, method: string, path: string, body?: unknown, host = 'anemo.test') => {
    const res = await env.app.request(path, { method, headers: { 'content-type': 'application/json', host, cookie: cookies.get(user) ?? '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') };
  };
  const login = async (u: string) => cookies.set(u, (await req('', 'POST', '/api/auth/login', { username: u, password: PW })).setCookie!.split(';')[0]!);
  let tcR = '';
  let tcA = '';
  let cycleA = '';
  let execA = '';
  let execR = '';

  before(async () => {
    env = await testEnv({ authMode: 'on' });
    process.env.ANEMO_ADMIN_PASSWORD = PW;
    const { bootstrapAdmin } = await import('../src/modules/auth/index.ts');
    await bootstrapAdmin(env.db, '/dev/null', () => {});
    delete process.env.ANEMO_ADMIN_PASSWORD;
    await login('admin');
    for (const u of ['vera', 'desi', 'tess', 'mira']) { uid[u] = (await req('admin', 'POST', '/api/admin/users', { username: u, displayName: u, password: PW })).body.id; await login(u); }
    await req('admin', 'POST', '/api/projects', { key: 'AA', name: 'Intern' });
    await req('admin', 'POST', '/api/projects', { key: 'RR', name: 'Vertraulich' });
    await req('admin', 'PUT', '/api/projects/RR/visibility', { visibility: 'restricted' });
    for (const k of ['AA', 'RR']) await req('admin', 'PUT', `/api/projects/${k}/external-services`, { externalServices: 'allowed' });
    await req('admin', 'PUT', '/api/projects/AA/members', { principalType: 'user', principalId: uid.desi, role: 'DESIGNER' });
    await req('admin', 'PUT', '/api/projects/AA/members', { principalType: 'user', principalId: uid.tess, role: 'TESTER' });
    await req('admin', 'PUT', '/api/projects/RR/members', { principalType: 'user', principalId: uid.tess, role: 'TESTER' });
    await req('admin', 'PUT', '/api/projects/RR/members', { principalType: 'user', principalId: uid.mira, role: 'VIEWER' });
    await req('admin', 'POST', '/api/admin/fields', { scope: 'test_case', key: 'kunde', name: 'Kunde (vertraulich)', type: 'select', options: ['Bundesamt X'], required: false, projectKey: 'RR', sortOrder: 1, active: true });
    tcR = (await req('admin', 'POST', '/api/projects/RR/test-cases', { content: { title: 'Vertraulicher Ablauf Z', steps: [{ action: 'a', expected: 'b' }] } })).body.id;
    tcA = (await req('admin', 'POST', '/api/projects/AA/test-cases', { content: { title: 'A1', steps: [{ action: 'öffnen', expected: 'offen' }] } })).body.id;
    cycleA = (await req('admin', 'POST', '/api/projects/AA/cycles', { name: 'Lauf' })).body.id;
    await req('admin', 'POST', `/api/cycles/${cycleA}/executions`, { testCaseIds: ['AA-T1'] });
    execA = (await req('admin', 'GET', `/api/cycles/${cycleA}/executions`)).body.items[0].id;
    const cycleR = (await req('admin', 'POST', '/api/projects/RR/cycles', { name: 'Lauf R' })).body.id;
    await req('admin', 'POST', `/api/cycles/${cycleR}/executions`, { testCaseIds: ['RR-T1'] });
    execR = (await req('admin', 'GET', `/api/cycles/${cycleR}/executions`)).body.items[0].id;
  });
  after(async () => { await env?.close(); });

  it('Sicherheit 6: Felder eingeschränkter Projekte nur mit Leserecht, all=true nur Administration', async () => {
    assert.equal((await req('vera', 'GET', '/api/fields?project=RR')).status, 404);
    const tess = await req('tess', 'GET', '/api/fields?project=RR');
    assert.equal(tess.status, 200);
    assert.ok(tess.body.some((f: any) => f.key === 'kunde'));
    assert.equal((await req('vera', 'GET', '/api/fields?all=true')).status, 403);
    assert.ok((await req('vera', 'GET', '/api/fields')).body.every((f: any) => f.projectId === null), 'ohne Projekt nur globale Felder');
    assert.ok((await req('admin', 'GET', '/api/fields?all=true')).body.some((f: any) => f.key === 'kunde'));
  });

  it('Sicherheit 3: Nachschlagen per Nummer ohne Zuordnung liefert keine Inhalte, mit Zuordnung nur aus dem Projekt', async () => {
    const before = seen.length;
    const r = await req('vera', 'GET', '/api/projects/AA/integrations/openproject/work-items/42');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.key, r.body.title, r.body.status, r.body.verified], ['42', null, null, false]);
    assert.ok(!JSON.stringify(r.body).includes('GEHEIM'));
    assert.equal(seen.slice(before).length, 0, 'kein Aufruf an OpenProject');
    assert.equal((await req('admin', 'PUT', '/api/projects/RR/integrations/openproject', { externalProject: 'qa' })).status, 204);
    assert.equal((await req('tess', 'GET', '/api/projects/RR/integrations/openproject/work-items/42')).body.title, 'Arbeitspaket 42');
    assert.equal((await req('tess', 'GET', '/api/projects/RR/integrations/openproject/work-items/99')).status, 404, 'Arbeitspaket eines fremden Projekts');
  });

  it('Sicherheit 4: Schlüssel nur Nummern, Rückverweis nur an Arbeitspakete des zugeordneten Projekts', async () => {
    const bad = await req('tess', 'POST', '/api/references', { ownerType: 'TEST_EXECUTION', ownerId: execA, provider: 'openproject', externalKey: '99/../../../api/v3/foo?', relation: 'DEFECT' });
    assert.equal(bad.status, 400);
    const posts = () => seen.filter((s) => s.method === 'POST' && s.url.includes('/activities')).map((s) => s.url);
    const n = posts().length;
    assert.equal(await backlinkComment(env.db, { aggregateType: 'TEST_EXECUTION', aggregateId: execR, actor: 'tess', payload: { provider: 'openproject', externalKey: '99/../../../api/v3/foo?', relation: 'DEFECT' } }), null);
    assert.equal(await backlinkComment(env.db, { aggregateType: 'TEST_EXECUTION', aggregateId: execR, actor: 'tess', payload: { provider: 'openproject', externalKey: '99', relation: 'DEFECT' } }), null, 'fremdes Projekt');
    assert.equal(await backlinkComment(env.db, { aggregateType: 'TEST_EXECUTION', aggregateId: execA, actor: 'tess', payload: { provider: 'openproject', externalKey: '42', relation: 'DEFECT' } }), null, 'AA ohne Zuordnung');
    assert.deepEqual(posts().slice(n), []);
    assert.match((await backlinkComment(env.db, { aggregateType: 'TEST_CASE', aggregateId: tcR, actor: 'tess', payload: { provider: 'openproject', externalKey: '42', relation: 'REQUIREMENT' } }))!, /Verknüpft in \*Anemo\*/);
    assert.deepEqual(posts().slice(n), ['/api/v3/work_packages/42/activities']);
  });

  it('Sicherheit 3: GitLab- und Jira-Abgleich nur mit Projektbezug', async () => {
    assert.equal((await req('admin', 'PUT', '/api/projects/AA/integrations/gitlab', { externalProject: 'grp/app', settings: {} })).status, 204);
    for (const externalKey of ['geheim/repo!1', 'grp/app!2']) {
      assert.equal((await req('tess', 'POST', '/api/references', { ownerType: 'TEST_EXECUTION', ownerId: execA, provider: 'gitlab', externalKey, relation: 'RELATED' })).status, 201);
    }
    await refreshGitlabReferences(env.db);
    const refs = (await req('tess', 'GET', `/api/references?ownerType=TEST_EXECUTION&ownerId=${execA}`)).body;
    const title = (k: string) => refs.find((x: any) => x.externalKey === k)?.title ?? null;
    assert.equal(title('geheim/repo!1'), null);
    assert.equal(title('grp/app!2'), 'MR aus grp/app');
    assert.ok(!seen.some((s) => s.url.includes('geheim')), 'fremdes Repository nicht abgefragt');
    // Jira: neu von Hand verknüpftes Ticket eines fremden Jira-Projekts bleibt ohne Titel; Projektschlüssel und Migration gehen
    for (const externalKey of ['SECRET-1', 'AA-5']) {
      assert.equal((await req('tess', 'POST', '/api/references', { ownerType: 'TEST_EXECUTION', ownerId: execA, provider: 'jira', externalKey, relation: 'DEFECT' })).status, 201);
    }
    await env.db`insert into external_reference(owner_type, owner_id, provider, external_key, relation, created_by) values ('TEST_EXECUTION', ${execA}, 'jira', 'OLD-1', 'DEFECT', 'migration')`;
    const r = await refreshJiraReferences(env.db, jiraConfig()!);
    assert.equal(r.error, null);
    const jr = (await req('tess', 'GET', `/api/references?ownerType=TEST_EXECUTION&ownerId=${execA}`)).body;
    const jt = (k: string) => jr.find((x: any) => x.externalKey === k)?.title ?? null;
    assert.deepEqual([jt('SECRET-1'), jt('AA-5'), jt('OLD-1')], [null, 'Ticket AA-5', 'Ticket OLD-1']);
    assert.equal((await req('tess', 'POST', '/api/references', { ownerType: 'TEST_EXECUTION', ownerId: execA, provider: 'gitlab', externalKey: '../x', relation: 'RELATED' })).status, 400);
  });

  it('Sicherheit 5 / Fach 25: CI-Start nur mit ANEMO_PUBLIC_URL, erlaubten Variablen und Zweigen', async () => {
    const pipelines = () => seen.filter((s) => s.url.endsWith('/pipeline'));
    assert.equal((await req('admin', 'PUT', '/api/projects/AA/integrations/gitlab', { externalProject: 'grp/app', settings: { ciVariables: ['CI_DEBUG_TRACE'] } })).status, 400, 'Steuervariable nicht freigebbar');
    const ci = await req('desi', 'POST', `/api/cycles/${cycleA}/ci-runs`, { ref: 'main', variables: { TEST_SUITE: 'smoke' } }, 'evil.example');
    assert.equal(ci.status, 409);
    process.env.ANEMO_PUBLIC_URL = 'https://anemo.firma.test';
    try {
      assert.equal((await req('desi', 'POST', `/api/cycles/${cycleA}/ci-runs`, { variables: { CI_DEBUG_TRACE: 'true' } }, 'evil.example')).status, 400);
      assert.equal((await req('desi', 'POST', `/api/cycles/${cycleA}/ci-runs`, { ref: 'production' }, 'evil.example')).status, 400);
      assert.equal(pipelines().length, 0);
      const ok = await req('desi', 'POST', `/api/cycles/${cycleA}/ci-runs`, { variables: { TEST_SUITE: 'smoke' } }, 'evil.example');
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      const vars = Object.fromEntries(JSON.parse(pipelines()[0]!.body).variables.map((v: any) => [v.key, v.value]));
      assert.equal(vars.ANEMO_URL, 'https://anemo.firma.test');
      assert.equal(JSON.parse(pipelines()[0]!.body).ref, 'main');
    } finally {
      delete process.env.ANEMO_PUBLIC_URL;
    }
  });

  it('Sicherheit 10 / Fach 27: Verweise ändern/löschen mit der Stufe des Anlegens, Schritt gegen die Ausführung geprüft', async () => {
    const tcRef = (await req('desi', 'POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: tcA, provider: 'jira', externalKey: 'AA-100', relation: 'REQUIREMENT' })).body;
    assert.equal((await req('tess', 'PATCH', `/api/references/${tcRef.id}`, { severity: 'Hoch' })).status, 403);
    assert.equal((await req('tess', 'DELETE', `/api/references/${tcRef.id}`)).status, 403);
    assert.equal((await req('desi', 'PATCH', `/api/references/${tcRef.id}`, { stepId: 'x' })).status, 400, 'Schrittbezug nur bei Ausführungen');
    const exRef = (await req('tess', 'POST', '/api/references', { ownerType: 'TEST_EXECUTION', ownerId: execA, provider: 'jira', externalKey: 'AA-101', relation: 'DEFECT' })).body;
    assert.equal((await req('tess', 'PATCH', `/api/references/${exRef.id}`, { stepId: 'gibt-es-nicht' })).status, 400);
    const step = (await req('tess', 'GET', `/api/executions/${execA}`)).body.steps[0].id;
    assert.equal((await req('tess', 'PATCH', `/api/references/${exRef.id}`, { stepId: step, severity: 'Kosmetisch' })).status, 204);
    assert.equal((await req('tess', 'DELETE', `/api/references/${exRef.id}`)).status, 204);
    assert.equal((await req('desi', 'DELETE', `/api/references/${tcRef.id}`)).status, 204);
  });

  it('Sicherheit 2 / Fach 14: Erwähnungen und Beobachten nur an Leseberechtigte; GET /api/watch gefiltert', async () => {
    await req('vera', 'PUT', '/api/auth/notifications', { email: 'vera@extern.example', kinds: ['mentioned', 'watched'] });
    await req('tess', 'PUT', '/api/auth/notifications', { email: 'tess@extern.example', kinds: ['watched'] });
    await req('mira', 'PUT', '/api/auth/notifications', { email: 'mira@firma.example', kinds: ['mentioned'] });
    assert.equal((await req('tess', 'PUT', `/api/watch/TEST_CASE/${tcR}`)).status, 204);
    await req('admin', 'PUT', '/api/projects/RR/members', { principalType: 'user', principalId: uid.tess, role: null });
    assert.equal((await req('tess', 'GET', `/api/test-cases/${tcR}`)).status, 404);
    assert.deepEqual((await req('tess', 'GET', '/api/watch')).body, [], 'beobachtetes Objekt ohne Leserecht nicht gelistet');
    const c = await req('admin', 'POST', '/api/comments', { ownerType: 'TEST_CASE', ownerId: tcR, body: '@vera @mira bitte prüfen: Zugangsdaten Kunde liegen im Tresor 4711' });
    assert.equal(c.status, 201);
    assert.deepEqual(c.body.unreachableMentions, ['vera']);
    const mails = await collectMails(env.db, await listEvents(env.db, { afterSeq: 0, limit: 1000 }), 'https://anemo.test');
    assert.ok(!mails.has('vera@extern.example'), 'Nichtmitglied erwähnt → keine Mail');
    assert.ok(!mails.has('tess@extern.example'), 'Beobachterin nach Rechteentzug → keine Mail');
    assert.match(mails.get('mira@firma.example')!.lines[0]!.text, /erwähnt/);
  });

  it('Sicherheit 13: Webhook-Test liefert nur den Status, nicht die Antwort der Gegenstelle', async () => {
    const w = (await req('admin', 'POST', '/api/admin/webhooks', { name: 'Intern', url: `${process.env.OPENPROJECT_URL}/hook`, format: 'json', eventTypes: [], projectKey: null, active: true })).body;
    const r = await req('admin', 'POST', `/api/admin/webhooks/${w.id}/test`);
    assert.deepEqual([r.body.ok, r.body.status], [false, 500]);
    assert.ok(!JSON.stringify(r.body).includes('GEHEIMNIS'));
  });

  it('Sicherheit 12: Projektlöschen entfernt Kommentare, Beobachtungen, Abdeckungsstand und Verweise', async () => {
    await req('admin', 'POST', '/api/projects', { key: 'ZZ', name: 'Weg damit' });
    const tc = (await req('admin', 'POST', '/api/projects/ZZ/test-cases', { content: { title: 'Z1', steps: [] } })).body;
    await req('admin', 'POST', '/api/comments', { ownerType: 'TEST_CASE', ownerId: tc.id, body: 'Vertraulicher Kommentartext' });
    await req('admin', 'PUT', `/api/watch/TEST_CASE/${tc.id}`);
    await req('admin', 'POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: tc.id, provider: 'openproject', externalKey: '42', relation: 'REQUIREMENT' });
    const [p] = await env.db<{ id: string }[]>`select id from project where key = 'ZZ'`;
    await env.db`insert into coverage_push(project_id, provider, external_key, state, detail) values (${p!.id}, 'openproject', '42', 'untested', 'x')`;
    const cy = (await req('admin', 'POST', '/api/projects/ZZ/cycles', { name: 'Z' })).body;
    await req('admin', 'PUT', `/api/watch/TEST_CYCLE/${cy.id}`);
    assert.equal((await req('admin', 'DELETE', '/api/projects/ZZ', { confirmKey: 'ZZ' })).status, 200);
    const count = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
    assert.equal(await count(env.db`select count(*)::int as n from comment where owner_id = ${tc.id}`), 0);
    assert.equal(await count(env.db`select count(*)::int as n from watch where object_id in (${tc.id}, ${cy.id})`), 0);
    assert.equal(await count(env.db`select count(*)::int as n from coverage_push where project_id = ${p!.id}`), 0);
    assert.equal(await count(env.db`select count(*)::int as n from external_reference where owner_id = ${tc.id}`), 0);
    assert.equal(await count(env.db`select count(*)::int as n from domain_event where payload::text like '%Vertraulicher Kommentartext%'`), 0, 'Auszug auch aus dem Ereignisprotokoll');
  });

  it('Sicherheit 13: neue Ziel-Adresse nur mit neu eingegebenem Geheimnis', async () => {
    const r = await req('admin', 'PUT', '/api/admin/settings', { changes: { OPENPROJECT_URL: 'https://angreifer.example' } });
    assert.equal(r.status, 400);
    assert.match(r.body.detail, /API-Schlüssel/);
    assert.equal((await req('admin', 'PUT', '/api/admin/settings', { changes: { OPENPROJECT_URL: `${process.env.OPENPROJECT_URL}/` } })).status, 200, 'gleiche Adresse');
    assert.equal((await req('admin', 'PUT', '/api/admin/settings', { changes: { GITLAB_URL: 'https://neu.example', GITLAB_TOKEN: 'neu' } })).status, 200);
    assert.equal((await req('admin', 'PUT', '/api/admin/settings', { changes: { SMTP_HOST: '' } })).status, 200, 'Abschalten ohne Geheimnis');
    assert.equal((await req('admin', 'PUT', '/api/admin/settings', { changes: { OPENPROJECT_URL: null, GITLAB_URL: null, GITLAB_TOKEN: null, SMTP_HOST: null } })).status, 200, 'Zurücksetzen auf die Umgebung');
  });
});

describe('Review Teil 3 / Sicherheit Teil 2 – Fachlogik', () => {
  let env: TestEnv;
  const pid: Record<string, string> = {};
  before(async () => {
    env = await testEnv();
    for (const k of ['CA', 'CB', 'SD', 'WA']) {
      await env.call('POST', '/api/projects', { key: k, name: k });
      await env.call('PUT', `/api/projects/${k}/external-services`, { externalServices: 'allowed' });
      pid[k] = (await env.db<{ id: string }[]>`select id from project where key = ${k}`)[0]!.id;
    }
    for (let i = 1; i <= 6; i++) await env.call('POST', '/api/projects/CA/test-cases', { content: { title: `Anforderungstest ${i}`, steps: [{ action: 'tun', expected: 'ok' }] } });
    await env.call('POST', '/api/projects/CB/test-cases', { content: { title: 'B1', steps: [{ action: 'tun', expected: 'ok' }] } });
  });
  after(async () => { await env?.close(); });
  const link = async (tcKey: string, externalKey: string) => {
    const tc = (await env.call('GET', `/api/test-cases/${tcKey}`)).body;
    assert.equal((await env.call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: tc.id, provider: 'openproject', externalKey, relation: 'REQUIREMENT' })).status, 201);
  };
  const covComments = (key: string) => comments.filter((c) => c.id === key && /Testabdeckung/.test(c.raw));

  it('Fach 1/20, Sicherheit 4: Abdeckung im Ticket je Projekt, nur bei Zustandswechsel, höchstens 1×/Tag, 404 blockiert nicht', async () => {
    for (const k of ['CA', 'CB']) assert.equal((await env.call('PUT', `/api/projects/${k}/integrations/openproject`, { externalProject: 'qa', settings: { coverageComments: true } })).status, 204);
    await link('CA-T1', '42'); await link('CB-T1', '42'); await link('CA-T2', '43'); await link('CA-T3', '41'); await link('CA-T4', '99');
    comments.length = 0;
    let r = await refreshOpenProjectReferences(env.db);
    assert.equal(covComments('42').length, 1, 'zwei Projekte, eine Anforderung: ein Kommentar am Tag');
    assert.equal(covComments('43').length, 1, '404 bei Arbeitspaket 41 bricht die übrigen nicht ab');
    assert.equal(covComments('99').length, 0, 'Arbeitspaket eines fremden OpenProject-Projekts');
    assert.match(r!.error ?? '', /CA: 1 Abdeckungskommentar/);
    r = await refreshOpenProjectReferences(env.db);
    assert.equal(comments.length, 2, 'unverändert → kein neuer Kommentar (auch kein Hin und Her zwischen CA und CB)');
    // nur das Detail ändert sich (weiterer Testfall, Zustand bleibt) → kein Kommentar, Stand still nachgeführt
    await link('CA-T5', '43');
    await refreshOpenProjectReferences(env.db);
    assert.equal(covComments('43').length, 1);
    const [st] = await env.db<{ detail: string }[]>`select detail from coverage_push where project_id = ${pid.CA!} and external_key = '43'`;
    assert.match(st!.detail, /CA-T5/);
    // Zustand wechselt am selben Tag → erst am nächsten Tag ein Kommentar
    const cy = (await env.call('POST', '/api/projects/CA/cycles', { name: 'Lauf 1' })).body;
    await env.call('POST', `/api/cycles/${cy.id}/executions`, { testCaseIds: ['CA-T1'] });
    const ex = (await env.call('GET', `/api/cycles/${cy.id}/executions`)).body.items[0].id;
    assert.equal((await env.call('POST', `/api/executions/${ex}/result`, { status: 'PASS' })).status, 200);
    await refreshOpenProjectReferences(env.db);
    assert.equal(covComments('42').length, 1, 'heute schon kommentiert');
    await env.db`update coverage_push set pushed_at = now() - interval '2 days'`;
    await refreshOpenProjectReferences(env.db);
    assert.equal(covComments('42').length, 2);
    assert.match(covComments('42')[1]!.raw, /bestanden/);
    assert.match(covComments('42')[1]!.raw, /Anemo, CA/);
    // CB kommt am Folgetag an die Reihe (CA unverändert → kein erneuter Kommentar von CA)
    assert.equal((await env.db`select 1 from coverage_push where project_id = ${pid.CB!} and external_key = '42'`).length, 0);
    await env.db`update coverage_push set pushed_at = now() - interval '2 days'`;
    await refreshOpenProjectReferences(env.db);
    assert.equal(covComments('42').length, 3);
    assert.match(covComments('42')[2]!.raw, /Anemo, CB/);
    const rows = await env.db<{ projectId: string; state: string }[]>`select project_id, state from coverage_push where external_key = '42'`;
    assert.deepEqual(rows.map((r) => [r.projectId, r.state]).sort(), [[pid.CA, 'passed'], [pid.CB, 'untested']].sort(), 'Stand je Projekt');
    await refreshOpenProjectReferences(env.db);
    assert.equal(covComments('42').length, 3, 'kein Hin und Her zwischen den Projekten');
  });

  it('Fach 20: Abdeckungsregel wie im Cockpit (aktuelle Version, ungeprüfte Agentenergebnisse, Konfigurationen, archivierte Zyklen)', async () => {
    const state = async (key: string) => (await requirementCoverage(env.db, pid.CA!)).find((c) => c.key === key)!;
    assert.equal((await state('42')).state, 'passed');
    await env.db`update test_execution set review_state = 'pending' where test_case_id = (select id from test_case where key = 'CA-T1')`;
    assert.equal((await state('42')).state, 'untested', 'ungeprüftes Agentenergebnis zählt nicht als bestanden');
    await env.db`update test_execution set review_state = null where test_case_id = (select id from test_case where key = 'CA-T1')`;
    const tc = (await env.call('GET', '/api/test-cases/CA-T1')).body;
    const rev = await env.call('PUT', '/api/test-cases/CA-T1/content', { content: { ...tc.version, steps: [{ ...tc.version.steps[0], expected: 'anders' }] }, changeNote: 'geändert' });
    assert.equal(rev.status, 200, JSON.stringify(rev.body));
    const outdated = await state('42');
    assert.equal(outdated.state, 'untested', 'Ergebnis auf älterer Version = nicht getestet');
    assert.match(outdated.detail, /ältere Version/);
    // Konfigurationen: Fehlschlag unter Oracle bleibt sichtbar, auch wenn SQL Server später besteht
    await link('CA-T6', '44');
    const ora = (await env.call('POST', '/api/projects/CA/cycles', { name: 'Oracle' })).body;
    const sql = (await env.call('POST', '/api/projects/CA/cycles', { name: 'SQL Server' })).body;
    await env.db`update test_cycle set configuration = ${env.db.json({ db: ['Oracle'] })}, configuration_source = 'manual' where id = ${ora.id}`;
    await env.db`update test_cycle set configuration = ${env.db.json({ db: ['SQL Server'] })}, configuration_source = 'manual' where id = ${sql.id}`;
    for (const [c, status] of [[ora, 'FAIL'], [sql, 'PASS']] as const) {
      await env.call('POST', `/api/cycles/${c.id}/executions`, { testCaseIds: ['CA-T6'] });
      const e = (await env.call('GET', `/api/cycles/${c.id}/executions`)).body.items[0].id;
      const steps = (await env.call('GET', `/api/executions/${e}`)).body.steps.map((x: any) => ({ stepId: x.id, status, comment: 'Befund: Absturz' }));
      const res = await env.call('POST', `/api/executions/${e}/result`, { status, comment: 'x', stepResults: steps });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    assert.equal((await state('44')).state, 'failing');
    await env.db`update test_cycle set archived_at = now() where id = ${ora.id}`;
    assert.equal((await state('44')).state, 'passed', 'archivierte Zyklen zählen nicht');
  });

  it('Fach 16: Sitzungsfund → Fehler legt bei parallelen Anfragen nur ein Ticket an; Fehler gibt die Markierung frei', async () => {
    assert.equal((await env.call('PUT', '/api/projects/SD/integrations/openproject', { externalProject: 'qa' })).status, 204);
    const cy = (await env.call('POST', '/api/projects/SD/cycles', { name: 'Erkunden' })).body;
    const s = (await env.call('POST', `/api/cycles/${cy.id}/sessions`, { charter: 'Druck erkunden', timeboxMinutes: 30 })).body;
    const f1 = (await env.call('POST', `/api/sessions/${s.id}/findings`, { kind: 'bug', text: 'Vorschau leer' })).body.findings[0].id;
    const before = created.length;
    const [a, b] = await Promise.all([1, 2].map(() => env.call('POST', `/api/sessions/${s.id}/findings/${f1}/defect`, { severity: 'Mittel' })));
    assert.deepEqual([a!.status, b!.status].sort(), [201, 409]);
    assert.equal(created.length - before, 1, 'genau ein Ticket');
    const after1 = (await env.call('GET', `/api/sessions/${s.id}`)).body.findings[0];
    assert.equal(after1.defectKey, String((a!.status === 201 ? a : b)!.body.externalKey));
    assert.ok(!after1.defectPending);
    const f2 = (await env.call('POST', `/api/sessions/${s.id}/findings`, { kind: 'bug', text: 'FEHLER500 beim Drucken' })).body.findings[1].id;
    assert.equal((await env.call('POST', `/api/sessions/${s.id}/findings/${f2}/defect`, {})).status, 502, 'Fehler der Gegenstelle als 502');
    assert.ok(!(await env.call('GET', `/api/sessions/${s.id}`)).body.findings[1].defectPending, 'Markierung zurückgenommen');
    assert.equal((await env.call('POST', `/api/sessions/${s.id}/findings/${f2}/defect`, { title: 'Drucken scheitert' })).status, 201, 'erneuter Versuch möglich');
  });

  it('Fach 14: Beobachtungen gelöschter Objekte werden entfernt; Plan-Beobachter erfahren vom gelöschten Zyklus', async () => {
    // Löschen eines Testfalls hinterlässt keine Beobachtungen
    const tc = (await env.call('POST', '/api/projects/WA/test-cases', { content: { title: 'Wird gelöscht', steps: [] } })).body;
    assert.equal((await env.call('PUT', `/api/watch/TEST_CASE/${tc.id}`, undefined, 'lea')).status, 204);
    assert.equal((await env.call('DELETE', `/api/test-cases/${tc.id}`)).status, 200);
    const [ev] = (await listEvents(env.db, { aggregateId: tc.id, limit: 50 })).filter((e) => e.type === 'TestCaseDeleted');
    await watchNotes(env.db, ev!, null);
    assert.equal((await env.db`select 1 from watch where object_id = ${tc.id}`).length, 0, 'keine verwaiste Beobachtung');
    // Versand räumt verwaiste Zeilen auf; Beobachter aus der Nutzlast (falls beim Löschen schon entfernt) werden benachrichtigt
    const gone = randomUUID();
    await env.db`insert into watch(username, object_type, object_id) values ('lea', 'TEST_CASE', ${gone})`;
    const deleted = { seq: 0, id: randomUUID(), type: 'TestCaseDeleted', aggregateType: 'TestCase', aggregateId: gone, actor: 'tester', occurredAt: new Date(),
      payload: { key: 'WA-T99', projectId: pid.WA, watchers: ['max'] } };
    const notes = await watchNotes(env.db, deleted, null);
    assert.deepEqual(notes.map((n) => [[...n.usernames].sort(), n.projectId]), [[['lea', 'max'], pid.WA]]);
    assert.match(notes[0]!.text, /WA-T99 gelöscht/);
    assert.equal((await env.db`select 1 from watch where object_id = ${gone}`).length, 0, 'verwaiste Beobachtung beim Versand entfernt');
    const plan = (await env.call('POST', '/api/projects/WA/plans', { name: 'Release' })).body;
    assert.equal((await env.call('PUT', `/api/watch/TEST_PLAN/${plan.id}`, undefined, 'lea')).status, 204);
    const cycleDeleted = { seq: 0, id: randomUUID(), type: 'TestCycleDeleted', aggregateType: 'TestCycle', aggregateId: randomUUID(), actor: 'tester', occurredAt: new Date(),
      payload: { name: 'Weg', projectId: pid.WA, planId: plan.id, watchers: ['max'] } };
    const n2 = await watchNotes(env.db, cycleDeleted, null);
    assert.deepEqual(n2.map((n) => n.usernames), [['max'], ['lea']]);
    assert.match(n2[1]!.text, /Zyklus „Weg“ gelöscht/);
  });

  it('Sicherheit 11: Wiki→Markdown nur mit sicheren Links, ohne HTML und ohne eingebettete Bilder', () => {
    assert.equal(wikiToMarkdown('[Klick|javascript:alert(1)]'), 'Klick');
    assert.equal(wikiToMarkdown('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(wikiToMarkdown('!https://tracker.example/p.png!'), '[Bild: p.png](https://tracker.example/p.png)');
    assert.equal(wikiToMarkdown('![x](https://tracker.example/p.png)'), '[x](https://tracker.example/p.png)');
    assert.ok(!/\]\(javascript/i.test(wikiToMarkdown('[a](javascript:alert(1))')));
    assert.equal(wikiToMarkdown('[Anemo|https://x.test] [mail|mailto:qa@firma.de]'), '[Anemo](https://x.test) [mail](mailto:qa@firma.de)');
    assert.equal(wikiToMarkdown('{{a<b}} und <b>'), '`a<b` und &lt;b&gt;');
  });

  it('UX 16: eigene Schweregrade; Datenmigration bildet alte Werte und Jira-Zuordnungen ab', async () => {
    assert.deepEqual([...SEVERITIES], ['Gravierend', 'Hoch', 'Mittel', 'Gering', 'Kosmetisch']);
    const old = ['Blocker', 'Kritisch', 'Schwer', 'Mittel', 'Gering'];
    for (const [i, s] of old.entries()) {
      await env.db`insert into external_reference(owner_type, owner_id, provider, external_key, relation, severity) values ('TEST_EXECUTION', ${randomUUID()}, 'jira', ${`SEV-${i}`}, 'DEFECT', ${s})`;
    }
    await env.db`insert into project_integration(project_id, provider, external_project, settings) values (${pid.WA!}, 'jira', 'WAJ', ${env.db.json({ issueType: 'Bug', priorities: { Blocker: 'Highest', Kritisch: 'High', Schwer: 'Medium', Mittel: 'Low', Gering: 'Lowest' } })})`;
    const sql = await readFile(new URL('../migrations/029_review_fixes.sql', import.meta.url), 'utf8');
    await env.db.unsafe(sql.slice(sql.indexOf('-- Schweregrad'), sql.indexOf('-- Projekt des Besitzers')));
    const rows = await env.db<{ externalKey: string; severity: string }[]>`select external_key, severity from external_reference where external_key like 'SEV-%' order by external_key`;
    assert.deepEqual(rows.map((r) => r.severity), ['Gravierend', 'Hoch', 'Mittel', 'Gering', 'Kosmetisch']);
    const [pi] = await env.db<{ settings: { issueType: string; priorities: Record<string, string> } }[]>`select settings from project_integration where project_id = ${pid.WA!} and provider = 'jira'`;
    assert.deepEqual(pi!.settings, { issueType: 'Bug', priorities: { Gravierend: 'Highest', Hoch: 'High', Mittel: 'Medium', Gering: 'Low', Kosmetisch: 'Lowest' } });
  });
});
