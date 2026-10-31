import { resolve, sep } from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { badRequest, notFound, route } from '../../platform/http.ts';
import { runImport } from './importer.ts';
import { buildReport } from './verify.ts';
import { readdir } from 'node:fs/promises';

export function migrationRoutes(app: Hono, db: Db, snapshotRoot: string, attachmentDir: string): void {
  const tag = 'Migration';

  route(app, { method: 'get', path: '/api/migration/snapshots', access: 'admin', tag, summary: 'Verfügbare Snapshots im Snapshot-Verzeichnis' },
    async () => {
      const entries = await readdir(snapshotRoot, { withFileTypes: true }).catch(() => []);
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    });

  route(app, {
    method: 'post', path: '/api/migration/runs', access: 'admin', tag, summary: 'Import aus einem Snapshot starten (synchron)', status: 201,
    body: z.object({ snapshot: z.string().regex(/^[\w.-]+$/, 'Nur ein Verzeichnisname innerhalb des Snapshot-Verzeichnisses') }),
  }, async ({ body }) => {
    const dir = resolve(snapshotRoot, body.snapshot);
    if (!dir.startsWith(resolve(snapshotRoot) + sep)) throw badRequest('Ungültiger Snapshot-Pfad');
    const result = await runImport(db, dir, { attachmentDir });
    return { ...result, report: await buildReport(db, result.runId) };
  });

  route(app, { method: 'get', path: '/api/migration/runs', access: 'admin', tag, summary: 'Migrationsläufe' },
    () => db`select id, source, status, started_at, finished_at, stats from migration_run order by started_at desc limit 100`);

  route(app, { method: 'get', path: '/api/migration/runs/:id/report', access: 'admin', tag, summary: 'Verifikationsbericht eines Laufs' },
    ({ params }) => buildReport(db, params.id!));

  route(app, {
    method: 'get', path: '/api/migration/runs/:id/mappings', access: 'admin', tag, summary: 'Mapping-Zeilen eines Laufs (filterbar)',
    query: z.object({
      sourceType: z.string().optional(), outcome: z.string().optional(), field: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0),
    }),
  }, ({ params, query }) => db`
    select m.id, s.source_type, s.source_id, m.target_type, m.target_id, m.outcome, m.action, m.preserved_fields, m.messages,
           tc.key as target_key
    from migration_mapping m join source_record s on s.id = m.source_record_id
    left join test_case tc on m.target_type = 'TestCase' and tc.id = m.target_id
    where m.run_id = ${params.id!}
      ${query.sourceType ? db`and s.source_type = ${query.sourceType}` : db``}
      ${query.outcome ? db`and m.outcome = ${query.outcome}` : db``}
      ${query.field ? db`and ${query.field} = any(m.preserved_fields)` : db``}
    order by s.source_type, s.source_id limit ${query.limit} offset ${query.offset}`);

  route(app, { method: 'get', path: '/api/migration/provenance/:targetId', access: 'admin', tag, summary: 'Herkunft eines Zielobjekts: Rohdaten + letztes Mapping' },
    async ({ params }) => {
      const rows = await db`
        select s.source_system, s.source_type, s.source_id, s.payload, s.updated_at, m.outcome, m.action, m.preserved_fields, m.messages, m.run_id
        from migration_identity i
        join source_record s on s.source_system = i.source_system and s.source_type = i.source_type and s.source_id = i.source_id
        left join lateral (select * from migration_mapping mm where mm.source_record_id = s.id order by mm.id desc limit 1) m on true
        where i.target_id = ${params.targetId!}`;
      if (rows.length === 0) throw notFound('Migrationsherkunft', params.targetId);
      return rows;
    });
}
