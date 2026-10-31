/**
 * Modul reports: Testberichte in Anlehnung an ISO/IEC/IEEE 29119-3 (Testprotokoll, Testabschlussbericht,
 * Testfallspezifikation) mit anpassbaren Profilen sowie Lieferpakete (ADR-0016).
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { markdownToPdf } from '../../platform/pdf.ts';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { badRequest, notFound, route, visibleProjectIdsOf } from '../../platform/http.ts';
import { writeXlsx } from '../../platform/xlsx.ts';
import { coverageHistory, portfolio, topDefects, workload } from './insights.ts';
import { getProject } from '../projects/index.ts';
import { completionReport, type Report, specification, testLog, traceability } from './data.ts';
import { baselineFile, ensureBaselines, listBaselines } from './baseline.ts';
import { buildPackage } from './package.ts';
import { EventTypes, subscribe } from '../events/index.ts';
import { burndown, statusReport } from './status.ts';
import { berlinDayEnd, berlinDayStart, requirePlausibleDay } from './time.ts';
import { cockpit } from './cockpit.ts';
import { KIND_TITLE, type ProfileOptions, renderHtml, renderMarkdown } from './render.ts';

export type { ProfileOptions } from './render.ts';
export { cockpit } from './cockpit.ts';
export { traceability } from './data.ts';

const Options = z.object({
  organization: z.string().max(200), accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/), footer: z.string().max(300),
  standardNote: z.boolean(), signoffRoles: z.array(z.string().min(1).max(80)).max(8),
  sections: z.object({
    summary: z.boolean(), environment: z.boolean(), executions: z.boolean(), steps: z.boolean(), comments: z.boolean(),
    defects: z.boolean(), openItems: z.boolean(), evidence: z.boolean(), signoff: z.boolean(),
  }),
});

async function profileOf(db: Db, id: string | undefined): Promise<{ id: string; name: string; options: ProfileOptions }> {
  const [p] = id
    ? await db<{ id: string; name: string; options: ProfileOptions }[]>`select id, name, options from report_profile where id = ${id}`
    : await db<{ id: string; name: string; options: ProfileOptions }[]>`select id, name, options from report_profile order by is_default desc, created_at limit 1`;
  if (!p) throw notFound('Berichtsprofil', id ?? 'Standard');
  return p;
}

const Format = z.object({ format: z.enum(['html', 'md', 'json', 'pdf']).default('html'), profile: z.uuid().optional(), download: z.stringbool().optional() });

function output(r: Report, profile: { name: string; options: ProfileOptions }, format: 'html' | 'md' | 'json' | 'pdf', download: boolean | undefined): Response {
  const base = `${KIND_TITLE[r.kind]}-${r.project.key}`.replace(/[^\p{L}\p{N}._-]+/gu, '-');
  const disposition = (ext: string) => `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`;
  if (format === 'json') return new Response(JSON.stringify(r, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': disposition('json') } });
  if (format === 'md') return new Response(renderMarkdown(r, profile), { headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': disposition('md') } });
  if (format === 'pdf') {
    const pdf = markdownToPdf(renderMarkdown(r, profile), { title: `${KIND_TITLE[r.kind]} – ${r.project.key} ${r.project.name}`, footer: profile.options.footer, author: r.generatedBy });
    return new Response(new Uint8Array(pdf), { headers: { 'content-type': 'application/pdf', 'content-disposition': disposition('pdf') } });
  }
  const { html } = renderHtml(r, profile, (a) => `/api/attachments/${a.id}/content`);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-disposition': disposition('html') } });
}

/** Freigabestände nach Entscheidungen anlegen und beim Start nachholen (Prozess, nicht je App-Instanz der Tests) */
export function startBaselineWorker(db: Db, attachmentDir: string): void {
  const loader = (d: Db) => profileOf(d, undefined);
  subscribe(async (e) => {
    if (e.type === EventTypes.ReleaseDecided && (e.payload as { decision?: string | null }).decision) await ensureBaselines(db, attachmentDir, loader, e.aggregateId);
  });
  void ensureBaselines(db, attachmentDir, loader).catch((err) => console.error('Freigabestände', err));
}

export function reportRoutes(app: Hono, db: Db, attachmentDir: string): void {
  const tag = 'Berichte';
  route(app, {
    method: 'get', path: '/api/plans/:id/baselines', tag, summary: 'Freigabestände des Testplans: zu jeder Entscheidung das abgelegte Lieferpaket mit Prüfsumme (fehlende werden angelegt)',
    access: { level: 'read', project: ({ params }) => ({ kind: 'plan', id: params.id! }) },
  }, async ({ params }) => {
    await ensureBaselines(db, attachmentDir, (d) => profileOf(d, undefined), params.id!);
    return listBaselines(db, params.id!);
  });
  route(app, {
    method: 'get', path: '/api/plans/:id/baselines/:baselineId/download', tag, summary: 'Abgelegtes Lieferpaket einer Freigabeentscheidung herunterladen (unverändert seit der Entscheidung)',
    access: { level: 'read', project: ({ params }) => ({ kind: 'plan', id: params.id! }) },
  }, async ({ params }) => {
    const [b] = (await listBaselines(db, params.id!)).filter((x) => x.id === params.baselineId && x.status === 'ready');
    if (!b) throw notFound('Freigabestand', params.baselineId);
    return new Response(Readable.toWeb(createReadStream(baselineFile(attachmentDir, b.id))) as ReadableStream, {
      headers: { 'content-type': 'application/zip', 'content-length': String(b.packageBytes ?? ''),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`Freigabestand-${b.packageName ?? `${b.id}.zip`}`)}` },
    });
  });
  route(app, { method: 'get', path: '/api/report-profiles', tag, summary: 'Berichtsprofile' },
    () => db`select id, name, options, is_default from report_profile order by is_default desc, name`);
  const ProfileBody = z.object({ name: z.string().min(1).max(120), isDefault: z.boolean(), options: Options });
  route(app, { method: 'post', path: '/api/admin/report-profiles', tag, summary: 'Berichtsprofil anlegen', access: 'admin', body: ProfileBody, status: 201 }, async ({ body }) => {
    if (body.isDefault) await db`update report_profile set is_default = false where is_default`;
    const [p] = await db`insert into report_profile(name, is_default, options) values (${body.name}, ${body.isDefault}, ${db.json(body.options as never)}) returning id`;
    return p;
  });
  route(app, { method: 'put', path: '/api/admin/report-profiles/:id', tag, summary: 'Berichtsprofil ändern', access: 'admin', body: ProfileBody, status: 204 }, async ({ params, body }) => {
    if (body.isDefault) await db`update report_profile set is_default = false where is_default and id <> ${params.id!}`;
    const r = await db`update report_profile set name = ${body.name}, is_default = ${body.isDefault}, options = ${db.json(body.options as never)} where id = ${params.id!}`;
    if (r.count === 0) throw notFound('Berichtsprofil', params.id);
  });
  route(app, { method: 'delete', path: '/api/admin/report-profiles/:id', tag, summary: 'Berichtsprofil löschen', access: 'admin', status: 204 }, async ({ params }) => {
    const [p] = await db<{ isDefault: boolean }[]>`select is_default from report_profile where id = ${params.id!}`;
    if (!p) throw notFound('Berichtsprofil', params.id);
    if (p.isDefault) throw badRequest('Das Standardprofil kann nicht gelöscht werden');
    await db`delete from report_profile where id = ${params.id!}`;
  });

  route(app, {
    method: 'get', path: '/api/reports/test-log/:id', tag, summary: 'Testprotokoll eines Zyklus (HTML/Markdown/JSON)', query: Format,
    access: { level: 'read', project: ({ params }) => ({ kind: 'cycle', id: params.id! }) },
  }, async ({ params, query, actor }) => {
    const profile = await profileOf(db, query.profile);
    return output(await testLog(db, params.id!, actor, { steps: profile.options.sections.steps }), profile, query.format, query.download);
  });
  route(app, {
    method: 'get', path: '/api/reports/completion/:id', tag, summary: 'Testabschlussbericht eines Testplans (HTML/Markdown/JSON)', query: Format,
    access: { level: 'read', project: ({ params }) => ({ kind: 'plan', id: params.id! }) },
  }, async ({ params, query, actor }) => {
    const profile = await profileOf(db, query.profile);
    return output(await completionReport(db, params.id!, actor, { steps: profile.options.sections.steps }), profile, query.format, query.download);
  });
  route(app, {
    method: 'get', path: '/api/reports/status/:id', tag, summary: 'Teststatusbericht (Zwischenbericht) eines Testplans: Berichtszeitraum, Burn-down mit Prognose, neue Fehler, Lagebild',
    query: Format.extend({ from: z.iso.date().optional(), to: z.iso.date().optional() }),
    access: { level: 'read', project: ({ params }) => ({ kind: 'plan', id: params.id! }) },
  }, async ({ params, query, actor }) => {
    const profile = await profileOf(db, query.profile);
    // Tagesgrenzen in Europe/Berlin (wie Burn-down und Cockpit), unabhängig von der Zeitzone des Servers
    const from = query.from ? berlinDayStart(requirePlausibleDay(query.from, 'Beginn des Berichtszeitraums')) : undefined;
    const to = query.to ? berlinDayEnd(requirePlausibleDay(query.to, 'Ende des Berichtszeitraums')) : undefined;
    if (from && to && from > to) throw badRequest('Der Beginn des Berichtszeitraums liegt nach dessen Ende');
    return output(await statusReport(db, params.id!, actor, { from, to, steps: false }), profile, query.format, query.download);
  });
  route(app, {
    method: 'put', path: '/api/plans/:id/status-note', tag, summary: 'Lagebild des Testmanagements (Hindernisse, nächste Schritte) für den Teststatusbericht', status: 204,
    access: { level: 'edit', project: ({ params }) => ({ kind: 'plan', id: params.id! }) }, body: z.object({ text: z.string().max(20_000).nullable() }),
  }, async ({ params, body, actor }) => {
    const text = body.text?.trim() || null;
    const r = await db`update test_plan set status_note = ${text}, status_note_at = ${text ? new Date() : null}, status_note_by = ${text ? actor : null} where id = ${params.id!}`;
    if (r.count === 0) throw notFound('Testplan', params.id);
  });
  route(app, {
    method: 'get', path: '/api/plans/:id/burndown', tag, summary: 'Burn-down des Testplans gegen das geplante Ende mit Prognose',
    access: { level: 'read', project: ({ params }) => ({ kind: 'plan', id: params.id! }) },
  }, ({ params }) => burndown(db, params.id!));
  route(app, {
    method: 'get', path: '/api/reports/traceability/:id', tag, summary: 'Rückverfolgbarkeit eines Testplans: Anforderungen × Testfälle × Ergebnis (asOf: Stand zum Stichtag)',
    query: Format.extend({ asOf: z.iso.date().optional() }),
    access: { level: 'read', project: ({ params }) => ({ kind: 'plan', id: params.id! }) },
  }, async ({ params, query, actor }) => {
    const profile = await profileOf(db, query.profile);
    const asOf = query.asOf ? berlinDayEnd(requirePlausibleDay(query.asOf, 'Stichtag')) : undefined;
    return output(await traceability(db, params.id!, actor, { asOf }), profile, query.format, query.download);
  });
  route(app, {
    method: 'get', path: '/api/reports/specification/:key', tag, summary: 'Testfallspezifikation (Projekt oder Ordner)',
    query: Format.extend({ folderId: z.uuid().optional() }),
    access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
  }, async ({ params, query, actor }) => {
    const profile = await profileOf(db, query.profile);
    return output(await specification(db, params.key!, query.folderId ?? null, actor), profile, query.format, query.download);
  });
  route(app, {
    method: 'get', path: '/api/plans/:id/cockpit', tag, summary: 'Release-Cockpit: Fortschritt, Stand, offene Fehler, ungetestete Änderungen, Empfehlung',
    access: { level: 'read', project: ({ params }) => ({ kind: 'plan', id: params.id! }) },
  }, ({ params, actor }) => cockpit(db, params.id!, actor));
  route(app, {
    method: 'get', path: '/api/reports/package/:id', tag, summary: 'Lieferpaket eines Testplans (ZIP mit Berichten, Ergebnissen, Evidenzen, Prüfsummen, Signatur)',
    query: z.object({ profile: z.uuid().optional() }),
    access: { level: 'read', project: ({ params }) => ({ kind: 'plan', id: params.id! }) },
  }, async ({ params, query, actor }) => {
    const pkg = await buildPackage(db, { planId: params.id!, profile: await profileOf(db, query.profile), actor, attachmentDir });
    return new Response(Readable.toWeb(Readable.from(pkg.stream)) as ReadableStream, {
      headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(pkg.name)}` },
    });
  });
  // ---- Auswertungen (Stufe H) ----
  const xlsx = async (name: string, sheets: Parameters<typeof writeXlsx>[0]) => new Response(new Uint8Array(await writeXlsx(sheets)), {
    headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${name}-${new Date().toISOString().slice(0, 10)}.xlsx`)}` },
  });
  route(app, {
    method: 'get', path: '/api/plans/:id/coverage-history', tag, summary: 'Abdeckung der Anforderungen je Woche (historisch, aus dem Ergebnisverlauf)',
    access: { level: 'read', project: ({ params }) => ({ kind: 'plan', id: params.id! }) }, query: z.object({ weeks: z.coerce.number().int().min(2).max(26).default(12) }),
  }, ({ params, query, actor }) => coverageHistory(db, params.id!, actor, query.weeks));
  route(app, {
    method: 'get', path: '/api/projects/:key/top-defects', tag, summary: 'Fehler nach Auswirkung (betroffene Testfälle, Ausführungen, Anforderungen)',
    access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
    query: z.object({ planId: z.uuid().optional(), days: z.coerce.number().int().min(1).max(3650).optional(), limit: z.coerce.number().int().min(1).max(500).default(50), format: z.enum(['json', 'xlsx']).default('json') }),
  }, async ({ params, query }) => {
    const p = await getProject(db, params.key!);
    const rows = await topDefects(db, p.id, query);
    if (query.format === 'json') return rows;
    return xlsx(`Top-Fehler-${p.key}`, [{ name: 'Top-Fehler', header: ['Fehler', 'Titel', 'Status', 'Stand', 'Testfälle', 'Ausführungen', 'Anforderungen', 'Zuletzt', 'Zyklen'],
      rows: rows.map((r) => [r.externalKey, r.title, r.status, r.resolution === 'open' ? 'offen' : r.resolution === 'fixed' ? 'behoben' : 'abgelehnt', r.testCases, r.executions, r.requirements.join(', '), r.lastSeen, r.cycles.join(', ')]) }]);
  });
  route(app, {
    method: 'get', path: '/api/projects/:key/workload', tag, summary: 'Team und Aufwand: je zuständiger Person, je Tester (30 Tage) und je Zyklus',
    access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
    query: z.object({ planId: z.uuid().optional(), cycleId: z.uuid().optional(), format: z.enum(['json', 'xlsx']).default('json') }),
  }, async ({ params, query }) => {
    const p = await getProject(db, params.key!);
    const w = await workload(db, p.id, query);
    if (query.format === 'json') return w;
    const h = (s: number) => Math.round((s / 3600) * 10) / 10;
    return xlsx(`Team-${p.key}`, [
      { name: 'Zuständige', header: ['Person', 'Ausführungen', 'offen', 'bestanden', 'fehlgeschl./blockiert', 'erfasst (h)', 'geplant (h)', 'Rest (h)', 'ohne Schätzung'],
        rows: w.byAssignee.map((a) => [a.assignee ?? '(niemand)', a.total, a.open, a.passed, a.problems, h(a.durationSeconds), h(a.plannedMinutes * 60), h(a.remainingMinutes * 60), a.withoutEstimate]) },
      { name: 'Tester (30 Tage)', header: ['Person', '7 Tage', '30 Tage', 'davon Probleme', 'erfasst (h)'], rows: w.byTester.map((t) => [t.executedBy, t.week, t.month, t.problems, h(t.durationSeconds)]) },
      { name: 'Zyklen', header: ['Zyklus', 'Ausführungen', 'offen', 'erfasst (h)', 'geplant (h)', 'Rest (h)'], rows: w.byCycle.map((c) => [c.name, c.total, c.open, h(c.durationSeconds), h(c.plannedMinutes * 60), h(c.remainingMinutes * 60)]) },
    ]);
  });
  route(app, {
    method: 'get', path: '/api/portfolio', tag, summary: 'Projektübergreifend: Bestand, Aktivität, Bestehensquote, offene Fehler, Release je sichtbarem Projekt',
    query: z.object({ format: z.enum(['json', 'xlsx']).default('json') }),
  }, async ({ c, query }) => {
    const rows = await portfolio(db, visibleProjectIdsOf(c));
    if (query.format === 'json') return rows;
    return xlsx('Portfolio', [{ name: 'Projekte', header: ['Projekt', 'Name', 'Testfälle', 'aktive Zyklen', 'offene Ausführungen', 'ausgeführt (30 T.)', 'Bestehensquote (30 T.) %', 'offene Fehler', 'aktuelles Release', 'Freigabe', 'zuletzt aktiv'],
      rows: rows.map((r) => [r.key, r.name, r.testCases, r.activeCycles, r.openExecutions, r.executed30, r.passRate30, r.openDefects, r.latestPlan ? `${r.latestPlan.name}${r.latestPlan.release ? ` (${r.latestPlan.release})` : ''}` : '', r.latestPlan?.releaseDecision ?? '', r.lastActivity]) }]);
  });

}
