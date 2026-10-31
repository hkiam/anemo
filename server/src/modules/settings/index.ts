/**
 * Modul settings: Einstellungen in der Oberfläche (ADR-0025). Umgebungsvariablen sind die Vorbelegung, Werte aus der
 * Oberfläche überschreiben sie; „Zurücksetzen“ stellt die Vorbelegung wieder her. Geheimnisse verlassen den Server nie.
 */
import { versionInfo } from '../../platform/version.ts';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { route } from '../../platform/http.ts';
import { describeSettings, SETTING_GROUPS, saveSettings, settingsLog } from '../../platform/settings.ts';

export function settingsRoutes(app: Hono, db: Db): void {
  // Version: kurz für alle Angemeldeten (Kontomenü), ausführlich für die Systemadministration
  route(app, { method: 'get', path: '/api/version', tag: 'Administration: Einstellungen', summary: 'Version der Anwendung (Versionsnummer, Commit)' },
    async () => { const v = versionInfo(); return { version: v.version, commit: v.commit, label: v.label }; });
  route(app, { method: 'get', path: '/api/admin/system', tag: 'Administration: Einstellungen', summary: 'Version und Systemangaben (Build, Start, Node, PostgreSQL, Datenbankstand)', access: 'admin' },
    async () => {
      const [pg] = await db<{ v: string }[]>`select current_setting('server_version') as v`;
      const [mig] = await db<{ name: string; appliedAt: Date }[]>`select name, applied_at from schema_migration order by name desc limit 1`;
      return { ...versionInfo(), node: process.version, postgres: pg?.v ?? null, migration: mig?.name ?? null, migratedAt: mig?.appliedAt ?? null };
    });
  const tag = 'Administration: Einstellungen';
  route(app, { method: 'get', path: '/api/admin/settings', tag, summary: 'Einstellungen mit Herkunft (Oberfläche, Umgebung, Standard); Geheimnisse nur als „gesetzt“', access: 'admin' },
    async () => ({ groups: SETTING_GROUPS, settings: describeSettings(), log: await settingsLog(db) }));
  route(app, {
    method: 'put', path: '/api/admin/settings', tag, summary: 'Einstellungen ändern (Wert = festlegen, "" = abschalten, null = auf Umgebung/Standard zurücksetzen)', access: 'admin',
    body: z.object({ changes: z.record(z.string(), z.string().nullable()) }),
  }, async ({ body, actor }) => ({ settings: await saveSettings(db, body.changes, actor), log: await settingsLog(db) }));
}
