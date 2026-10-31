import { refLabel } from './References.tsx';
import { useApi } from '../api.ts';
import { fmtDuration } from '../ux.tsx';
import { Legend } from './common.tsx';

export interface TopDefect {
  provider: string; externalKey: string; title: string | null; status: string | null; url: string | null; resolution: 'open' | 'fixed' | 'rejected';
  executions: number; testCases: number; requirements: string[]; lastSeen: string | null; cycles: string[];
  /** Sitzungen mit diesem Fehler als Fund (optional, neuere Server) */
  sessions?: number;
}
export interface Workload {
  byAssignee: { assignee: string | null; total: number; open: number; passed: number; problems: number; durationSeconds: number; plannedMinutes: number; remainingMinutes: number; withoutEstimate: number }[];
  byTester: { executedBy: string; week: number; month: number; durationSeconds: number; problems: number }[];
  byCycle: { id: string; name: string; total: number; open: number; durationSeconds: number; plannedMinutes: number; remainingMinutes: number }[];
}
const COV = [['OK', 'bestanden', 'var(--ok)'], ['NOK', 'mit Fehlern', 'url(#cov-hatch)'], ['NOT_RUN', 'nicht (vollständig) getestet', 'var(--warn)'], ['UNCOVERED', 'ohne Testfall', 'var(--muted)']] as const;
const SWATCH: Record<string, string> = { OK: 'var(--ok)', NOK: 'var(--danger)', NOT_RUN: 'var(--warn)', UNCOVERED: 'var(--muted)' };
const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;

/** Abdeckung der Anforderungen je Woche (gestapelt), aus dem Ergebnisverlauf. */
export function CoverageHistory({ planId, weeks = 12 }: { planId: string; weeks?: number }) {
  const h = useApi<{ date: string; OK: number; NOK: number; NOT_RUN: number; UNCOVERED: number }[]>(`/api/plans/${planId}/coverage-history?weeks=${weeks}`);
  if (h.error) return <div className="small err">{h.error.message}</div>;
  if (!h.data) return <div className="muted small">Lädt …</div>;
  const total = Math.max(1, ...h.data.map((d) => d.OK + d.NOK + d.NOT_RUN + d.UNCOVERED));
  if (h.data.every((d) => d.OK + d.NOK + d.NOT_RUN + d.UNCOVERED === 0)) return <div className="small muted">Keine Anforderungen verknüpft.</div>;
  const W = 900, H = 150, P = 10, bw = (W - 2 * P) / h.data.length;
  const last = h.data.at(-1)!;
  const summary = `Abdeckung der Anforderungen je Woche, ${h.data.length} Wochen bis ${dm(last.date)}. Stand zuletzt: ${COV.map(([k, l]) => `${last[k]} ${l}`).join(', ')}.`;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label={summary}>
        <defs>
          <pattern id="cov-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--danger)" /><line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,.55)" strokeWidth="2" />
          </pattern>
        </defs>
        {h.data.map((d, i) => {
          let y = H;
          return <g key={d.date}><title>{`${new Date(d.date).toLocaleDateString('de-DE')}: ${COV.map(([k, l]) => `${d[k]} ${l}`).join(', ')}`}</title>
            {COV.map(([k, , col]) => { const hh = (d[k] / total) * (H - P); y -= hh; return d[k] ? <rect key={k} x={P + i * bw + 3} y={y} width={bw - 6} height={hh} fill={col} opacity={0.85} /> : null; })}
          </g>;
        })}
      </svg>
      <div className="cov-axis small muted" style={{ padding: `0 ${(100 * P) / W}%` }}>
        {h.data.map((d, i) => <span key={d.date}>{i % Math.ceil(h.data!.length / 6) === 0 ? `${d.date.slice(8, 10)}.${d.date.slice(5, 7)}.` : ''}</span>)}
      </div>
      <Legend title="Legende Abdeckung (Stand letzte Woche)" items={COV.map(([k, l]) => ({ label: l, color: SWATCH[k]!, value: last[k], shape: k === 'NOK' ? 'hatched' as const : 'box' as const }))} />
      <details className="chart-data small"><summary>Werte als Tabelle</summary>
        <div className="table-wrap" style={{ maxHeight: 260 }} tabIndex={0} role="region" aria-label="Abdeckung je Woche als Tabelle"><table>
          <thead><tr><th>Woche bis</th>{COV.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
          <tbody>{h.data.map((d) => <tr key={d.date}><td>{new Date(d.date).toLocaleDateString('de-DE')}</td>{COV.map(([k]) => <td key={k}>{d[k]}</td>)}</tr>)}</tbody>
        </table></div>
      </details>
    </div>
  );
}

export function TopDefectsTable({ rows, max = 10 }: { rows: TopDefect[]; max?: number }) {
  if (!rows.length) return <div className="small muted">Keine Fehler verknüpft.</div>;
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Top-Fehler"><table>
      <thead><tr><th>Fehler</th><th className="fit">Stand</th><th className="fit"><abbr title="betroffene Testfälle">Testf.</abbr></th><th className="fit"><abbr title="betroffene Ausführungen">Ausf.</abbr></th><th>Anforderungen</th></tr></thead>
      <tbody>{rows.slice(0, max).map((d) => (
        <tr key={`${d.provider}:${d.externalKey}`} className={d.resolution === 'open' ? '' : 'muted'}>
          <td>{d.url ? <a href={d.url} target="_blank" rel="noreferrer noopener">{refLabel(d)}</a> : refLabel(d)}
            {d.title && <div className="small muted">{d.title}</div>}
            {(d.sessions ?? 0) > 0 && <div className="small muted" title="Auch als Fund in explorativen Sitzungen erfasst">+ {d.sessions === 1 ? '1 Sitzungsfund' : `${d.sessions} Sitzungsfunde`}</div>}</td>
          <td className="fit small"><span className={`badge ${d.resolution === 'open' ? 'bad' : d.resolution === 'fixed' ? 'ok' : 'neutral'}`}>{d.resolution === 'open' ? 'offen' : d.resolution === 'fixed' ? 'behoben' : 'abgelehnt'}</span>
            {d.status && <div className="muted">{d.status}</div>}</td>
          <td className="fit">{d.testCases}</td><td className="fit">{d.executions}</td>
          <td className="small">{d.requirements.slice(0, 4).join(', ')}{d.requirements.length > 4 ? ' …' : ''}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

/** Team & Aufwand: je Person Fortschritt, erfasste und geplante Zeit. */
export function WorkloadTable({ w, compact }: { w: Workload; compact?: boolean }) {
  if (!w.byAssignee.length) return <div className="small muted">Keine Ausführungen im Umfang.</div>;
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Team und Aufwand je Person"><table>
      <thead><tr><th>Zuständig</th><th style={{ width: 160 }}>Fortschritt</th><th className="fit">offen</th><th className="fit">Probleme</th>{!compact && <><th className="fit">erfasst</th><th className="fit">geplant / Rest</th></>}</tr></thead>
      <tbody>{w.byAssignee.map((a) => {
        const done = a.total - a.open;
        return (
          <tr key={a.assignee ?? '-'}>
            <td>{a.assignee ?? <span className="muted">nicht zugewiesen</span>}</td>
            <td><div className="progress" title={`${done} von ${a.total} erledigt`} role="img" aria-label={`${done} von ${a.total} erledigt, ${a.passed} bestanden, ${a.problems} mit Problemen`}><span style={{ width: `${(100 * a.passed) / Math.max(1, a.total)}%`, background: 'var(--ok)' }} />
              <span style={{ width: `${(100 * a.problems) / Math.max(1, a.total)}%`, background: 'var(--danger)' }} /></div>
              <div className="small muted">{done} / {a.total}</div></td>
            <td className="fit">{a.open}</td><td className="fit">{a.problems || '–'}</td>
            {!compact && <><td className="fit small">{a.durationSeconds ? fmtDuration(a.durationSeconds) : '–'}</td>
            <td className="fit small">{a.plannedMinutes ? `${fmtDuration(a.plannedMinutes * 60)} / ${fmtDuration(a.remainingMinutes * 60)}` : '–'}
              {a.withoutEstimate > 0 && <div className="muted" title="ohne Schätzung">{a.withoutEstimate} ohne Schätzung</div>}</td></>}
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}
