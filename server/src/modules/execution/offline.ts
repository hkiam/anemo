/**
 * Offline-/Excel-Rundlauf (Stufe I): Ausführungen eines Zyklus als Arbeitsmappe ausgeben, ohne Anemo ausfüllen
 * (z. B. in einer abgeschotteten Testumgebung) und die Ergebnisse wieder einlesen. Jede Zeile trägt die ID der
 * Ausführung und ihren Ergebnisstand; wurde inzwischen in Anemo ein Ergebnis gespeichert, wird die Zeile als Konflikt
 * gemeldet und nicht überschrieben. Parametrisierte Tests werden je Durchlauf erfasst (Blatt „Durchläufe“).
 * Einlesen mit Probelauf; jede Zeile einzeln (Fehler einer Zeile stoppen nicht alles).
 */
import { checkSteps, groupTitle, isGroup, stepNumbers } from '../../../../shared/steps/groups.ts';
import { type Db, inTx } from '../../platform/db.ts';
import { badRequest } from '../../platform/http.ts';
import { readXlsx, writeXlsx } from '../../platform/xlsx.ts';
import { deriveOverall } from '../../../../shared/status/status.ts';
import { type Dataset, effectiveDataset, getVersionById, resolveExecutionSteps, type Step, type TestCaseVersion } from '../testcases/index.ts';
import { assertMayRecord, defectKey, executeTest, getCycle, getExecution, queryExecutions, type StepResult, withSavepoint } from './service.ts';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const EXEC_HEADER = ['Ausführungs-ID', 'Stand', 'Schlüssel', 'Titel', 'Version', 'Zuständig', 'Bisheriger Status', 'Neuer Status', 'Kommentar', 'Fehler (Schlüssel)', 'Dauer (Min.)'];
const STEP_HEADER = ['Ausführungs-ID', 'Schlüssel', 'Schritt', 'Schritt-ID', 'Aktion', 'Testdaten', 'Erwartetes Ergebnis', 'Bisheriger Status', 'Neuer Status', 'Befund'];
const ITER_HEADER = ['Ausführungs-ID', 'Schlüssel', 'Durchlauf', 'Datenwerte', 'Bisheriger Status', 'Neuer Status', 'Kommentar'];
const NO_RESULT = '0';

interface StatusRow { code: string; name: string; category: string; appliesTo: string; active: boolean }

/**
 * „Stand“ einer Ausführung für die Konflikterkennung: ID des letzten gespeicherten Ergebnisses (0 = noch keins).
 * Anders als `updated_at` ändert er sich nur bei Ergebnisänderungen – Zuweisen, Verteilen oder eigene Felder machen
 * eine ausgegebene Arbeitsmappe nicht ungültig (Review Teil 3, Befund 7).
 */
async function resultStands(db: Db, ids: string[]): Promise<Map<string, { id: string; at: Date }>> {
  if (!ids.length) return new Map();
  const rows = await db<{ executionId: string; id: string; at: Date }[]>`
    select distinct on (execution_id) execution_id, id::text as id, recorded_at as at from execution_result
    where execution_id = any(${ids}::uuid[]) order by execution_id, id desc`;
  return new Map(rows.map((r) => [r.executionId, { id: r.id, at: r.at }]));
}

export async function exportOffline(db: Db, cycleId: string, o: { assignee?: string | undefined; onlyOpen?: boolean | undefined }) {
  const cycle = await getCycle(db, cycleId);
  const statuses = await db<StatusRow[]>`select code, name, category, applies_to, active from execution_status order by sort_order, code`;
  const name = (c: string) => statuses.find((s) => s.code === c)?.name ?? c;
  const items: Awaited<ReturnType<typeof queryExecutions>>['items'] = [];
  for (let offset = 0; offset < 5000; offset += 500) {
    const page = await queryExecutions(db, { cycleId, assignee: o.assignee, limit: 500, offset, sort: 'order' });
    items.push(...page.items);
    if (page.items.length < 500) break;
  }
  const open = new Set(statuses.filter((s) => s.category === 'OPEN' || s.category === 'IN_PROGRESS').map((s) => s.code));
  const list = o.onlyOpen ? items.filter((e) => open.has(e.status)) : items;
  // gebündelt laden statt getExecution je Zeile (Review Teil 3, Befund 21): Stand, Schritte je Version, Datensätze
  const stands = await resultStands(db, list.map((e) => e.id));
  const versions = new Map<string, { version: TestCaseVersion; steps: Step[] }>();
  for (const vid of new Set(list.map((e) => e.testCaseVersionId))) {
    const version = await getVersionById(db, vid);
    versions.set(vid, { version, steps: await resolveExecutionSteps(db, version) });
  }
  const overrides = await db<{ scope: 'plan' | 'cycle'; testCaseId: string; dataset: Dataset }[]>`
    select scope, test_case_id, dataset from dataset_override
    where (scope = 'cycle' and scope_id = ${cycleId}) or (scope = 'plan' and scope_id = ${cycle.planId ?? null}::uuid)`;
  const datasetOf = (testCaseId: string, version: TestCaseVersion) =>
    overrides.find((x) => x.scope === 'cycle' && x.testCaseId === testCaseId)?.dataset
      ?? overrides.find((x) => x.scope === 'plan' && x.testCaseId === testCaseId)?.dataset ?? effectiveDataset(version);
  const execRows: (string | number | null)[][] = [];
  const stepRows: (string | number | null)[][] = [];
  const iterRows: (string | number | null)[][] = [];
  for (const e of list) {
    const { version, steps } = versions.get(e.testCaseVersionId)!;
    execRows.push([e.id, stands.get(e.id)?.id ?? NO_RESULT, e.testCaseKey, e.title, e.versionNo, e.assignee, name(e.status), '', '', '', '']);
    const res = new Map(e.stepResults.map((r) => [r.stepId, r]));
    // Abschnitte (J1): Zwischenzeile ohne Nummer und ohne Ergebnis; Einträge dort werden beim Einlesen ignoriert
    const nos = stepNumbers(steps);
    steps.forEach((s, i) => {
      const r = res.get(s.id!);
      if (isGroup(s)) stepRows.push([e.id, e.testCaseKey, '', s.id ?? '', `▸ Abschnitt: ${groupTitle(s as { title?: string | null })}`, '', '', '', '', '']);
      else stepRows.push([e.id, e.testCaseKey, nos[i]!, s.id ?? '', s.action, s.data, s.expected, r ? name(r.status) : '', '', '']);
    });
    // parametrisierte Tests: je Datenzeile ein Durchlauf mit Werten, bisherigem Status und Kommentar
    const ds = datasetOf(e.testCaseId, version);
    if (ds?.rows.length) {
      const prev = new Map((e.iterations ?? []).map((it) => [it.index, it]));
      ds.rows.forEach((row, k) => {
        const it = prev.get(k);
        // Eingabespalten bleiben leer (wie im Blatt „Ausführungen“) – der bisherige Befund steht beim bisherigen Status
        iterRows.push([e.id, e.testCaseKey, k + 1, ds.columns.map((c, j) => `${c}=${row[j] ?? ''}`).join('; '), it ? `${name(it.status)}${it.comment ? ` – ${it.comment}` : ''}` : '', '', '']);
      });
    }
  }
  const usable = statuses.filter((s) => s.active);
  const body = await writeXlsx([
    { name: 'Ausführungen', header: EXEC_HEADER, rows: execRows, widths: [10, 10, 12, 50, 8, 14, 18, 18, 40, 20, 10] },
    { name: 'Schritte', header: STEP_HEADER, rows: stepRows, widths: [10, 12, 8, 10, 50, 30, 50, 18, 18, 40] },
    { name: 'Durchläufe', header: ITER_HEADER, rows: iterRows, widths: [10, 12, 10, 50, 18, 18, 40] },
    { name: 'Statuswerte', header: ['Status', 'für', 'Kategorie'], rows: usable.map((s) => [s.name, s.appliesTo === 'step' ? 'nur Schritte' : s.appliesTo === 'execution' ? 'nur Ausführungen' : 'beides', s.category]) },
    { name: 'Hinweise', header: ['Hinweis'], rows: [
      [`Zyklus „${cycle.name}“ – ausgegeben ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`],
      ['Nur die Spalten „Neuer Status“, „Kommentar“, „Fehler (Schlüssel)“, „Dauer (Min.)“, im Blatt „Schritte“ „Neuer Status“ und „Befund“ sowie im Blatt „Durchläufe“ „Neuer Status“ und „Kommentar“ ausfüllen.'],
      ['Statuswerte wie im Blatt „Statuswerte“. Fehlt der neue Gesamtstatus, wird er aus den Schritten bzw. Durchläufen abgeleitet.'],
      ['Parametrisierte Tests (mit Datensatz) werden je Durchlauf im Blatt „Durchläufe“ erfasst; der Gesamtstatus muss zu den Durchläufen passen.'],
      ['Ein Gesamtstatus, der den Schritt- bzw. Durchlaufergebnissen widerspricht, wird nicht übernommen – Abweichungen bitte in Anemo mit Begründung erfassen.'],
      ['Spalten „Ausführungs-ID“, „Stand“, „Schritt-ID“ und „Durchlauf“ nicht ändern – sie ordnen die Zeilen beim Einlesen zu und erkennen Änderungen in Anemo.'],
      ['Einlesen: Zyklus → ⋯ Mehr → ⇅ Excel-Rundlauf… → 2. Einlesen (zuerst Probelauf, dann „Übernehmen“).'],
    ] },
  ]);
  const safe = cycle.name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60);
  return { fileName: `Offline-${safe}-${new Date().toISOString().slice(0, 10)}.xlsx`, contentType: XLSX, body };
}

export interface OfflineResult {
  dryRun: boolean; updated: number; unchanged: number; conflicts: number; errors: number;
  items: { key: string; action: 'updated' | 'unchanged' | 'conflict' | 'error'; message?: string; status?: string }[];
}

class DryRun extends Error {}

/**
 * Ergebnisse aus der Arbeitsmappe übernehmen. `isLead`: Pflegerecht (Regel „nur Zuständige“ gilt dann nicht);
 * `force`: auch Ausführungen überschreiben, die seit der Ausgabe in Anemo geändert wurden bzw. keinen gültigen Stand tragen.
 */
export async function importOffline(db: Db, cycleId: string, file: Buffer, actor: string,
  o: { dryRun: boolean; force?: boolean | undefined; isLead: boolean; requireEvidence: boolean }): Promise<OfflineResult> {
  let sheets: { name: string; rows: string[][] }[];
  // Meldung des Lesers (z. B. Grenzen überschritten, XlsxError) durchreichen statt pauschal „nicht lesbar“
  try { sheets = readXlsx(file); } catch (e) { throw badRequest(`Keine lesbare Excel-Arbeitsmappe (.xlsx): ${(e as Error).message}`); }
  const execSheet = sheets.find((s) => s.name === 'Ausführungen');
  if (!execSheet) throw badRequest('Blatt „Ausführungen“ fehlt – bitte die von Anemo ausgegebene Arbeitsmappe verwenden');
  const stepSheet = sheets.find((s) => s.name === 'Schritte');
  const iterSheet = sheets.find((s) => s.name === 'Durchläufe');
  const cols = (header: string[] | undefined, names: string[]) => {
    const idx = Object.fromEntries(names.map((n) => [n, (header ?? []).findIndex((h) => h.trim() === n)]));
    const missing = names.filter((n) => idx[n]! < 0);
    if (missing.length) throw badRequest(`Spalten fehlen: ${missing.join(', ')}`);
    return idx as Record<string, number>;
  };
  const ec = cols(execSheet.rows[0], EXEC_HEADER);
  const sc = stepSheet ? cols(stepSheet.rows[0], STEP_HEADER) : null;
  const ic = iterSheet ? cols(iterSheet.rows[0], ITER_HEADER) : null;
  const statuses = await db<StatusRow[]>`select code, name, category, applies_to, active from execution_status`;
  const lookup = (v: string, purpose: 'execution' | 'step') => {
    const t = v.trim().toLowerCase();
    if (!t) return null;
    const s = statuses.find((x) => x.name.toLowerCase() === t || x.code.toLowerCase() === t);
    if (!s) throw badRequest(`Unbekannter Status „${v}“`);
    if (s.appliesTo === (purpose === 'execution' ? 'step' : 'execution')) throw badRequest(`Status „${s.name}“ gilt nicht für ${purpose === 'execution' ? 'Ausführungen' : 'Schritte'}`);
    return s.code;
  };
  const cell = (r: string[], i: number | undefined) => (r[i!] ?? '').trim();
  // Schritteingaben je Ausführung
  const stepInput = new Map<string, { stepId: string; status: string; comment: string }[]>();
  for (const r of stepSheet?.rows.slice(1) ?? []) {
    const id = cell(r, sc!['Ausführungs-ID']);
    const status = cell(r, sc!['Neuer Status']);
    const comment = cell(r, sc!['Befund']);
    if (!id || (!status && !comment)) continue;
    (stepInput.get(id) ?? stepInput.set(id, []).get(id)!).push({ stepId: cell(r, sc!['Schritt-ID']), status, comment });
  }
  // Durchlaufeingaben je Ausführung (Durchlauf 1-basiert wie ausgegeben)
  const iterInput = new Map<string, { no: string; status: string; comment: string }[]>();
  for (const r of iterSheet?.rows.slice(1) ?? []) {
    const id = cell(r, ic!['Ausführungs-ID']);
    const status = cell(r, ic!['Neuer Status']);
    const comment = cell(r, ic!['Kommentar']);
    if (!id || (!status && !comment)) continue;
    (iterInput.get(id) ?? iterInput.set(id, []).get(id)!).push({ no: cell(r, ic!['Durchlauf']), status, comment });
  }
  const cat = (c: string) => statuses.find((x) => x.code === c)?.category;
  const usable = (c: string) => statuses.find((x) => x.code === c)?.appliesTo !== 'step';
  const result: OfflineResult = { dryRun: o.dryRun, updated: 0, unchanged: 0, conflicts: 0, errors: 0, items: [] };
  const run = async (tx: Db) => {
    for (const r of execSheet.rows.slice(1)) {
      const id = cell(r, ec['Ausführungs-ID']);
      if (!id) continue;
      const key = cell(r, ec['Schlüssel']) || id;
      const newStatus = cell(r, ec['Neuer Status']);
      const comment = cell(r, ec['Kommentar']);
      const defects = (r[ec['Fehler (Schlüssel)']!] ?? '').split(/[,;\s]+/).map((x) => x.trim().replace(/^#/, '')).filter(Boolean);
      const minutes = Number((cell(r, ec['Dauer (Min.)']) || '0').replace(',', '.'));
      const steps = stepInput.get(id) ?? [];
      const iters = iterInput.get(id) ?? [];
      if (!newStatus && !comment && !defects.length && !steps.length && !iters.length) continue;
      // je Zeile ein Savepoint (postgres.js): Fehler einer Zeile – auch der Datenbank – verwerfen nur diese Zeile
      try {
        const item = await withSavepoint(tx, async (sp) => {
          // Zeile sperren: Konfliktprüfung und Schreiben ohne Zeitfenster dazwischen
          const [row] = await sp<{ cycleId: string; updatedAt: Date }[]>`select cycle_id, updated_at from test_execution
            where id = ${/^[0-9a-f-]{36}$/i.test(id) ? id : '00000000-0000-0000-0000-000000000000'} for update`;
          if (!row || row.cycleId !== cycleId) throw badRequest('Ausführung gehört nicht zu diesem Zyklus');
          if (!o.force) {
            const stand = cell(r, ec['Stand']);
            const last = (await resultStands(sp, [id])).get(id);
            let changed: boolean;
            if (/^\d+$/.test(stand)) changed = (last?.id ?? NO_RESULT) !== stand;
            else if (stand && !Number.isNaN(new Date(stand).getTime())) changed = !!last && new Date(last.at).getTime() > new Date(stand).getTime() + 999; // ältere Mappen: Zeitstempel
            else throw badRequest(stand ? `Spalte „Stand“ ungültig („${stand.slice(0, 40)}“) – Zeile nicht übernommen; bitte die ausgegebene Arbeitsmappe verwenden oder bewusst überschreiben`
              : 'Spalte „Stand“ leer – ohne Stand ist keine Konfliktprüfung möglich; bitte die ausgegebene Arbeitsmappe verwenden oder bewusst überschreiben');
            if (changed) return { key, action: 'conflict' as const, message: 'seit der Ausgabe in Anemo geändert – nicht überschrieben' };
          }
          await assertMayRecord(sp, [id], actor, o.isLead);
          const cur = await getExecution(sp, id);
          const ds = cur.dataset?.rows.length ? cur.dataset : null;
          const known = new Set(cur.steps.map((s) => s.id));
          const stepResults = [...cur.stepResults];
          if (ds && steps.length) throw badRequest('Parametrisierter Test: Ergebnisse bitte je Durchlauf im Blatt „Durchläufe“ erfassen, nicht im Blatt „Schritte“');
          if (!ds && iters.length) throw badRequest('Kein parametrisierter Test – Angaben im Blatt „Durchläufe“ passen nicht zu dieser Ausführung');
          const groupIds = new Set(cur.steps.filter(isGroup).map((s) => s.id));
          for (const s of steps) {
            if (!known.has(s.stepId)) throw badRequest(`Schritt-ID ${s.stepId || '(leer)'} gehört nicht zur Ausführung`);
            if (groupIds.has(s.stepId)) continue; // Abschnitt: kein Ergebnis
            const i = stepResults.findIndex((x) => x.stepId === s.stepId);
            const prev = i >= 0 ? stepResults[i]! : { stepId: s.stepId, status: 'NOT_EXECUTED' };
            const next = { ...prev, status: lookup(s.status, 'step') ?? prev.status, ...(s.comment ? { comment: s.comment } : {}) };
            if (i >= 0) stepResults[i] = next; else stepResults.push(next);
          }
          // Durchläufe zusammenführen: bisherige bleiben, eingetragene ersetzen Status/Kommentar; unveränderte zählen nicht
          let iterations: { index: number; status: string; comment: string | null; stepResults: StepResult[] }[] | undefined;
          if (ds && iters.length) {
            const merged = new Map(cur.iterations.map((it) => [it.index, { index: it.index, status: it.status, comment: it.comment ?? null, stepResults: it.stepResults }]));
            let changedIter = false;
            for (const it of iters) {
              const no = Number(it.no);
              if (!Number.isInteger(no) || no < 1 || no > ds.rows.length) throw badRequest(`Durchlauf „${it.no}“ gibt es nicht (Datensatz mit ${ds.rows.length} Zeilen)`);
              const prev = merged.get(no - 1);
              const next = { index: no - 1, status: lookup(it.status, 'execution') ?? prev?.status ?? 'NOT_EXECUTED', comment: it.comment || prev?.comment || null, stepResults: prev?.stepResults ?? [] };
              if (next.status !== (prev?.status ?? 'NOT_EXECUTED') || next.comment !== (prev?.comment ?? null)) changedIter = true;
              merged.set(no - 1, next);
            }
            if (changedIter) iterations = [...merged.values()].sort((a, b) => a.index - b.index);
          }
          const explicit = lookup(newStatus, 'execution');
          let overall: string;
          if (ds) {
            const all = ds.rows.map((_, k) => (iterations ?? cur.iterations).find((i) => i.index === k)?.status ?? 'NOT_EXECUTED');
            overall = explicit ?? (iterations ? deriveOverall(all, cat, usable) : cur.status);
            // Ein abschließender Gesamtstatus ohne einen einzigen erfassten Durchlauf wäre unbelegt (Review Teil 3, Befund 5)
            if (explicit && !['OPEN', 'IN_PROGRESS', 'INVALID'].includes(cat(explicit) ?? 'OPEN') && !all.some((c) => !['OPEN', 'IN_PROGRESS'].includes(cat(c) ?? 'OPEN'))) {
              throw badRequest('Parametrisierter Test: bitte die Ergebnisse je Durchlauf im Blatt „Durchläufe“ eintragen – der Gesamtstatus wird daraus abgeleitet');
            }
          } else {
            overall = explicit ?? (steps.some((s) => s.status) ? deriveOverall(checkSteps(cur.steps).map((s) => stepResults.find((x) => x.stepId === s.id)?.status ?? 'NOT_EXECUTED'), cat, usable) : cur.status);
          }
          const same = overall === cur.status && (!comment || comment === cur.comment) && !defects.length && !steps.length && !iterations;
          if (same) return { key, action: 'unchanged' as const };
          await executeTest(sp, id, {
            status: overall, comment: comment || cur.comment, stepResults, iterations,
            defects: await Promise.all(defects.map((k) => defectKey(k))),
            durationSeconds: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : undefined,
            // Stand unter Zeilensperre gelesen – schützt zusätzlich, falls executeTest künftig ohne diese Sperre aufgerufen wird
            expectedUpdatedAt: new Date(row.updatedAt).toISOString(),
          }, actor, { requireEvidence: o.requireEvidence });
          return { key, action: 'updated' as const, status: statuses.find((s) => s.code === overall)?.name ?? overall };
        });
        if (item.action === 'conflict') result.conflicts++;
        else if (item.action === 'unchanged') result.unchanged++;
        else result.updated++;
        result.items.push(item);
      } catch (e) {
        result.errors++;
        result.items.push({ key, action: 'error', message: (e as Error).message });
      }
    }
    if (o.dryRun) throw new DryRun();
  };
  try {
    await inTx(db, run);
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  return result;
}
