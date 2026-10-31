export const config = {
  port: Number(process.env.ANEMO_PORT ?? 8090),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://anemo:anemo@localhost:5433/anemo',
  /** Verzeichnis mit der gebauten Web-UI; im Container gesetzt, lokal übernimmt Vite. */
  webDist: process.env.WEB_DIST,
  /** Nur aus diesem Verzeichnis dürfen Migrations-Snapshots über die API importiert werden. */
  snapshotRoot: process.env.SNAPSHOT_ROOT ?? new URL('../../../migration-snapshots', import.meta.url).pathname,
  attachmentDir: process.env.ATTACHMENT_DIR ?? new URL('../../../.data/attachments', import.meta.url).pathname,
};
