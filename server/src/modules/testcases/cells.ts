/**
 * Stufe J3: Wer hat welche Schrittzelle wann geändert. Abgeleitet aus den Versionen (Schritt-IDs sind über Versionen
 * stabil; bei übernommenen Testfällen enthalten die Versionen die zurückgerechnete Zephyr-Historie).
 */
import type { Db } from '../../platform/db.ts';
import { notFound } from '../../platform/http.ts';

export type CellField = 'action' | 'data' | 'expected' | 'title';
export const CELL_FIELDS: CellField[] = ['action', 'data', 'expected', 'title'];

interface VersionSteps { versionNo: number; createdBy: string; createdAt: Date; steps: { id?: string; kind?: string | null; title?: string | null; action?: string; data?: string; expected?: string }[] }
export interface CellChange { versionNo: number; by: string; at: Date; value: string }
export interface CellInfo { versionNo: number; by: string; at: Date; changes: number }

const valueOf = (s: VersionSteps['steps'][number], f: CellField) => (f === 'title' ? (s.kind === 'group' ? s.title ?? '' : '') : (s[f] ?? ''));

/** Änderungen je Schritt und Feld bis einschließlich der letzten übergebenen Version (aufsteigend sortiert). */
export function cellChanges(versions: VersionSteps[]): Map<string, Map<CellField, CellChange[]>> {
  const out = new Map<string, Map<CellField, CellChange[]>>();
  const last = new Map<string, string>();
  for (const v of versions) {
    for (const s of v.steps ?? []) {
      if (!s.id) continue;
      for (const f of CELL_FIELDS) {
        const value = valueOf(s, f);
        const k = `${s.id}\u0000${f}`;
        if (last.get(k) === value) continue;
        // ein leeres Feld beim ersten Auftreten ist keine Änderung (z. B. Testdaten nie gefüllt)
        if (!last.has(k) && value === '') { last.set(k, value); continue; }
        last.set(k, value);
        let byStep = out.get(s.id);
        if (!byStep) out.set(s.id, (byStep = new Map()));
        const list = byStep.get(f) ?? [];
        list.push({ versionNo: v.versionNo, by: v.createdBy, at: v.createdAt, value });
        byStep.set(f, list);
      }
    }
  }
  return out;
}

async function loadVersions(db: Db, testCaseId: string, upTo?: number) {
  const [tc] = await db<{ id: string; currentVersion: number }[]>`select id, current_version from test_case where id = ${testCaseId}`;
  if (!tc) throw notFound('Testfall', testCaseId);
  const until = upTo && upTo > 0 ? Math.min(upTo, tc.currentVersion) : tc.currentVersion;
  const versions = await db<VersionSteps[]>`
    select version_no, created_by, created_at, steps from test_case_version where test_case_id = ${tc.id} and version_no <= ${until} order by version_no`;
  return { until, versions };
}

/** Letzte Änderung je Zelle der gezeigten Version (für Tooltip und Hervorhebung). */
export async function cellSummary(db: Db, testCaseId: string, upTo?: number) {
  const { until, versions } = await loadVersions(db, testCaseId, upTo);
  const cells: Record<string, Partial<Record<CellField, CellInfo>>> = {};
  for (const [stepId, fields] of cellChanges(versions)) {
    for (const [f, list] of fields) {
      const lastChange = list.at(-1)!;
      (cells[stepId] ??= {})[f] = { versionNo: lastChange.versionNo, by: lastChange.by, at: lastChange.at, changes: list.length };
    }
  }
  return { versionNo: until, cells };
}

/** Verlauf einer Zelle (alle Fassungen mit Person und Zeit), neueste zuerst. */
export async function cellHistory(db: Db, testCaseId: string, stepId: string, field: CellField, upTo?: number) {
  const { versions } = await loadVersions(db, testCaseId, upTo);
  return (cellChanges(versions).get(stepId)?.get(field) ?? []).slice().reverse();
}
