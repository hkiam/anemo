import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { api, fmtDate, useApi } from '../../api.ts';
import { ErrorNote } from '../../components/common.tsx';
import { href } from '../../router.ts';
import { askText, Icon, toast, useUnsavedGuard } from '../../ux.tsx';

export interface Setting {
  key: string; group: string; label: string; type: 'text' | 'url' | 'secret' | 'bool' | 'number' | 'select' | 'textarea';
  default?: string; options?: { value: string; label: string }[]; hint?: string; placeholder?: string;
  value: string | null; source: 'ui' | 'env' | 'default' | 'none'; envValue: string | null; unreadable?: boolean;
}
export interface SettingsData { groups: { id: string; title: string; description: string }[]; settings: Setting[]; log: { key: string; action: string; changedBy: string; changedAt: string }[] }

const SOURCE: Record<Setting['source'], { label: string; cls: string; title: string }> = {
  ui: { label: 'Oberfläche', cls: 'accent', title: 'In der Oberfläche festgelegt – überschreibt die Umgebung' },
  env: { label: 'Umgebung', cls: 'neutral', title: 'Aus der Umgebungsvariable (z. B. .env beim Containerstart)' },
  default: { label: 'Standard', cls: 'neutral', title: 'Eingebauter Standardwert' },
  none: { label: 'nicht gesetzt', cls: 'warn', title: 'Weder Umgebung noch Oberfläche setzen einen Wert' },
};

/** Verbindungstest je Gruppe (nutzt die vorhandenen Prüfungen der Integrationen). */
async function runTest(group: string): Promise<{ ok: boolean; message: string } | null> {
  if (group === 'oidc' || group === 'ldap') return api('POST', `/api/admin/auth/test/${group}`);
  if (group === 'ai') return api('POST', '/api/admin/ai/test', { profile: 'default' });
  if (group === 'ai-strong') return api('POST', '/api/admin/ai/test', { profile: 'strong' });
  if (group === 'openproject' || group === 'gitlab') {
    const r = await api<{ ok: boolean; user?: string; error?: string }>('POST', `/api/admin/integrations/${group}/test`);
    return { ok: r.ok, message: r.ok ? `Verbunden${r.user ? ` als ${r.user}` : ''}` : r.error ?? 'Fehler' };
  }
  if (group === 'smtp') {
    const to = await askText({ title: 'Testmail senden', label: 'Empfänger', placeholder: 'name@firma.de', confirmLabel: 'Senden' });
    if (!to) return null;
    const r = await api<{ ok: boolean; error: string | null }>('POST', '/api/admin/mail/test', { to });
    return { ok: r.ok, message: r.ok ? `Testmail an ${to} versendet` : r.error ?? 'Fehler' };
  }
  return null;
}
/**
 * Ziel-Adresse → zugehörige Geheimnisse (wie server/src/platform/settings.ts SECRET_FOR_TARGET): Wer die Adresse
 * ändert, muss das Geheimnis in derselben Speicherung neu eingeben – sonst lehnt der Server ab (400).
 */
const SECRET_FOR_TARGET: Record<string, string[]> = {
  OPENPROJECT_URL: ['OPENPROJECT_API_KEY'], GITLAB_URL: ['GITLAB_TOKEN'], JIRA_BASE_URL: ['JIRA_TOKEN', 'JIRA_PASSWORD'],
  AI_BASE_URL: ['AI_API_KEY'], AI_STRONG_BASE_URL: ['AI_STRONG_API_KEY'], SMTP_HOST: ['SMTP_PASSWORD'], LDAP_URL: ['LDAP_BIND_PASSWORD'],
  OIDC_ISSUER: ['OIDC_CLIENT_SECRET'],
};
const normTarget = (v: string | null | undefined) => (v ?? '').trim().replace(/\/+$/, '').toLowerCase();
const RESECRET_HINT = 'Bei geänderter Adresse das Geheimnis neu eingeben';

const TESTABLE = new Set(['oidc', 'ldap', 'ai', 'ai-strong', 'openproject', 'gitlab', 'smtp']);

/**
 * Eine Einstellungsgruppe: wirksamer Wert mit Herkunft, Änderungen sammeln und gemeinsam speichern,
 * einzelne Werte auf die Vorbelegung (Umgebung/Standard) zurücksetzen, Verbindung prüfen.
 */
export function SettingsGroup({ group, title, description, settings, onSaved, exclude = [], extra }: {
  group: string; title?: string; description?: string; settings: Setting[]; onSaved: (d: SettingsData) => void; exclude?: string[]; extra?: ReactNode;
}) {
  const items = settings.filter((s) => s.group === group && !exclude.includes(s.key));
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const dirty = Object.keys(draft).length > 0;
  // Geheimnisse, die wegen einer geänderten Ziel-Adresse in dieser Speicherung Pflicht sind (nur bereits gesetzte)
  const requiredSecrets = new Map<string, string>();
  for (const [target, secrets] of Object.entries(SECRET_FOR_TARGET)) {
    const t = items.find((x) => x.key === target);
    const next = draft[target];
    if (!t || next === undefined || !normTarget(next) || normTarget(next) === normTarget(t.value)) continue;
    for (const k of secrets) {
      const sec = items.find((x) => x.key === k);
      if (sec && sec.source !== 'none') requiredSecrets.set(k, t.label);
    }
  }
  const missingSecrets = [...requiredSecrets.keys()].filter((k) => !draft[k]);
  useUnsavedGuard(dirty, `settings-${group}`);
  const save = async (changes: Record<string, string | null>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Omit<SettingsData, 'groups'>>('PUT', '/api/admin/settings', { changes });
      setDraft({});
      setTest(null);
      onSaved(r as SettingsData);
      toast(`${title ?? 'Einstellungen'} gespeichert`);
    } catch (e) {
      setError(e);
      // Meldung des Servers (z. B. „Adresse geändert – Geheimnis neu eingeben“) sichtbar machen
      requestAnimationFrame(() => document.querySelector(`#einstellung-${group} .error-note`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    } finally {
      setBusy(false);
    }
  };
  const fieldId = (s: Setting) => `einstellung-${group}-${s.key}`;
  const field = (s: Setting) => {
    const v = draft[s.key];
    const id = fieldId(s);
    const mustRenew = requiredSecrets.has(s.key);
    const describedBy = [mustRenew ? `${id}-neu` : '', s.hint ? `${id}-hinweis` : ''].filter(Boolean).join(' ') || undefined;
    const set = (x: string) => setDraft((d) => ({ ...d, [s.key]: x }));
    const current = s.type === 'secret' ? '' : s.value ?? '';
    if (s.type === 'bool') {
      const on = (v ?? s.value ?? s.default ?? 'false') === 'true';
      // Name des Häkchens ist die Beschriftung der Einstellung (label htmlFor); der Zustand steht nur als Zusatz daneben
      return (
        <div className="row setting-bool">
          <input id={id} type="checkbox" style={{ width: 'auto' }} checked={on} aria-describedby={describedBy} onChange={(e) => set(e.target.checked ? 'true' : 'false')} />
          <span className="small muted" aria-hidden="true">{on ? 'eingeschaltet' : 'ausgeschaltet'}</span>
        </div>
      );
    }
    if (s.type === 'select') {
      return (
        <select id={id} aria-describedby={describedBy} value={v ?? s.value ?? ''} onChange={(e) => set(e.target.value)}>
          {!s.default && <option value="">– automatisch –</option>}
          {s.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    if (s.type === 'secret') {
      return <input id={id} aria-describedby={describedBy} type="password" autoComplete="new-password" value={v ?? ''} onChange={(e) => set(e.target.value)}
        required={mustRenew} aria-required={mustRenew || undefined} aria-invalid={(mustRenew && !v) || undefined} className={mustRenew && !v ? 'invalid' : undefined}
        placeholder={s.value ? '•••••• gesetzt – leer lassen, um ihn zu behalten' : 'nicht gesetzt'} />;
    }
    return <input id={id} aria-describedby={describedBy} type={s.type === 'number' ? 'number' : 'text'} inputMode={s.type === 'number' ? 'numeric' : undefined} value={v ?? current}
      placeholder={s.placeholder ?? s.default ?? ''} onChange={(e) => set(e.target.value)} />;
  };
  const changes = () => Object.fromEntries(Object.entries(draft).filter(([k, val]) => {
    const s = items.find((x) => x.key === k)!;
    return s.type === 'secret' ? val !== '' : val !== (s.value ?? '');
  }));
  return (
    <section className="card settings-group" id={`einstellung-${group}`}>
      <div className="card-body stack">
        {title && <div className="row"><h3>{title}</h3><span className="spacer" />
          {TESTABLE.has(group) && <button className="small" disabled={dirty || busy} title={dirty ? 'Erst speichern' : 'Verbindung mit den wirksamen Werten prüfen'}
            onClick={async () => { setTest(null); try { setTest(await runTest(group)); } catch (e) { setTest({ ok: false, message: (e as Error).message }); } }}>Verbindung prüfen</button>}
        </div>}
        {description && <p className="small muted" style={{ margin: 0 }}>{description}</p>}
        {test && <div className={`notice ${test.ok ? 'ok' : 'bad'}`}>{test.message}</div>}
        <ErrorNote error={error} />
        {extra}
        <div className="settings-grid">
          {items.map((s) => (
            <div key={s.key} className="setting">
              <div className="setting-label">
                <label htmlFor={fieldId(s)}>{s.label}{requiredSecrets.has(s.key) && <span className="req" aria-hidden="true"> *</span>}</label>
                <span className={`badge ${SOURCE[s.source].cls}`} title={SOURCE[s.source].title}>{SOURCE[s.source].label}</span>
                {draft[s.key] !== undefined && <span className="badge warn">geändert</span>}
              </div>
              {field(s)}
              {requiredSecrets.has(s.key) && <div id={`${fieldId(s)}-neu`} className="small err">{RESECRET_HINT} („{requiredSecrets.get(s.key)}“ geändert).</div>}
              <div className="small muted setting-hint">
                {s.hint && <span id={`${fieldId(s)}-hinweis`}>{s.hint}</span>}
                <span className="mono" title="Name der Umgebungsvariable">{s.key}</span>
                {s.source === 'ui' && s.envValue && <span>· Umgebung: {s.envValue}</span>}
                {s.unreadable && <span className="err">· gespeicherter Wert nicht lesbar (Schlüssel geändert?) – neu eingeben</span>}
                {s.source === 'ui' && <button className="ghost small" onClick={() => save({ [s.key]: null })} disabled={busy}
                  aria-label={`${s.label}: Wert aus der Oberfläche zurücksetzen`}
                  title="Wert aus der Oberfläche entfernen – es gilt wieder die Umgebung bzw. der Standard"><Icon>↺</Icon> zurücksetzen</button>}
                {s.source === 'env' && s.type !== 'bool' && <button className="ghost small" onClick={() => save({ [s.key]: '' })} disabled={busy}
                  aria-label={`${s.label}: Wert aus der Umgebung abschalten`}
                  title="Wert aus der Umgebung hier abschalten (z. B. Integration deaktivieren)"><Icon>⊘</Icon> abschalten</button>}
              </div>
            </div>
          ))}
        </div>
        <div className="row">
          <span className="spacer" />
          {dirty && <button className="ghost" onClick={() => setDraft({})}>Verwerfen</button>}
          {missingSecrets.length > 0 && <span className="small err">{RESECRET_HINT}: {missingSecrets.map((k) => items.find((x) => x.key === k)?.label ?? k).join(', ')}</span>}
          <button className="primary" disabled={!dirty || busy} onClick={() => {
            if (missingSecrets.length) {
              const label = missingSecrets.map((k) => `„${items.find((x) => x.key === k)?.label ?? k}“`).join(' bzw. ');
              setError(new Error(`Adresse geändert: Bitte ${label} neu eingeben – das gespeicherte Geheimnis wird nicht an eine neue Adresse gesendet.`));
              document.getElementById(fieldId(items.find((x) => x.key === missingSecrets[0])!))?.focus();
              return;
            }
            void save(changes());
          }}>{busy ? 'Speichert …' : 'Speichern'}</button>
        </div>
      </div>
    </section>
  );
}

export function useSettings() {
  const data = useApi<SettingsData>('/api/admin/settings');
  const [local, setLocal] = useState<SettingsData | null>(null);
  useEffect(() => { if (data.data) setLocal(data.data); }, [data.data]);
  const merge = (d: Partial<SettingsData>) => setLocal((cur) => (cur ? { ...cur, ...d } : cur));
  return { data: local, error: data.error, merge };
}

/** Wo eine Einstellungsgruppe gepflegt wird (Seite der Administration). */
export const GROUP_PAGE: Record<string, { path: string[]; label: string }> = {
  general: { path: ['admin', 'settings'], label: 'System → Allgemein' },
  accounts: { path: ['admin', 'users'], label: 'Benutzer & Rechte → Benutzer' },
  links: { path: ['admin', 'integrations'], label: 'Anbindungen → Übersicht' },
  opbacklink: { path: ['admin', 'openproject'], label: 'Anbindungen → OpenProject → Rückverweis' },
  oidc: { path: ['admin', 'auth'], label: 'Benutzer & Rechte → Anmeldung' },
  ldap: { path: ['admin', 'auth'], label: 'Benutzer & Rechte → Anmeldung' },
  smtp: { path: ['admin', 'mail'], label: 'Benachrichtigungen → E-Mail' },
  openproject: { path: ['admin', 'openproject'], label: 'Anbindungen → OpenProject' },
  gitlab: { path: ['admin', 'gitlab'], label: 'Anbindungen → GitLab' },
  jira: { path: ['admin', 'jira'], label: 'Anbindungen → Jira' },
  ai: { path: ['admin', 'ai'], label: 'KI' },
  'ai-strong': { path: ['admin', 'ai'], label: 'KI' },
};

/** System → Allgemein: allgemeine Einstellungen, Suche über alle Einstellungen (mit Verweis auf ihre Seite), Änderungsprotokoll. */
export function Settings() {
  const { data, error, merge } = useSettings();
  const [filter, setFilter] = useState('');
  const hits = useMemo(() => {
    if (!data || !filter.trim()) return [];
    const f = filter.toLowerCase();
    return data.settings.filter((s) => `${s.label} ${s.key} ${s.hint ?? ''}`.toLowerCase().includes(f));
  }, [data, filter]);
  if (!data) return <div className="stack"><h2>Allgemein</h2><ErrorNote error={error} />{!error && <div className="muted" role="status">Lädt …</div>}</div>;
  const general = data.groups.find((g) => g.id === 'general');
  return (
    <div className="stack">
      <div className="row"><h2>Allgemein</h2><span className="spacer" />
        <input type="search" placeholder="In allen Einstellungen suchen …" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 280 }} aria-label="Einstellungen suchen" /></div>
      {filter.trim() && <div className="card"><div className="card-body stack">
        <h3>Treffer ({hits.length})</h3>
        {hits.length === 0 ? <div className="small muted">Keine Einstellung passt.</div> : <div className="table-wrap"><table><tbody>
          {hits.map((s) => { const pg = GROUP_PAGE[s.group]; return (
            <tr key={s.key}><td>{s.label}<div className="small muted mono">{s.key}</div></td>
              <td className="fit"><span className={`badge ${SOURCE[s.source].cls}`}>{SOURCE[s.source].label}</span></td>
              <td className="fit">{pg ? <a href={href(pg.path)}>{pg.label} →</a> : s.group}</td></tr>
          ); })}
        </tbody></table></div>}
      </div></div>}
      <div className="notice info small">
        Jede Einstellung wird dort gepflegt, wo sie wirkt: Anmeldung, E-Mail, Anbindungen (OpenProject, GitLab, Jira) und KI haben eigene Seiten.
        Vorbelegung kommt aus den <strong>Umgebungsvariablen</strong> (z. B. <span className="mono">.env</span>); was in der Oberfläche gespeichert wird,
        <strong> überschreibt</strong> sie und wirkt sofort. Passwörter und Tokens werden verschlüsselt gespeichert und nie angezeigt.
      </div>
      <SystemInfo />
      {general && <SettingsGroup group="general" title={general.title} description={general.description} settings={data.settings} onSaved={merge} />}
      <details className="card"><summary className="card-body" style={{ cursor: 'pointer' }}><strong>Änderungsprotokoll aller Einstellungen</strong> <span className="small muted">(ohne Werte)</span></summary>
        <div className="table-wrap" style={{ margin: '0 12px 12px' }}><table><tbody>
          {data.log.map((l, i) => <tr key={i}><td className="fit small">{fmtDate(l.changedAt)}</td><td className="mono small">{l.key}</td><td className="small">{l.action === 'set' ? 'festgelegt' : 'zurückgesetzt'}</td><td className="small">{l.changedBy}</td></tr>)}
          {data.log.length === 0 && <tr><td className="empty">Noch keine Änderungen in der Oberfläche.</td></tr>}
        </tbody></table></div>
      </details>
    </div>
  );
}

interface SystemInfoData { version: string; commit: string | null; builtAt: string | null; startedAt: string; node: string; postgres: string | null; migration: string | null; migratedAt: string | null }

/** Version und Systemangaben (nur Systemadministration). */
function SystemInfo() {
  const d = useApi<SystemInfoData>('/api/admin/system');
  if (!d.data) return <ErrorNote error={d.error} />;
  const x = d.data;
  const rows: [string, ReactNode][] = [
    ['Version', <b key="v">{x.version}</b>],
    ['Commit', x.commit ? <span className="mono">{x.commit}</span> : <span className="muted">unbekannt</span>],
    ['Gebaut', x.builtAt ? fmtDate(x.builtAt) : <span className="muted">– (Entwicklung)</span>],
    ['Gestartet', fmtDate(x.startedAt)],
    ['Datenbankstand', x.migration ? <><span className="mono">{x.migration.replace(/\.sql$/, '')}</span>{x.migratedAt && <span className="muted"> · {fmtDate(x.migratedAt)}</span>}</> : '–'],
    ['Laufzeit', <span key="r" className="mono">Node {x.node} · PostgreSQL {x.postgres ?? '?'}</span>],
  ];
  return (
    <div className="card"><div className="card-body stack" style={{ gap: 6 }}>
      <h3>Version</h3>
      <table className="kv"><tbody>{rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>
    </div></div>
  );
}
