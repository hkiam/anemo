/**
 * Explorative Testsitzungen (Stufe G2): strukturiertes freies Testen im Zyklus.
 * Charter (Ziel), Bereiche, Timebox, Zeitnahme (Start/Pause/Ende), laufendes Protokoll mit Screenshots (Anhänge der
 * Sitzung) und Funde (Fehler, Frage, Idee, Notiz) – Funde lassen sich als Fehlerverweis bzw. Testfall übernehmen.
 */
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { type Db, inTx } from '../../platform/db.ts';
import { badRequest, conflict, notFound, route } from '../../platform/http.ts';
import { EventTypes, recordEvent } from '../events/index.ts';
import { getCycle } from './service.ts';

export const FindingKind = z.enum(['bug', 'question', 'idea', 'note']);
export const Finding = z.object({
  id: z.string().max(40).optional(),
  kind: FindingKind,
  text: z.string().trim().min(1).max(4000),
  at: z.string().optional(),
  by: z.string().optional(),
  /** übernommener Fehler (Ticket-Schlüssel) bzw. Testfall */
  defectKey: z.string().max(100).nullish(),
  testCaseKey: z.string().max(100).nullish(),
});
export type Finding = z.infer<typeof Finding>;

export interface Session {
  id: string; cycleId: string; charter: string; areas: string | null; timeboxMinutes: number; tester: string | null;
  status: 'planned' | 'running' | 'paused' | 'done' | 'debriefed'; startedAt: Date | null; runningSince: Date | null; endedAt: Date | null;
  durationSeconds: number; notes: string | null; summary: string | null; findings: Finding[]; createdBy: string; createdAt: Date; updatedAt: Date;
  debriefNote?: string | null; debriefedBy?: string | null; debriefedAt?: Date | null; tbs?: { test: number; bug: number; setup: number; charterPct?: number } | null;
}

/** Dauer einschließlich der laufenden Phase. */
const withElapsed = (s: Session) => ({
  ...s, elapsedSeconds: s.durationSeconds + (s.runningSince ? Math.round((Date.now() - new Date(s.runningSince).getTime()) / 1000) : 0),
});

export async function getSession(db: Db, id: string) {
  const [s] = await db<Session[]>`select * from exploratory_session where id = ${id}`;
  if (!s) throw notFound('Sitzung', id);
  const c = await getCycle(db, s.cycleId);
  return { ...withElapsed(s), cycleName: c.name, planId: c.planId, planName: c.planName };
}

export async function listSessions(db: Db, cycleIds: string[]) {
  if (!cycleIds.length) return [];
  const rows = await db<Session[]>`select * from exploratory_session where cycle_id = any(${cycleIds}::uuid[]) order by created_at`;
  return rows.map(withElapsed);
}

const SessionBody = z.object({
  charter: z.string().trim().min(3).max(2000),
  areas: z.string().max(2000).nullish(),
  timeboxMinutes: z.number().int().min(5).max(480).default(60),
  tester: z.string().max(100).nullish(),
});

export function sessionRoutes(app: Hono, db: Db): void {
  const tag = 'Explorative Sitzungen';
  const bySession = (level: 'read' | 'execute' | 'edit') => ({ level, project: ({ params }: { params: Record<string, string> }) => ({ kind: 'session' as const, id: params.id! }) });
  route(app, { method: 'get', path: '/api/cycles/:id/sessions', tag, summary: 'Explorative Sitzungen eines Zyklus', access: { level: 'read', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) } },
    ({ params }) => listSessions(db, [params.id!]));
  route(app, {
    method: 'post', path: '/api/cycles/:id/sessions', tag, summary: 'Sitzung planen (Charter, Bereiche, Timebox, Tester)', status: 201, body: SessionBody,
    access: { level: 'execute', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) },
  }, async ({ params, body, actor }) => {
    await getCycle(db, params.id!);
    const [s] = await db<Session[]>`insert into exploratory_session(cycle_id, charter, areas, timebox_minutes, tester, created_by)
      values (${params.id!}, ${body.charter}, ${body.areas ?? null}, ${body.timeboxMinutes}, ${body.tester ?? actor}, ${actor}) returning *`;
    return withElapsed(s!);
  });
  route(app, { method: 'get', path: '/api/sessions/:id', tag, summary: 'Sitzung lesen', access: bySession('read') }, ({ params }) => getSession(db, params.id!));
  // Sitzung bearbeiten – nur solange nicht abgeschlossen; Sperre gegen gleichzeitige Änderungen
  route(app, {
    method: 'put', path: '/api/sessions/:id', tag, summary: 'Sitzung bearbeiten (Auftrag, Protokoll, Zusammenfassung) – nicht mehr nach Abschluss', access: bySession('execute'),
    body: SessionBody.partial().extend({ notes: z.string().max(200_000).nullish(), summary: z.string().max(20_000).nullish(), expectedUpdatedAt: z.string().optional() }),
  }, ({ params, body }) => inTx(db, async (tx) => {
    const [cur] = await tx<Session[]>`select * from exploratory_session where id = ${params.id!} for update`;
    if (!cur) throw notFound('Sitzung', params.id);
    if (cur.status === 'done' || cur.status === 'debriefed') throw conflict('Die Sitzung ist abgeschlossen und schreibgeschützt.');
    if (body.expectedUpdatedAt && new Date(body.expectedUpdatedAt).getTime() !== new Date(cur.updatedAt).getTime()) {
      throw conflict('Die Sitzung wurde zwischenzeitlich geändert – bitte neu laden.');
    }
    await tx`update exploratory_session set
      charter = ${body.charter ?? cur.charter}, areas = ${body.areas === undefined ? cur.areas : body.areas ?? null},
      timebox_minutes = ${body.timeboxMinutes ?? cur.timeboxMinutes}, tester = ${body.tester === undefined ? cur.tester : body.tester ?? null},
      notes = ${body.notes === undefined ? cur.notes : body.notes ?? null}, summary = ${body.summary === undefined ? cur.summary : body.summary ?? null},
      updated_at = now()
      where id = ${cur.id}`;
    return getSession(tx, cur.id);
  }));
  // Beobachtungen einzeln anhängen/ändern/entfernen (atomar – keine verlorenen Funde bei parallelem Arbeiten)
  const withLockedSession = (id: string, fn: (s: Session, tx: Db) => Promise<Finding[]>) => inTx(db, async (tx) => {
    const [cur] = await tx<Session[]>`select * from exploratory_session where id = ${id} for update`;
    if (!cur) throw notFound('Sitzung', id);
    if (cur.status === 'done' || cur.status === 'debriefed') throw conflict('Die Sitzung ist abgeschlossen und schreibgeschützt.');
    const findings = await fn(cur, tx);
    await tx`update exploratory_session set findings = ${tx.json(findings as never)}, updated_at = now() where id = ${id}`;
    return getSession(tx, id);
  });
  route(app, {
    method: 'post', path: '/api/sessions/:id/findings', tag, summary: 'Beobachtung hinzufügen (Fehler, Frage, Idee, Notiz)', status: 201, access: bySession('execute'),
    body: z.object({ kind: FindingKind, text: z.string().trim().min(1).max(4000) }),
  }, ({ params, body, actor }) => withLockedSession(params.id!, async (cur) => {
    if (cur.findings.length >= 500) throw badRequest('Höchstens 500 Beobachtungen je Sitzung');
    return [...cur.findings, { id: randomUUID().slice(0, 8), kind: body.kind, text: body.text, at: new Date().toISOString(), by: actor }];
  }));
  route(app, {
    method: 'patch', path: '/api/sessions/:id/findings/:fid', tag, summary: 'Beobachtung ändern bzw. übernommenen Fehler/Testfall eintragen', access: bySession('execute'),
    body: z.object({ text: z.string().trim().min(1).max(4000).optional(), kind: FindingKind.optional(), defectKey: z.string().max(100).nullish(), testCaseKey: z.string().max(100).nullish() }),
  }, ({ params, body }) => withLockedSession(params.id!, async (cur) => {
    if (!cur.findings.some((f) => f.id === params.fid)) throw notFound('Beobachtung', params.fid);
    // Urheber und Zeitpunkt bleiben, wie sie beim Anlegen gesetzt wurden
    return cur.findings.map((f) => (f.id === params.fid ? { ...f, ...(body.text ? { text: body.text } : {}), ...(body.kind ? { kind: body.kind } : {}),
      ...(body.defectKey !== undefined ? { defectKey: body.defectKey } : {}), ...(body.testCaseKey !== undefined ? { testCaseKey: body.testCaseKey } : {}) } : f));
  }));
  route(app, { method: 'delete', path: '/api/sessions/:id/findings/:fid', tag, summary: 'Beobachtung entfernen (nur ohne übernommenen Fehler/Testfall)', access: bySession('execute') },
    ({ params }) => withLockedSession(params.id!, async (cur) => {
      const f = cur.findings.find((x) => x.id === params.fid);
      if (!f) throw notFound('Beobachtung', params.fid);
      if (f.defectKey || f.testCaseKey) throw badRequest('Übernommene Beobachtungen bleiben erhalten');
      return cur.findings.filter((x) => x.id !== params.fid);
    }));
  route(app, {
    method: 'post', path: '/api/sessions/:id/timer', tag, summary: 'Zeitnahme: start, pause oder stop (stop beendet die Sitzung, Zusammenfassung Pflicht)', access: bySession('execute'),
    body: z.object({ action: z.enum(['start', 'pause', 'stop']), summary: z.string().max(20_000).optional() }),
  }, ({ params, body, actor }) => inTx(db, async (tx) => {
    const [s] = await tx<Session[]>`select * from exploratory_session where id = ${params.id!} for update`;
    if (!s) throw notFound('Sitzung', params.id);
    if (s.status === 'done' || s.status === 'debriefed') {
      if (body.action === 'stop') return getSession(tx, s.id); // idempotent
      throw conflict('Die Sitzung ist abgeschlossen.');
    }
    const running = s.runningSince ? Math.round((Date.now() - new Date(s.runningSince).getTime()) / 1000) : 0;
    if (body.action === 'start') {
      if (s.status === 'running') return getSession(tx, s.id);
      await tx`update exploratory_session set status = 'running', running_since = now(), started_at = coalesce(started_at, now()), updated_at = now() where id = ${s.id}`;
    } else if (body.action === 'pause') {
      if (s.status !== 'running') throw badRequest('Sitzung läuft nicht');
      await tx`update exploratory_session set status = 'paused', running_since = null, duration_seconds = duration_seconds + ${running}, updated_at = now() where id = ${s.id}`;
    } else {
      const summary = body.summary?.trim() || s.summary?.trim();
      if (!summary) throw badRequest('Zum Abschließen bitte eine Zusammenfassung schreiben (abgedeckt, nicht abgedeckt, Risiken).');
      await tx`update exploratory_session set status = 'done', running_since = null, duration_seconds = duration_seconds + ${running}, summary = ${summary},
        started_at = coalesce(started_at, now()), ended_at = now(), updated_at = now() where id = ${s.id}`;
      await recordEvent(tx, { type: EventTypes.SessionCompleted, aggregateType: 'ExploratorySession', aggregateId: s.id, actor,
        payload: { cycleId: s.cycleId, charter: s.charter.slice(0, 200), findings: s.findings.length, bugs: s.findings.filter((f) => f.kind === 'bug').length } });
    }
    return getSession(tx, s.id);
  }));
  route(app, {
    method: 'post', path: '/api/sessions/:id/debrief', tag, summary: 'Nachbesprechung (SBTM-Debriefing) durch die Testleitung, mit Zeitanteilen Test/Bug/Setup', access: bySession('edit'),
    body: z.object({
      note: z.string().trim().min(3).max(20_000),
      tbs: z.object({ test: z.number().int().min(0).max(100), bug: z.number().int().min(0).max(100), setup: z.number().int().min(0).max(100), charterPct: z.number().int().min(0).max(100).optional() })
        .refine((t) => t.test + t.bug + t.setup === 100, 'Test + Bug + Setup muss 100 % ergeben').optional(),
    }),
  }, ({ params, body, actor }) => inTx(db, async (tx) => {
    const [s] = await tx<Session[]>`select * from exploratory_session where id = ${params.id!} for update`;
    if (!s) throw notFound('Sitzung', params.id);
    if (s.status !== 'done' && s.status !== 'debriefed') throw badRequest('Nachbesprechen erst nach Abschluss der Sitzung');
    await tx`update exploratory_session set status = 'debriefed', debrief_note = ${body.note}, debriefed_by = ${actor}, debriefed_at = now(),
      tbs = ${body.tbs ? tx.json(body.tbs as never) : null}, updated_at = now() where id = ${s.id}`;
    return getSession(tx, s.id);
  }));
  route(app, { method: 'delete', path: '/api/sessions/:id', tag, summary: 'Sitzung löschen (nur geplant, ohne Protokoll und Funde)', status: 204, access: bySession('edit') },
    async ({ params }) => {
      const s = await getSession(db, params.id!);
      if (s.status !== 'planned' || s.notes || s.findings.length) throw badRequest('Nur geplante Sitzungen ohne Protokoll und Funde lassen sich löschen');
      await db`delete from exploratory_session where id = ${s.id}`;
    });
}
