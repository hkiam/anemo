import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { ErrorNote } from '../components/common.tsx';
import { ForgotPassword } from './PasswordPages.tsx';
import { BrandMark } from '../components/Brand.tsx';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const providers = useApi<{ local: boolean; ldap: boolean; oidc: { label: string } | null; selfReset?: boolean }>('/api/auth/providers');
  const [forgot, setForgot] = useState(false);
  // Fehler aus der Rückkehr vom Identitätsanbieter (z. B. abgebrochene Anmeldung)
  const ssoError = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('loginError');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/login', { username, password });
      setPassword('');
      onLoggedIn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (forgot) {
    return <div className="login-page"><div className="card login-card"><div className="brand"><BrandMark />Anemo</div>
      <ForgotPassword onBack={() => setForgot(false)} /></div></div>;
  }
  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand"><BrandMark />Anemo</div>
        <p className="muted small">Testmanagement – bitte anmelden.</p>
        <ErrorNote error={error ?? (ssoError ? new Error(ssoError) : null)} />
        {providers.data?.oidc && <>
          <a className="btn primary sso" href={`/api/auth/oidc/start?returnTo=${encodeURIComponent('/' + (window.location.hash.replace(/\?loginError=.*$/, '') || ''))}`}>{providers.data.oidc.label}</a>
          <div className="login-or small muted">oder mit Benutzername und Kennwort</div>
        </>}
        {providers.data?.ldap && <div className="small muted">Mit Ihrem Windows-/Domänenkonto anmelden.</div>}
        <label className="field">Benutzername
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label className="field">Kennwort
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <button className="primary" disabled={busy || !username || !password}>{busy ? 'Anmelden …' : 'Anmelden'}</button>
        {providers.data?.selfReset && <button type="button" className="link small" onClick={() => setForgot(true)}>Kennwort vergessen?</button>}
      </form>
    </div>
  );
}
