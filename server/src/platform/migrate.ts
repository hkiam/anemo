import { readdir, readFile } from 'node:fs/promises';
import type { Db } from './db.ts';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

/** Spielt alle noch nicht angewendeten SQL-Dateien in Namensreihenfolge ein (je Datei eine Transaktion). */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  await db`create table if not exists schema_migration (name text primary key, applied_at timestamptz not null default now())`;
  const applied: string[] = [];
  await db.begin(async (tx) => {
    // Migrationen dürfen länger laufen als das Zeitlimit normaler Anfragen
    await tx`set local statement_timeout = 0`;
    await tx`select pg_advisory_xact_lock(4711)`;
    const done = new Set((await tx<{ name: string }[]>`select name from schema_migration`).map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sqlText = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      await tx.unsafe(sqlText);
      await tx`insert into schema_migration(name) values (${file})`;
      applied.push(file);
      log(`Migration angewendet: ${file}`);
    }
  });
  return applied;
}
