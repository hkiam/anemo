/**
 * Modul attachments: Anhänge an Testfällen, Ausführungen usw.
 * Speicherarten: LOCAL (Datei im Anhangsverzeichnis) und SOURCE (nur Verweis auf das Quellsystem,
 * z. B. noch nicht heruntergeladene Jira-Anhänge aus der Migration).
 */
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { badRequest, conflict, notFound, requireAccess, route } from '../../platform/http.ts';
import { EventTypes, recordEvent } from '../events/index.ts';

export interface Attachment {
  id: string;
  ownerType: string;
  ownerId: string;
  fileName: string;
  contentType: string | null;
  sizeBytes: number | null;
  storage: 'LOCAL' | 'SOURCE';
  location: string;
  author: string | null;
  createdAt: Date;
  /** Schritt (Testfall) bzw. Schrittergebnis (Ausführung), zu dem der Anhang gehört */
  stepId?: string | null;
}

const MAX_BYTES = 50 * 1024 * 1024;

export async function addSourceAttachment(
  db: Db,
  a: { ownerType: string; ownerId: string; fileName: string; contentType?: string | null; sizeBytes?: number | null; url: string; author?: string | null; createdAt?: Date; sourceKey?: string },
): Promise<void> {
  const [existing] = await db`select 1 from attachment where owner_type = ${a.ownerType} and owner_id = ${a.ownerId}
    and (location = ${a.url} or (source_key is not null and source_key = ${a.sourceKey ?? null}))`;
  if (existing) return;
  await db`
    insert into attachment(owner_type, owner_id, file_name, content_type, size_bytes, storage, location, author, created_at, source_key)
    values (${a.ownerType}, ${a.ownerId}, ${a.fileName}, ${a.contentType ?? null}, ${a.sizeBytes ?? null}, 'SOURCE', ${a.url},
            ${a.author ?? null}, ${a.createdAt ?? new Date()}, ${a.sourceKey ?? null})`;
}

/**
 * Übernimmt eine Datei (z. B. aus einem Migrations-Snapshot) in den Anhangsspeicher. Idempotent über
 * {@code sourceKey}: ein erneuter Import legt keinen zweiten Anhang an.
 */
export async function importLocalAttachment(
  db: Db, dir: string,
  a: { ownerType: string; ownerId: string; fileName: string; contentType?: string | null; filePath: string; sourceKey: string; author?: string | null; createdAt?: Date },
): Promise<'CREATED' | 'EXISTS'> {
  // Nur eine bereits lokal gespeicherte Kopie zählt als vorhanden – ein früherer reiner Verweis (SOURCE)
  // wird unten durch die Datei ersetzt.
  const [existing] = await db`select id from attachment where owner_type = ${a.ownerType} and owner_id = ${a.ownerId}
    and source_key = ${a.sourceKey} and storage = 'LOCAL'`;
  if (existing) return 'EXISTS';
  const size = (await stat(a.filePath)).size;
  const [row] = await db<{ id: string }[]>`
    insert into attachment(owner_type, owner_id, file_name, content_type, size_bytes, storage, location, author, created_at, source_key)
    values (${a.ownerType}, ${a.ownerId}, ${a.fileName}, ${a.contentType ?? null}, ${size}, 'LOCAL', '', ${a.author ?? null},
            ${a.createdAt ?? new Date()}, ${a.sourceKey})
    returning id`;
  await mkdir(dir, { recursive: true });
  // Kopieren statt in den Speicher laden (Anhänge können mehrere hundert MB groß sein)
  await copyFile(a.filePath, join(dir, row!.id));
  await db`update attachment set location = ${row!.id} where id = ${row!.id}`;
  // Ein früher nur verlinkter Anhang (SOURCE) wird durch die lokale Kopie ersetzt.
  await db`delete from attachment where owner_type = ${a.ownerType} and owner_id = ${a.ownerId} and storage = 'SOURCE' and source_key = ${a.sourceKey}`;
  return 'CREATED';
}

export async function listAttachments(db: Db, ownerType: string, ownerId: string): Promise<Attachment[]> {
  const rows = await db<Attachment[]>`
    select * from attachment where owner_type = ${ownerType} and owner_id = ${ownerId} order by created_at`;
  return rows.map((r) => ({ ...r, sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes) }));
}

const OWNER_TABLE: Record<string, string> = { TEST_CASE: 'test_case', TEST_EXECUTION: 'test_execution', TEST_CYCLE: 'test_cycle', TEST_PLAN: 'test_plan', EXPLORATORY_SESSION: 'exploratory_session' };

/** Anhangsverzeichnis (gesetzt beim Registrieren der Routen) – zum Entfernen der Dateien beim Löschen. */
let attachmentDir: string | null = null;

/** Alle Anhänge eines Objekts samt Dateien entfernen (z. B. beim Löschen eines Testfalls). */
export async function deleteAttachmentsOf(db: Db, ownerType: string, ownerId: string): Promise<number> {
  const rows = await db<{ storage: string; location: string }[]>`delete from attachment where owner_type = ${ownerType} and owner_id = ${ownerId} returning storage, location`;
  if (attachmentDir) for (const r of rows) if (r.storage === 'LOCAL' && /^[0-9a-f-]{36}$/i.test(r.location)) await rm(join(attachmentDir, r.location), { force: true });
  return rows.length;
}

export function attachmentRoutes(app: Hono, db: Db, dir: string): void {
  const tag = 'Anhänge';
  attachmentDir = dir;
  route(app, {
    method: 'delete', path: '/api/attachments/:id', tag, summary: 'Anhang löschen (Testfall: Pflegen; Ausführung/Sitzung: Ausführen, nicht in abgeschlossenen Zyklen)', status: 204,
  }, async ({ c, params, actor }) => {
    const [a] = await db<Attachment[]>`select * from attachment where id = ${params.id!}`;
    if (!a) throw notFound('Anhang', params.id);
    const executionLike = ['TEST_EXECUTION', 'EXPLORATORY_SESSION'].includes(a.ownerType);
    await requireAccess(c, { level: executionLike ? 'execute' : 'edit', project: () => ({ kind: 'attachment', id: a.id }) });
    if (a.ownerType === 'TEST_EXECUTION') {
      const [cy] = await db<{ state: string }[]>`select c.state from test_execution e join test_cycle c on c.id = e.cycle_id where e.id = ${a.ownerId}`;
      if (cy?.state === 'closed') throw conflict('Der Zyklus ist abgeschlossen – Evidenzen sind gesperrt.');
    }
    await db`delete from attachment where id = ${a.id}`;
    if (a.storage === 'LOCAL' && /^[0-9a-f-]{36}$/i.test(a.location)) await rm(join(dir, a.location), { force: true });
    await recordEvent(db, { type: EventTypes.AttachmentDeleted, aggregateType: a.ownerType, aggregateId: a.ownerId, actor, payload: { fileName: a.fileName, attachmentId: a.id } });
  });
  route(app, {
    method: 'get', path: '/api/attachments', access: { level: 'read', project: ({ query }) => ({ kind: 'owner', ...(query as { ownerType: string; ownerId: string }) }) }, tag, summary: 'Anhänge eines Objekts',
    query: z.object({ ownerType: z.string(), ownerId: z.uuid() }),
  }, ({ query }) => listAttachments(db, query.ownerType, query.ownerId));

  route(app, {
    method: 'post', path: '/api/attachments', tag, summary: 'Datei hochladen (multipart: ownerType, ownerId, file)', status: 201,
  }, async ({ c, actor }) => {
    const form = await c.req.parseBody();
    const file = form.file;
    const ownerType = String(form.ownerType ?? '');
    const ownerId = String(form.ownerId ?? '');
    // optional: Anhang gehört zu einem Schritt (Testfall) bzw. Schrittergebnis (Ausführung)
    const stepId = form.stepId ? String(form.stepId).slice(0, 200) : null;
    if (!(file instanceof File) || !OWNER_TABLE[ownerType] || !z.uuid().safeParse(ownerId).success) {
      throw badRequest('Erwartet: file, ownerType (TEST_CASE, TEST_EXECUTION, TEST_CYCLE, TEST_PLAN), ownerId');
    }
    const [owner] = await db`select 1 from ${db(OWNER_TABLE[ownerType]!)} where id = ${ownerId}`;
    if (!owner) throw notFound('Objekt', ownerId);
    await requireAccess(c, { level: ['TEST_EXECUTION', 'EXPLORATORY_SESSION'].includes(ownerType) ? 'execute' : 'edit', project: () => ({ kind: 'owner', ownerType, ownerId }) });
    if (file.size > MAX_BYTES) throw badRequest('Datei zu groß (max. 50 MB)');
    await mkdir(dir, { recursive: true });
    const [row] = await db<Attachment[]>`
      insert into attachment(owner_type, owner_id, file_name, content_type, size_bytes, storage, location, author, step_id)
      values (${ownerType}, ${ownerId}, ${file.name}, ${file.type || null}, ${file.size}, 'LOCAL', '', ${actor}, ${stepId})
      returning *`;
    await writeFile(join(dir, row!.id), Buffer.from(await file.arrayBuffer()));
    await db`update attachment set location = ${row!.id} where id = ${row!.id}`;
    return { ...row!, location: row!.id };
  });

  // Datei als Base64 (für Agenten/MCP und Skripte ohne Multipart)
  route(app, {
    method: 'post', path: '/api/attachments/base64', tag, summary: 'Datei als Base64 anhängen (max. 15 MB)', status: 201,
    access: ({ body }) => { const b = body as { ownerType: string; ownerId: string }; return { level: ['TEST_EXECUTION', 'EXPLORATORY_SESSION'].includes(b.ownerType) ? 'execute' : 'edit', project: () => ({ kind: 'owner', ownerType: b.ownerType, ownerId: b.ownerId }) }; },
    body: z.object({ ownerType: z.enum(['TEST_CASE', 'TEST_EXECUTION', 'EXPLORATORY_SESSION']), ownerId: z.uuid(), fileName: z.string().trim().min(1).max(200).regex(/^[^/\\]+$/), contentType: z.string().max(100).nullish(), contentBase64: z.string().max(20_000_000), stepId: z.string().max(200).nullish() }),
  }, async ({ body, actor }) => {
    const [owner] = await db`select 1 from ${db(OWNER_TABLE[body.ownerType]!)} where id = ${body.ownerId}`;
    if (!owner) throw notFound('Objekt', body.ownerId);
    const data = Buffer.from(body.contentBase64, 'base64');
    if (!data.length || data.length > 15 * 1024 * 1024) throw badRequest('Datei leer oder größer als 15 MB');
    await mkdir(dir, { recursive: true });
    const [row] = await db<Attachment[]>`
      insert into attachment(owner_type, owner_id, file_name, content_type, size_bytes, storage, location, author, step_id)
      values (${body.ownerType}, ${body.ownerId}, ${body.fileName}, ${body.contentType ?? null}, ${data.length}, 'LOCAL', '', ${actor}, ${body.stepId ?? null}) returning *`;
    await writeFile(join(dir, row!.id), data);
    await db`update attachment set location = ${row!.id} where id = ${row!.id}`;
    return { id: row!.id, fileName: row!.fileName, sizeBytes: data.length, stepId: row!.stepId ?? null };
  });

  // Anhang über seine Herkunft (z. B. jira-42465) – für absolute Jira-Bild-URLs in migrierten Texten
  app.get('/api/attachments/source/:key/content', async (c) => {
    await requireAccess(c, { level: 'read', project: () => ({ kind: 'attachmentSource', key: c.req.param('key') }) });
    const [a] = await db<{ id: string }[]>`select id from attachment where source_key = ${c.req.param('key')} and storage = 'LOCAL' limit 1`;
    if (!a) throw notFound('Anhang', c.req.param('key'));
    return c.redirect(`/api/attachments/${a.id}/content`);
  });

  app.get('/api/attachments/:id/content', async (c) => {
    if (!/^[0-9a-f-]{36}$/i.test(c.req.param('id'))) throw notFound('Anhang', c.req.param('id'));
    await requireAccess(c, { level: 'read', project: () => ({ kind: 'attachment', id: c.req.param('id') }) });
    const [a] = await db<Attachment[]>`select * from attachment where id = ${c.req.param('id')}`;
    if (!a) throw notFound('Anhang', c.req.param('id'));
    if (a.storage === 'SOURCE') return c.redirect(a.location);
    const path = join(dir, a.location);
    const info = await stat(path).catch(() => null);
    // Nur unkritische Typen inline anzeigen; alles andere (z. B. HTML, SVG) als Download (XSS-Schutz).
    const inline = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain)$/.test(a.contentType ?? '');
    if (!info) throw notFound('Anhangsdatei', a.id);
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: {
        'content-length': String(info.size),
        'content-type': inline ? a.contentType! : 'application/octet-stream',
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
        'x-content-type-options': 'nosniff',
      },
    });
  });
}
