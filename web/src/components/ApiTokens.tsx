import { useState } from 'react';
import { api, fmtDate, useApi } from '../api.ts';
import { ErrorNote, Modal } from './common.tsx';
import { askConfirm } from '../ux.tsx';

interface Token { id: string; name: string; prefix: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null }

/** Eigene API-Tokens für CI-Pipelines, Skripte und Agenten (MCP). Das Geheimnis wird nur einmal angezeigt. */
export function ApiTokensDialog({ onClose }: { onClose: () => void }) {
  const list = useApi<Token[]>('/api/auth/tokens');
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  async function create() {
    try {
      const r = await api<{ token: string }>('POST', '/api/auth/tokens', { name, expiresDays: days ? Number(days) : null });
      setCreated(r.token);
      setName('');
      list.reload();
    } catch (e) {
      setError(e);
    }
  }
  async function revoke(t: Token) {
    if (!(await askConfirm({ title: 'Token widerrufen', message: `Token „${t.name}“ widerrufen? Pipelines/Agenten mit diesem Token verlieren sofort den Zugriff.`, confirmLabel: 'Widerrufen', danger: true }))) return;
    await api('DELETE', `/api/auth/tokens/${t.id}`).catch(setError);
    list.reload();
  }
  return (
    <Modal title="API-Tokens" help="api" onClose={onClose} footer={<button onClick={onClose}>Schließen</button>}>
      <p className="small muted">Für CI-Pipelines (Ergebnisimport), Skripte und KI-Agenten (MCP). Ein Token handelt mit <strong>Ihren</strong> Rechten –
        für Pipelines besser einen technischen Benutzer mit passender Rolle anlegen. Verwendung: <code>Authorization: Bearer &lt;Token&gt;</code>.</p>
      <ErrorNote error={error ?? list.error} />
      {created && <div className="notice ok stack">
        <strong>Neues Token – jetzt kopieren, es wird nicht wieder angezeigt:</strong>
        <div className="row"><code className="mono" style={{ wordBreak: 'break-all', flex: 1 }}>{created}</code>
          <button className="small" onClick={() => navigator.clipboard.writeText(created)}>Kopieren</button></div>
      </div>}
      <div className="row">
        <input placeholder="Name, z. B. GitLab-Pipeline Regression" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, width: 'auto' }} />
        <select value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 'auto' }} aria-label="Gültigkeit">
          <option value="30">30 Tage</option><option value="90">90 Tage</option><option value="365">1 Jahr</option><option value="">unbegrenzt</option>
        </select>
        <button className="primary" onClick={create} disabled={!name.trim()}>Erzeugen</button>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th className="fit">Kennung</th><th className="fit">gültig bis</th><th className="fit">zuletzt verwendet</th><th className="fit" /></tr></thead>
        <tbody>
          {list.data?.length === 0 && <tr><td colSpan={5} className="empty">Keine Tokens.</td></tr>}
          {list.data?.map((t) => (
            <tr key={t.id}><td>{t.name}</td><td className="fit mono small">{t.prefix}…</td><td className="fit small">{t.expiresAt ? fmtDate(t.expiresAt) : 'unbegrenzt'}</td>
              <td className="fit small">{fmtDate(t.lastUsedAt)}</td><td className="fit"><button className="small danger" onClick={() => revoke(t)}>Widerrufen</button></td></tr>
          ))}
        </tbody>
      </table></div>
    </Modal>
  );
}
