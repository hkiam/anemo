import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashPassword, passwordProblem, verifyPassword } from '../src/modules/auth/password.ts';
import { type TestEnv, testEnv } from './helpers.ts';

const PW = 'Sicheres-Passwort-1';

describe('Passwörter', () => {
  it('hasht mit Salz und prüft zeitkonstant', async () => {
    const a = await hashPassword(PW);
    const b = await hashPassword(PW);
    assert.notEqual(a, b, 'Salz unterscheidet die Hashes');
    assert.ok(await verifyPassword(PW, a));
    assert.ok(!(await verifyPassword('falsch-falsch-1', a)));
    assert.ok(!(await verifyPassword(PW, null)));
  });
  it('verlangt Mindestlänge und gemischte Zeichen', () => {
    assert.ok(passwordProblem('kurz1'));
    assert.ok(passwordProblem('nurbuchstabenlang'));
    assert.equal(passwordProblem(PW), null);
  });
});

describe('Anmeldung, Rollen und Projektsichtbarkeit (Modus on)', () => {
  let env: TestEnv;
  const cookies = new Map<string, string>();

  async function req(user: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await env.app.request(path, {
      method,
      headers: {
        'content-type': 'application/json', host: 'anemo.test',
        ...(user && cookies.has(user) ? { cookie: cookies.get(user)! } : {}), ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') };
  }
  async function loginAs(user: string, password = PW) {
    const r = await req(null, 'POST', '/api/auth/login', { username: user, password });
    assert.equal(r.status, 200, `Login ${user}: ${JSON.stringify(r.body)}`);
    cookies.set(user, r.setCookie!.split(';')[0]!);
  }
  const ids: Record<string, string> = {};

  before(async () => {
    env = await testEnv({ authMode: 'on' });
    process.env.ANEMO_ADMIN_PASSWORD = PW;
    const { bootstrapAdmin } = await import('../src/modules/auth/index.ts');
    await bootstrapAdmin(env.db, '/dev/null', () => {});
    delete process.env.ANEMO_ADMIN_PASSWORD;
    await loginAs('admin');
    for (const u of ['vera', 'tom', 'dana', 'gast']) {
      const r = await req('admin', 'POST', '/api/admin/users', { username: u, displayName: u.toUpperCase(), password: PW });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      ids[u] = r.body.id;
      await loginAs(u);
    }
    for (const key of ['OFFEN', 'GEHEIM']) await req('admin', 'POST', '/api/projects', { key, name: key });
    await req('admin', 'PUT', '/api/projects/GEHEIM/visibility', { visibility: 'restricted' });
    const g = await req('admin', 'POST', '/api/admin/groups', { name: 'Testteam' });
    ids.team = g.body.id;
    await req('admin', 'PUT', `/api/admin/groups/${g.body.id}`, { memberIds: [ids.tom] });
    await req('admin', 'PUT', '/api/projects/GEHEIM/members', { principalType: 'user', principalId: ids.vera, role: 'VIEWER' });
    await req('admin', 'PUT', '/api/projects/GEHEIM/members', { principalType: 'group', principalId: ids.team, role: 'TESTER' });
    await req('admin', 'PUT', '/api/projects/GEHEIM/members', { principalType: 'user', principalId: ids.dana, role: 'DESIGNER' });
    await req('admin', 'PUT', '/api/projects/OFFEN/members', { principalType: 'user', principalId: ids.dana, role: 'PROJECT_ADMIN' });
  });
  after(() => env.close());

  it('ohne Anmeldung 401, mit falschem Passwort 401 ohne Hinweis auf den Benutzer', async () => {
    assert.equal((await req(null, 'GET', '/api/projects')).status, 401);
    const a = await req(null, 'POST', '/api/auth/login', { username: 'vera', password: 'falsch-falsch-1' });
    const b = await req(null, 'POST', '/api/auth/login', { username: 'niemand', password: 'falsch-falsch-1' });
    assert.equal(a.status, 401);
    assert.equal(a.body.detail, b.body.detail);
  });

  it('sperrt nach wiederholten Fehlversuchen vorübergehend', async () => {
    for (let i = 0; i < 5; i++) await req(null, 'POST', '/api/auth/login', { username: 'gast', password: 'falsch-falsch-1' });
    assert.equal((await req(null, 'POST', '/api/auth/login', { username: 'gast', password: PW })).status, 429);
  });

  it('gesperrtes Projekt ist für Nichtmitglieder unsichtbar (Liste, Direktzugriff, Suche)', async () => {
    const list = await req('gast', 'GET', '/api/projects');
    assert.deepEqual(list.body.map((p: any) => p.key), ['OFFEN']);
    assert.equal((await req('gast', 'GET', '/api/projects/GEHEIM')).status, 404);
    assert.equal((await req('gast', 'GET', '/api/projects/GEHEIM/test-cases')).status, 404);
    const listVera = await req('vera', 'GET', '/api/projects');
    assert.deepEqual(listVera.body.map((p: any) => p.key), ['GEHEIM', 'OFFEN']);
  });

  it('Rollen begrenzen Pflegen und Ausführen', async () => {
    const content = { title: 'Geheimer Test', steps: [{ action: 'a', data: '', expected: 'b' }] };
    assert.equal((await req('vera', 'POST', '/api/projects/GEHEIM/test-cases', { content })).status, 403, 'VIEWER darf nicht pflegen');
    assert.equal((await req('tom', 'POST', '/api/projects/GEHEIM/test-cases', { content })).status, 403, 'TESTER (über Gruppe) darf nicht pflegen');
    const tc = await req('dana', 'POST', '/api/projects/GEHEIM/test-cases', { content });
    assert.equal(tc.status, 201, 'DESIGNER darf pflegen');
    assert.equal(tc.body.createdBy, 'dana', 'Akteur stammt aus der Sitzung');
    const cycle = await req('dana', 'POST', '/api/projects/GEHEIM/cycles', { name: 'Lauf 1' });
    assert.equal(cycle.status, 201, JSON.stringify(cycle.body));
    const ex = await req('dana', 'POST', `/api/cycles/${cycle.body.id}/executions`, { testCaseIds: [tc.body.id] });
    assert.ok(ex.status < 300, JSON.stringify(ex.body));
    const execs = await req('tom', 'GET', `/api/cycles/${cycle.body.id}/executions`);
    const exId = (execs.body.items ?? execs.body)[0].id;
    assert.equal((await req('vera', 'POST', `/api/executions/${exId}/result`, { status: 'PASS' })).status, 403);
    const r = await req('tom', 'POST', `/api/executions/${exId}/result`, { status: 'PASS' });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    assert.equal((await req('gast', 'GET', `/api/executions/${exId}`)).status, 404, 'Nichtmitglied erfährt nichts');
  });

  it('Anhänge: Hochladen je nach Rolle, Abruf nur mit Sichtrecht', async () => {
    const tc = (await req('dana', 'GET', '/api/projects/GEHEIM/test-cases')).body.items[0];
    const cycle = (await req('dana', 'GET', '/api/projects/GEHEIM/cycles')).body.items[0];
    const exId = (await req('dana', 'GET', `/api/cycles/${cycle.id}/executions`)).body.items[0].id;
    const upload = async (user: string, ownerType: string, ownerId: string, name = 'bild.png', type = 'image/png') => {
      const form = new FormData();
      form.set('ownerType', ownerType);
      form.set('ownerId', ownerId);
      form.set('file', new File([new Uint8Array([137, 80, 78, 71])], name, { type }));
      const res = await env.app.request('/api/attachments', { method: 'POST', body: form, headers: { cookie: cookies.get(user)!, host: 'anemo.test' } });
      return { status: res.status, body: await res.json() };
    };
    assert.equal((await upload('tom', 'TEST_CASE', tc.id)).status, 403, 'TESTER darf Testfälle nicht ändern');
    const ev = await upload('tom', 'TEST_EXECUTION', exId, 'screenshot.png');
    assert.equal(ev.status, 201, 'TESTER darf Evidenzen anhängen');
    assert.equal((await upload('dana', 'TEST_CASE', tc.id)).status, 201);
    assert.equal((await upload('dana', 'TEST_CASE', '01900000-0000-7000-8000-000000000000')).status, 404, 'unbekannter Besitzer');
    assert.equal((await upload('dana', 'ANDERES', tc.id)).status, 400);
    const get = (user: string) => env.app.request(`/api/attachments/${ev.body.id}/content`, { headers: { cookie: cookies.get(user)!, host: 'anemo.test' } });
    const ok = await get('tom');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal((await get('gast')).status, 404, 'Nichtmitglied');
    const svg = await upload('dana', 'TEST_CASE', tc.id, 'x.svg', 'image/svg+xml');
    const s = await env.app.request(`/api/attachments/${svg.body.id}/content`, { headers: { cookie: cookies.get('dana')!, host: 'anemo.test' } });
    assert.equal(s.headers.get('content-type'), 'application/octet-stream', 'SVG nie inline (XSS)');
  });

  it('Projektadmin verwaltet Mitglieder nur im eigenen Projekt; Systemadmin-Bereich bleibt gesperrt', async () => {
    assert.equal((await req('dana', 'PUT', '/api/projects/OFFEN/members', { principalType: 'user', principalId: ids.gast, role: 'TESTER' })).status, 204);
    assert.equal((await req('dana', 'PUT', '/api/projects/GEHEIM/members', { principalType: 'user', principalId: ids.gast, role: 'TESTER' })).status, 403);
    assert.equal((await req('dana', 'GET', '/api/admin/users')).status, 403);
    assert.equal((await req('dana', 'GET', '/api/migration/runs')).status, 403);
    assert.equal((await req('dana', 'GET', '/api/events')).status, 403);
  });

  it('eingeschränktes Projekt: Zugriffsprotokoll und Sperre externer Dienste', async () => {
    const tc = (await req('dana', 'GET', '/api/projects/GEHEIM/test-cases')).body.items[0];
    await req('vera', 'GET', `/api/test-cases/${tc.key}`);
    await req('vera', 'GET', `/api/test-cases/${tc.key}`);
    await req('gast', 'GET', `/api/test-cases/${tc.key}`);
    await req('vera', 'GET', '/api/projects/OFFEN');
    assert.equal((await req('dana', 'GET', '/api/projects/GEHEIM/access-log')).status, 403, 'nur Projektadmin');
    const log = (await req('admin', 'GET', '/api/projects/GEHEIM/access-log?limit=1000')).body;
    const veraReads = log.items.filter((l: any) => l.username === 'vera' && l.objectKind === 'testCase');
    assert.equal(veraReads.length, 1, 'Wiederholung innerhalb von 5 Minuten wird zusammengefasst');
    assert.equal(veraReads[0].objectKey, tc.key);
    assert.ok(log.items.some((l: any) => l.username === 'gast' && l.action === 'denied:read'), 'abgelehnter Versuch protokolliert');
    assert.equal((await req('admin', 'GET', '/api/projects/OFFEN/access-log')).body.total, 0, 'interne Projekte werden nicht protokolliert');
    assert.equal((await req('admin', 'GET', '/api/projects/GEHEIM')).body.externalServices, 'blocked');
    assert.equal((await req('admin', 'GET', '/api/projects/OFFEN')).body.externalServices, 'allowed');
  });

  it('/api/auth/me liefert effektive Rollen', async () => {
    const me = await req('tom', 'GET', '/api/auth/me');
    assert.equal(me.body.username, 'tom');
    assert.deepEqual(me.body.projectRoles, { GEHEIM: 'TESTER', OFFEN: 'VIEWER' });
  });

  it('lehnt ändernde Anfragen von fremdem Ursprung ab', async () => {
    const r = await req('admin', 'POST', '/api/projects', { key: 'X', name: 'X' }, { origin: 'https://boese.example' });
    assert.equal(r.status, 403);
  });

  it('Deaktivieren und Passwortwechsel beenden Sitzungen; letzter Admin bleibt', async () => {
    assert.equal((await req('admin', 'PATCH', `/api/admin/users/${ids.vera}`, { active: false })).status, 200);
    assert.equal((await req('vera', 'GET', '/api/projects')).status, 401);
    const [admin] = await env.db<{ id: string }[]>`select id from app_user where username = 'admin'`;
    assert.equal((await req('admin', 'PATCH', `/api/admin/users/${admin!.id}`, { isSystemAdmin: false })).status, 400);
    // eigener Wechsel: die laufende Sitzung bleibt, alle anderen enden
    const other = await req(null, 'POST', '/api/auth/login', { username: 'tom', password: PW });
    const otherCookie = other.setCookie!.split(';')[0]!;
    assert.equal((await req('tom', 'POST', '/api/auth/password', { currentPassword: PW, newPassword: 'Neues-Passwort-22' })).status, 204);
    assert.equal((await req('tom', 'GET', '/api/projects')).status, 200);
    const res = await env.app.request('/api/projects', { headers: { host: 'anemo.test', cookie: otherCookie } });
    assert.equal(res.status, 401, 'andere Sitzung beendet');
    await loginAs('tom', 'Neues-Passwort-22');
  });

  it('API-Token: handelt mit den Rechten des Benutzers, Widerruf wirkt sofort', async () => {
    const t = await req('dana', 'POST', '/api/auth/tokens', { name: 'CI-Pipeline', expiresDays: 30 });
    assert.equal(t.status, 201);
    assert.match(t.body.token, /^anemo_/);
    const bearer = { authorization: `Bearer ${t.body.token}` };
    assert.equal((await req(null, 'GET', '/api/projects/GEHEIM/test-cases', undefined, bearer)).status, 200);
    assert.equal((await req(null, 'GET', '/api/admin/users', undefined, bearer)).status, 403, 'keine Adminrechte über Token');
    const list = (await req('dana', 'GET', '/api/auth/tokens')).body;
    assert.equal(list[0].name, 'CI-Pipeline');
    assert.equal(list[0].token, undefined, 'Geheimnis wird nie wieder ausgegeben');
    assert.ok(list[0].lastUsedAt);
    assert.equal((await req('dana', 'DELETE', `/api/auth/tokens/${t.body.id}`)).status, 204);
    assert.equal((await req(null, 'GET', '/api/projects', undefined, bearer)).status, 401);
    assert.equal((await req(null, 'GET', '/api/projects', undefined, { authorization: 'Bearer anemo_gefaelscht_gefaelscht_xx' })).status, 401);
  });

  it('Abmelden beendet die Sitzung', async () => {
    assert.equal((await req('dana', 'POST', '/api/auth/logout')).status, 200);
    assert.equal((await req('dana', 'GET', '/api/projects')).status, 401);
  });
});
