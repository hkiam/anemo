import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Db } from '../../platform/db.ts';
import { badRequest, conflict, HttpError, notFound } from '../../platform/http.ts';
import type { Permission, Role } from './access.ts';
import { ldapAuthenticate, ldapConfig, provision } from './directory.ts';
import { hashPassword, passwordProblem, randomPassword, verifyPassword } from './password.ts';
import { adminResetPassword, changeOwn, registerFailure } from './accounts.ts';
import { settingsEnv } from '../../platform/settings.ts';
import { EventTypes, recordEvent } from '../events/index.ts';

export interface User {
  id: string; username: string; displayName: string; email: string | null; source: string;
  active: boolean; isSystemAdmin: boolean; isAgent?: boolean; createdAt: Date; lastLoginAt: Date | null;
  mustChangePassword?: boolean; passwordChangedAt?: Date | null; failedLogins?: number; lockedUntil?: Date | null;
}

const SESSION_DAYS = 7;
const IDLE_HOURS = 12;
const USER_COLUMNS = (db: Db) => db`id, username, display_name, email, source, active, is_system_admin, is_agent, created_at, last_login_at,
  must_change_password, password_changed_at, failed_logins, locked_until`;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

// ---- Benutzer ----

export async function listUsers(db: Db): Promise<(User & { groups: string[] })[]> {
  return db<(User & { groups: string[] })[]>`
    select ${USER_COLUMNS(db)}, coalesce((select array_agg(g.name order by g.name) from group_member gm join user_group g on g.id = gm.group_id where gm.user_id = u.id), '{}') as groups
    from app_user u order by lower(username)`;
}

export async function getUser(db: Db, id: string): Promise<User> {
  const [u] = await db<User[]>`select ${USER_COLUMNS(db)} from app_user where id = ${id}`;
  if (!u) throw notFound('Benutzer', id);
  return u;
}

export async function createUser(db: Db, u: { username: string; displayName: string; email?: string | null; password: string; isSystemAdmin?: boolean; isAgent?: boolean; mustChangePassword?: boolean }): Promise<User> {
  if (!/^[a-zA-Z0-9._@-]{2,64}$/.test(u.username)) throw badRequest('Benutzername: 2–64 Zeichen, Buchstaben, Ziffern, . _ - @');
  const problem = passwordProblem(u.password, { username: u.username });
  if (problem) throw badRequest(problem);
  const [exists] = await db`select 1 from app_user where lower(username) = lower(${u.username})`;
  if (exists) throw conflict(`Benutzer „${u.username}“ existiert bereits`);
  const [row] = await db<User[]>`
    insert into app_user(username, display_name, email, password_hash, is_system_admin, is_agent, must_change_password, password_changed_at)
    values (${u.username}, ${u.displayName}, ${u.email ?? null}, ${await hashPassword(u.password)}, ${u.isSystemAdmin ?? false}, ${u.isAgent ?? false},
      ${u.mustChangePassword ?? false}, now())
    returning ${USER_COLUMNS(db)}`;
  // Voreinstellung: Mail bei Zuweisung und fälligem Nachtest (wirksam, sobald eine E-Mail-Adresse hinterlegt ist)
  await db`insert into user_notification(user_id, kind) values (${row!.id}, 'assigned'), (${row!.id}, 'retest'), (${row!.id}, 'mentioned'), (${row!.id}, 'watched') on conflict do nothing`;
  return row!;
}

export async function updateUser(db: Db, id: string, u: { displayName?: string; email?: string | null; active?: boolean; isSystemAdmin?: boolean; isAgent?: boolean }, actorId: string | null): Promise<User> {
  const cur = await getUser(db, id);
  if (actorId === id && (u.active === false || u.isSystemAdmin === false)) throw badRequest('Eigenes Konto kann nicht deaktiviert bzw. die eigenen Adminrechte nicht entzogen werden.');
  if (cur.isSystemAdmin && (u.isSystemAdmin === false || u.active === false)) await ensureAnotherAdmin(db, id);
  const [row] = await db<User[]>`
    update app_user set display_name = ${u.displayName ?? cur.displayName}, email = ${u.email === undefined ? cur.email : u.email},
      active = ${u.active ?? cur.active}, is_system_admin = ${u.isSystemAdmin ?? cur.isSystemAdmin}, is_agent = ${u.isAgent ?? cur.isAgent ?? false}
    where id = ${id} returning ${USER_COLUMNS(db)}`;
  if (u.active === false) await db`delete from user_session where user_id = ${id}`;
  return row!;
}

async function ensureAnotherAdmin(db: Db, exceptId: string) {
  const [r] = await db<{ n: number }[]>`select count(*)::int as n from app_user where is_system_admin and active and id <> ${exceptId}`;
  if (!r!.n) throw badRequest('Es muss mindestens ein aktiver Systemadministrator bleiben.');
}

/** Kennwort durch die Administration setzen (ältere Schnittstelle; ohne Pflichtwechsel). */
export async function setPassword(db: Db, id: string, password: string, actor = 'system'): Promise<void> {
  await adminResetPassword(db, id, { password, mustChange: false }, actor);
}

/** Eigenes Kennwort ändern; die laufende Sitzung bleibt bestehen, andere enden. */
export async function changeOwnPassword(db: Db, id: string, current: string, next: string, currentSession: string | null = null): Promise<void> {
  await changeOwn(db, id, current, next, currentSession, verifyPassword);
}

// ---- Gruppen ----

export async function listGroups(db: Db) {
  return db<{ id: string; name: string; description: string | null; members: { id: string; username: string; displayName: string }[] }[]>`
    select g.id, g.name, g.description,
      coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'displayName', u.display_name) order by lower(u.username))
                from group_member gm join app_user u on u.id = gm.user_id where gm.group_id = g.id), '[]') as members
    from user_group g order by lower(g.name)`;
}

export async function createGroup(db: Db, name: string, description: string | null) {
  const [exists] = await db`select 1 from user_group where lower(name) = lower(${name})`;
  if (exists) throw conflict(`Gruppe „${name}“ existiert bereits`);
  const [g] = await db<{ id: string }[]>`insert into user_group(name, description) values (${name}, ${description}) returning id`;
  return g!;
}

export async function updateGroup(db: Db, id: string, g: { name?: string; description?: string | null; memberIds?: string[] }) {
  const r = await db`update user_group set name = coalesce(${g.name ?? null}, name), description = ${g.description ?? null} where id = ${id}`;
  if (r.count === 0) throw notFound('Gruppe', id);
  if (g.memberIds) {
    await db`delete from group_member where group_id = ${id}`;
    for (const uid of new Set(g.memberIds)) await db`insert into group_member(group_id, user_id) values (${id}, ${uid}) on conflict do nothing`;
  }
}

export async function deleteGroup(db: Db, id: string) {
  await db`delete from project_member where principal_type = 'group' and principal_id = ${id}`;
  await db`delete from global_permission where principal_type = 'group' and principal_id = ${id}`;
  const r = await db`delete from user_group where id = ${id}`;
  if (r.count === 0) throw notFound('Gruppe', id);
}

// ---- instanzweite Rechte (ADR-0027) ----

export async function listPermissionGrants(db: Db) {
  return db<{ principalType: 'user' | 'group'; principalId: string; name: string; permission: Permission; grantedBy: string; grantedAt: Date }[]>`
    select g.principal_type, g.principal_id, coalesce(u.display_name || ' (' || u.username || ')', ug.name) as name, g.permission, g.granted_by, g.granted_at
    from global_permission g
    left join app_user u on g.principal_type = 'user' and u.id = g.principal_id
    left join user_group ug on g.principal_type = 'group' and ug.id = g.principal_id
    order by g.permission, g.principal_type desc, name`;
}

export async function setPermission(db: Db, g: { principalType: 'user' | 'group'; principalId: string; permission: Permission; granted: boolean }, actor: string) {
  const [target] = g.principalType === 'user'
    ? await db<{ name: string }[]>`select username as name from app_user where id = ${g.principalId}`
    : await db<{ name: string }[]>`select name from user_group where id = ${g.principalId}`;
  if (!target) throw notFound(g.principalType === 'user' ? 'Benutzer' : 'Gruppe', g.principalId);
  const r = g.granted
    ? await db`insert into global_permission(principal_type, principal_id, permission, granted_by) values (${g.principalType}, ${g.principalId}, ${g.permission}, ${actor}) on conflict do nothing`
    : await db`delete from global_permission where principal_type = ${g.principalType} and principal_id = ${g.principalId} and permission = ${g.permission}`;
  if (r.count > 0) {
    await recordEvent(db, { type: EventTypes.PermissionChanged, aggregateType: g.principalType === 'user' ? 'User' : 'Group', aggregateId: g.principalId, actor,
      payload: { permission: g.permission, granted: g.granted, principal: target.name } });
  }
}

// ---- Projektmitglieder und Sichtbarkeit ----

export async function listProjectMembers(db: Db, projectId: string) {
  return db<{ principalType: 'user' | 'group'; principalId: string; name: string; role: Role }[]>`
    select m.principal_type, m.principal_id, coalesce(u.display_name || ' (' || u.username || ')', g.name) as name, m.role
    from project_member m
    left join app_user u on m.principal_type = 'user' and u.id = m.principal_id
    left join user_group g on m.principal_type = 'group' and g.id = m.principal_id
    where m.project_id = ${projectId} order by m.principal_type desc, name`;
}

export async function setProjectMember(db: Db, projectId: string, principalType: 'user' | 'group', principalId: string, role: Role | null) {
  if (role === null) {
    await db`delete from project_member where project_id = ${projectId} and principal_type = ${principalType} and principal_id = ${principalId}`;
    return;
  }
  await db`insert into project_member(project_id, principal_type, principal_id, role) values (${projectId}, ${principalType}, ${principalId}, ${role})
           on conflict (project_id, principal_type, principal_id) do update set role = excluded.role`;
}

export async function setProjectVisibility(db: Db, projectId: string, visibility: 'internal' | 'restricted') {
  // Wird ein Projekt eingeschränkt, sind externe Dienste zunächst gesperrt (bewusst wieder freigeben)
  await db`update project set visibility = ${visibility},
             external_services = case when ${visibility} = 'restricted' then 'blocked' else external_services end
           where id = ${projectId}`;
}

// ---- Anmeldung und Sitzungen ----

const failures = new Map<string, { count: number; until: number }>();
/** Fehlversuche je Absender (gegen Durchprobieren vieler Konten): max. 30 in 15 Minuten. */
const ipFailures = new Map<string, { count: number; since: number }>();
const IP_WINDOW = 15 * 60_000;
const IP_MAX = 30;
const bounded = <K, V>(m: Map<K, V>) => { if (m.size > 10_000) m.clear(); };

/** Sitzung für einen angemeldeten Benutzer anlegen. */
export async function createSession(db: Db, user: User, userAgent: string | null, idToken: string | null = null): Promise<{ token: string; user: User; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db`insert into user_session(token_hash, user_id, expires_at, user_agent, id_token) values (${hashToken(token)}, ${user.id}, ${expiresAt}, ${userAgent}, ${idToken})`;
  await db`update app_user set last_login_at = now() where id = ${user.id}`;
  return { token, user, expiresAt };
}

/**
 * Prüft Benutzername/Kennwort mit Schutz gegen Durchprobieren (Sperre steigt mit Fehlversuchen).
 * Lokale Konten prüft Anemo selbst; ist LDAP eingerichtet, werden alle übrigen Namen gegen das Verzeichnis geprüft.
 */
export async function login(db: Db, username: string, password: string, userAgent: string | null, ip: string | null = null): Promise<{ token: string; user: User; expiresAt: Date }> {
  const key = username.toLowerCase();
  // Bremse je Name nur für Namen ohne lokales Konto; lokale Konten haben die dauerhafte Sperre (app_user.locked_until)
  const [known] = await db<{ source: string }[]>`select source from app_user where lower(username) = ${key}`;
  const f = known?.source === 'local' ? undefined : failures.get(key);
  if (f && f.until > Date.now()) throw new HttpError(429, `Zu viele Fehlversuche – bitte in ${Math.ceil((f.until - Date.now()) / 1000)} s erneut versuchen.`);
  const fromIp = ip ? ipFailures.get(ip) : undefined;
  if (fromIp && fromIp.count >= IP_MAX && Date.now() - fromIp.since < IP_WINDOW) {
    throw new HttpError(429, 'Zu viele Fehlversuche von dieser Adresse – bitte später erneut versuchen.');
  }
  const fail = () => {
    const count = (f?.count ?? 0) + 1;
    bounded(failures);
    if (known?.source !== 'local') failures.set(key, { count, until: count >= 5 ? Date.now() + Math.min(2 ** (count - 5), 300) * 1000 : 0 });
    if (ip) {
      bounded(ipFailures);
      const cur = ipFailures.get(ip);
      ipFailures.set(ip, cur && Date.now() - cur.since < IP_WINDOW ? { count: cur.count + 1, since: cur.since } : { count: 1, since: Date.now() });
    }
    return new HttpError(401, 'Benutzername oder Kennwort falsch.');
  };
  const [u] = await db<(User & { passwordHash: string | null })[]>`
    select ${USER_COLUMNS(db)}, password_hash from app_user where lower(username) = ${key}`;
  // dauerhafte Sperre (übersteht Neustarts, für die Administration sichtbar und aufhebbar)
  if (u?.source === 'local' && u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now()) {
    throw new HttpError(429, `Zu viele Fehlversuche – das Konto ist bis ${new Date(u.lockedUntil).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })} Uhr gesperrt. Die Administration kann es entsperren.`);
  }
  const ldap = ldapConfig();
  if (ldap && (!u || u.source === 'ldap')) {
    let identity;
    try {
      identity = await ldapAuthenticate(ldap, username, password);
    } catch (e) {
      throw new HttpError(503, `Verzeichnisdienst nicht erreichbar: ${(e as Error).message}`);
    }
    if (!identity) throw fail();
    failures.delete(key);
    return createSession(db, await provision(db, identity), userAgent);
  }
  // Auch bei unbekanntem Benutzer hashen, damit die Antwortzeit nichts verrät
  const ok = await verifyPassword(password, u?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!u || !ok || !u.active) {
    if (u && u.source === 'local' && !ok) await registerFailure(db, u.id);
    throw fail();
  }
  failures.delete(key);
  if (u.failedLogins || u.lockedUntil) await db`update app_user set failed_logins = 0, locked_until = null where id = ${u.id}`;
  const { passwordHash: _p, ...user } = u;
  return createSession(db, user, userAgent);
}

/** Sitzung auflösen; Leerlauf über 12 h oder Ablauf beendet die Sitzung. */
export async function sessionUser(db: Db, token: string): Promise<User | null> {
  const [u] = await db<User[]>`
    update user_session s set last_seen_at = now()
    from app_user u
    where s.token_hash = ${hashToken(token)} and u.id = s.user_id and u.active
      and s.expires_at > now() and s.last_seen_at > now() - make_interval(hours => ${IDLE_HOURS})
    returning u.id, u.username, u.display_name, u.email, u.source, u.active, u.is_system_admin, u.is_agent, u.created_at, u.last_login_at, u.must_change_password`;
  return u ?? null;
}

/** Sitzung beenden; liefert das ID-Token einer OIDC-Sitzung (für die Abmeldung beim Anbieter). */
export async function logout(db: Db, token: string): Promise<string | null> {
  const [s] = await db<{ idToken: string | null }[]>`delete from user_session where token_hash = ${hashToken(token)} returning id_token`;
  return s?.idToken ?? null;
}

export async function cleanupSessions(db: Db) {
  await db`delete from user_session where expires_at < now() or last_seen_at < now() - make_interval(hours => ${IDLE_HOURS})`;
  // Aufbewahrung des Zugriffsprotokolls (Standard 2 Jahre)
  const days = Number(settingsEnv().ANEMO_ACCESS_LOG_DAYS ?? 730);
  await db`delete from access_log where at < now() - make_interval(days => ${days})`;
}

/**
 * Erstinstallation: Gibt es noch keinen Benutzer, wird "admin" mit Zufallskennwort angelegt. Das Kennwort
 * steht ausschließlich in einer Datei (nur für den Eigentümer lesbar) und wird nie protokolliert.
 */
export async function bootstrapAdmin(db: Db, passwordFile: string, log: (m: string) => void): Promise<void> {
  const [r] = await db<{ n: number }[]>`select count(*)::int as n from app_user`;
  if (r!.n > 0) return;
  const password = process.env.ANEMO_ADMIN_PASSWORD || randomPassword();
  await createUser(db, { username: 'admin', displayName: 'Administrator', password, isSystemAdmin: true });
  if (!process.env.ANEMO_ADMIN_PASSWORD) {
    await mkdir(dirname(passwordFile), { recursive: true });
    await writeFile(passwordFile, `Benutzer: admin\nKennwort: ${password}\n\nBitte nach der ersten Anmeldung ändern und diese Datei löschen.\n`, { mode: 0o600 });
    log(`Erstinstallation: Benutzer "admin" angelegt – Kennwort in ${passwordFile}`);
  } else {
    log('Erstinstallation: Benutzer "admin" mit Kennwort aus ANEMO_ADMIN_PASSWORD angelegt');
  }
}

// ---- API-Tokens (CI, Skripte, Agenten) ----

export async function createApiToken(db: Db, userId: string, name: string, expiresDays: number | null) {
  const token = `anemo_${randomBytes(32).toString('base64url')}`;
  const expiresAt = expiresDays ? new Date(Date.now() + expiresDays * 86400_000) : null;
  const [row] = await db<{ id: string; createdAt: Date }[]>`
    insert into api_token(user_id, name, token_hash, prefix, expires_at)
    values (${userId}, ${name}, ${hashToken(token)}, ${token.slice(0, 12)}, ${expiresAt}) returning id, created_at`;
  return { id: row!.id, name, token, prefix: token.slice(0, 12), createdAt: row!.createdAt, expiresAt };
}

export async function listApiTokens(db: Db, userId: string) {
  return db<{ id: string; name: string; prefix: string; createdAt: Date; expiresAt: Date | null; lastUsedAt: Date | null }[]>`
    select id, name, prefix, created_at, expires_at, last_used_at from api_token where user_id = ${userId} order by created_at desc`;
}

export async function deleteApiToken(db: Db, userId: string, id: string) {
  const r = await db`delete from api_token where id = ${id} and user_id = ${userId}`;
  if (r.count === 0) throw notFound('API-Token', id);
}

/** Benutzer eines gültigen Tokens (aktives Konto, nicht abgelaufen); „zuletzt verwendet“ höchstens minütlich. */
export async function tokenUser(db: Db, token: string): Promise<User | null> {
  const [u] = await db<User[]>`
    update api_token t set last_used_at = case when t.last_used_at is null or t.last_used_at < now() - interval '1 minute' then now() else t.last_used_at end
    from app_user u
    where t.token_hash = ${hashToken(token)} and u.id = t.user_id and u.active and (t.expires_at is null or t.expires_at > now())
    returning u.id, u.username, u.display_name, u.email, u.source, u.active, u.is_system_admin, u.is_agent, u.created_at, u.last_login_at`;
  return u ?? null;
}
