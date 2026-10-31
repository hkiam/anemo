/**
 * Einstellungen: Umgebungsvariablen geben die Vorbelegung (z. B. beim Containerstart), Werte aus der Oberfläche
 * überschreiben sie. Alle Konfigurationsfunktionen lesen über {@link settingsEnv} – Änderungen wirken ohne Neustart.
 * Geheimnisse werden mit AES-256-GCM verschlüsselt gespeichert und nie an die Oberfläche zurückgegeben.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.ts';
import type { Db } from './db.ts';
import { HttpError } from './http.ts';

export type SettingType = 'text' | 'url' | 'secret' | 'bool' | 'number' | 'select' | 'textarea';
export interface SettingDef {
  key: string; group: string; label: string; type: SettingType;
  /** Wert, der gilt, wenn weder Umgebung noch Oberfläche etwas setzen */
  default?: string; options?: { value: string; label: string }[]; hint?: string; placeholder?: string;
}
export interface SettingGroup { id: string; title: string; description: string }

export const SETTING_GROUPS: SettingGroup[] = [
  { id: 'general', title: 'Allgemein', description: 'Öffentliche Adresse, Aufbewahrung und Hintergrundabgleiche ohne eigene Anbindung.' },
  { id: 'ai', title: 'KI', description: 'Optionales Sprachmodell – on-prem (z. B. vLLM, Ollama, LM Studio, LocalAI) oder extern (OpenAI-kompatibel, Azure OpenAI, Anthropic).' },
  { id: 'ai-strong', title: 'KI: Profil „stark“', description: 'Optionales zweites Modell, z. B. extern und leistungsfähiger; je Skill wählbar. Projekte mit gesperrten externen Diensten nutzen es nur, wenn es on-prem läuft.' },
  { id: 'links', title: 'Freie Links (URL)', description: 'Statt eines Tickets eine beliebige Adresse mit Kurznamen verknüpfen – z. B. Fehler in Systemen ohne Anbindung, Dokumente, Wiki-Seiten.' },
  { id: 'accounts', title: 'Konten und Kennwörter', description: 'Regeln für lokale Konten: Kennwortlänge, Sperre nach Fehlversuchen, Zurücksetzen per E-Mail-Link.' },
  { id: 'oidc', title: 'Anmeldung: SSO (OIDC)', description: 'Keycloak, Microsoft Entra ID oder ein anderer OpenID-Connect-Anbieter.' },
  { id: 'ldap', title: 'Anmeldung: LDAP / Active Directory', description: 'Anmeldung mit Verzeichniskonten, Gruppen aus dem Verzeichnis.' },
  { id: 'smtp', title: 'E-Mail', description: 'Versand von Benachrichtigungen.' },
  { id: 'openproject', title: 'OpenProject', description: 'Fehler und Anforderungen in OpenProject verknüpfen und anlegen.' },
  { id: 'opbacklink', title: 'OpenProject: Rückverweis', description: 'Felder in OpenProject, die beim Anlegen den Bezug zu Anemo erhalten.' },
  { id: 'gitlab', title: 'GitLab', description: 'Gherkin-Testfälle mit Repositories abgleichen, Merge-Requests verknüpfen.' },
  { id: 'jira', title: 'Jira (Parallelbetrieb)', description: 'Status verknüpfter Tickets abgleichen; auf Wunsch Fehler direkt in Jira anlegen.' },
];

const bool = (key: string, group: string, label: string, def: 'true' | 'false', hint?: string): SettingDef =>
  ({ key, group, label, type: 'bool', default: def, ...(hint ? { hint } : {}) });

export const SETTINGS: SettingDef[] = [
  { key: 'ANEMO_PUBLIC_URL', group: 'general', label: 'Öffentliche Adresse', type: 'url', placeholder: 'https://anemo.firma.de', hint: 'für Links in Mails, Rückverweise und SSO-Rücksprung' },
  { key: 'ANEMO_ACCESS_LOG_DAYS', group: 'general', label: 'Zugriffsprotokoll aufbewahren (Tage)', type: 'number', default: '730', hint: 'eingeschränkte Projekte' },
  { key: 'ANEMO_FIELD_OPTIONS_REFRESH_HOURS', group: 'general', label: 'Auswahlwerte eigener Felder abgleichen alle … Stunden', type: 'number', default: '6', hint: 'aus Jira/OpenProject; 0 = aus' },

  bool('AI_ENABLED', 'ai', 'KI-Funktionen eingeschaltet', 'true', 'Hauptschalter: aus = keine Anfrage an ein Sprachmodell, KI-Schaltflächen verschwinden'),
  { key: 'AI_PROVIDER', group: 'ai', label: 'Schnittstelle', type: 'select', default: 'openai', options: [
    { value: 'openai', label: 'OpenAI-kompatibel (vLLM, Ollama, LM Studio, LocalAI, Azure OpenAI, OpenAI …)' },
    { value: 'anthropic', label: 'Anthropic (Claude)' },
  ] },
  { key: 'AI_BASE_URL', group: 'ai', label: 'Basis-URL', type: 'url', placeholder: 'http://llm.intern:8000/v1', hint: 'OpenAI-kompatibel: bis einschließlich /v1; Ollama: http://host:11434/v1' },
  { key: 'AI_MODEL', group: 'ai', label: 'Modell', type: 'text', placeholder: 'z. B. Qwen/Qwen3-8B, qwen3:8b, llama3.1:70b, gpt-4o, claude-sonnet-4-5', hint: 'Name wie beim Server (vLLM: --served-model-name bzw. /v1/models)' },
  { key: 'AI_API_KEY', group: 'ai', label: 'API-Schlüssel', type: 'secret', hint: 'bei lokalen Modellen meist leer' },
  { key: 'AI_EXTRA_BODY', group: 'ai', label: 'Zusätzliche Anfrageparameter (JSON)', type: 'textarea', placeholder: '{"chat_template_kwargs": {"enable_thinking": false}}',
    hint: 'werden in jede Anfrage übernommen; Qwen3 auf vLLM: Denkphase abschalten wie im Beispiel (schneller, weniger Token). <think>-Blöcke werden ohnehin entfernt.' },
  bool('AI_ON_PREM', 'ai', 'Modell läuft im eigenen Netz (on-prem)', 'false', 'on-prem-Modelle dürfen auch Inhalte von Projekten mit gesperrten externen Diensten verarbeiten'),
  { key: 'AI_MAX_REQUESTS_PER_HOUR', group: 'ai', label: 'Höchstens … Anfragen pro Stunde', type: 'number', default: '200', hint: 'Kostenbremse über alle Benutzer; 0 = unbegrenzt' },
  bool('AGENTS_ENABLED', 'ai', 'KI-Agenten (MCP-Schnittstelle) zulassen', 'true', 'aus = /api/mcp lehnt alle Anfragen ab; Agentenkonten bleiben bestehen'),

  { key: 'AI_STRONG_PROVIDER', group: 'ai-strong', label: 'Schnittstelle', type: 'select', default: 'openai', options: [
    { value: 'openai', label: 'OpenAI-kompatibel (vLLM, Ollama, Azure OpenAI, OpenAI …)' }, { value: 'anthropic', label: 'Anthropic (Claude)' },
  ] },
  { key: 'AI_STRONG_BASE_URL', group: 'ai-strong', label: 'Basis-URL', type: 'url', placeholder: 'https://api.openai.com/v1' },
  { key: 'AI_STRONG_MODEL', group: 'ai-strong', label: 'Modell', type: 'text', placeholder: 'leer = Profil nicht eingerichtet' },
  { key: 'AI_STRONG_API_KEY', group: 'ai-strong', label: 'API-Schlüssel', type: 'secret' },
  { key: 'AI_STRONG_EXTRA_BODY', group: 'ai-strong', label: 'Zusätzliche Anfrageparameter (JSON)', type: 'textarea', placeholder: '{"chat_template_kwargs": {"enable_thinking": false}}' },
  bool('AI_STRONG_ON_PREM', 'ai-strong', 'Modell läuft im eigenen Netz (on-prem)', 'false'),

  bool('ANEMO_URL_LINKS', 'links', 'Freie Links erlauben', 'false', 'Verknüpfen per URL mit Kurznamen an Testfällen, Ausführungen, Zyklen, Testplänen und Sitzungen'),
  { key: 'ANEMO_URL_LINK_DOMAINS', group: 'links', label: 'Erlaubte Domains', type: 'text', placeholder: 'z. B. firma.de, *.firma.de, wiki.example.org', hint: 'kommagetrennt; *.domain erlaubt alle Unterdomains; leer = alle http(s)-Adressen' },
  { key: 'ANEMO_PASSWORD_MIN_LENGTH', group: 'accounts', label: 'Mindestlänge des Kennworts', type: 'number', default: '12', hint: '8 bis 128 Zeichen; gilt für lokale Konten' },
  { key: 'ANEMO_LOGIN_LOCK_AFTER', group: 'accounts', label: 'Vorübergehende Sperre nach … Fehlversuchen', type: 'number', default: '5', hint: 'Sperrdauer wächst mit jedem weiteren Fehlversuch bis 15 Minuten; Administration kann entsperren' },
  bool('ANEMO_PASSWORD_SELF_RESET', 'accounts', '„Kennwort vergessen?“ anbieten', 'true', 'nur wirksam mit E-Mail-Versand und öffentlicher Adresse; der Link geht an die hinterlegte E-Mail-Adresse'),
  { key: 'ANEMO_PASSWORD_RESET_MINUTES', group: 'accounts', label: 'Gültigkeit des Links zum Zurücksetzen (Minuten)', type: 'number', default: '60' },
  { key: 'OIDC_ISSUER', group: 'oidc', label: 'Issuer', type: 'url', placeholder: 'https://sso.firma.de/realms/firma', hint: 'Entra ID: https://login.microsoftonline.com/<tenant>/v2.0' },
  { key: 'OIDC_CLIENT_ID', group: 'oidc', label: 'Client-ID', type: 'text' },
  { key: 'OIDC_CLIENT_SECRET', group: 'oidc', label: 'Client-Secret', type: 'secret' },
  { key: 'OIDC_LABEL', group: 'oidc', label: 'Beschriftung der Schaltfläche', type: 'text', default: 'Mit Firmenkonto anmelden' },
  { key: 'OIDC_SCOPES', group: 'oidc', label: 'Scopes', type: 'text', default: 'openid profile email' },
  { key: 'OIDC_USERNAME_CLAIM', group: 'oidc', label: 'Claim für den Benutzernamen', type: 'text', default: 'preferred_username' },
  bool('OIDC_USERNAME_STRIP_DOMAIN', 'oidc', 'Domäne vom Benutzernamen entfernen (name@firma.de → name)', 'true'),
  { key: 'OIDC_GROUPS_CLAIM', group: 'oidc', label: 'Claim(s) für Gruppen', type: 'text', default: 'groups', hint: 'mehrere mit Komma, Pfade mit Punkt (realm_access.roles); Entra: roles' },
  bool('OIDC_GROUPS_FULL_PATH', 'oidc', 'Gruppen mit vollem Pfad (Keycloak /a/b)', 'false'),
  { key: 'OIDC_ADMIN_GROUP', group: 'oidc', label: 'Gruppe für Systemadministration', type: 'text' },
  { key: 'OIDC_TOKEN_AUTH', group: 'oidc', label: 'Client-Authentifizierung', type: 'select', default: 'basic', options: [{ value: 'basic', label: 'HTTP Basic (Keycloak)' }, { value: 'post', label: 'im Formular (Entra ID)' }] },
  bool('OIDC_LOGOUT', 'oidc', 'Beim Abmelden auch beim Anbieter abmelden', 'true'),

  { key: 'LDAP_URL', group: 'ldap', label: 'Server', type: 'url', placeholder: 'ldaps://dc.firma.de:636' },
  { key: 'LDAP_BASE_DN', group: 'ldap', label: 'Basis-DN', type: 'text', placeholder: 'DC=firma,DC=de' },
  { key: 'LDAP_BIND_DN', group: 'ldap', label: 'Dienstkonto (Bind-DN)', type: 'text' },
  { key: 'LDAP_BIND_PASSWORD', group: 'ldap', label: 'Kennwort des Dienstkontos', type: 'secret' },
  { key: 'LDAP_USER_FILTER', group: 'ldap', label: 'Benutzerfilter', type: 'text', default: '(&(objectClass=person)(|(sAMAccountName={username})(uid={username})))' },
  { key: 'LDAP_USERNAME_ATTR', group: 'ldap', label: 'Attribut für den Benutzernamen', type: 'text', placeholder: 'sAMAccountName' },
  { key: 'LDAP_GROUP_FILTER', group: 'ldap', label: 'Gruppenfilter', type: 'text' },
  { key: 'LDAP_GROUP_BASE_DN', group: 'ldap', label: 'Basis-DN der Gruppen', type: 'text' },
  { key: 'LDAP_GROUP_PATTERN', group: 'ldap', label: 'Nur Gruppen, die passen (regulärer Ausdruck)', type: 'text', placeholder: '^QA-' },
  { key: 'LDAP_ADMIN_GROUP', group: 'ldap', label: 'Gruppe für Systemadministration', type: 'text' },
  bool('LDAP_TLS_INSECURE', 'ldap', 'Zertifikat nicht prüfen (nur Test!)', 'false'),

  { key: 'SMTP_HOST', group: 'smtp', label: 'Server', type: 'text', placeholder: 'smtp.firma.de' },
  { key: 'SMTP_PORT', group: 'smtp', label: 'Port', type: 'number', default: '587' },
  { key: 'SMTP_SECURE', group: 'smtp', label: 'Verschlüsselung', type: 'select', options: [{ value: 'starttls', label: 'STARTTLS (587)' }, { value: 'tls', label: 'TLS (465)' }, { value: 'none', label: 'keine (25, nur intern)' }], hint: 'leer = nach Port' },
  { key: 'SMTP_USER', group: 'smtp', label: 'Benutzer', type: 'text' },
  { key: 'SMTP_PASSWORD', group: 'smtp', label: 'Kennwort', type: 'secret' },
  { key: 'SMTP_FROM', group: 'smtp', label: 'Absender', type: 'text', placeholder: 'Anemo <anemo@firma.de>' },
  bool('SMTP_TLS_INSECURE', 'smtp', 'Zertifikat nicht prüfen (nur Test!)', 'false'),

  { key: 'OPENPROJECT_URL', group: 'openproject', label: 'Adresse', type: 'url', placeholder: 'https://openproject.firma.de' },
  { key: 'OPENPROJECT_API_KEY', group: 'openproject', label: 'API-Schlüssel (Servicekonto)', type: 'secret' },
  { key: 'OPENPROJECT_LINK_FIELD', group: 'opbacklink', label: 'Feld für den Rückverweis (Link)', type: 'text', placeholder: 'customField34',
    hint: 'Benutzerdefiniertes Feld vom Typ Link; Auswahl unter Anbindungen → OpenProject → Rückverweis' },
  { key: 'OPENPROJECT_TESTCASE_FIELD', group: 'opbacklink', label: 'Feld für den Testfall (Text)', type: 'text', placeholder: 'customField35',
    hint: 'optional; erhält den Testfallschlüssel, z. B. DEMO-T29' },
  { key: 'ANEMO_OPENPROJECT_REFRESH_MINUTES', group: 'openproject', label: 'Status abgleichen alle … Minuten', type: 'number', default: '15', hint: 'gilt auch für GitLab; 0 = aus' },

  { key: 'GITLAB_URL', group: 'gitlab', label: 'Adresse', type: 'url', placeholder: 'https://gitlab.firma.de' },
  { key: 'GITLAB_TOKEN', group: 'gitlab', label: 'Token (Bereich api)', type: 'secret' },

  { key: 'JIRA_BASE_URL', group: 'jira', label: 'Adresse', type: 'url', placeholder: 'https://jira.firma.de', hint: 'alternativ JIRA_HOST (nur Rechnername) in der Umgebung' },
  { key: 'JIRA_USER', group: 'jira', label: 'Benutzer', type: 'text' },
  { key: 'JIRA_PASSWORD', group: 'jira', label: 'Kennwort', type: 'secret' },
  { key: 'JIRA_TOKEN', group: 'jira', label: 'Persönliches Zugriffstoken', type: 'secret', hint: 'statt Benutzer/Kennwort' },
  { key: 'ANEMO_JIRA_REFRESH_HOURS', group: 'jira', label: 'Status abgleichen alle … Stunden', type: 'number', default: '6', hint: '0 = aus' },
  bool('JIRA_CREATE_DEFECTS', 'jira', 'Fehler in Jira anlegen', 'false', 'schreibt in Jira – nur für Projekte, die einem Jira-Projekt zugeordnet und keinem OpenProject-Projekt zugeordnet sind'),
];
const DEFS = new Map(SETTINGS.map((d) => [d.key, d]));
const isSecret = (key: string) => DEFS.get(key)?.type === 'secret';

/**
 * Ziel-Adresse → zugehörige Geheimnisse. Wer die Adresse ändert, muss das Geheimnis neu eingeben – sonst ginge das
 * verdeckte Geheimnis an ein neues (womöglich fremdes) Ziel („Geheimnisse verlassen den Server nie“).
 */
export const SECRET_FOR_TARGET: Record<string, string[]> = {
  OPENPROJECT_URL: ['OPENPROJECT_API_KEY'],
  GITLAB_URL: ['GITLAB_TOKEN'],
  JIRA_BASE_URL: ['JIRA_TOKEN', 'JIRA_PASSWORD'],
  AI_BASE_URL: ['AI_API_KEY'],
  AI_STRONG_BASE_URL: ['AI_STRONG_API_KEY'],
  SMTP_HOST: ['SMTP_PASSWORD'],
  LDAP_URL: ['LDAP_BIND_PASSWORD'],
  OIDC_ISSUER: ['OIDC_CLIENT_SECRET'],
};
const normTarget = (v: string | null | undefined) => (v ?? '').trim().replace(/\/+$/, '').toLowerCase();

// ---------------------------------------------------------------------------------------------
// Verschlüsselung der Geheimnisse
// ---------------------------------------------------------------------------------------------

let cachedKey: Buffer | null = null;
/** Schlüssel aus ANEMO_SECRET_KEY oder – beim ersten Bedarf erzeugt – aus der Datei neben den Anhängen (0600). */
function secretKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.ANEMO_SECRET_KEY;
  if (fromEnv) return (cachedKey = createHash('sha256').update(fromEnv).digest());
  const file = process.env.ANEMO_SECRET_KEY_FILE ?? join(dirname(config.attachmentDir), 'secret.key');
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
  }
  return (cachedKey = createHash('sha256').update(readFileSync(file, 'utf8').trim()).digest());
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}

function decrypt(stored: string): string | null {
  try {
    const [iv, tag, enc] = stored.split('.').map((p) => Buffer.from(p, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', secretKey(), iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(enc!), d.final()]).toString('utf8');
  } catch {
    return null; // falscher Schlüssel (z. B. Datei verloren): Wert ignorieren, Umgebung gilt
  }
}

// ---------------------------------------------------------------------------------------------
// Laden, Lesen, Speichern
// ---------------------------------------------------------------------------------------------

const overrides = new Map<string, string>();
const unreadable = new Set<string>();
let merged: NodeJS.ProcessEnv | null = null;
const listeners = new Set<(keys: string[]) => void>();

/** Lädt die Einstellungen aus der Datenbank (beim Start und nach Änderungen). */
export async function loadSettings(db: Db): Promise<void> {
  const rows = await db<{ key: string; value: string; secret: boolean }[]>`select key, value, secret from app_setting`;
  overrides.clear();
  unreadable.clear();
  for (const r of rows) {
    const v = r.secret ? decrypt(r.value) : r.value;
    if (v === null) unreadable.add(r.key);
    else overrides.set(r.key, v);
  }
  merged = null;
}

/** Wirksame Konfiguration: Umgebung, überschrieben durch die Oberfläche. Ein leerer Wert schaltet eine Vorbelegung ab. */
export function settingsEnv(): NodeJS.ProcessEnv {
  if (!overrides.size) return process.env;
  if (!merged) {
    merged = { ...process.env };
    for (const [k, v] of overrides) {
      if (v === '') delete merged[k];
      else merged[k] = v;
    }
  }
  return merged;
}

/** Wird nach Änderungen aufgerufen (z. B. um Caches zu leeren). */
export function onSettingsChanged(fn: (keys: string[]) => void): void {
  listeners.add(fn);
}

export interface SettingView extends SettingDef {
  /** Wirksamer Wert (bei Geheimnissen nie enthalten) */
  value: string | null;
  source: 'ui' | 'env' | 'default' | 'none';
  /** Wert aus der Umgebung (bei Geheimnissen nur „gesetzt“) */
  envValue: string | null;
  unreadable?: boolean;
}

export function describeSettings(): SettingView[] {
  return SETTINGS.map((d) => {
    const env = process.env[d.key];
    const ui = overrides.get(d.key);
    const source: SettingView['source'] = ui !== undefined ? 'ui' : env !== undefined && env !== '' ? 'env' : d.default !== undefined ? 'default' : 'none';
    const raw = ui !== undefined ? (ui === '' ? null : ui) : env || d.default || null;
    const hide = (v: string | null | undefined) => (v ? (d.type === 'secret' ? '••••••' : v) : null);
    return { ...d, value: hide(raw), source, envValue: hide(env), ...(unreadable.has(d.key) ? { unreadable: true } : {}) };
  });
}

/**
 * Änderungen speichern: Wert = in der Oberfläche festlegen, null = auf Umgebung/Standard zurücksetzen.
 * Leerer Text schaltet eine Vorbelegung aus der Umgebung ab (z. B. Integration deaktivieren).
 */
export async function saveSettings(db: Db, changes: Record<string, string | null>, actor: string): Promise<SettingView[]> {
  for (const [key, value] of Object.entries(changes)) {
    const d = DEFS.get(key);
    if (!d) throw new HttpError(400, `Unbekannte Einstellung: ${key}`);
    if (value === null) continue;
    if (value.length > 4000) throw new HttpError(400, `${d.label}: Wert zu lang`);
    if (value && d.type === 'number' && !/^\d+$/.test(value)) throw new HttpError(400, `${d.label}: nur ganze Zahlen`);
    if (value && d.type === 'bool' && !['true', 'false'].includes(value)) throw new HttpError(400, `${d.label}: true oder false`);
    if (value && d.type === 'url' && !/^(https?|ldaps?):\/\/\S+$/i.test(value)) throw new HttpError(400, `${d.label}: vollständige Adresse mit http(s):// bzw. ldap(s)://`);
    if (value && d.type === 'select' && d.options && !d.options.some((o) => o.value === value)) throw new HttpError(400, `${d.label}: ungültige Auswahl`);
    if (value && key.endsWith('EXTRA_BODY')) {
      let v: unknown;
      try { v = JSON.parse(value); } catch { throw new HttpError(400, `${d.label}: kein gültiges JSON`); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `${d.label}: ein JSON-Objekt erwartet`);
      const fixed = Object.keys(v).filter((k) => ['model', 'messages', 'system', 'stream', 'max_tokens', 'max_completion_tokens', 'n'].includes(k));
      if (fixed.length) throw new HttpError(400, `${d.label}: ${fixed.join(', ')} legt Anemo selbst fest`);
    }
    if (key === 'LDAP_GROUP_PATTERN' && value) {
      try { new RegExp(value); } catch { throw new HttpError(400, `${d.label}: ungültiger regulärer Ausdruck`); }
    }
  }
  // Ziel-Adresse geändert, Geheimnis aber nicht neu eingegeben → ablehnen
  const env = settingsEnv();
  for (const [target, secrets] of Object.entries(SECRET_FOR_TARGET)) {
    // Zurücksetzen (null) führt auf die Adresse aus der Umgebung – die legt der Betrieb fest, nicht die Oberfläche
    if (!(target in changes) || changes[target] === null) continue;
    const next = changes[target]!;
    if (!normTarget(next) || normTarget(next) === normTarget(env[target])) continue;
    const active = secrets.filter((k) => !!env[k]);
    if (!active.length) continue;
    if (active.some((k) => changes[k] === undefined || changes[k] === null)) {
      const labels = active.map((k) => `„${DEFS.get(k)?.label ?? k}“`).join(' bzw. ');
      const group = SETTING_GROUPS.find((g) => g.id === DEFS.get(target)?.group)?.title ?? target;
      throw new HttpError(400, `${group}: ${DEFS.get(target)?.label ?? target} geändert. Bitte ${labels} neu eingeben – das gespeicherte Geheimnis wird nicht an eine neue Adresse gesendet.`);
    }
  }
  await db.begin(async (tx) => {
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) {
        await tx`delete from app_setting where key = ${key}`;
        await tx`insert into app_setting_log(key, action, changed_by) values (${key}, 'reset', ${actor})`;
      } else {
        const secret = isSecret(key) && value !== '';
        const stored = secret ? encrypt(value) : value;
        await tx`insert into app_setting(key, value, secret, updated_by) values (${key}, ${stored}, ${secret}, ${actor})
                 on conflict (key) do update set value = excluded.value, secret = excluded.secret, updated_by = excluded.updated_by, updated_at = now()`;
        await tx`insert into app_setting_log(key, action, changed_by) values (${key}, 'set', ${actor})`;
      }
    }
  });
  await loadSettings(db);
  const keys = Object.keys(changes);
  for (const fn of listeners) fn(keys);
  return describeSettings();
}

export async function settingsLog(db: Db, limit = 50): Promise<{ key: string; action: string; changedBy: string; changedAt: Date }[]> {
  return db`select key, action, changed_by, changed_at from app_setting_log order by id desc limit ${limit}`;
}
