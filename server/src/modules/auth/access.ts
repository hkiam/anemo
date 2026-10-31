/**
 * Rechteprüfung. Rollen je Projekt (auch über Gruppen): VIEWER < TESTER < DESIGNER < PROJECT_ADMIN.
 * Systemadministratoren dürfen alles. Projekte mit visibility = internal sind für alle Angemeldeten lesbar;
 * restricted-Projekte sehen nur Mitglieder (ADR-0011).
 */
import type { Db } from '../../platform/db.ts';
import { HttpError } from '../../platform/http.ts';

export type Role = 'VIEWER' | 'TESTER' | 'DESIGNER' | 'PROJECT_ADMIN';
export type Level = 'read' | 'execute' | 'edit' | 'manage';
/** Instanzweite Rechte neben den Rollen je Projekt (Vergabe durch die Systemadministration, ADR-0027) */
export const PERMISSIONS = ['PROJECT_TRANSFER'] as const;
export type Permission = (typeof PERMISSIONS)[number];

const RANK: Record<Role, number> = { VIEWER: 1, TESTER: 2, DESIGNER: 3, PROJECT_ADMIN: 4 };
const NEEDED: Record<Level, number> = { read: 1, execute: 2, edit: 3, manage: 4 };

export interface Principal {
  userId: string | null;
  username: string;
  displayName: string;
  isSystemAdmin: boolean;
  /** explizite Rollen je Projekt-ID (direkt oder über Gruppen, höchste gewinnt) */
  roles: Map<string, Role>;
  /** Projekt-ID → visibility (für implizites Leserecht bei internal) */
  visibility: Map<string, 'internal' | 'restricted'>;
  /** instanzweite Rechte (direkt oder über Gruppen); Systemadministratoren haben alle implizit */
  permissions: Set<Permission>;
}

export async function loadPrincipal(db: Db, user: { id: string; username: string; displayName: string; isSystemAdmin: boolean }): Promise<Principal> {
  const rows = await db<{ projectId: string; role: Role }[]>`
    select m.project_id, m.role from project_member m
    where (m.principal_type = 'user' and m.principal_id = ${user.id})
       or (m.principal_type = 'group' and m.principal_id in (select group_id from group_member where user_id = ${user.id}))`;
  const roles = new Map<string, Role>();
  for (const r of rows) if (!roles.has(r.projectId) || RANK[r.role] > RANK[roles.get(r.projectId)!]) roles.set(r.projectId, r.role);
  const vis = await db<{ id: string; visibility: 'internal' | 'restricted' }[]>`select id, visibility from project`;
  const perms = await db<{ permission: Permission }[]>`
    select distinct g.permission from global_permission g
    where (g.principal_type = 'user' and g.principal_id = ${user.id})
       or (g.principal_type = 'group' and g.principal_id in (select group_id from group_member where user_id = ${user.id}))`;
  return {
    userId: user.id, username: user.username, displayName: user.displayName, isSystemAdmin: user.isSystemAdmin, roles,
    visibility: new Map(vis.map((v) => [v.id, v.visibility])), permissions: new Set(perms.map((r) => r.permission)),
  };
}

export function hasPermission(p: Principal, permission: Permission): boolean {
  return p.isSystemAdmin || p.permissions.has(permission);
}

export function effectiveRole(p: Principal, projectId: string): Role | null {
  if (p.isSystemAdmin) return 'PROJECT_ADMIN';
  const explicit = p.roles.get(projectId) ?? null;
  if (explicit) return explicit;
  return p.visibility.get(projectId) === 'internal' ? 'VIEWER' : null;
}

export function can(p: Principal, projectId: string, level: Level): boolean {
  const role = effectiveRole(p, projectId);
  return !!role && RANK[role] >= NEEDED[level];
}

export function visibleProjectIds(p: Principal): string[] | null {
  if (p.isSystemAdmin) return null; // null = alle
  return [...p.visibility.keys()].filter((id) => effectiveRole(p, id) !== null);
}

// ---- Zuordnung Objekt → Projekt ----

export type ProjectRef =
  | { kind: 'project'; key: string }
  | { kind: 'testCase' | 'folder' | 'cycle' | 'plan' | 'execution' | 'reference' | 'attachment' | 'session' | 'testSet' | 'precondition' | 'comment' | 'stepBlock'; id: string }
  | { kind: 'owner'; ownerType: string; ownerId: string }
  | { kind: 'attachmentSource'; key: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ownerProject(db: Db, ownerType: string, ownerId: string): Promise<string | null> {
  if (!UUID_RE.test(ownerId)) return null;
  const [r] = ownerType === 'TEST_CASE' ? await db<{ p: string }[]>`select project_id as p from test_case where id = ${ownerId}`
    : ownerType === 'TEST_EXECUTION' ? await db<{ p: string }[]>`select c.project_id as p from test_execution e join test_cycle c on c.id = e.cycle_id where e.id = ${ownerId}`
    : ownerType === 'TEST_CYCLE' ? await db<{ p: string }[]>`select project_id as p from test_cycle where id = ${ownerId}`
    : ownerType === 'TEST_PLAN' ? await db<{ p: string }[]>`select project_id as p from test_plan where id = ${ownerId}`
    : ownerType === 'EXPLORATORY_SESSION' ? await db<{ p: string }[]>`select c.project_id as p from exploratory_session s join test_cycle c on c.id = s.cycle_id where s.id = ${ownerId}`
    : ownerType === 'PRECONDITION' ? await db<{ p: string }[]>`select project_id as p from precondition where id = ${ownerId}`
    : [];
  return r?.p ?? null;
}

/**
 * Testfall per Schlüssel: Anemo-Schlüssel vor Altschlüssel; ein Altschlüssel in mehreren Projekten ist mehrdeutig
 * (409) – dieselbe Regel wie `findTestCase`, damit Rechteprüfung und Handler denselben Testfall treffen.
 */
async function testCaseByKey(db: Db, key: string): Promise<string | null> {
  const [exact] = await db<{ p: string }[]>`select project_id as p from test_case where key = ${key}`;
  if (exact) return exact.p;
  const legacy = await db<{ p: string }[]>`select project_id as p from test_case where legacy_key = ${key} order by project_id, id limit 2`;
  if (legacy.length > 1) throw new HttpError(409, `Altschlüssel ${key} ist mehrdeutig (in mehreren Projekten) – bitte den Anemo-Schlüssel verwenden`);
  return legacy[0]?.p ?? null;
}

/** Projekt-ID eines Objekts; null, wenn das Objekt nicht existiert (die Route meldet dann 404). */
export async function resolveProject(db: Db, ref: ProjectRef): Promise<string | null> {
  const one = async (q: Promise<{ p: string }[]>) => (await q)[0]?.p ?? null;
  switch (ref.kind) {
    case 'project': return one(db<{ p: string }[]>`select id as p from project where key = ${ref.key}`);
    case 'testCase':
      return UUID_RE.test(ref.id)
        ? one(db<{ p: string }[]>`select project_id as p from test_case where id = ${ref.id}`)
        : testCaseByKey(db, ref.id);
    case 'folder': return UUID_RE.test(ref.id) ? one(db<{ p: string }[]>`select project_id as p from folder where id = ${ref.id}`) : null;
    case 'cycle': return UUID_RE.test(ref.id) ? one(db<{ p: string }[]>`select project_id as p from test_cycle where id = ${ref.id}`) : null;
    case 'plan': return UUID_RE.test(ref.id) ? one(db<{ p: string }[]>`select project_id as p from test_plan where id = ${ref.id}`) : null;
    case 'execution': return UUID_RE.test(ref.id) ? one(db<{ p: string }[]>`select c.project_id as p from test_execution e join test_cycle c on c.id = e.cycle_id where e.id = ${ref.id}`) : null;
    case 'session': return UUID_RE.test(ref.id) ? one(db<{ p: string }[]>`select c.project_id as p from exploratory_session s join test_cycle c on c.id = s.cycle_id where s.id = ${ref.id}`) : null;
    case 'testSet': return UUID_RE.test(ref.id) ? one(db<{ p: string }[]>`select project_id as p from test_set where id = ${ref.id}`) : null;
    case 'precondition':
      return UUID_RE.test(ref.id)
        ? one(db<{ p: string }[]>`select project_id as p from precondition where id = ${ref.id}`)
        : one(db<{ p: string }[]>`select project_id as p from precondition where key = ${ref.id}`);
    case 'stepBlock': return UUID_RE.test(ref.id) ? one(db<{ p: string }[]>`select project_id as p from step_block where id = ${ref.id}`) : null;
    case 'comment': {
      if (!UUID_RE.test(ref.id)) return null;
      const [r] = await db<{ ownerType: string; ownerId: string }[]>`select owner_type, owner_id from comment where id = ${ref.id}`;
      return r ? ownerProject(db, r.ownerType, r.ownerId) : null;
    }
    case 'reference': {
      if (!UUID_RE.test(ref.id)) return null;
      const [r] = await db<{ ownerType: string; ownerId: string }[]>`select owner_type, owner_id from external_reference where id = ${ref.id}`;
      return r ? ownerProject(db, r.ownerType, r.ownerId) : null;
    }
    case 'attachment': {
      if (!UUID_RE.test(ref.id)) return null;
      const [r] = await db<{ ownerType: string; ownerId: string }[]>`select owner_type, owner_id from attachment where id = ${ref.id}`;
      return r ? ownerProject(db, r.ownerType, r.ownerId) : null;
    }
    case 'attachmentSource': {
      const [r] = await db<{ ownerType: string; ownerId: string }[]>`select owner_type, owner_id from attachment where source_key = ${ref.key} and storage = 'LOCAL' limit 1`;
      return r ? ownerProject(db, r.ownerType, r.ownerId) : null;
    }
    case 'owner': return ownerProject(db, ref.ownerType, ref.ownerId);
  }
}
