/**
 * Startet Anemo für die Ende-zu-Ende-Tests: frische Datenbank `anemo_e2e`, eigener Port, gebaute Weboberfläche,
 * ohne .env (keine echten Zugangsdaten, keine Abgleiche mit Jira/OpenProject/GitLab).
 * Das zufällige Admin-Passwort steht nur in e2e/.state/admin-password (gitignored).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from '../server/src/platform/db.ts';

const root = new URL('..', import.meta.url).pathname;
const state = `${root}e2e/.state`;
const base = process.env.E2E_DATABASE_URL ?? 'postgres://anemo:anemo@localhost:5433/anemo';
const name = 'anemo_e2e';

rmSync(state, { recursive: true, force: true });
mkdirSync(`${state}/attachments`, { recursive: true });
const admin = connect(base, { max: 1 });
await admin.unsafe(`drop database if exists ${name} with (force)`);
await admin.unsafe(`create database ${name}`);
await admin.end();

const url = new URL(base);
url.pathname = `/${name}`;
const password = `E2e-${randomBytes(12).toString('base64url')}7`;
writeFileSync(`${state}/admin-password`, password, { mode: 0o600 });

// Schein-Sprachmodell (OpenAI-kompatibel) für die KI-Abläufe: feste Antworten je Skill (erkannt am System-Prompt)
const { createServer } = await import('node:http');
const answers: [RegExp, unknown][] = [
  [/Prüfe den Testfall/, { findings: [{ severity: 'hoch', step: 1, problem: 'Erwartung nicht beobachtbar', suggestion: 'Konkrete Anzeige nennen' }] }],
  [/Fehlermeldung/, { title: 'Gast sieht Admin-Menü', steps: ['Als Gast anmelden', 'Menü öffnen'], expected: 'Kein Admin-Menü', actual: 'Admin-Menü sichtbar', environment: 'E2E', severity: 'major', notes: '' }],
  [/Testmanager/, { assessment: 'Der Teststand ist überwiegend gut.', risks: [{ risk: 'Rollen', reason: 'ein Durchlauf fehlgeschlagen' }], recommendation: 'mit Auflagen', conditions: ['Fehler beheben'] }],
  [/Anforderung einen manuellen Testfall/, { title: 'PDF exportieren', objective: 'Export prüfen', preconditions: 'Akte vorhanden', steps: [{ action: 'Export wählen', data: '', expected: 'PDF wird erzeugt' }], gherkin: '' }],
];
const llm = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const system = (() => { try { return JSON.parse(body).messages?.[0]?.content ?? ''; } catch { return ''; } })();
    const hit = answers.find(([re]) => re.test(system));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: hit ? JSON.stringify(hit[1]) : 'OK' } }] }));
  });
});
await new Promise<void>((r) => llm.listen(Number(process.env.E2E_LLM_PORT ?? 8096), r));

for (const k of Object.keys(process.env)) if (/^(JIRA_|OPENPROJECT_|GITLAB_|OIDC_|LDAP_|SMTP_|AI_)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  ANEMO_PORT: process.env.E2E_PORT ?? '8097',
  WEB_DIST: `${root}web/dist`,
  ATTACHMENT_DIR: `${state}/attachments`,
  SNAPSHOT_ROOT: `${root}server/test/fixtures`,
  ANEMO_ADMIN_PASSWORD: password,
  ANEMO_JIRA_REFRESH_HOURS: '0',
  ANEMO_OPENPROJECT_REFRESH_MINUTES: '0',
  AI_BASE_URL: `http://localhost:${process.env.E2E_LLM_PORT ?? 8096}/v1`,
  AI_MODEL: 'schein-modell',
  AI_ON_PREM: 'true',
  ANEMO_SECRET_KEY: 'e2e-nur-fuer-tests',
});
await import('../server/src/main.ts');
