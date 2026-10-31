import { useState } from 'react';
import { useApi } from '../api.ts';
import { ErrorNote } from '../components/common.tsx';
import { hitHref, searchHref, TYPE_LABEL } from '../components/Search.tsx';
import { navigate, type Route } from '../router.ts';
import type { SearchResult, SearchType } from '../types.ts';

const TYPES: SearchType[] = ['testcase', 'cycle', 'plan', 'execution', 'reference', 'attachment'];

export function SearchPage({ route, currentProject }: { route: Route; currentProject: string | undefined }) {
  const q = route.query.get('q') ?? '';
  const project = route.query.get('project') ?? '';
  const types = route.query.get('types') ?? '';
  const [text, setText] = useState(q);
  const params = new URLSearchParams({ q, limit: '50' });
  if (project) params.set('project', project);
  if (types) params.set('types', types);
  const res = useApi<SearchResult>(q.trim().length >= 2 ? `/api/search?${params}` : null);
  const set = (patch: Record<string, string | null>) =>
    navigate(['search'], { q, project: project || null, types: types || null, ...patch });

  return (
    <div className="page" tabIndex={0} role="region" aria-label="Suche"><div className="page-wide stack">
      <h2>Suche</h2>
      <form className="row" onSubmit={(e) => { e.preventDefault(); set({ q: text }); }}>
        <input type="search" autoFocus value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1, width: 'auto' }}
          placeholder="Testfall, Jira-Schlüssel (z. B. DEMO-4102), Fehler-Ticket, Zyklus, Build, Umgebung, Kommentar, Dateiname …" />
        <button className="primary">Suchen</button>
      </form>
      <div className="row small">
        <span className="muted">Bereich:</span>
        <button className={!project ? 'small primary' : 'small'} onClick={() => set({ project: null })}>Alle Projekte</button>
        {currentProject && <button className={project === currentProject ? 'small primary' : 'small'} onClick={() => set({ project: currentProject })}>Nur {currentProject}</button>}
        <span className="spacer" />
        <span className="muted">Art:</span>
        <button className={!types ? 'small primary' : 'small'} onClick={() => set({ types: null })}>Alle</button>
        {TYPES.map((t) => <button key={t} className={types === t ? 'small primary' : 'small'} onClick={() => set({ types: t })}>{TYPE_LABEL[t]}</button>)}
      </div>
      <ErrorNote error={res.error} />
      {res.loading && <div className="muted">Sucht …</div>}
      {res.data?.groups.filter((g) => g.total > 0).map((g) => (
        <div key={g.type} className="card"><div className="card-body stack">
          <div className="row"><h3>{TYPE_LABEL[g.type]}</h3><span className="muted">{g.total} Treffer{g.total > g.items.length ? `, ${g.items.length} angezeigt` : ''}</span>
            <span className="spacer" />{!types && g.total > g.items.length && <a href={searchHref(q, { project: project || undefined, types: g.type })}>alle anzeigen</a>}</div>
          <div className="table-wrap"><table><tbody>
            {g.items.map((h) => (
              <tr key={h.id} className="clickable" onClick={() => (window.location.hash = hitHref(h).slice(1))}>
                <td style={{ width: 80 }}><span className="badge neutral mono">{h.projectKey}</span></td>
                <td><a href={hitHref(h)}>{h.title}</a>{h.subtitle && <div className="small muted">{h.subtitle}</div>}</td>
              </tr>
            ))}
          </tbody></table></div>
        </div></div>
      ))}
      {res.data && res.data.groups.every((g) => g.total === 0) && <div className="empty">Keine Treffer für „{q}“.</div>}
    </div></div>
  );
}
