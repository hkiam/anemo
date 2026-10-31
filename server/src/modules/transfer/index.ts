/**
 * Modul transfer: Projekte als Projektpaket exportieren (und ab Stufe K2 importieren), ADR-0027.
 *
 * Ablauf Export: Antrag → (bei sensiblen Projekten) Freigabe durch die Systemadministration → das Paket entsteht als
 * Hintergrundauftrag (running → ready) → Abruf innerhalb von 24 Stunden durch die anfordernde Person. Voraussetzung
 * ist das Recht „Projekte übertragen“ und die Projektadministration im Projekt; beides wird beim Abruf erneut geprüft.
 * Ablauf Import: Hochladen und Prüfen → Probelauf → Einspielen (synchron oder mit ?background=true als Auftrag mit
 * Fortschritt). Jeder Vorgang bleibt mit Prüfsumme und Größe des Pakets in project_transfer nachvollziehbar.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { conflict, HttpError, notFound, requireAccess, route, visibleProjectIdsOf } from '../../platform/http.ts';
import { requirePermission } from '../auth/index.ts';
import { EventTypes, recordEvent } from '../events/index.ts';
import { exportProject, scopeSummary } from './export.ts';
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions, type ExportScope, type Manifest, type TypeName } from './format.ts';
import { cleanupImportStaging, type ImportOptions, importPackage, inspectPackage, POLICY_TYPES, uuidv7 } from './import.ts';

export { FORMAT, FORMAT_VERSION, NOT_EXPORTED, TYPES, CATALOG_TABLES } from './format.ts';
export type { ExportOptions, ExportScope, Manifest } from './format.ts';
export type { ImportOptions, ImportReport } from './import.ts';

/** So lange ist ein freigegebener Export abrufbar */
export const EXPORT_VALID_HOURS = 24;

export interface ProjectTransfer {
  id: string;
  direction: 'export' | 'import';
  projectId: string | null;
  projectKey: string;
  /** Export: pending → approved → running → ready → done (abgerufen); Import: pending → running → done */
  status: 'pending' | 'approved' | 'rejected' | 'running' | 'ready' | 'done' | 'failed';
  sensitive: boolean;
  options: Record<string, unknown>;
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  expiresAt: Date | null;
  downloads: number;
  packageSha256: string | null;
  packageBytes: string | null;
  counts: Record<string, number> | null;
  error: string | null;
  finishedAt: Date | null;
  progress: { phase: string; type?: string; done?: number } | null;
  report: unknown;
}

/** Sensibel im Sinne von ADR-0014: nur für Mitglieder sichtbar oder für externe Dienste gesperrt */
const isSensitive = (p: { visibility: string; externalServices: string }) => p.visibility === 'restricted' || p.externalServices === 'blocked';

const workDir = () => process.env.ANEMO_TRANSFER_DIR?.trim() || tmpdir();
const importFile = (id: string) => join(workDir(), `anemo-import-${id}.zip`);
const exportFile = (id: string) => join(workDir(), `anemo-export-${id}.zip`);

/** laufende Aufträge dieses Prozesses (Übertragungs-ID → Auftrag) */
const jobs = new Map<string, Promise<void>>();

/** Fortschritt höchstens zweimal je Sekunde schreiben */
function progressWriter(db: Db, id: string) {
  let last = 0;
  return (p: { phase: string; type?: string; done?: number }) => {
    if (Date.now() - last < 500) return;
    last = Date.now();
    void db`update project_transfer set progress = ${db.json(p)} where id = ${id}`.catch(() => {});
  };
}

/** Export als Hintergrundauftrag bauen (approved → running → ready); wartet auf einen schon laufenden Auftrag. */
function ensureExport(db: Db, t: ProjectTransfer, attachmentDir: string): Promise<void> {
  const running = jobs.get(t.id);
  if (running) return running;
  const job = (async () => {
    const [claimed] = await db<ProjectTransfer[]>`update project_transfer set status = 'running', progress = ${db.json({ phase: 'Start' })}, error = null
      where id = ${t.id} and status in ('approved', 'running') returning *`;
    if (!claimed || !claimed.projectId) return;
    try {
      await mkdir(workDir(), { recursive: true });
      const o = claimed.options as { scope?: ExportScope; options?: Partial<ExportOptions> };
      const r = await exportProject(db, { projectId: claimed.projectId, transferId: t.id, actor: claimed.requestedBy, attachmentDir, workDir: workDir(),
        scope: o.scope, options: o.options, onProgress: progressWriter(db, t.id) });
      const { files: _f, ...counts } = r.manifest.counts;
      await db`update project_transfer set status = 'ready', package_sha256 = ${r.sha256}, package_bytes = ${r.bytes}, progress = null,
        counts = ${db.json({ ...counts, files: r.manifest.counts.files })}, report = ${db.json({ fileName: r.fileName, warnings: r.manifest.warnings })},
        finished_at = now() where id = ${t.id}`;
    } catch (e) {
      await db`update project_transfer set status = 'failed', progress = null, error = ${(e as Error).message.slice(0, 2000)} where id = ${t.id}`.catch(() => {});
    }
  })().finally(() => jobs.delete(t.id));
  jobs.set(t.id, job);
  return job;
}

/** Größte erlaubte Paketgröße beim Hochladen (ANEMO_TRANSFER_MAX_MB, Standard 10 GB) */
export function transferMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const mb = Number(env.ANEMO_TRANSFER_MAX_MB ?? 10_240);
  return (Number.isFinite(mb) && mb > 0 ? mb : 10_240) * 1024 * 1024;
}

/** Abgelaufene Pakete entfernen: nicht eingespielte Importe, abrufbare Exporte (stündlich und vor jedem Hochladen) */
export async function cleanupTransferFiles(db: Db): Promise<void> {
  const stale = await db<{ id: string }[]>`
    update project_transfer set status = 'failed', error = coalesce(error, 'abgelaufen, nicht eingespielt')
    where direction = 'import' and status = 'pending' and expires_at < now() returning id`;
  for (const t of stale) await rm(importFile(t.id), { force: true });
  const expired = await db<{ id: string }[]>`select id from project_transfer where direction = 'export' and status in ('ready', 'done') and expires_at < now()
    and requested_at > now() - interval '7 days'`;
  for (const t of expired) await rm(exportFile(t.id), { force: true });
  // verwaiste Dateien (z. B. nach Abbruch beim Hochladen)
  const dir = workDir();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!/^anemo-(import|export)-[0-9a-f-]{36}\.zip(\.part)?$/.test(name)) continue;
    const st = await stat(join(dir, name)).catch(() => null);
    if (st && st.mtimeMs < Date.now() - 2 * EXPORT_VALID_HOURS * 3600_000) await rm(join(dir, name), { force: true });
  }
}

const ScopeSchema = z.object({
  kind: z.enum(['complete', 'selection']),
  folders: z.array(z.uuid()).max(1000).optional(),
  testCases: z.array(z.string().trim().min(1).max(100)).max(50_000).optional(),
  query: z.string().max(2000).optional(),
  testSets: z.array(z.uuid()).max(100).optional(),
  plans: z.array(z.uuid()).max(100).optional(),
  cycles: z.array(z.uuid()).max(1000).optional(),
}).refine((s) => s.kind === 'complete' || !!(s.folders?.length || s.testCases?.length || s.query?.trim() || s.testSets?.length || s.plans?.length || s.cycles?.length),
  'Auswahl ist leer: Ordner, Testfälle, Abfrage, Testsets, Pläne oder Zyklen angeben');
const OptionsSchema = z.object({
  versions: z.enum(['all', 'current']).optional(), executions: z.boolean().optional(), attachments: z.boolean().optional(),
  comments: z.boolean().optional(), pseudonymize: z.boolean().optional(),
});

const Policy = z.enum(['update', 'skip', 'new']);
const ImportOptionsSchema = z.object({
  target: z.object({ mode: z.enum(['new', 'existing']).default('new'), key: z.string().trim(), name: z.string().trim().max(200).optional(), folderId: z.uuid().nullish() }),
  // nur Objektarten des Zielprojekts – Testfälle anderer Projekte sind nie veränderbar
  conflicts: z.partialRecord(z.enum(POLICY_TYPES as [TypeName, ...TypeName[]]), Policy).optional(),
  persons: z.record(z.string(), z.string().nullable()).optional(),
  executionStatuses: z.record(z.string(), z.string()).optional(),
  testCaseStatuses: z.record(z.string(), z.string()).optional(),
  priorities: z.record(z.string(), z.string()).optional(),
});

/** Übersicht eines hochgeladenen Pakets (für Oberfläche und Fortsetzen) */
const summaryOf = (m: Manifest) => ({
  project: m.project, formatVersion: m.formatVersion, anemo: m.anemo, sourceInstance: m.sourceInstance, exportedAt: m.exportedAt, exportedBy: m.exportedBy,
  scope: m.scope, counts: m.counts, persons: m.persons, groups: m.groups, warnings: m.warnings,
});

async function getTransfer(db: Db, id: string): Promise<ProjectTransfer | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [t] = await db<ProjectTransfer[]>`select * from project_transfer where id = ${id}`;
  return t;
}

export function transferRoutes(app: Hono, db: Db, attachmentDir: string): void {
  const tag = 'Projektübertragung';
  // nach einem Neustart: unterbrochene Aufträge wieder aufnehmbar machen (Export neu bauen, Import erneut einspielen)
  void db`update project_transfer set status = case direction when 'export' then 'approved' else 'pending' end, progress = null,
      error = case direction when 'import' then 'Einspielen wurde unterbrochen (Neustart) – bitte erneut starten' else error end
    where status = 'running'`.catch(() => {});
  void cleanupImportStaging(attachmentDir);
  const byKey = { level: 'manage' as const, project: ({ params }: { params: Record<string, string> }) => ({ kind: 'project', key: params.key! }) };

  route(app, {
    method: 'post', path: '/api/projects/:key/exports', tag, status: 201, access: byKey,
    summary: 'Export des Projekts anfordern (komplett oder Auswahl, mit Optionen). Braucht das Recht „Projekte übertragen“; sensible Projekte zusätzlich die Freigabe der Systemadministration',
    body: z.object({ note: z.string().trim().max(2000).optional(), scope: ScopeSchema.optional(), options: OptionsSchema.optional() }),
  }, async ({ params, body, actor, c }) => {
    const principal = requirePermission(c, 'PROJECT_TRANSFER');
    const [p] = await db<{ id: string; key: string; visibility: string; externalServices: string }[]>`
      select id, key, visibility, external_services from project where key = ${params.key!}`;
    if (!p) throw notFound('Projekt', params.key);
    const sensitive = isSensitive(p);
    // Auswahl sofort prüfen (Fehler jetzt statt beim Abruf) und Umfang für Freigabe und Oberfläche festhalten
    const summary = body.scope?.kind === 'selection' ? await scopeSummary(db, { projectId: p.id, actor, scope: body.scope as ExportScope, options: body.options }) : null;
    // Systemadministration gibt eigene Exporte zugleich frei
    const approved = !sensitive || principal.isSystemAdmin;
    const [t] = await db<ProjectTransfer[]>`
      insert into project_transfer(direction, project_id, project_key, status, sensitive, options, requested_by, decided_by, decided_at, decision_note, expires_at)
      values ('export', ${p.id}, ${p.key}, ${approved ? 'approved' : 'pending'}, ${sensitive},
        ${db.json({ scope: body.scope ?? { kind: 'complete' }, options: { ...DEFAULT_EXPORT_OPTIONS, ...body.options }, note: body.note ?? null, summary } as never)}, ${actor},
        ${sensitive && approved ? actor : null}, ${sensitive && approved ? new Date() : null}, ${sensitive && approved ? 'durch Systemadministration angefordert' : null},
        ${approved ? db`now() + make_interval(hours => ${EXPORT_VALID_HOURS})` : null})
      returning *`;
    await recordEvent(db, { type: EventTypes.ProjectExportRequested, aggregateType: 'Project', aggregateId: p.id, actor,
      payload: { key: p.key, transferId: t!.id, sensitive, status: t!.status } });
    if (approved) void ensureExport(db, t!, attachmentDir);
    return t;
  });

  route(app, { method: 'get', path: '/api/project-transfers', tag, summary: 'Eigene Exporte und Importe (neueste zuerst)' },
    ({ actor }) => db<ProjectTransfer[]>`select * from project_transfer where requested_by = ${actor} order by requested_at desc limit 100`);

  route(app, {
    method: 'get', path: '/api/admin/project-transfers', tag, summary: 'Alle Exporte und Importe; mit status=pending die offenen Freigaben', access: 'admin',
    query: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'running', 'ready', 'done', 'failed']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
  }, ({ query }) => db<ProjectTransfer[]>`select * from project_transfer
      ${query.status ? db`where status = ${query.status}` : db``} order by requested_at desc limit ${query.limit}`);

  route(app, {
    method: 'post', path: '/api/admin/project-transfers/:id/decision', tag, access: 'admin',
    summary: 'Export eines sensiblen Projekts freigeben oder ablehnen (danach 24 Stunden abrufbar)',
    body: z.object({ approve: z.boolean(), note: z.string().trim().max(2000).optional() }),
  }, async ({ params, body, actor }) => {
    const t = await getTransfer(db, params.id!);
    if (!t) throw notFound('Übertragung', params.id);
    if (t.status !== 'pending') throw conflict('Über diesen Antrag ist bereits entschieden.');
    const [u] = await db<ProjectTransfer[]>`
      update project_transfer set status = ${body.approve ? 'approved' : 'rejected'}, decided_by = ${actor}, decided_at = now(), decision_note = ${body.note ?? null},
        expires_at = ${body.approve ? db`now() + make_interval(hours => ${EXPORT_VALID_HOURS})` : null}
      where id = ${t.id} and status = 'pending' returning *`;
    if (!u) throw conflict('Über diesen Antrag ist bereits entschieden.');
    if (t.projectId) {
      await recordEvent(db, { type: EventTypes.ProjectExportDecided, aggregateType: 'Project', aggregateId: t.projectId, actor,
        payload: { key: t.projectKey, transferId: t.id, approved: body.approve, requestedBy: t.requestedBy } });
    }
    if (body.approve) void ensureExport(db, u, attachmentDir);
    return u;
  });

  route(app, { method: 'get', path: '/api/project-transfers/:id/download', tag, summary: 'Freigegebenen Export als Projektpaket abrufen (nur die anfordernde Person, innerhalb von 24 Stunden)' },
    async ({ params, actor, c }) => {
      const t = await getTransfer(db, params.id!);
      // Fremde Anträge sind nicht sichtbar
      if (!t || t.direction !== 'export' || t.requestedBy !== actor) throw notFound('Übertragung', params.id);
      if (t.status === 'pending') throw conflict('Der Export wartet auf die Freigabe durch die Systemadministration.');
      if (t.status === 'rejected') throw new HttpError(403, `Der Export wurde abgelehnt${t.decisionNote ? `: ${t.decisionNote}` : '.'}`);
      if (!t.expiresAt || t.expiresAt.getTime() < Date.now()) throw new HttpError(410, 'Der Export ist abgelaufen – bitte neu anfordern.');
      // Rechte gelten zum Zeitpunkt des Abrufs (entzogenes Recht, entzogene Projektrolle)
      const principal = requirePermission(c, 'PROJECT_TRANSFER');
      if (!t.projectId) throw notFound('Projekt', t.projectKey);
      await requireAccess(c, { level: 'manage', project: () => ({ kind: 'project', key: t.projectKey }) });
      const [p] = await db<{ key: string; visibility: string; externalServices: string }[]>`select key, visibility, external_services from project where id = ${t.projectId}`;
      if (!p) throw notFound('Projekt', t.projectKey);
      if (isSensitive(p) && !t.sensitive && !principal.isSystemAdmin) {
        throw conflict('Das Projekt ist inzwischen eingeschränkt. Bitte den Export neu anfordern; er braucht jetzt eine Freigabe.');
      }
      // Paket bauen bzw. auf den laufenden Auftrag warten
      if (t.status === 'approved' || t.status === 'running') await ensureExport(db, t, attachmentDir);
      const cur = (await getTransfer(db, t.id))!;
      if (cur.status === 'failed') throw new HttpError(500, `Export fehlgeschlagen: ${cur.error ?? 'unbekannter Fehler'} – bitte neu anfordern`);
      if (cur.status !== 'ready' && cur.status !== 'done') throw conflict('Der Export wird noch erstellt.');
      const path = exportFile(t.id);
      const size = (await stat(path).catch(() => null))?.size;
      if (size === undefined) throw new HttpError(410, 'Das Paket liegt nicht mehr vor – bitte neu anfordern.');
      await db`update project_transfer set status = 'done', downloads = downloads + 1 where id = ${t.id}`;
      await recordEvent(db, { type: EventTypes.ProjectExported, aggregateType: 'Project', aggregateId: t.projectId, actor,
        payload: { key: p.key, transferId: t.id, sha256: cur.packageSha256, bytes: size, counts: cur.counts } });
      const fileName = (cur.report as { fileName?: string } | null)?.fileName ?? `Projekt-${p.key}.anemo.zip`;
      return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
        headers: {
          'content-type': 'application/zip', 'content-length': String(size), 'x-anemo-sha256': cur.packageSha256 ?? '',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        },
      });
    });

  // ---- Import als neues Projekt (Stufe K2) ----
  const ownImport = async (id: string, actor: string) => {
    const t = await getTransfer(db, id);
    if (!t || t.direction !== 'import' || t.requestedBy !== actor) throw notFound('Import', id);
    if (t.status !== 'pending') throw conflict(t.status === 'done' ? 'Dieses Paket ist bereits eingespielt.' : 'Dieses Paket ist nicht mehr verfügbar – bitte erneut hochladen.');
    if (!t.expiresAt || t.expiresAt.getTime() < Date.now()) {
      await rm(importFile(t.id), { force: true });
      throw new HttpError(410, 'Das hochgeladene Paket ist abgelaufen – bitte erneut hochladen.');
    }
    return t;
  };
  route(app, {
    method: 'post', path: '/api/package-imports', tag, status: 201,
    summary: 'Projektpaket hochladen (Inhalt: die ZIP-Datei, Content-Type application/zip) und prüfen; danach Probelauf und Einspielen. Braucht das Recht „Projekte übertragen“',
  }, async ({ c, actor }) => {
    requirePermission(c, 'PROJECT_TRANSFER');
    if (!c.req.raw.body) throw new HttpError(400, 'Kein Paket im Inhalt der Anfrage');
    await mkdir(workDir(), { recursive: true });
    await cleanupTransferFiles(db);
    const id = uuidv7();
    const path = importFile(id);
    const h = createHash('sha256');
    let bytes = 0;
    try {
      const counted = Readable.fromWeb(c.req.raw.body as never).on('data', (chunk: Buffer) => { h.update(chunk); bytes += chunk.length; });
      await pipeline(counted, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
      const m = await inspectPackage(path);
      const [t] = await db<ProjectTransfer[]>`
        insert into project_transfer(id, direction, project_key, status, sensitive, options, requested_by, expires_at, package_sha256, package_bytes, counts)
        values (${id}, 'import', ${m.project.key}, 'pending', ${m.project.visibility === 'restricted' || m.project.externalServices === 'blocked'},
          ${db.json({ source: { key: m.project.key, name: m.project.name, instance: m.sourceInstance, transferId: m.transferId, exportedAt: m.exportedAt, exportedBy: m.exportedBy },
            package: summaryOf(m) } as never)},
          ${actor}, now() + make_interval(hours => ${EXPORT_VALID_HOURS}), ${h.digest('hex')}, ${bytes}, ${db.json(m.counts)})
        returning *`;
      const taken = (await db`select 1 from project where key = ${m.project.key}`).length > 0;
      return {
        transfer: t,
        package: summaryOf(m),
        suggestedTarget: { key: taken ? '' : m.project.key, name: m.project.name },
      };
    } catch (e) {
      await rm(path, { force: true });
      throw e;
    }
  });
  route(app, { method: 'get', path: '/api/package-imports/:id', tag, summary: 'Stand eines hochgeladenen Pakets (mit Übersicht unter options.package, Fortschritt, Bericht)' }, async ({ params, actor }) => {
    const t = await getTransfer(db, params.id!);
    if (!t || t.direction !== 'import' || t.requestedBy !== actor) throw notFound('Import', params.id);
    const src = (t.options as { source?: { key: string; name: string } }).source;
    const taken = src ? (await db`select 1 from project where key = ${src.key}`).length > 0 : true;
    return { ...t, suggestedTarget: { key: taken ? '' : src!.key, name: src?.name ?? '' } };
  });
  const run = (dryRun: boolean) => async ({ params, body, query, actor, c }: {
    params: Record<string, string>; body: z.infer<typeof ImportOptionsSchema>; query: unknown; actor: string; c: Parameters<typeof requirePermission>[0];
  }) => {
    const principal = requirePermission(c, 'PROJECT_TRANSFER');
    const t = await ownImport(params.id!, actor);
    // bestehendes Projekt: Projektadministration im Ziel
    if (body.target.mode === 'existing') await requireAccess(c, { level: 'manage', project: () => ({ kind: 'project', key: body.target.key }) });
    const exec = (onProgress?: (p: { phase: string; type?: string; done?: number }) => void) => importPackage(db, {
      path: importFile(t.id), options: body as ImportOptions, actor, userId: principal.userId, isSystemAdmin: principal.isSystemAdmin, attachmentDir, dryRun, transferId: t.id, onProgress,
      readableProjects: visibleProjectIdsOf(c),
    });
    if (dryRun) return exec();
    // Einspielen: nur einmal gleichzeitig
    const [claimed] = await db<ProjectTransfer[]>`update project_transfer set status = 'running', progress = ${db.json({ phase: 'Start' })}, error = null
      where id = ${t.id} and status = 'pending' returning *`;
    if (!claimed) throw conflict('Dieses Paket wird bereits eingespielt.');
    const job = (async () => {
      try {
        const report = await exec(progressWriter(db, t.id));
        if (report.problems.length) {
          await db`update project_transfer set status = 'pending', progress = null, report = ${db.json(report as never)}, error = ${report.problems.join('; ').slice(0, 2000)} where id = ${t.id}`;
          return report;
        }
        await db`update project_transfer set status = 'done', progress = null, project_id = ${report.target.projectId}, project_key = ${report.target.key},
          options = options || ${db.json({ target: body.target })}, counts = ${db.json(report.counts)}, report = ${db.json(report as never)}, error = null, finished_at = now() where id = ${t.id}`;
        await rm(importFile(t.id), { force: true });
        return report;
      } catch (e) {
        await db`update project_transfer set status = 'pending', progress = null, error = ${(e as Error).message.slice(0, 2000)} where id = ${t.id}`.catch(() => {});
        throw e;
      }
    })();
    if ((query as { background?: boolean } | undefined)?.background) {
      const tracked = job.then(() => undefined, () => undefined).finally(() => jobs.delete(t.id));
      jobs.set(t.id, tracked);
      return c.json((await getTransfer(db, t.id))!, 202);
    }
    const report = await job;
    if (report.problems.length) throw new HttpError(409, `Einspielen nicht möglich: ${report.problems.join('; ')}`, { report });
    return report;
  };
  route(app, {
    method: 'post', path: '/api/package-imports/:id/preview', tag, body: ImportOptionsSchema,
    summary: 'Probelauf: Import vollständig durchrechnen und zurücknehmen (Zählung, Personen, Kataloge, Warnungen, Hinderungsgründe)',
  }, run(true));
  route(app, {
    method: 'post', path: '/api/package-imports/:id/apply', tag, body: ImportOptionsSchema, query: z.object({ background: z.stringbool().optional() }),
    summary: 'Paket einspielen: als neues Projekt (die importierende Person wird Projektadmin) oder in ein bestehendes (target.mode = existing; Projektadmin im Ziel nötig)',
  }, run(false));
  route(app, { method: 'delete', path: '/api/package-imports/:id', tag, summary: 'Hochgeladenes Paket verwerfen', status: 204 }, async ({ params, actor }) => {
    const t = await ownImport(params.id!, actor);
    await db`update project_transfer set status = 'rejected', decided_by = ${actor}, decided_at = now(), decision_note = 'verworfen' where id = ${t.id}`;
    await rm(importFile(t.id), { force: true });
  });
}
