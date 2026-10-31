/**
 * Beobachten (Stufe I): Wer einen Testfall, Zyklus oder Testplan beobachtet, erhält dessen wichtige Änderungen in der
 * Sammelmail (Art „watched“). Eigene Aktionen werden nicht gemeldet; Projekte mit gesperrten externen Diensten nur als
 * Hinweis ohne Inhalt. Empfänger ohne Leserecht am Projekt filtert der Versand (mail.ts).
 *
 * Gelöschte Objekte: Beim Melden von „gelöscht“ werden die Beobachtungen des Objekts entfernt (keine verwaisten
 * Zeilen). Liefert das Löschereignis die Beobachter selbst (`payload.watchers`, weil die Zeilen schon beim Löschen
 * entfernt wurden), werden diese benachrichtigt. „Zyklus gelöscht“ erreicht über `payload.planId` auch die Beobachter
 * des Testplans.
 */
import type { Db } from '../../platform/db.ts';
import { type DomainEvent, EventTypes } from '../events/index.ts';
import { goLink } from '../../platform/links.ts';

export type WatchType = 'TEST_CASE' | 'TEST_CYCLE' | 'TEST_PLAN';
export interface WatchNote { usernames: string[]; projectId: string; project: string; text: string; link: string | null }

interface Ctx { testCaseId?: string | null; cycleId?: string | null; planId?: string | null }

/** Welche Objekte sind von einem Ereignis betroffen – und für welche Beobachter ist es relevant? */
async function affected(db: Db, e: DomainEvent): Promise<{ ctx: Ctx; label: string; projectId: string; projectKey: string; ext: string; deleted?: WatchType } | null> {
  const p = e.payload as Record<string, unknown>;
  const t = e.aggregateType;
  if (t === 'TestExecution') {
    const [x] = await db<{ testCaseId: string; cycleId: string; planId: string | null; key: string; cycleName: string; projectId: string; projectKey: string; ext: string }[]>`
      select e.test_case_id, c.id as cycle_id, c.plan_id, tc.key, c.name as cycle_name, pr.id as project_id, pr.key as project_key, pr.external_services as ext
      from test_execution e join test_cycle c on c.id = e.cycle_id join test_case tc on tc.id = e.test_case_id join project pr on pr.id = c.project_id where e.id = ${e.aggregateId}`;
    return x ? { ctx: { testCaseId: x.testCaseId, cycleId: x.cycleId, planId: x.planId }, label: `${x.key} in „${x.cycleName}“`, projectId: x.projectId, projectKey: x.projectKey, ext: x.ext } : null;
  }
  if (t === 'TestCase') {
    const [x] = await db<{ key: string; projectId: string; projectKey: string; ext: string }[]>`select tc.key, pr.id as project_id, pr.key as project_key, pr.external_services as ext from test_case tc join project pr on pr.id = tc.project_id where tc.id = ${e.aggregateId}`;
    const key = x?.key ?? String(p.key ?? '');
    if (!x) {
      if (typeof p.projectId !== 'string') return null;
      const [pr] = await db<{ key: string; ext: string }[]>`select key, external_services as ext from project where id = ${p.projectId}`;
      return pr ? { ctx: { testCaseId: e.aggregateId }, label: key, projectId: p.projectId, projectKey: pr.key, ext: pr.ext, deleted: 'TEST_CASE' } : null;
    }
    return { ctx: { testCaseId: e.aggregateId }, label: key, projectId: x.projectId, projectKey: x.projectKey, ext: x.ext };
  }
  if (t === 'TestCycle') {
    const [x] = await db<{ planId: string | null; name: string; projectId: string; projectKey: string; ext: string }[]>`select c.plan_id, c.name, pr.id as project_id, pr.key as project_key, pr.external_services as ext from test_cycle c join project pr on pr.id = c.project_id where c.id = ${e.aggregateId}`;
    if (!x) {
      if (typeof p.projectId !== 'string') return null;
      const [pr] = await db<{ key: string; ext: string }[]>`select key, external_services as ext from project where id = ${p.projectId}`;
      // gelöschter Zyklus: Beobachter des Plans über payload.planId (falls das Ereignis ihn mitliefert)
      const planId = typeof p.planId === 'string' ? p.planId : null;
      return pr ? { ctx: { cycleId: e.aggregateId, planId }, label: `„${String(p.name ?? '')}“`, projectId: p.projectId, projectKey: pr.key, ext: pr.ext, deleted: 'TEST_CYCLE' } : null;
    }
    return { ctx: { cycleId: e.aggregateId, planId: x.planId }, label: `„${x.name}“`, projectId: x.projectId, projectKey: x.projectKey, ext: x.ext };
  }
  if (t === 'TestPlan') {
    const [x] = await db<{ name: string; projectId: string; projectKey: string; ext: string }[]>`select pl.name, pr.id as project_id, pr.key as project_key, pr.external_services as ext from test_plan pl join project pr on pr.id = pl.project_id where pl.id = ${e.aggregateId}`;
    return x ? { ctx: { planId: e.aggregateId }, label: `Testplan „${x.name}“`, projectId: x.projectId, projectKey: x.projectKey, ext: x.ext } : null;
  }
  return null;
}

/** Text je Ereignis und Beobachtungsart; null = für diese Art nicht melden. */
function describe(e: DomainEvent, kind: WatchType, label: string): string | null {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case EventTypes.TestFailed: return `Fehlgeschlagen: ${label}`;
    case EventTypes.TestCaseChanged: return kind === 'TEST_CASE' ? `${label} geändert → v${p.toVersion ?? '?'}${p.changeNote ? `: ${p.changeNote}` : ''}` : null;
    case EventTypes.TestCaseMetaChanged: return kind === 'TEST_CASE' && p.status ? `${label}: Status → ${p.status}` : null;
    case EventTypes.TestCaseArchived: return kind === 'TEST_CASE' ? `${label} archiviert` : null;
    case EventTypes.TestCaseRestored: return kind === 'TEST_CASE' ? `${label} wiederhergestellt` : null;
    case EventTypes.TestCaseDeleted: return kind === 'TEST_CASE' ? `${label} gelöscht` : null;
    case EventTypes.CommentAdded: return kind === 'TEST_CASE' ? `Neuer Kommentar bei ${label}: „${String(p.excerpt ?? '').slice(0, 140)}“` : null;
    case EventTypes.TestCycleCreated: return kind === 'TEST_PLAN' ? `Neuer Zyklus ${label}` : null;
    case EventTypes.TestCycleArchived: return kind !== 'TEST_CASE' ? `Zyklus ${label} ${p.archived === false ? 'wiederhergestellt' : 'archiviert'}` : null;
    case EventTypes.TestCycleDeleted: return kind !== 'TEST_CASE' ? `Zyklus ${label} gelöscht` : null;
    case EventTypes.SessionCompleted: return kind === 'TEST_CYCLE' ? `Explorative Sitzung abgeschlossen: ${String(p.charter ?? '')}` : null;
    case EventTypes.ReleaseDecided: return kind === 'TEST_PLAN' ? `Freigabeentscheidung für ${label}: ${p.decision}` : null;
    case EventTypes.AssessmentChanged: return kind === 'TEST_PLAN' ? `Fazit für ${label} geändert` : null;
    default: return null;
  }
}

/** Beobachter-Hinweise zu einem Ereignis (je Beobachtungsart zusammengefasst, eigene Aktionen ausgenommen). */
export async function watchNotes(db: Db, e: DomainEvent, base: string | null): Promise<WatchNote[]> {
  const p = e.payload as Record<string, unknown>;
  const a = await affected(db, e);
  if (!a) return [];
  const targets: [WatchType, string | null | undefined][] = [['TEST_CASE', a.ctx.testCaseId], ['TEST_CYCLE', a.ctx.cycleId], ['TEST_PLAN', a.ctx.planId]];
  const notes: WatchNote[] = [];
  const seen = new Set<string>([e.actor]);
  const isDeletion = e.type === EventTypes.TestCaseDeleted || e.type === EventTypes.TestCycleDeleted;
  for (const [kind, id] of targets) {
    if (!id) continue;
    const text = describe(e, kind, a.label);
    // Beobachtungen des gelöschten Objekts gehören weg – auch wenn niemand (mehr) benachrichtigt wird
    const orphan = isDeletion && a.deleted === kind;
    const rows = (await db<{ username: string }[]>`select username from watch where object_type = ${kind} and object_id = ${id}`).map((r) => r.username);
    if (orphan) await db`delete from watch where object_type = ${kind} and object_id = ${id}`;
    if (!text) continue;
    const fromPayload = orphan && Array.isArray(p.watchers) ? (p.watchers as unknown[]).filter((u): u is string => typeof u === 'string') : [];
    const users = [...new Set([...rows, ...fromPayload])].filter((u) => !seen.has(u));
    if (!users.length) continue;
    users.forEach((u) => seen.add(u));
    const link = !base ? null : kind === 'TEST_CASE' && a.ctx.testCaseId && e.type !== EventTypes.TestFailed ? goLink('testfall', a.label)
      : a.ctx.cycleId ? (e.aggregateType === 'TestExecution' ? goLink('ausfuehrung', e.aggregateId) : goLink('zyklus', a.ctx.cycleId))
        : a.ctx.planId ? goLink('plan', a.ctx.planId) : null;
    notes.push({ usernames: users, projectId: a.projectId, project: a.projectKey, link, text: a.ext !== 'allowed' ? `Neuigkeit in einem geschützten Projekt (${a.projectKey}) – Details in Anemo` : text });
  }
  return notes;
}
