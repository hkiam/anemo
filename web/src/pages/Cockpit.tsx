import { useEffect, useState } from 'react';
import { api, fmtDate, useApi } from '../api.ts';
import { ErrorNote, Legend, Modal, Progress, StatusBadge, Wiki } from '../components/common.tsx';
import { useCan } from '../session.tsx';
import { askConfirm, askText, fmtDuration, toast, useUnsavedGuard } from '../ux.tsx';
import { plural } from '../text.ts';
import { WikiEditor } from '../wiki/WikiEditor.tsx';
import { BurndownChart } from '../components/Burndown.tsx';
import { CoverageHistory, type TopDefect, TopDefectsTable, type Workload, WorkloadTable } from '../components/Insights.tsx';
import { href } from '../router.ts';
import type { ExecutionStatus } from '../types.ts';

interface Summary { total: number; executed: number; passRate: number | null; failed: number; open: number; byStatus: { code: string; count: number }[] }
interface Defect { provider: string; key: string; title: string | null; status: string | null; url: string | null; executions?: number; /** Sitzungen, in denen der Fehler als Fund vorkommt */ sessions?: number }
interface CockpitData {
  assessment: { recommendation: 'release' | 'conditional' | 'not-recommended' | 'insufficient'; reasons: string[] };
  criteria: { label: string; target: string; actual: string; met: boolean }[];
  risks: string[];
  knownDefects: (Defect & { executions: number })[];
  openFindings: { session: string; text: string }[];
  releaseDecision: { decision: Decision; note: string | null; by: string | null; at: string | null;
    baseline: { id: string; status: string; sha256: string | null; name: string | null } | null; changesSince: number } | null;
  current: Summary & { testCases: number };
  cycles: { id: string; name: string; build: string | null; configuration: string; summary: Summary }[];
  burn: { day: string; passed: number; failed: number; other: number }[];
  problems: { id: string; cycleId: string; cycleName: string; key: string; title: string; status: string; defects: Defect[] }[];
  retestPending: { key: string; title: string; cycleName: string; defects: string[] }[];
  knownFailures: { id: string; cycleId: string; cycleName: string; key: string; title: string; status: string; defects: Defect[]; comment: string | null }[];
  byConfiguration: { configurations: { key: string; label: string; summary: Summary & { testCases: number } }[]; matrix: { key: string; title: string; cells: Record<string, string | null> }[] };
  openDefects: Defect[]; allDefects: number;
  changedNotTested: { key: string; title: string; testedVersion: number; currentVersion: number; changedAt: string; changedBy: string; changeNote: string | null }[];
  coverage: { totals: { OK: number; NOK: number; NOT_RUN: number; UNCOVERED: number }; requirements: number; withoutRequirement: number };
  effort: { seconds: number; measured: number };
  plan: { id: string; name: string };
}

type Decision = 'released' | 'conditional' | 'rejected';
const DECISION: Record<Decision, [string, string]> = {
  released: ['Freigegeben', 'ok'], conditional: ['Freigegeben mit Auflagen', 'warn'], rejected: ['Nicht freigegeben', 'bad'],
};
interface ExitCriteria { minPassRate?: number; minExecutionRate?: number; maxOpenDefects?: number; maxFailed?: number; maxKnownFailures?: number; fullCoverage?: boolean; noUntestedChanges?: boolean }

const REC = {
  insufficient: ['Keine Aussage möglich – zu wenig getestet', 'info'],
  release: ['Freigabe empfohlen', 'ok'],
  conditional: ['Freigabe mit Auflagen empfohlen', 'warn'],
  'not-recommended': ['Freigabe nicht empfohlen', 'bad'],
} as const;

const toRecord = (s: Summary) => Object.fromEntries(s.byStatus.map((b) => [b.code, b.count]));

/** Release-Cockpit eines Testplans (C3). */
export function Cockpit({ projectKey, planId, statuses }: { projectKey: string; planId: string; statuses: ExecutionStatus[] }) {
  const c = useApi<CockpitData>(`/api/plans/${planId}/cockpit`);
  const plan = useApi<{ assessment: string | null; assessmentBy?: string | null; assessmentAt?: string | null; assessmentAi?: string | null; exitCriteria: ExitCriteria | null;
    statusNote?: string | null; statusNoteAt?: string | null; statusNoteBy?: string | null }>(`/api/plans/${planId}`);
  const assist = useApi<{ llm: { model: string } | null }>('/api/assist/status');
  const canEdit = useCan(projectKey, 'edit');
  const [editing, setEditing] = useState(false);
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const [asOf, setAsOf] = useState('');
  const top = useApi<TopDefect[]>(`/api/projects/${projectKey}/top-defects?planId=${planId}&limit=15`);
  const team = useApi<Workload>(`/api/projects/${projectKey}/workload?planId=${planId}`);
  const [deciding, setDeciding] = useState(false);
  const [noting, setNoting] = useState(false);
  if (!c.data) return c.error ? <ErrorNote error={c.error} /> : <div className="muted">Lädt …</div>;
  const d = c.data;
  const [label, tone] = REC[d.assessment.recommendation];
  const cov = d.coverage;
  const report = (fmt = '') => `/api/reports/traceability/${planId}${fmt}`;
  return (
    <div className="stack">
      {editing && <AssessmentDialog planId={planId} initial={plan.data?.assessment ?? ''} initialAi={plan.data?.assessmentAi ?? null} ai={!!assist.data?.llm} onClose={() => setEditing(false)}
        onSaved={() => { setEditing(false); plan.reload(); }} autoDraft={!plan.data?.assessment && !!assist.data?.llm} />}
      {criteriaOpen && <CriteriaDialog planId={planId} initial={plan.data?.exitCriteria ?? {}} onClose={() => setCriteriaOpen(false)}
        onSaved={() => { setCriteriaOpen(false); plan.reload(); c.reload(); }} />}
      {deciding && <DecisionDialog planId={planId} recommendation={label} current={d.releaseDecision} onClose={() => setDeciding(false)}
        onSaved={() => { setDeciding(false); c.reload(); }} />}
      {noting && <StatusNoteDialog planId={planId} initial={plan.data?.statusNote ?? ''} onClose={() => setNoting(false)}
        onSaved={() => { setNoting(false); plan.reload(); }} />}
      <ReleaseDecisionBox planId={planId} decision={d.releaseDecision} canEdit={canEdit} onEdit={() => setDeciding(true)} onBaseline={c.reload} />
      <div className={`notice ${tone}`}>
        <strong>{label}</strong>
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{d.assessment.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        <div className="small muted">Regelbasierte Empfehlung aus aktuellem Stand je Testfall und Konfiguration, Ausstiegskriterien und verknüpften Fehlern – die Freigabeentscheidung treffen Verantwortliche oben.</div>
      </div>
      <div className="card"><div className="card-body stack">
        <div className="row"><h4 style={{ flex: 1 }}>Ausstiegskriterien</h4>
          {canEdit && <button className="small" onClick={() => setCriteriaOpen(true)}>{d.criteria.length ? '✎ Bearbeiten' : '+ Kriterien festlegen'}</button>}</div>
        {d.criteria.length === 0 ? <div className="small muted">Keine Ausstiegskriterien festgelegt – z. B. Bestehensquote ≥ 95 %, keine offenen Fehler, alle Anforderungen getestet.</div> : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Ausstiegskriterien"><table><thead><tr><th>Kriterium</th><th>Ziel</th><th>Ist</th><th /></tr></thead><tbody>
            {d.criteria.map((k) => <tr key={k.label}><td>{k.label}</td><td className="fit">{k.target}</td><td className="fit">{k.actual}</td>
              <td className="fit">{k.met ? <span className="rate-ok"><span aria-hidden="true">✓ </span>erfüllt</span> : <span className="rate-bad"><span aria-hidden="true">✗ </span>nicht erfüllt</span>}</td></tr>)}
          </tbody></table></div>
        )}
      </div></div>
      {(d.risks.length > 0 || d.knownDefects.length > 0 || d.openFindings.length > 0) && <div className="card"><div className="card-body stack">
        <h4>Restrisiken</h4>
        {d.risks.length > 0 && <ul style={{ margin: 0, paddingLeft: 18 }}>{d.risks.map((r) => <li key={r}>{r}</li>)}</ul>}
        {d.knownDefects.length > 0 && <details><summary className="small">Bekannte, nicht behobene Fehler ({d.knownDefects.length})</summary>
          <ul className="small" style={{ paddingLeft: 18 }}>{d.knownDefects.map((x) => <li key={`${x.provider}:${x.key}`}>{x.url ? <a href={x.url} target="_blank" rel="noreferrer noopener">{x.key}</a> : x.key} {x.title ?? ''} <span className="muted">({x.status ?? '?'})</span>{(x.sessions ?? 0) > 0 && <span className="badge neutral" title="Auch als Fund in explorativen Sitzungen erfasst"> + {plural(x.sessions!, 'Sitzungsfund', 'Sitzungsfunde')}</span>}</li>)}</ul></details>}
        {d.openFindings.length > 0 && <details><summary className="small">Fehlerfunde aus explorativen Sitzungen ohne Ticket ({d.openFindings.length})</summary>
          <ul className="small" style={{ paddingLeft: 18 }}>{d.openFindings.map((f, i) => <li key={i}><span className="muted">{f.session}:</span> {f.text}</li>)}</ul></details>}
      </div></div>}
      <div className="kpis">
        <Kpi value={d.current.testCases} label="Testfälle im Plan" />
        <Kpi value={d.current.passRate === null ? '–' : `${d.current.passRate.toLocaleString('de-DE')} %`} label="Bestehensquote (bestanden ÷ ausgeführt ohne blockiert)" />
        <Kpi value={d.current.failed} label="fehlgeschlagen/blockiert" bad={d.current.failed > 0} />
        <Kpi value={d.current.open} label="offen" />
        <Kpi value={`${d.openDefects.length} / ${d.allDefects}`} label="offene / alle Fehler" bad={d.openDefects.length > 0} />
        <Kpi value={d.changedNotTested.length} label="geändert, nicht erneut getestet" bad={d.changedNotTested.length > 0} />
        {d.effort.seconds > 0 && <Kpi value={fmtDuration(d.effort.seconds)} label={`Aufwand (${plural(d.effort.measured, 'Ausführung', 'Ausführungen')} gemessen)`} />}
      </div>
      <div className="card"><div className="card-body stack">
        <h4>Burn-down gegen geplantes Ende</h4>
        <BurndownChart planId={planId} />
      </div></div>
      <div className="card"><div className="card-body stack">
        <div className="row"><h4 style={{ flex: 1 }}>Lagebild (Zwischenbericht)</h4>
          {canEdit && <button className="small" onClick={() => setNoting(true)}>{plan.data?.statusNote ? '✎ Bearbeiten' : '✎ Lagebild schreiben'}</button>}</div>
        {plan.data?.statusNote ? <>
          <Wiki text={plan.data.statusNote} />
          {plan.data.statusNoteAt && <div className="small muted">Stand {fmtDate(plan.data.statusNoteAt)}{plan.data.statusNoteBy ? `, ${plan.data.statusNoteBy}` : ''}</div>}
        </> : <div className="small muted">Noch kein Lagebild – Hindernisse, Einschätzung und nächste Schritte erscheinen im Teststatusbericht.</div>}
        <StatusReportLinks planId={planId} />
      </div></div>
      <div className="card"><div className="card-body stack">
        <div className="row"><h4 style={{ flex: 1 }}>Abdeckung der Anforderungen</h4>
          <a className="btn small" href={report()} target="_blank" rel="noreferrer" title="Rückverfolgbarkeit: Anforderung × Testfall × Ergebnis (druckbar)">Rückverfolgbarkeit öffnen</a></div>
        {cov.requirements === 0 ? <div className="small muted">Keine Anforderungen verknüpft – Anforderungen am Testplan (Verweise) oder an Testfällen verknüpfen.</div> : (
          <div className="kpis">
            <Kpi value={cov.totals.OK} label="abgedeckt, bestanden" />
            <Kpi value={cov.totals.NOK} label="mit Fehlern" bad={cov.totals.NOK > 0} />
            <Kpi value={cov.totals.NOT_RUN} label="nicht (vollständig) getestet" bad={cov.totals.NOT_RUN > 0} />
            <Kpi value={cov.totals.UNCOVERED} label="ohne Testfall" bad={cov.totals.UNCOVERED > 0} />
          </div>
        )}
        {cov.withoutRequirement > 0 && <div className="small muted">{plural(cov.withoutRequirement, 'Testfall', 'Testfälle')} im Plan ohne verknüpfte Anforderung.</div>}
      </div></div>
      <div className="card"><div className="card-body stack">
        <div className="row"><h4 style={{ flex: 1 }}>Fazit des Testmanagements</h4>
          {canEdit && <button className="small" onClick={() => setEditing(true)}>{plan.data?.assessment ? '✎ Bearbeiten' : assist.data?.llm ? '✨ Fazit entwerfen' : '✎ Fazit schreiben'}</button>}</div>
        {plan.data?.assessment ? <><Wiki text={plan.data.assessment} />
          <div className="small muted">Verfasst von {plan.data.assessmentBy ?? 'unbekannt'}{plan.data.assessmentAt ? `, ${fmtDate(plan.data.assessmentAt)}` : ''}
            {plan.data.assessmentAi && <> · <span className="badge accent" title={`Entwurf von ${plan.data.assessmentAi}, geprüft und gespeichert von ${plan.data.assessmentBy ?? 'unbekannt'}`}>✨ mit KI erstellt</span></>}</div></>
          : <div className="small muted">Noch kein Fazit. Es erscheint im Testabschlussbericht und im Lieferpaket.</div>}
      </div></div>
      <div className="card"><div className="card-body">
        <div className="row"><h4 style={{ flex: 1 }}>Abdeckung der Anforderungen im Verlauf</h4>
          <label className="row small">Rückverfolgbarkeit zum Stichtag
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} style={{ width: 'auto' }} aria-label="Stichtag" /></label>
          {asOf && <a className="btn small" href={`${report()}${report().includes('?') ? '&' : '?'}asOf=${asOf}`} target="_blank" rel="noreferrer">Bericht zum Stichtag</a>}</div>
        <CoverageHistory planId={planId} />
      </div></div>
      <div className="card"><div className="card-body stack">
        <div className="row"><h4 style={{ flex: 1 }}>Team &amp; Aufwand</h4>
          <a className="btn small" href={`/api/projects/${projectKey}/workload?planId=${planId}&format=xlsx`}>⇩ Excel</a></div>
        {team.data ? <WorkloadTable w={team.data} /> : <div className="muted small">Lädt …</div>}
      </div></div>
      {d.byConfiguration.configurations.length > 0 && <ByConfiguration d={d.byConfiguration} statuses={statuses} />}
      <div className="card"><div className="card-body">
        <h4>Verlauf der Ausführungen</h4>
        <Burn data={d.burn} />
      </div></div>
      <div className="grid2">
        <div className="stack">
          <h4>Zyklen</h4>
          <div className="table-wrap"><table>
            <tbody>{d.cycles.map((cy) => (
              <tr key={cy.id} className="clickable" onClick={() => { window.location.hash = href(['p', projectKey, 'cycles', cy.id]); }}>
                <td><a href={href(['p', projectKey, 'cycles', cy.id])} onClick={(e) => e.stopPropagation()}>{cy.name}</a><div className="small muted">{[cy.build, cy.configuration].filter(Boolean).join(' · ')}</div></td>
                <td style={{ width: 180 }}><Progress byStatus={toRecord(cy.summary)} statuses={statuses} total={cy.summary.total} /></td>
                <td className="fit small">{cy.summary.passRate === null ? '–' : `${cy.summary.passRate} %`}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
        <div className="stack">
          <div className="row"><h4 style={{ flex: 1 }}>Top-Fehler ({d.openDefects.length} offen)</h4>
            <a className="btn small" href={`/api/projects/${projectKey}/top-defects?planId=${planId}&format=xlsx`}>⇩ Excel</a></div>
          <p className="small muted">Nach Auswirkung: betroffene Testfälle und Anforderungen, offene zuerst.</p>
          {top.data ? <TopDefectsTable rows={top.data} /> : <div className="muted small">Lädt …</div>}
        </div>
      </div>
      <div className="grid2">
        <div className="stack">
          <h4>Fehlgeschlagen/blockiert – aktueller Stand ({d.problems.length})</h4>
          <div className="table-wrap" style={{ maxHeight: 360 }}><table><tbody>
            {d.problems.length === 0 && <tr><td className="empty">Keine.</td></tr>}
            {d.problems.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => { window.location.hash = href(['p', projectKey, 'cycles', p.cycleId], { exec: p.id }); }}>
                <td className="fit mono small"><a href={href(['p', projectKey, 'cycles', p.cycleId], { exec: p.id })} onClick={(e) => e.stopPropagation()}>{p.key}</a></td><td>{p.title}<div className="small muted">{p.cycleName}</div></td>
                <td className="fit"><StatusBadge code={p.status} statuses={statuses} /></td>
                <td className="small">{p.defects.map((x) => x.key).join(', ') || '–'}</td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
        {d.retestPending.length > 0 && <div className="stack">
          <h4>Behoben, aber nicht nachgetestet ({d.retestPending.length})</h4>
          <p className="small muted" style={{ margin: 0 }}>Fehler laut Ticket behoben, der Testfall ist aber noch nicht wieder bestanden. Fehlt ein Nachtest, gibt es keinen offenen Zyklus mit gleicher Konfiguration – dann einen anlegen bzw. öffnen.</p>
          <div className="table-wrap" style={{ maxHeight: 360 }}><table><tbody>
            {d.retestPending.map((p) => (
              <tr key={`${p.key}-${p.cycleName}`}><td className="fit mono small">{p.key}</td><td>{p.title}<div className="small muted">{p.cycleName}</div></td><td className="small">{p.defects.join(', ')}</td></tr>
            ))}
          </tbody></table></div>
        </div>}
        {d.knownFailures.length > 0 && <div className="stack">
          <h4>Bekannte Fehler – dokumentiert, blockieren die Freigabe nicht ({d.knownFailures.length})</h4>
          <div className="table-wrap" style={{ maxHeight: 360 }}><table><tbody>
            {d.knownFailures.map((p) => (
              <tr key={p.id} className="clickable" onClick={() => { window.location.hash = href(['p', projectKey, 'cycles', p.cycleId], { exec: p.id }); }}>
                <td className="fit mono small"><a href={href(['p', projectKey, 'cycles', p.cycleId], { exec: p.id })} onClick={(e) => e.stopPropagation()}>{p.key}</a></td><td>{p.title}<div className="small muted">{p.cycleName}</div></td>
                <td className="fit"><StatusBadge code={p.status} statuses={statuses} /></td>
                <td className="small">{p.defects.map((x) => x.key).join(', ') || '–'}</td>
              </tr>
            ))}
          </tbody></table></div>
        </div>}
        <div className="stack">
          <h4>Geändert, aber nicht erneut getestet ({d.changedNotTested.length})</h4>
          <div className="table-wrap" style={{ maxHeight: 360 }}><table><tbody>
            {d.changedNotTested.length === 0 && <tr><td className="empty">Keine – alle ausgeführten Testfälle sind aktuell.</td></tr>}
            {d.changedNotTested.map((x) => (
              <tr key={x.key}>
                <td className="fit mono small"><a href={href(['p', projectKey, 'repo'], { tc: x.key })}>{x.key}</a></td>
                <td>{x.title}<div className="small muted">{x.changeNote ?? 'ohne Änderungsnotiz'} · {x.changedBy}, {fmtDate(x.changedAt)}</div></td>
                <td className="fit small">v{x.testedVersion} → v{x.currentVersion}</td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
      </div>
    </div>
  );
}

function Kpi({ value, label, bad }: { value: string | number; label: string; bad?: boolean }) {
  return <div className="card kpi"><div style={{ fontSize: 22, fontWeight: 650 }} className={bad ? 'rate-bad' : ''}>{value}</div><div className="small muted">{label}</div></div>;
}

/**
 * Gestapelte Tagesbalken (bestanden/fehlgeschlagen/sonstige) plus kumulierte Linie – ohne Diagrammbibliothek.
 * Legende, Schraffur für „fehlgeschlagen/blockiert“ und eine ausklappbare Datentabelle machen die Aussage
 * auch ohne Farbunterscheidung und für Screenreader zugänglich.
 */
function Burn({ data }: { data: CockpitData['burn'] }) {
  if (!data.length) return <div className="muted small">Noch keine Ausführungen.</div>;
  const W = 900, H = 180, P = 28;
  const max = Math.max(...data.map((d) => d.passed + d.failed + d.other));
  const total = data.reduce((a, d) => a + d.passed + d.failed + d.other, 0);
  const sum = data.reduce((a, d) => ({ passed: a.passed + d.passed, failed: a.failed + d.failed, other: a.other + d.other }), { passed: 0, failed: 0, other: 0 });
  const bw = Math.max(2, Math.min(24, (W - 2 * P) / data.length - 2));
  const x = (i: number) => P + (i + 0.5) * ((W - 2 * P) / data.length);
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  let cum = 0;
  const line = data.map((d, i) => { cum += d.passed + d.failed + d.other; return `${x(i)},${H - P - (cum / total) * (H - 2 * P)}`; }).join(' ');
  const step = Math.ceil(data.length / 8);
  const day = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
  const summary = `Ausführungen je Tag vom ${day(data[0]!.day)} bis ${day(data.at(-1)!.day)}: insgesamt ${total}, davon ${sum.passed} bestanden, ${sum.failed} fehlgeschlagen oder blockiert, ${sum.other} sonstige; höchstens ${max} an einem Tag.`;
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img" aria-label={summary}>
        <defs>
          <pattern id="burn-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--danger)" /><line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,.55)" strokeWidth="2" />
          </pattern>
        </defs>
        {data.map((d, i) => {
          const parts = [[d.passed, 'var(--ok)'], [d.failed, 'url(#burn-hatch)'], [d.other, 'var(--muted)']] as const;
          let base = 0;
          return <g key={d.day}><title>{`${day(d.day)}: ${d.passed} bestanden, ${d.failed} fehlgeschlagen/blockiert, ${d.other} sonstige`}</title>
            {parts.map(([v, col], k) => { const y0 = y(base); base += v; return v ? <rect key={k} x={x(i) - bw / 2} y={y(base)} width={bw} height={y0 - y(base)} fill={col} opacity={0.85} /> : null; })}
            {i % step === 0 && <text x={x(i)} y={H - 8} fontSize="12" textAnchor="middle" fill="currentColor" opacity={0.7}>{day(d.day)}</text>}
          </g>;
        })}
        {/* Werteachse: 0 und Höchstwert je Tag */}
        <line x1={P} y1={y(0)} x2={P} y2={y(max)} stroke="currentColor" opacity={0.3} />
        <text x={P - 4} y={y(0) + 4} fontSize="12" textAnchor="end" fill="currentColor" opacity={0.7}>0</text>
        <text x={P - 4} y={y(max) + 4} fontSize="12" textAnchor="end" fill="currentColor" opacity={0.7}>{max}</text>
        <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth={2} />
        <text x={W - P} y={14} fontSize="12" textAnchor="end" fill="var(--accent)">kumuliert {total}</text>
        <text x={P + 4} y={14} fontSize="12" fill="currentColor" opacity={0.7}>max. {max}/Tag</text>
      </svg>
      <Legend title="Legende Verlauf der Ausführungen" items={[
        { label: 'bestanden', color: 'var(--ok)', value: sum.passed },
        { label: 'fehlgeschlagen/blockiert', color: 'var(--danger)', value: sum.failed, shape: 'hatched' },
        { label: 'sonstige', color: 'var(--muted)', value: sum.other },
        { label: 'kumuliert (Linie)', color: 'var(--accent)', value: total, shape: 'line' },
      ]} />
      <details className="chart-data small"><summary>Werte als Tabelle</summary>
        <div className="table-wrap" style={{ maxHeight: 260 }} tabIndex={0} role="region" aria-label="Verlauf der Ausführungen als Tabelle"><table>
          <thead><tr><th>Tag</th><th>bestanden</th><th>fehlgeschlagen/blockiert</th><th>sonstige</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.day}><td>{day(d.day)}</td><td>{d.passed}</td><td>{d.failed}</td><td>{d.other}</td></tr>)}</tbody>
        </table></div>
      </details>
    </>
  );
}

/** Fazit bearbeiten; mit KI als Entwurf aus Kennzahlen, Abdeckung und Fehlern (wird erst nach Prüfung gespeichert). */
function AssessmentDialog({ planId, initial, initialAi, ai, autoDraft, onClose, onSaved }: {
  planId: string; initial: string; initialAi: string | null; ai: boolean; autoDraft: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const draft = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ text: string; model: string }>('POST', `/api/plans/${planId}/assist/assessment`);
      setText(r.text);
      setModel(r.model);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const dirty = text !== initial;
  useUnsavedGuard(dirty, `assessment-${planId}`);
  const close = async () => {
    if (dirty && !(await askConfirm({ title: 'Fazit nicht gespeichert', message: model ? 'Der KI-Entwurf und Ihre Änderungen gehen beim Schließen verloren.' : 'Die Änderungen am Fazit gehen beim Schließen verloren.', confirmLabel: 'Verwerfen', danger: true }))) return;
    onClose();
  };
  // Ohne vorhandenes Fazit entsteht der KI-Entwurf beim Öffnen direkt (U12)
  useEffect(() => { if (autoDraft) void draft(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    try {
      // KI-Vermerk bleibt, solange das Fazit auf einem KI-Entwurf beruht (auch nach Überarbeitung)
      await api('PUT', `/api/plans/${planId}/assessment`, { assessment: text.trim() || null, aiModel: model ?? initialAi });
      toast('Fazit gespeichert – erscheint im Testabschlussbericht');
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal size="large" title="Fazit des Testmanagements" onClose={() => void close()}
      footer={<>{ai && <button onClick={draft} disabled={busy}>{busy ? 'Entwurf entsteht …' : text.trim() ? '✨ Neu entwerfen' : '✨ Entwurf erzeugen'}</button>}<span className="spacer" />
        <button onClick={() => void close()}>Abbrechen</button><button className="primary" onClick={save}>Speichern</button></>}>
      <ErrorNote error={error} />
      {model && <div className="notice info small"><span aria-hidden="true">✨ </span>Entwurf von {model} aus Kennzahlen, Abdeckung, Fehlern und Testplan-Zielen – bitte prüfen und anpassen. Die Freigabeentscheidung treffen Verantwortliche im Cockpit.</div>}
      <div className="field">Bewertung, Restrisiken, Empfehlung
        <WikiEditor label="Fazit" value={text} onChange={setText} minRows={14} placeholder="Bewertung des Teststands, Restrisiken, Empfehlung mit Bedingungen" />
      </div>
    </Modal>
  );
}

/** Festgehaltene Freigabeentscheidung (Mensch) – getrennt von der regelbasierten Empfehlung. */
function ReleaseDecisionBox({ planId, decision, canEdit, onEdit, onBaseline }: {
  planId: string; decision: CockpitData['releaseDecision']; canEdit: boolean; onEdit: () => void; onBaseline: () => void;
}) {
  const pending = !!decision && decision.baseline?.status !== 'ready';
  // Freigabestand anstoßen bzw. nachholen (der Abruf legt fehlende Stände an), danach Cockpit neu laden
  useEffect(() => {
    if (!pending) return;
    let stop = false;
    void api('GET', `/api/plans/${planId}/baselines`).then(() => { if (!stop) onBaseline(); }, () => undefined);
    return () => { stop = true; };
  }, [pending, planId, decision?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!decision) {
    return canEdit ? <div className="row"><span className="muted small">Noch keine Freigabeentscheidung festgehalten.</span><span className="spacer" />
      <button className="primary" onClick={onEdit}>Freigabe entscheiden …</button></div> : null;
  }
  const [label, tone] = DECISION[decision.decision];
  return (
    <div className={`notice ${tone}`}>
      <div className="row"><strong style={{ flex: 1 }}>Entscheidung: {label}</strong>
        {canEdit && <button className="small" onClick={onEdit}>Ändern …</button>}</div>
      {decision.note && <div style={{ whiteSpace: 'pre-wrap' }}>{decision.note}</div>}
      <div className="small muted">{decision.by}{decision.at ? `, ${fmtDate(decision.at)}` : ''}</div>
      {decision.baseline?.status === 'ready' && decision.baseline.sha256
        ? <div className="small">Freigabestand: <a href={`/api/plans/${planId}/baselines/${decision.baseline.id}/download`} download>⇩ Lieferpaket zur Entscheidung</a>{' '}
          <span className="muted mono" title="SHA-256 des abgelegten Lieferpakets">SHA-256 {decision.baseline.sha256.slice(0, 16)}…</span></div>
        : <div className="small muted">Freigabestand (Lieferpaket zur Entscheidung) wird abgelegt …</div>}
      {decision.changesSince > 0 && <div className="small" role="status"><b>Nach der Entscheidung geändert:</b> {decision.changesSince} Änderungen an Ergebnissen, Zyklen oder Kriterien – maßgeblich ist der abgelegte Freigabestand. Bei wesentlichen Änderungen neu entscheiden.</div>}
    </div>
  );
}

function DecisionDialog({ planId, recommendation, current, onClose, onSaved }: {
  planId: string; recommendation: string; current: CockpitData['releaseDecision']; onClose: () => void; onSaved: () => void;
}) {
  const [decision, setDecision] = useState<Decision>(current?.decision ?? 'released');
  const [note, setNote] = useState(current?.note ?? '');
  const [error, setError] = useState<unknown>(null);
  const dirty = decision !== (current?.decision ?? 'released') || note !== (current?.note ?? '');
  useUnsavedGuard(dirty, `decision-${planId}`);
  const close = async () => {
    if (dirty && !(await askConfirm({ title: 'Entscheidung nicht festgehalten', message: 'Die Eingaben zur Freigabeentscheidung gehen beim Schließen verloren.', confirmLabel: 'Verwerfen', danger: true }))) return;
    onClose();
  };
  /** Zurücknehmen nur mit Begründung – sie bleibt im Ereignisverlauf erhalten */
  const revoke = async () => {
    const reason = await askText({ title: 'Freigabeentscheidung zurücknehmen', label: 'Begründung der Rücknahme (Pflicht)', multiline: true, confirmLabel: 'Zurücknehmen',
      hint: `Die festgehaltene Entscheidung „${current ? DECISION[current.decision][0] : ''}“ samt Begründung gilt danach nicht mehr. Die Rücknahme wird mit Ihrer Begründung im Verlauf protokolliert.` });
    if (reason === null) return;
    if (reason.trim().length < 3) { toast('Bitte die Rücknahme begründen', 'bad'); return; }
    await save(null, reason.trim());
  };
  const save = async (value: Decision | null, revokeNote?: string) => {
    try {
      await api('PUT', `/api/plans/${planId}/release-decision`, { decision: value, note: value ? note : revokeNote ?? null });
      toast(value ? `Freigabeentscheidung festgehalten: ${DECISION[value][0]}` : 'Freigabeentscheidung zurückgenommen');
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal title="Freigabeentscheidung" help="cockpit" onClose={() => void close()}
      footer={<>{current && <button className="ghost danger" onClick={() => void revoke()}>Zurücknehmen …</button>}<span className="spacer" />
        <button onClick={() => void close()}>Abbrechen</button><button className="primary" onClick={() => save(decision)} disabled={note.trim().length < 3}
          title={note.trim().length < 3 ? 'Bitte die Entscheidung begründen (mindestens 3 Zeichen)' : undefined}>Entscheidung festhalten</button></>}>
      <ErrorNote error={error} />
      <p className="small muted">Empfehlung aus den Regeln: <b>{recommendation}</b>. Die Entscheidung wird mit Name und Zeitpunkt im Abschlussbericht und im Lieferpaket dokumentiert.</p>
      <fieldset className="plain-fieldset"><legend className="small">Entscheidung</legend>
        <div className="row">
          {(Object.keys(DECISION) as Decision[]).map((k) => (
            <label key={k} className="row small"><input type="radio" name="decision" value={k} checked={decision === k} onChange={() => setDecision(k)} style={{ width: 'auto' }} /> {DECISION[k][0]}</label>
          ))}
        </div>
      </fieldset>
      <label className="field">Begründung, Auflagen, akzeptierte Restrisiken (Pflicht)
        <textarea rows={5} value={note} onChange={(e) => setNote(e.target.value)} placeholder="z. B. Freigabe mit der Auflage, dass PROJ-123 bis zum Hotfix behoben wird" />
      </label>
    </Modal>
  );
}

/** Stand je Konfiguration (z. B. Gerät iPad/iPhone) und welche Testfälle wo fehlschlagen. */
function ByConfiguration({ d, statuses }: { d: CockpitData['byConfiguration']; statuses: ExecutionStatus[] }) {
  return (
    <div className="card"><div className="card-body stack">
      <h4>Stand je Konfiguration</h4>
      <div className="table-wrap"><table>
        <thead><tr><th>Konfiguration</th><th className="fit">Testfälle</th><th style={{ width: 200 }}>Ergebnisse</th><th className="fit">Bestanden</th><th className="fit">Fehlgeschlagen</th></tr></thead>
        <tbody>{d.configurations.map((c) => (
          <tr key={c.key}>
            <td>{c.label}</td><td className="fit small">{c.summary.testCases}</td>
            <td><Progress byStatus={toRecord(c.summary)} statuses={statuses} total={c.summary.total} /></td>
            <td className="fit small">{c.summary.passRate === null ? '–' : `${c.summary.passRate} %`}</td>
            <td className={`fit small${c.summary.failed ? ' rate-bad' : ''}`}>{c.summary.failed}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {d.matrix.length > 0 && <>
        <h4>Fehlgeschlagen je Konfiguration ({d.matrix.length})</h4>
        <p className="small muted">Leere Zelle: in dieser Konfiguration nicht eingeplant.</p>
        <div className="table-wrap" style={{ maxHeight: 360 }}><table>
          <thead><tr><th className="fit">Testfall</th><th>Titel</th>{d.configurations.map((c) => <th key={c.key} className="fit wrap small">{c.label}</th>)}</tr></thead>
          <tbody>{d.matrix.map((m) => (
            <tr key={m.key}>
              <td className="fit mono small">{m.key}</td><td className="small">{m.title}</td>
              {d.configurations.map((c) => <td key={c.key} className="fit">{m.cells[c.key] ? <StatusBadge code={m.cells[c.key]!} statuses={statuses} /> : ''}</td>)}
            </tr>
          ))}</tbody>
        </table></div>
      </>}
    </div></div>
  );
}

function CriteriaDialog({ planId, initial, onClose, onSaved }: { planId: string; initial: ExitCriteria; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<ExitCriteria>(initial);
  const [error, setError] = useState<unknown>(null);
  const num = (k: 'minPassRate' | 'minExecutionRate' | 'maxOpenDefects' | 'maxFailed' | 'maxKnownFailures', label: string, suffix: string) => (
    <label className="field">{label}
      <div className="row"><input type="number" min={0} max={suffix === '%' ? 100 : undefined} style={{ width: 110 }} value={v[k] ?? ''}
        onChange={(e) => setV({ ...v, [k]: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="–" aria-label={label} /> <span className="muted small">{suffix}</span></div>
    </label>
  );
  const save = async () => {
    try {
      await api('PUT', `/api/plans/${planId}/exit-criteria`, v);
      toast('Ausstiegskriterien gespeichert');
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal title="Ausstiegskriterien" help="cockpit" onClose={onClose} footer={<><span className="spacer" /><button onClick={onClose}>Abbrechen</button><button className="primary" onClick={save}>Speichern</button></>}>
      <ErrorNote error={error} />
      <p className="small muted">Leere Felder gelten nicht. Die Kriterien fließen in die Freigabeempfehlung und den Testabschlussbericht ein.</p>
      <div className="grid2">
        {num('minPassRate', 'Bestehensquote mindestens', '%')}
        {num('minExecutionRate', 'Durchführungsgrad mindestens', '%')}
        {num('maxOpenDefects', 'Offene Fehler höchstens', 'Anzahl')}
        {num('maxFailed', 'Fehlgeschlagene/blockierte Testfälle höchstens', 'Anzahl')}
        {num('maxKnownFailures', 'Bekannte Fehler (dokumentiert) höchstens', 'Anzahl')}
      </div>
      <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={!!v.fullCoverage} onChange={(e) => setV({ ...v, fullCoverage: e.target.checked })} /> Alle verknüpften Anforderungen bestanden</label>
      <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={!!v.noUntestedChanges} onChange={(e) => setV({ ...v, noUntestedChanges: e.target.checked })} /> Keine geänderten, nicht erneut getesteten Testfälle</label>
    </Modal>
  );
}

const isoDay = (d: Date) => d.toLocaleDateString('sv-SE');

/** Teststatusbericht öffnen: Berichtszeitraum (letzte 7/14/30 Tage oder seit Datum), als HTML, PDF oder Markdown. */
function StatusReportLinks({ planId }: { planId: string }) {
  const [range, setRange] = useState('7');
  const [since, setSince] = useState('');
  const to = isoDay(new Date());
  const from = range === 'since' ? since : isoDay(new Date(Date.now() - (Number(range) - 1) * 86_400_000));
  const link = (extra = '') => `/api/reports/status/${planId}?${from ? `from=${from}&` : ''}to=${to}${extra}`;
  const invalid = range === 'since' && (!since || since > to);
  return (
    <div className="row small status-report-links">
      <strong>Teststatusbericht öffnen</strong>
      <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Berichtszeitraum">
        <option value="7">letzte 7 Tage</option><option value="14">letzte 14 Tage</option><option value="30">letzte 30 Tage</option><option value="since">seit Datum …</option>
      </select>
      {range === 'since' && <input type="date" value={since} max={to} onChange={(e) => setSince(e.target.value)} aria-label="Bericht seit" style={{ width: 'auto' }} />}
      {invalid ? <span className="muted">Beginn wählen</span> : <>
        <a className="btn small" href={link()} target="_blank" rel="noreferrer" title="Im Browser öffnen (druckbar)">HTML</a>
        <a className="btn small" href={link('&format=pdf&download=true')} download>PDF</a>
        <a className="btn small" href={link('&format=md&download=true')} download>MD</a>
      </>}
    </div>
  );
}

/** Lagebild des Testmanagements: Einschätzung, Hindernisse, nächste Schritte – erscheint im Teststatusbericht. */
function StatusNoteDialog({ planId, initial, onClose, onSaved }: { planId: string; initial: string; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  const dirty = text !== initial;
  useUnsavedGuard(dirty, `status-note-${planId}`);
  const close = async () => {
    if (dirty && !(await askConfirm({ title: 'Lagebild nicht gespeichert', message: 'Die Änderungen am Lagebild gehen beim Schließen verloren.', confirmLabel: 'Verwerfen', danger: true }))) return;
    onClose();
  };
  const save = async () => {
    try {
      await api('PUT', `/api/plans/${planId}/status-note`, { text: text.trim() || null });
      toast(text.trim() ? 'Lagebild gespeichert – erscheint im Teststatusbericht' : 'Lagebild entfernt');
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal size="large" title="Lagebild (Zwischenbericht)" onClose={() => void close()}
      footer={<><span className="spacer" /><button onClick={() => void close()}>Abbrechen</button><button className="primary" onClick={save}>Speichern</button></>}>
      <ErrorNote error={error} />
      <div className="field">Einschätzung, Hindernisse, nächste Schritte
        <WikiEditor value={text} onChange={setText} minRows={8} label="Einschätzung, Hindernisse, nächste Schritte"
          placeholder="z. B. Testumgebung ab Mittwoch wieder verfügbar; PROJ-123 blockiert 4 Tests; nächste Schritte: Nachtest Build 2.1" />
      </div>
      <div className="small muted">Erscheint im Teststatusbericht mit Datum und Namen. Leeres Feld entfernt das Lagebild.</div>
    </Modal>
  );
}
