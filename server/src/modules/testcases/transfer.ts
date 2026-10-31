/**
 * Testfälle als Excel/CSV exportieren und importieren (Stufe H1).
 * Format: je Schritt eine Zeile; die erste Zeile eines Testfalls trägt dessen Angaben (wie bei Zephyr/Xray üblich).
 * Der Import erkennt Spalten auch aus Zephyr- und Xray-Exporten, zeigt eine Vorschau mit Zuordnung, kann
 * probeweise laufen (nichts wird gespeichert) und bestehende Testfälle per Schlüssel aktualisieren.
 */
import { convertStep, groupTitle, isGroup, stepNumbers } from '../../../../shared/steps/groups.ts';
import { z } from 'zod';
import { decodeText, parseCsv, writeCsv } from '../../platform/csv.ts';
import type { Db } from '../../platform/db.ts';
import { badRequest } from '../../platform/http.ts';
import { type Cell, readXlsx, writeXlsx } from '../../platform/xlsx.ts';
import { checkPriority, fieldDefinitions, validateCustomFields } from '../fields/index.ts';
import type { TestCaseContentInput } from './model.ts';
import { createTestCase, ensureFolderPath, getTestCase, listFolders, reviseTestCase, searchTestCases, type SearchQuery, updateTestCaseMeta } from './service.ts';

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

const BASE_COLUMNS = ['Schlüssel', 'Jira-Schlüssel', 'Titel', 'Ordner', 'Status', 'Priorität', 'Labels', 'Komponenten', 'Owner', 'Format',
  'Ziel', 'Vorbedingungen', 'Testdaten', 'Gherkin', 'Testanweisung (Freitext)', 'Version', 'Schätzung (Min.)'] as const;
const STEP_COLUMNS = ['Schritt', 'Aktion', 'Schritt-Testdaten', 'Erwartetes Ergebnis'] as const;

export async function exportTestCases(db: Db, q: SearchQuery & { ids?: string[] | undefined }, format: 'xlsx' | 'csv', projectKey: string) {
  const folders = await listFolders(db, q.projectId);
  const pathOf = (id: string | null): string => {
    const f = folders.find((x) => x.id === id);
    return f ? `${f.parentId ? `${pathOf(f.parentId)}/` : ''}${f.name}` : '';
  };
  const ids: string[] = [];
  if (q.ids?.length) ids.push(...q.ids);
  else {
    for (let offset = 0; offset < 20_000; offset += 1000) {
      const page = await searchTestCases(db, { ...q, limit: 1000, offset });
      ids.push(...page.items.map((t) => t.id));
      if (page.items.length < 1000) break;
    }
  }
  const defs = await fieldDefinitions(db, 'test_case', q.projectId);
  const header = [...BASE_COLUMNS, ...defs.map((d) => `Feld: ${d.name}`), ...STEP_COLUMNS];
  const rows: Cell[][] = [];
  const fieldText = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  for (const id of ids) {
    const t = await getTestCase(db, id);
    const v = t.version;
    const base: Cell[] = [t.key, t.legacyKey, v.title, pathOf(t.folderId), t.status, v.priority, v.labels.join(', '), v.components.join(', '), t.owner,
      v.format === 'GHERKIN' ? 'Gherkin' : v.format === 'PLAIN' ? 'Freitext' : 'Klassisch', v.objective, v.preconditions, v.testData, v.gherkin, v.plainText ?? null, t.currentVersion, t.estimateMinutes ?? null,
      ...defs.map((d) => fieldText(v.customFields[d.key]))];
    const steps = v.format === 'CLASSIC' ? v.steps : [];
    if (!steps.length) rows.push([...base, '', '', '', '']);
    const nos = stepNumbers(steps);
    steps.forEach((s, i) => {
      // Folgezeilen eines Testfalls: nur Schlüssel (zur Zuordnung) und Schrittspalten
      const lead: Cell[] = i === 0 ? base : [t.key, ...base.slice(1).map(() => '')];
      // Abschnitt (J1): ohne Nummer, Aktion „▸ Abschnitt: Titel“ – wird beim Import wieder zum Abschnitt
      if (isGroup(s)) rows.push([...lead, '', `${GROUP_PREFIX}${groupTitle(s as { title?: string | null })}`, (s as { note?: string | null }).note ?? '', '']);
      else rows.push([...lead, nos[i]!, s.action, s.data, s.expected]);
    });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    return { fileName: `Testfaelle-${projectKey}-${stamp}.csv`, contentType: 'text/csv; charset=utf-8', body: writeCsv(header, rows) };
  }
  return {
    fileName: `Testfaelle-${projectKey}-${stamp}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: await writeXlsx([{ name: 'Testfälle', header, rows }]),
  };
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

/** Ziele der Spaltenzuordnung mit erkannten Spaltennamen (deutsch, englisch, Zephyr Squad/Scale, Xray). */
export const TARGETS: { id: string; label: string; aliases: string[] }[] = [
  { id: 'key', label: 'Schlüssel (zum Aktualisieren)', aliases: ['schlüssel', 'key', 'testfall-schlüssel', 'test case key', 'issue key', 'vorgangsschlüssel', 'testcase key', 'tcid'] },
  { id: 'title', label: 'Titel', aliases: ['titel', 'title', 'name', 'summary', 'zusammenfassung', 'testfall', 'test case', 'test name'] },
  { id: 'folder', label: 'Ordner (Pfad mit /)', aliases: ['ordner', 'folder', 'pfad', 'path', 'test repository path', 'repository path'] },
  { id: 'status', label: 'Status', aliases: ['status'] },
  { id: 'priority', label: 'Priorität', aliases: ['priorität', 'prioritaet', 'priority', 'prio'] },
  { id: 'labels', label: 'Labels', aliases: ['labels', 'label', 'stichwörter', 'tags'] },
  { id: 'components', label: 'Komponenten', aliases: ['komponenten', 'komponente', 'component', 'components', 'component/s'] },
  { id: 'owner', label: 'Owner', aliases: ['owner', 'verantwortlich', 'assignee', 'bearbeiter'] },
  { id: 'estimate', label: 'Schätzung (Minuten)', aliases: ['schätzung (min.)', 'schätzung', 'aufwand', 'estimate', 'estimated time', 'geschätzte zeit', 'originalschätzung'] },
  { id: 'objective', label: 'Ziel / Beschreibung', aliases: ['ziel', 'objective', 'beschreibung', 'description'] },
  { id: 'preconditions', label: 'Vorbedingungen', aliases: ['vorbedingungen', 'vorbedingung', 'precondition', 'preconditions'] },
  { id: 'testData', label: 'Testdaten (Testfall)', aliases: ['testdaten', 'test data (test case)'] },
  { id: 'format', label: 'Format (Klassisch/Gherkin/Freitext)', aliases: ['format', 'test type', 'testtyp'] },
  { id: 'plainText', label: 'Testanweisung (Freitext)', aliases: ['testanweisung (freitext)', 'testanweisung', 'freitext', 'generic definition', 'unstructured definition', 'test script (plain text)'] },
  { id: 'gherkin', label: 'Gherkin', aliases: ['gherkin', 'scenario', 'szenario', 'test script (bdd)', 'cucumber scenario'] },
  { id: 'step.no', label: 'Schritt-Nr. (nur Reihenfolge)', aliases: ['schritt', 'schritt-nr', 'step #', 'step no', 'nr'] },
  { id: 'step.action', label: 'Schritt: Aktion', aliases: ['aktion', 'action', 'step', 'schrittbeschreibung', 'test script (step-by-step) - step', 'test step'] },
  { id: 'step.data', label: 'Schritt: Testdaten', aliases: ['schritt-testdaten', 'data', 'test data', 'testdaten (schritt)', 'test script (step-by-step) - test data'] },
  { id: 'step.expected', label: 'Schritt: Erwartetes Ergebnis', aliases: ['erwartetes ergebnis', 'erwartung', 'expected result', 'result', 'expected', 'test script (step-by-step) - expected result'] },
  { id: 'ignore', label: '– nicht übernehmen –', aliases: ['jira-schlüssel', 'version'] },
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export interface ImportFile { fileName: string; contentBase64: string; sheet?: number | undefined }

/** Datei lesen: XLSX (Tabellenblatt wählbar) oder CSV. */
export function readTable(f: ImportFile): { sheets: string[]; rows: string[][] } {
  const buf = Buffer.from(f.contentBase64, 'base64');
  if (!buf.length) throw badRequest('Datei ist leer');
  if (buf.length > 20 * 1024 * 1024) throw badRequest('Datei zu groß (max. 20 MB)');
  if (buf.subarray(0, 2).toString() === 'PK' || /\.xlsx$/i.test(f.fileName)) {
    let sheets;
    try { sheets = readXlsx(buf); } catch (e) { throw badRequest(`Excel-Datei nicht lesbar: ${(e as Error).message}`); }
    const s = sheets[f.sheet ?? 0];
    if (!s) throw badRequest('Tabellenblatt nicht gefunden');
    return { sheets: sheets.map((x) => x.name), rows: s.rows };
  }
  if (/\.xls$/i.test(f.fileName)) throw badRequest('Das alte Excel-Format .xls wird nicht unterstützt – bitte als .xlsx oder .csv speichern.');
  return { sheets: [], rows: parseCsv(decodeText(buf)) };
}

export async function previewImport(db: Db, projectId: string, f: ImportFile) {
  const { sheets, rows } = readTable(f);
  const header = (rows[0] ?? []).map((h) => h.trim());
  const defs = await fieldDefinitions(db, 'test_case', projectId);
  const targets = [...TARGETS, ...defs.map((d) => ({ id: `field:${d.key}`, label: `Feld: ${d.name}`, aliases: [`feld: ${d.name}`.toLowerCase(), d.name.toLowerCase(), d.key.toLowerCase()] }))];
  const used = new Set<string>();
  const mapping: Record<number, string> = {};
  header.forEach((h, i) => {
    const n = norm(h);
    const t = targets.find((x) => !used.has(x.id) && x.id !== 'ignore' && x.aliases.includes(n)) ?? (TARGETS.find((x) => x.id === 'ignore')!.aliases.includes(n) ? { id: 'ignore' } : null);
    if (t) { mapping[i] = t.id; if (t.id !== 'ignore') used.add(t.id); }
  });
  return {
    sheets, header, mapping, rowCount: Math.max(0, rows.length - 1),
    sample: rows.slice(1, 21),
    targets: targets.map(({ id, label }) => ({ id, label })),
  };
}

export const ImportOptions = z.object({
  mapping: z.record(z.string(), z.string()),
  mode: z.enum(['create', 'upsert']).default('upsert'),
  folderId: z.uuid().nullish(),
  dryRun: z.boolean().default(false),
  changeNote: z.string().max(500).nullish(),
});

interface Pending {
  row: number; key: string; values: Record<string, string>; steps: { action: string; data: string; expected: string }[];
}
export interface ImportResult {
  dryRun: boolean; created: number; updated: number; unchanged: number; failed: number;
  items: { row: number; key: string | null; title: string; action: 'created' | 'updated' | 'unchanged' | 'failed'; message?: string }[];
}

class DryRun extends Error {}

/** Schätzung aus Zahl (Minuten) oder Angaben wie „1h 30m“, „90 min“, „1,5 h“, „2d“ (Arbeitstag = 8 h). */
export function parseEstimate(s: string): number {
  const t = s.trim().toLowerCase().replace(',', '.');
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  let total = 0;
  let matched = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(w|d|t|h|std|m|min)\w*/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'w' ? n * 5 * 8 * 60 : m[2] === 'd' || m[2] === 't' ? n * 8 * 60 : m[2] === 'h' || m[2] === 'std' ? n * 60 : n;
  }
  if (!matched) throw badRequest(`Schätzung „${s}“ nicht lesbar (z. B. 90, 1h 30m, 1,5 h)`);
  return Math.round(total);
}

export async function importTestCases(db: Db, projectId: string, f: ImportFile, o: z.infer<typeof ImportOptions>, actor: string): Promise<ImportResult> {
  const { rows } = readTable(f);
  const mapping = Object.entries(o.mapping).filter(([, t]) => t && t !== 'ignore').map(([i, t]) => [Number(i), t] as const);
  const cols = (target: string) => mapping.filter(([, t]) => t === target).map(([i]) => i);
  if (!cols('title').length && !(o.mode === 'upsert' && cols('key').length)) throw badRequest('Bitte eine Spalte als „Titel“ zuordnen (bzw. „Schlüssel“ zum Aktualisieren).');
  // Zeilen zu Testfällen gruppieren: neuer Testfall bei Titel oder neuem Schlüssel; sonst Folgezeile mit weiterem Schritt
  const cases: Pending[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const val = (target: string) => cols(target).map((i) => (row[i] ?? '').trim()).filter(Boolean).join('\n');
    if (mapping.every(([i]) => !(row[i] ?? '').trim())) continue;
    const key = val('key').toUpperCase();
    const title = val('title');
    const cur = cases.at(-1);
    if (!cur || title || (key && key !== cur.key)) {
      const values: Record<string, string> = {};
      for (const [, t] of mapping) if (!t.startsWith('step.')) values[t] = val(t);
      cases.push({ row: r + 1, key, values, steps: [] });
    }
    const step = { action: val('step.action'), data: val('step.data'), expected: val('step.expected') };
    if (step.action || step.data || step.expected) cases.at(-1)!.steps.push(importedStep(step));
  }
  if (cases.length > 5000) throw badRequest(`Zu viele Testfälle (${cases.length}) – höchstens 5000 je Import`);
  const stepColumns = cols('step.action').length + cols('step.data').length + cols('step.expected').length > 0;

  const statuses = await db<{ code: string; name: string; category: string; active: boolean }[]>`select code, name, category, active from test_case_status`;
  const folders = await listFolders(db, projectId);
  const basePath = (() => { const out: string[] = []; let id = o.folderId ?? null; while (id) { const f2 = folders.find((x) => x.id === id); if (!f2) break; out.unshift(f2.name); id = f2.parentId; } return out; })();
  const list = (s: string | undefined) => (s ?? '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  const result: ImportResult = { dryRun: o.dryRun, created: 0, updated: 0, unchanged: 0, failed: 0, items: [] };
  const run = async (tx: Db) => {
    for (const c of cases) {
      const v = c.values;
      const title = v.title ?? '';
      try {
        await tx`savepoint imp`;
        const has = (t: string) => cols(t).length > 0;
        let status: string | undefined;
        if (has('status') && v.status) {
          const s = statuses.find((x) => x.code.toLowerCase() === v.status!.toLowerCase() || x.name.toLowerCase() === v.status!.toLowerCase());
          if (!s) throw badRequest(`Unbekannter Status „${v.status}“`);
          status = s.code;
        }
        const priority = has('priority') && v.priority ? await checkPriority(tx, v.priority) : undefined;
        const fieldVals: Record<string, unknown> = {};
        for (const [, t] of mapping) if (t.startsWith('field:') && v[t]) fieldVals[t.slice(6)] = v[t];
        const format = has('gherkin') && v.gherkin ? 'GHERKIN' : has('format') && /gherkin|bdd|cucumber/i.test(v.format ?? '') ? 'GHERKIN'
          : has('plainText') && v.plainText && !c.steps.length ? 'PLAIN' : has('format') && /freitext|plain|generic|unstruct/i.test(v.format ?? '') ? 'PLAIN' : undefined;
        const folderId = has('folder') && v.folder
          ? await ensureFolderPath(tx, projectId, [...basePath, ...v.folder.split(/[/\\>]/).map((x) => x.trim()).filter(Boolean)])
          : undefined;
        const existing = o.mode === 'upsert' && c.key
          ? (await tx<{ id: string }[]>`select id from test_case where project_id = ${projectId} and (key = ${c.key} or legacy_key = ${c.key}) limit 1`)[0]
          : undefined;
        if (o.mode === 'upsert' && c.key && !existing && !title) throw badRequest(`Schlüssel ${c.key} nicht gefunden und kein Titel zum Anlegen`);
        if (existing) {
          const t = await getTestCase(tx, existing.id);
          const cur = t.version;
          // nur zugeordnete, nicht leere Spalten ändern; Schritte nur, wenn Schrittspalten zugeordnet und Schritte vorhanden
          const fields = Object.keys(fieldVals).length ? await validateCustomFields(tx, 'test_case', projectId, { ...cur.customFields, ...fieldVals }, { previous: cur.customFields }) : cur.customFields;
          const content: TestCaseContentInput = {
            ...cur,
            title: title || cur.title,
            objective: v.objective || cur.objective, preconditions: v.preconditions || cur.preconditions, testData: v.testData || cur.testData,
            priority: priority ?? cur.priority,
            labels: has('labels') && v.labels ? list(v.labels) : cur.labels,
            components: has('components') && v.components ? list(v.components) : cur.components,
            format: format ?? cur.format, gherkin: v.gherkin || cur.gherkin, plainText: v.plainText || cur.plainText,
            steps: stepColumns && c.steps.length ? c.steps.map((s, i) => ({ ...s, id: cur.steps[i]?.id })) : cur.steps,
            customFields: fields,
          };
          const r = await reviseTestCase(tx, existing.id, content, o.changeNote || `Import aus ${f.fileName}`, actor);
          const estimate = has('estimate') && v.estimate ? parseEstimate(v.estimate) : undefined;
          const metaChanged = (status && status !== t.status) || (folderId !== undefined && folderId !== t.folderId) || (has('owner') && v.owner && v.owner !== t.owner)
            || (estimate !== undefined && estimate !== (t.estimateMinutes ?? null));
          if (metaChanged) await updateTestCaseMeta(tx, existing.id, { status, folderId, owner: has('owner') && v.owner ? v.owner : undefined, estimateMinutes: estimate }, actor, { enforceWorkflow: true });
          const changed = r.changed || metaChanged;
          result.items.push({ row: c.row, key: t.key, title: content.title, action: changed ? 'updated' : 'unchanged' });
          if (changed) result.updated++; else result.unchanged++;
        } else {
          if (!title) throw badRequest('Titel fehlt');
          if (status && statuses.find((s) => s.code === status)?.category === 'APPROVED') {
            throw badRequest('Freigegeben ist beim Anlegen nicht möglich (Vier-Augen-Prinzip) – bitte ohne Status bzw. als Entwurf importieren');
          }
          const fields = await validateCustomFields(tx, 'test_case', projectId, fieldVals);
          const tc = await createTestCase(tx, {
            projectId, folderId: folderId ?? o.folderId ?? null, status, owner: v.owner || null,
            content: {
              title, objective: v.objective || null, preconditions: v.preconditions || null, testData: v.testData || null,
              priority: priority ?? (await tx<{ code: string }[]>`select code from priority where is_default and active`)[0]?.code ?? null,
              labels: list(v.labels), components: list(v.components), format: format ?? 'CLASSIC', gherkin: v.gherkin || null, plainText: v.plainText || null,
              steps: c.steps, customFields: fields,
            },
            changeNote: o.changeNote || `Import aus ${f.fileName}`,
          }, actor);
          if (has('estimate') && v.estimate) await updateTestCaseMeta(tx, tc.id, { estimateMinutes: parseEstimate(v.estimate) }, actor);
          result.items.push({ row: c.row, key: tc.key, title, action: 'created' });
          result.created++;
        }
        await tx`release savepoint imp`;
      } catch (e) {
        await tx`rollback to savepoint imp`;
        result.failed++;
        result.items.push({ row: c.row, key: c.key || null, title, action: 'failed', message: (e as Error).message });
      }
    }
    if (o.dryRun) throw new DryRun();
  };
  try {
    await db.begin((tx) => run(tx as unknown as Db));
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  return result;
}

/** Kennzeichnung eines Abschnitts in Excel/CSV (Spalte Aktion) */
const GROUP_PREFIX = '▸ Abschnitt: ';

/** Importierter Schritt: „▸ Abschnitt: Titel“ bzw. Pfeil-Trennschritt aus Zephyr-Exporten wird Abschnitt (J1). */
function importedStep(s: { action: string; data: string; expected: string }) {
  if (s.action.startsWith(GROUP_PREFIX.trim()) && !s.expected) {
    return { kind: 'group' as const, title: s.action.slice(GROUP_PREFIX.trim().length).trim(), note: s.data || null, action: '', data: '', expected: '' };
  }
  return convertStep(s);
}
