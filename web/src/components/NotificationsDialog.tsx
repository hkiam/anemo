import { useEffect, useState } from 'react';
import { api, useApi } from '../api.ts';
import { ErrorNote, Modal } from './common.tsx';

const KINDS: [string, string][] = [
  ['assigned', 'Mir wurde eine Ausführung zugewiesen'],
  ['retest', 'Ein Nachtest ist für mich fällig (Fehler erledigt)'],
  ['failed_own', 'Ein Test in einem meiner Zyklen ist fehlgeschlagen'],
  ['mentioned', 'Ich werde in einer Diskussion erwähnt (@name)'],
  ['watched', 'Änderungen an Testfällen, Zyklen und Testplänen, die ich beobachte (👁)'],
];

/** Eigene E-Mail-Adresse und Benachrichtigungen (ADR-0020). */
export function NotificationsDialog({ onClose }: { onClose: () => void }) {
  const cur = useApi<{ email: string | null; kinds: string[]; mailConfigured: boolean }>('/api/auth/notifications');
  const [email, setEmail] = useState('');
  const [kinds, setKinds] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (cur.data) { setEmail(cur.data.email ?? ''); setKinds(cur.data.kinds); }
  }, [cur.data]);
  async function save() {
    try {
      await api('PUT', '/api/auth/notifications', { email: email.trim() || null, kinds });
      onClose();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Modal title="Benachrichtigungen" help="notifications" onClose={onClose} footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" onClick={save}>Speichern</button></>}>
      <ErrorNote error={error ?? cur.error} />
      {cur.data && !cur.data.mailConfigured && <div className="notice warn">Der Mail-Versand ist noch nicht eingerichtet – Einstellungen werden gespeichert und gelten, sobald er aktiv ist.</div>}
      <label className="field">E-Mail-Adresse<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@firma.de" /></label>
      <div className="field">Per E-Mail benachrichtigen, wenn …
        {KINDS.map(([k, label]) => (
          <label key={k} className="row" style={{ color: 'var(--text)' }}><input type="checkbox" style={{ width: 'auto' }} checked={kinds.includes(k)}
            onChange={(e) => setKinds((x) => (e.target.checked ? [...x, k] : x.filter((y) => y !== k)))} />{label}</label>
        ))}
      </div>
      <p className="small muted">Mehrere Ereignisse werden zu einer Mail zusammengefasst; eigene Aktionen lösen keine Mail aus.</p>
    </Modal>
  );
}
