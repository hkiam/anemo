import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { HELP_TOPICS, helpSection, helpSlug, topicForRoute, topicOf, type HelpTopic } from '../../../shared/help/topics.ts';
import { useApi } from '../api.ts';
import { href, useRoute } from '../router.ts';
import { Icon } from '../ux.tsx';
import { ErrorNote } from './common.tsx';
import { Markdown } from './Markdown.tsx';

// ---------------------------------------------------------------------------------------------
// Zustand: offen/zu und Thema. Ohne festes Thema folgt die Hilfe der aktuellen Ansicht.
// ---------------------------------------------------------------------------------------------

interface HelpState { open: boolean; topic: string | null }
let state: HelpState = { open: false, topic: null };
const listeners = new Set<() => void>();
const set = (s: HelpState) => { state = s; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Hilfe öffnen – mit Thema (Hilfe-Knopf an Ort und Stelle) oder passend zur Ansicht. */
export function openHelp(topic?: string): void { set({ open: true, topic: topic ?? null }); }
export function closeHelp(): void { set({ ...state, open: false }); }
export function toggleHelp(): void { if (state.open) closeHelp(); else openHelp(); }

/** Kapitel-Link mit Sprungmarke (Hilfeseite #/hilfe/<seite>?a=<anker>). */
export function helpHref(t: HelpTopic): string {
  return href(['hilfe', t.page], t.heading ? { a: helpSlug(t.heading) } : {});
}

/** In der Anwendung lesbare Seiten (siehe Modul help); andere Verweise (ADRs, Quelltext) bleiben Text. */
const HANDBOOK_PAGE = /^(README|\d\d-[a-z-]+|anmeldung-sso|openproject|automation|mcp|agenten|ki-assistenz|ki-konzept|bdd-e2e-beispiel)$/;

/** Links im Handbuch: Handbuchseiten auf Hilfeseiten abbilden (mit Sprungmarke), Webadressen extern, Rest als Text. */
export function handbookLink(h: string, external = false) {
  if (/^https?:\/\//.test(h)) return { href: h, external: true };
  const [file, anchor] = h.split('#');
  const m = /^(?:\.\.\/)?(?:handbuch\/)?([0-9A-Za-z-]+)\.md$/.exec(file!);
  if (m && HANDBOOK_PAGE.test(m[1]!)) return { href: href(['hilfe', m[1]!], anchor ? { a: anchor } : {}), external };
  return null;
}

/** Kleiner „?“-Knopf neben Titeln und Bereichen: öffnet die Hilfe zum Thema. */
export function HelpButton({ topic, className }: { topic: string; className?: string }) {
  const t = topicOf(topic);
  if (!t) return null;
  return (
    <button type="button" className={`help-btn ${className ?? ''}`} onClick={(e) => { e.stopPropagation(); openHelp(topic); }}
      aria-label={`Hilfe: ${t.title}`} title={`Hilfe: ${t.title}`}>?</button>
  );
}

/** Knopf in der Kopfzeile: Hilfe zur aktuellen Ansicht ein- und ausblenden (F1). */
export function HelpToggle() {
  const s = useSyncExternalStore(subscribe, () => state);
  return (
    <button type="button" className={`help-toggle ${s.open ? 'on' : ''}`} onClick={toggleHelp} aria-pressed={s.open}
      aria-label="Hilfe zu dieser Ansicht" title="Hilfe zu dieser Ansicht (F1)"><Icon>?</Icon></button>
  );
}

// ---------------------------------------------------------------------------------------------
// Seitenleiste
// ---------------------------------------------------------------------------------------------

const ALL = Object.entries(HELP_TOPICS as Record<string, HelpTopic>);

/** Hilfe-Seitenleiste (nicht modal): bleibt beim Arbeiten offen, F1 bzw. ❓ öffnet und schließt. */
export function HelpPanel() {
  const s = useSyncExternalStore(subscribe, () => state);
  const route = useRoute();
  const contextTopic = topicForRoute(route.path, route.query);
  const id = s.topic ?? contextTopic;
  const topic: HelpTopic = topicOf(id) ?? HELP_TOPICS.overview;
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLElement>(null);
  const text = useApi<string>(s.open ? `/api/help/${topic.page}` : null);

  // F1 überall (auch in Eingabefeldern – der Browser hat dafür keine sinnvolle Belegung)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1') { e.preventDefault(); toggleHelp(); }
      else if (e.key === 'Escape' && state.open && ref.current?.contains(document.activeElement)) { e.preventDefault(); closeHelp(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Beim Öffnen und Themenwechsel: Fokus in die Leiste, Inhalt nach oben
  useEffect(() => {
    if (!s.open) return;
    const body = ref.current?.querySelector('.help-body');
    if (body) body.scrollTop = 0;
    ref.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }, [s.open, id]);
  useEffect(() => setQuery(''), [id]);
  // Dialoge rücken neben die Hilfe, statt von ihr verdeckt zu werden
  useEffect(() => { document.body.classList.toggle('help-open', s.open); }, [s.open]);

  const section = useMemo(() => {
    if (typeof text.data !== 'string') return null;
    return topic.heading ? helpSection(text.data, topic.heading) ?? text.data : text.data;
  }, [text.data, topic.heading]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? ALL.filter(([, t]) => t.title.toLowerCase().includes(q) || (t.heading ?? '').toLowerCase().includes(q)).slice(0, 12) : [];
  }, [query]);

  if (!s.open) return null;
  const related = (topic.related ?? []).map((r) => [r, topicOf(r)] as const).filter((x): x is readonly [string, HelpTopic] => !!x[1]);
  return (
    <aside ref={ref} className="help-panel" aria-labelledby="help-panel-title">
      <div className="help-head">
        <span className="help-kicker">Hilfe</span>
        <span className="spacer" />
        {s.topic && s.topic !== contextTopic && <button className="small ghost" onClick={() => openHelp()} title="Zurück zur Hilfe für die aktuelle Ansicht">Zur Ansicht</button>}
        <button className="ghost small" onClick={closeHelp} aria-label="Hilfe schließen" title="Hilfe schließen (Esc bzw. F1)">✕</button>
      </div>
      <div className="help-search">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Thema suchen …" aria-label="Hilfethema suchen"
          onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) openHelp(matches[0][0]); }} />
        {matches.length > 0 && <ul className="help-matches" aria-label="Gefundene Themen">
          {matches.map(([k, t]) => <li key={k}><button className="link" onClick={() => openHelp(k)}>{t.title}</button></li>)}
        </ul>}
        {query.trim() && matches.length === 0 && <div className="small muted" role="status">Kein Thema gefunden – im <a href={href(['hilfe'])} target="_blank" rel="noreferrer">Handbuch</a> nachsehen.</div>}
      </div>
      <div className="help-body">
        <h2 id="help-panel-title" tabIndex={-1}>{topic.title}</h2>
        <ErrorNote error={text.error} />
        {section === null && !text.error && <div className="muted small" role="status">Lädt …</div>}
        {/* Erste Überschrift steht schon im Titel; Links zu Handbuchseiten öffnen einen neuen Tab, damit Eingaben bleiben */}
        {section !== null && <div className="help-text"><Markdown text={topic.heading ? section.replace(/^#{1,6} .*\n?/, '') : section} link={(h) => handbookLink(h, true)} /></div>}
        {related.length > 0 && <>
          <h3 className="help-sub">Verwandte Themen</h3>
          <div className="row" style={{ gap: 6 }}>{related.map(([k, t]) => <button key={k} className="small chip-btn" onClick={() => openHelp(k)}>{t.title}</button>)}</div>
        </>}
      </div>
      <div className="help-foot">
        <a href={helpHref(topic)} target="_blank" rel="noreferrer" className="small">Ganzes Kapitel im Handbuch öffnen <Icon>↗</Icon></a>
      </div>
    </aside>
  );
}
