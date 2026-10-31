import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

/** Regressionstests aus dem Sicherheitsreview (IDOR, Agentenkanal, Größenlimits, Links). */
describe('Sicherheit: Projektgrenzen und Eingaben', () => {
  let env: TestEnv;
  const PW = 'Sicheres-Passwort-1';
  const cookies = new Map<string, string>();
  async function req(user: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await env.app.request(path, {
      method,
      headers: { 'content-type': 'application/json', host: 'anemo.test', ...(user && cookies.has(user) ? { cookie: cookies.get(user)! } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }
  async function loginAs(user: string) {
    const res = await env.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', host: 'anemo.test' }, body: JSON.stringify({ username: user, password: PW }) });
    assert.equal(res.status, 200, user);
    cookies.set(user, res.headers.getSetCookie().find((c) => c.startsWith('anemo_session='))!.split(';')[0]!);
  }
  let geheimPlan = '';
  let geheimFolder = '';
  let offenCycle = '';

  before(async () => {
    env = await testEnv({ authMode: 'on' });
    process.env.ANEMO_ADMIN_PASSWORD = PW;
    const { bootstrapAdmin } = await import('../src/modules/auth/index.ts');
    await bootstrapAdmin(env.db, '/dev/null', () => {});
    delete process.env.ANEMO_ADMIN_PASSWORD;
    await loginAs('admin');
    const ids: Record<string, string> = {};
    for (const [u, agent] of [['dana', false], ['robo', true]] as const) {
      ids[u] = (await req('admin', 'POST', '/api/admin/users', { username: u, displayName: u, password: PW, isAgent: agent })).body.id;
      await loginAs(u);
    }
    for (const key of ['OFFEN', 'GEHEIM']) await req('admin', 'POST', '/api/projects', { key, name: key });
    await req('admin', 'PUT', '/api/projects/GEHEIM/visibility', { visibility: 'restricted' });
    await req('admin', 'PUT', '/api/projects/OFFEN/members', { principalType: 'user', principalId: ids.dana, role: 'DESIGNER' });
    await req('admin', 'PUT', '/api/projects/OFFEN/members', { principalType: 'user', principalId: ids.robo, role: 'TESTER' });
    await req('admin', 'POST', '/api/projects/GEHEIM/test-cases', { content: { title: 'Geheim', steps: [{ action: 'x', expected: 'y' }] } });
    geheimPlan = (await req('admin', 'POST', '/api/projects/GEHEIM/plans', { name: 'Geheimplan' })).body.id;
    geheimFolder = (await req('admin', 'POST', '/api/projects/GEHEIM/folders', { name: 'Geheimordner' })).body.id;
    offenCycle = (await req('dana', 'POST', '/api/projects/OFFEN/cycles', { name: 'Lauf' })).body.id;
  });
  after(() => env.close());

  it('Testfälle aus fremden Projekten lassen sich nicht in einen Zyklus einplanen', async () => {
    const r = await req('dana', 'POST', `/api/cycles/${offenCycle}/executions`, { testCaseIds: ['GEHEIM-T1'] });
    assert.equal(r.status, 404);
    assert.equal((await req('dana', 'GET', `/api/cycles/${offenCycle}/executions`)).body.total, 0);
  });

  it('Zyklen lassen sich nicht an Testpläne fremder Projekte hängen', async () => {
    assert.equal((await req('dana', 'POST', '/api/projects/OFFEN/cycles', { name: 'x', planId: geheimPlan })).status, 404);
    assert.equal((await req('dana', 'PUT', `/api/cycles/${offenCycle}`, { name: 'Lauf', planId: geheimPlan })).status, 404);
  });

  it('Testfälle und Ordner lassen sich nicht in Ordner fremder Projekte legen', async () => {
    assert.equal((await req('dana', 'POST', '/api/projects/OFFEN/test-cases', { content: { title: 't' }, folderId: geheimFolder })).status, 404);
    assert.equal((await req('dana', 'POST', '/api/projects/OFFEN/folders', { name: 'u', parentId: geheimFolder })).status, 404);
  });

  it('Agentenkonten sehen gesperrte Projekte auch ohne MCP-Header nicht', async () => {
    await req('admin', 'PUT', '/api/projects/OFFEN/external-services', { externalServices: 'blocked' });
    assert.equal((await req('robo', 'GET', '/api/projects/OFFEN/test-cases')).status, 404);
    assert.ok(!(await req('robo', 'GET', '/api/projects')).body.some((p: any) => p.key === 'OFFEN'));
    await req('admin', 'PUT', '/api/projects/OFFEN/external-services', { externalServices: 'allowed' });
    assert.equal((await req('robo', 'GET', '/api/projects/OFFEN/test-cases')).status, 200);
  });

  it('Zuordnung zu GitLab/OpenProject nur durch Systemadministration', async () => {
    await req('admin', 'PUT', '/api/projects/OFFEN/members', { principalType: 'user', principalId: (await req('admin', 'GET', '/api/admin/users')).body.find((u: any) => u.username === 'dana').id, role: 'PROJECT_ADMIN' });
    assert.equal((await req('dana', 'PUT', '/api/projects/OFFEN/integrations/gitlab', { externalProject: 'infra/secret' })).status, 403);
  });

  it('nur http(s)-Links an Verweisen', async () => {
    const r = await req('dana', 'POST', '/api/references', { ownerType: 'TEST_CYCLE', ownerId: offenCycle, provider: 'jira', externalKey: 'X-1', relation: 'REQUIREMENT', url: 'javascript:alert(1)' });
    assert.equal(r.status, 400);
  });

  it('übergroße Anfragen werden vor dem Lesen abgelehnt (413), auch ohne Anmeldung', async () => {
    const big = JSON.stringify({ username: 'x', password: 'y'.repeat(5 * 1024 * 1024) });
    assert.equal((await req(null, 'POST', '/api/auth/login', big)).status, 413);
  });

  it('Fehlervorlagen eines eingeschränkten Projekts sind für Nichtmitglieder nicht lesbar', async () => {
    assert.equal((await req('dana', 'GET', '/api/defect-templates?project=GEHEIM')).status, 404);
  });
  it('Teil 2 Befund 7: ohne Anmeldung 401 vor dem Lesen des Bodys, kleines Limit; Zugriff vor Schemaprüfung', async () => {
    // kein Schema in der Antwort für Unbekannte
    const r = await req(null, 'POST', '/api/projects/NOPE/test-cases/import', {});
    assert.equal(r.status, 401);
    assert.equal(r.body.issues, undefined);
    // ohne Anmeldung höchstens 64 KB, auch auf Routen mit großem Limit
    const big = JSON.stringify({ ownerType: 'TEST_CASE', ownerId: '00000000-0000-0000-0000-000000000000', fileName: 'a', contentBase64: 'A'.repeat(200_000) });
    assert.equal((await req(null, 'POST', '/api/attachments/base64', big)).status, 413);
    // Anmeldung selbst funktioniert weiter (kleiner Body)
    assert.equal((await req(null, 'POST', '/api/auth/login', { username: 'x', password: 'falsch' })).status, 401);
    // angemeldet, aber ohne Zugriff aufs Projekt: 404 statt Schemafehler
    assert.equal((await req('dana', 'POST', '/api/projects/GEHEIM/test-cases/import', {})).status, 404);
    // angemeldet mit Zugriff: Schema wird geprüft
    assert.equal((await req('dana', 'POST', '/api/projects/OFFEN/test-cases/import', {})).status, 400);
    // Zugriffsregel, die den Body braucht (Verweis anlegen): weiterhin geprüft
    assert.equal((await req('dana', 'POST', '/api/references', { ownerType: 'TEST_PLAN', ownerId: geheimPlan, provider: 'jira', externalKey: 'X-1', relation: 'REQUIREMENT' })).status, 404);
  });
});
