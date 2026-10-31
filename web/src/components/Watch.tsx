import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { Icon, toast } from '../ux.tsx';

export type WatchType = 'TEST_CASE' | 'TEST_CYCLE' | 'TEST_PLAN';
const NOUN: Record<WatchType, string> = { TEST_CASE: 'Testfall', TEST_CYCLE: 'Zyklus', TEST_PLAN: 'Testplan' };

/** Beobachten an-/abschalten: Änderungen kommen per E-Mail (Benachrichtigungsart „watched“). */
export function WatchButton({ type, id }: { type: WatchType; id: string }) {
  const s = useApi<{ watching: boolean; watchers: number }>(`/api/watch/${type}/${id}`);
  const [busy, setBusy] = useState(false);
  if (!s.data) return null;
  const on = s.data.watching;
  const toggle = async () => {
    setBusy(true);
    try {
      await api(on ? 'DELETE' : 'PUT', `/api/watch/${type}/${id}`);
      toast(on ? `${NOUN[type]} wird nicht mehr beobachtet` : `${NOUN[type]} wird beobachtet – Änderungen kommen per E-Mail`);
      s.reload();
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <button className={`small ${on ? 'on' : ''}`} aria-pressed={on} disabled={busy} onClick={toggle}
      title={`${on ? 'Beobachten beenden' : 'Beobachten: Änderungen per E-Mail erhalten'}${s.data.watchers ? ` – ${s.data.watchers} beobachten` : ''}`}>
      <Icon>👁</Icon>{on ? 'Beobachtet' : 'Beobachten'}{s.data.watchers > (on ? 1 : 0) ? ` (${s.data.watchers})` : ''}
    </button>
  );
}
