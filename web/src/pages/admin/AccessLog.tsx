import { useState } from 'react';
import { fmtDate, useApi } from '../../api.ts';
import { ErrorNote } from '../../components/common.tsx';
import { href } from '../../router.ts';

interface Entry { at: string; username: string; action: string; objectKind: string; objectId: string | null; objectKey: string | null; path: string }
const ACTION: Record<string, string> = { read: 'gelesen', execute: 'ausgeführt', edit: 'geändert', manage: 'verwaltet' };
const KIND: Record<string, string> = {
  project: 'Projekt', testCase: 'Testfall', execution: 'Ausführung', cycle: 'Zyklus', plan: 'Testplan', folder: 'Ordner',
  attachment: 'Anhang', attachmentSource: 'Anhang', reference: 'Verweis', TEST_CASE: 'Testfall (Anhänge/Verweise)', TEST_EXECUTION: 'Ausführung (Anhänge/Verweise)',
};

/** Zugriffsprotokoll eines eingeschränkten Projekts (wer hat was wann angesehen oder versucht). */
export function AccessLog({ projectKey }: { projectKey: string }) {
  const [user, setUser] = useState('');
  const [page, setPage] = useState(0);
  const log = useApi<{ total: number; items: Entry[] }>(`/api/projects/${projectKey}/access-log?limit=100&offset=${page * 100}${user ? `&user=${encodeURIComponent(user)}` : ''}`);
  return (
    <div className="stack">
      <p className="small muted">Protokolliert werden Zugriffe auf eingeschränkte Projekte, auch abgelehnte Versuche. Wiederholte Zugriffe derselben Person auf dasselbe Objekt innerhalb von 5 Minuten erscheinen einmal.</p>
      <div className="row">
        <input placeholder="Benutzername filtern" aria-label="Zugriffe nach Benutzername filtern" value={user} onChange={(e) => { setUser(e.target.value.trim()); setPage(0); }} style={{ width: 220 }} />
        <span className="small muted">{log.data?.total ?? 0} Einträge</span>
        <span className="spacer" />
        <button className="small" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Vorige Seite" title="Vorige Seite">‹</button>
        <button className="small" disabled={(page + 1) * 100 >= (log.data?.total ?? 0)} onClick={() => setPage(page + 1)} aria-label="Nächste Seite" title="Nächste Seite">›</button>
      </div>
      <ErrorNote error={log.error} />
      <div className="table-wrap" style={{ maxHeight: '55vh' }}>
        <table>
          <thead><tr><th className="fit">Zeitpunkt</th><th className="fit">Benutzer</th><th className="fit">Aktion</th><th>Objekt</th></tr></thead>
          <tbody>
            {log.data?.items.length === 0 && <tr><td colSpan={4} className="empty">Keine Einträge.</td></tr>}
            {log.data?.items.map((e, i) => {
              const denied = e.action.startsWith('denied:');
              const action = ACTION[e.action.replace('denied:', '')] ?? e.action;
              return (
                <tr key={i}>
                  <td className="fit small">{fmtDate(e.at)}</td>
                  <td className="fit small">{e.username}</td>
                  <td className={`fit small ${denied ? 'rate-bad' : ''}`}>{denied ? `abgelehnt (${action})` : action}</td>
                  <td className="small">{KIND[e.objectKind] ?? e.objectKind}{' '}
                    {e.objectKey ? <a href={href(['p', projectKey, 'repo'], { tc: e.objectKey })}>{e.objectKey}</a> : <span className="muted mono">{e.objectId}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
