import { useEffect, useState } from 'react';
import { api, useApi } from '../api.ts';
import { ErrorNote } from '../components/common.tsx';
import { BrandMark } from '../components/Brand.tsx';

/** Neues Kennwort zweimal eingeben – mit Prüfung der Regeln schon im Browser (der Server prüft erneut). */
export function NewPasswordFields({ minLength, value, repeat, onChange, onRepeat, username }: {
  minLength: number; value: string; repeat: string; onChange: (v: string) => void; onRepeat: (v: string) => void; username?: string | null | undefined;
}) {
  const problems = [
    value.length < minLength && `mindestens ${minLength} Zeichen`,
    value && (!/[a-zA-Z]/.test(value) || !/[^a-zA-Z]/.test(value)) && 'Buchstaben und Ziffern oder Sonderzeichen',
    value && username && username.length >= 3 && value.toLowerCase().includes(username.toLowerCase()) && 'darf den Benutzernamen nicht enthalten',
    repeat && value !== repeat && 'Wiederholung stimmt nicht überein',
  ].filter(Boolean) as string[];
  return <>
    <label className="field">Neues Kennwort
      <input type="password" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" aria-describedby="pw-rules" aria-invalid={!!value && problems.length > 0} />
    </label>
    <label className="field">Neues Kennwort wiederholen
      <input type="password" value={repeat} onChange={(e) => onRepeat(e.target.value)} autoComplete="new-password" aria-invalid={!!repeat && value !== repeat} />
    </label>
    <div id="pw-rules" className="small muted" aria-live="polite">
      {value && problems.length ? `Noch nicht erfüllt: ${problems.join(' · ')}` : `Mindestens ${minLength} Zeichen, Buchstaben und Ziffern oder Sonderzeichen, nicht der Benutzername.`}
    </div>
  </>;
}
export const passwordOk = (v: string, r: string, min: number, username?: string | null) =>
  v.length >= min && /[a-zA-Z]/.test(v) && /[^a-zA-Z]/.test(v) && v === r && !(username && username.length >= 3 && v.toLowerCase().includes(username.toLowerCase()));

/** Pflichtwechsel nach dem Anmelden (Einmal-Kennwort bzw. von der Administration verlangt). */
export function ForcedPasswordChange({ username, minLength, onDone, onLogout }: { username: string; minLength: number; onDone: () => void; onLogout: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/api/auth/password', { currentPassword: current, newPassword: next });
      onDone();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit} aria-labelledby="forced-title">
        <div className="brand"><BrandMark />Anemo</div>
        <h1 id="forced-title" className="login-title">Neues Kennwort festlegen</h1>
        <p className="small muted">Für das Konto „{username}“ muss vor dem Weiterarbeiten ein eigenes Kennwort festgelegt werden.</p>
        <ErrorNote error={error} />
        <label className="field">Bisheriges bzw. Einmal-Kennwort
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus required />
        </label>
        <NewPasswordFields minLength={minLength} value={next} repeat={repeat} onChange={setNext} onRepeat={setRepeat} username={username} />
        <div className="row"><button type="button" className="ghost" onClick={onLogout}>Abmelden</button><span className="spacer" />
          <button className="primary" disabled={busy || !current || !passwordOk(next, repeat, minLength, username)}>{busy ? 'Speichern …' : 'Kennwort festlegen'}</button></div>
      </form>
    </div>
  );
}

/** Link aus der E-Mail: #/kennwort-zuruecksetzen?token=… */
export function PasswordResetPage() {
  const token = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('token') ?? '';
  const check = useApi<{ valid: boolean; username: string | null }>(token.length >= 20 ? `/api/auth/password-reset/check?token=${encodeURIComponent(token)}` : null);
  const providers = useApi<{ minPasswordLength?: number }>('/api/auth/providers');
  const min = providers.data?.minPasswordLength ?? 12;
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { document.title = 'Kennwort zurücksetzen – Anemo'; }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ username: string }>('POST', '/api/auth/password-reset/confirm', { token, password: next });
      setDone(r.username);
    } catch (err) { setError(err); }
  }
  const toLogin = () => { window.location.hash = '#/'; window.location.reload(); };
  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit} aria-labelledby="reset-title">
        <div className="brand"><BrandMark />Anemo</div>
        <h1 id="reset-title" className="login-title">Kennwort zurücksetzen</h1>
        {done ? <>
          <p role="status">Das Kennwort für „{done}“ ist geändert. Sie können sich jetzt anmelden.</p>
          <button type="button" className="primary" onClick={toLogin}>Zur Anmeldung</button>
        </> : !token || check.data?.valid === false ? <>
          <p className="notice warn">Der Link ist ungültig, abgelaufen oder wurde bereits verwendet. Fordern Sie auf der Anmeldeseite einen neuen an.</p>
          <button type="button" onClick={toLogin}>Zur Anmeldung</button>
        </> : !check.data ? <div className="small muted" role="status">Lädt …</div> : <>
          <p className="small muted">Neues Kennwort für „{check.data.username}“ festlegen. Danach sind alle bisherigen Sitzungen beendet.</p>
          <ErrorNote error={error} />
          <NewPasswordFields minLength={min} value={next} repeat={repeat} onChange={setNext} onRepeat={setRepeat} username={check.data.username} />
          <button className="primary" disabled={!passwordOk(next, repeat, min, check.data.username)}>Kennwort speichern</button>
        </>}
      </form>
    </div>
  );
}

/** „Kennwort vergessen?“ auf der Anmeldeseite. */
export function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try { await api('POST', '/api/auth/password-reset/request', { identifier }); setSent(true); } catch (err) { setError(err); }
  }
  return (
    <form className="stack" onSubmit={submit} aria-labelledby="forgot-title">
      <h2 id="forgot-title" className="login-title">Kennwort vergessen?</h2>
      {sent ? <p role="status">Falls zu dieser Angabe ein Konto mit E-Mail-Adresse existiert, ist ein Link zum Zurücksetzen unterwegs. Er ist begrenzt gültig.</p> : <>
        <p className="small muted">Benutzername oder E-Mail-Adresse angeben – der Link geht an die hinterlegte Adresse. Konten mit Firmen-/Verzeichnisanmeldung setzen ihr Kennwort dort zurück.</p>
        <ErrorNote error={error} />
        <label className="field">Benutzername oder E-Mail
          <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <button className="primary" disabled={!identifier.trim()}>Link anfordern</button>
      </>}
      <button type="button" className="link" onClick={onBack}>Zurück zur Anmeldung</button>
    </form>
  );
}
