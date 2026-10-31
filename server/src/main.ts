import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { config } from './platform/config.ts';
import { connect } from './platform/db.ts';
import { migrate } from './platform/migrate.ts';
import { loadSettings, settingsEnv } from './platform/settings.ts';
import { startEventRelay } from './modules/events/index.ts';
import { bootstrapAdmin, cleanupSessions } from './modules/auth/index.ts';
import { jiraConfig, openProjectConfigured, refreshGitlabReferences, refreshJiraReferences, refreshOpenProjectReferences, syncAllFieldOptions } from './modules/integrations/index.ts';
import { startMailDispatcher, startWebhookDispatcher } from './modules/notifications/index.ts';
import { startBaselineWorker } from './modules/reports/index.ts';
import { cleanupTransferFiles } from './modules/transfer/index.ts';

const db = connect(config.databaseUrl);
await migrate(db, console.log);
// Einstellungen aus der Oberfläche (überschreiben Umgebungsvariablen)
await loadSettings(db);
const stopRelay = await startEventRelay(db);
const stopWebhooks = startWebhookDispatcher(db);
const stopMail = startMailDispatcher(db);
// abgelaufene Projektpakete (Exporte nach 24 h, nicht eingespielte Importe) stündlich entfernen
setInterval(() => cleanupTransferFiles(db).catch(() => {}), 3600_000).unref();
// Freigabestände (abgelegte Lieferpakete) nach Entscheidungen anlegen, nach einem Neustart nachholen
startBaselineWorker(db, config.attachmentDir);
const authMode = process.env.ANEMO_AUTH === 'off' ? 'off' : 'on';
if (authMode === 'off') console.warn('WARNUNG: ANEMO_AUTH=off – keine Anmeldung, alle Anfragen mit vollen Rechten. Nur für Entwicklung!');
else {
  // Datenverzeichnis (neben den Anhängen) ist auch im schreibgeschützten Container beschreibbar
  await bootstrapAdmin(db, join(dirname(config.attachmentDir), 'initial-admin-password.txt'), console.log);
  setInterval(() => cleanupSessions(db).catch(() => {}), 3600_000).unref();
}

// Hintergrundabgleiche (Takt aus den Einstellungen, Änderungen wirken ohne Neustart; 0 = aus):
// Jira-Tickets alle ANEMO_JIRA_REFRESH_HOURS Stunden, OpenProject/GitLab alle ANEMO_OPENPROJECT_REFRESH_MINUTES Minuten
const last = { jira: 0, op: Date.now(), fieldOptions: Date.now() - 5.5 * 3600_000 }; // Jira erstmals eine Minute nach dem Start
setInterval(() => {
  const env = settingsEnv();
  const jira = jiraConfig();
  const hours = Number(env.ANEMO_JIRA_REFRESH_HOURS ?? 6);
  if (jira && hours > 0 && Date.now() - last.jira >= hours * 3600_000) {
    last.jira = Date.now();
    refreshJiraReferences(db, jira).then((r) => console.log(`Jira-Verweise: ${r.checked} geprüft, ${r.updated} aktualisiert${r.error ? `, Fehler: ${r.error}` : ''}`), (e) => console.error('Jira-Abgleich', e));
  }
  const minutes = Number(env.ANEMO_OPENPROJECT_REFRESH_MINUTES ?? 15);
  if (minutes > 0 && Date.now() - last.op >= minutes * 60_000) {
    last.op = Date.now();
    if (openProjectConfigured()) refreshOpenProjectReferences(db).catch((e) => console.error('OpenProject-Abgleich', e));
    refreshGitlabReferences(db).catch((e) => console.error('GitLab-Abgleich', e));
  }
  // Auswahlwerte eigener Felder aus Jira/OpenProject (Stufe H5)
  const optHours = Number(env.ANEMO_FIELD_OPTIONS_REFRESH_HOURS ?? 6);
  if (optHours > 0 && Date.now() - last.fieldOptions >= optHours * 3600_000) {
    last.fieldOptions = Date.now();
    syncAllFieldOptions(db).then((r) => { if (r.synced || r.failed) console.log(`Feld-Auswahlwerte: ${r.synced} abgeglichen, ${r.failed} fehlgeschlagen`); }, (e) => console.error('Feld-Auswahlwerte', e));
  }
}, 60_000).unref();

const app = createApp({
  db,
  webDist: config.webDist,
  snapshotRoot: config.snapshotRoot,
  attachmentDir: config.attachmentDir,
  authMode,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Anemo läuft auf http://localhost:${info.port}  (OpenAPI: /api/openapi.json)`);
});

async function shutdown() {
  stopRelay();
  stopWebhooks();
  stopMail();
  server.close();
  await db.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
