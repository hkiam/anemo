/** Modul projects: Projekte der QA-Domäne (entsprechen anfangs den Jira-Projekten). */
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { badRequest, notFound, route, visibleProjectIdsOf } from '../../platform/http.ts';
import { inTx } from '../../platform/db.ts';
import { deleteAttachmentsOf } from '../attachments/index.ts';
import { EventTypes, recordChange, recordEvent } from '../events/index.ts';

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string | null;
  visibility?: 'internal' | 'restricted';
  /** Projektkontext für KI-Skills (Glossar, Stilregeln) */
  aiContext?: string | null;
  /** Fehlschlag/Blockade nur mit Befund oder Fehlerverweis */
  requireFailureEvidence?: boolean;
  executeOnlyAssignee?: boolean;
  /** 'blocked': keine Inhalte an externe Dienste (ADR-0014) */
  externalServices?: 'allowed' | 'blocked';
  createdAt: Date;
}

export const ProjectInput = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/, 'Projektschlüssel: Großbuchstaben/Ziffern, 2–20 Zeichen'),
  name: z.string().min(1),
  description: z.string().nullish(),
});

export async function listProjects(db: Db, visible: string[] | null = null): Promise<Project[]> {
  return db<Project[]>`select id, key, name, description, visibility, created_at from project
    ${visible ? db`where id = any(${visible}::uuid[])` : db``} order by key`;
}

export async function findProject(db: Db, key: string): Promise<Project | undefined> {
  const [p] = await db<Project[]>`select id, key, name, description, visibility, external_services, ai_context, require_failure_evidence, execute_only_assignee, created_at from project where key = ${key}`;
  return p;
}

export async function getProject(db: Db, key: string): Promise<Project> {
  const p = await findProject(db, key);
  if (!p) throw notFound('Projekt', key);
  return p;
}

export async function upsertProject(db: Db, input: z.infer<typeof ProjectInput>): Promise<Project> {
  const [p] = await db<Project[]>`
    insert into project(key, name, description) values (${input.key}, ${input.name}, ${input.description ?? null})
    on conflict (key) do update set name = excluded.name, description = coalesce(excluded.description, project.description)
    returning id, key, name, description, visibility, created_at`;
  return p!;
}

/** Vergibt die nächste laufende Nummer für Testfallschlüssel (z. B. DEMO-T17). */
export async function nextNumber(db: Db, projectId: string): Promise<number> {
  const [r] = await db<{ n: number }[]>`
    update project set next_number = next_number + 1 where id = ${projectId} returning next_number - 1 as n`;
  return r!.n;
}

/**
 * Projekt mit allen Inhalten endgültig löschen (Stufe H4, nur Systemadministration mit Bestätigung des Schlüssels).
 * Das Ereignisprotokoll bleibt als Nachweis erhalten (ohne Kommentarauszüge); Zuordnungen der Migration auf gelöschte
 * Objekte werden entfernt, damit ein erneuter Import sauber neu anlegt. Auch Daten ohne Fremdschlüssel auf das Projekt
 * gehen mit (Kommentare, Beobachtungen, Abdeckungsstand, Verweise und Anhänge aller Besitzerarten) – Löschkonzept.
 */
export async function deleteProject(db: Db, key: string, actor: string) {
  const p = await getProject(db, key);
  const ids = async (sql: Promise<{ id: string }[]>) => (await sql).map((r) => r.id);
  const tcs = await ids(db<{ id: string }[]>`select id from test_case where project_id = ${p.id}`);
  const cycles = await ids(db<{ id: string }[]>`select id from test_cycle where project_id = ${p.id}`);
  const plans = await ids(db<{ id: string }[]>`select id from test_plan where project_id = ${p.id}`);
  const execs = await ids(db<{ id: string }[]>`select id from test_execution where cycle_id = any(${cycles}::uuid[])`);
  const sessions = await ids(db<{ id: string }[]>`select id from exploratory_session where cycle_id = any(${cycles}::uuid[])`);
  const preconditions = await ids(db<{ id: string }[]>`select id from precondition where project_id = ${p.id}`);
  const owners: [string, string[]][] = [['TEST_CASE', tcs], ['TEST_EXECUTION', execs], ['TEST_CYCLE', cycles], ['TEST_PLAN', plans], ['EXPLORATORY_SESSION', sessions], ['PRECONDITION', preconditions]];
  let files = 0;
  for (const [type, list] of owners) for (const id of list) files += await deleteAttachmentsOf(db, type, id);
  for (const [type, list] of owners) await db`delete from external_reference where owner_type = ${type} and owner_id = any(${list}::uuid[])`;
  const all = owners.flatMap(([, l]) => l);
  // Daten ohne Fremdschlüssel auf das Projekt (Besitzer über owner_type/owner_id bzw. object_type/object_id)
  for (const [type, list] of owners) {
    await db`delete from comment where owner_type = ${type} and owner_id = any(${list}::uuid[])`;
    await db`delete from watch where object_type = ${type} and object_id = any(${list}::uuid[])`;
  }
  await db`delete from coverage_push where project_id = ${p.id}`;
  // Kommentarauszüge auch aus dem Ereignisprotokoll entfernen (das Ereignis selbst bleibt als Nachweis)
  // einzige erlaubte Änderung am Ereignisprotokoll (Migration 040): Freigabe nur für diese Transaktion
  await db`select set_config('anemo.event_redaction', 'on', true)`;
  await db`update domain_event set payload = payload - 'excerpt' where aggregate_id = any(${all}::uuid[]) and payload ? 'excerpt'`;
  await db`delete from migration_mapping where target_id = any(${all}::uuid[])`;
  await db`delete from test_execution where cycle_id = any(${cycles}::uuid[])`;
  await db`delete from test_cycle where project_id = ${p.id}`;
  await db`delete from test_plan where project_id = ${p.id}`;
  await db`delete from test_case_version where test_case_id = any(${tcs}::uuid[])`;
  await db`delete from test_case where project_id = ${p.id}`;
  await db`delete from folder where project_id = ${p.id}`;
  // übrige Projektdaten hängen mit „on delete cascade“ am Projekt (Vorbedingungen, Schrittbibliothek, Testsets, Felder,
  // Ansichten, Zuordnungen, Mitglieder, Zugriffsprotokoll, CI-Läufe über die Zyklen, Abdeckungsstand)
  await db`delete from project where id = ${p.id}`;
  await recordEvent(db, { type: EventTypes.ProjectDeleted, aggregateType: 'Project', aggregateId: p.id, actor,
    payload: { key: p.key, name: p.name, externalServices: p.externalServices, testCases: tcs.length, cycles: cycles.length, executions: execs.length, attachments: files } });
  return { key: p.key, testCases: tcs.length, cycles: cycles.length, plans: plans.length, executions: execs.length, attachments: files };
}

export function projectRoutes(app: Hono, db: Db): void {
  route(app, { method: 'get', path: '/api/projects', tag: 'Projekte', summary: 'Projekte auflisten' },
    ({ c }) => listProjects(db, visibleProjectIdsOf(c)));
  route(app, { method: 'post', path: '/api/projects', access: 'admin', tag: 'Projekte', summary: 'Projekt anlegen', body: ProjectInput, status: 201 },
    ({ body }) => upsertProject(db, body));
  route(app, {
    method: 'put', path: '/api/projects/:key/ai-context', access: { level: 'manage', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag: 'Projekte',
    summary: 'Projektkontext für KI-Skills (Glossar, Fachbegriffe, Stilregeln)', body: z.object({ aiContext: z.string().max(8000).nullable() }),
  }, async ({ params, body }) => {
    await db`update project set ai_context = ${body.aiContext?.trim() || null} where key = ${params.key!}`;
    return getProject(db, params.key!);
  });
  route(app, {
    method: 'put', path: '/api/projects/:key/settings', access: { level: 'manage', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag: 'Projekte',
    summary: 'Projektregeln (Nachweispflicht bei Fehlschlag/Blockade, Ausführung nur durch Zuständige)',
    body: z.object({ requireFailureEvidence: z.boolean().optional(), executeOnlyAssignee: z.boolean().optional() }),
  }, ({ params, body, actor }) => inTx(db, async (tx) => {
    const p = await getProject(tx, params.key!);
    const before = { requireFailureEvidence: p.requireFailureEvidence !== false, executeOnlyAssignee: p.executeOnlyAssignee === true };
    const after = { requireFailureEvidence: body.requireFailureEvidence ?? before.requireFailureEvidence, executeOnlyAssignee: body.executeOnlyAssignee ?? before.executeOnlyAssignee };
    await recordChange(tx, { type: EventTypes.ProjectRulesChanged, aggregateType: 'Project', aggregateId: p.id, actor, before, after });
    await tx`update project set require_failure_evidence = ${after.requireFailureEvidence}, execute_only_assignee = ${after.executeOnlyAssignee} where id = ${p.id}`;
    return getProject(tx, params.key!);
  }));
  route(app, {
    method: 'patch', path: '/api/projects/:key', access: { level: 'manage', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag: 'Projekte',
    summary: 'Projekt umbenennen bzw. Beschreibung ändern (der Schlüssel bleibt – er steckt in allen Testfallschlüsseln)',
    body: z.object({ name: z.string().trim().min(1).max(200).optional(), description: z.string().max(5000).nullish() }),
  }, async ({ params, body }) => {
    const p = await getProject(db, params.key!);
    await db`update project set name = ${body.name ?? p.name}, description = ${body.description === undefined ? db`description` : body.description} where id = ${p.id}`;
    return getProject(db, params.key!);
  });
  route(app, {
    method: 'delete', path: '/api/projects/:key', access: 'admin', tag: 'Projekte',
    summary: 'Projekt mit allen Inhalten endgültig löschen (Bestätigung: confirmKey = Projektschlüssel)',
    body: z.object({ confirmKey: z.string() }),
  }, ({ params, body, actor }) => {
    if (body.confirmKey !== params.key) throw badRequest('Zur Bestätigung den Projektschlüssel genau eingeben.');
    return inTx(db, (tx) => deleteProject(tx, params.key!, actor));
  });
  route(app, { method: 'get', path: '/api/projects/:key', access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, tag: 'Projekte', summary: 'Projekt lesen' },
    ({ params }) => getProject(db, params.key!));
}
