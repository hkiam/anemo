/**
 * Modul notifications: Webhooks aus dem Ereignisprotokoll (Roadmap B6, ADR-0019).
 * Jeder Webhook hat einen eigenen Lesezeiger im Log – Zustellung mindestens einmal, in Reihenfolge, mit
 * Wiederholung (exponentiell bis 1 h, nach 8 Fehlversuchen wird das Ereignis übersprungen und protokolliert).
 * Ereignisse aus Projekten mit gesperrten externen Diensten werden nie gesendet.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { HttpError, notFound, route, visibleProjectIdsOf } from '../../platform/http.ts';
import { sendMail, smtpConfig } from '../../platform/smtp.ts';
import { principalOf } from '../auth/index.ts';
import { mailStatus } from './mail.ts';
import { type DomainEvent, EventTypes, listEvents } from '../events/index.ts';
import { settingsEnv } from '../../platform/settings.ts';
import { goLink } from '../../platform/links.ts';

export interface Webhook {
  id: string; name: string; url: string; format: 'json' | 'chat'; eventTypes: string[]; projectId: string | null; secret: string;
  active: boolean; cursorSeq: number; failures: number; nextAttemptAt: Date | null;
}

const MAX_FAILURES = 8;
const ICON: Record<string, string> = { PASS: '✅', FAIL: '❌', BLOCKED: '⛔', WIP: '🔄', NOT_EXECUTED: '⚪' };

type Fetch = typeof fetch;
let http: Fetch = fetch;
/** Nur für Tests: HTTP-Client ersetzen */
export function setWebhookFetch(f: Fetch | null): void {
  http = f ?? fetch;
}

type ProjectInfo = { id: string; key: string; name: string; externalServices: string };
/** Ereignisse ohne Projektbezug (dürfen ohne Projektprüfung zugestellt werden) */
const SYSTEM_AGGREGATES = new Set(['MigrationRun', 'Webhook']);

/**
 * Projekt eines Ereignisses – Grundlage für Projektfilter und die Sperre externer Dienste. Gelöschte Objekte werden
 * über `payload.projectId` aufgelöst; was sich nicht zuordnen lässt, gilt als gesperrt (siehe dispatchWebhooks).
 */
export async function projectOf(db: Db, e: DomainEvent): Promise<ProjectInfo | null> {
  const t = e.aggregateType;
  const id = e.aggregateId;
  const by = (sql: ReturnType<Db>) => sql as unknown as Promise<ProjectInfo[]>;
  const cols = db`p.id, p.key, p.name, p.external_services`;
  let rows: ProjectInfo[] = [];
  if (t === 'TestCase' || t === 'TEST_CASE') rows = await by(db`select ${cols} from test_case x join project p on p.id = x.project_id where x.id = ${id}`);
  else if (t === 'TestCycle' || t === 'TEST_CYCLE') rows = await by(db`select ${cols} from test_cycle x join project p on p.id = x.project_id where x.id = ${id}`);
  else if (t === 'TestExecution' || t === 'TEST_EXECUTION') rows = await by(db`select ${cols} from test_execution x join test_cycle c on c.id = x.cycle_id join project p on p.id = c.project_id where x.id = ${id}`);
  else if (t === 'TestPlan' || t === 'TEST_PLAN') rows = await by(db`select ${cols} from test_plan x join project p on p.id = x.project_id where x.id = ${id}`);
  else if (t === 'Precondition' || t === 'PRECONDITION') rows = await by(db`select ${cols} from precondition x join project p on p.id = x.project_id where x.id = ${id}`);
  else if (t === 'Folder') rows = await by(db`select ${cols} from folder x join project p on p.id = x.project_id where x.id = ${id}`);
  else if (t === 'ExploratorySession') rows = await by(db`select ${cols} from exploratory_session x join test_cycle c on c.id = x.cycle_id join project p on p.id = c.project_id where x.id = ${id}`);
  else if (t === 'Project') {
    rows = await by(db`select ${cols} from project p where p.id = ${id}`);
    const pl = e.payload as { key?: string; name?: string; externalServices?: string };
    // gelöschtes Projekt: Angaben aus dem Ereignis, ohne Angabe gilt es als gesperrt
    if (!rows.length && pl.key) return { id, key: pl.key, name: pl.name ?? pl.key, externalServices: pl.externalServices ?? 'blocked' };
  }
  if (!rows.length && typeof e.payload.projectId === 'string') rows = await by(db`select ${cols} from project p where p.id = ${e.payload.projectId}`);
  return rows[0] ?? null;
}

async function chatText(db: Db, e: DomainEvent, project: { key: string } | null, base: string | null): Promise<string> {
  const p = e.payload as Record<string, string | number | undefined>;
  let cycleName = '';
  if (p.cycleId) cycleName = (await db<{ name: string }[]>`select name from test_cycle where id = ${String(p.cycleId)}`)[0]?.name ?? '';
  const target = base && project && p.cycleId ? (e.aggregateType === 'TestExecution' ? goLink('ausfuehrung', e.aggregateId) : goLink('zyklus', String(p.cycleId))) : null;
  const link = target ? ` – ${target}` : '';
  const who = ` (${e.actor})`;
  switch (e.type) {
    case EventTypes.TestFailed: return `❌ ${p.key} fehlgeschlagen${cycleName ? ` in „${cycleName}“` : ''}${who}${link}`;
    case EventTypes.TestExecuted: return `${ICON[String(p.status)] ?? '•'} ${p.key}: ${p.previousStatus ?? '–'} → ${p.status}${cycleName ? ` in „${cycleName}“` : ''}${who}${link}`;
    case EventTypes.TestCycleCreated: return `🆕 Testzyklus „${p.name}“ angelegt${project ? ` in ${project.key}` : ''}${who}`;
    case EventTypes.ExecutionAssigned: return `👤 Ausführung zugewiesen an ${p.assignee ?? '–'}${who}`;
    case EventTypes.ReferenceLinked: return `🔗 ${p.provider} ${p.externalKey} (${p.relation}) verknüpft${who}`;
    case EventTypes.TestCaseCreated: return `📝 Testfall ${p.key ?? ''} angelegt${who}`;
    case EventTypes.CommentAdded: return `💬 ${p.key ?? ''}: „${String(p.excerpt ?? '').slice(0, 140)}“${who}${link}`;
    case EventTypes.TestCaseChanged: return `✏️ Testfall ${p.key ?? ''} geändert → v${p.toVersion ?? '?'}${p.changeNote ? `: ${p.changeNote}` : ''}${who}`;
    default: return `${e.type}${project ? ` in ${project.key}` : ''}${who}`;
  }
}

export function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function deliver(db: Db, w: Webhook, e: DomainEvent, project: Awaited<ReturnType<typeof projectOf>>): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const base = settingsEnv().ANEMO_PUBLIC_URL?.replace(/\/+$/, '') ?? null;
  const body = w.format === 'chat'
    ? JSON.stringify({ text: await chatText(db, e, project, base) })
    : JSON.stringify({ event: e, project: project ? { key: project.key, name: project.name } : null });
  try {
    const res = await http(w.url, {
      method: 'POST', body, signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'user-agent': 'Anemo-Webhook/1', 'x-anemo-event': e.type, 'x-anemo-delivery': `${w.id}:${e.seq}`, 'x-anemo-signature': sign(w.secret, body) },
    });
    // Antworttext der Gegenstelle weder speichern noch anzeigen (Webhook-Ziel ist frei wählbar → kein Lesen interner Dienste)
    await res.body?.cancel().catch(() => {});
    return { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, error: (err as Error).message };
  }
}

/** Ein Durchlauf: für jeden fälligen Webhook die nächsten Ereignisse zustellen. */
export async function dispatchWebhooks(db: Db, now = new Date()): Promise<number> {
  const hooks = await db<Webhook[]>`select * from webhook where active and (next_attempt_at is null or next_attempt_at <= ${now})`;
  let sent = 0;
  for (const w of hooks) {
    const events = await listEvents(db, { afterSeq: Number(w.cursorSeq), limit: 100 });
    for (const e of events) {
      const project = await projectOf(db, e);
      const wanted = (!w.eventTypes.length || w.eventTypes.includes(e.type)) && (!w.projectId || project?.id === w.projectId)
        && (project ? project.externalServices === 'allowed' : SYSTEM_AGGREGATES.has(e.aggregateType));
      if (!wanted) {
        await db`update webhook set cursor_seq = ${e.seq} where id = ${w.id}`;
        continue;
      }
      const r = await deliver(db, w, e, project);
      const failures = r.ok ? 0 : w.failures + 1;
      const skip = !r.ok && failures >= MAX_FAILURES;
      await db`insert into webhook_delivery(webhook_id, event_seq, event_type, ok, status, error)
               values (${w.id}, ${e.seq}, ${e.type}, ${r.ok}, ${r.status}, ${skip ? `übersprungen nach ${failures} Versuchen: ${r.error}` : r.error})`;
      if (r.ok || skip) {
        await db`update webhook set cursor_seq = ${e.seq}, failures = 0, next_attempt_at = null where id = ${w.id}`;
        w.failures = 0;
        if (r.ok) sent++;
        continue;
      }
      const wait = Math.min(2 ** failures * 10, 3600);
      await db`update webhook set failures = ${failures}, next_attempt_at = ${new Date(now.getTime() + wait * 1000)} where id = ${w.id}`;
      break; // Reihenfolge wahren: dieser Webhook wartet
    }
    // Protokoll begrenzen
    await db`delete from webhook_delivery where webhook_id = ${w.id} and id < (select min(id) from (select id from webhook_delivery where webhook_id = ${w.id} order by id desc limit 200) x)`;
  }
  return sent;
}

export function startWebhookDispatcher(db: Db, intervalMs = 3000): () => void {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await dispatchWebhooks(db);
    } catch (e) {
      console.error('Webhook-Zustellung', e);
    } finally {
      running = false;
    }
  }, intervalMs);
  t.unref();
  return () => clearInterval(t);
}

const Body = z.object({
  name: z.string().trim().min(1).max(120), url: z.url().regex(/^https?:\/\//), format: z.enum(['json', 'chat']),
  eventTypes: z.array(z.enum(Object.values(EventTypes) as [string, ...string[]])).max(30), projectKey: z.string().nullable(), active: z.boolean(),
});

export { dispatchMail, setMailSender, startMailDispatcher } from './mail.ts';

const KINDS = ['assigned', 'retest', 'failed_own', 'mentioned', 'watched'] as const;
const WATCH_TYPES = ['TEST_CASE', 'TEST_CYCLE', 'TEST_PLAN'] as const;

export function notificationRoutes(app: Hono, db: Db): void {
  const tag = 'Benachrichtigungen';
  // ---- eigene E-Mail-Benachrichtigungen ----
  route(app, { method: 'get', path: '/api/auth/notifications', tag, summary: 'Eigene E-Mail-Benachrichtigungen' }, async ({ c }) => {
    const p = principalOf(c)!;
    if (!p.userId) return { email: null, kinds: [], mailConfigured: !!smtpConfig() };
    const [u] = await db<{ email: string | null }[]>`select email from app_user where id = ${p.userId}`;
    const kinds = (await db<{ kind: string }[]>`select kind from user_notification where user_id = ${p.userId}`).map((r) => r.kind);
    return { email: u?.email ?? null, kinds, mailConfigured: !!smtpConfig() };
  });
  route(app, {
    method: 'put', path: '/api/auth/notifications', tag, summary: 'Eigene E-Mail-Adresse und Benachrichtigungen festlegen', status: 204,
    body: z.object({ email: z.email().nullable(), kinds: z.array(z.enum(KINDS)) }),
  }, async ({ c, body }) => {
    const p = principalOf(c)!;
    if (!p.userId) throw new HttpError(400, 'Im Modus ohne Anmeldung nicht möglich.');
    await db`update app_user set email = ${body.email} where id = ${p.userId}`;
    await db`delete from user_notification where user_id = ${p.userId}`;
    for (const k of new Set(body.kinds)) await db`insert into user_notification(user_id, kind) values (${p.userId}, ${k})`;
  });
  // ---- Beobachten ----
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const watchAccess = ({ params }: { params: Record<string, string> }) => {
    if (!(WATCH_TYPES as readonly string[]).includes(params.type!) || !UUID.test(params.id!)) throw new HttpError(400, 'Unbekannte Objektart oder ungültige ID');
    return watchLevel(params);
  };
  const watchLevel = (params: Record<string, string>) => ({
    level: 'read' as const,
    project: () => (params.type === 'TEST_CASE' ? { kind: 'testCase' as const, id: params.id! } : params.type === 'TEST_CYCLE' ? { kind: 'cycle' as const, id: params.id! } : { kind: 'plan' as const, id: params.id! }),
  });
  route(app, { method: 'get', path: '/api/watch', tag, summary: 'Was ich beobachte (mit Bezeichnung und Projekt; nur Projekte, die ich lesen darf)' }, async ({ actor, c }) => {
    const visible = visibleProjectIdsOf(c);
    return db`
      select w.object_type, w.object_id, w.created_at, coalesce(tc.key || ' ' || v.title, c.name, pl.name) as label, pr.key as project_key
      from watch w
      left join test_case tc on w.object_type = 'TEST_CASE' and tc.id = w.object_id
      left join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
      left join test_cycle c on w.object_type = 'TEST_CYCLE' and c.id = w.object_id
      left join test_plan pl on w.object_type = 'TEST_PLAN' and pl.id = w.object_id
      join project pr on pr.id = coalesce(tc.project_id, c.project_id, pl.project_id)
      where w.username = ${actor} ${visible ? db`and pr.id = any(${visible}::uuid[])` : db``} order by w.created_at desc`;
  });
  route(app, { method: 'get', path: '/api/watch/:type/:id', tag, summary: 'Beobachte ich das Objekt? Anzahl der Beobachter', access: watchAccess,}, async ({ params, actor }) => {
    const [r] = await db<{ watching: boolean; watchers: number }[]>`select bool_or(username = ${actor}) as watching, count(*)::int as watchers from watch where object_type = ${params.type!} and object_id = ${params.id!}`;
    return { watching: !!r?.watching, watchers: r?.watchers ?? 0 };
  });
  route(app, { method: 'put', path: '/api/watch/:type/:id', tag, summary: 'Objekt beobachten', access: watchAccess, status: 204,}, async ({ params, actor }) => {
    await db`insert into watch(username, object_type, object_id) values (${actor}, ${params.type!}, ${params.id!}) on conflict do nothing`;
  });
  route(app, { method: 'delete', path: '/api/watch/:type/:id', tag, summary: 'Beobachten beenden', access: watchAccess, status: 204,}, async ({ params, actor }) => {
    await db`delete from watch where username = ${actor} and object_type = ${params.type!} and object_id = ${params.id!}`;
  });
  route(app, { method: 'get', path: '/api/admin/mail', tag, summary: 'Status des Mail-Versands', access: 'admin' }, () => mailStatus(db));
  route(app, {
    method: 'post', path: '/api/admin/mail/test', tag, summary: 'Testmail senden', access: 'admin', body: z.object({ to: z.email() }),
  }, async ({ body }) => {
    const cfg = smtpConfig();
    if (!cfg) throw new HttpError(409, 'SMTP ist nicht eingerichtet (SMTP_HOST, SMTP_FROM)');
    try {
      await sendMail(cfg, { to: [body.to], subject: 'Anemo: Testmail', text: 'Diese Testmail bestätigt, dass Anemo E-Mails versenden kann.' });
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  const projectId = async (key: string | null) => {
    if (!key) return null;
    const [p] = await db<{ id: string }[]>`select id from project where key = ${key}`;
    if (!p) throw notFound('Projekt', key);
    return p.id;
  };
  route(app, { method: 'get', path: '/api/admin/webhooks', tag, summary: 'Webhooks mit letzten Zustellungen', access: 'admin' }, async () => {
    const hooks = await db<(Omit<Webhook, 'secret'> & { projectKey: string | null })[]>`
      select w.id, w.name, w.url, w.format, w.event_types, w.project_id, p.key as project_key, w.active, w.cursor_seq, w.failures, w.next_attempt_at
      from webhook w left join project p on p.id = w.project_id order by w.created_at`;
    const deliveries = await db<{ webhookId: string; eventSeq: number; eventType: string; ok: boolean; status: number | null; error: string | null; at: Date }[]>`
      select webhook_id, event_seq, event_type, ok, status, error, at from (
        select d.*, row_number() over (partition by webhook_id order by id desc) rn from webhook_delivery d) x where rn <= 10 order by id desc`;
    return { eventTypes: Object.values(EventTypes), webhooks: hooks.map((h) => ({ ...h, deliveries: deliveries.filter((d) => d.webhookId === h.id) })) };
  });
  route(app, { method: 'post', path: '/api/admin/webhooks', tag, summary: 'Webhook anlegen (Geheimnis wird einmal angezeigt)', access: 'admin', body: Body, status: 201 }, async ({ body, actor }) => {
    const secret = randomBytes(24).toString('base64url');
    // ab jetzt: ältere Ereignisse werden nicht nachgeliefert
    const [w] = await db<{ id: string }[]>`
      insert into webhook(name, url, format, event_types, project_id, secret, active, cursor_seq, created_by)
      values (${body.name}, ${body.url}, ${body.format}, ${body.eventTypes}, ${await projectId(body.projectKey)}, ${secret}, ${body.active},
              (select coalesce(max(seq), 0) from domain_event), ${actor}) returning id`;
    return { id: w!.id, secret };
  });
  route(app, { method: 'put', path: '/api/admin/webhooks/:id', tag, summary: 'Webhook ändern', access: 'admin', body: Body, status: 204 }, async ({ params, body }) => {
    const r = await db`update webhook set name = ${body.name}, url = ${body.url}, format = ${body.format}, event_types = ${body.eventTypes},
      project_id = ${await projectId(body.projectKey)}, active = ${body.active}, failures = 0, next_attempt_at = null where id = ${params.id!}`;
    if (r.count === 0) throw notFound('Webhook', params.id);
  });
  route(app, { method: 'delete', path: '/api/admin/webhooks/:id', tag, summary: 'Webhook löschen', access: 'admin', status: 204 }, async ({ params }) => {
    const r = await db`delete from webhook where id = ${params.id!}`;
    if (r.count === 0) throw notFound('Webhook', params.id);
  });
  route(app, { method: 'post', path: '/api/admin/webhooks/:id/test', tag, summary: 'Testnachricht senden', access: 'admin' }, async ({ params, actor }) => {
    const [w] = await db<Webhook[]>`select * from webhook where id = ${params.id!}`;
    if (!w) throw notFound('Webhook', params.id);
    const ping: DomainEvent = { seq: 0, id: '00000000-0000-0000-0000-000000000000', type: 'Ping', aggregateType: 'Webhook', aggregateId: w.id, payload: { message: 'Testnachricht von Anemo' }, actor, occurredAt: new Date() };
    // nur Erfolg und HTTP-Status – den Antworttext der Gegenstelle nicht zurückgeben (sonst SSRF mit Lesezugriff)
    const r = await deliver(db, w, ping, null);
    return { ok: r.ok, status: r.status, error: r.ok ? null : r.status ? `Gegenstelle antwortete mit HTTP ${r.status}` : 'Gegenstelle nicht erreichbar' };
  });
}
