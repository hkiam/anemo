import { useCallback, useId, useRef, useState } from 'react';
import { api, useApi } from '../api.ts';
import { href } from '../router.ts';
import type { Me } from '../session.tsx';
import { ApiTokensDialog } from './ApiTokens.tsx';
import { NewPasswordFields, passwordOk } from '../pages/PasswordPages.tsx';
import { UserSessions } from '../pages/admin/Users.tsx';
import { NotificationsDialog } from './NotificationsDialog.tsx';
import { ErrorNote, Modal } from './common.tsx';
import { DropPanel, Icon, showShortcuts, toast } from '../ux.tsx';

/**
 * Angemeldeter Benutzer oben rechts: Kennwort ändern, Abmelden. Aufklappbereich (Disclosure) mit Knöpfen und Links –
 * Fokus beim Öffnen auf dem ersten Eintrag, ↑/↓/Pos1/Ende wechseln, Esc schließt und kehrt zum Kontoknopf zurück.
 */
export function AccountMenu({ me, roleLabel, onLogout, onChanged }: { me: Me; roleLabel: string | null; onLogout: () => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [pw, setPw] = useState(false);
  const [tokens, setTokens] = useState(false);
  const [watching, setWatching] = useState(false);
  const [sessions, setSessions] = useState(false);
  const [notes, setNotes] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="account" ref={anchorRef}>
      <button className="ghost account-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={open ? panelId : undefined}
        title={`Konto ${me.displayName}`}>
        <span className="avatar" aria-hidden="true">{me.displayName.slice(0, 1).toUpperCase()}</span>
        <span className="account-name">{me.displayName}</span>
        {me.isSystemAdmin ? (!/admin/i.test(me.displayName) && <span className="badge">Admin</span>) : roleLabel && <span className="badge">{roleLabel}</span>}
      </button>
      {open && <>
        <DropPanel anchor={anchorRef} onClose={close} id={panelId} label="Konto">
          <div className="small muted">Angemeldet als <strong>{me.username}</strong>{me.authMode === 'off' ? ' (ohne Anmeldung – Entwicklungsmodus)' : ''}</div>
          {me.authMode === 'on' && (me.source ?? 'local') === 'local' && <button className="ghost" onClick={() => { setPw(true); setOpen(false); }}>Kennwort ändern…</button>}
          {me.authMode === 'on' && <button className="ghost" onClick={() => { setSessions(true); setOpen(false); }}>Sitzungen …</button>}
          {me.authMode === 'on' && <button className="ghost" onClick={() => { setNotes(true); setOpen(false); }}>Benachrichtigungen…</button>}
          {me.authMode === 'on' && <button className="ghost" onClick={() => { setTokens(true); setOpen(false); }}>API-Tokens…</button>}
          <button className="ghost" onClick={() => { setWatching(true); setOpen(false); }}>👁 Beobachtet…</button>
          <a href="#/hilfe" onClick={() => setOpen(false)}><Icon>❓</Icon> Hilfe / Handbuch</a>
          <button className="ghost" onClick={() => { setOpen(false); showShortcuts(); }} title="Auch mit der Taste ?"><Icon>⌨</Icon> Tastenkürzel</button>
          <a className="small" href="/api/openapi.json" target="_blank" rel="noreferrer">API-Beschreibung <span className="sr-only">(neues Fenster)</span></a>
          {me.authMode === 'on' && <button onClick={onLogout}>Abmelden</button>}
          <AppVersion admin={me.isSystemAdmin} onNavigate={() => setOpen(false)} />
        </DropPanel>
      </>}
      {notes && <NotificationsDialog onClose={() => setNotes(false)} />}
      {tokens && <ApiTokensDialog onClose={() => setTokens(false)} />}
      {watching && <WatchingDialog onClose={() => setWatching(false)} />}
      {sessions && <Modal title="Meine Sitzungen" onClose={() => setSessions(false)} footer={<button onClick={() => setSessions(false)}>Schließen</button>}>
        <p className="small muted">Wo Ihr Konto angemeldet ist. Unbekannte Sitzungen abmelden und das Kennwort ändern.</p><UserSessions own /></Modal>}
      {pw && <PasswordDialog minLength={me.minPasswordLength ?? 12} username={me.username} onClose={() => setPw(false)} onDone={() => { setPw(false); toast('Kennwort geändert – andere Sitzungen wurden abgemeldet'); onChanged(); }} />}
    </div>
  );
}

function PasswordDialog({ minLength, username, onClose, onDone }: { minLength: number; username: string; onClose: () => void; onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<unknown>(null);
  async function save() {
    try {
      await api('POST', '/api/auth/password', { currentPassword: current, newPassword: next });
      onDone();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Modal title="Kennwort ändern" onClose={onClose}
      footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" onClick={save} disabled={!current || !passwordOk(next, repeat, minLength, username)}>Ändern</button></>}>
      <ErrorNote error={error} />
      <label className="field">Bisheriges Kennwort<input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus /></label>
      <NewPasswordFields minLength={minLength} value={next} repeat={repeat} onChange={setNext} onRepeat={setRepeat} username={username} />
      <p className="small muted">Diese Sitzung bleibt angemeldet, alle anderen Sitzungen werden abgemeldet.</p>
    </Modal>
  );
}

interface Watched { objectType: 'TEST_CASE' | 'TEST_CYCLE' | 'TEST_PLAN'; objectId: string; label: string; projectKey: string; createdAt: string }
const WATCH_KIND: Record<Watched['objectType'], string> = { TEST_CASE: 'Testfall', TEST_CYCLE: 'Zyklus', TEST_PLAN: 'Testplan' };

/** Was ich beobachte – mit Sprung zum Objekt und „nicht mehr beobachten“. */
function WatchingDialog({ onClose }: { onClose: () => void }) {
  const list = useApi<Watched[]>('/api/watch');
  const [error, setError] = useState<unknown>(null);
  const link = (w: Watched) => w.objectType === 'TEST_CASE' ? href(['p', w.projectKey, 'repo'], { tc: w.label.split(' ')[0]! })
    : w.objectType === 'TEST_CYCLE' ? href(['p', w.projectKey, 'cycles', w.objectId]) : href(['p', w.projectKey, 'cycles'], { plan: w.objectId, tab: 'cockpit' });
  const stop = async (w: Watched) => {
    try { await api('DELETE', `/api/watch/${w.objectType}/${w.objectId}`); list.reload(); } catch (e) { setError(e); }
  };
  return (
    <Modal title="Beobachtet" help="watch" onClose={onClose} footer={<button onClick={onClose}>Schließen</button>}>
      <ErrorNote error={error ?? list.error} />
      <p className="small muted">Änderungen an diesen Objekten kommen per E-Mail, wenn in den Benachrichtigungen „Änderungen an … die ich beobachte“ eingeschaltet ist.</p>
      {list.data && !list.data.length && <div className="empty">Nichts beobachtet. Testfälle, Zyklen und Testpläne lassen sich mit „Beobachten“ verfolgen.</div>}
      <div className="table-wrap"><table><tbody>{list.data?.map((w) => (
        <tr key={`${w.objectType}:${w.objectId}`}>
          <td className="fit small muted">{WATCH_KIND[w.objectType]}</td>
          <td><a href={link(w)} onClick={onClose}>{w.label}</a> <span className="small muted">{w.projectKey}</span></td>
          <td className="fit"><button className="small" onClick={() => stop(w)}>Nicht mehr beobachten</button></td>
        </tr>
      ))}</tbody></table></div>
    </Modal>
  );
}

/** Versionsangabe im Kontomenü; Systemadministratoren springen zu den Details (Administration → Allgemein). */
function AppVersion({ admin, onNavigate }: { admin: boolean; onNavigate: () => void }) {
  const v = useApi<{ version: string; commit: string | null; label: string }>('/api/version');
  if (!v.data) return null;
  const text = <>Anemo {v.data.version}{v.data.commit && <span className="mono"> · {v.data.commit}</span>}</>;
  return admin
    ? <a className="small muted app-version" href={href(['admin', 'settings'])} onClick={onNavigate} title="Version und Systemangaben">{text}</a>
    : <div className="small muted app-version">{text}</div>;
}
