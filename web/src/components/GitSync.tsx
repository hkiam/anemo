import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { href } from '../router.ts';
import { ErrorNote, Modal } from './common.tsx';

interface Entry { key: string | null; title: string; path: string | null; status: 'same' | 'changedInGit' | 'changedInAnemo' | 'onlyInGit' | 'onlyInAnemo'; version: number | null }
const LABEL: Record<Entry['status'], [string, string]> = {
  same: ['gleich', 'ok'], changedInAnemo: ['in Anemo geändert', 'warn'], onlyInAnemo: ['nur in Anemo', 'neutral'],
  changedInGit: ['in Git geändert', 'bad'], onlyInGit: ['nur in Git', 'bad'],
};

/** Gherkin-Testfälle ↔ .feature-Dateien im GitLab-Repository abgleichen (ADR-0022). */
export function GitSyncDialog({ projectKey, canEdit, onClose }: { projectKey: string; canEdit: boolean; onClose: () => void }) {
  const status = useApi<{ available: boolean; reason: string | null; project?: string; branch?: string; folder?: string }>(`/api/projects/${projectKey}/gitlab/status`);
  const cmp = useApi<{ entries: Entry[] }>(status.data?.available ? `/api/projects/${projectKey}/gitlab/compare` : null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const entries = cmp.data?.entries ?? [];
  const toExport = entries.filter((e) => e.status === 'changedInAnemo' || e.status === 'onlyInAnemo').length;
  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      setMsg(await fn());
      setSel(new Set());
      cmp.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal size="large" title="Gherkin ↔ Git (GitLab)" onClose={onClose} footer={<>
      <button onClick={onClose}>Schließen</button>
      {canEdit && status.data?.available && <>
        <button disabled={busy || !sel.size} onClick={() => run(async () => {
          const r = await api<{ results: { action: string }[] }>('POST', `/api/projects/${projectKey}/gitlab/import`, { paths: [...sel] });
          return `${r.results.filter((x) => x.action === 'version').length} neue Versionen, ${r.results.filter((x) => x.action === 'created').length} neue Testfälle aus Git übernommen.`;
        })}>Aus Git übernehmen ({sel.size})</button>
        <button className="primary" disabled={busy || !toExport} onClick={() => run(async () => {
          const r = await api<{ created: number; updated: number; skippedChangedInGit: string[]; commit: { short_id: string; web_url: string } | null }>('POST', `/api/projects/${projectKey}/gitlab/export`);
          return r.commit ? `Commit ${r.commit.short_id}: ${r.created} neu, ${r.updated} aktualisiert${r.skippedChangedInGit.length ? `; nicht überschrieben (in Git geändert): ${r.skippedChangedInGit.join(', ')}` : ''}.` : 'Nichts zu schreiben.';
        })}>Nach Git schreiben ({toExport})</button>
      </>}
    </>}>
      <ErrorNote error={error ?? cmp.error} />
      {status.data && !status.data.available && <div className="notice warn">{status.data.reason}</div>}
      {status.data?.available && <p className="small muted">Repository <strong>{status.data.project}</strong>, Zweig <strong>{status.data.branch}</strong>, Ordner <code>{status.data.folder}/</code>.
        Jede Datei trägt das Tag <code>@Testfallschlüssel</code> – darüber ordnen auch CI-Ergebnisse (Cucumber) zu. „Nach Git schreiben“ überschreibt nie
        Dateien, die in Git geändert wurden; diese erst übernehmen.</p>}
      {msg && <div className="notice ok">{msg}</div>}
      {cmp.loading && <div className="muted">Lädt Repository …</div>}
      {entries.length > 0 && <div className="table-wrap"><table>
        <thead><tr><th className="fit" /><th className="fit">Testfall</th><th>Titel</th><th>Datei</th><th className="fit">Stand</th></tr></thead>
        <tbody>{entries.map((e, i) => {
          const pickable = canEdit && e.path && (e.status === 'changedInGit' || e.status === 'onlyInGit');
          return (
            <tr key={`${e.key}-${e.path}-${i}`}>
              <td className="fit">{pickable && <input type="checkbox" style={{ width: 'auto' }} checked={sel.has(e.path!)} aria-label={`übernehmen ${e.path}`}
                onChange={(ev) => setSel((s) => { const n = new Set(s); if (ev.target.checked) n.add(e.path!); else n.delete(e.path!); return n; })} />}</td>
              <td className="fit mono small">{e.key ? <a href={href(['p', projectKey, 'repo'], { tc: e.key })}>{e.key}</a> : '–'}</td>
              <td>{e.title}</td><td className="small mono">{e.path ?? '–'}</td>
              <td className="fit"><span className={`badge ${LABEL[e.status][1]}`}>{LABEL[e.status][0]}</span></td>
            </tr>
          );
        })}</tbody>
      </table></div>}
      {cmp.data && entries.length === 0 && <div className="empty">Keine Gherkin-Testfälle und keine .feature-Dateien.</div>}
    </Modal>
  );
}
