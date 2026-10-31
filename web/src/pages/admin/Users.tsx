import { useState } from 'react';
import { api, fmtDate, useApi } from '../../api.ts';
import { ErrorNote, Modal } from '../../components/common.tsx';
import { useSession } from '../../session.tsx';
import { askConfirm, toast } from '../../ux.tsx';
import { SettingsGroup, useSettings } from './Settings.tsx';
import { grantsOf, PERMISSION_LABEL, usePermissionGrants, useTransferPermission } from './Permissions.tsx';

export interface AdminUser {
  id: string; username: string; displayName: string; email: string | null; source: string;
  active: boolean; isSystemAdmin: boolean; isAgent?: boolean; createdAt: string; lastLoginAt: string | null; groups: string[];
  mustChangePassword?: boolean; passwordChangedAt?: string | null; failedLogins?: number; lockedUntil?: string | null;
}
interface SessionRow { id: string; createdAt: string; lastSeenAt: string; expiresAt: string; userAgent: string | null; current: boolean }

const locked = (u: AdminUser) => !!u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now();
const SOURCE: Record<string, string> = { local: 'lokal', ldap: 'LDAP', oidc: 'SSO' };

/** Kurzbeschreibung eines Browsers aus dem User-Agent (nur zur Wiedererkennung). */
export function deviceOf(ua: string | null): string {
  if (!ua) return 'unbekannt';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|undici/i.test(ua) ? 'Programm' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' · ');
}

export function Users() {
  const users = useApi<AdminUser[]>('/api/admin/users');
  const me = useSession();
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null);
  const [filter, setFilter] = useState('');
  const [only, setOnly] = useState<'' | 'locked' | 'change' | 'inactive'>('');
  const shown = (users.data ?? []).filter((u) => `${u.username} ${u.displayName} ${u.email ?? ''}`.toLowerCase().includes(filter.toLowerCase())
    && (!only || (only === 'locked' ? locked(u) : only === 'change' ? u.mustChangePassword : !u.active)));
  const settings = useSettings();
  const grants = usePermissionGrants();

  return (
    <div className="stack">
      <div className="row wrap">
        <h2>Benutzer</h2><span className="muted small">{users.data?.length ?? 0}</span><span className="spacer" />
        <input placeholder="Filtern …" aria-label="Benutzer filtern" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 200 }} />
        <select value={only} onChange={(e) => setOnly(e.target.value as typeof only)} aria-label="Nur bestimmte Konten" style={{ width: 'auto' }}>
          <option value="">alle Konten</option><option value="locked">gesperrte</option><option value="change">Kennwortwechsel ausstehend</option><option value="inactive">deaktivierte</option>
        </select>
        <button className="primary" onClick={() => setEditing('new')}>+ Benutzer</button>
      </div>
      <ErrorNote error={users.error} />
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Benutzer">
        <table>
          <thead><tr><th>Benutzer</th><th>Name</th><th>E-Mail</th><th>Gruppen</th><th>Rechte</th><th>Status</th><th className="fit wrap">Letzte Anmeldung</th><th className="fit" /></tr></thead>
          <tbody>
            {shown.map((u) => (
              <tr key={u.id} className={u.active ? '' : 'muted'}>
                <td><button className="link" onClick={() => setEditing(u)}><strong>{u.username}</strong></button></td>
                <td>{u.displayName}</td>
                <td className="small">{u.email ?? '–'}</td>
                <td className="small">{u.groups.join(', ') || '–'}</td>
                <td className="small">{u.isSystemAdmin ? 'Systemadmin' : 'Projektrollen'}{u.isSystemAdmin ? '' : grantsOf(grants.data, 'user', u.id).map((x) => ` · ${PERMISSION_LABEL[x] ?? x}`).join('')}{u.isAgent ? ' · KI-Agent' : ''}{u.source !== 'local' ? ` · ${SOURCE[u.source] ?? u.source}` : ''}</td>
                <td className="small"><span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                  {!u.active && <span className="badge neutral">deaktiviert</span>}
                  {locked(u) && <span className="badge bad" title={`${u.failedLogins} Fehlversuche`}>gesperrt bis {new Date(u.lockedUntil!).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>}
                  {u.mustChangePassword && <span className="badge warn">Kennwortwechsel ausstehend</span>}
                  {u.active && !locked(u) && !u.mustChangePassword && <span className="muted">aktiv</span>}
                </span></td>
                <td className="fit small">{fmtDate(u.lastLoginAt)}</td>
                <td className="fit"><button className="small" onClick={() => setEditing(u)} aria-label={`${u.username} bearbeiten`}>Bearbeiten</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.data && !shown.length && <div className="empty">Keine Benutzer.</div>}
      </div>
      {settings.data && <SettingsGroup group="accounts" title="Konten und Kennwörter" settings={settings.data.settings} onSaved={settings.merge} />}
      {editing && <UserEditor user={editing === 'new' ? null : editing} self={editing !== 'new' && editing.username === me.username}
        onClose={() => setEditing(null)} onSaved={() => { users.reload(); grants.reload(); }} onDone={() => { setEditing(null); users.reload(); grants.reload(); }} />}
    </div>
  );
}

function UserEditor({ user, self, onClose, onSaved, onDone }: { user: AdminUser | null; self: boolean; onClose: () => void; onSaved: () => void; onDone: () => void }) {
  const [username, setUsername] = useState(user?.username ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [pwMode, setPwMode] = useState<'generate' | 'set'>('generate');
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [active, setActive] = useState(user?.active ?? true);
  const [isSystemAdmin, setAdmin] = useState(user?.isSystemAdmin ?? false);
  const [isAgent, setAgent] = useState(user?.isAgent ?? false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);
  const [resetting, setResetting] = useState(false);
  const transfer = useTransferPermission('user', user?.id);

  async function save() {
    setError(null);
    try {
      if (!user) {
        const r = await api<AdminUser & { password: string | null }>('POST', '/api/admin/users', {
          username, displayName, email: email || null, isSystemAdmin, isAgent,
          ...(pwMode === 'generate' ? { generatePassword: true } : { password }), mustChangePassword: mustChange,
        });
        await transfer.commit(r.id);
        onSaved();
        if (r.password) setCreated({ username: r.username, password: r.password });
        else { toast(`Benutzer ${r.username} angelegt`); onDone(); }
      } else {
        await api('PATCH', `/api/admin/users/${user.id}`, { displayName, email: email || null, active, isSystemAdmin, isAgent });
        await transfer.commit(user.id);
        toast(`Benutzer ${user.username} gespeichert`);
        onDone();
      }
    } catch (e) {
      setError(e);
    }
  }

  if (created) return <OneTimePassword username={created.username} password={created.password} onClose={onDone} />;
  const local = !user || user.source === 'local';
  return (
    <Modal title={user ? `Benutzer ${user.username}` : 'Neuer Benutzer'} help="admin-users" size="large" onClose={onClose}
      footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" onClick={save}
        disabled={!username || !displayName || (!user && pwMode === 'set' && !password)}>{user ? 'Speichern' : 'Anlegen'}</button></>}>
      <ErrorNote error={error} />
      <div className="grid2">
        <label className="field">Benutzername<input value={username} onChange={(e) => setUsername(e.target.value)} disabled={!!user} autoFocus={!user} /></label>
        <label className="field">Anzeigename<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
        <label className="field">E-Mail<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <span className="small muted">für Benachrichtigungen, Sicherheitshinweise und Links zum Zurücksetzen</span></label>
        {!user && <fieldset className="field">
          <legend>Erstes Kennwort</legend>
          <label className="row"><input type="radio" name="pwmode" checked={pwMode === 'generate'} onChange={() => setPwMode('generate')} style={{ width: 'auto' }} /> Einmal-Kennwort erzeugen (wird einmal angezeigt)</label>
          <label className="row"><input type="radio" name="pwmode" checked={pwMode === 'set'} onChange={() => setPwMode('set')} style={{ width: 'auto' }} /> Kennwort festlegen</label>
          {pwMode === 'set' && <input type="password" aria-label="Kennwort" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />}
          <label className="row"><input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} style={{ width: 'auto' }} /> Beim ersten Anmelden ändern</label>
        </fieldset>}
      </div>
      <label className="row"><input type="checkbox" checked={isSystemAdmin} disabled={self} onChange={(e) => setAdmin(e.target.checked)} style={{ width: 'auto' }} />
        Systemadministrator (alle Projekte, Administrationsbereich)</label>
      {!isSystemAdmin && transfer.checkbox}
      <label className="row"><input type="checkbox" checked={isAgent} onChange={(e) => setAgent(e.target.checked)} style={{ width: 'auto' }} />
        KI-Agent (technisches Konto; erfasste Ergebnisse brauchen eine QA-Prüfung)</label>
      {user && <label className="row"><input type="checkbox" checked={active} disabled={self} onChange={(e) => setActive(e.target.checked)} style={{ width: 'auto' }} />
        Aktiv (deaktivierte Konten können sich nicht anmelden; Sitzungen enden sofort)</label>}

      {user && <section className="stack account-security" aria-labelledby={`sec-${user.id}`}>
        <h3 id={`sec-${user.id}`}>Kennwort, Sperre und Sitzungen</h3>
        {local ? <>
          <div className="small muted">
            Kennwort zuletzt geändert: {user.passwordChangedAt ? fmtDate(user.passwordChangedAt) : 'unbekannt'}
            {user.mustChangePassword && ' · Wechsel beim nächsten Anmelden ausstehend'}
            {user.failedLogins ? ` · ${user.failedLogins} Fehlversuche seit der letzten Anmeldung` : ''}
          </div>
          <div className="row wrap">
            <button onClick={() => setResetting(true)}>Kennwort zurücksetzen …</button>
            <button disabled={!user.email} title={user.email ? 'Link an die hinterlegte E-Mail-Adresse senden' : 'Keine E-Mail-Adresse hinterlegt'} onClick={async () => {
              try {
                await api('POST', `/api/admin/users/${user.id}/password-reset-link`);
                toast(`Link zum Zurücksetzen an ${user.email} gesendet`);
              } catch (e) { setError(e); }
            }}>Link zum Zurücksetzen senden</button>
            {locked(user) && <button onClick={async () => {
              try { await api('POST', `/api/admin/users/${user.id}/unlock`); toast(`${user.username} entsperrt`); onSaved(); onDone(); } catch (e) { setError(e); }
            }}>Entsperren</button>}
          </div>
        </> : <div className="small muted">Das Kennwort dieses Kontos wird im {user.source === 'ldap' ? 'Verzeichnis (LDAP)' : 'Identitätsanbieter (SSO)'} verwaltet.</div>}
        <UserSessions userId={user.id} />
      </section>}
      {resetting && user && <ResetPasswordDialog user={user} onClose={() => setResetting(false)} onDone={() => { setResetting(false); onSaved(); }} />}
    </Modal>
  );
}

function ResetPasswordDialog({ user, onClose, onDone }: { user: AdminUser; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'generate' | 'set'>('generate');
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [revokeTokens, setRevokeTokens] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<string | null>(null);
  async function reset() {
    try {
      const r = await api<{ password: string | null }>('PUT', `/api/admin/users/${user.id}/password`,
        { ...(mode === 'generate' ? { generate: true } : { password }), mustChange, revokeTokens });
      onDone();
      if (r.password) setResult(r.password);
      else { toast(`Kennwort von ${user.username} zurückgesetzt`); onClose(); }
    } catch (e) { setError(e); }
  }
  if (result) return <OneTimePassword username={user.username} password={result} onClose={onClose} />;
  return (
    <Modal title={`Kennwort von ${user.username} zurücksetzen`} help="admin-passwords" onClose={onClose}
      footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={mode === 'set' && !password} onClick={reset}>Zurücksetzen</button></>}>
      <ErrorNote error={error} />
      <fieldset className="stack">
        <legend className="small muted">Neues Kennwort</legend>
        <label className="row"><input type="radio" name="reset-mode" checked={mode === 'generate'} onChange={() => setMode('generate')} style={{ width: 'auto' }} /> Einmal-Kennwort erzeugen (wird einmal angezeigt)</label>
        <label className="row"><input type="radio" name="reset-mode" checked={mode === 'set'} onChange={() => setMode('set')} style={{ width: 'auto' }} /> Kennwort festlegen</label>
        {mode === 'set' && <input type="password" aria-label="Neues Kennwort" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />}
      </fieldset>
      <label className="row"><input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} style={{ width: 'auto' }} /> Beim nächsten Anmelden ändern</label>
      <label className="row"><input type="checkbox" checked={revokeTokens} onChange={(e) => setRevokeTokens(e.target.checked)} style={{ width: 'auto' }} /> Auch alle API-Tokens widerrufen (z. B. bei Verdacht auf Missbrauch)</label>
      <p className="small muted">Alle Sitzungen enden sofort, eine Sperre wird aufgehoben. {user.email ? 'Die Person erhält einen Hinweis per E-Mail (ohne Kennwort).' : 'Keine E-Mail-Adresse hinterlegt – die Person erfährt es nur von Ihnen.'}</p>
    </Modal>
  );
}

/** Einmal-Kennwort anzeigen – nur hier, danach nie wieder. */
function OneTimePassword({ username, password, onClose }: { username: string; password: string; onClose: () => void }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(password); toast('Kennwort kopiert'); } catch { toast('Kopieren nicht möglich – bitte markieren und kopieren', 'bad'); }
  };
  return (
    <Modal title={`Einmal-Kennwort für ${username}`} onClose={onClose} footer={<button className="primary" onClick={onClose}>Fertig</button>}>
      <p>Geben Sie das Kennwort auf sicherem Weg weiter. Es wird nur jetzt angezeigt.</p>
      <div className="row"><code className="one-time-password" aria-label="Einmal-Kennwort">{password}</code><button onClick={copy}>Kopieren</button></div>
    </Modal>
  );
}

/** Sitzungen eines Kontos (Administration) bzw. eigene Sitzungen (base = /api/auth). */
export function UserSessions({ userId, own }: { userId?: string; own?: boolean }) {
  const base = own ? '/api/auth/sessions' : `/api/admin/users/${userId}/sessions`;
  const s = useApi<SessionRow[]>(base);
  const [error, setError] = useState<unknown>(null);
  const others = (s.data ?? []).filter((x) => !x.current).length;
  const endAll = async () => {
    if (!(await askConfirm({ title: 'Sitzungen beenden', message: own ? 'Alle anderen Sitzungen abmelden? Die aktuelle bleibt bestehen.' : 'Alle Sitzungen dieses Kontos beenden? Die Person muss sich neu anmelden.', confirmLabel: 'Beenden', danger: true }))) return;
    try { const r = await api<{ ended: number }>('DELETE', base); toast(`${r.ended} Sitzung${r.ended === 1 ? '' : 'en'} beendet`); s.reload(); } catch (e) { setError(e); }
  };
  const endOne = async (id: string) => {
    try { await api('DELETE', `/api/auth/sessions?id=${id}`); s.reload(); } catch (e) { setError(e); }
  };
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row"><h4 style={{ flex: 1 }}>Angemeldete Sitzungen ({s.data?.length ?? 0})</h4>
        <button className="small" disabled={own ? !others : !s.data?.length} onClick={endAll}>{own ? 'Alle anderen abmelden' : 'Alle Sitzungen beenden'}</button></div>
      <ErrorNote error={error ?? s.error} />
      {s.data && !s.data.length && <div className="small muted">Keine aktive Sitzung.</div>}
      {!!s.data?.length && <div className="table-wrap"><table><tbody>{s.data.map((x) => (
        <tr key={x.id}>
          <td>{deviceOf(x.userAgent)}{x.current && <span className="badge ok" style={{ marginLeft: 6 }}>diese Sitzung</span>}</td>
          <td className="fit small muted">angemeldet {fmtDate(x.createdAt)}</td>
          <td className="fit small muted">zuletzt aktiv {fmtDate(x.lastSeenAt)}</td>
          {own && <td className="fit">{!x.current && <button className="small" onClick={() => endOne(x.id)} aria-label={`Sitzung ${deviceOf(x.userAgent)} abmelden`}>Abmelden</button>}</td>}
        </tr>
      ))}</tbody></table></div>}
    </div>
  );
}
