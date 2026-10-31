/**
 * Freigabestand (Review 30.10.2026, F1): Zu jeder Freigabeentscheidung wird das Lieferpaket auf dem Server abgelegt
 * und seine Prüfsumme protokolliert (ReleaseBaselineCreated). So bleibt nachweisbar, auf welchem Stand entschieden
 * wurde – auch wenn sich Ergebnisse, Kriterien oder Statuskategorien später ändern. Änderungen nach der Entscheidung
 * zeigen Cockpit und Abschlussbericht an.
 *
 * Die Ablage liegt unter dem Anhangsverzeichnis (wird mit ihm gesichert). Entstehen wird der Stand nach der
 * Entscheidung (Ereignis-Abonnement) und beim Start bzw. Abruf nachgeholt, falls ein Neustart dazwischenkam.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { Db } from '../../platform/db.ts';
import { EventTypes, recordEvent } from '../events/index.ts';
import { buildPackage } from './package.ts';
import type { ProfileOptions } from './render.ts';

export interface ReleaseBaseline {
  id: string; planId: string; decision: string; decidedBy: string; decidedAt: Date; status: 'pending' | 'ready' | 'failed';
  packageName: string | null; packageSha256: string | null; packageBytes: number | null; error: string | null; createdAt: Date;
}

type ProfileLoader = (db: Db) => Promise<{ name: string; options: ProfileOptions }>;

export const baselineDir = (attachmentDir: string) => join(attachmentDir, '.release-baselines');
export const baselineFile = (attachmentDir: string, id: string) => join(baselineDir(attachmentDir), `${id}.zip`);

/** Fehlende Freigabestände anlegen (alle bzw. eines Testplans). Mehrfach aufrufbar; jeder Stand entsteht genau einmal. */
export async function ensureBaselines(db: Db, attachmentDir: string, profile: ProfileLoader, planId?: string): Promise<void> {
  // offene Entscheidungen ohne Stand; hängengebliebene Versuche (Neustart) nach zehn Minuten erneut
  const todo = await db<ReleaseBaseline[]>`
    insert into release_baseline(plan_id, decision, decided_by, decided_at)
    select p.id, p.release_decision, coalesce(p.release_by, 'system'), p.release_at from test_plan p
    where p.release_decision is not null and p.release_at is not null ${planId ? db`and p.id = ${planId}` : db``}
    on conflict (plan_id, decided_at) do update set status = 'pending', error = null, created_at = now()
      where release_baseline.status = 'failed' or (release_baseline.status = 'pending' and release_baseline.created_at < now() - interval '10 minutes')
    returning *`;
  for (const b of todo) await build(db, attachmentDir, profile, b);
}

async function build(db: Db, attachmentDir: string, profile: ProfileLoader, b: ReleaseBaseline): Promise<void> {
  const file = baselineFile(attachmentDir, b.id);
  try {
    await mkdir(baselineDir(attachmentDir), { recursive: true });
    const pkg = await buildPackage(db, { planId: b.planId, profile: await profile(db), actor: b.decidedBy, attachmentDir });
    const hash = createHash('sha256');
    let bytes = 0;
    const tap = new Transform({ transform(chunk: Buffer, _e, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); } });
    await pipeline(Readable.from(pkg.stream), tap, createWriteStream(file, { flags: 'w' }));
    const sha256 = hash.digest('hex');
    await db.begin(async (sql) => {
      const tx = sql as unknown as Db;
      await tx`update release_baseline set status = 'ready', package_name = ${pkg.name}, package_sha256 = ${sha256}, package_bytes = ${bytes} where id = ${b.id}`;
      await recordEvent(tx, { type: EventTypes.ReleaseBaselineCreated, aggregateType: 'TestPlan', aggregateId: b.planId, actor: b.decidedBy,
        payload: { baselineId: b.id, decision: b.decision, decidedAt: new Date(b.decidedAt).toISOString(), sha256, bytes, name: pkg.name } });
    });
  } catch (e) {
    await rm(file, { force: true });
    await db`update release_baseline set status = 'failed', error = ${(e as Error).message.slice(0, 2000)} where id = ${b.id}`;
    console.error('Freigabestand', b.id, e);
  }
}

export async function listBaselines(db: Db, planId: string): Promise<ReleaseBaseline[]> {
  return db<ReleaseBaseline[]>`select * from release_baseline where plan_id = ${planId} order by decided_at desc`;
}

