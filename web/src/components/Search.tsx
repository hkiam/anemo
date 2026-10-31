import { useEffect, useId, useRef, useState } from 'react';
import { get } from '../api.ts';
import { href, navigate } from '../router.ts';
import type { SearchHit, SearchResult, SearchType } from '../types.ts';
import { hasFinePointer, MOD_KEY } from '../ux.tsx';

export const TYPE_LABEL: Record<SearchType, string> = {
  testcase: 'Testfälle', cycle: 'Testzyklen', plan: 'Testpläne', execution: 'Ausführungskommentare',
  reference: 'Verknüpfte Vorgänge (Jira u. a.)', attachment: 'Anhänge',
};

/** Ziel-URL eines Suchtreffers – überall gleich, damit jede Fundstelle direkt erreichbar ist. */
export function hitHref(h: SearchHit): string {
  if (h.target.executionId && h.target.cycleId) return href(['p', h.projectKey, 'cycles', h.target.cycleId], { exec: h.target.executionId });
  if (h.target.cycleId) return href(['p', h.projectKey, 'cycles', h.target.cycleId]);
  if (h.target.planId) return href(['p', h.projectKey, 'cycles'], { plan: h.target.planId });
  return href(['p', h.projectKey, 'repo'], { tc: h.target.testCase ?? null });
}

export function searchHref(q: string, opts: { project?: string | undefined; types?: string | undefined } = {}): string {
  return href(['search'], { q, project: opts.project ?? null, types: opts.types ?? null });
}

/** Globale Schnellsuche in der Kopfzeile (⌘K / Strg+K), projektübergreifend; Combobox mit gruppierter Trefferliste. */
export function QuickSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const uid = useId();
  const listId = `${uid}-treffer`;
  // Tastenkürzel-Hinweis plattformgerecht und nur mit Maus/Trackpad
  const [hint] = useState(() => (hasFinePointer() ? ` (${MOD_KEY === '⌘' ? '⌘K' : 'Strg+K'})` : ''));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => input.current?.focus(), 0);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResult(null);
      return;
    }
    const t = setTimeout(() => get<SearchResult>(`/api/search?limit=5&q=${encodeURIComponent(q)}`).then((r) => { setResult(r); setActive(0); }, () => {}), 200);
    return () => clearTimeout(t);
  }, [q]);

  const hits = result?.groups.flatMap((g) => g.items) ?? [];
  const go = (url: string) => {
    window.location.hash = url.slice(1);
    setOpen(false);
  };

  const expanded = open && !!result;
  const listShown = expanded && hits.length > 0;
  const total = result?.groups.reduce((n, g) => n + g.total, 0) ?? 0;
  const optionId = (idx: number) => `${listId}-${idx}`;
  return (
    <div className="quicksearch">
      <input ref={input} type="search" placeholder={`Suchen …${hint}`} value={q} aria-label="Übergreifende Suche"
        role="combobox" aria-autocomplete="list" aria-expanded={listShown} aria-controls={listShown ? listId : undefined}
        aria-activedescendant={listShown && hits[active] ? optionId(active) : undefined} aria-keyshortcuts="Control+K Meta+K"
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, hits.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Home' && expanded && hits.length) { e.preventDefault(); setActive(0); }
          if (e.key === 'End' && expanded && hits.length) { e.preventDefault(); setActive(hits.length - 1); }
          if (e.key === 'Enter') {
            e.preventDefault();
            if (hits[active]) go(hitHref(hits[active]!));
            else if (q.trim().length >= 2) go(searchHref(q));
          }
        }} />
      <div className="sr-only" role="status" aria-live="polite">
        {open && result ? (total ? `${total} Treffer, mit Pfeiltasten wählen` : 'Keine Treffer') : ''}
      </div>
      {expanded && (
        <div className="quicksearch-panel" onMouseDown={(e) => e.preventDefault()}>
          {hits.length > 0 && <div role="listbox" id={listId} aria-label="Suchtreffer">
            {result.groups.filter((g) => g.total > 0).map((g) => (
              <div key={g.type} role="group" aria-labelledby={`${listId}-${g.type}`}>
                <div className="qs-group" id={`${listId}-${g.type}`} role="presentation">{TYPE_LABEL[g.type]} <span className="muted">({g.total})</span></div>
                {g.items.map((h) => {
                  const idx = hits.indexOf(h);
                  return (
                    <a key={`${h.type}-${h.id}`} id={optionId(idx)} role="option" aria-selected={idx === active} tabIndex={-1}
                      className={`qs-item ${idx === active ? 'active' : ''}`} href={hitHref(h)} onClick={() => setOpen(false)} onMouseEnter={() => setActive(idx)}>
                      <span className="badge neutral mono">{h.projectKey}</span>
                      <span className="qs-title">{h.title}</span>
                      {h.subtitle && <span className="qs-sub">{h.subtitle}</span>}
                    </a>
                  );
                })}
              </div>
            ))}
          </div>}
          {result.groups.every((g) => g.total === 0) && <div className="empty">Keine Treffer.</div>}
          <a className="qs-all" href={searchHref(q)} onClick={() => setOpen(false)}>Alle Ergebnisse für „{q}“ anzeigen <span aria-hidden="true">↵</span></a>
        </div>
      )}
      {open && <div className="qs-backdrop" onClick={() => setOpen(false)} />}
    </div>
  );
}
