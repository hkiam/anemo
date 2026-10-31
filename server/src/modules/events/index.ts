/**
 * Modul events: Domain-Event-Log als Outbox und Audit-Trail (ADR-0007).
 *
 * Producer schreiben Events in derselben Transaktion wie die Fachänderung ({@link recordEvent}).
 * Konsumenten im Prozess abonnieren mit {@link subscribe}; ein Relay liest das Log nach dem Commit
 * per Sequenznummer und ruft die Abonnenten auf. Externe Konsumenten lesen über GET /api/events.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { writeCsv } from '../../platform/csv.ts';
import { notFound, route } from '../../platform/http.ts';
import { eventLabel } from '../../../../shared/events/labels.ts';

export const EventTypes = {
  TestCaseCreated: 'TestCaseCreated',
  TestCaseChanged: 'TestCaseChanged',
  TestCaseMetaChanged: 'TestCaseMetaChanged',
  TestCycleCreated: 'TestCycleCreated',
  TestAddedToCycle: 'TestAddedToCycle',
  TestExecuted: 'TestExecuted',
  ExecutionAssigned: 'ExecutionAssigned',
  TestFailed: 'TestFailed',
  ReferenceLinked: 'ReferenceLinked',
  ReferenceRemoved: 'ReferenceRemoved',
  MigrationCompleted: 'MigrationCompleted',
  RetestCreated: 'RetestCreated',
  ResultReviewed: 'ResultReviewed',
  SessionCompleted: 'SessionCompleted',
  ReleaseDecided: 'ReleaseDecided',
  AssessmentChanged: 'AssessmentChanged',
  // Stufe H: Pflege großer Bestände
  ExecutionUpdated: 'ExecutionUpdated',
  ExecutionRemoved: 'ExecutionRemoved',
  TestCaseArchived: 'TestCaseArchived',
  TestCaseRestored: 'TestCaseRestored',
  TestCaseDeleted: 'TestCaseDeleted',
  TestCycleArchived: 'TestCycleArchived',
  TestCycleDeleted: 'TestCycleDeleted',
  FolderChanged: 'FolderChanged',
  AttachmentDeleted: 'AttachmentDeleted',
  ProjectDeleted: 'ProjectDeleted',
  CommentAdded: 'CommentAdded',
  // Konten und Kennwörter (ohne Kennwörter/Tokens in der Nutzlast)
  UserPasswordReset: 'UserPasswordReset',
  UserPasswordChanged: 'UserPasswordChanged',
  PasswordResetRequested: 'PasswordResetRequested',
  UserLocked: 'UserLocked',
  UserUnlocked: 'UserUnlocked',
  UserSessionsEnded: 'UserSessionsEnded',
  // Stufe K: instanzweite Rechte und Projektübertragung (ADR-0027)
  PermissionChanged: 'PermissionChanged',
  ProjectExportRequested: 'ProjectExportRequested',
  ProjectExportDecided: 'ProjectExportDecided',
  ProjectExported: 'ProjectExported',
  ProjectImported: 'ProjectImported',
  // Stufe J1: Pfeil-Trennschritte im Bestand zu Abschnitten umgestellt (bzw. zurückgenommen)
  StepsGrouped: 'StepsGrouped',
  // Review 30.10.2026: lückenloser Audit-Trail prozessrelevanter Änderungen (je Feld alter und neuer Wert)
  PlanChanged: 'PlanChanged',
  PlanArchived: 'PlanArchived',
  PlanRestored: 'PlanRestored',
  ExitCriteriaChanged: 'ExitCriteriaChanged',
  CycleChanged: 'CycleChanged',
  CycleStateChanged: 'CycleStateChanged',
  ProjectRulesChanged: 'ProjectRulesChanged',
  StatusCatalogChanged: 'StatusCatalogChanged',
  ReleaseBaselineCreated: 'ReleaseBaselineCreated',
  /** Fehler behoben, aber kein offener Zyklus mit gleicher Konfiguration für den Nachtest */
  RetestMissing: 'RetestMissing',
} as const;
export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

export interface DomainEvent {
  seq: number;
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  actor: string;
  occurredAt: Date;
}

/** Muss innerhalb der fachlichen Transaktion aufgerufen werden. */
export async function recordEvent(
  db: Db,
  e: { type: EventType; aggregateType: string; aggregateId: string; payload: Record<string, unknown>; actor: string },
): Promise<void> {
  await db`
    insert into domain_event(type, aggregate_type, aggregate_id, payload, actor)
    values (${e.type}, ${e.aggregateType}, ${e.aggregateId}, ${db.json(e.payload as postgresJson)}, ${e.actor})`;
}
type postgresJson = Parameters<Db['json']>[0];

/** Kennung für instanzweite Objekte ohne eigene ID (z. B. Statuskatalog) */
export const INSTANCE_AGGREGATE = '00000000-0000-0000-0000-000000000000';

const normalize = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);

/**
 * Änderung protokollieren: je geändertem Feld alter und neuer Wert (`changes`). Ohne Änderung entsteht kein Ereignis.
 * Muss innerhalb der fachlichen Transaktion aufgerufen werden.
 */
export async function recordChange(
  db: Db,
  e: { type: EventType; aggregateType: string; aggregateId: string; actor: string; before: Record<string, unknown>; after: Record<string, unknown>; payload?: Record<string, unknown> },
): Promise<boolean> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(e.before), ...Object.keys(e.after)])) {
    const from = normalize(e.before[k]), to = normalize(e.after[k]);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[k] = { from, to };
  }
  if (!Object.keys(changes).length) return false;
  await recordEvent(db, { type: e.type, aggregateType: e.aggregateType, aggregateId: e.aggregateId, actor: e.actor, payload: { ...e.payload, changes } });
  return true;
}

export async function listEvents(
  db: Db,
  q: { aggregateId?: string | undefined; afterSeq?: number; limit?: number; type?: string | undefined },
): Promise<DomainEvent[]> {
  const rows = await db<DomainEvent[]>`
    select seq::int8 as seq, id, type, aggregate_type, aggregate_id, payload, actor, occurred_at
    from domain_event
    where seq > ${q.afterSeq ?? 0}
      ${q.aggregateId ? db`and aggregate_id = ${q.aggregateId}` : db``}
      ${q.type ? db`and type = ${q.type}` : db``}
    order by seq
    limit ${Math.min(q.limit ?? 100, 1000)}`;
  return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
}

type Listener = (event: DomainEvent) => Promise<void> | void;
const listeners: Listener[] = [];

export function subscribe(listener: Listener): void {
  listeners.push(listener);
}

/** Startet das In-Process-Relay ab dem aktuellen Ende des Logs. Liefert eine Stop-Funktion. */
export async function startEventRelay(db: Db, intervalMs = 1000): Promise<() => void> {
  const [row] = await db<{ max: string | null }[]>`select max(seq) as max from domain_event`;
  let lastSeq = Number(row?.max ?? 0);
  let running = false;
  const timer = setInterval(async () => {
    if (running || listeners.length === 0) return;
    running = true;
    try {
      const events = await listEvents(db, { afterSeq: lastSeq, limit: 500 });
      for (const event of events) {
        for (const l of listeners) {
          try {
            await l(event);
          } catch (err) {
            console.error(`Event-Listener fehlgeschlagen für ${event.type}#${event.seq}`, err);
          }
        }
        lastSeq = event.seq;
      }
    } catch (err) {
      console.error('Event-Relay', err);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function eventRoutes(app: Hono, db: Db): void {
  route(app, {
    method: 'get', path: '/api/events', access: 'admin', tag: 'Events',
    summary: 'Event-Log inkrementell lesen (afterSeq = zuletzt gesehene Sequenznummer)',
    query: z.object({
      aggregateId: z.uuid().optional(),
      type: z.string().optional(),
      afterSeq: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
    }),
  }, ({ query }) => listEvents(db, query));

  // Audit-Trail eines Projekts (Testleitung, Revision) bzw. der ganzen Instanz (Systemadministration): neueste zuerst,
  // filterbar, mit deutschen Bezeichnungen, als CSV exportierbar
  const AuditQuery = z.object({
    type: z.string().max(2000).optional(), actor: z.string().max(200).optional(), object: z.uuid().optional(),
    from: z.iso.date().optional(), to: z.iso.date().optional(), beforeSeq: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200), format: z.enum(['json', 'csv']).default('json'),
  });
  route(app, {
    method: 'get', path: '/api/projects/:key/events', tag: 'Events', access: { level: 'edit', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
    summary: 'Ereignisprotokoll eines Projekts (neueste zuerst; Filter nach Art, Person, Zeitraum, Objekt; format=csv für den Export)', query: AuditQuery,
  }, async ({ params, query }) => {
    const [p] = await db<{ id: string }[]>`select id from project where key = ${params.key!}`;
    if (!p) throw notFound('Projekt', params.key);
    return auditLog(db, query, { projectId: p.id, name: params.key! });
  });
  route(app, {
    method: 'get', path: '/api/admin/events', tag: 'Events', access: 'admin', query: AuditQuery,
    summary: 'Ereignisprotokoll der Instanz (neueste zuerst; Filter wie je Projekt; format=csv für den Export)',
  }, ({ query }) => auditLog(db, query, { projectId: null, name: 'Instanz' }));
}

type AuditQuery = { type?: string | undefined; actor?: string | undefined; object?: string | undefined; from?: string | undefined; to?: string | undefined;
  beforeSeq?: number | undefined; limit: number; format: 'json' | 'csv' };

async function auditLog(db: Db, q: AuditQuery, scope: { projectId: string | null; name: string }) {
  const types = q.type?.split(',').map((t) => t.trim()).filter(Boolean) ?? [];
  const csv = q.format === 'csv';
  const rows = await db<(DomainEvent & { projectKey: string | null })[]>`
    select e.seq::int8 as seq, e.id, e.type, e.aggregate_type, e.aggregate_id, e.payload, e.actor, e.occurred_at, p.key as project_key
    from domain_event e left join project p on p.id = e.project_id
    where true
      ${scope.projectId ? db`and e.project_id = ${scope.projectId}` : db``}
      ${types.length ? db`and e.type = any(${types})` : db``}
      ${q.actor ? db`and e.actor = ${q.actor}` : db``}
      ${q.object ? db`and e.aggregate_id = ${q.object}` : db``}
      ${q.from ? db`and e.occurred_at >= ${q.from}::date` : db``}
      ${q.to ? db`and e.occurred_at < ${q.to}::date + 1` : db``}
      ${q.beforeSeq ? db`and e.seq < ${q.beforeSeq}` : db``}
    order by e.seq desc limit ${csv ? 100_000 : q.limit}`;
  const items = rows.map((r) => ({ ...r, seq: Number(r.seq), label: eventLabel(r.type) }));
  if (!csv) return { items, more: rows.length === q.limit };
  const body = writeCsv(['Nr.', 'Zeitpunkt', 'Ereignis', 'Typ', 'Projekt', 'Objektart', 'Objekt', 'Person', 'Angaben'],
    items.map((e) => [e.seq, e.occurredAt, e.label, e.type, e.projectKey, e.aggregateType, e.aggregateId, e.actor, JSON.stringify(e.payload)]));
  return new Response(new Uint8Array(body), { headers: { 'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`Ereignisse-${scope.name}-${new Date().toISOString().slice(0, 10)}.csv`)}` } });
}
