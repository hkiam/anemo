import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setAccountMailSender } from '../src/modules/auth/accounts.ts';
import { type TestEnv, testEnv } from './helpers.ts';

const PW = 'Sicheres-Passwort-1';

describe('Konten und Kennwörter (Modus on)', () => {
  let env: TestEnv;
  const cookies = new Map<string, string>();
  const mails: { to: string[]; subject: string; text: string }[] = [];
  const req = async (user: string | null, method: string, path: string, body?: unknown) => {
    const res = await env.app.request(path, { method, headers: { 'content-type': 'application/json', host: 'anemo.test', ...(user && cookies.has(user) ? { cookie: cookies.get(user)! } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get('set-cookie') };
  };
  const login = async (u: string, pw: string, as = u) => {
    const r = await req(null, 'POST', '/api/auth/login', { username: u, password: pw });
    if (r.status === 200) cookies.set(as, r.setCookie!.split(';')[0]!);
    return r;
  };
  const ids: Record<string, string> = {};
  before(async () => {
    env = await testEnv({ authMode: 'on' });
    Object.assign(process.env, { ANEMO_ADMIN_PASSWORD: PW, SMTP_HOST: 'mail.example.test', SMTP_FROM: 'anemo@example.test', ANEMO_PUBLIC_URL: 'https://anemo.example.test' });
    setAccountMailSender(async (_c, m) => { mails.push(m); });
    const { bootstrapAdmin } = await import('../src/modules/auth/index.ts');
    await bootstrapAdmin(env.db, '/dev/null', () => {});
    delete process.env.ANEMO_ADMIN_PASSWORD;
    await login('admin', PW);
    for (const u of ['vera', 'tom']) ids[u] = (await req('admin', 'POST', '/api/admin/users', { username: u, displayName: u.toUpperCase(), email: `${u}@example.test`, password: PW })).body.id;
  });
  after(async () => {
    setAccountMailSender(null);
    for (const k of ['SMTP_HOST', 'SMTP_FROM', 'ANEMO_PUBLIC_URL', 'ANEMO_PASSWORD_MIN_LENGTH']) delete process.env[k];
    await env.close();
  });

  it('Anlegen mit Einmal-Kennwort: einmal angezeigt, Pflichtwechsel serverseitig erzwungen', async () => {
    const r = await req('admin', 'POST', '/api/admin/users', { username: 'neu', displayName: 'Neu', email: 'neu@example.test', generatePassword: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.password, /^[A-Za-z2-9]{5}-[A-Za-z2-9]{5}-[A-Za-z2-9]{5}-[A-Za-z2-9]{4}[2-9]$/);
    assert.equal(r.body.mustChangePassword, true);
    const l = await login('neu', r.body.password);
    assert.equal(l.body.user.mustChangePassword, true);
    const blocked = await req('neu', 'GET', '/api/projects');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await req('neu', 'GET', '/api/auth/me')).body.mustChangePassword, true);
    assert.equal((await req('neu', 'POST', '/api/auth/password', { currentPassword: r.body.password, newPassword: r.body.password })).status, 400, 'muss sich unterscheiden');
    assert.equal((await req('neu', 'POST', '/api/auth/password', { currentPassword: r.body.password, newPassword: 'Mein-neu-Kennwort-7' })).status, 400, 'enthält Benutzernamen');
    assert.equal((await req('neu', 'POST', '/api/auth/password', { currentPassword: r.body.password, newPassword: 'Eigenes-Kennwort-7' })).status, 204);
    assert.equal((await req('neu', 'GET', '/api/projects')).status, 200, 'aktuelle Sitzung bleibt, Sperre aufgehoben');
    assert.ok(mails.some((m) => m.to[0] === 'neu@example.test' && /Kennwort wurde geändert/.test(m.subject)));
    // Antwort der Liste enthält nie Hashes
    const list = (await req('admin', 'GET', '/api/admin/users')).body;
    assert.ok(list.every((u: Record<string, unknown>) => !('passwordHash' in u)));
  });

  it('Administration setzt zurück: Sitzungen enden, Tokens optional widerrufen, Hinweis per Mail, Protokoll ohne Kennwort', async () => {
    await login('tom', PW);
    const tok = await req('tom', 'POST', '/api/auth/tokens', { name: 'CI', expiresDays: null });
    assert.equal(tok.status, 201);
    mails.length = 0;
    const r = await req('admin', 'PUT', `/api/admin/users/${ids.tom}/password`, { generate: true, mustChange: true, revokeTokens: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.revokedTokens, 1);
    assert.equal((await req('tom', 'GET', '/api/auth/me')).status, 401, 'alte Sitzung beendet');
    assert.match(mails[0]!.text, /zurückgesetzt/);
    assert.doesNotMatch(mails[0]!.text, new RegExp(r.body.password));
    const ev = await env.db<{ payload: unknown }[]>`select payload from domain_event where type = 'UserPasswordReset'`;
    assert.ok(ev.length && !JSON.stringify(ev).includes(r.body.password));
    assert.equal((await login('tom', r.body.password)).body.user.mustChangePassword, true);
    // vorgegebenes Kennwort ohne Pflichtwechsel; Regeln greifen
    assert.equal((await req('admin', 'PUT', `/api/admin/users/${ids.tom}/password`, { password: 'kurz1', mustChange: false })).status, 400);
    assert.equal((await req('admin', 'PUT', `/api/admin/users/${ids.tom}/password`, { password: 'Neues-Tom-Kennwort-2', mustChange: false })).status, 400, 'enthält Benutzernamen');
    assert.equal((await req('admin', 'PUT', `/api/admin/users/${ids.tom}/password`, { password: 'Neues-Kennwort-22', mustChange: false })).status, 200);
    assert.equal((await login('tom', 'Neues-Kennwort-22')).body.user.mustChangePassword, false);
  });

  it('Sperre nach Fehlversuchen bleibt bestehen, ist sichtbar und lässt sich aufheben', async () => {
    for (let i = 0; i < 5; i++) await req(null, 'POST', '/api/auth/login', { username: 'vera', password: 'falsch-falsch-9' });
    const locked = await req(null, 'POST', '/api/auth/login', { username: 'vera', password: PW });
    assert.equal(locked.status, 429);
    const v = (await req('admin', 'GET', '/api/admin/users')).body.find((u: { username: string }) => u.username === 'vera');
    assert.ok(v.lockedUntil && v.failedLogins >= 5);
    assert.ok(mails.some((m) => m.to[0] === 'vera@example.test' && /gesperrt/.test(m.subject)));
    assert.equal((await req('admin', 'POST', `/api/admin/users/${ids.vera}/unlock`)).status, 204);
    // die In-Memory-Bremse je Name zählt unabhängig – deshalb direkt prüfen, dass die DB-Sperre weg ist
    const after = (await req('admin', 'GET', '/api/admin/users')).body.find((u: { username: string }) => u.username === 'vera');
    assert.deepEqual([after.lockedUntil, after.failedLogins], [null, 0]);
  });

  it('Sitzungen einsehen und beenden (eigene und durch die Administration)', async () => {
    await login('tom', 'Neues-Kennwort-22', 'tom2');
    await login('tom', 'Neues-Kennwort-22', 'tom3');
    const own = (await req('tom2', 'GET', '/api/auth/sessions')).body;
    assert.ok(own.length >= 2 && own.filter((s: { current: boolean }) => s.current).length === 1);
    assert.ok(own.every((s: { id: string }) => /^[0-9a-f]{16}$/.test(s.id)));
    const r = await req('tom2', 'DELETE', '/api/auth/sessions');
    assert.ok(r.body.ended >= 1);
    assert.equal((await req('tom3', 'GET', '/api/auth/me')).status, 401);
    assert.equal((await req('tom2', 'GET', '/api/auth/me')).status, 200, 'eigene Sitzung bleibt');
    assert.ok((await req('admin', 'GET', `/api/admin/users/${ids.tom}/sessions`)).body.length >= 1);
    await req('admin', 'DELETE', `/api/admin/users/${ids.tom}/sessions`);
    assert.equal((await req('tom2', 'GET', '/api/auth/me')).status, 401);
  });

  it('Kennwort vergessen: gleiche Antwort für alle, Link einmalig und befristet', async () => {
    assert.equal((await req(null, 'GET', '/api/auth/providers')).body.selfReset, true);
    mails.length = 0;
    assert.equal((await req(null, 'POST', '/api/auth/password-reset/request', { identifier: 'niemand' })).status, 204);
    assert.equal((await req(null, 'POST', '/api/auth/password-reset/request', { identifier: 'VERA@example.test' })).status, 204);
    assert.equal(mails.length, 1);
    const token = /token=([A-Za-z0-9_-]+)/.exec(mails[0]!.text)![1]!;
    assert.match(mails[0]!.text, /https:\/\/anemo\.example\.test\/#\/kennwort-zuruecksetzen\?token=/);
    assert.deepEqual((await req(null, 'GET', `/api/auth/password-reset/check?token=${token}`)).body, { valid: true, username: 'vera' });
    assert.equal((await req(null, 'POST', '/api/auth/password-reset/request', { identifier: 'vera' })).status, 204);
    assert.equal(mails.length, 1, 'höchstens ein Link alle 2 Minuten');
    assert.equal((await req(null, 'POST', '/api/auth/password-reset/confirm', { token, password: 'kurz' })).status, 400);
    assert.equal((await req(null, 'POST', '/api/auth/password-reset/confirm', { token, password: 'Zurueckgesetzt-42' })).status, 200);
    assert.equal((await req(null, 'POST', '/api/auth/password-reset/confirm', { token, password: 'Nochmal-anders-42' })).status, 400, 'nur einmal');
    assert.equal((await login('vera', 'Zurueckgesetzt-42')).status, 200);
    // abgelaufener Link
    await env.db`update password_reset set created_at = now() - interval '1 hour'`;
    await req(null, 'POST', '/api/auth/password-reset/request', { identifier: 'vera' });
    const t2 = /token=([A-Za-z0-9_-]+)/.exec(mails.at(-1)!.text)![1]!;
    await env.db`update password_reset set expires_at = now() - interval '1 minute' where used_at is null`;
    assert.equal((await req(null, 'GET', `/api/auth/password-reset/check?token=${t2}`)).body.valid, false);
  });

  it('Link durch die Administration; externe Konten ausgenommen; Mindestlänge einstellbar', async () => {
    mails.length = 0;
    assert.equal((await req('admin', 'POST', `/api/admin/users/${ids.tom}/password-reset-link`)).status, 204);
    assert.match(mails[0]!.text, /die Administration \(admin\)/);
    await env.db`insert into app_user(username, display_name, source) values ('ldapnutzer', 'LDAP', 'ldap')`;
    const [l] = await env.db<{ id: string }[]>`select id from app_user where username = 'ldapnutzer'`;
    assert.equal((await req('admin', 'PUT', `/api/admin/users/${l!.id}/password`, { generate: true })).status, 409);
    process.env.ANEMO_PASSWORD_MIN_LENGTH = '20';
    assert.equal((await req('admin', 'PUT', `/api/admin/users/${ids.tom}/password`, { password: 'Kurz-genug-1234', mustChange: false })).status, 400);
    assert.equal((await req(null, 'GET', '/api/auth/providers')).body.minPasswordLength, 20);
  });
});
