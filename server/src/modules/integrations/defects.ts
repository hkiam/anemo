/** Fehlermeldungen aus Ausführungen: Vorlagen, Entwurf, Anlage im Fremdsystem (B2-Vorbereitung, ADR-0015). */
import { groupTitle, isGroup, stepNumbers } from '../../../../shared/steps/groups.ts';
import type { Db } from '../../platform/db.ts';
import { badRequest, notFound } from '../../platform/http.ts';
import { listAttachments } from '../attachments/index.ts';
import { getCycle, getExecution, listStatuses, loadDimensions } from '../execution/index.ts';
import { plainTitle, type TemplateData, renderTemplate } from './template.ts';
import { wikiSummary, wikiToText } from '../../../../shared/wiki/text.ts';
import { goPath } from '../../platform/links.ts';

export interface DefectTemplate { id: string; projectId: string | null; name: string; titleTemplate: string; bodyTemplate: string; isDefault: boolean }

export async function listTemplates(db: Db, projectId: string | null): Promise<DefectTemplate[]> {
  return db<DefectTemplate[]>`
    select id, project_id, name, title_template, body_template, is_default from defect_template
    where project_id is null ${projectId ? db`or project_id = ${projectId}` : db``}
    order by (project_id is null), is_default desc, name`;
}

export async function saveTemplate(db: Db, id: string | null, t: Omit<DefectTemplate, 'id'>): Promise<{ id: string }> {
  if (t.isDefault) await db`update defect_template set is_default = false where project_id is not distinct from ${t.projectId}`;
  if (id) {
    const r = await db`update defect_template set project_id = ${t.projectId}, name = ${t.name}, title_template = ${t.titleTemplate},
      body_template = ${t.bodyTemplate}, is_default = ${t.isDefault} where id = ${id}`;
    if (r.count === 0) throw notFound('Vorlage', id);
    return { id };
  }
  const [row] = await db<{ id: string }[]>`insert into defect_template(project_id, name, title_template, body_template, is_default)
    values (${t.projectId}, ${t.name}, ${t.titleTemplate}, ${t.bodyTemplate}, ${t.isDefault}) returning id`;
  return row!;
}

export async function deleteTemplate(db: Db, id: string): Promise<void> {
  const r = await db`delete from defect_template where id = ${id}`;
  if (r.count === 0) throw notFound('Vorlage', id);
}

/**
 * Mehrzeiligen Wiki-Text in eine Zeile bringen (Jira-Zeilenumbruch \\): Blockmarken am Zeilenanfang (h1.–h6., bq.)
 * entfallen, weil sie mitten in einer Zeile nicht mehr wirken und sonst als Text im Ticket stünden.
 */
const oneLine = (s: string | null | undefined) => (s ?? '').split(/\r?\n/)
  .map((l) => l.trim().replace(/^(h[1-6]|bq)\.\s*/, '')).filter((l) => wikiToText(l).trim()).join('\\\\');

/**
 * Daten für die Vorlage aus einer Ausführung (und optional einem bestimmten Schritt) zusammenstellen.
 * Platzhalter (Review Teil 3, Befund 19): neben Testfall, Zyklus, Schritten und Evidenzen auch `testanweisung`
 * (Freitext-Testfälle), `durchlauf` (fehlgeschlagener Durchlauf eines parametrisierten Tests mit Datenwerten und
 * Schritt) und `vorbedingungen` (wiederverwendbare Vorbedingungen). Damit die Standardvorlage ohne Migration davon
 * profitiert, fließen sie zusätzlich in `preconditions`, `steps` und `step` ein.
 */
export async function defectData(db: Db, executionId: string, stepId: string | null, baseUrl: string): Promise<TemplateData & { projectId: string }> {
  const e = await getExecution(db, executionId);
  const cycle = await getCycle(db, e.cycleId);
  const statuses = new Map((await listStatuses(db)).map((s) => [s.code, s]));
  const bad = (code: string | undefined) => ['FAILED', 'BLOCKED'].includes(statuses.get(code ?? '')?.category ?? '');
  // parametrisierter Test: erster fehlgeschlagene/blockierte Durchlauf mit seinen Schrittergebnissen
  const failedIteration = (e.iterations ?? []).find((i) => bad(i.status)) ?? null;
  const results = new Map((failedIteration?.stepResults.length ? failedIteration.stepResults : e.stepResults).map((r) => [r.stepId, r]));
  const idx = stepId ? e.steps.findIndex((s) => s.id === stepId) : e.steps.findIndex((s) => !isGroup(s) && bad(results.get(s.id!)?.status));
  const nos = stepNumbers(e.steps);
  if (stepId && idx < 0) throw badRequest('Schritt gehört nicht zu dieser Ausführung');
  const failed = idx >= 0 ? e.steps[idx]! : null;
  const dims = await loadDimensions(db);
  const configuration = Object.entries((cycle as { configuration?: Record<string, string[]> }).configuration ?? {})
    .filter(([, v]) => v.length)
    .map(([k, v]) => `${dims.find((d) => d.key === k)?.name ?? k}: ${v.join(', ')}`).join('; ');
  const atts = await listAttachments(db, 'TEST_EXECUTION', executionId);
  const actual = (failed ? results.get(failed.id!)?.comment ?? '' : '') || failedIteration?.comment || '';
  const [project] = await db<{ key: string }[]>`select key from project where id = ${cycle.projectId}`;
  const statusName = (c: string) => statuses.get(c)?.name ?? c;
  const testanweisung = e.version.format === 'PLAIN' ? (e.version.plainText ?? '').trim() : '';
  const vorbedingungen = (e.preconditions ?? []).map((p) => `* ${p.key} – ${oneLine(p.title)}${p.content?.trim() ? `\\\\${oneLine(p.content)}` : ''}`).join('\n');
  const durchlauf = failedIteration
    ? [`Durchlauf ${failedIteration.index + 1} (${Object.entries(failedIteration.values).map(([k, v]) => `${k} = ${v}`).join('; ') || 'ohne Werte'}): ${statusName(failedIteration.status)}${failedIteration.comment ? ` – ${oneLine(failedIteration.comment)}` : ''}`,
      ...failedIteration.stepResults.filter((r) => bad(r.status)).map((r) => {
        const no = nos[e.steps.findIndex((s) => s.id === r.stepId)] ?? 0;
        return `Schritt ${no > 0 ? no : '–'}: ${statusName(r.status)}${r.comment ? ` – ${oneLine(r.comment)}` : ''}`;
      })].join('\n')
    : '';
  // Abschnitte (J1) als fette Zwischenzeile; nummerierte Liste nur für Prüfschritte
  const stepList = e.steps.map((s, i) => isGroup(s) ? `*${oneLine(groupTitle(s as { title?: string | null }))}*` : `# ${oneLine(s.action)}${s.data ? ` _(Daten: ${oneLine(s.data)})_` : ''}${s.expected ? `\\\\_Erwartet:_ ${oneLine(s.expected)}` : ''}${i === idx ? ' ← *hier tritt der Fehler auf*' : ''}`).join('\n');
  return {
    projectId: cycle.projectId,
    testCase: { key: e.testCase.key, title: e.version.title, version: e.version.versionNo },
    preconditions: [e.version.preconditions ?? '', vorbedingungen && `Wiederverwendbare Vorbedingungen:\n${vorbedingungen}`].filter(Boolean).join('\n'),
    vorbedingungen,
    testanweisung,
    durchlauf,
    cycle: { name: cycle.name, release: cycle.release ?? '–', build: cycle.build ?? '–', environment: cycle.environment ?? '–' },
    configuration: configuration || '–',
    step: failed ? { no: nos[idx] ?? idx + 1, action: failed.action, expected: failed.expected, actual: actual || '(siehe Kommentar)' } : null,
    fehler: actual || e.comment || `${e.testCase.key} ist fehlgeschlagen`,
    // Schritte zur Reproduktion: Freitext-Testanweisung bzw. Schritte, bei Durchläufen mit Datenzeile davor
    steps: [
      durchlauf && `*Daten:* ${durchlauf.split('\n')[0]}`,
      testanweisung ? `*Testanweisung (Freitext):*\n${testanweisung}` : stepList,
    ].filter(Boolean).join('\n'),
    evidence: atts.length ? atts.map((a) => `* [^${a.fileName}]`).join('\n') : 'keine',
    executedBy: e.executedBy ?? '–',
    link: baseUrl ? `${baseUrl}${goPath('ausfuehrung', executionId)}` : '',
  };
}

export async function draftDefect(db: Db, executionId: string, opts: { templateId?: string | undefined; stepId?: string | undefined; baseUrl: string }) {
  const data = await defectData(db, executionId, opts.stepId ?? null, opts.baseUrl);
  const templates = await listTemplates(db, data.projectId);
  const t = (opts.templateId ? templates.find((x) => x.id === opts.templateId) : null)
    ?? templates.find((x) => x.isDefault && x.projectId === data.projectId) ?? templates.find((x) => x.isDefault) ?? templates[0];
  if (!t) throw badRequest('Keine Fehlervorlage vorhanden');
  // Titel: Schritt ohne aussagekräftigen Text (z. B. nur ein gezeichneter Pfeil „----->“) → Testfall-Titel statt Zeichenfolge
  const step = data.step as { action: string } | null;
  const titleData = step && !wikiSummary(step.action) ? { ...data, step: { ...step, action: (data.testCase as { title: string }).title } } : data;
  return { templateId: t.id, projectId: data.projectId, title: plainTitle(renderTemplate(t.titleTemplate, titleData)), body: renderTemplate(t.bodyTemplate, data) };
}
