/**
 * Modul auth: Anmeldung, Sitzungen, Benutzer, Gruppen, Rollen je Projekt, Rechteprüfung (ADR-0011).
 * Modus 'off' (nur Tests/Entwicklung): kein Login, Benutzer aus Header X-Anemo-User mit vollen Rechten.
 */
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { type Db, inTx } from '../../platform/db.ts';
import { type Access, type AccessControl, HttpError, notFound, route } from '../../platform/http.ts';
import { finishOidc, ldapConfig, oidcConfig, oidcLogoutUrl, provision, startOidc, testLdap, testOidc } from './directory.ts';
import { adminResetPassword, adminSendResetLink, checkReset, confirmReset, endSessions, listSessions, requestReset, selfResetAvailable, unlockUser } from './accounts.ts';
import { minPasswordLength, randomPassword } from './password.ts';
import { can, effectiveRole, hasPermission, loadPrincipal, type Permission, PERMISSIONS, type Principal, type ProjectRef, resolveProject, type Role, visibleProjectIds } from './access.ts';
import {
  changeOwnPassword, createGroup, listPermissionGrants, setPermission, createUser, deleteGroup, getUser, listGroups, listProjectMembers, listUsers, login, logout,
  sessionUser, setPassword, createSession, createApiToken, deleteApiToken, listApiTokens, tokenUser, setProjectMember, setProjectVisibility, updateGroup, updateUser,
} from './service.ts';

export { bootstrapAdmin, cleanupSessions } from './service.ts';
export type { Permission, Principal, ProjectRef, Role } from './access.ts';
export { can, hasPermission, visibleProjectIds } from './access.ts';

export type AuthMode = 'on' | 'off';
const COOKIE = 'anemo_session';
const OIDC_STATE_COOKIE = 'anemo_oidc_state';

/** Absenderadresse: hinter einem Reverse-Proxy (ANEMO_TRUST_PROXY=true) aus X-Forwarded-For, sonst die Verbindung. */
function clientIp(c: Context): string | null {
  if (process.env.ANEMO_TRUST_PROXY === 'true') return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null;
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? null;
}

export function principalOf(c: Context): Principal | null {
  return (c.get('principal' as never) as Principal | undefined) ?? null;
}

/** Sichtbare Projekt-IDs des aktuellen Benutzers (null = alle). */
export function visibleProjects(c: Context): string[] | null {
  const p = principalOf(c);
  return p ? visibleProjectIds(p) : [];
}

/** Instanzweites Recht verlangen (403 mit verständlicher Meldung). */
export function requirePermission(c: Context, permission: Permission): Principal {
  const p = principalOf(c);
  if (!p) throw new HttpError(401, 'Bitte anmelden.');
  if (!hasPermission(p, permission)) {
    const what: Record<Permission, string> = { PROJECT_TRANSFER: 'Projekte übertragen' };
    throw new HttpError(403, `Dafür fehlt das Recht „${what[permission]}“. Es wird von der Systemadministration vergeben.`);
  }
  return p;
}

export function authMiddleware(db: Db, mode: AuthMode): MiddlewareHandler {
  const check = accessControl(db);
  return async (c, next) => {
    c.set('accessControl' as never, check as never);
    if (mode === 'off') {
      const name = c.req.header('x-anemo-user')?.trim() || 'anonymous';
      c.set('principal' as never, { userId: null, username: name, displayName: name, isSystemAdmin: true, roles: new Map(), visibility: new Map(), permissions: new Set() } as never);
      c.set('actor' as never, name as never);
      c.set('visibleProjectIds' as never, null as never);
      await restrictForAgents(db, c);
      return next();
    }
    // Schutz gegen Cross-Site-Requests: ändernde Anfragen nur vom eigenen Ursprung
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin && new URL(origin).host !== (c.req.header('x-forwarded-host') ?? c.req.header('host'))) {
        throw new HttpError(403, 'Anfrage von fremdem Ursprung abgelehnt');
      }
    }
    // API-Token (Authorization: Bearer anemo_…) für CI, Skripte und Agenten, sonst Sitzungs-Cookie
    const bearer = /^Bearer\s+(anemo_[A-Za-z0-9_-]{20,})$/.exec(c.req.header('authorization') ?? '')?.[1];
    const token = bearer ? null : getCookie(c, COOKIE);
    const user = bearer ? await tokenUser(db, bearer) : token ? await sessionUser(db, token) : null;
    if (user) {
      // Pflichtwechsel des Kennworts gilt für Sitzungen (nicht für API-Tokens von CI/Agenten)
      if (!bearer && (user as { mustChangePassword?: boolean }).mustChangePassword) c.set('passwordChangeRequired' as never, true as never);
      const principal = await loadPrincipal(db, user);
      c.set('principal' as never, principal as never);
      c.set('actor' as never, user.username as never);
      c.set('visibleProjectIds' as never, visibleProjectIds(principal) as never);
    } else {
      c.set('visibleProjectIds' as never, [] as never);
    }
    // KI-Agentenkonten sind immer im Agentenkanal – unabhängig davon, ob sie den MCP-Header senden
    await restrictForAgents(db, c, !!user?.isAgent);
    return next();
  };
}

// ---- Kanal „Agent“ (MCP): Projekte mit gesperrten externen Diensten sind unsichtbar (ADR-0014/0018) ----

// bewusst ohne Zwischenspeicher: Sperren wirken sofort (wenige hundert Projekte, eine kurze Abfrage)
async function externalBlocked(db: Db) {
  const rows = await db<{ id: string; externalServices: string }[]>`select id, external_services from project`;
  return {
    blocked: new Set(rows.filter((r) => r.externalServices !== 'allowed').map((r) => r.id)),
    allowed: rows.filter((r) => r.externalServices === 'allowed').map((r) => r.id),
  };
}
const isAgent = (c: Context) => c.get('channel' as never) === 'mcp';

async function restrictForAgents(db: Db, c: Context, agentAccount = false): Promise<void> {
  if (c.req.header('x-anemo-channel') !== 'mcp' && !agentAccount) return;
  c.set('channel' as never, 'mcp' as never);
  const { allowed } = await externalBlocked(db);
  const visible = c.get('visibleProjectIds' as never) as string[] | null;
  c.set('visibleProjectIds' as never, (visible === null ? allowed : visible.filter((id) => allowed.includes(id))) as never);
}

// ---- Zugriffsprotokoll für eingeschränkte Projekte (A5, ADR-0014) ----

const restrictedCache = { at: 0, ids: new Set<string>() };
async function isRestricted(db: Db, projectId: string): Promise<boolean> {
  if (Date.now() - restrictedCache.at > 30_000) {
    restrictedCache.ids = new Set((await db<{ id: string }[]>`select id from project where visibility = 'restricted'`).map((r) => r.id));
    restrictedCache.at = Date.now();
  }
  return restrictedCache.ids.has(projectId);
}
export function forgetRestrictedCache(): void {
  restrictedCache.at = 0;
}

// Wiederholte Zugriffe derselben Person auf dasselbe Objekt nur alle 5 Minuten protokollieren
const recent = new Map<string, number>();
async function logAccess(db: Db, c: Context, p: Principal, projectId: string, ref: ProjectRef, action: string): Promise<void> {
  if (!(await isRestricted(db, projectId))) return;
  const objectId = 'id' in ref ? ref.id : 'key' in ref ? ref.key : ref.ownerId;
  const objectKind = ref.kind === 'owner' ? ref.ownerType : ref.kind;
  const k = `${p.username}|${objectKind}|${objectId}|${action}`;
  if ((recent.get(k) ?? 0) > Date.now() - 300_000) return;
  if (recent.size > 20_000) recent.clear();
  recent.set(k, Date.now());
  await db`insert into access_log(project_id, user_id, username, action, object_kind, object_id, path)
           values (${projectId}, ${p.userId}, ${p.username}, ${action}, ${objectKind}, ${objectId}, ${new URL(c.req.url).pathname})`;
}

/** Was bei ausstehendem Pflichtwechsel des Kennworts erlaubt bleibt */
const PASSWORD_CHANGE_ALLOWED = new Set(['/api/auth/me', '/api/auth/password', '/api/auth/logout']);

/** Rechteprüfung für Routen (die Plattform ruft sie vor jedem Handler auf). */
function accessControl(db: Db): AccessControl {
  return async (c, access: Access, input) => {
    if (access === 'public') return;
    const p = principalOf(c);
    if (!p) throw new HttpError(401, 'Bitte anmelden.');
    if (c.get('passwordChangeRequired' as never) && !PASSWORD_CHANGE_ALLOWED.has(c.req.path)) {
      throw new HttpError(403, 'Bitte zuerst ein neues Kennwort festlegen.', { code: 'PASSWORD_CHANGE_REQUIRED' });
    }
    if (access === 'authenticated') return;
    if (access === 'admin') {
      if (!p.isSystemAdmin) throw new HttpError(403, 'Nur für Systemadministration.');
      return;
    }
    const refs = await access.project(input);
    for (const ref of (Array.isArray(refs) ? refs : [refs]).filter(Boolean) as ProjectRef[]) {
      const projectId = await resolveProject(db, ref);
      // Nicht zuordenbares Objekt: sofort 404 statt Prüfung zu überspringen (schlägt geschlossen fehl)
      if (!projectId) throw notFound('Objekt', 'nicht vorhanden oder kein Zugriff');
      if (isAgent(c) && (await externalBlocked(db)).blocked.has(projectId)) throw notFound('Objekt', 'nicht vorhanden oder für externe Dienste gesperrt');
      const allowed = !!effectiveRole(p, projectId) && can(p, projectId, access.level);
      await logAccess(db, c, p, projectId, ref, allowed ? access.level : `denied:${access.level}`);
      if (!effectiveRole(p, projectId)) throw notFound('Objekt', 'nicht vorhanden oder kein Zugriff');
      if (!allowed) {
        const what = { read: 'Lesen', execute: 'Ausführen', edit: 'Pflegen', manage: 'Projektadministration' }[access.level];
        throw new HttpError(403, `Keine Berechtigung (${what}) für dieses Projekt.`);
      }
    }
  };
}

const RoleSchema = z.enum(['VIEWER', 'TESTER', 'DESIGNER', 'PROJECT_ADMIN']);

export function authRoutes(app: Hono, db: Db, mode: AuthMode): void {
  const tag = 'Anmeldung';
  route(app, {
    method: 'post', path: '/api/auth/login', tag, summary: 'Anmelden (setzt Sitzungs-Cookie)', access: 'public',
    body: z.object({ username: z.string().min(1), password: z.string().min(1) }),
  }, async ({ body, c }) => {
    if (mode === 'off') throw new HttpError(400, 'Anmeldung ist in diesem Modus deaktiviert.');
    const r = await login(db, body.username, body.password, c.req.header('user-agent') ?? null, clientIp(c));
    setCookie(c, COOKIE, r.token, {
      httpOnly: true, sameSite: 'Lax', path: '/', expires: r.expiresAt,
      secure: c.req.url.startsWith('https:') || c.req.header('x-forwarded-proto') === 'https',
    });
    return { user: r.user };
  });
  // ---- Unternehmensanmeldung (ADR-0021) ----
  route(app, { method: 'get', path: '/api/auth/providers', tag, summary: 'Verfügbare Anmeldeverfahren', access: 'public' }, async () => {
    const o = oidcConfig();
    return { local: true, ldap: !!ldapConfig(), oidc: o ? { label: o.label } : null, selfReset: selfResetAvailable(), minPasswordLength: minPasswordLength() };
  });
  route(app, {
    method: 'get', path: '/api/auth/oidc/start', tag, summary: 'Anmeldung beim Identitätsanbieter starten (Weiterleitung)', access: 'public',
    query: z.object({ returnTo: z.string().max(500).optional() }),
  }, async ({ query, c }) => {
    const cfg = oidcConfig();
    if (!cfg) throw notFound('Anmeldeverfahren', 'OIDC');
    const { url, state } = await startOidc(db, cfg, query.returnTo ?? '/');
    // State an diesen Browser binden (Schutz gegen untergeschobene Anmeldungen / Login-CSRF)
    setCookie(c, OIDC_STATE_COOKIE, state, {
      httpOnly: true, sameSite: 'Lax', path: '/api/auth/oidc', maxAge: 600,
      secure: c.req.url.startsWith('https:') || c.req.header('x-forwarded-proto') === 'https',
    });
    return c.redirect(url, 302);
  });
  route(app, {
    method: 'get', path: '/api/auth/oidc/callback', tag, summary: 'Rückkehr vom Identitätsanbieter', access: 'public',
    query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() }),
  }, async ({ query, c }) => {
    const cfg = oidcConfig();
    if (!cfg) throw notFound('Anmeldeverfahren', 'OIDC');
    const back = (msg: string) => c.redirect(`/#/?loginError=${encodeURIComponent(msg)}`, 302);
    if (query.error || !query.code || !query.state) return back(query.error_description ?? query.error ?? 'Anmeldung abgebrochen');
    const bound = getCookie(c, OIDC_STATE_COOKIE);
    deleteCookie(c, OIDC_STATE_COOKIE, { path: '/api/auth/oidc' });
    if (bound !== query.state) return back('Anmeldung wurde in einem anderen Browser begonnen – bitte erneut anmelden.');
    try {
      const { identity, returnTo, idToken } = await finishOidc(db, cfg, query.code, query.state);
      const s = await createSession(db, await provision(db, identity), c.req.header('user-agent') ?? null, idToken);
      setCookie(c, COOKIE, s.token, {
        httpOnly: true, sameSite: 'Lax', path: '/', expires: s.expiresAt,
        secure: c.req.url.startsWith('https:') || c.req.header('x-forwarded-proto') === 'https',
      });
      return c.redirect(returnTo, 302);
    } catch (e) {
      return back(e instanceof HttpError ? e.message : `Anmeldung fehlgeschlagen: ${(e as Error).message}`);
    }
  });
  route(app, { method: 'post', path: '/api/auth/logout', tag, summary: 'Abmelden (liefert ggf. Abmelde-URL des Identitätsanbieters)', access: 'public' }, async ({ c }) => {
    const token = getCookie(c, COOKIE);
    const p = principalOf(c);
    const idToken = token ? await logout(db, token) : null;
    deleteCookie(c, COOKIE, { path: '/' });
    // Bei SSO-Konten auch beim Anbieter abmelden, sonst wäre die nächste Anmeldung ohne Kennwort
    const [u] = p?.userId ? await db<{ source: string }[]>`select source from app_user where id = ${p.userId}` : [];
    const cfg = oidcConfig();
    return { logoutUrl: u?.source === 'oidc' && cfg ? await oidcLogoutUrl(cfg, idToken) : null };
  });
  route(app, { method: 'get', path: '/api/auth/me', tag, summary: 'Angemeldeter Benutzer mit Rollen je Projekt' }, async ({ c }) => {
    const p = principalOf(c)!;
    const projects = await db<{ id: string; key: string }[]>`select id, key from project order by key`;
    const [acc] = p.userId ? await db<{ source: string; mustChangePassword: boolean; passwordChangedAt: Date | null }[]>`
      select source, must_change_password, password_changed_at from app_user where id = ${p.userId}` : [];
    return {
      username: p.username, displayName: p.displayName, isSystemAdmin: p.isSystemAdmin, authMode: mode,
      permissions: PERMISSIONS.filter((x) => hasPermission(p, x)),
      source: acc?.source ?? null, mustChangePassword: !!acc?.mustChangePassword, passwordChangedAt: acc?.passwordChangedAt ?? null, minPasswordLength: minPasswordLength(),
      projectRoles: Object.fromEntries(projects.map((x) => [x.key, effectiveRole(p, x.id)]).filter(([, r]) => r)),
    };
  });
  route(app, {
    method: 'post', path: '/api/auth/password', tag, summary: 'Eigenes Kennwort ändern', status: 204,
    body: z.object({ currentPassword: z.string(), newPassword: z.string() }),
  }, async ({ c, body }) => {
    const p = principalOf(c)!;
    if (!p.userId) throw new HttpError(400, 'Im Modus ohne Anmeldung nicht möglich.');
    await inTx(db, (tx) => changeOwnPassword(tx, p.userId!, body.currentPassword, body.newPassword, getCookie(c, COOKIE) ?? null));
  });
  // ---- Kennwort vergessen (öffentlich; Antwort verrät nicht, ob es das Konto gibt) ----
  route(app, {
    method: 'post', path: '/api/auth/password-reset/request', tag, summary: 'Link zum Zurücksetzen an die hinterlegte E-Mail-Adresse senden (Antwort immer gleich)', access: 'public', status: 204,
    body: z.object({ identifier: z.string().trim().min(1).max(200) }),
  }, async ({ body, c }) => {
    if (mode === 'off') throw new HttpError(400, 'Anmeldung ist in diesem Modus deaktiviert.');
    await requestReset(db, body.identifier, clientIp(c));
  });
  route(app, {
    method: 'get', path: '/api/auth/password-reset/check', tag, summary: 'Ist der Link zum Zurücksetzen gültig?', access: 'public',
    query: z.object({ token: z.string().min(20).max(200) }),
  }, ({ query }) => checkReset(db, query.token));
  route(app, {
    method: 'post', path: '/api/auth/password-reset/confirm', tag, summary: 'Neues Kennwort über den Link festlegen (beendet alle Sitzungen)', access: 'public',
    body: z.object({ token: z.string().min(20).max(200), password: z.string().max(256) }),
  }, ({ body }) => inTx(db, (tx) => confirmReset(tx, body.token, body.password)));
  // ---- eigene Sitzungen ----
  route(app, { method: 'get', path: '/api/auth/sessions', tag, summary: 'Eigene Sitzungen (Gerät/Browser, zuletzt aktiv)' }, async ({ c }) => {
    const p = principalOf(c)!;
    if (!p.userId) return [];
    return listSessions(db, p.userId, getCookie(c, COOKIE) ?? null);
  });
  route(app, {
    method: 'delete', path: '/api/auth/sessions', tag, summary: 'Eigene Sitzungen beenden (alle außer der aktuellen bzw. eine bestimmte)',
    query: z.object({ id: z.string().regex(/^[0-9a-f]{16}$/).optional() }),
  }, async ({ c, query }) => {
    const p = principalOf(c)!;
    if (!p.userId) throw new HttpError(400, 'Im Modus ohne Anmeldung nicht möglich.');
    return { ended: await endSessions(db, p.userId, { exceptCurrent: getCookie(c, COOKIE) ?? null, id: query.id }, p.username) };
  });

  route(app, { method: 'get', path: '/api/directory', tag, summary: 'Aktive Benutzer und Gruppen (für Auswahllisten, ohne Details)' }, async () => ({
    users: await db`select id, username, display_name from app_user where active order by lower(display_name)`,
    groups: await db`select id, name from user_group order by lower(name)`,
  }));

  // ---- eigene API-Tokens ----
  const own = (c: Context) => {
    const p = principalOf(c)!;
    if (!p.userId) throw new HttpError(400, 'Im Modus ohne Anmeldung nicht möglich.');
    return p.userId;
  };
  route(app, { method: 'get', path: '/api/auth/tokens', tag, summary: 'Eigene API-Tokens (ohne Geheimnis)' }, ({ c }) => listApiTokens(db, own(c)));
  route(app, {
    method: 'post', path: '/api/auth/tokens', tag, summary: 'API-Token erzeugen (wird nur einmal angezeigt)', status: 201,
    body: z.object({ name: z.string().trim().min(1).max(100), expiresDays: z.number().int().min(1).max(730).nullable() }),
  }, ({ c, body }) => createApiToken(db, own(c), body.name, body.expiresDays));
  route(app, { method: 'delete', path: '/api/auth/tokens/:id', tag, summary: 'API-Token widerrufen', status: 204 },
    ({ c, params }) => deleteApiToken(db, own(c), params.id!));

  // ---- Administration: Benutzer, Gruppen, Projektrechte ----
  const atag = 'Administration – Benutzer & Rechte';
  route(app, { method: 'post', path: '/api/admin/auth/test/:kind', tag: atag, summary: 'Verbindungstest SSO (oidc) bzw. LDAP (ldap)', access: 'admin' }, async ({ params }) => {
    try {
      if (params.kind === 'oidc') { const cfg = oidcConfig(); return cfg ? { ok: true, message: await testOidc(cfg) } : { ok: false, message: 'SSO ist nicht eingerichtet (Issuer, Client-ID)' }; }
      if (params.kind === 'ldap') { const cfg = ldapConfig(); return cfg ? { ok: true, message: await testLdap(cfg) } : { ok: false, message: 'LDAP ist nicht eingerichtet (Server, Basis-DN)' }; }
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    throw notFound('Verbindungstest', params.kind);
  });
  route(app, { method: 'get', path: '/api/admin/users', tag: atag, summary: 'Benutzer', access: 'admin' }, () => listUsers(db));
  route(app, {
    method: 'post', path: '/api/admin/users', tag: atag, summary: 'Benutzer anlegen', access: 'admin', status: 201,
    body: z.object({
      username: z.string(), displayName: z.string().min(1), email: z.string().email().nullish(), password: z.string().max(256).optional(),
      generatePassword: z.boolean().optional(), mustChangePassword: z.boolean().optional(), isSystemAdmin: z.boolean().optional(), isAgent: z.boolean().optional(),
    }),
  }, ({ body }) => inTx(db, async (tx) => {
    if (!body.password && !body.generatePassword) throw new HttpError(400, 'Kennwort angeben oder Einmal-Kennwort erzeugen lassen.');
    const password = body.generatePassword ? randomPassword() : body.password!;
    const u = await createUser(tx, { ...body, password, mustChangePassword: body.mustChangePassword ?? !!body.generatePassword });
    // Einmal-Kennwort nur in dieser Antwort (nie gespeichert oder protokolliert)
    return { ...u, password: body.generatePassword ? password : null };
  }));
  route(app, {
    method: 'patch', path: '/api/admin/users/:id', tag: atag, summary: 'Benutzer ändern (Name, E-Mail, aktiv, Systemadmin)', access: 'admin',
    body: z.object({ displayName: z.string().min(1).optional(), email: z.string().email().nullish(), active: z.boolean().optional(), isSystemAdmin: z.boolean().optional(), isAgent: z.boolean().optional() }),
  }, ({ params, body, c }) => inTx(db, (tx) => updateUser(tx, params.id!, body, principalOf(c)?.userId ?? null)));
  route(app, {
    method: 'put', path: '/api/admin/users/:id/password', tag: atag, access: 'admin',
    summary: 'Kennwort zurücksetzen: vorgegeben oder Einmal-Kennwort (nur in der Antwort), optional Pflichtwechsel und Widerruf der API-Tokens; beendet alle Sitzungen',
    body: z.object({ password: z.string().max(256).optional(), generate: z.boolean().optional(), mustChange: z.boolean().default(true), revokeTokens: z.boolean().optional() }),
  }, ({ params, body, actor }) => inTx(db, (tx) => adminResetPassword(tx, params.id!, body, actor)));
  route(app, { method: 'post', path: '/api/admin/users/:id/password-reset-link', tag: atag, summary: 'Link zum Zurücksetzen an die hinterlegte E-Mail-Adresse senden', access: 'admin', status: 204 },
    ({ params, actor }) => inTx(db, (tx) => adminSendResetLink(tx, params.id!, actor)));
  route(app, { method: 'post', path: '/api/admin/users/:id/unlock', tag: atag, summary: 'Sperre nach Fehlversuchen aufheben', access: 'admin', status: 204 },
    ({ params, actor }) => inTx(db, (tx) => unlockUser(tx, params.id!, actor)));
  route(app, { method: 'get', path: '/api/admin/users/:id/sessions', tag: atag, summary: 'Sitzungen eines Benutzers', access: 'admin' },
    ({ params, c }) => listSessions(db, params.id!, getCookie(c, COOKIE) ?? null));
  route(app, { method: 'delete', path: '/api/admin/users/:id/sessions', tag: atag, summary: 'Alle Sitzungen eines Benutzers beenden (bei sich selbst: außer der aktuellen)', access: 'admin' },
    async ({ params, c, actor }) => {
      const self = principalOf(c)?.userId === params.id;
      return { ended: await endSessions(db, params.id!, { exceptCurrent: self ? getCookie(c, COOKIE) ?? null : null }, actor) };
    });
  route(app, { method: 'get', path: '/api/admin/groups', tag: atag, summary: 'Gruppen mit Mitgliedern', access: 'admin' }, () => listGroups(db));
  route(app, {
    method: 'post', path: '/api/admin/groups', tag: atag, summary: 'Gruppe anlegen', access: 'admin', status: 201,
    body: z.object({ name: z.string().min(1), description: z.string().nullish() }),
  }, ({ body }) => createGroup(db, body.name, body.description ?? null));
  route(app, {
    method: 'put', path: '/api/admin/groups/:id', tag: atag, summary: 'Gruppe ändern (inkl. Mitglieder)', access: 'admin', status: 204,
    body: z.object({ name: z.string().min(1).optional(), description: z.string().nullish(), memberIds: z.array(z.uuid()).optional() }),
  }, ({ params, body }) => inTx(db, (tx) => updateGroup(tx, params.id!, body)));
  route(app, { method: 'delete', path: '/api/admin/groups/:id', tag: atag, summary: 'Gruppe löschen', access: 'admin', status: 204 },
    ({ params }) => inTx(db, (tx) => deleteGroup(tx, params.id!)));
  // ---- instanzweite Rechte (ADR-0027) ----
  route(app, { method: 'get', path: '/api/admin/permissions', tag: atag, summary: 'Vergebene instanzweite Rechte (z. B. „Projekte übertragen“)', access: 'admin' },
    async () => ({ permissions: PERMISSIONS, grants: await listPermissionGrants(db) }));
  route(app, {
    method: 'put', path: '/api/admin/permissions', tag: atag, summary: 'Instanzweites Recht an Benutzer oder Gruppe vergeben bzw. entziehen', access: 'admin', status: 204,
    body: z.object({ principalType: z.enum(['user', 'group']), principalId: z.uuid(), permission: z.enum(PERMISSIONS), granted: z.boolean() }),
  }, ({ body, actor }) => inTx(db, (tx) => setPermission(tx, body, actor)));
  route(app, { method: 'get', path: '/api/admin/projects', tag: atag, summary: 'Projekte mit Sichtbarkeit und Mitgliederzahl', access: 'admin' },
    () => db`select p.id, p.key, p.name, p.visibility, p.external_services, p.require_failure_evidence, p.execute_only_assignee, (select count(*)::int from project_member m where m.project_id = p.id) as members,
                    (select count(*)::int from test_case t where t.project_id = p.id) as test_cases
             from project p order by p.key`);
  route(app, {
    method: 'get', path: '/api/projects/:key/members', tag: atag, summary: 'Mitglieder eines Projekts',
    access: { level: 'manage', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
  }, async ({ params }) => {
    const [p] = await db<{ id: string }[]>`select id from project where key = ${params.key!}`;
    if (!p) throw notFound('Projekt', params.key);
    return listProjectMembers(db, p.id);
  });
  route(app, {
    method: 'put', path: '/api/projects/:key/members', tag: atag, summary: 'Rolle eines Benutzers/einer Gruppe setzen (role null = entfernen)',
    access: { level: 'manage', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
    body: z.object({ principalType: z.enum(['user', 'group']), principalId: z.uuid(), role: RoleSchema.nullable() }),
    status: 204,
  }, async ({ params, body }) => {
    const [p] = await db<{ id: string }[]>`select id from project where key = ${params.key!}`;
    if (!p) throw notFound('Projekt', params.key);
    await setProjectMember(db, p.id, body.principalType, body.principalId, body.role as Role | null);
  });
  route(app, {
    method: 'put', path: '/api/projects/:key/visibility', tag: atag, summary: 'Sichtbarkeit: internal (alle Angemeldeten lesen) oder restricted (nur Mitglieder)',
    access: 'admin', body: z.object({ visibility: z.enum(['internal', 'restricted']) }), status: 204,
  }, async ({ params, body }) => {
    const [p] = await db<{ id: string }[]>`select id from project where key = ${params.key!}`;
    if (!p) throw notFound('Projekt', params.key);
    await setProjectVisibility(db, p.id, body.visibility);
    forgetRestrictedCache();
  });
  route(app, {
    method: 'put', path: '/api/projects/:key/external-services', tag: atag, summary: 'Inhalte an externe Dienste (KI, Integrationen) erlauben oder sperren',
    access: 'admin', body: z.object({ externalServices: z.enum(['allowed', 'blocked']) }), status: 204,
  }, async ({ params, body }) => {
    const r = await db`update project set external_services = ${body.externalServices} where key = ${params.key!}`;
    if (r.count === 0) throw notFound('Projekt', params.key);
  });
  route(app, {
    method: 'get', path: '/api/projects/:key/access-log', tag: atag, summary: 'Zugriffsprotokoll (nur eingeschränkte Projekte)',
    access: { level: 'manage', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
    query: z.object({ user: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0) }),
  }, async ({ params, query }) => {
    const rows = await db<{ at: Date; username: string; action: string; objectKind: string; objectId: string | null; objectKey: string | null; path: string; total: number }[]>`
      select l.at, l.username, l.action, l.object_kind, l.object_id, l.path, count(*) over ()::int as total,
        coalesce(tc.key, tce.key) as object_key
      from access_log l join project p on p.id = l.project_id
      left join test_case tc on l.object_kind = 'testCase' and (tc.id::text = l.object_id or tc.key = l.object_id)
      left join test_execution e on l.object_kind = 'execution' and e.id::text = l.object_id
      left join test_case tce on tce.id = e.test_case_id
      where p.key = ${params.key!} ${query.user ? db`and l.username = ${query.user}` : db``}
      order by l.at desc limit ${query.limit} offset ${query.offset}`;
    return { total: rows[0]?.total ?? 0, items: rows.map(({ total: _t, ...r }) => r) };
  });
  void getUser;
}
