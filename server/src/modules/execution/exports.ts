/**
 * Export von Ausführungen (Abfrage oder Zyklus) und Ergebnis-Matrix als Excel/CSV (Stufe H1).
 */
import { groupTitle, isGroup, stepNumbers } from '../../../../shared/steps/groups.ts';
import { writeCsv } from '../../platform/csv.ts';
import type { Db } from '../../platform/db.ts';
import { type Cell, writeXlsx } from '../../platform/xlsx.ts';
import { fieldDefinitions } from '../fields/index.ts';
import { getExecution, planMatrix, searchExecutions } from './service.ts';

type File = { fileName: string; contentType: string; body: Buffer };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const stamp = () => new Date().toISOString().slice(0, 10);

export async function exportExecutions(db: Db, projectId: string, projectKey: string, q: { aql?: string | undefined; cycleId?: string | undefined; actor: string }, format: 'xlsx' | 'csv'): Promise<File> {
  const statuses = new Map((await db<{ code: string; name: string }[]>`select code, name from execution_status`).map((s) => [s.code, s.name]));
  const defs = await fieldDefinitions(db, 'execution', projectId);
  const rows: Awaited<ReturnType<typeof searchExecutions>>['items'] = [];
  for (let offset = 0; offset < 20_000; offset += 500) {
    const page = await searchExecutions(db, projectId, { ...q, limit: 500, offset });
    rows.push(...page.items);
    if (page.items.length < 500) break;
  }
  const configs = new Map((await db<{ id: string; configuration: Record<string, string[]> }[]>`
    select id, configuration from test_cycle where id = any(${[...new Set(rows.map((r) => r.cycleId))]}::uuid[])`).map((c) => [c.id, c.configuration]));
  const fv = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v));
  const header = ['Zyklus', 'Testplan', 'Release', 'Build', 'Umgebung', 'Konfiguration', 'Schlüssel', 'Jira-Schlüssel', 'Titel', 'Version', 'Priorität',
    'Status', 'Zuständig', 'Ausgeführt von', 'Ausgeführt am', 'Dauer (Min.)', 'Kommentar', 'Fehler', ...defs.map((d) => `Feld: ${d.name}`)];
  const data: Cell[][] = rows.map((r) => [
    r.cycleName, r.planName, r.release, r.build, r.environment,
    Object.entries(configs.get(r.cycleId) ?? {}).map(([k, v]) => `${k}: ${v.join('/')}`).join('; '),
    r.testCaseKey, r.legacyKey, r.title, r.versionNo, r.priority, statuses.get(r.status) ?? r.status, r.assignee, r.executedBy,
    r.executedAt ? new Date(r.executedAt) : null, r.durationSeconds ? Math.round((r.durationSeconds / 60) * 10) / 10 : null, r.comment,
    r.defects.map((d) => d.externalKey).join(', '),
    ...defs.map((d) => fv((r as { customFields?: Record<string, unknown> }).customFields?.[d.key])),
  ]);
  const name = `Ausfuehrungen-${projectKey}-${stamp()}`;
  if (format === 'csv') return { fileName: `${name}.csv`, contentType: 'text/csv; charset=utf-8', body: writeCsv(header, data) };
  // Zweites Blatt: Schrittergebnisse (für Auswertung und Durchsicht außerhalb von Anemo), bis 3000 Ausführungen
  const steps: Cell[][] = [];
  if (rows.length <= 3000) {
    for (const r of rows) {
      if (r.status === 'NOT_EXECUTED') continue;
      const e = await getExecution(db, r.id);
      const byStep = new Map(e.stepResults.map((s) => [s.stepId, s]));
      // Abschnitte (J1) erscheinen als Zwischenzeile ohne Nummer und Status
      const nos = stepNumbers(e.steps);
      const lines = e.iterations.length
        ? e.iterations.flatMap((it) => e.steps.map((s, i) => [`${it.index + 1}: ${Object.values(it.values).join(', ')}`, nos[i], s, it.stepResults.find((x) => x.stepId === s.id)] as const))
        : e.steps.map((s, i) => ['', nos[i], s, byStep.get(s.id!)] as const);
      for (const [iter, n, s, res] of lines) {
        if (isGroup(s)) { steps.push([r.cycleName, r.testCaseKey, iter, '', `▸ Abschnitt: ${groupTitle(s as { title?: string | null })}`, '', '', '']); continue; }
        steps.push([r.cycleName, r.testCaseKey, iter, n ?? '', s.action, s.expected, res ? statuses.get(res.status) ?? res.status : 'nicht ausgeführt', res?.comment ?? '']);
      }
    }
  }
  const sheets = [{ name: 'Ausführungen', header, rows: data }];
  if (steps.length) sheets.push({ name: 'Schrittergebnisse', header: ['Zyklus', 'Schlüssel', 'Durchlauf', 'Schritt', 'Aktion', 'Erwartetes Ergebnis', 'Status', 'Befund'], rows: steps });
  return { fileName: `${name}.xlsx`, contentType: XLSX, body: await writeXlsx(sheets) };
}

export async function exportMatrix(db: Db, planId: string, format: 'xlsx' | 'csv'): Promise<File> {
  const [plan] = await db<{ name: string }[]>`select name from test_plan where id = ${planId}`;
  const m = await planMatrix(db, planId, { maxCycles: 200 });
  const statuses = new Map((await db<{ code: string; name: string }[]>`select code, name from execution_status`).map((s) => [s.code, s.name]));
  const header = ['Schlüssel', 'Jira-Schlüssel', 'Titel', ...m.cycles.map((c) => [c.name, c.build].filter(Boolean).join(' · '))];
  const rows: Cell[][] = m.rows.map((r) => [r.key, r.legacyKey, r.title, ...m.cycles.map((c) => (r.cells[c.id] ? statuses.get(r.cells[c.id]!.status) ?? r.cells[c.id]!.status : ''))]);
  const name = `Matrix-${(plan?.name ?? 'Testplan').replace(/[^\p{L}\p{N}._-]+/gu, '_')}-${stamp()}`;
  if (format === 'csv') return { fileName: `${name}.csv`, contentType: 'text/csv; charset=utf-8', body: writeCsv(header, rows) };
  return { fileName: `${name}.xlsx`, contentType: XLSX, body: await writeXlsx([{ name: 'Ergebnis-Matrix', header, rows, widths: [12, 12, 50, ...m.cycles.map(() => 16)] }]) };
}
