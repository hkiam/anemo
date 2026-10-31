/**
 * Startet Anemo für die Screenshots der Dokumentation: frische Datenbank `anemo_showcase`, eigener Port, gebaute
 * Weboberfläche, ohne .env (keine echten Zugangsdaten, keine Abgleiche mit Jira/OpenProject/GitLab). Alle Inhalte sind
 * fiktiv und werden von showcase.spec.ts über die API angelegt.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from '../../server/src/platform/db.ts';

const root = new URL('../..', import.meta.url).pathname;
const state = `${root}tools/screenshots/.state`;
const base = process.env.SHOWCASE_DATABASE_URL ?? 'postgres://anemo:anemo@localhost:5433/anemo';
const name = 'anemo_showcase';

rmSync(state, { recursive: true, force: true });
mkdirSync(`${state}/attachments`, { recursive: true });
const admin = connect(base, { max: 1 });
await admin.unsafe(`drop database if exists ${name} with (force)`);
await admin.unsafe(`create database ${name}`);
await admin.end();

const url = new URL(base);
url.pathname = `/${name}`;
const password = `Show-${randomBytes(12).toString('base64url')}7`;
writeFileSync(`${state}/admin-password`, password, { mode: 0o600 });

for (const k of Object.keys(process.env)) if (/^(JIRA_|OPENPROJECT_|GITLAB_|OIDC_|LDAP_|SMTP_|AI_)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  ANEMO_PORT: process.env.SHOWCASE_PORT ?? '8098',
  WEB_DIST: `${root}web/dist`,
  ATTACHMENT_DIR: `${state}/attachments`,
  ANEMO_ADMIN_PASSWORD: password,
  ANEMO_JIRA_REFRESH_HOURS: '0',
  ANEMO_OPENPROJECT_REFRESH_MINUTES: '0',
  ANEMO_SECRET_KEY: 'showcase-nur-fuer-screenshots',
});
await import('../../server/src/main.ts');
