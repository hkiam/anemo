/**
 * E-Mail-Benachrichtigungen (ADR-0020): Ereignisse → Empfänger nach Abonnement → eine Sammelmail je Empfänger
 * und Durchlauf. Eigene Aktionen lösen keine Mail aus. Aus Projekten mit gesperrten externen Diensten wird nur ein
 * Hinweis ohne Inhalt versendet. Jede Zeile geht nur an Empfänger, die das Projekt (noch) lesen dürfen – gleiche Regel wie
 * bei der Rechteprüfung der Routen (Mitgliedschaft bzw. internes Projekt); ein Rechteentzug wirkt sofort.
 */
import type { Db } from '../../platform/db.ts';
import { type Mail, sendMail, type SmtpConfig, smtpConfig } from '../../platform/smtp.ts';
import { type DomainEvent, EventTypes, listEvents } from '../events/index.ts';
import { settingsEnv } from '../../platform/settings.ts';
import { watchNotes } from './watch.ts';
import { can, type Principal, type Role } from '../auth/index.ts';
import { goLink } from '../../platform/links.ts';

type Sender = (cfg: SmtpConfig, mail: Mail) => Promise<void>;
let sender: Sender = sendMail;
/** Nur für Tests */
export function setMailSender(s: Sender | null): void {
  sender = s ?? sendMail;
}

interface Recipient { id: string; username: string; displayName: string; email: string; isSystemAdmin: boolean }
interface Line { project: string; text: string; link: string | null }

async function execInfo(db: Db, id: string) {
  const [r] = await db<{ key: string; title: string; cycleId: string; cycleName: string; projectId: string; projectKey: string; ext: string; cycleCreator: string }[]>`
    select tc.key, v.title, c.id as cycle_id, c.name as cycle_name, p.id as project_id, p.key as project_key, p.external_services as ext, c.created_by as cycle_creator
    from test_execution e join test_cycle c on c.id = e.cycle_id join test_case tc on tc.id = e.test_case_id
    join test_case_version v on v.id = e.test_case_version_id join project p on p.id = c.project_id where e.id = ${id}`;
  return r;
}

/** Rechte je Empfänger (einmal je Versanddurchlauf geladen) */
type Principals = Map<string, Promise<Principal>>;

/**
 * Rechte eines Empfängers wie bei der Anmeldung (Mitgliedschaft direkt bzw. über Gruppen, Sichtbarkeit der Projekte);
 * geprüft wird mit `can` aus dem Modul auth. Für das Leserecht genügt irgendeine Rolle.
 */
async function principalOf(db: Db, u: Recipient): Promise<Principal> {
  const rows = await db<{ projectId: string; role: Role }[]>`
    select m.project_id, m.role from project_member m
    where (m.principal_type = 'user' and m.principal_id = ${u.id})
       or (m.principal_type = 'group' and m.principal_id in (select group_id from group_member where user_id = ${u.id}))`;
  const vis = await db<{ id: string; visibility: 'internal' | 'restricted' }[]>`select id, visibility from project`;
  return { userId: u.id, username: u.username, displayName: u.displayName, isSystemAdmin: u.isSystemAdmin, roles: new Map(rows.map((r) => [r.projectId, r.role])), visibility: new Map(vis.map((v) => [v.id, v.visibility])), permissions: new Set() };
}

async function recipientsFor(db: Db, usernames: string[], kind: string, projectId: string, principals: Principals): Promise<Recipient[]> {
  if (!usernames.length) return [];
  const rows = await db<Recipient[]>`
    select u.id, u.username, u.display_name, u.email, u.is_system_admin from app_user u join user_notification n on n.user_id = u.id and n.kind = ${kind}
    where u.active and u.email is not null and u.username = any(${usernames})`;
  const out: Recipient[] = [];
  for (const r of rows) {
    if (!principals.has(r.id)) principals.set(r.id, principalOf(db, r));
    if (can(await principals.get(r.id)!, projectId, 'read')) out.push(r);
  }
  return out;
}

export async function collectMails(db: Db, events: DomainEvent[], base: string | null): Promise<Map<string, { r: Recipient; lines: Line[] }>> {
  const out = new Map<string, { r: Recipient; lines: Line[] }>();
  const principals: Principals = new Map();
  const add = (r: Recipient, l: Line) => (out.get(r.email) ?? out.set(r.email, { r, lines: [] }).get(r.email)!).lines.push(l);
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    // Beobachter – unabhängig von den übrigen Arten; je Ereignis höchstens eine Zeile pro Person
    const told = new Set<string>();
    for (const n of await watchNotes(db, e, base)) for (const r of await recipientsFor(db, n.usernames, 'watched', n.projectId, principals)) {
      told.add(r.username);
      add(r, { project: n.project, text: n.text, link: n.link });
    }
    let kind: string | null = null;
    let who: string[] = [];
    if (e.type === EventTypes.ExecutionAssigned && p.assignee) { kind = 'assigned'; who = [String(p.assignee)]; }
    else if (e.type === EventTypes.RetestCreated && p.assignee) { kind = 'retest'; who = [String(p.assignee)]; }
    else if (e.type === EventTypes.TestFailed) kind = 'failed_own';
    else if (e.type === EventTypes.CommentAdded && Array.isArray(p.mentions) && p.mentions.length) {
      // Erwähnung in einer Diskussion (Testfall/Vorbedingung)
      const [t] = await db<{ projectId: string; projectKey: string; ext: string; key: string }[]>`select pr.id as project_id, pr.key as project_key, pr.external_services as ext, x.key
        from (select project_id, key from test_case where id = ${e.aggregateId} union all select project_id, key from precondition where id = ${e.aggregateId}) x
        join project pr on pr.id = x.project_id`;
      if (!t) continue;
      const link = base ? goLink('testfall', t.key) : null;
      const text = t.ext !== 'allowed' ? `Sie wurden in einem geschützten Projekt (${t.projectKey}) erwähnt – Details in Anemo`
        : `${e.actor} hat Sie bei ${t.key} erwähnt: „${String(p.excerpt ?? '').slice(0, 160)}“`;
      for (const r of await recipientsFor(db, (p.mentions as string[]), 'mentioned', t.projectId, principals)) if (r.username !== e.actor && !told.has(r.username)) add(r, { project: t.projectKey, text, link });
      continue;
    }
    if (!kind) continue;
    const x = await execInfo(db, e.aggregateId);
    if (!x) continue;
    if (kind === 'failed_own') who = [x.cycleCreator];
    const link = base ? goLink('ausfuehrung', e.aggregateId) : null;
    const text = x.ext !== 'allowed'
      ? `Neuigkeit in einem geschützten Projekt (${x.projectKey}) – Details in Anemo`
      : kind === 'assigned' ? `Zugewiesen: ${x.key} „${x.title}“ in „${x.cycleName}“ (von ${e.actor})`
        : kind === 'retest' ? `Nachtest fällig: ${x.key} „${x.title}“ in „${x.cycleName}“ – Fehler ${String(p.defect ?? '').replace(/^\w+:/, '')} ist erledigt`
          : `Fehlgeschlagen: ${x.key} „${x.title}“ in Ihrem Zyklus „${x.cycleName}“ (${e.actor})`;
    for (const r of await recipientsFor(db, who, kind, x.projectId, principals)) {
      if (r.username === e.actor || told.has(r.username)) continue; // eigene Aktionen nicht melden
      add(r, { project: x.projectKey, text, link });
    }
  }
  return out;
}

function compose(r: Recipient, lines: Line[], base: string | null): Mail {
  const max = 50;
  const body = [
    `Hallo ${r.displayName},`, '', `es gibt ${lines.length} Neuigkeit${lines.length === 1 ? '' : 'en'} in Anemo:`, '',
    ...lines.slice(0, max).flatMap((l) => [`• [${l.project}] ${l.text}`, ...(l.link ? [`  ${l.link}`] : [])]),
    ...(lines.length > max ? [``, `… und ${lines.length - max} weitere.`] : []),
    '', base ? `Anemo: ${base}` : '', 'Benachrichtigungen einstellen: Menü oben rechts → Benachrichtigungen.',
  ].join('\n');
  const subject = lines.length === 1 ? `Anemo: ${lines[0]!.text.slice(0, 120)}` : `Anemo: ${lines.length} Neuigkeiten`;
  return { to: [r.email], subject, text: body };
}

/** Ein Versanddurchlauf. Ist der Mailserver nicht erreichbar, bleibt der Lesezeiger stehen (Wiederholung). */
export async function dispatchMail(db: Db, now = new Date()): Promise<{ sent: number; failed: number } | null> {
  const cfg = smtpConfig();
  if (!cfg) return null;
  const [st] = await db<{ cursorSeq: string; failures: number; nextAttemptAt: Date | null }[]>`select cursor_seq, failures, next_attempt_at from mail_state where id = 1`;
  if (!st || (st.nextAttemptAt && st.nextAttemptAt > now)) return { sent: 0, failed: 0 };
  const events = await listEvents(db, { afterSeq: Number(st.cursorSeq), limit: 500 });
  if (!events.length) return { sent: 0, failed: 0 };
  const base = settingsEnv().ANEMO_PUBLIC_URL?.replace(/\/+$/, '') ?? null;
  const mails = await collectMails(db, events, base);
  let sent = 0;
  let failed = 0;
  let lastError: string | null = null;
  for (const { r, lines } of mails.values()) {
    try {
      await sender(cfg, compose(r, lines, base));
      sent++;
    } catch (e) {
      failed++;
      lastError = (e as Error).message;
    }
  }
  const last = events.at(-1)!.seq;
  if (failed && !sent) {
    const failures = st.failures + 1;
    await db`update mail_state set failures = ${failures}, last_error = ${lastError},
      next_attempt_at = ${new Date(now.getTime() + Math.min(2 ** failures * 30, 3600) * 1000)} where id = 1`;
  } else {
    await db`update mail_state set cursor_seq = ${last}, failures = 0, next_attempt_at = null, last_error = ${lastError},
      last_sent_at = case when ${sent} > 0 then now() else last_sent_at end where id = 1`;
  }
  return { sent, failed };
}

export function startMailDispatcher(db: Db, intervalMs = 60_000): () => void {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await dispatchMail(db);
    } catch (e) {
      console.error('Mail-Versand', e);
    } finally {
      running = false;
    }
  }, intervalMs);
  t.unref();
  return () => clearInterval(t);
}

export async function mailStatus(db: Db) {
  const cfg = smtpConfig();
  const [st] = await db<{ failures: number; nextAttemptAt: Date | null; lastError: string | null; lastSentAt: Date | null }[]>`
    select failures, next_attempt_at, last_error, last_sent_at from mail_state where id = 1`;
  return { configured: !!cfg, host: cfg ? `${cfg.host}:${cfg.port} (${cfg.secure})` : null, from: cfg?.from ?? null, ...st };
}
