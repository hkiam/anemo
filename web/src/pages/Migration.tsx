import { useState } from 'react';
import { api, fmtDate, useApi } from '../api.ts';
import { ErrorNote } from '../components/common.tsx';
import { href, navigate, type Route } from '../router.ts';
import type { Mapping, MigrationReport, MigrationRun } from '../types.ts';

export function Migration({ route }: { route: Route }) {
  const runId = route.path[1];
  const runs = useApi<MigrationRun[]>('/api/migration/runs');
  const snapshots = useApi<string[]>('/api/migration/snapshots');
  const [snapshot, setSnapshot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ runId: string }>('POST', '/api/migration/runs', { snapshot });
      runs.reload();
      navigate(['migration', r.runId]);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" tabIndex={0} role="region" aria-label="Migration"><div className="page-wide stack">
      <h2>Migration Jira/Zephyr</h2>
      <div className="card"><div className="card-body stack">
        <p className="small muted" style={{ margin: 0 }}>
          Snapshots werden mit <code>npm run migration -w server -- extract …</code> erzeugt (optional <code>anonymize</code>) und liegen im Snapshot-Verzeichnis.
          Ein Import ist idempotent: erneutes Einspielen aktualisiert statt zu duplizieren.
        </p>
        <div className="row">
          <select aria-label="Snapshot für den Import" value={snapshot} onChange={(e) => setSnapshot(e.target.value)} style={{ width: 'auto', minWidth: 240 }}>
            <option value="">Snapshot wählen …</option>
            {snapshots.data?.map((s) => <option key={s}>{s}</option>)}
          </select>
          <button className="primary" disabled={!snapshot || busy} onClick={start}>{busy ? 'Import läuft …' : 'Import starten'}</button>
        </div>
        <ErrorNote error={error} />
      </div></div>

      {runId ? <Report runId={runId} /> : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Migrationsläufe"><table>
          <thead><tr><th>Lauf</th><th>Quelle</th><th>Status</th><th>Gestartet</th></tr></thead>
          <tbody>{runs.data?.map((r) => (
            <tr key={r.id} className="clickable" onClick={() => navigate(['migration', r.id])}>
              <td className="mono small">{r.id.slice(0, 13)}…</td><td className="small">{r.source}</td>
              <td><span className={`badge ${r.status === 'COMPLETED' ? 'ok' : r.status === 'RUNNING' ? 'warn' : 'bad'}`}>{r.status}</span></td>
              <td className="small">{fmtDate(r.startedAt)}</td>
            </tr>
          ))}</tbody>
        </table>{runs.data?.length === 0 && <div className="empty">Noch keine Migrationsläufe.</div>}</div>
      )}
    </div></div>
  );
}

function Report({ runId }: { runId: string }) {
  const report = useApi<MigrationReport>(`/api/migration/runs/${runId}/report`);
  const [filter, setFilter] = useState<{ outcome?: string; sourceType?: string; field?: string }>({});
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]).toString();
  const mappings = useApi<Mapping[]>(`/api/migration/runs/${runId}/mappings?limit=200&${qs}`);
  if (report.error) return <ErrorNote error={report.error} />;
  if (!report.data) return <div className="muted">Lädt …</div>;
  const r = report.data;
  const total = r.byType.reduce((a, t) => a + t.total, 0);
  const outcome = (o: string) => r.byType.reduce((a, t) => a + (t.outcomes[o] ?? 0), 0);

  return (
    <div className="stack">
      <div className="row"><a href={href(['migration'])}>‹ Alle Läufe</a></div>
      <div className={`notice ${r.verdict === 'PASSED' ? 'ok' : 'bad'}`}>
        <strong>Verifikation {r.verdict === 'PASSED' ? 'bestanden' : 'nicht bestanden'}</strong> · {r.run.source} · {fmtDate(r.run.startedAt)}
      </div>
      <div className="kpis">
        <div className="card kpi"><div className="v">{total}</div><div className="l">Quellobjekte</div></div>
        <div className="card kpi"><div className="v">{outcome('MAPPED')}</div><div className="l">vollständig strukturiert</div></div>
        <div className="card kpi"><div className="v">{outcome('PARTIAL')}</div><div className="l">mit bewahrten Feldern</div></div>
        <div className="card kpi"><div className="v" style={{ color: outcome('FAILED') ? 'var(--danger)' : undefined }}>{outcome('FAILED')}</div><div className="l">fehlgeschlagen</div></div>
      </div>

      <div className="card"><div className="card-body stack">
        <h3>Prüfungen</h3>
        {r.checks.map((c) => (
          <details key={c.name} open={!c.passed}>
            <summary><span className={`badge ${c.passed ? 'ok' : 'bad'}`}>{c.passed ? '✓' : '✗'}</span> {c.name}</summary>
            {c.details.length > 0 && <ul className="small">{c.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
          </details>
        ))}
      </div></div>

      <div className="grid2">
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Ergebnis je Objektart"><table>
          <thead><tr><th>Objekttyp</th><th>Gesamt</th><th>Ergebnis</th></tr></thead>
          <tbody>{r.byType.map((t) => (
            <tr key={t.sourceType} className="clickable" onClick={() => setFilter({ sourceType: t.sourceType })}>
              <td>{t.sourceType}</td><td>{t.total}</td>
              <td className="small">{Object.entries(t.outcomes).map(([k, v]) => `${k} ${v}`).join(' · ')}<div className="muted">{Object.entries(t.actions).map(([k, v]) => `${k} ${v}`).join(' · ')}</div></td>
            </tr>
          ))}</tbody>
        </table></div>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Nur bewahrte Felder (Mapping-Kandidaten)"><table>
          <thead><tr><th>Nur bewahrtes Feld (Mapping-Kandidat)</th><th>Anzahl</th></tr></thead>
          <tbody>{r.preservedFields.map((f) => (
            <tr key={f.field} className="clickable" onClick={() => setFilter({ field: f.field })}><td className="small">{f.field}</td><td>{f.count}</td></tr>
          ))}</tbody>
        </table>{r.preservedFields.length === 0 && <div className="empty">Alle Felder strukturiert übernommen.</div>}</div>
      </div>

      <div className="stack">
        <div className="row">
          <h3>Einzelnachweis je Quellobjekt</h3>
          <span className="spacer" />
          {['', 'MAPPED', 'PARTIAL', 'FAILED', 'SKIPPED'].map((o) => (
            <button key={o} className={(filter.outcome ?? '') === o && !filter.field && !filter.sourceType ? 'small primary' : 'small'} onClick={() => setFilter(o ? { outcome: o } : {})}>{o || 'Alle'}</button>
          ))}
        </div>
        {(filter.field || filter.sourceType) && <div className="small muted">Filter: {filter.field ?? filter.sourceType} <button className="small ghost" onClick={() => setFilter({})}>✕</button></div>}
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Einzelnachweis je Quellobjekt"><table>
          <thead><tr><th>Quelle</th><th>Ziel</th><th>Ergebnis</th><th>Hinweise</th></tr></thead>
          <tbody>{mappings.data?.map((m) => (
            <tr key={m.id}>
              <td className="small mono">{m.sourceType}<div className="muted">{m.sourceId}</div></td>
              <td className="small">{m.targetKey ? <a href={href(['p', m.targetKey.split('-')[0]!, 'repo'], { tc: m.targetKey })}>{m.targetKey}</a> : m.targetType ?? '–'}</td>
              <td><span className={`badge ${m.outcome === 'MAPPED' ? 'ok' : m.outcome === 'FAILED' ? 'bad' : m.outcome === 'PARTIAL' ? 'warn' : 'neutral'}`}>{m.outcome}</span><div className="small muted">{m.action}</div></td>
              <td className="small">
                {m.preservedFields.length > 0 && <div>Bewahrt: {m.preservedFields.join(', ')}</div>}
                {m.messages.map((x, i) => <div key={i} className="muted" style={{ whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'hidden' }}>{x}</div>)}
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>
    </div>
  );
}
