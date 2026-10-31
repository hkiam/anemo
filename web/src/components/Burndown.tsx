import { useApi } from '../api.ts';
import type { Burndown } from '../types.ts';

const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;

/** Satz zum Stand: „3 offen · Tempo 1,5 je Tag · Prognose fertig am 14.10. – im Plan“. */
export function burndownSentence(b: Burndown): string {
  const parts = [`${b.remaining} offen`, `Tempo ${b.velocity.toLocaleString('de-DE')} erledigte je Arbeitstag (Mittel der letzten 10 Arbeitstage)`];
  if (b.forecast) {
    parts.push(`Prognose fertig am ${dm(b.forecast)}${b.onTrack === true ? ' – im Plan' : b.onTrack === false ? ` – ${b.daysLate ?? '?'} ${b.daysLate === 1 ? 'Arbeitstag' : 'Arbeitstage'} nach Plan` : ''}`);
  } else if (b.remaining > 0) parts.push('keine Prognose (noch kein Fortschritt)');
  return parts.join(' · ');
}

/**
 * Burn-down des Testplans: offene Ausführungen je Tag (Linie), Ideallinie bis zum geplanten Ende (gestrichelt) und eine
 * senkrechte Linie am geplanten Ende. Datumsbeschriftung als HTML unter der Grafik (lesbare Schriftgröße auch schmal).
 */
export function BurndownChart({ planId }: { planId: string }) {
  const r = useApi<Burndown>(`/api/plans/${planId}/burndown`);
  if (r.error) return <div className="small err">{r.error.message}</div>;
  if (!r.data) return <div className="muted small">Lädt …</div>;
  const b = r.data;
  if (!b.points.length) return <div className="small muted">Noch keine Ausführungen eingeplant.</div>;
  // links Platz für die Werteachse (0 und Höchstwert)
  const W = 900, H = 170, P = 10, PL = 40;
  const n = b.points.length;
  const max = Math.max(1, ...b.points.map((p) => Math.max(p.total, p.remaining ?? 0, p.ideal ?? 0)));
  const x = (i: number) => PL + (n === 1 ? (W - PL - P) / 2 : (i * (W - PL - P)) / (n - 1));
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  const actual = b.points.map((p, i) => (p.remaining === null ? null : `${x(i)},${y(p.remaining)}`)).filter(Boolean).join(' ');
  const ideal = b.points.map((p, i) => (p.ideal === null ? null : `${x(i)},${y(p.ideal)}`)).filter(Boolean).join(' ');
  const endIdx = b.end ? b.points.findIndex((p) => p.day === b.end) : -1;
  const today = new Date().toLocaleDateString('sv-SE');
  const todayIdx = b.points.findIndex((p) => p.day === today);
  const every = Math.max(1, Math.ceil(n / 7));
  return (
    <div className="stack burndown" style={{ gap: 4 }}>
      {!b.end && <div className="notice info small">Zyklen ohne Enddatum – Ende im Zyklus festlegen, dann erscheinen Ideallinie und Prognose gegen den Plan.</div>}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto' }} role="img"
        aria-label={`Burn-down: ${burndownSentence(b)}${b.end ? `, geplantes Ende ${dm(b.end)}` : ''}`}>
        <line x1={PL} x2={W - P} y1={H - P} y2={H - P} stroke="var(--border)" />
        <line x1={PL} x2={PL} y1={P} y2={H - P} stroke="var(--border)" />
        <line x1={PL} x2={W - P} y1={y(max)} y2={y(max)} stroke="var(--border)" strokeDasharray="2 6" />
        <text x={PL - 6} y={y(0) + 4} fontSize="12" textAnchor="end" fill="currentColor" opacity={0.7}>0</text>
        <text x={PL - 6} y={y(max) + 4} fontSize="12" textAnchor="end" fill="currentColor" opacity={0.7}>{max}</text>
        {todayIdx >= 0 && <line x1={x(todayIdx)} x2={x(todayIdx)} y1={P} y2={H - P} stroke="var(--muted)" strokeDasharray="2 4" opacity={0.6}><title>heute</title></line>}
        {endIdx >= 0 && <line x1={x(endIdx)} x2={x(endIdx)} y1={P} y2={H - P} stroke="var(--danger)" strokeWidth={1.5}><title>{`geplantes Ende ${dm(b.end!)}`}</title></line>}
        {ideal && <polyline points={ideal} fill="none" stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="6 5" />}
        {actual && <polyline points={actual} fill="none" stroke="var(--accent)" strokeWidth={2.5} />}
        {b.points.map((p, i) => p.remaining !== null && <circle key={p.day} cx={x(i)} cy={y(p.remaining)} r={n > 60 ? 0 : 2.5} fill="var(--accent)">
          <title>{`${dm(p.day)}: ${p.remaining} offen von ${p.total}${p.ideal !== null ? ` (ideal ${p.ideal.toLocaleString('de-DE')})` : ''}`}</title></circle>)}
      </svg>
      <div className="cov-axis small muted" style={{ padding: `0 ${(100 * P) / W}% 0 ${(100 * PL) / W}%` }} aria-hidden="true">
        {b.points.map((p, i) => <span key={p.day} className={i === endIdx ? 'burn-end' : ''}>{i === endIdx ? `Ende ${dm(p.day)}` : i % every === 0 && Math.abs(i - endIdx) >= every / 2 ? dm(p.day) : ''}</span>)}
      </div>
      <div className="row small burn-legend">
        <span className="row" style={{ gap: 4 }}><span className="burn-key" style={{ background: 'var(--accent)' }} />offene Ausführungen</span>
        {b.end && <span className="row" style={{ gap: 4 }}><span className="burn-key dashed" />Ideallinie</span>}
        {b.end && <span className="row" style={{ gap: 4 }}><span className="burn-key" style={{ background: 'var(--danger)', width: 3, height: 12 }} />geplantes Ende</span>}
      </div>
      <div className={b.onTrack === false ? 'rate-bad' : b.onTrack ? 'rate-ok' : ''} data-testid="burndown-sentence">{burndownSentence(b)}</div>
      <details className="chart-data small"><summary>Werte als Tabelle</summary>
        <div className="table-wrap" style={{ maxHeight: 260 }} tabIndex={0} role="region" aria-label="Burn-down als Tabelle"><table>
          <thead><tr><th>Tag</th><th>offen</th><th>eingeplant</th><th>ideal</th></tr></thead>
          <tbody>{b.points.filter((p) => p.remaining !== null || p.ideal !== null).map((p) => <tr key={p.day}><td>{dm(p.day)}{p.day === b.end ? ' (Ende)' : ''}</td><td>{p.remaining ?? '–'}</td><td>{p.total}</td><td>{p.ideal === null ? '–' : p.ideal.toLocaleString('de-DE')}</td></tr>)}</tbody>
        </table></div>
      </details>
    </div>
  );
}
