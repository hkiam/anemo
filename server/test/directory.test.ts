import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { claimGroups } from '../src/modules/auth/directory.ts';
import { berInt, berStr, encodeFilter, int, readBer, seq, str, tlv } from '../src/platform/ldap.ts';
import { type TestEnv, testEnv } from './helpers.ts';

const PW = 'Sicheres-Passwort-1';

/** Simulierter Verzeichnisdienst: Dienstkonto + zwei Personen, Gruppen über memberOf. */
function ldapMock(): Promise<{ server: Server; port: number; groups: Record<string, string[]> }> {
  const people: Record<string, { dn: string; pw: string; mail: string; name: string }> = {
    max: { dn: 'uid=max,ou=people,dc=example,dc=test', pw: 'Domaene-123', mail: 'max@example.test', name: 'Max Muster' },
    tom: { dn: 'uid=tom,ou=people,dc=example,dc=test', pw: 'Domaene-456', mail: 'tom@example.test', name: 'Tom LDAP' },
  };
  const groups: Record<string, string[]> = { max: ['cn=QA-Team,ou=groups,dc=example,dc=test', 'cn=Anemo-Admins,ou=groups,dc=example,dc=test'], tom: [] };
  const server = createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const r = readBer(buf);
        if (!r) break;
        buf = buf.subarray(r.end);
        const [idB, op] = r.ber.children!;
        const id = berInt(idB!);
        const reply = (b: Buffer) => s.write(seq(0x30, int(id), b));
        const result = (tag: number, code: number) => reply(seq(tag, int(code, 0x0a), str(''), str('')));
        if (op!.tag === 0x60) {
          const dn = berStr(op!.children![1]!);
          const pw = berStr(op!.children![2]!);
          const ok = (dn === 'cn=svc,dc=example,dc=test' && pw === 'svc-geheim') || Object.values(people).some((p) => p.dn === dn && p.pw === pw);
          result(0x61, ok ? 0 : 49);
        } else if (op!.tag === 0x63) {
          const filter = op!.children![6]!;
          const raw = Buffer.concat([Buffer.from([filter.tag]), Buffer.from([0])]).toString() + filter.value.toString('latin1');
          for (const [u, p] of Object.entries(people)) {
            if (!raw.includes(u)) continue;
            const attr = (name: string, vals: string[]) => seq(0x30, str(name), seq(0x31, ...vals.map((v) => str(v))));
            reply(seq(0x64, str(p.dn), seq(0x30, attr('uid', [u]), attr('cn', [p.name]), attr('mail', [p.mail]), attr('memberOf', groups[u]!))));
          }
          result(0x65, 0);
        } else if (op!.tag === 0x42) s.end();
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as AddressInfo).port, groups })));
}

/** Cookie-Helfer für den OIDC-Ablauf: State-Cookie aus /start, Sitzungs-Cookie aus /callback. */
const cookieOf = (res: Response, name: string) => res.headers.getSetCookie().map((c) => c.split(';')[0]!).find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);
const stateOf = (res: Response) => cookieOf(res, 'anemo_oidc_state') ?? '';
const session = (res: Response) => cookieOf(res, 'anemo_session');

describe('LDAP-Filter', () => {
  it('kodiert verschachtelte Filter nach RFC 4515', () => {
    const b = encodeFilter('(&(objectClass=person)(|(uid=ma\\2a)(cn=Ma*ik)))');
    assert.equal(b[0], 0xa0);
    const r = readBer(b)!;
    assert.equal(r.ber.children!.length, 2);
    assert.equal(r.ber.children![1]!.tag, 0xa1);
    assert.equal(r.ber.children![1]!.children![1]!.tag, 0xa4, 'Teilstring');
    assert.equal(tlv(0x04, Buffer.from('x')).toString('hex'), '040178');
  });
});

describe('Unternehmensanmeldung (B5)', () => {
  let env: TestEnv;
  let ldap: Awaited<ReturnType<typeof ldapMock>>;
  let idp: ReturnType<typeof serve>;
  let idpUrl = '';
  const codes = new Map<string, string>();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let tokenAud = 'anemo';
  let claims: Record<string, unknown> = {};
  let tokenAuthSeen = '';

  const req = async (path: string, init: RequestInit = {}) => env.app.request(path, { ...init, headers: { host: 'anemo.test', 'content-type': 'application/json', ...(init.headers ?? {}) } });

  before(async () => {
    env = await testEnv({ authMode: 'on' });
    process.env.ANEMO_ADMIN_PASSWORD = PW;
    const { bootstrapAdmin } = await import('../src/modules/auth/index.ts');
    await bootstrapAdmin(env.db, '/dev/null', () => {});
    delete process.env.ANEMO_ADMIN_PASSWORD;
    ldap = await ldapMock();
    Object.assign(process.env, {
      LDAP_URL: `ldap://127.0.0.1:${ldap.port}`, LDAP_BASE_DN: 'dc=example,dc=test', LDAP_BIND_DN: 'cn=svc,dc=example,dc=test', LDAP_BIND_PASSWORD: 'svc-geheim',
      LDAP_ADMIN_GROUP: 'Anemo-Admins',
    });
    // simulierter OIDC-Anbieter
    const op = new Hono();
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
    op.get('/.well-known/openid-configuration', (c) => c.json({ issuer: idpUrl, authorization_endpoint: `${idpUrl}/auth`, token_endpoint: `${idpUrl}/token`, jwks_uri: `${idpUrl}/jwks`, end_session_endpoint: `${idpUrl}/logout` }));
    op.get('/jwks', (c) => c.json({ keys: [jwk] }));
    op.get('/auth', (c) => {
      const code = `code-${codes.size}`;
      codes.set(code, c.req.query('nonce')!);
      assert.equal(c.req.query('code_challenge_method'), 'S256');
      return c.redirect(`${c.req.query('redirect_uri')}?code=${code}&state=${c.req.query('state')}`);
    });
    op.post('/token', async (c) => {
      const f = await c.req.parseBody();
      tokenAuthSeen = f.client_secret ? 'post' : c.req.header('authorization')?.startsWith('Basic ') ? 'basic' : 'none';
      assert.ok(String(f.code_verifier).length > 40, 'PKCE');
      const now = Math.floor(Date.now() / 1000);
      const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const head = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
      const body = enc({ iss: idpUrl, aud: tokenAud, sub: 'oidc-123', exp: now + 300, iat: now, nonce: codes.get(String(f.code)),
        preferred_username: 'sabine', name: 'Sabine SSO', email: 'sabine@example.test', groups: ['/QA-Team', 'Release-Manager'], ...claims });
      const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
      return c.json({ id_token: `${head}.${body}.${sig}`, access_token: 'x', token_type: 'Bearer' });
    });
    await new Promise<void>((r) => { idp = serve({ fetch: op.fetch, port: 0 }, (i) => { idpUrl = `http://127.0.0.1:${i.port}`; r(); }); });
    Object.assign(process.env, { OIDC_ISSUER: idpUrl, OIDC_CLIENT_ID: 'anemo', OIDC_CLIENT_SECRET: 'geheim', ANEMO_PUBLIC_URL: 'http://anemo.test', OIDC_ADMIN_GROUP: 'Release-Manager' });
  });
  after(async () => {
    ldap.server.close();
    idp.close();
    for (const k of ['LDAP_URL', 'LDAP_BASE_DN', 'LDAP_BIND_DN', 'LDAP_BIND_PASSWORD', 'LDAP_ADMIN_GROUP', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'ANEMO_PUBLIC_URL', 'OIDC_ADMIN_GROUP']) delete process.env[k];
    await env.close();
  });

  it('meldet Verfahren an', async () => {
    const p = await (await req('/api/auth/providers')).json();
    assert.deepEqual({ local: p.local, ldap: p.ldap, oidc: p.oidc }, { local: true, ldap: true, oidc: { label: 'Mit Firmenkonto anmelden' } });
    assert.equal(typeof p.selfReset, 'boolean');
  });

  it('LDAP: Anmeldung legt Konto an, übernimmt Gruppen und Adminrecht; falsches Passwort 401', async () => {
    assert.equal((await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'max', password: 'falsch-falsch' }) })).status, 401);
    const res = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'max', password: 'Domaene-123' }) });
    assert.equal(res.status, 200, await res.clone().text());
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const me = await (await req('/api/auth/me', { headers: { cookie } })).json();
    assert.deepEqual([me.username, me.displayName, me.isSystemAdmin], ['max', 'Max Muster', true]);
    const groups = await (await req('/api/admin/groups', { headers: { cookie } })).json();
    assert.deepEqual(groups.map((g: any) => g.name).sort(), ['Anemo-Admins', 'QA-Team']);
    // Gruppenaustritt im Verzeichnis wird beim nächsten Login übernommen
    ldap.groups.max = ['cn=QA-Team,ou=groups,dc=example,dc=test'];
    const again = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'max', password: 'Domaene-123' }) });
    const c2 = again.headers.get('set-cookie')!.split(';')[0]!;
    const g2 = await (await req('/api/admin/groups', { headers: { cookie: c2 } })).json();
    assert.equal(g2, g2); // Abruf mit c2 schlägt fehl, da nicht mehr Admin
    const me2 = await (await req('/api/auth/me', { headers: { cookie: c2 } })).json();
    assert.equal(me2.isSystemAdmin, false);
  });

  it('LDAP übernimmt keine lokalen Konten: lokaler „admin“ meldet sich weiter lokal an', async () => {
    const res = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: PW }) });
    assert.equal(res.status, 200);
  });

  it('OIDC: Anmeldung mit PKCE, Signaturprüfung, Konto und Gruppen', async () => {
    const start = await req('/api/auth/oidc/start?returnTo=%2F%23%2Fp%2FX%2Fcycles');
    assert.equal(start.status, 302);
    const authUrl = start.headers.get('location')!;
    assert.ok(authUrl.startsWith(`${idpUrl}/auth?`));
    const authRes = await fetch(authUrl, { redirect: 'manual' });
    const cb = new URL(authRes.headers.get('location')!);
    assert.equal(`${cb.origin}${cb.pathname}`, 'http://anemo.test/api/auth/oidc/callback');
    const done = await req(`/api/auth/oidc/callback${cb.search}`, { headers: { cookie: stateOf(start) } });
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location'), '/#/p/X/cycles');
    const cookie = session(done)!;
    const me = await (await req('/api/auth/me', { headers: { cookie } })).json();
    assert.deepEqual([me.username, me.displayName, me.isSystemAdmin], ['sabine', 'Sabine SSO', true]);
    // Wiederverwendung desselben state ist nicht möglich
    const replay = await req(`/api/auth/oidc/callback${cb.search}`, { headers: { cookie: stateOf(start) } });
    assert.match(decodeURIComponent(replay.headers.get('location')!), /abgelaufen oder ungültig/);
  });

  it('OIDC: Rücksprung nur in die Anwendung, State ist an den Browser gebunden', async () => {
    for (const evil of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
      const start = await req(`/api/auth/oidc/start?returnTo=${encodeURIComponent(evil)}`);
      const cb = new URL((await fetch(start.headers.get('location')!, { redirect: 'manual' })).headers.get('location')!);
      const done = await req(`/api/auth/oidc/callback${cb.search}`, { headers: { cookie: stateOf(start) } });
      assert.equal(done.headers.get('location'), '/', evil);
    }
    // Callback in einem anderen Browser (ohne State-Cookie) wird abgelehnt – kein untergeschobenes Konto
    const start = await req('/api/auth/oidc/start');
    const cb = new URL((await fetch(start.headers.get('location')!, { redirect: 'manual' })).headers.get('location')!);
    const foreign = await req(`/api/auth/oidc/callback${cb.search}`);
    assert.match(decodeURIComponent(foreign.headers.get('location')!), /anderen Browser/);
    assert.equal(session(foreign), undefined);
  });

  it('OIDC: Token für andere Anwendung wird abgelehnt', async () => {
    tokenAud = 'fremde-app';
    const start = await req('/api/auth/oidc/start');
    const authRes = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const cb = new URL(authRes.headers.get('location')!);
    const done = await req(`/api/auth/oidc/callback${cb.search}`, { headers: { cookie: stateOf(start) } });
    assert.match(decodeURIComponent(done.headers.get('location')!), /nicht für diese Anwendung/);
    assert.equal(session(done), undefined);
    tokenAud = 'anemo';
  });

  it('Abmelden eines SSO-Kontos liefert die Abmelde-URL des Anbieters', async () => {
    const start = await req('/api/auth/oidc/start');
    const cb = new URL((await fetch(start.headers.get('location')!, { redirect: 'manual' })).headers.get('location')!);
    const cookie = session(await req(`/api/auth/oidc/callback${cb.search}`, { headers: { cookie: stateOf(start) } }))!;
    const out = await (await req('/api/auth/logout', { method: 'POST', headers: { cookie } })).json();
    assert.match(out.logoutUrl, /\/logout\?client_id=anemo&post_logout_redirect_uri=http%3A%2F%2Fanemo\.test%2F&id_token_hint=ey/);
  });

  it('Entra ID: UPN als Benutzername (ohne Domäne), oid als Kennung, App-Rollen, client_secret per POST', async () => {
    Object.assign(process.env, { OIDC_GROUPS_CLAIM: 'roles', OIDC_TOKEN_AUTH: 'post', OIDC_ADMIN_GROUP: 'Anemo.Admin' });
    claims = { preferred_username: 'k.weber@example.com', name: 'Katrin Weber', email: undefined, upn: 'k.weber@example.com', oid: '6f1c-guid', roles: ['Anemo.Tester', 'Anemo.Admin'], groups: ['a1b2-guid'] };
    const start = await req('/api/auth/oidc/start');
    const cb = new URL((await fetch(start.headers.get('location')!, { redirect: 'manual' })).headers.get('location')!);
    const cookie = session(await req(`/api/auth/oidc/callback${cb.search}`, { headers: { cookie: stateOf(start) } }))!;
    assert.equal(tokenAuthSeen, 'post');
    const me = await (await req('/api/auth/me', { headers: { cookie } })).json();
    assert.deepEqual([me.username, me.isSystemAdmin], ['k.weber', true]);
    const groups = await (await req('/api/admin/groups', { headers: { cookie } })).json();
    assert.ok(groups.some((g: any) => g.name === 'Anemo.Tester' && g.members.some((m: any) => m.username === 'k.weber')));
    const [u] = await env.db<{ email: string; externalId: string }[]>`select email, external_id from app_user where username = 'k.weber'`;
    assert.deepEqual([u!.email, u!.externalId], ['k.weber@example.com', '6f1c-guid']);
    claims = {};
    for (const k of ['OIDC_GROUPS_CLAIM', 'OIDC_TOKEN_AUTH']) delete process.env[k];
    process.env.OIDC_ADMIN_GROUP = 'Release-Manager';
  });
});

describe('Gruppen-Claims (Keycloak/Entra)', () => {
  it('liest mehrere Claims mit Punkt-Pfad und Keycloak-Gruppenpfade', () => {
    const c = { groups: ['/IT/QA-Team', '/Fachbereich'], realm_access: { roles: ['tester', 'offline_access'] }, resource_access: { anemo: { roles: ['designer'] } } };
    assert.deepEqual(claimGroups(c, { groupsClaim: 'groups,realm_access.roles,resource_access.anemo.roles', groupsFullPath: false }),
      ['QA-Team', 'Fachbereich', 'tester', 'offline_access', 'designer']);
    assert.deepEqual(claimGroups(c, { groupsClaim: 'groups', groupsFullPath: true }), ['IT/QA-Team', 'Fachbereich']);
  });
});
