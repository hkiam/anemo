import { fmtDate, useApi } from '../api.ts';
import { ErrorNote } from '../components/common.tsx';
import { href } from '../router.ts';

interface Row {
  key: string; name: string; visibility: string; testCases: number; activeCycles: number; openExecutions: number; executed30: number;
  passRate30: number | null; openDefects: number; lastActivity: string | null; latestPlan: { name: string; release: string | null; releaseDecision: string | null } | null;
}
const DECISION: Record<string, [string, string]> = { released: ['freigegeben', 'ok'], conditional: ['mit Auflagen', 'warn'], rejected: ['nicht freigegeben', 'bad'] };

/** Projektübergreifender Überblick über alle sichtbaren Projekte (Testmanagement, Bereichsleitung). */
export function Portfolio() {
  const d = useApi<Row[]>('/api/portfolio');
  const rows = d.data ?? [];
  const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
  return (
    <div className="page" tabIndex={0} role="region" aria-label="Portfolio"><div className="stack">
      <div className="row"><h2 style={{ flex: 1 }}>Portfolio</h2><a className="btn small" href="/api/portfolio?format=xlsx">⇩ Excel</a></div>
      <p className="small muted">Alle Projekte, die Sie sehen dürfen – Bestand, Aktivität der letzten 30 Tage, offene Fehler und der jüngste Testplan (Release) mit Freigabeentscheidung.</p>
      <ErrorNote error={d.error} />
      {!d.data && !d.error && <div className="muted small" role="status">Lädt …</div>}
      {rows.length > 0 && <div className="kpis">
        <div className="card kpi"><div className="v">{rows.length}</div><div className="l">Projekte</div></div>
        <div className="card kpi"><div className="v">{sum((r) => r.testCases).toLocaleString('de-DE')}</div><div className="l">Testfälle</div></div>
        <div className="card kpi"><div className="v">{sum((r) => r.executed30).toLocaleString('de-DE')}</div><div className="l">ausgeführt (30 Tage)</div></div>
        <div className="card kpi"><div className="v">{sum((r) => r.openDefects)}</div><div className="l">offene Fehler</div></div>
      </div>}
      <div className="table-wrap"><table>
        <thead><tr><th>Projekt</th><th className="fit">Testfälle</th><th className="fit">aktive Zyklen</th><th className="fit">offen</th><th className="fit">ausgeführt (30 Tage)</th>
          <th className="fit">Bestehensquote</th><th className="fit">offene Fehler</th><th>jüngster Testplan (Release)</th><th className="fit">zuletzt aktiv</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.key} className="clickable" onClick={() => { window.location.hash = href(['p', r.key, 'start']); }}>
            <td><a href={href(['p', r.key, 'start'])}><b>{r.key}</b></a> {r.name}{r.visibility === 'restricted' && <span className="badge warn" title="eingeschränktes Projekt"><span aria-hidden="true">🔒</span><span className="sr-only">eingeschränkt</span></span>}</td>
            <td className="fit">{r.testCases.toLocaleString('de-DE')}</td><td className="fit">{r.activeCycles}</td><td className="fit">{r.openExecutions}</td>
            <td className="fit">{r.executed30}</td>
            <td className={`fit ${r.passRate30 !== null && r.passRate30 < 80 ? 'rate-bad' : ''}`}>{r.passRate30 === null ? '–' : `${r.passRate30.toLocaleString('de-DE')} %`}</td>
            <td className={`fit ${r.openDefects ? 'rate-bad' : ''}`}>{r.openDefects}</td>
            <td className="small">{r.latestPlan ? <>{r.latestPlan.name}{r.latestPlan.release ? ` (${r.latestPlan.release})` : ''}
              {r.latestPlan.releaseDecision && <span className={`badge ${DECISION[r.latestPlan.releaseDecision]?.[1] ?? 'neutral'}`} title="Freigabeentscheidung"> {DECISION[r.latestPlan.releaseDecision]?.[0]}</span>}</> : '–'}</td>
            <td className="fit small muted">{r.lastActivity ? fmtDate(r.lastActivity) : '–'}</td>
          </tr>
        ))}</tbody>
      </table>{d.data && !rows.length && <div className="empty">Keine Projekte sichtbar.</div>}</div>
    </div></div>
  );
}
