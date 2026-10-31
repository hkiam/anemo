import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { createApp } from '../src/app.ts';
import type { AuthMode } from '../src/modules/auth/index.ts';
import { connect, type Db } from '../src/platform/db.ts';
import { migrate } from '../src/platform/migrate.ts';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://anemo:anemo@localhost:5433/anemo';
export const FIXTURE = new URL('./fixtures/zephyr-demo', import.meta.url).pathname;
export const FIXTURES_ROOT = new URL('./fixtures', import.meta.url).pathname;

export interface TestEnv {
  db: Db;
  app: Hono;
  /** JSON-Aufruf gegen die App (ohne Netzwerk). */
  call: <T = any>(method: string, path: string, body?: unknown, user?: string) => Promise<{ status: number; body: T }>;
  close: () => Promise<void>;
}

/** Eigene, frisch migrierte Datenbank je Testdatei – Tests laufen parallel und isoliert. */
export async function testEnv(opts: { authMode?: AuthMode } = {}): Promise<TestEnv> {
  const name = `anemo_test_${randomBytes(4).toString('hex')}`;
  const admin = connect(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const db = connect(url.toString(), { max: 5 });
  await migrate(db);
  const app = createApp({ db, attachmentDir: await mkdtemp(join(tmpdir(), 'anemo-att-')), snapshotRoot: FIXTURES_ROOT, authMode: opts.authMode ?? 'off' });
  return {
    db,
    app,
    async call(method, path, body, user = 'tester') {
      const res = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json', 'x-anemo-user': user },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      await db.end();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}
