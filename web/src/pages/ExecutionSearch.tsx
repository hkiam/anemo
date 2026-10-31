import { useState } from 'react';
import { api, fmtDate, useApi } from '../api.ts';
import { ErrorNote, StatusBadge, useStatuses } from '../components/common.tsx';
import { ExecutionBulkBar, QuickStatus } from '../components/ExecutionBulk.tsx';
import { usePriorities } from '../components/Fields.tsx';
import { AQL_EXAMPLES, QueryInput } from '../components/QueryInput.tsx';
import { href, navigate, type Route } from '../router.ts';
import { useCan } from '../session.tsx';
import type { ExecutionListItem } from '../types.ts';
import { FocusLink, fmtDuration, useSync } from '../ux.tsx';

type Row = ExecutionListItem & { cycleName: string; cycleState: string; planName: string | null; release: string | null; build: string | null; priority: string | null };
const PAGE = 100;

/**
 * Projektweite Ausführungssuche mit der Abfragesprache (wie ZQL in Zephyr): Grundlage für Massenbearbeitung,
 * Schnellausführung und Export. Die Abfrage steht in der URL und lässt sich als Ansicht speichern.
 */
export function ExecutionSearch({ projectKey, route }: { projectKey: string; route: Route }) {
  const aql = route.query.get('aql') ?? '';
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const statuses = useStatuses();
  const priorities = usePriorities();
  const canExecute = useCan(projectKey, 'execute');
  const facets = useApi<{ labels: { value: string }[]; components: { value: string }[] }>(`/api/projects/${projectKey}/test-case-facets`);
  const cfacets = useApi<{ environments: { value: string }[]; builds: { value: string }[] }>(`/api/projects/${projectKey}/cycle-facets`);
  const list = useApi<{ total: number; items: Row[] }>(aql ? `/api/projects/${projectKey}/execution-search?aql=${encodeURIComponent(aql)}&limit=${PAGE}&offset=${page * PAGE}` : null);
  useSync(['execution', 'cycle'], () => list.reload());
  const go = (q: string) => { setPage(0); setSelected(new Set()); navigate(['p', projectKey, 'cycles'], { view: 'search', aql: q || null }); };
  const selectAll = async () => {
    const r = await api<{ total: number; ids: string[] }>('GET', `/api/projects/${projectKey}/execution-search?aql=${encodeURIComponent(aql)}&idsOnly=true&limit=5000`);
    setSelected(new Set(r.ids));
  };
  const items = list.data?.items ?? [];
  return (
    <div className="pane stack" style={{ padding: 16, overflow: 'auto' }}>
      <div className="row"><h2 style={{ flex: 1 }}>Ausführungen suchen</h2>
        {aql && <a className="btn small" href={`/api/projects/${projectKey}/execution-export?format=xlsx&aql=${encodeURIComponent(aql)}`} title="Treffer als Excel-Datei (bis 20 000)">⇩ Excel</a>}
        {aql && <a className="btn small" href={`/api/projects/${projectKey}/execution-export?format=csv&aql=${encodeURIComponent(aql)}`} title="Treffer als CSV (Semikolon, für Excel)">⇩ CSV</a>}
      </div>
      <QueryInput scope="execution" value={aql} onSubmit={go} autoFocus={!aql} values={{
        status: statuses.map((s) => s.name), priorität: priorities.map((p) => p.code), label: facets.data?.labels.map((x) => x.value) ?? [],
        komponente: facets.data?.components.map((x) => x.value) ?? [], umgebung: cfacets.data?.environments.map((x) => x.value) ?? [],
        build: cfacets.data?.builds.map((x) => x.value) ?? [],
      }} />
      {!aql && <div className="card"><div className="card-body stack">
        <div className="small muted">Beispiele – anklicken zum Ausführen:</div>
        <ul className="aql-examples">{AQL_EXAMPLES.execution.map(([q, d]) => (
          <li key={q}><button type="button" className="link mono" onClick={() => go(q)}>{q}</button> <span className="small muted">{d}</span></li>
        ))}</ul>
      </div></div>}
      <ErrorNote error={list.error} />
      {list.data && <div className="row small"><span className="muted">{list.data.total.toLocaleString('de-DE')} Treffer</span></div>}
      <ExecutionBulkBar projectKey={projectKey} selected={selected} statuses={statuses} total={list.data?.total} onSelectAll={selectAll}
        onClear={() => setSelected(new Set())} onDone={() => list.reload()} />
      {list.data && <div className="table-wrap"><table>
        <thead><tr>
          <th style={{ width: 28 }}><input type="checkbox" style={{ width: 'auto' }} aria-label="Alle auf dieser Seite auswählen" checked={!!items.length && items.every((e) => selected.has(e.id))}
            onChange={(ev) => setSelected((s) => { const n = new Set(s); for (const e of items) ev.target.checked ? n.add(e.id) : n.delete(e.id); return n; })} /></th>
          <th>Testfall</th><th>Zyklus</th><th>Status</th><th>Zuständig / ausgeführt</th><th>Fehler</th>
        </tr></thead>
        <tbody>{items.map((e) => (
          <tr key={e.id} className="clickable" onClick={() => navigate(['p', projectKey, 'cycles', e.cycleId], { exec: e.id })}>
            <td onClick={(ev) => ev.stopPropagation()}><input type="checkbox" style={{ width: 'auto' }} checked={selected.has(e.id)} aria-label={`${e.testCaseKey} auswählen`}
              onChange={(ev) => setSelected((s) => { const n = new Set(s); ev.target.checked ? n.add(e.id) : n.delete(e.id); return n; })} /></td>
            <td><a className="mono small" href={href(['p', projectKey, 'cycles', e.cycleId], { exec: e.id })} onClick={(ev) => ev.stopPropagation()}>{e.testCaseKey}</a> {e.title}
              <span onClick={(ev) => ev.stopPropagation()}><FocusLink to={`/f/${projectKey}/run/${e.id}`} name="anemo-run" className="row-action" title="Im eigenen Fenster durchführen"><span aria-hidden="true">⧉</span><span className="sr-only">{e.testCaseKey} im eigenen Fenster durchführen</span></FocusLink></span>
              {e.comment && <div className="small muted">{e.comment.slice(0, 100)}</div>}</td>
            <td className="small"><a href={href(['p', projectKey, 'cycles', e.cycleId])} onClick={(ev) => ev.stopPropagation()}>{e.cycleName}</a>
              <div className="muted">{[e.planName, e.build].filter(Boolean).join(' · ')}{e.cycleState === 'closed' ? ' · abgeschlossen' : ''}</div></td>
            <td><StatusBadge code={e.status} statuses={statuses} />
              <QuickStatus execution={e} statuses={statuses} disabled={!canExecute || e.cycleState === 'closed'} onSaved={() => list.reload()} /></td>
            <td className="small">{e.assignee ?? '–'}<div className="muted">{e.executedBy ? `${e.executedBy}, ${fmtDate(e.executedAt)}` : ''}{e.durationSeconds ? ` · ⏱ ${fmtDuration(e.durationSeconds)}` : ''}</div></td>
            <td className="small">{e.defects.map((d) => d.externalKey).join(', ') || '–'}</td>
          </tr>
        ))}</tbody>
      </table>{!items.length && <div className="empty">Keine Treffer.</div>}</div>}
      {(list.data?.total ?? 0) > PAGE && <div className="row">
        <button className="small" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Zurück</button>
        <span className="small muted">Seite {page + 1} / {Math.ceil(list.data!.total / PAGE)}</span>
        <button className="small" disabled={(page + 1) * PAGE >= list.data!.total} onClick={() => setPage(page + 1)}>Weiter ›</button>
      </div>}
    </div>
  );
}
