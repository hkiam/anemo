/**
 * Konten und Kennwörter (lokale Konten): Zurücksetzen durch die Administration (Einmal-Kennwort oder vorgegeben,
 * optional Pflichtwechsel), Link zum Zurücksetzen per E-Mail (auch selbst angefordert), dauerhafte Sperre nach
 * Fehlversuchen mit Entsperren, Sitzungen einsehen und beenden, Sicherheitshinweise per Mail. Kennwörter und Tokens
 * erscheinen nie im Ereignisprotokoll; gespeichert wird nur der Hash.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../../platform/db.ts';
import { badRequest, conflict, HttpError, notFound } from '../../platform/http.ts';
import { type Mail, sendMail, type SmtpConfig, smtpConfig } from '../../platform/smtp.ts';
import { settingsEnv } from '../../platform/settings.ts';
import { EventTypes, recordEvent } from '../events/index.ts';
import { hashPassword, passwordProblem, randomPassword } from './password.ts';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

type Sender = (cfg: SmtpConfig, mail: Mail) => Promise<void>;
let sender: Sender = sendMail;
/** Nur für Tests: Mailversand ersetzen */
export function setAccountMailSender(s: Sender | null): void {
  sender = s ?? sendMail;
}

const publicUrl = () => settingsEnv().ANEMO_PUBLIC_URL?.trim().replace(/\/+$/, '') || null;
const resetMinutes = () => Math.min(24 * 60, Math.max(5, Number(settingsEnv().ANEMO_PASSWORD_RESET_MINUTES ?? 60) || 60));
export const lockAfter = () => Math.min(50, Math.max(3, Number(settingsEnv().ANEMO_LOGIN_LOCK_AFTER ?? 5) || 5));

/** „Kennwort vergessen?“ ist möglich: eingeschaltet, Mailversand und öffentliche Adresse vorhanden. */
export function selfResetAvailable(): boolean {
  return settingsEnv().ANEMO_PASSWORD_SELF_RESET !== 'false' && !!smtpConfig() && !!publicUrl();
}

interface LocalUser { id: string; username: string; displayName: string; email: string | null; source: string; active: boolean }

async function localUser(db: Db, id: string): Promise<LocalUser> {
  const [u] = await db<LocalUser[]>`select id, username, display_name, email, source, active from app_user where id = ${id}`;
  if (!u) throw notFound('Benutzer', id);
  if (u.source !== 'local') throw conflict(`Das Kennwort von „${u.username}“ wird im ${u.source === 'ldap' ? 'Verzeichnis (LDAP)' : 'Identitätsanbieter (SSO)'} verwaltet.`);
  return u;
}

/** Hinweis per Mail an die betroffene Person (ohne Kennwort); Fehler beim Versand verhindern den Vorgang nicht. */
async function notice(u: { email: string | null; displayName: string }, subject: string, lines: string[]): Promise<void> {
  const cfg = smtpConfig();
  if (!cfg || !u.email) return;
  const base = publicUrl();
  try {
    await sender(cfg, { to: [u.email], subject: `Anemo: ${subject}`, text: [`Hallo ${u.displayName},`, '', ...lines, '',
      'Waren Sie das nicht, wenden Sie sich bitte umgehend an die Administration.', ...(base ? ['', `Anemo: ${base}`] : [])].join('\n') });
  } catch (e) {
    console.error('Sicherheitshinweis per Mail', (e as Error).message);
  }
}

/**
 * Kennwort setzen (gemeinsamer Kern): Hash speichern, Pflichtwechsel setzen bzw. löschen, Sperre aufheben, offene Links
 * zum Zurücksetzen entwerten und Sitzungen beenden – außer der aktuellen Sitzung der Person selbst.
 */
export async function storePassword(db: Db, u: LocalUser, password: string, o: { mustChange: boolean; keepSession?: string | null }): Promise<void> {
  const problem = passwordProblem(password, { username: u.username });
  if (problem) throw badRequest(problem);
  await db`update app_user set password_hash = ${await hashPassword(password)}, password_changed_at = now(), must_change_password = ${o.mustChange},
    failed_logins = 0, locked_until = null where id = ${u.id}`;
  await db`delete from password_reset where user_id = ${u.id}`;
  await db`delete from user_session where user_id = ${u.id} ${o.keepSession ? db`and token_hash <> ${hashToken(o.keepSession)}` : db``}`;
}

/** Administration: Kennwort zurücksetzen – vorgegeben oder als Einmal-Kennwort (wird nur in der Antwort gezeigt). */
export async function adminResetPassword(db: Db, id: string, o: { password?: string | undefined; generate?: boolean | undefined; mustChange: boolean; revokeTokens?: boolean | undefined }, actor: string) {
  const u = await localUser(db, id);
  if (!o.generate && !o.password) throw badRequest('Kennwort angeben oder Einmal-Kennwort erzeugen lassen.');
  const password = o.generate ? randomPassword() : o.password!;
  await storePassword(db, u, password, { mustChange: o.mustChange });
  let tokens = 0;
  if (o.revokeTokens) tokens = (await db`delete from api_token where user_id = ${u.id}`).count;
  await recordEvent(db, { type: EventTypes.UserPasswordReset, aggregateType: 'User', aggregateId: u.id, actor,
    payload: { username: u.username, generated: !!o.generate, mustChange: o.mustChange, revokedTokens: tokens } });
  await notice(u, 'Ihr Kennwort wurde zurückgesetzt', [
    `die Administration (${actor}) hat das Kennwort Ihres Anemo-Kontos „${u.username}“ zurückgesetzt.`,
    o.mustChange ? 'Bei der nächsten Anmeldung legen Sie ein eigenes Kennwort fest.' : 'Das neue Kennwort erhalten Sie von der Administration.',
    'Alle bisherigen Sitzungen wurden beendet.',
  ]);
  return { password: o.generate ? password : null, mustChange: o.mustChange, revokedTokens: tokens };
}

/** Eigenes Kennwort ändern (auch beim Pflichtwechsel); die aktuelle Sitzung bleibt, alle anderen enden. */
export async function changeOwn(db: Db, id: string, current: string, next: string, currentSession: string | null, verify: (pw: string, hash: string | null) => Promise<boolean>) {
  const u = await localUser(db, id);
  const [row] = await db<{ passwordHash: string | null }[]>`select password_hash from app_user where id = ${id}`;
  if (!(await verify(current, row?.passwordHash ?? null))) throw badRequest('Das bisherige Kennwort ist falsch.');
  if (current === next) throw badRequest('Das neue Kennwort muss sich vom bisherigen unterscheiden.');
  await storePassword(db, u, next, { mustChange: false, keepSession: currentSession });
  await recordEvent(db, { type: EventTypes.UserPasswordChanged, aggregateType: 'User', aggregateId: u.id, actor: u.username, payload: { username: u.username, via: 'self' } });
  await notice(u, 'Ihr Kennwort wurde geändert', [`das Kennwort Ihres Anemo-Kontos „${u.username}“ wurde soeben geändert. Andere Sitzungen wurden beendet.`]);
}

// ---------------------------------------------------------------------------------------------
// Links zum Zurücksetzen
// ---------------------------------------------------------------------------------------------

async function sendResetLink(db: Db, u: LocalUser, createdBy: string | null): Promise<void> {
  const cfg = smtpConfig();
  const base = publicUrl();
  if (!cfg) throw conflict('Kein E-Mail-Versand eingerichtet (Benachrichtigungen → E-Mail).');
  if (!base) throw conflict('Öffentliche Adresse fehlt (ANEMO_PUBLIC_URL) – ohne sie kann kein Link erzeugt werden.');
  if (!u.email) throw conflict(`Für „${u.username}“ ist keine E-Mail-Adresse hinterlegt.`);
  const token = randomBytes(32).toString('base64url');
  const minutes = resetMinutes();
  await db`delete from password_reset where user_id = ${u.id} and used_at is null`;
  await db`insert into password_reset(token_hash, user_id, created_by, expires_at) values (${hashToken(token)}, ${u.id}, ${createdBy}, now() + make_interval(mins => ${minutes}))`;
  // Token im Fragment (#…): wird vom Browser nicht an Server oder Proxy-Protokolle übertragen
  await sender(cfg, { to: [u.email], subject: 'Anemo: Kennwort zurücksetzen', text: [
    `Hallo ${u.displayName},`, '',
    createdBy ? `die Administration (${createdBy}) hat für Ihr Anemo-Konto „${u.username}“ einen Link zum Festlegen eines neuen Kennworts angefordert.`
      : `für Ihr Anemo-Konto „${u.username}“ wurde ein neues Kennwort angefordert.`,
    '', `${base}/#/kennwort-zuruecksetzen?token=${token}`, '',
    `Der Link ist ${minutes} Minuten gültig und nur einmal verwendbar.`,
    createdBy ? '' : 'Haben Sie das nicht angefordert, können Sie diese Nachricht ignorieren – Ihr Kennwort bleibt unverändert.',
  ].join('\n') });
}

/** Administration: Link zum Zurücksetzen an die hinterlegte Adresse senden. */
export async function adminSendResetLink(db: Db, id: string, actor: string): Promise<void> {
  const u = await localUser(db, id);
  if (!u.active) throw conflict('Das Konto ist deaktiviert.');
  await sendResetLink(db, u, actor);
  await recordEvent(db, { type: EventTypes.PasswordResetRequested, aggregateType: 'User', aggregateId: u.id, actor, payload: { username: u.username, by: 'admin' } });
}

const requests = new Map<string, number[]>();
/**
 * „Kennwort vergessen?“: Benutzername oder E-Mail-Adresse. Die Antwort verrät nie, ob ein Konto existiert;
 * je Absender höchstens 5 Anfragen in 15 Minuten, je Konto höchstens ein Link alle 2 Minuten.
 */
export async function requestReset(db: Db, identifier: string, ip: string | null): Promise<void> {
  if (!selfResetAvailable()) throw new HttpError(404, 'Zurücksetzen per E-Mail ist nicht eingerichtet – bitte an die Administration wenden.');
  const key = ip ?? 'unbekannt';
  const now = Date.now();
  const recent = (requests.get(key) ?? []).filter((t) => now - t < 15 * 60_000);
  if (requests.size > 10_000) requests.clear();
  requests.set(key, [...recent, now]);
  if (recent.length >= 5) return;
  const id = identifier.trim().toLowerCase();
  if (!id) return;
  const found = await db<LocalUser[]>`select id, username, display_name, email, source, active from app_user
    where source = 'local' and active and (lower(username) = ${id} or lower(email) = ${id}) limit 2`;
  if (found.length !== 1 || !found[0]!.email) return; // unbekannt oder mehrdeutig: still
  const u = found[0]!;
  const [last] = await db<{ n: number }[]>`select count(*)::int as n from password_reset where user_id = ${u.id} and created_at > now() - interval '2 minutes'`;
  if (last!.n) return;
  try {
    await sendResetLink(db, u, null);
    await recordEvent(db, { type: EventTypes.PasswordResetRequested, aggregateType: 'User', aggregateId: u.id, actor: u.username, payload: { username: u.username, by: 'self' } });
  } catch (e) {
    console.error('Link zum Zurücksetzen', (e as Error).message);
  }
}

async function validReset(db: Db, token: string) {
  const [r] = await db<{ userId: string; username: string; displayName: string; email: string | null; source: string; active: boolean }[]>`
    select r.user_id, u.username, u.display_name, u.email, u.source, u.active from password_reset r join app_user u on u.id = r.user_id
    where r.token_hash = ${hashToken(token)} and r.used_at is null and r.expires_at > now() and u.active and u.source = 'local'`;
  return r ?? null;
}

export async function checkReset(db: Db, token: string): Promise<{ valid: boolean; username: string | null }> {
  const r = await validReset(db, token);
  return { valid: !!r, username: r?.username ?? null };
}

/** Neues Kennwort über den Link festlegen (Link wird verbraucht, alle Sitzungen enden). */
export async function confirmReset(db: Db, token: string, password: string): Promise<{ username: string }> {
  const r = await validReset(db, token);
  if (!r) throw badRequest('Der Link ist ungültig, abgelaufen oder wurde bereits verwendet – bitte neu anfordern.');
  const u: LocalUser = { id: r.userId, username: r.username, displayName: r.displayName, email: r.email, source: r.source, active: r.active };
  await storePassword(db, u, password, { mustChange: false });
  await db`update password_reset set used_at = now() where token_hash = ${hashToken(token)}`;
  await recordEvent(db, { type: EventTypes.UserPasswordChanged, aggregateType: 'User', aggregateId: u.id, actor: u.username, payload: { username: u.username, via: 'link' } });
  await notice(u, 'Ihr Kennwort wurde geändert', [`das Kennwort Ihres Anemo-Kontos „${u.username}“ wurde über einen Link zum Zurücksetzen neu festgelegt. Alle Sitzungen wurden beendet.`]);
  return { username: u.username };
}

// ---------------------------------------------------------------------------------------------
// Sperre und Sitzungen
// ---------------------------------------------------------------------------------------------

/** Fehlversuch zählen; ab der Schwelle steigt die Sperrdauer (1, 2, 4 … Minuten, höchstens 15). */
export async function registerFailure(db: Db, userId: string): Promise<void> {
  const [r] = await db<{ failedLogins: number; email: string | null; displayName: string; username: string }[]>`
    update app_user set failed_logins = failed_logins + 1 where id = ${userId} returning failed_logins, email, display_name, username`;
  if (!r) return;
  const over = r.failedLogins - lockAfter();
  if (over < 0) return;
  const minutes = Math.min(15, 2 ** over);
  await db`update app_user set locked_until = now() + make_interval(mins => ${minutes}) where id = ${userId}`;
  if (over === 0) {
    await recordEvent(db, { type: EventTypes.UserLocked, aggregateType: 'User', aggregateId: userId, actor: 'system', payload: { username: r.username, failedLogins: r.failedLogins } });
    await notice(r, 'Konto vorübergehend gesperrt', [`für Ihr Anemo-Konto „${r.username}“ gab es ${r.failedLogins} fehlgeschlagene Anmeldeversuche. Das Konto ist vorübergehend gesperrt.`]);
  }
}

export async function unlockUser(db: Db, id: string, actor: string): Promise<void> {
  const r = await db<{ username: string }[]>`update app_user set failed_logins = 0, locked_until = null where id = ${id} returning username`;
  if (!r.length) throw notFound('Benutzer', id);
  await recordEvent(db, { type: EventTypes.UserUnlocked, aggregateType: 'User', aggregateId: id, actor, payload: { username: r[0]!.username } });
}

export async function listSessions(db: Db, userId: string, current: string | null) {
  const rows = await db<{ tokenHash: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date; userAgent: string | null }[]>`
    select token_hash, created_at, last_seen_at, expires_at, user_agent from user_session where user_id = ${userId} order by last_seen_at desc`;
  const cur = current ? hashToken(current) : null;
  // Kennung nach außen: gekürzter Hash (nicht das Token, nicht der volle Hash)
  return rows.map((r) => ({ id: r.tokenHash.slice(0, 16), createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, expiresAt: r.expiresAt, userAgent: r.userAgent, current: r.tokenHash === cur }));
}

/** Sitzungen beenden: alle, alle außer der aktuellen oder eine bestimmte (Kennung aus listSessions). */
export async function endSessions(db: Db, userId: string, o: { exceptCurrent?: string | null; id?: string | undefined }, actor: string): Promise<number> {
  const r = await db`delete from user_session where user_id = ${userId}
    ${o.exceptCurrent ? db`and token_hash <> ${hashToken(o.exceptCurrent)}` : db``}
    ${o.id ? db`and left(token_hash, 16) = ${o.id}` : db``}`;
  await recordEvent(db, { type: EventTypes.UserSessionsEnded, aggregateType: 'User', aggregateId: userId, actor, payload: { count: r.count } });
  return r.count;
}
