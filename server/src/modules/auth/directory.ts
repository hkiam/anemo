/**
 * Unternehmensanmeldung (ADR-0021): LDAP/Active Directory und OpenID Connect. Beide liefern eine externe
 * Identität; daraus wird das Anemo-Konto angelegt bzw. aktualisiert und die Gruppenmitgliedschaft abgeglichen.
 * Lokale Konten werden nie automatisch übernommen.
 */
import { createHash, createPublicKey, randomBytes, verify as verifySig, type JsonWebKey } from 'node:crypto';
import type { Db } from '../../platform/db.ts';
import { HttpError } from '../../platform/http.ts';
import { escapeFilter, LdapClient } from '../../platform/ldap.ts';
import type { User } from './service.ts';
import { settingsEnv } from '../../platform/settings.ts';

export interface ExternalIdentity {
  source: 'ldap' | 'oidc'; externalId: string; username: string; displayName: string; email: string | null; groups: string[];
  /** true/false nur, wenn eine Admin-Gruppe konfiguriert ist; sonst unverändert */
  admin: boolean | null;
}

const USER_COLUMNS = (db: Db) => db`id, username, display_name, email, source, active, is_system_admin, is_agent, created_at, last_login_at`;

/** Konto zur externen Identität anlegen/aktualisieren und Gruppen abgleichen. */
export async function provision(db: Db, id: ExternalIdentity): Promise<User> {
  const username = id.username.trim();
  if (!/^[\p{L}\p{N}._@-]{2,64}$/u.test(username)) throw new HttpError(400, `Benutzername „${username}“ ist für Anemo ungültig`);
  let [u] = await db<(User & { externalId: string | null })[]>`select ${USER_COLUMNS(db)}, external_id from app_user where source = ${id.source} and external_id = ${id.externalId}`;
  if (!u) {
    const [byName] = await db<(User & { externalId: string | null })[]>`select ${USER_COLUMNS(db)}, external_id from app_user where lower(username) = lower(${username})`;
    if (byName && (byName.source !== id.source || (byName.externalId && byName.externalId !== id.externalId))) {
      throw new HttpError(409, `Es gibt bereits ein Konto „${username}“ (${byName.source}). Bitte die Administration bitten, das Konto zuzuordnen.`);
    }
    u = byName;
  }
  if (u && !u.active) throw new HttpError(403, 'Konto ist deaktiviert.');
  const [row] = u
    ? await db<User[]>`update app_user set display_name = ${id.displayName}, email = coalesce(${id.email}, email), external_id = ${id.externalId},
        is_system_admin = ${id.admin === null ? db`is_system_admin` : db`${id.admin}`} where id = ${u.id} returning ${USER_COLUMNS(db)}`
    : await db<User[]>`insert into app_user(username, display_name, email, source, external_id, is_system_admin)
        values (${username}, ${id.displayName}, ${id.email}, ${id.source}, ${id.externalId}, ${id.admin ?? false}) returning ${USER_COLUMNS(db)}`;
  if (!u) await db`insert into user_notification(user_id, kind) values (${row!.id}, 'assigned'), (${row!.id}, 'retest'), (${row!.id}, 'mentioned'), (${row!.id}, 'watched') on conflict do nothing`;
  // Gruppen der gleichen Quelle abgleichen (lokale Gruppen bleiben unberührt)
  const groupIds: string[] = [];
  for (const g of [...new Set(id.groups)].slice(0, 500)) {
    const [existing] = await db<{ id: string }[]>`select id from user_group where source = ${id.source} and external_id = ${g}`;
    if (existing) { groupIds.push(existing.id); continue; }
    const [clash] = await db`select 1 from user_group where lower(name) = lower(${g})`;
    const [created] = await db<{ id: string }[]>`insert into user_group(name, description, source, external_id)
      values (${clash ? `${g} (${id.source.toUpperCase()})` : g}, ${`aus ${id.source.toUpperCase()} übernommen`}, ${id.source}, ${g}) returning id`;
    groupIds.push(created!.id);
  }
  await db`delete from group_member gm using user_group g where gm.group_id = g.id and gm.user_id = ${row!.id} and g.source = ${id.source}
           and not (g.id = any(${groupIds}::uuid[]))`;
  for (const gid of groupIds) await db`insert into group_member(group_id, user_id) values (${gid}, ${row!.id}) on conflict do nothing`;
  return row!;
}

// ---------------------------------------------------------------------------------------------
// LDAP / Active Directory
// ---------------------------------------------------------------------------------------------

export interface LdapConfig {
  url: string; bindDn: string; bindPassword: string; baseDn: string; userFilter: string; usernameAttr: string;
  groupFilter: string | null; groupBaseDn: string | null; groupPattern: RegExp | null; adminGroup: string | null; rejectUnauthorized: boolean;
}

export function ldapConfig(env: NodeJS.ProcessEnv = settingsEnv()): LdapConfig | null {
  if (!env.LDAP_URL || !env.LDAP_BASE_DN) return null;
  return {
    url: env.LDAP_URL, bindDn: env.LDAP_BIND_DN ?? '', bindPassword: env.LDAP_BIND_PASSWORD ?? '', baseDn: env.LDAP_BASE_DN,
    userFilter: env.LDAP_USER_FILTER ?? '(&(objectClass=person)(|(sAMAccountName={username})(uid={username})))',
    usernameAttr: env.LDAP_USERNAME_ATTR ?? '', groupFilter: env.LDAP_GROUP_FILTER ?? null, groupBaseDn: env.LDAP_GROUP_BASE_DN ?? null,
    groupPattern: env.LDAP_GROUP_PATTERN ? new RegExp(env.LDAP_GROUP_PATTERN, 'i') : null, adminGroup: env.LDAP_ADMIN_GROUP ?? null,
    rejectUnauthorized: env.LDAP_TLS_INSECURE !== 'true',
  };
}

const cn = (dn: string) => /^cn=((?:\\,|[^,])+)/i.exec(dn)?.[1]?.replace(/\\,/g, ',') ?? dn;

/** Anmeldung per Bind; null bei unbekanntem Benutzer oder falschem Kennwort. */
export async function ldapAuthenticate(cfg: LdapConfig, username: string, password: string): Promise<ExternalIdentity | null> {
  if (!password) return null;
  const c = await LdapClient.connect(cfg.url, { rejectUnauthorized: cfg.rejectUnauthorized });
  try {
    if (cfg.bindDn) await c.bind(cfg.bindDn, cfg.bindPassword);
    const filter = cfg.userFilter.replaceAll('{username}', escapeFilter(username));
    const attrs = ['cn', 'displayName', 'mail', 'memberOf', 'sAMAccountName', 'uid', 'entryUUID', 'objectGUID'];
    const [entry] = await c.search(cfg.baseDn, filter, cfg.usernameAttr ? [...attrs, cfg.usernameAttr] : attrs, 2, 2);
    if (!entry) return null;
    try {
      await c.bind(entry.dn, password);
    } catch (e) {
      if ((e as { code?: number }).code === 49) return null; // invalidCredentials
      throw e;
    }
    const a = entry.attributes;
    let groups = (a.memberof ?? []).map(cn);
    if (cfg.groupFilter) {
      if (cfg.bindDn) await c.bind(cfg.bindDn, cfg.bindPassword);
      const gf = cfg.groupFilter.replaceAll('{dn}', escapeFilter(entry.dn)).replaceAll('{username}', escapeFilter(username));
      groups = [...groups, ...(await c.search(cfg.groupBaseDn ?? cfg.baseDn, gf, ['cn'], 2, 500)).map((g) => g.attributes.cn?.[0] ?? cn(g.dn))];
    }
    if (cfg.groupPattern) groups = groups.filter((g) => cfg.groupPattern!.test(g));
    const name = (cfg.usernameAttr && a[cfg.usernameAttr.toLowerCase()]?.[0]) || a.samaccountname?.[0] || a.uid?.[0] || username;
    return {
      source: 'ldap', externalId: a.entryuuid?.[0] ?? entry.dn, username: name, displayName: a.displayname?.[0] ?? a.cn?.[0] ?? name,
      email: a.mail?.[0] ?? null, groups, admin: cfg.adminGroup ? groups.some((g) => g.toLowerCase() === cfg.adminGroup!.toLowerCase()) : null,
    };
  } finally {
    c.close();
  }
}

// ---------------------------------------------------------------------------------------------
// OpenID Connect (Authorization Code + PKCE)
// ---------------------------------------------------------------------------------------------

export interface OidcConfig {
  issuer: string; clientId: string; clientSecret: string | null; scopes: string; usernameClaim: string;
  /** ein oder mehrere Claims, Komma-getrennt, mit Punkt-Pfaden (z. B. "groups,realm_access.roles,resource_access.anemo.roles") */
  groupsClaim: string;
  /** Keycloak-Gruppenpfade "/Abteilung/Team" vollständig übernehmen statt nur des letzten Teils */
  groupsFullPath: boolean;
  /** "max@firma.de" → "max" (Entra-UPN, E-Mail-Benutzernamen) */
  stripDomain: boolean;
  tokenAuth: 'basic' | 'post';
  adminGroup: string | null; label: string; redirectUri: string; postLogoutUri: string; logout: boolean;
}

export function oidcConfig(env: NodeJS.ProcessEnv = settingsEnv()): OidcConfig | null {
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID) return null;
  const base = (env.ANEMO_PUBLIC_URL ?? `http://localhost:${env.ANEMO_PORT ?? 8090}`).replace(/\/+$/, '');
  return {
    issuer: env.OIDC_ISSUER.replace(/\/+$/, ''), clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET ?? null,
    scopes: env.OIDC_SCOPES ?? 'openid profile email', usernameClaim: env.OIDC_USERNAME_CLAIM ?? 'preferred_username',
    groupsClaim: env.OIDC_GROUPS_CLAIM ?? 'groups', groupsFullPath: env.OIDC_GROUPS_FULL_PATH === 'true',
    stripDomain: env.OIDC_USERNAME_STRIP_DOMAIN !== 'false', tokenAuth: env.OIDC_TOKEN_AUTH === 'post' ? 'post' : 'basic',
    adminGroup: env.OIDC_ADMIN_GROUP ?? null, label: env.OIDC_LABEL ?? 'Mit Firmenkonto anmelden',
    redirectUri: `${base}/api/auth/oidc/callback`, postLogoutUri: `${base}/`, logout: env.OIDC_LOGOUT !== 'false',
  };
}

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; end_session_endpoint?: string }
const discoveryCache = new Map<string, { at: number; d: Discovery; keys: (JsonWebKey & { kid?: string; alg?: string })[] }>();

async function discover(cfg: OidcConfig, refreshKeys = false) {
  const hit = discoveryCache.get(cfg.issuer);
  if (hit && !refreshKeys && Date.now() - hit.at < 3600_000) return hit;
  const d = (await (await fetch(`${cfg.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })).json()) as Discovery;
  if (d.issuer.replace(/\/+$/, '') !== cfg.issuer) throw new Error(`OIDC: Issuer passt nicht (${d.issuer})`);
  const jwks = (await (await fetch(d.jwks_uri, { signal: AbortSignal.timeout(10_000) })).json()) as { keys: (JsonWebKey & { kid?: string })[] };
  const v = { at: Date.now(), d, keys: jwks.keys };
  discoveryCache.set(cfg.issuer, v);
  return v;
}

const b64url = (b: Buffer) => b.toString('base64url');

/** Rücksprung nur innerhalb der Anwendung: Pfad mit genau einem führenden „/“ (kein //host, kein /\host). */
export const safeReturnTo = (r: string | null | undefined): string => (r && /^\/(?![/\\])[^\s\\]*$/.test(r) ? r : '/');

/** Liefert die Weiterleitungsadresse und den Login-State (wird zusätzlich als Cookie an den Browser gebunden). */

export async function startOidc(db: Db, cfg: OidcConfig, returnTo: string): Promise<{ url: string; state: string }> {
  const { d } = await discover(cfg);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(16));
  await db`delete from oidc_login where expires_at < now()`;
  await db`insert into oidc_login(state, verifier, nonce, return_to, expires_at)
           values (${state}, ${verifier}, ${nonce}, ${safeReturnTo(returnTo)}, ${new Date(Date.now() + 10 * 60_000)})`;
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri, scope: cfg.scopes, state, nonce,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  }).toString();
  return { url: u.toString(), state };
}

const ALG: Record<string, { hash: string; ec?: boolean; pss?: boolean }> = {
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true }, ES256: { hash: 'sha256', ec: true }, ES384: { hash: 'sha384', ec: true },
};

/** ID-Token prüfen: Signatur (JWKS), Issuer, Audience, Ablauf, Nonce. */
/** Verbindungstest für die Administration: Discovery und Schlüssel des Anbieters abrufen. */
export async function testOidc(cfg: OidcConfig): Promise<string> {
  const { d, keys } = await discover(cfg, true);
  return `Anbieter erreichbar: ${d.issuer} (${keys.length} Signaturschlüssel)`;
}

/** Verbindungstest: Dienstkonto anmelden und eine Benutzersuche ausführen (ohne Treffer zu erwarten). */
export async function testLdap(cfg: LdapConfig): Promise<string> {
  await ldapAuthenticate(cfg, 'anemo-verbindungstest-' + Date.now(), 'x');
  return `Verzeichnis erreichbar, Dienstkonto angemeldet, Suche unter ${cfg.baseDn} möglich`;
}

export async function verifyIdToken(cfg: OidcConfig, token: string, nonce: string): Promise<Record<string, unknown>> {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new Error('ID-Token ungültig');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg: string; kid?: string };
  const alg = ALG[header.alg];
  if (!alg) throw new Error(`ID-Token: Algorithmus ${header.alg} nicht erlaubt`);
  let { keys } = await discover(cfg);
  let jwk = keys.find((k) => !header.kid || k.kid === header.kid);
  if (!jwk) {
    keys = (await discover(cfg, true)).keys; // Schlüsselwechsel beim Anbieter
    jwk = keys.find((k) => !header.kid || k.kid === header.kid);
  }
  if (!jwk) throw new Error('ID-Token: Schlüssel unbekannt');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const ok = verifySig(alg.hash, Buffer.from(`${h}.${p}`), alg.ec ? { key, dsaEncoding: 'ieee-p1363' } : alg.pss ? { key, padding: 6, saltLength: 32 } : key, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('ID-Token: Signatur ungültig');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
  const now = Date.now() / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (String(claims.iss).replace(/\/+$/, '') !== cfg.issuer) throw new Error('ID-Token: falscher Aussteller');
  if (!aud.includes(cfg.clientId)) throw new Error('ID-Token: nicht für diese Anwendung');
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new Error('ID-Token abgelaufen');
  if (claims.nonce !== nonce) throw new Error('ID-Token: Nonce passt nicht');
  return claims;
}

export async function finishOidc(db: Db, cfg: OidcConfig, code: string, state: string): Promise<{ identity: ExternalIdentity; returnTo: string; idToken: string }> {
  const [login] = await db<{ verifier: string; nonce: string; returnTo: string }[]>`
    delete from oidc_login where state = ${state} and expires_at > now() returning verifier, nonce, return_to`;
  if (!login) throw new HttpError(400, 'Anmeldung abgelaufen oder ungültig – bitte erneut versuchen.');
  login.returnTo = safeReturnTo(login.returnTo);
  const { d } = await discover(cfg);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri, code_verifier: login.verifier, client_id: cfg.clientId });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  // Keycloak: beides; Entra ID: client_secret_post oder Basic
  if (cfg.clientSecret && cfg.tokenAuth === 'post') body.set('client_secret', cfg.clientSecret);
  else if (cfg.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64')}`;
  const res = await fetch(d.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
  const tok = (await res.json()) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !tok.id_token) throw new HttpError(401, `Anmeldung beim Identitätsanbieter fehlgeschlagen: ${tok.error_description ?? tok.error ?? res.status}`);
  const c = await verifyIdToken(cfg, tok.id_token, login.nonce);
  const groups = claimGroups(c, cfg);
  const username = String(claimAt(c, cfg.usernameClaim) ?? c.email ?? c.upn ?? c.sub);
  return {
    returnTo: login.returnTo, idToken: tok.id_token,
    identity: {
      // Entra ID: "oid" ist je Mandant stabil, "sub" ist paarweise je Anwendung – beides geeignet; oid bevorzugt
      source: 'oidc', externalId: String(c.oid ?? c.sub), username: cfg.stripDomain && username.includes('@') ? username.split('@')[0]! : username,
      displayName: String(c.name ?? username),
      email: typeof c.email === 'string' ? c.email : typeof c.upn === 'string' && c.upn.includes('@') ? c.upn : null, groups,
      admin: cfg.adminGroup ? groups.some((g) => g.toLowerCase() === cfg.adminGroup!.toLowerCase()) : null,
    },
  };
}

/** Claim über Punkt-Pfad lesen, z. B. "realm_access.roles" oder "resource_access.anemo.roles" (Keycloak). */
export function claimAt(claims: Record<string, unknown>, path: string): unknown {
  if (path in claims) return claims[path];
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), claims);
}

/** Gruppen/Rollen aus einem oder mehreren Claims; Keycloak-Pfade "/A/B" → "B" (oder vollständig). */
export function claimGroups(c: Record<string, unknown>, cfg: Pick<OidcConfig, 'groupsClaim' | 'groupsFullPath'>): string[] {
  const out: string[] = [];
  for (const path of cfg.groupsClaim.split(',').map((x) => x.trim()).filter(Boolean)) {
    const v = claimAt(c, path);
    for (const g of Array.isArray(v) ? v : typeof v === 'string' ? [v] : []) {
      const name = String(g).replace(/^\//, '');
      out.push(cfg.groupsFullPath ? name : name.split('/').pop()!);
    }
  }
  if (c._claim_names && typeof c._claim_names === 'object' && 'groups' in (c._claim_names as object)) {
    // Entra ID „Group Overage“: zu viele Gruppen für das Token – App-Rollen oder Gruppenfilter in Entra verwenden
    console.warn('OIDC: Gruppenanzahl überschreitet Tokengrenze (Entra „groups overage“) – App-Rollen (Claim „roles“) empfohlen');
  }
  return [...new Set(out)];
}

/** Abmelden auch beim Identitätsanbieter (RP-initiated Logout), sofern der Anbieter es anbietet. */
export async function oidcLogoutUrl(cfg: OidcConfig, idToken: string | null = null): Promise<string | null> {
  if (!cfg.logout) return null;
  try {
    const { d } = await discover(cfg);
    if (!d.end_session_endpoint) return null;
    const u = new URL(d.end_session_endpoint);
    u.searchParams.set('client_id', cfg.clientId);
    u.searchParams.set('post_logout_redirect_uri', cfg.postLogoutUri);
    if (idToken) u.searchParams.set('id_token_hint', idToken); // Keycloak/Entra: Abmeldung ohne Rückfrage
    return u.toString();
  } catch {
    return null;
  }
}
