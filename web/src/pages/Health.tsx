import { useState } from 'react';
import { api, fmtDay, useApi } from '../api.ts';
import { ErrorNote, TestCaseStatusBadge, useWorkflow } from '../components/common.tsx';
import { href, navigate, type Route } from '../router.ts';
import { useCan } from '../session.tsx';
import { askText } from '../ux.tsx';

interface Item { key: string; title: string; status: string; detail: string; lastExecutedAt: string | null }
interface Check { id: string; title: string; description: string; severity: 'info' | 'warn' | 'bad'; count: number; items: Item[] }

const SUGGESTED_LABEL: Record<string, string> = {
  alwaysPass: 'automatisierung-kandidat', flaky: 'wackelnd', noExpected: 'pflege-erwartung', remarks: 'fachlich-klaeren',
  duplicates: 'duplikat-pruefen', legacy: 'altlast', stale: 'pruefen-aktualitaet', never: 'nie-ausgefuehrt', blocked: 'haeufig-blockiert',
};

/** Test-Health je Projekt: regelbasierte Pflege-Warteschlangen (Roadmap E). */
export function Health({ projectKey, route }: { projectKey: string; route: Route }) {
  const h = useApi<{ total: number; checks: Check[] }>(`/api/projects/${projectKey}/health`);
  const workflow = useWorkflow();
  const canEdit = useCan(projectKey, 'edit');
  const active = route.query.get('check') ?? h.data?.checks.find((c) => c.count)?.id ?? 'never';
  const check = h.data?.checks.find((c) => c.id === active);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  async function label() {
    const l = await askText({ title: `${sel.size} Testfälle markieren`, label: 'Label', initial: SUGGESTED_LABEL[active] ?? 'pflege', hint: 'Danach in der Testfallliste über das Label filterbar.', confirmLabel: 'Label setzen' });
    if (!l?.trim()) return;
    try {
      const r = await api<{ updated: number }>('POST', '/api/test-cases/bulk', { ids: [...sel], addLabels: [l.trim()] });
      setDone(`Label „${l.trim()}“ an ${r.updated} Testfällen gesetzt – in der Testfallliste über das Label filterbar.`);
      setSel(new Set());
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="planning">
      <div className="pane" style={{ borderRight: '1px solid var(--border)', overflow: 'auto' }}>
        <h3>Test-Health</h3>
        <p className="small muted">{h.data ? `${h.data.total.toLocaleString('de-DE')} Testfälle geprüft` : 'Lädt …'}</p>
        <div className="stack" style={{ gap: 2 }}>
          {h.data?.checks.map((c) => (
            <a key={c.id} className={`plan-item ${c.id === active ? 'active' : ''}`} href={href(['p', projectKey, 'health'], { check: c.id })} onClick={() => setSel(new Set())} title={c.description}>
              <div className="row"><strong>{c.title}</strong><span className="spacer" />
                <span className={`badge ${c.count === 0 ? 'ok' : c.severity === 'bad' ? 'bad' : c.severity === 'warn' ? 'warn' : 'neutral'}`}>{c.count}</span></div>
              {c.id === active && <span className="small muted">{c.description}</span>}
            </a>
          ))}
          <div className="small muted" style={{ margin: '10px 0 2px', textTransform: 'uppercase', letterSpacing: '.04em' }}>Analysen</div>
          {ANALYSES.map(([id, title, desc]) => (
            <a key={id} className={`plan-item ${active === id ? 'active' : ''}`} href={href(['p', projectKey, 'health'], { check: id })} title={desc}>
              <strong>{title}</strong>{active === id && <span className="small muted">{desc}</span>}
            </a>
          ))}
        </div>
      </div>
      {ANALYSES.some(([id]) => id === active) ? <div className="pane stack" style={{ overflow: 'auto', padding: 16 }}><Analysis key={`${projectKey}:${active}`} projectKey={projectKey} id={active} /></div> :
      <div className="pane stack" style={{ overflow: 'auto', padding: 16 }}>
        <ErrorNote error={error ?? h.error} />
        {done && <div className="notice ok">{done}</div>}
        {check && <>
          <div className="row"><h2>{check.title}</h2><span className="muted small">{check.count} Testfälle{check.count > check.items.length ? `, die ersten ${check.items.length} angezeigt` : ''}</span>
            <span className="spacer" />
            {canEdit && sel.size > 0 && <button className="primary" onClick={label}>Label vergeben ({sel.size})</button>}
          </div>
          <p className="small muted">{check.description}</p>
          <div className="table-wrap"><table>
            <thead><tr>
              {canEdit && <th className="fit"><input type="checkbox" style={{ width: 'auto' }} aria-label="alle auswählen" checked={sel.size > 0 && sel.size === check.items.length}
                onChange={(e) => setSel(e.target.checked ? new Set(check.items.map((i) => i.key)) : new Set())} /></th>}
              <th className="fit">Testfall</th><th>Titel</th><th className="fit">Status</th><th>Befund</th><th className="fit">zuletzt ausgeführt</th>
            </tr></thead>
            <tbody>
              {check.items.length === 0 && <tr><td colSpan={6} className="empty">Nichts zu tun. ✓</td></tr>}
              {check.items.map((i) => (
                <tr key={i.key} className="clickable" onClick={() => navigate(['p', projectKey, 'repo'], { tc: i.key })}>
                  {canEdit && <td className="fit" onClick={(e) => e.stopPropagation()}><input type="checkbox" style={{ width: 'auto' }} aria-label={i.key} checked={sel.has(i.key)}
                    onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(i.key); else n.delete(i.key); return n; })} /></td>}
                  <td className="fit mono small">{i.key}</td><td>{i.title}</td>
                  <td className="fit"><TestCaseStatusBadge code={i.status} workflow={workflow} /></td>
                  <td className="small">{i.detail}</td><td className="fit small">{fmtDay(i.lastExecutedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </>}
      </div>}
    </div>
  );
}

const ANALYSES: [string, string, string][] = [
  ['similar', 'Ähnliche Testfälle', 'Duplikatkandidaten nach Titel und Inhalt'],
  ['clusters', 'Fehlerursachen', 'Fehlschläge mit ähnlichem Befund bzw. gleichem Fehler gruppiert'],
  ['coverage', 'Anforderungsabdeckung', 'Verknüpfte Anforderungen × letzte Ergebnisse'],
];

// Je Analyse eine eigene Instanz (key): useApi behält beim Adresswechsel die alten Daten bis zur neuen Antwort – die
// nächste Analyse würde sonst kurz die Daten der vorigen mit anderem Aufbau zeichnen und abstürzen
function Analysis({ projectKey, id }: { projectKey: string; id: string }) {
  const [min, setMin] = useState(0.6);
  const [days, setDays] = useState(180);
  const [summarize, setSummarize] = useState(false);
  const assist = useApi<{ llm: { model: string } | null }>('/api/assist/status');
  const path = id === 'similar' ? `/api/projects/${projectKey}/assist/similar?min=${min}`
    : id === 'clusters' ? `/api/projects/${projectKey}/assist/clusters?days=${days}${summarize ? '&summarize=true' : ''}` : `/api/projects/${projectKey}/assist/coverage`;
  const data = useApi<any[]>(path);
  const tc = (k: string) => <a key={k} href={href(['p', projectKey, 'repo'], { tc: k })} className="mono small">{k}</a>;
  const STATE: Record<string, [string, string]> = { failing: ['fehlgeschlagen', 'bad'], passed: ['bestanden', 'ok'], partial: ['teilweise', 'warn'], untested: ['ungetestet', 'neutral'] };
  return (
    <>
      <ErrorNote error={data.error} />
      {id === 'similar' && <>
        <div className="row"><h2>Ähnliche Testfälle</h2><span className="spacer" />
          <label className="row small">Mindestähnlichkeit <input type="range" min={0.4} max={0.95} step={0.05} value={min} onChange={(e) => setMin(Number(e.target.value))} style={{ width: 140 }} /> {Math.round(min * 100)} %</label></div>
        <p className="small muted">Titel (40 %) und Inhalt (60 %) per Zeichen-Trigrammen verglichen. Kandidaten prüfen, zusammenführen oder als veraltet kennzeichnen.</p>
        <div className="table-wrap"><table><thead><tr><th className="fit">Ähnlichkeit</th><th>Testfall A</th><th>Testfall B</th></tr></thead><tbody>
          {data.data?.length === 0 && <tr><td colSpan={3} className="empty">Keine Kandidaten über der Schwelle.</td></tr>}
          {data.data?.map((p, i) => <tr key={i}><td className="fit"><strong>{Math.round(p.score * 100)} %</strong><div className="small muted">Titel {Math.round(p.title * 100)} · Inhalt {Math.round(p.content * 100)}</div></td>
            <td>{tc(p.a)} {p.aTitle}</td><td>{tc(p.b)} {p.bTitle}</td></tr>)}
        </tbody></table></div>
      </>}
      {id === 'clusters' && <>
        <div className="row"><h2>Fehlerursachen-Cluster</h2><span className="spacer" />
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }} aria-label="Zeitraum">
            <option value={30}>30 Tage</option><option value={180}>6 Monate</option><option value={365}>1 Jahr</option><option value={3650}>alles</option></select>
          {assist.data?.llm && <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={summarize} onChange={(e) => setSummarize(e.target.checked)} />KI-Zusammenfassung</label>}
        </div>
        <p className="small muted">Fehlschläge mit ähnlichem Befund (Zahlen, Kennungen, Pfade und häufige Umgebungsangaben ausgeblendet) oder gleichem verknüpften Fehler.</p>
        {data.loading && <div className="muted">Analysiert …</div>}
        {data.data?.length === 0 && <div className="empty">Keine wiederkehrenden Fehlerbilder.</div>}
        {data.data?.map((c, i) => (
          <div key={i} className="card"><div className="card-body stack" style={{ gap: 6 }}>
            <div className="row"><strong>{c.label || 'gleicher Fehler'}</strong><span className="badge bad">{c.size} Fehlschläge</span><span className="small muted">{c.testCases.length} Testfälle · {c.defects.length} Fehler</span></div>
            {c.summary && <div className="notice info small">{c.summary}</div>}
            <div className="row small">{c.testCases.slice(0, 15).map(tc)}{c.testCases.length > 15 && <span className="muted">…</span>}</div>
            {c.defects.length > 0 && <div className="small muted">Fehler: {c.defects.slice(0, 12).join(', ')}{c.defects.length > 12 ? ' …' : ''}</div>}
            <details className="small"><summary>Beispielbefunde</summary>{c.samples.map((x: string, k: number) => <div key={k} className="muted" style={{ margin: '4px 0' }}>„{x}“</div>)}</details>
          </div></div>
        ))}
      </>}
      {id === 'coverage' && <>
        <h2>Anforderungsabdeckung</h2>
        <p className="small muted">Anforderungen/Stories/Epics, die mit Testfällen verknüpft sind, und das jeweils letzte Ergebnis dieser Testfälle.</p>
        <div className="stat-chips">{Object.entries(STATE).map(([k, [label]]) => <span key={k} className="chip-btn">{label}: {data.data?.filter((r) => r.state === k).length ?? 0}</span>)}</div>
        <div className="table-wrap"><table><thead><tr><th className="fit">Anforderung</th><th>Titel</th><th className="fit">Ticketstatus</th><th>Testfälle</th><th className="fit">Ergebnis</th></tr></thead><tbody>
          {data.data?.map((r) => <tr key={`${r.provider}:${r.key}`}>
            <td className="fit mono small">{r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener">{r.key}</a> : r.key}</td><td>{r.title ?? '–'}</td>
            <td className="fit small">{r.status ?? '–'}</td><td className="small">{r.tests.slice(0, 6).map(tc)}{r.tests.length > 6 ? ` +${r.tests.length - 6}` : ''}</td>
            <td className="fit"><span className={`badge ${STATE[r.state]![1]}`}>{STATE[r.state]![0]}</span></td></tr>)}
        </tbody></table></div>
      </>}
    </>
  );
}
