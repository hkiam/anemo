import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api, fmtDate, useApi } from '../api.ts';
import { ErrorNote, Progress, StatusBadge, useStatuses } from '../components/common.tsx';
import { href } from '../router.ts';
import { useCan, useSession } from '../session.tsx';
import type { Plan } from '../types.ts';
import { FocusLink, toast, useSync } from '../ux.tsx';
import { type TopDefect, TopDefectsTable, type Workload, WorkloadTable } from '../components/Insights.tsx';
import { plural, pluralWord } from '../text.ts';

interface Exec { id: string; cycleId: string; cycleName: string; key: string; title: string; status: string; endDate?: string | null }
interface StartData {
  me: string;
  tasks: {
    executions: { count: number; cycles: number; items: Exec[] };
    sessions: { id: string; cycleId: string; cycleName: string; charter: string; status: string; timeboxMinutes: number }[];
    drafts: { key: string; title: string; status: string; updatedAt: string }[];
  };
  lead: {
    approvals: { count: number; items: { key: string; title: string; status: string; createdBy: string; createdAt: string }[] };
    agentReviews: number;
    debriefs: { id: string; cycleId: string; charter: string; tester: string | null }[];
  } | null;
  kpis: { testCases: number; openExecutions: number; executedToday: number; executedWeek: number; myToday: number };
  cycles: { id: string; name: string; planId: string | null; planName: string | null; endDate: string | null; total: number; open: number; byStatus: Record<string, number> }[];
  failures: (Exec & { executedAt: string; executedBy: string | null })[];
  changes: { key: string; title: string; versionNo: number; createdBy: string; createdAt: string; changeNote: string | null }[];
}
interface Layout { order: string[]; hidden: string[] }

/** Kacheln der Startseite; `lead` nur mit Pflegerecht. */
const WIDGETS: { id: string; title: string; hint: string; lead?: boolean }[] = [
  { id: 'tasks', title: 'Meine Aufgaben', hint: 'Zugewiesene Ausführungen, eigene Sitzungen und Entwürfe' },
  { id: 'lead', title: 'Aufgaben der Testleitung', hint: 'Testfall-Freigaben (Vier-Augen-Prüfung), KI-Ergebnisprüfung, Nachbesprechungen', lead: true },
  { id: 'releases', title: 'Testpläne (Releases)', hint: 'Fortschritt und Freigabeentscheidung je Testplan' },
  { id: 'cycles', title: 'Aktive Testzyklen', hint: 'Laufende Zyklen mit Fortschritt' },
  { id: 'failures', title: 'Zuletzt fehlgeschlagen', hint: 'Fehlgeschlagene und blockierte Ausführungen der letzten 30 Tage' },
  { id: 'changes', title: 'Zuletzt geänderte Testfälle', hint: 'Neue Versionen im Projekt' },
  { id: 'health', title: 'Test-Health', hint: 'Pflegebedarf im Testbestand' },
  { id: 'topdefects', title: 'Top-Fehler', hint: 'Fehler mit den meisten betroffenen Testfällen (90 Tage)' },
  { id: 'team', title: 'Team & Aufwand', hint: 'Fortschritt je Person in den aktiven Zyklen (Aufwand im Release-Cockpit bzw. in Excel)', lead: true },
  { id: 'shortcuts', title: 'Schnellzugriff', hint: 'Häufige Aktionen' },
];
const DEFAULT_LEAD: Layout = { order: ['tasks', 'lead', 'releases', 'cycles', 'team', 'topdefects', 'failures', 'health', 'changes', 'shortcuts'], hidden: [] };
const DEFAULT_TESTER: Layout = { order: ['tasks', 'cycles', 'failures', 'shortcuts', 'topdefects', 'releases', 'changes', 'health'], hidden: ['topdefects', 'releases', 'changes', 'health'] };
const PREF = '/api/me/preferences/start';

const greeting = () => { const h = new Date().getHours(); return h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend'; };

/** Startseite je Projekt: Überblick und eigene Aufgaben; Kacheln persönlich ein-/ausblendbar und sortierbar. */
export function Start({ projectKey }: { projectKey: string }) {
  const me = useSession();
  const canEdit = useCan(projectKey, 'edit');
  const canExecute = useCan(projectKey, 'execute');
  const d = useApi<StartData>(`/api/projects/${projectKey}/start`);
  const pref = useApi<{ value: Layout | null }>(PREF);
  useSync(['execution', 'cycle', 'plan', 'testcase'], () => d.reload());
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<Layout | null>(null);
  const defaults = canEdit ? DEFAULT_LEAD : DEFAULT_TESTER;
  useEffect(() => { if (pref.data) setLayout(normalize(pref.data.value ?? defaults)); }, [pref.data, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  const available = WIDGETS.filter((w) => !w.lead || canEdit);
  function normalize(l: Layout): Layout {
    const ids = available.map((w) => w.id);
    const order = [...l.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !l.order.includes(id))];
    return { order, hidden: l.hidden.filter((id) => ids.includes(id)) };
  }
  const current = layout ?? normalize(defaults);
  // immer vom jüngsten Stand ausgehen – mehrere schnelle Änderungen dürfen sich nicht überschreiben
  const latest = useRef(current);
  latest.current = current;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const persist = async (change: ((l: Layout) => Layout) | null) => {
    const next = change ? normalize(change(latest.current)) : null;
    latest.current = next ?? normalize(defaults);
    setLayout(latest.current);
    // Speichern nacheinander, damit beim Server immer der letzte Stand ankommt
    queue.current = queue.current.then(() => api('PUT', PREF, { value: next })).catch((e) => toast((e as Error).message, 'bad'));
    await queue.current;
  };
  const move = (id: string, delta: number) => void persist((l) => {
    const order = [...l.order];
    const i = order.indexOf(id), j = i + delta;
    if (j < 0 || j >= order.length) return l;
    [order[i], order[j]] = [order[j]!, order[i]!];
    return { ...l, order };
  });
  const toggle = (id: string) => void persist((l) => ({ ...l, hidden: l.hidden.includes(id) ? l.hidden.filter((x) => x !== id) : [...l.hidden, id] }));

  const k = d.data?.kpis;
  const shown = current.order.filter((id) => editing || !current.hidden.includes(id));
  return (
    <div className="pane start-page">
      <div className="row start-head">
        <div style={{ flex: 1 }}>
          <h2>{greeting()}, {me.displayName}</h2>
          <div className="small muted">Projekt {projectKey} · {new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        </div>
        {editing
          ? <><button className="ghost small" onClick={() => persist(null)}>Standard wiederherstellen</button><button className="primary" onClick={() => setEditing(false)}>Fertig</button></>
          : <button className="small" onClick={() => setEditing(true)} title="Kacheln ein-/ausblenden und anordnen">⚙ Anpassen</button>}
      </div>
      <ErrorNote error={d.error} />
      {k && <div className="kpis">
        <Kpi value={k.testCases.toLocaleString('de-DE')} label="Testfälle" to={href(['p', projectKey, 'repo'])} />
        <Kpi value={k.openExecutions.toLocaleString('de-DE')} label="offene Ausführungen (Projekt)" to={href(['p', projectKey, 'cycles'], { state: 'open' })} />
        <Kpi value={`${k.executedToday}`} label={`heute ausgeführt${k.myToday ? `, davon ${k.myToday} von mir` : ''}`} />
        <Kpi value={`${k.executedWeek}`} label="in den letzten 7 Tagen" />
      </div>}
      {editing && <div className="notice info small">Kacheln mit ↑ ↓ anordnen und mit dem Auge ein- oder ausblenden. Die Einstellung gilt nur für Sie und wird sofort gespeichert.</div>}
      <div className="start-grid">
        {shown.map((id, i) => {
          const w = WIDGETS.find((x) => x.id === id)!;
          const hidden = current.hidden.includes(id);
          return (
            <section key={id} className={`card start-card ${id === 'tasks' ? 'start-wide' : ''} ${hidden ? 'start-hidden' : ''}`} aria-label={w.title}>
              <div className="card-body stack">
                <div className="row"><h3 style={{ flex: 1 }} title={w.hint}>{w.title}</h3>
                  {editing && <span className="row" style={{ gap: 2 }}>
                    <button className="ghost small" disabled={i === 0} onClick={() => move(id, -1)} aria-label={`${w.title} nach oben`}>↑</button>
                    <button className="ghost small" disabled={i === shown.length - 1} onClick={() => move(id, 1)} aria-label={`${w.title} nach unten`}>↓</button>
                    <button className="ghost small" onClick={() => toggle(id)} aria-label={`${w.title} ${hidden ? 'einblenden' : 'ausblenden'}`}><span aria-hidden="true">{hidden ? '◌ ' : '👁 '}</span>{hidden ? 'einblenden' : 'ausblenden'}</button>
                  </span>}
                </div>
                {hidden ? <div className="small muted">{w.hint} – ausgeblendet</div>
                  : !d.data ? <div className="muted small">Lädt …</div>
                  : <Widget id={id} projectKey={projectKey} data={d.data} canEdit={canEdit} canExecute={canExecute} />}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Kpi({ value, label, to }: { value: string; label: string; to?: string }) {
  const body = <><div style={{ fontSize: 22, fontWeight: 650 }}>{value}</div><div className="small muted">{label}</div></>;
  return to ? <a className="card kpi kpi-link" href={to}>{body}</a> : <div className="card kpi">{body}</div>;
}

function Widget({ id, projectKey, data, canEdit, canExecute }: { id: string; projectKey: string; data: StartData; canEdit: boolean; canExecute: boolean }) {
  const statuses = useStatuses();
  const execHref = (e: { cycleId: string; id: string }) => href(['p', projectKey, 'cycles', e.cycleId], { exec: e.id });
  const tcHref = (key: string) => href(['p', projectKey, 'repo'], { tc: key });
  switch (id) {
    case 'tasks': {
      const t = data.tasks;
      const first = t.executions.items[0];
      const nothing = !t.executions.count && !t.sessions.length && !t.drafts.length && !(data.lead && (data.lead.approvals.count || data.lead.agentReviews || data.lead.debriefs.length));
      return (
        <div className="stack">
          {t.executions.count > 0 ? <>
            <div className="row">
              <span><strong>{t.executions.count}</strong> offene {pluralWord(t.executions.count, 'Ausführung', 'Ausführungen')} in {plural(t.executions.cycles, 'Zyklus', 'Zyklen')} zugewiesen</span>
              <span className="spacer" />
              {canExecute && first && <FocusLink to={`/f/${projectKey}/run/${first.id}`} name="anemo-run" className="btn primary" title="Nächste Zuweisung im eigenen Fenster durchführen">▶ Weiter testen</FocusLink>}
            </div>
            <List items={t.executions.items.map((e) => ({ key: e.id, to: execHref(e), main: <><span className="mono small">{e.key}</span> {e.title}</>, sub: `${e.cycleName}${e.endDate ? ` · bis ${fmtDate(e.endDate)}` : ''}`, right: <StatusBadge code={e.status} statuses={statuses} /> }))} />
            {t.executions.count > t.executions.items.length && <a className="small" href={href(['p', projectKey, 'cycles'], { view: 'mine' })}>Alle {t.executions.count} zugewiesenen anzeigen →</a>}
          </> : <div className="small muted">Keine offenen Ausführungen zugewiesen. <a href={href(['p', projectKey, 'cycles'], { view: 'mine' })}>Mir zugewiesen →</a></div>}
          {t.sessions.length > 0 && <>
            <h4>Explorative Sitzungen</h4>
            <List items={t.sessions.map((s) => ({ key: s.id, main: s.charter, sub: `${s.cycleName} · ${s.timeboxMinutes} min`,
              right: <FocusLink to={`/f/${projectKey}/session/${s.id}`} name="anemo-sitzung" className="btn small" title={`Sitzung „${s.charter}“ im eigenen Fenster öffnen`}>{s.status === 'running' ? '⏱ läuft – öffnen' : '⧉ Öffnen'}</FocusLink> }))} />
          </>}
          {t.drafts.length > 0 && <>
            <h4>Meine Entwürfe</h4>
            <List items={t.drafts.map((x) => ({ key: x.key, to: tcHref(x.key), main: <><span className="mono small">{x.key}</span> {x.title}</>, sub: `zuletzt ${fmtDate(x.updatedAt)}` }))} />
          </>}
          {nothing && <div className="empty">Alles erledigt – keine offenen Aufgaben. <span aria-hidden="true">🎉</span></div>}
        </div>
      );
    }
    case 'lead': {
      const l = data.lead;
      if (!l) return null;
      return (
        <div className="stack">
          <div className="row"><span><strong>{l.approvals.count}</strong> {pluralWord(l.approvals.count, 'Testfall wartet', 'Testfälle warten')} auf Testfall-Freigabe (Vier-Augen-Prüfung)</span></div>
          {l.approvals.items.length > 0 && <List items={l.approvals.items.map((x) => ({ key: x.key, to: tcHref(x.key), main: <><span className="mono small">{x.key}</span> {x.title}</>, sub: `geändert von ${x.createdBy}, ${fmtDate(x.createdAt)}` }))} />}
          <div className="row"><span><strong>{l.agentReviews}</strong> {pluralWord(l.agentReviews, 'KI-Ergebnis', 'KI-Ergebnisse')} zur KI-Ergebnisprüfung</span><span className="spacer" />
            {l.agentReviews > 0 && <a className="btn small" href={href(['p', projectKey, 'cycles'], { view: 'reviews' })}>Prüfen →</a>}</div>
          <div className="row"><span><strong>{l.debriefs.length}</strong> {pluralWord(l.debriefs.length, 'Sitzung', 'Sitzungen')} ohne Nachbesprechung</span></div>
          {l.debriefs.length > 0 && <List items={l.debriefs.map((s) => ({ key: s.id, to: href(['p', projectKey, 'cycles', s.cycleId]), main: s.charter, sub: s.tester ?? '' }))} />}
        </div>
      );
    }
    case 'releases': return <Releases projectKey={projectKey} />;
    case 'cycles':
      return data.cycles.length === 0 ? <div className="small muted">Keine laufenden Zyklen.</div> : (
        <List items={data.cycles.map((c) => ({
          key: c.id, to: href(['p', projectKey, 'cycles', c.id]), main: c.name,
          sub: [c.planName, `${c.open} offen von ${c.total}`, c.endDate ? `bis ${fmtDate(c.endDate)}` : null].filter(Boolean).join(' · '),
          right: <div style={{ width: 140 }}><Progress byStatus={c.byStatus} statuses={statuses} total={c.total} /></div>,
        }))} />
      );
    case 'failures':
      return data.failures.length === 0 ? <div className="small muted">Keine Fehlschläge in den letzten 30 Tagen.</div> : (
        <List items={data.failures.map((e) => ({ key: e.id, to: execHref(e), main: <><span className="mono small">{e.key}</span> {e.title}</>,
          sub: `${e.cycleName} · ${e.executedBy ?? '?'}, ${fmtDate(e.executedAt)}`, right: <StatusBadge code={e.status} statuses={statuses} /> }))} />
      );
    case 'changes':
      return data.changes.length === 0 ? <div className="small muted">Keine Testfälle.</div> : (
        <List items={data.changes.map((x) => ({ key: x.key, to: tcHref(x.key), main: <><span className="mono small">{x.key}</span> {x.title}</>,
          sub: `v${x.versionNo} · ${x.createdBy}, ${fmtDate(x.createdAt)}${x.changeNote ? ` · ${x.changeNote}` : ''}` }))} />
      );
    case 'health': return <HealthSummary projectKey={projectKey} />;
    case 'topdefects': return <TopDefectsTile projectKey={projectKey} />;
    case 'team': return <TeamTile projectKey={projectKey} />;
    case 'shortcuts':
      return (
        <div className="shortcuts">
          {canEdit && <FocusLink to={`/f/${projectKey}/testcase/new`} name="anemo-testfall" className="btn">+ Testfall</FocusLink>}
          {canEdit && <FocusLink to={`/f/${projectKey}/cycle/new`} name="anemo-zyklus" className="btn">+ Testzyklus</FocusLink>}
          <a className="btn" href={href(['p', projectKey, 'cycles'], { view: 'mine' })}>Mir zugewiesen</a>
          <a className="btn" href={href(['p', projectKey, 'repo'])}>Testfälle</a>
          <a className="btn" href={href(['search'])}><span aria-hidden="true">🔎 </span>Suche</a>
          <a className="btn" href={href(['hilfe'])}><span aria-hidden="true">? </span>Hilfe</a>
        </div>
      );
    default: return null;
  }
}

function List({ items }: { items: { key: string; to?: string; main: ReactNode; sub?: string; right?: ReactNode }[] }) {
  return (
    <ul className="start-list">
      {items.map((x) => (
        <li key={x.key}>
          <div className="start-item-main">{x.to ? <a href={x.to}>{x.main}</a> : x.main}{x.sub && <div className="small muted">{x.sub}</div>}</div>
          {x.right}
        </li>
      ))}
    </ul>
  );
}

const DECISION: Record<string, string> = { released: 'Freigabeentscheidung: freigegeben', conditional: 'Freigabeentscheidung: mit Auflagen', rejected: 'Freigabeentscheidung: nicht freigegeben' };

function Releases({ projectKey }: { projectKey: string }) {
  const plans = useApi<(Plan & { releaseDecision?: string | null })[]>(`/api/projects/${projectKey}/plans`);
  const statuses = useStatuses();
  if (!plans.data) return <div className="muted small">Lädt …</div>;
  const list = plans.data.slice(0, 5);
  if (!list.length) return <div className="small muted">Noch keine Testpläne.</div>;
  return (
    <List items={list.map((p) => ({
      key: p.id, to: href(['p', projectKey, 'cycles'], { plan: p.id, tab: 'cockpit' }), main: p.name,
      sub: [`${plural(p.cycleCount ?? 0, 'Zyklus', 'Zyklen')} · ${plural(p.total ?? 0, 'Ausführung', 'Ausführungen')}`, p.releaseDecision ? DECISION[p.releaseDecision] : 'keine Freigabeentscheidung'].join(' · '),
      right: <div style={{ width: 140 }}><Progress byStatus={p.byStatus ?? {}} statuses={statuses} total={p.total ?? 0} /></div>,
    }))} />
  );
}

function HealthSummary({ projectKey }: { projectKey: string }) {
  const h = useApi<{ total: number; checks: { id: string; title: string; severity: string; count: number }[] }>(`/api/projects/${projectKey}/health`);
  if (!h.data) return <div className="muted small">Lädt …</div>;
  const open = h.data.checks.filter((c) => c.count > 0).sort((a, b) => b.count - a.count).slice(0, 6);
  if (!open.length) return <div className="small muted">Kein Pflegebedarf erkannt.</div>;
  return (
    <List items={open.map((c) => ({
      key: c.id, to: href(['p', projectKey, 'health'], { check: c.id }), main: c.title,
      right: <span className={`badge ${c.severity === 'bad' ? 'bad' : c.severity === 'warn' ? 'warn' : 'neutral'}`}>{c.count}</span>,
    }))} />
  );
}

function TopDefectsTile({ projectKey }: { projectKey: string }) {
  const t = useApi<TopDefect[]>(`/api/projects/${projectKey}/top-defects?days=90&limit=6`);
  if (!t.data) return <div className="muted small">Lädt …</div>;
  return <div className="stack"><TopDefectsTable rows={t.data} max={6} />
    {t.data.length > 0 && <a className="small" href={`/api/projects/${projectKey}/top-defects?days=90&limit=500&format=xlsx`}>⇩ Excel (alle)</a>}</div>;
}

function TeamTile({ projectKey }: { projectKey: string }) {
  const w = useApi<Workload>(`/api/projects/${projectKey}/workload`);
  if (!w.data) return <div className="muted small">Lädt …</div>;
  // in der Kachel nur Zuständig, Fortschritt, offen, Probleme – Aufwand im Cockpit bzw. in Excel (kein Abschneiden)
  return <div className="stack"><WorkloadTable w={w.data} compact />
    {w.data.byAssignee.length > 0 && <a className="small" href={`/api/projects/${projectKey}/workload?format=xlsx`}>⇩ Excel (inkl. je Tester und Zyklus)</a>}</div>;
}
