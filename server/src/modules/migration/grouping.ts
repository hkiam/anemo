/**
 * Bestandsumstellung Stufe J1: Pfeil-Trennschritte aus Zephyr in allen Versionen „an Ort und Stelle“ zu Abschnitten
 * machen – ohne neue Versionen (sonst gälten alle betroffenen Testfälle als geändert und laufende Ausführungen als
 * veraltet). Der Originaltext bleibt je Schritt in `legacy`; `revert` stellt ihn wieder her.
 *
 * Ablauf: erst Probelauf (Bericht), dann `apply` – je Projekt in einer Transaktion, mit Ereignis `StepsGrouped`.
 * Der Bericht enthält Testfallschlüssel und Abschnittsnamen und gehört nur in migration-snapshots/ (nicht versioniert).
 */
import { writeFile } from 'node:fs/promises';
import type { Db } from '../../platform/db.ts';
import { recordEvent } from '../events/index.ts';
import { convertStep, isGroup, type GroupFields } from '../../../../shared/steps/groups.ts';

type RawStep = { id?: string; action?: string; data?: string; expected?: string; kind?: string | null; legacy?: GroupFields['legacy'] } & Record<string, unknown>;

export interface GroupingResult {
  mode: 'dry-run' | 'apply' | 'revert';
  projects: { key: string; testCases: number; versions: number; groups: number; untitled: number; withMarker: number; withSubtitle: number; withNote: number }[];
  /** Fälle zur Sichtung (aktuelle Versionen): ohne Namen, mit Kennzeichen, mit Untertitel */
  review: { key: string; version: number; step: number; reason: string; title: string; subtitle: string | null; marker: string | null }[];
}

export async function groupSteps(db: Db, o: { mode: GroupingResult['mode']; projects?: string[]; actor?: string; report?: string; log?: (m: string) => void }): Promise<GroupingResult> {
  const log = o.log ?? (() => undefined);
  const projects = await db<{ id: string; key: string }[]>`
    select id, key from project ${o.projects?.length ? db`where key in ${db(o.projects)}` : db``} order by key`;
  const result: GroupingResult = { mode: o.mode, projects: [], review: [] };
  for (const p of projects) {
    const stat = { key: p.key, testCases: 0, versions: 0, groups: 0, untitled: 0, withMarker: 0, withSubtitle: 0, withNote: 0 };
    const touchedCases = new Set<string>();
    const run = async (tx: Db) => {
      const rows = await tx<{ id: string; testCaseId: string; key: string; versionNo: number; current: boolean; steps: RawStep[] }[]>`
        select v.id, v.test_case_id, t.key, v.version_no, (v.version_no = t.current_version) as current, v.steps
        from test_case_version v join test_case t on t.id = v.test_case_id
        where t.project_id = ${p.id} and v.format = 'CLASSIC' and jsonb_array_length(v.steps) > 0`;
      for (const r of rows) {
        let changed = false;
        const next = r.steps.map((s) => {
          if (o.mode === 'revert') {
            if (!isGroup(s) || !s.legacy) return s;
            changed = true;
            const { kind: _k, title: _t, subtitle: _s, marker: _m, note: _n, legacy, ...rest } = s as RawStep & GroupFields;
            return { ...rest, action: legacy!.action, data: legacy!.data, expected: legacy!.expected };
          }
          const c = convertStep(s as RawStep) as RawStep & Partial<GroupFields>;
          if (c !== s) changed = true;
          return c;
        });
        if (!changed) continue;
        stat.versions++;
        touchedCases.add(r.testCaseId);
        if (o.mode !== 'revert' && r.current) {
          next.forEach((s, i) => {
            if (!isGroup(s) || isGroup(r.steps[i])) return;
            const g = s as RawStep & GroupFields;
            stat.groups++;
            if (!g.title) stat.untitled++;
            if (g.marker) stat.withMarker++;
            if (g.subtitle) stat.withSubtitle++;
            if (g.note) stat.withNote++;
            const reason = !g.title ? 'ohne Namen' : g.subtitle ? 'zwei Überschriften (Untertitel)' : g.marker ? `Kennzeichen „${g.marker}“` : g.title.length > 80 ? 'sehr langer Name' : '';
            // Schrittnummer wie in Zephyr (alle Schritte gezählt), damit der Fall dort wiederzufinden ist
            if (reason) result.review.push({ key: r.key, version: r.versionNo, step: i + 1, reason, title: g.title, subtitle: g.subtitle ?? null, marker: g.marker ?? null });
          });
        }
        if (o.mode !== 'dry-run') await tx`update test_case_version set steps = ${tx.json(next as never)} where id = ${r.id}`;
      }
      stat.testCases = touchedCases.size;
      if (o.mode !== 'dry-run' && stat.versions) {
        await recordEvent(tx, { type: 'StepsGrouped', aggregateType: 'project', aggregateId: p.id,
          payload: { mode: o.mode, testCases: stat.testCases, versions: stat.versions, groups: stat.groups }, actor: o.actor ?? 'migration' });
      }
    };
    if (o.mode === 'dry-run') await run(db); else await db.begin((tx) => run(tx as unknown as Db));
    if (stat.versions) { result.projects.push(stat); log(`${p.key}: ${stat.testCases} Testfälle, ${stat.versions} Versionen${o.mode !== 'revert' ? `, ${stat.groups} Abschnitte (aktuelle Versionen)` : ''}`); }
  }
  if (o.report) await writeFile(o.report, reportMarkdown(result), 'utf8');
  return result;
}

function reportMarkdown(r: GroupingResult): string {
  const sum = (k: keyof GroupingResult['projects'][number]) => r.projects.reduce((a, p) => a + (p[k] as number), 0);
  const cell = (s: string | null) => (s ?? '').replace(/\|/g, '\\|');
  return [
    `# Abschnitte (Stufe J1) – ${r.mode === 'dry-run' ? 'Probelauf' : r.mode === 'apply' ? 'Umstellung' : 'Rücknahme'}`,
    '',
    `Stand ${new Date().toISOString().slice(0, 16).replace('T', ' ')}. Zahlen zu Abschnitten beziehen sich auf die aktuellen Versionen; umgestellt werden alle Versionen.`,
    '',
    '| Projekt | Testfälle | Versionen | Abschnitte | ohne Namen | Kennzeichen | Untertitel | Beschreibung |',
    '|---|---|---|---|---|---|---|---|',
    ...r.projects.map((p) => `| ${p.key} | ${p.testCases} | ${p.versions} | ${p.groups} | ${p.untitled} | ${p.withMarker} | ${p.withSubtitle} | ${p.withNote} |`),
    `| **Summe** | ${sum('testCases')} | ${sum('versions')} | ${sum('groups')} | ${sum('untitled')} | ${sum('withMarker')} | ${sum('withSubtitle')} | ${sum('withNote')} |`,
    '',
    '## Zur Sichtung',
    '',
    'Schrittnummer wie in Zephyr (alle Schritte gezählt).',
    '',
    '| Testfall | Version | Schritt | Grund | Name | Untertitel | Kennzeichen |',
    '|---|---|---|---|---|---|---|',
    ...r.review.map((x) => `| ${x.key} | v${x.version} | ${x.step} | ${x.reason} | ${cell(x.title)} | ${cell(x.subtitle)} | ${cell(x.marker)} |`),
    '',
  ].join('\n');
}
