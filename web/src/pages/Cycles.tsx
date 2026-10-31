import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtDate, fmtDay, get, uploadAttachment, useApi } from '../api.ts';
import { uniqueFileName, WikiEditor } from '../wiki/WikiEditor.tsx';
import { DefectDialog } from '../components/DefectDialog.tsx';
import { ReportMenu } from '../components/ReportMenu.tsx';
import { References, refLabel } from '../components/References.tsx';
import { LinkDefectDialog } from '../components/LinkInput.tsx';
import { ToolButton, ToolFileButton, ToolRow } from '../components/ToolRow.tsx';
import { ReviewQueue } from '../components/Reviews.tsx';
import { Cockpit } from './Cockpit.tsx';
import { CompareDialog, DistributeDialog, RepeatCycleDialog } from '../components/CycleTools.tsx';
import { SavedViews } from '../components/SavedViews.tsx';
import { currentUser, useCan } from '../session.tsx';
import { deriveOverall } from '../../../shared/status/status.ts';
import { EventLog } from './Events.tsx';
import { ActionMenu, askConfirm, Icon, askText, confirmLeave, fillParams, FocusLink, fmtDuration, notifyChanged, openFocus, toast, useActiveTimer, useSync, useUnsavedGuard } from '../ux.tsx';
import { CycleEditor, PlanEditor } from './FocusForms.tsx';
import { SessionsPanel } from '../components/Sessions.tsx';
import { TestCaseView } from '../components/TestCaseView.tsx';
import { VersionUpdateDialog } from '../components/VersionUpdate.tsx';
import { GroupRow, GroupToggleAll, useStepGroups } from '../components/StepGroups.tsx';
import { checkSteps } from '../../../shared/steps/groups.ts';
import { RiskSelectionDialog } from '../components/RiskSelection.tsx';
import { TestSetPicker } from '../components/TestSets.tsx';
import { ExecutionBulkBar, QuickStatus } from '../components/ExecutionBulk.tsx';
import { postResult } from '../components/resultSave.ts';
import { ExecutionSearch } from './ExecutionSearch.tsx';
import { FieldInputs, useFieldDefs } from '../components/Fields.tsx';
import { DatasetEditor } from '../components/DatasetEditor.tsx';
import { AutomationImportDialog } from '../components/AutomationImport.tsx';
import { OfflineDialog } from '../components/OfflineDialog.tsx';
import { CiRunDialog, LastCiRun } from '../components/CiRuns.tsx';
import { WatchButton } from '../components/Watch.tsx';
import { SeverityBadge } from '../components/Severity.tsx';
import { ErrorNote, GherkinView, Modal, Progress, StatusBadge, useStatuses, Wiki, WikiAttachments } from '../components/common.tsx';
import { fmtRange, limitHint, plural } from '../text.ts';
import { fillStyle } from '../color.ts';
import { searchHref } from '../components/Search.tsx';
import { ConfigChips, EditCycleConfiguration, useDimensions } from '../components/Configuration.tsx';
import { href, navigate, type Route } from '../router.ts';
import type {
  Dataset, ConfigCount, Configuration,
  Cycle, ExecutionDetail, ExecutionListItem, ExecutionPage, ExecutionStatus, Facet, MatrixData, Page, Plan, StepResult,
  TestCaseListItem,
} from '../types.ts';

/**
 * Planung & Ausführung – ausgelegt auf sehr viele Zyklen in vielen Kontexten (Release, Build, Umgebung):
 * links Navigator (Testpläne/Releases, Sonderansichten), rechts Zyklen mit Filtern, Ergebnis-Matrix oder
 * ein einzelner Zyklus mit filterbaren Ausführungen. Alle Zustände stehen in der URL (verlinkbar).
 */
export function Cycles({ projectKey, route }: { projectKey: string; route: Route }) {
  const cycleId = route.path[3];
  const plans = useApi<Plan[]>(`/api/projects/${projectKey}/plans`);
  // Änderungen aus Fokusfenstern (Plan/Zyklus angelegt, Ergebnisse erfasst) aktualisieren die Übersicht
  useSync(['plan', 'cycle', 'execution'], () => plans.reload());
  return (
    // Offene Durchführung: Plan-Navigator ausblenden, damit Liste und Schritte Platz haben
    <div className={`planning ${cycleId && route.query.get('exec') ? 'exec-open' : ''}`}>
      <PlanNavigator projectKey={projectKey} plans={plans.data ?? []} route={route} onChanged={plans.reload} />
      {cycleId
        ? <CycleView key={cycleId} projectKey={projectKey} cycleId={cycleId} route={route} />
        : <PlanningMain projectKey={projectKey} plans={plans.data ?? []} route={route} onChanged={plans.reload} />}
    </div>
  );
}

const q = (route: Route, k: string) => route.query.get(k) ?? '';

// ---------------------------------------------------------------------------------------------
// Navigator
// ---------------------------------------------------------------------------------------------

function PlanNavigator({ projectKey, plans, route, onChanged }: { projectKey: string; plans: Plan[]; route: Route; onChanged: () => void }) {
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const canEdit = useCan(projectKey, 'edit');
  const statuses = useStatuses();
  const plan = q(route, 'plan');
  const view = q(route, 'view');
  const archived = plans.filter((p) => p.archivedAt).length;
  // archivierte Pläne nur auf Wunsch (bzw. wenn gerade geöffnet)
  const list = plans.filter((p) => (showArchived || !p.archivedAt || p.id === plan) && (!filter || `${p.name} ${p.release ?? ''}`.toLowerCase().includes(filter.toLowerCase())));
  const item = (key: string, label: string, sub: string, active: boolean, query: Record<string, string | null>) => (
    <a key={key} className={`plan-item ${active ? 'active' : ''}`} href={href(['p', projectKey, 'cycles'], query)}>
      <strong>{label}</strong><span className="meta"><span>{sub}</span></span>
    </a>
  );
  return (
    <nav className={`nav-pane stack ${navOpen ? '' : 'collapsed'}`} aria-label="Testpläne">
      <button className="small nav-toggle" onClick={() => setNavOpen((o) => !o)} aria-expanded={navOpen}>☰ Pläne und Ansichten {navOpen ? '▴' : '▾'}</button>
      <div className="stack" style={{ gap: 2 }}>
        {item('all', 'Alle Testzyklen', 'über alle Releases', !plan && !view && !route.path[3], {})}
        {item('mine', 'Mir zugewiesen', `offene Ausführungen von ${currentUser()}`, view === 'mine', { view: 'mine' })}
        {item('search', 'Ausführungen suchen', 'Abfrage über alle Zyklen, Massenbearbeitung, Export', view === 'search', { view: 'search' })}
        {item('reviews', 'KI-Ergebnisprüfung', 'Ergebnisse von KI-Agenten prüfen, Eskalationen', view === 'reviews', { view: 'reviews' })}
        {canEdit && item('audit', 'Protokoll', 'Wer hat wann was geändert (Audit-Trail, CSV)', view === 'audit', { view: 'audit' })}
        {item('none', 'Ohne Testplan', 'nicht einem Release zugeordnet', plan === 'none', { plan: 'none' })}
      </div>
      <div className="row"><h4 style={{ flex: 1 }}>Testpläne / Releases ({plans.length - archived})</h4>
        {canEdit && <button className="small" onClick={() => setCreating(true)} title="Neuen Testplan (Release) anlegen">+ Plan</button>}</div>
      {creating && <PlanEditor projectKey={projectKey} plan={null} onClose={() => setCreating(false)}
        onSaved={(p) => { setCreating(false); onChanged(); navigate(['p', projectKey, 'cycles'], { plan: p.id }); }} />}
      <input type="search" placeholder="Testplan oder Release filtern …" aria-label="Testpläne filtern (Name oder Release)" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <div className="stack" style={{ gap: 2 }}>
        {list.map((p) => (
          <a key={p.id} className={`plan-item ${plan === p.id ? 'active' : ''}`} href={href(['p', projectKey, 'cycles'], { plan: p.id })}>
            <strong>{p.name}{p.archivedAt && <span className="badge neutral" style={{ marginLeft: 6 }}>archiviert</span>}</strong>
            <Progress byStatus={p.byStatus ?? {}} statuses={statuses} total={p.total ?? 0} />
            <span className="meta">
              <span>{plural(p.cycleCount ?? 0, 'Zyklus', 'Zyklen')} · {plural(p.total ?? 0, 'Ausführung', 'Ausführungen')}</span>
              <span>{p.lastDate ? fmtDay(p.lastDate) : ''}</span>
            </span>
          </a>
        ))}
        {list.length === 0 && <div className="muted small">Keine Testpläne.</div>}
      </div>
      {archived > 0 && <label className="row small muted"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} style={{ width: 'auto' }} />
        Archivierte zeigen ({archived})</label>}
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------
// Hauptbereich: Zyklenliste / Matrix / Mir zugewiesen
// ---------------------------------------------------------------------------------------------

function PlanningMain({ projectKey, plans, route, onChanged }: { projectKey: string; plans: Plan[]; route: Route; onChanged: () => void }) {
  const canEdit = useCan(projectKey, 'edit');
  const plan = q(route, 'plan');
  const view = q(route, 'view');
  const tab = q(route, 'tab') || 'cycles';
  const current = plans.find((p) => p.id === plan);
  const [creating, setCreating] = useState(false);
  const [editingPlan, setEditingPlan] = useState(false);
  const statuses = useStatuses();

  if (view === 'mine') return <MyExecutions projectKey={projectKey} />;
  if (view === 'search') return <ExecutionSearch projectKey={projectKey} route={route} />;
  if (view === 'reviews') return <div className="pane" style={{ padding: 16, overflow: 'auto' }}><ReviewQueue projectKey={projectKey} statuses={statuses} /></div>;
  if (view === 'audit') return (
    <div className="pane stack" style={{ padding: 16, overflow: 'auto' }}>
      <h2>Protokoll</h2>
      <p className="small muted" style={{ margin: 0 }}>Alle fachlichen Änderungen im Projekt mit Person und Zeitpunkt – bei Kriterien, Plänen, Zyklen und Projektregeln mit altem und neuem Wert. Das Protokoll ist unveränderlich.</p>
      <EventLog projectKey={projectKey} />
    </div>
  );

  const archivePlan = async () => {
    if (!current) return;
    const archive = !current.archivedAt;
    if (archive && !(await askConfirm({ title: `Testplan „${current.name}“ archivieren`, message: 'Der Plan wird in der Planung ausgeblendet. Berichte, Freigabestände und Ergebnisse bleiben erhalten; Wiederherstellen ist jederzeit möglich.', confirmLabel: 'Archivieren' }))) return;
    await api('POST', `/api/plans/${current.id}/archive`, { archived: archive });
    toast(archive ? 'Testplan archiviert' : 'Testplan wiederhergestellt');
    onChanged();
  };
  const clonePlan = async () => {
    if (!current) return;
    const name = await askText({ title: `Testplan „${current.name}“ kopieren`, label: 'Name des neuen Testplans', initial: `${current.name} (Kopie)`, confirmLabel: 'Kopieren',
      hint: 'Übernommen werden Ziele, Ausstiegskriterien, Verweise, Datensatz-Anpassungen und alle Zyklen mit ihren Testfällen (aktuelle Version, Zuständige) – ohne Ergebnisse.' });
    if (!name?.trim()) return;
    const release = await askText({ title: 'Release des neuen Testplans', label: 'Release', initial: current.release ?? '', required: false, confirmLabel: 'Übernehmen' });
    if (release === null) return;
    try {
      const r = await api<{ planId: string; cycles: number; executions: number }>('POST', `/api/plans/${current.id}/clone`, { name: name.trim(), release: release.trim() || null, withCycles: true });
      toast(`Testplan kopiert: ${plural(r.cycles, 'Zyklus', 'Zyklen')}, ${plural(r.executions, 'Ausführung', 'Ausführungen')}`);
      notifyChanged('plan', r.planId);
      navigate(['p', projectKey, 'cycles'], { plan: r.planId });
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };
  const title = plan === 'none' ? 'Zyklen ohne Testplan' : current ? `Testplan ${current.name}` : 'Alle Testzyklen';
  return (
    <div className="pane stack" style={{ padding: 16 }}>
      <div className="row">
        <h2>{title}</h2>
        {current && <span className="muted small">{plural(current.cycleCount ?? 0, 'Zyklus', 'Zyklen')} · {plural(current.total ?? 0, 'Ausführung', 'Ausführungen')} · {fmtRange(current.firstDate ? fmtDay(current.firstDate) : null, current.lastDate ? fmtDay(current.lastDate) : null)}</span>}
        <span className="spacer" />
        <SavedViews projectKey={projectKey} page="cycles" base={`#/p/${projectKey}/cycles`} />
        {current && <ReportMenu items={[
          { label: 'Teststatusbericht (Zwischenbericht)', path: `/api/reports/status/${current.id}`, hint: 'Letzte 7 Tage: Fortschritt gegen Plan mit Prognose, neue Fehler, Lagebild (anderer Zeitraum: Release-Cockpit)' },
          { label: 'Testabschlussbericht', path: `/api/reports/completion/${current.id}`, hint: 'Kennzahlen, Ausstiegskriterien, Fehlerwirkungen, Restrisiken, Freigabeentscheidung' },
          { label: 'Rückverfolgbarkeit', path: `/api/reports/traceability/${current.id}`, hint: 'Anforderungen × Testfälle × letztes Ergebnis; ohne Testfall, mit Fehlern, nicht getestet' },
          { label: 'Lieferpaket', path: `/api/reports/package/${current.id}`, zip: true, hint: 'Bericht, Protokolle je Zyklus, Rückverfolgbarkeit, Ergebnisse (JSON), Evidenzen, Prüfsummen, Signatur' },
        ]} />}
        {current && <WatchButton key={current.id} type="TEST_PLAN" id={current.id} />}
        {current && canEdit && <button onClick={() => setEditingPlan(true)} title="Name, Release, Ziele und Kriterien des Testplans">✎ Plan bearbeiten</button>}
        {current && canEdit && <button onClick={() => void clonePlan()} title="Für das nächste Release: Ziele, Kriterien, Verweise und Zyklen mit Testfällen übernehmen – ohne Ergebnisse">⎘ Kopieren …</button>}
        {current && canEdit && <button onClick={() => void archivePlan()} title={current.archivedAt ? 'Wieder in der Planung anzeigen' : 'In der Planung ausblenden – Berichte, Freigabestände und Ergebnisse bleiben'}>
          {current.archivedAt ? '↺ Wiederherstellen' : '🗄 Archivieren'}</button>}
        {canEdit && <button className="primary" onClick={() => setCreating(true)}>+ Testzyklus</button>}
      </div>
      {current?.description && <details className="small"><summary>Ziele und Kriterien des Testplans</summary><Wiki text={current.description} /></details>}
      {current && <Progress byStatus={current.byStatus ?? {}} statuses={statuses} total={current.total ?? 0} />}
      {current && <details className="small"><summary>Verweise des Testplans (Anforderungen, Epics als übergeordnete Vorhaben, Release)</summary>
        <References ownerType="TEST_PLAN" ownerId={current.id} projectKey={projectKey} canEdit={canEdit} compact /></details>}
      <div className="tabs">
        <a className={tab === 'cycles' ? 'active' : ''} aria-current={tab === 'cycles' ? 'page' : undefined} href={href(['p', projectKey, 'cycles'], { plan: plan || null })}>Zyklen</a>
        <a className={tab === 'config' ? 'active' : ''} aria-current={tab === 'config' ? 'page' : undefined} href={href(['p', projectKey, 'cycles'], { plan: plan || null, tab: 'config' })}>Nach Konfiguration</a>
        {current && <a className={tab === 'matrix' ? 'active' : ''} aria-current={tab === 'matrix' ? 'page' : undefined} href={href(['p', projectKey, 'cycles'], { plan, tab: 'matrix' })}>Ergebnis-Matrix</a>}
        {current && <a className={tab === 'cockpit' ? 'active' : ''} aria-current={tab === 'cockpit' ? 'page' : undefined} href={href(['p', projectKey, 'cycles'], { plan, tab: 'cockpit' })}>Release-Cockpit</a>}
      </div>
      {current && tab === 'cockpit' ? <Cockpit projectKey={projectKey} planId={current.id} statuses={statuses} />
        : current && tab === 'matrix' ? <PlanMatrix projectKey={projectKey} planId={current.id} statuses={statuses} />
        : tab === 'config' ? <ConfigurationResults projectKey={projectKey} planId={current?.id} statuses={statuses} />
        : <CycleTable projectKey={projectKey} route={route} statuses={statuses} />}
      {creating && <CycleEditor projectKey={projectKey} plans={plans} cycle={null} defaultPlanId={current?.id} onClose={() => setCreating(false)}
        onSaved={(id) => { onChanged(); navigate(['p', projectKey, 'cycles', id]); }} onPlanCreated={onChanged} />}
      {editingPlan && current && <PlanEditor projectKey={projectKey} plan={current} onClose={() => setEditingPlan(false)}
        onSaved={() => { setEditingPlan(false); onChanged(); }} />}
    </div>
  );
}

const PAGE = 50;

function CycleTable({ projectKey, route, statuses }: { projectKey: string; route: Route; statuses: ExecutionStatus[] }) {
  const plan = q(route, 'plan');
  const filters = { q: q(route, 'q'), state: q(route, 'state'), environment: q(route, 'env'), build: q(route, 'build'), from: q(route, 'from'), to: q(route, 'to'), cfg: q(route, 'cfg'), archived: q(route, 'arch') };
  const dims = useDimensions();
  const cfg = parseCfg(filters.cfg);
  const page = Number(q(route, 'page') || 0);
  const [text, setText] = useState(filters.q);
  // Selten genutzte Filter eingeklappt; aktive Filter bleiben als Chips sichtbar
  const advancedActive = [filters.build, filters.from, filters.to, filters.cfg, filters.environment].filter(Boolean).length;
  const [moreFilters, setMoreFilters] = useState(() => { try { return localStorage.getItem('anemo.cycleFilters') === '1'; } catch { return false; } });
  const toggleMore = () => setMoreFilters((m) => { try { localStorage.setItem('anemo.cycleFilters', m ? '0' : '1'); } catch { /* egal */ } return !m; });
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
  if (plan) params.set('planId', plan);
  if (filters.q) params.set('q', filters.q);
  if (filters.state) params.set('state', filters.state);
  if (filters.environment) params.set('environment', filters.environment);
  if (filters.build) params.set('build', filters.build);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.cfg) params.set('config', filters.cfg);
  if (filters.archived === 'all' || filters.archived === 'only') params.set('archived', filters.archived);
  const cycles = useApi<Page<Cycle>>(`/api/projects/${projectKey}/cycles?${params}`);
  const counts = useApi<ConfigCount[]>(`/api/configuration/counts?project=${projectKey}${plan && plan !== 'none' ? `&planId=${plan}` : ''}`);
  const facets = useApi<{ environments: Facet[]; builds: Facet[] }>(`/api/projects/${projectKey}/cycle-facets${plan && plan !== 'none' ? `?planId=${plan}` : ''}`);
  const set = (patch: Record<string, string | null>) =>
    navigate(['p', projectKey, 'cycles'], {
      plan: plan || null, q: filters.q || null, state: filters.state || null, env: filters.environment || null,
      build: filters.build || null, from: filters.from || null, to: filters.to || null, cfg: filters.cfg || null, arch: filters.archived || null, ...patch, page: patch.page ?? null,
    });
  const setCfg = (dim: string, value: string | null) => {
    const next: Configuration = { ...cfg };
    if (value) next[dim] = [value]; else delete next[dim];
    set({ cfg: formatCfg(next) || null });
  };

  return (
    <div className="stack">
      <form className="filterbar" onSubmit={(e) => { e.preventDefault(); set({ q: text || null }); }}>
        <input type="search" placeholder="Zyklus, Build, Umgebung …" aria-label="Zyklen suchen (Name, Build, Umgebung) – Enter" value={text} onChange={(e) => setText(e.target.value)} style={{ minWidth: 220 }} />
        <select value={filters.state} onChange={(e) => set({ state: e.target.value || null })} aria-label="Zustand">
          <option value="">Alle Zustände</option>
          <option value="open">Offen (nicht/teilweise ausgeführt)</option>
          <option value="failed">Mit Fehlern/Blockaden</option>
          <option value="done">Vollständig ausgeführt</option>
        </select>
        <select value={filters.archived} onChange={(e) => set({ arch: e.target.value || null })} aria-label="Archiv">
          <option value="">ohne archivierte</option>
          <option value="all">mit archivierten</option>
          <option value="only">nur archivierte</option>
        </select>
        <button type="button" className={`small ${moreFilters ? 'on' : ''}`} onClick={toggleMore} aria-expanded={moreFilters}>
          {moreFilters ? 'Weniger Filter ▴' : `Weitere Filter${advancedActive ? ` (${advancedActive})` : ''} ▾`}</button>
        {Object.values(filters).some(Boolean) && <button type="button" className="small ghost" onClick={() => { setText(''); navigate(['p', projectKey, 'cycles'], { plan: plan || null }); }}>Filter zurücksetzen</button>}
      </form>
      {!moreFilters && advancedActive > 0 && (
        <div className="filter-chips small">
          <span className="muted">Aktiv:</span>
          {filters.build && <span className="chip">Build {filters.build} <button type="button" className="ghost small" aria-label="Build-Filter entfernen" onClick={() => set({ build: null })}>✕</button></span>}
          {filters.from && <span className="chip">ab {fmtDay(filters.from)} <button type="button" className="ghost small" aria-label="Von-Filter entfernen" onClick={() => set({ from: null })}>✕</button></span>}
          {filters.to && <span className="chip">bis {fmtDay(filters.to)} <button type="button" className="ghost small" aria-label="Bis-Filter entfernen" onClick={() => set({ to: null })}>✕</button></span>}
          {Object.entries(cfg).map(([d, vs]) => <span key={d} className="chip">{dims.find((x) => x.key === d)?.name ?? d}: {vs.join(', ')} <button type="button" className="ghost small" aria-label="Konfigurationsfilter entfernen" onClick={() => setCfg(d, null)}>✕</button></span>)}
          {filters.environment && <span className="chip">Umgebung „{filters.environment}“ <button type="button" className="ghost small" aria-label="Umgebungsfilter entfernen" onClick={() => set({ env: null })}>✕</button></span>}
        </div>
      )}
      {moreFilters && <div className="filterbar">
        <select value={filters.build} onChange={(e) => set({ build: e.target.value || null })} aria-label="Build" style={{ maxWidth: 200 }}>
          <option value="">Alle Builds</option>
          {facets.data?.builds.map((f) => <option key={f.value} value={f.value}>{f.value} ({f.count})</option>)}
        </select>
        <label className="row small muted">von <input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value || null })} /></label>
        <label className="row small muted">bis <input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value || null })} /></label>
      </div>}
      {moreFilters && <div className="cfg-filters small">
        <span className="muted">Konfiguration:</span>
        {dims.map((d) => {
          const opts = (counts.data ?? []).filter((c) => c.dimension === d.key);
          if (!opts.length) return null;
          return (
            <select key={d.key} value={cfg[d.key]?.[0] ?? ''} onChange={(e) => setCfg(d.key, e.target.value || null)} aria-label={d.name}>
              <option value="">{d.name}: alle</option>
              {opts.map((o) => <option key={o.value} value={o.value}>{d.name}: {o.value} ({o.cycles})</option>)}
            </select>
          );
        })}
        {filters.environment && <span className="chip">Umgebung „{filters.environment}“ <button type="button" className="ghost small" aria-label="Umgebungsfilter entfernen" onClick={() => set({ env: null })}>✕</button></span>}
      </div>}
      <ErrorNote error={cycles.error} />
      <div className="small muted">{cycles.data ? plural(cycles.data.total, 'Zyklus', 'Zyklen') : 'Lädt …'}</div>
      <div className="table-wrap"><table>
        <thead><tr><th>Zyklus</th>{!plan && <th className="fit">Testplan</th>}<th>Build</th><th>Konfiguration</th><th className="fit">Zeitraum</th><th style={{ width: 210 }}>Fortschritt</th></tr></thead>
        <tbody>{cycles.data?.items.map((c) => {
          const done = c.total - (c.byStatus.NOT_EXECUTED ?? 0);
          const problems = (c.byStatus.FAIL ?? 0) + (c.byStatus.BLOCKED ?? 0);
          return (
            <tr key={c.id} className="clickable" onClick={() => navigate(['p', projectKey, 'cycles', c.id])}>
              <td><a href={href(['p', projectKey, 'cycles', c.id])}>{c.name}</a>{(c as { isAdhoc?: boolean }).isAdhoc && <span className="badge neutral" title="Sofortausführungen ohne geplanten Zyklus"> Ad hoc</span>}
                {(c as { state?: string }).state === 'closed' && <span className="badge neutral" title="abgeschlossen"><span aria-hidden="true"> 🔒</span><span className="sr-only">abgeschlossen</span></span>}{c.description && <div className="small muted clamp2" title={c.description}>{c.description}</div>}</td>
              {!plan && <td className="small fit">{c.planName ?? '–'}</td>}
              <td className="small">{c.build ?? '–'}</td>
              <td className="small"><ConfigChips configuration={c.configuration} dims={dims} evidence={c.configurationEvidence} onPick={(d, v) => setCfg(d, v)} />
                {c.environment && <div className="muted clamp2" title={`Umgebung laut Quelle: ${c.environment}`}>{c.environment}</div>}</td>
              <td className="small fit">{fmtRange(c.startDate ? fmtDay(c.startDate) : null, c.endDate ? fmtDay(c.endDate) : null)}
                {c.lastExecutedAt && <div className="muted" style={{ whiteSpace: 'normal' }}>zuletzt ausgeführt {fmtDay(c.lastExecutedAt)}</div>}</td>
              <td>
                <Progress byStatus={c.byStatus} statuses={statuses} total={c.total} />
                <div className="small muted">{done}/{c.total} ausgeführt{problems ? <span className="err"> · {plural(problems, 'Problem', 'Probleme')}</span> : ''}</div>
              </td>
            </tr>
          );
        })}</tbody>
      </table>{cycles.data?.items.length === 0 && <div className="empty">Keine Zyklen für diese Filter.</div>}</div>
      <Pager total={cycles.data?.total ?? 0} page={page} size={PAGE} onPage={(p) => set({ page: String(p) })} />
    </div>
  );
}

function Pager({ total, page, size, onPage }: { total: number; page: number; size: number; onPage: (p: number) => void }) {
  if (total <= size) return null;
  const pages = Math.ceil(total / size);
  return (
    <div className="row small">
      <button className="small" disabled={page === 0} onClick={() => onPage(page - 1)}>‹ Zurück</button>
      <span className="muted">Seite {page + 1} von {pages} ({total.toLocaleString('de-DE')} Einträge)</span>
      <button className="small" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>Weiter ›</button>
    </div>
  );
}

/** Testfall × Zyklus: zeigt auf einen Blick, in welchem Kontext ein Test fehlschlug. */
function PlanMatrix({ projectKey, planId, statuses }: { projectKey: string; planId: string; statuses: ExecutionStatus[] }) {
  const [text, setText] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [maxCycles, setMaxCycles] = useState(30);
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 250);
    return () => clearTimeout(t);
  }, [text]);
  const m = useApi<MatrixData>(`/api/plans/${planId}/matrix?maxCycles=${maxCycles}&onlyProblems=${onlyProblems}${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`);
  const color = (code: string) => statuses.find((s) => s.code === code)?.color ?? '#999';
  const name = (code: string) => statuses.find((s) => s.code === code)?.name ?? code;
  return (
    <div className="stack">
      <div className="filterbar">
        <input type="search" placeholder="Testfall filtern …" aria-label="Testfälle in der Matrix filtern" value={text} onChange={(e) => setText(e.target.value)} />
        <label className="row small"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} style={{ width: 'auto' }} /> nur Testfälle mit Fehlern/Blockaden</label>
        <select value={maxCycles} onChange={(e) => setMaxCycles(Number(e.target.value))} aria-label="Anzahl Zyklen">
          {[15, 30, 60, 100].map((n) => <option key={n} value={n}>neueste {n} Zyklen</option>)}
        </select>
        <span className="small muted">{m.data ? `${plural(m.data.rows.length, 'Testfall', 'Testfälle')} × ${m.data.cycles.length} von ${plural(m.data.totalCycles, 'Zyklus', 'Zyklen')}` : 'Lädt …'}</span>
        <span className="spacer" />
        <a className="btn small" href={`/api/plans/${planId}/matrix/export?format=xlsx`} title="Ganze Matrix (bis 200 Zyklen) als Excel">⇩ Excel</a>
        <a className="btn small" href={`/api/plans/${planId}/matrix/export?format=csv`}>⇩ CSV</a>
      </div>
      <div className="stat-chips small">{statuses.map((s) => <span key={s.code} className="row" style={{ gap: 4 }}><span className="status-dot" style={{ background: s.color }} />{s.name}</span>)}</div>
      {m.data && (
        <div className="table-wrap" style={{ maxHeight: '65vh' }}>
          <table className="matrix">
            <thead><tr>
              <th className="sticky">Testfall</th>
              {m.data.cycles.map((c) => (
                <th key={c.id} className="col" title={`${c.name}${c.environment ? ` · ${c.environment}` : ''}${c.build ? ` · ${c.build}` : ''}`}>
                  <a href={href(['p', projectKey, 'cycles', c.id])}>{c.name.length > 28 ? `${c.name.slice(0, 27)}…` : c.name}</a>
                </th>
              ))}
            </tr></thead>
            <tbody>{m.data.rows.map((r) => (
              <tr key={r.testCaseId}>
                <td className="sticky small"><a href={href(['p', projectKey, 'repo'], { tc: r.key })}>{r.legacyKey ?? r.key}</a> {r.title}</td>
                {m.data!.cycles.map((c) => {
                  const cell = r.cells[c.id];
                  return (
                    <td key={c.id} className="cell">
                      {cell && <a href={href(['p', projectKey, 'cycles', c.id], { exec: cell.executionId })} style={{ background: color(cell.status) }}
                        title={`${r.legacyKey ?? r.key} in „${c.name}“: ${name(cell.status)}`} aria-label={name(cell.status)} />}
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table>
          {m.data.rows.length === 0 && <div className="empty">Keine Testfälle.</div>}
        </div>
      )}
    </div>
  );
}

function MyExecutions({ projectKey }: { projectKey: string }) {
  const [onlyOpen, setOnlyOpen] = useState(true);
  const statuses = useStatuses();
  const MINE_LIMIT = 500;
  const list = useApi<Page<ExecutionListItem & { cycleName: string; release: string | null; environment: string | null }>>(
    `/api/projects/${projectKey}/executions?assignee=me&limit=${MINE_LIMIT}${onlyOpen ? '&status=NOT_EXECUTED,WIP' : ''}`);
  const more = limitHint(list.data?.items.length ?? 0, list.data?.total, 'für den Rest die Ausführungssuche verwenden (zugewiesen = ich())');
  const isOpenCode = (c: string) => ['OPEN', 'IN_PROGRESS'].includes(statuses.find((x) => x.code === c)?.category ?? 'OPEN');
  const firstOpen = list.data?.items.find((e) => isOpenCode(e.status));
  const openMine = list.data?.items.filter((e) => isOpenCode(e.status)).length ?? 0;
  return (
    <div className="pane stack" style={{ padding: 16 }}>
      <div className="row"><h2>Mir zugewiesen</h2><span className="muted small">als „{currentUser()}“</span><span className="spacer" />
        <label className="row small"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} style={{ width: 'auto' }} /> nur offene</label>
        {firstOpen && <FocusLink to={`/f/${projectKey}/run/${firstOpen.id}`} name="anemo-run" className="btn primary" title="Erste offene Zuweisung im eigenen Fenster durchführen">▶ Durchführen ({openMine} offen)</FocusLink>}</div>
      {more && <div className="notice info small" role="status">{more}. <a href={href(['p', projectKey, 'cycles'], { view: 'search', aql: 'zugewiesen = ich()' })}>Zur Ausführungssuche →</a></div>}
      <ErrorNote error={list.error} />
      <div className="table-wrap"><table>
        <thead><tr><th>Testfall</th><th>Zyklus</th><th>Release</th><th>Umgebung</th><th>Status</th></tr></thead>
        <tbody>{list.data?.items.map((e) => (
          <tr key={e.id} className="clickable" onClick={() => navigate(['p', projectKey, 'cycles', e.cycleId], { exec: e.id })}>
            <td><a className="mono small" href={href(['p', projectKey, 'cycles', e.cycleId], { exec: e.id })} onClick={(ev) => ev.stopPropagation()}>{e.testCaseKey}</a> {e.title}{e.legacyKey && <span className="badge neutral mono legacy" title="Schlüssel im Altsystem">Jira {e.legacyKey}</span>}</td>
            <td>{e.cycleName}</td><td className="small">{e.release ?? '–'}</td><td className="small">{e.environment ?? '–'}</td>
            <td><StatusBadge code={e.status} statuses={statuses} /></td>
          </tr>
        ))}</tbody>
      </table>{!list.data && !list.error && <div className="empty small">Lädt …</div>}{list.data?.items.length === 0 && <div className="empty">Ihnen ist {onlyOpen ? 'nichts Offenes' : 'nichts'} zugewiesen.{' '}
        <a href={href(['p', projectKey, 'cycles'], { state: 'open' })}>Zyklen mit offenen Ausführungen ansehen →</a></div>}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Einzelner Zyklus
// ---------------------------------------------------------------------------------------------

const EXEC_PAGE = 200;

function CycleView({ projectKey, cycleId, route }: { projectKey: string; cycleId: string; route: Route }) {
  const canEdit = useCan(projectKey, 'edit');
  const canExecute = useCan(projectKey, 'execute');
  const execId = route.query.get('exec');
  const cycle = useApi<Cycle>(`/api/cycles/${cycleId}`);
  // Breite Ausführung: Liste schmal, Durchführung mit Schritten/Screenshots breit (Einstellung bleibt erhalten)
  const [wide, setWide] = useState(() => { try { return localStorage.getItem('anemo.execWide') === '1'; } catch { return false; } });
  const [repeating, setRepeating] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [distributing, setDistributing] = useState(false);
  const toggleWide = () => setWide((w) => { try { localStorage.setItem('anemo.execWide', w ? '0' : '1'); } catch { /* egal */ } return !w; });
  const statuses = useStatuses();
  const [status, setStatus] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [assignee, setAssignee] = useState('');
  const [withDefects, setWithDefects] = useState(false);
  const [outdated, setOutdated] = useState(false);
  const [sort, setSort] = useState('order');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [editingConfig, setEditingConfig] = useState(false);
  const [importingResults, setImportingResults] = useState(false);
  const [offline, setOffline] = useState(false);
  const [ciOpen, setCiOpen] = useState(false);
  const [risk, setRisk] = useState(false);
  // Telefon: Kopfangaben und seltene Filter eingeklappt, damit die Liste früher beginnt (Desktop unverändert)
  const [headOpen, setHeadOpen] = useState(false);
  const gitlab = useApi<{ available: boolean; reason: string | null; ciRefs?: string[] }>(`/api/projects/${projectKey}/gitlab/status`);
  const [editing, setEditing] = useState(false);
  const plans = useApi<Plan[]>(editing ? `/api/projects/${projectKey}/plans` : null);
  const dims = useDimensions();
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const t = setTimeout(() => { setDebounced(text); setPage(0); }, 250);
    return () => clearTimeout(t);
  }, [text]);

  const params = new URLSearchParams({ limit: String(EXEC_PAGE), offset: String(page * EXEC_PAGE), sort });
  if (status.length) params.set('status', status.join(','));
  if (debounced) params.set('q', debounced);
  if (assignee) params.set('assignee', assignee);
  if (withDefects) params.set('withDefects', 'true');
  if (outdated) params.set('outdated', 'true');
  const execs = useApi<ExecutionPage>(`/api/cycles/${cycleId}/executions?${params}`);
  useSync(['execution', 'testcase'], () => execs.reload());
  useSync(['cycle'], (_k, id) => { if (!id || id === cycleId) cycle.reload(); });
  // Wechsel nur nach Rückfrage, wenn die offene Durchführung ungespeicherte Eingaben hat
  const openCount = Object.entries(execs.data?.byStatus ?? {}).filter(([code]) => ['OPEN', 'IN_PROGRESS'].includes(statuses.find((x) => x.code === code)?.category ?? 'OPEN')).reduce((a, [, n]) => a + n, 0);
  const setCycleState = async (state: 'active' | 'closed') => {
    if (state === 'closed' && !(await askConfirm({ title: 'Zyklus abschließen', message: `Ergebnisse von „${cycle.data?.name}“ werden gesperrt. Der Zyklus lässt sich wieder öffnen.${openCount ? ` ${openCount} Ausführungen sind noch offen.` : ''}`, confirmLabel: 'Abschließen' }))) return;
    try {
      await api('POST', `/api/cycles/${cycleId}/state`, { state });
      toast(state === 'closed' ? 'Zyklus abgeschlossen' : 'Zyklus wieder geöffnet');
      notifyChanged('cycle', cycleId);
      cycle.reload();
    } catch (e) {
      setError(e);
    }
  };
  const archiveCycle = async (archived: boolean) => {
    if (archived && !(await askConfirm({ title: 'Zyklus archivieren', message: `„${cycle.data?.name}“ wird aus Listen und Startseite ausgeblendet und abgeschlossen. Ergebnisse und Berichte bleiben erhalten; wiederherstellen ist jederzeit möglich.`, confirmLabel: 'Archivieren' }))) return;
    try {
      await api('POST', `/api/cycles/${cycleId}/archive`, { archived });
      toast(archived ? 'Zyklus archiviert' : 'Zyklus wiederhergestellt');
      notifyChanged('cycle', cycleId);
      cycle.reload();
    } catch (e) { setError(e); }
  };
  const deleteCycle = async () => {
    if (!(await askConfirm({ title: 'Zyklus löschen', message: `„${cycle.data?.name}“ mit allen (nicht ausgeführten) Einträgen endgültig löschen? Zyklen mit Ergebnissen lassen sich nur archivieren.`, confirmLabel: 'Endgültig löschen', danger: true }))) return;
    try {
      await api('DELETE', `/api/cycles/${cycleId}`);
      toast('Zyklus gelöscht');
      notifyChanged('cycle', cycleId);
      navigate(['p', projectKey, 'cycles'], cycle.data?.planId ? { plan: cycle.data.planId } : {});
    } catch (e) { setError(e); }
  };
  const select = async (id: string | null) => { if (id !== execId && (await confirmLeave())) navigate(['p', projectKey, 'cycles', cycleId], { exec: id }); };
  const total = Object.values(execs.data?.byStatus ?? {}).reduce((a, b) => a + b, 0);
  const toggleStatus = (code: string) => { setPage(0); setStatus((s) => (s.includes(code) ? s.filter((x) => x !== code) : [...s, code])); };
  const assignees = useMemo(() => Object.entries(execs.data?.byAssignee ?? {}).sort((a, b) => b[1] - a[1]), [execs.data]);

  // Stufe J2: Sammelumstellung mit Probelauf (Anzahl, zurückgesetzte und entfallende Ergebnisse, Ausnahmen)
  const updateAllVersions = async () => {
    try {
      const d = await api<{ updated: number; resultsReset: number; resultsDropped: number; skipped: { key: string; reason: string }[] }>('POST', `/api/cycles/${cycleId}/update-versions`, { dryRun: true });
      if (!d.updated) { toast(d.skipped.length ? `Nichts umzustellen – ${plural(d.skipped.length, 'Ausführung ist', 'Ausführungen sind')} abgeschlossen (erneut einplanen statt umstellen).` : 'Alle Ausführungen nutzen die aktuelle Fassung.'); return; }
      const ok = await askConfirm({
        title: 'Auf aktuelle Testfallfassungen umstellen',
        message: `${plural(d.updated, 'Ausführung wird', 'Ausführungen werden')} umgestellt. ${d.resultsReset} Schrittergebnisse werden wieder offen (geänderte Schritte), ${d.resultsDropped} entfallen (entfernte Schritte); unveränderte bleiben. Der bisherige Stand bleibt im Verlauf.${d.skipped.length ? ` ${plural(d.skipped.length, 'abgeschlossene Ausführung bleibt', 'abgeschlossene Ausführungen bleiben')} unverändert.` : ''}`,
        confirmLabel: 'Umstellen',
      });
      if (!ok) return;
      const r = await api<{ updated: number }>('POST', `/api/cycles/${cycleId}/update-versions`, {});
      toast(`${plural(r.updated, 'Ausführung', 'Ausführungen')} umgestellt`);
      execs.reload();
      notifyChanged('execution');
    } catch (e) { toast((e as Error).message, 'bad'); }
  };

  const c = cycle.data;
  return (<>
    {repeating && c && <RepeatCycleDialog projectKey={projectKey} cycle={c} onClose={() => setRepeating(false)} />}
    {distributing && <DistributeDialog cycleId={cycleId} onClose={() => setDistributing(false)} onDone={() => execs.reload()} />}
    {comparing && c && <CompareDialog projectKey={projectKey} cycle={c} statuses={statuses} onClose={() => setComparing(false)} />}
    {/* Ohne gewählte Ausführung bekommt die Liste die volle Breite */}
    <div className="split" style={{ gridTemplateColumns: !execId ? 'minmax(0, 1fr)' : wide ? 'minmax(340px, 0.55fr) minmax(560px, 1.45fr)' : 'minmax(460px, 1fr) minmax(440px, 1.1fr)' }}>
      <div className="pane">
        <div className="stack">
          <div className="row small">
            <a href={href(['p', projectKey, 'cycles'], c?.planId ? { plan: c.planId } : {})}>‹ {c?.planName ?? 'Testplanung'}</a>
          </div>
          <div className="row"><h2>{c?.name}</h2>{gitlab.data?.available && <LastCiRun key={ciOpen ? 'a' : 'b'} cycleId={cycleId} />}<span className="spacer" />
            {c && <WatchButton type="TEST_CYCLE" id={cycleId} />}</div>
          {/* Werkzeugleiste: links die Arbeit am Zyklus (Primäraktion zuerst), rechts Verwaltung, Austausch und Berichte */}
          <div className="row toolbar" role="toolbar" aria-label="Aktionen zum Zyklus">
            {c && canExecute && openCount > 0 && (c as { state?: string }).state !== 'closed' && <FocusLink to={`/f/${projectKey}/cycle-run/${cycleId}`} name="anemo-run" className="btn primary" title="Durchführung im eigenen Fenster: nächste offene Ausführung, Speichern & weiter (Strg/Cmd-Klick: neuer Tab)"><Icon>▶</Icon>Durchführen ({openCount} offen)</FocusLink>}
            {canEdit && (c as { state?: string } | undefined)?.state !== 'closed' && <button className={openCount > 0 || total > 0 ? '' : 'primary'} onClick={() => setAdding(true)}><Icon>+</Icon>Tests aufnehmen</button>}
            {canEdit && (c as { state?: string } | undefined)?.state !== 'closed' && <button onClick={() => setRisk(true)} title="Vorschlag nach Risiko im Zeit- oder Mengenbudget, optional mit KI"><Icon>⚖</Icon>Risikobasiert auswählen …</button>}
            {/* Lebenszyklus sichtbar, sobald nichts mehr offen ist */}
            {c && canEdit && openCount === 0 && total > 0 && (c as { state?: string }).state !== 'closed' && <button onClick={() => void setCycleState('closed')} title="Ergebnisse sperren (für Berichte und Abnahme) – lässt sich wieder öffnen"><Icon>🔒</Icon>Abschließen …</button>}
            <span className="spacer" />
            {c && canEdit && <button className="small" onClick={() => setEditing(true)} title="Name, Plan, Build, Umgebung, Zeitraum, Testumfang"><Icon>✎</Icon>Bearbeiten</button>}
            {/* Datenaustausch (Export, Excel-Rundlauf, CI, automatisierte Ergebnisse) getrennt von Planung und Lebenszyklus */}
            {c && <ActionMenu label="⇅ Austausch ▾" items={[
              { label: '⇩ Export Excel', title: 'Alle Ausführungen mit Schrittergebnissen', onClick: () => { window.location.href = `/api/projects/${projectKey}/execution-export?format=xlsx&cycleId=${cycleId}`; } },
              { label: '⇅ Excel-Rundlauf …', title: 'Arbeitsmappe ausgeben, ohne Anemo ausfüllen und wieder einlesen (mit Probelauf)', onClick: () => setOffline(true) },
              { label: gitlab.data?.available ? '▶ CI-Pipeline starten …' : '▶ CI-Pipeline starten … (nicht verfügbar)', title: gitlab.data?.available ? 'GitLab-Pipeline für diesen Zyklus; Ergebnisse kommen automatisch zurück' : gitlab.data?.reason ?? 'GitLab nicht eingerichtet',
                hidden: !canEdit || !gitlab.data, onClick: () => setCiOpen(true) },
              { label: '⇧ Automatisierte Ergebnisse …', title: 'JUnit, Cucumber, TestNG, NUnit, xUnit, TRX, Robot, Playwright, Jest …', hidden: !canExecute, onClick: () => setImportingResults(true) },
            ]} />}
            <ReportMenu items={[{ label: 'Testprotokoll', path: `/api/reports/test-log/${cycleId}`, hint: 'Alle Ausführungen mit Befunden und Evidenzen' }]} />
            {c && <ActionMenu items={[
              { label: '↻ Wiederholen …', title: 'für neuen Build, als Nachtest oder je Konfiguration', onClick: () => setRepeating(true), hidden: !canEdit },
              { label: '⚖ Verteilen …', title: 'offene Ausführungen nach Auslastung zuweisen', onClick: () => setDistributing(true), hidden: !canExecute },
              { label: '⇄ Vergleichen …', title: 'mit anderem Zyklus bzw. Build', onClick: () => setComparing(true) },
              { label: '⟳ Auf aktuelle Testfallfassungen umstellen …', title: 'Offene und begonnene Ausführungen mit älterer Fassung umstellen – unveränderte Schrittergebnisse bleiben',
                hidden: !canExecute || (c as { state?: string }).state === 'closed', onClick: () => void updateAllVersions() },
              { label: '⚙ Konfiguration …', title: 'Datenbank, Client, Betriebssystem …', onClick: () => setEditingConfig(true), hidden: !canEdit },
              { label: '⧉ Bearbeiten im Fenster', title: 'Zyklusangaben mit voller Fläche', onClick: () => openFocus(`/f/${projectKey}/cycle/${cycleId}`, 'anemo-zyklus'), hidden: !canEdit },
              { label: (c as { state?: string }).state === 'closed' ? '🔓 Zyklus wieder öffnen' : '🔒 Zyklus abschließen …', title: (c as { state?: string }).state === 'closed' ? 'Ergebnisse wieder änderbar machen' : 'Ergebnisse sperren (für Berichte und Abnahme)',
                hidden: !canEdit, onClick: () => void setCycleState((c as { state?: string }).state === 'closed' ? 'active' : 'closed') },
              { label: (c as { archivedAt?: string | null }).archivedAt ? '↺ Wiederherstellen' : '🗄 Archivieren …', title: 'Ausblenden und sperren – Ergebnisse bleiben erhalten', hidden: !canEdit,
                onClick: () => void archiveCycle(!(c as { archivedAt?: string | null }).archivedAt) },
              { label: '🗑 Löschen …', title: 'Nur ohne Ergebnisse; sonst archivieren', hidden: !canEdit, onClick: () => void deleteCycle() },
            ]} />}</div>
          {(c as { archivedAt?: string | null } | undefined)?.archivedAt && <div className="notice warn small row"><span aria-hidden="true">🗄 </span>Archiviert – in Listen ausgeblendet, Ergebnisse gesperrt.
            {canEdit && <><span className="spacer" /><button className="small" onClick={() => archiveCycle(false)}>Wiederherstellen</button></>}</div>}
          {(c as { state?: string } | undefined)?.state === 'closed' && !(c as { archivedAt?: string | null } | undefined)?.archivedAt && <div className="notice warn small"><span aria-hidden="true">🔒 </span>Zyklus abgeschlossen – Ergebnisse sind gesperrt.</div>}
          <button className="small cycle-head-extra-toggle" onClick={() => setHeadOpen((o) => !o)} aria-expanded={headOpen}>Angaben zum Zyklus {headOpen ? '▴' : '▾'}</button>
          <div className={`cycle-head ${headOpen ? '' : 'compact'}`}><div className="cycle-head-extra stack">
          <div className="row small">
            {c?.release && <span className="chip">Release {c.release}</span>}
            {c?.build && <a className="chip" href={href(['p', projectKey, 'cycles'], { build: c.build })} title="Alle Zyklen mit diesem Build">Build {c.build}</a>}
            {c?.environment && <a className="chip" href={href(['p', projectKey, 'cycles'], { env: c.environment })} title="Alle Zyklen mit genau dieser Umgebungsangabe">{c.environment}</a>}
            {(c?.startDate || c?.endDate) && <span className="chip">{fmtRange(c?.startDate ? fmtDay(c.startDate) : null, c?.endDate ? fmtDay(c.endDate) : null)}</span>}
          </div>
          {c && (
            <div className="row small">
              <ConfigChips configuration={c.configuration} dims={dims} evidence={c.configurationEvidence}
                onPick={(d, v) => navigate(['p', projectKey, 'cycles'], { cfg: `${d}:${v}` })} />
              <span className="muted">{c.configurationSource === 'manual' ? '(manuell)' : '(automatisch erkannt)'}</span>
            </div>
          )}
          {c?.description && <Wiki text={c.description} />}
          {c && <details className="small"><summary>Verweise auf Tickets (Anforderungen, Fehler)</summary>
            <References ownerType="TEST_CYCLE" ownerId={c.id} projectKey={projectKey} canEdit={canEdit} compact /></details>}
          <Progress byStatus={execs.data?.byStatus ?? {}} statuses={statuses} total={total} />
          {((execs.data?.durationSeconds ?? 0) > 0 || (execs.data?.effort?.plannedMinutes ?? 0) > 0) && <div className="small muted effort-line">
            ⏱ erfasst {fmtDuration(execs.data!.durationSeconds)}
            {(execs.data!.effort?.plannedMinutes ?? 0) > 0 && <> · geplant {fmtDuration(execs.data!.effort!.plannedMinutes * 60)} · Rest {fmtDuration(execs.data!.effort!.remainingMinutes * 60)}</>}
            {(execs.data!.effort?.withoutEstimate ?? 0) > 0 && <span title="Testfälle ohne Schätzung zählen nicht in den geplanten Aufwand"> · {execs.data!.effort!.withoutEstimate} ohne Schätzung</span>}</div>}
          <SessionsPanel projectKey={projectKey} cycleId={cycleId} canExecute={canExecute} />
          </div></div>

          <div className="stat-chips">
            <button className={`chip-btn ${status.length === 0 ? 'on' : ''}`} onClick={() => { setStatus([]); setPage(0); }}>Alle ({total})</button>
            {statuses.filter((s) => execs.data?.byStatus[s.code]).map((s) => (
              <button key={s.code} className={`chip-btn ${status.includes(s.code) ? 'on' : ''}`} onClick={() => toggleStatus(s.code)}>
                <span className="status-dot" style={{ background: s.color }} />{s.name} ({execs.data?.byStatus[s.code]})
              </button>
            ))}
          </div>
          <div className={`filterbar cycle-filters ${headOpen ? '' : 'compact'}`}>
            <input type="search" placeholder="Testfall oder Kommentar …" aria-label="Ausführungen suchen (Testfall oder Kommentar)" value={text} onChange={(e) => setText(e.target.value)} style={{ minWidth: 200 }} />
            <select value={assignee} onChange={(e) => { setAssignee(e.target.value); setPage(0); }} aria-label="Zugewiesen">
              <option value="">Alle Zuständigen</option>
              {assignees.map(([a, n]) => <option key={a} value={a}>{a === '-' ? 'nicht zugewiesen' : a} ({n})</option>)}
            </select>
            <select className="filterbar-extra" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sortierung">
              <option value="order">Reihenfolge</option><option value="key">Schlüssel</option>
              <option value="status">Status</option><option value="executedAt">zuletzt ausgeführt</option>
            </select>
            <label className="row small"><input type="checkbox" checked={withDefects} onChange={(e) => { setWithDefects(e.target.checked); setPage(0); }} style={{ width: 'auto' }} /> nur mit verknüpften Fehlern</label>
            <label className="row small filterbar-extra" title="Testfall wurde seit der Einplanung geändert"><input type="checkbox" checked={outdated} onChange={(e) => { setOutdated(e.target.checked); setPage(0); }} style={{ width: 'auto' }} /> nur veraltete Testfall-Version</label>
          </div>
          <ExecutionBulkBar projectKey={projectKey} selected={selected} statuses={statuses} total={execs.data?.total}
            onSelectAll={async () => {
              // alle Treffer der aktuellen Filter: Zyklus-Abfrage ohne Seitenbegrenzung
              const p = new URLSearchParams(params); p.set('limit', '1000'); p.set('offset', '0');
              try {
                const r = await api<ExecutionPage>('GET', `/api/cycles/${cycleId}/executions?${p}`);
                setSelected(new Set(r.items.map((e) => e.id)));
                if (r.total > r.items.length) toast(`Es wurden die ersten ${r.items.length.toLocaleString('de-DE')} von ${r.total.toLocaleString('de-DE')} Treffern ausgewählt`, 'info');
              } catch (err) { toast((err as Error).message, 'bad'); }
            }}
            onClear={() => setSelected(new Set())} onDone={() => execs.reload()} />
          <ErrorNote error={error ?? execs.error} />
          <div className="table-wrap"><table>
            <thead><tr>
              <th style={{ width: 28 }}><input type="checkbox" aria-label="Alle auswählen" style={{ width: 'auto' }}
                checked={!!execs.data?.items.length && execs.data.items.every((e) => selected.has(e.id))}
                onChange={(ev) => setSelected(ev.target.checked ? new Set(execs.data?.items.map((e) => e.id)) : new Set())} /></th>
              <th>Testfall</th><th>Status</th><th>Zuständig / ausgeführt</th><th>Fehler</th>
            </tr></thead>
            <tbody>{execs.data?.items.map((e) => (
              <tr key={e.id} className={`clickable ${execId === e.id ? 'selected' : ''}`} onClick={() => select(e.id)}>
                <td onClick={(ev) => ev.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(e.id)} style={{ width: 'auto' }} aria-label={`${e.testCaseKey} auswählen`}
                    onChange={(ev) => setSelected((s) => { const n = new Set(s); ev.target.checked ? n.add(e.id) : n.delete(e.id); return n; })} />
                </td>
                <td>
                  <a className="mono small" href={href(['p', projectKey, 'cycles', cycleId], { exec: e.id })} aria-current={execId === e.id ? 'true' : undefined}
                    onClick={(ev) => { ev.stopPropagation(); if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return; ev.preventDefault(); void select(e.id); }}>{e.testCaseKey}</a> {e.title}{e.legacyKey && <span className="badge neutral mono legacy" title="Schlüssel im Altsystem">Jira {e.legacyKey}</span>}
                  <span onClick={(ev) => ev.stopPropagation()}><FocusLink to={`/f/${projectKey}/run/${e.id}`} name="anemo-run" className="row-action" title="Im eigenen Fenster durchführen (Strg/Cmd-Klick: neuer Tab)"><span aria-hidden="true">⧉</span><span className="sr-only">{e.testCaseKey} im eigenen Fenster durchführen</span></FocusLink></span>
                  <div className="small muted">v{e.versionNo}{e.versionNo !== e.currentVersion && <span className="badge warn" title="Der Testfall wurde seit der Einplanung geändert"> aktuell v{e.currentVersion}</span>}
                    {e.comment && <> · {e.comment.slice(0, 80)}</>}</div>
                </td>
                <td><StatusBadge code={e.status} statuses={statuses} />
                  <QuickStatus execution={{ ...e, testCaseKey: e.testCaseKey }} statuses={statuses} disabled={!canExecute || (c as { state?: string } | undefined)?.state === 'closed'} onSaved={() => execs.reload()} />
                  {e.reviewState === 'pending' && <span className="badge warn" title="Ergebnis eines KI-Agenten – KI-Ergebnisprüfung ausstehend" style={{ marginLeft: 4 }}><span aria-hidden="true">🤖 </span>zu prüfen</span>}{e.reviewState === 'escalated' && <span className="badge bad" style={{ marginLeft: 4 }}>eskaliert</span>}</td>
                <td className="small">{e.assignee ?? '–'}<div className="muted">{e.executedBy ? `${e.executedBy}, ${fmtDate(e.executedAt)}` : ''}{e.durationSeconds ? ` · ⏱ ${fmtDuration(e.durationSeconds)}` : ''}</div>
                  {(e.iterations?.length ?? 0) > 0 && <div className="muted" title="Durchläufe des parametrisierten Tests">{plural(e.iterations!.length, 'Durchlauf', 'Durchläufe')}</div>}</td>
                <td className="small">{e.defects.map((d) => <a key={d.id} href={searchHref(d.externalKey, { types: 'reference' })} onClick={(ev) => ev.stopPropagation()} title="Alle Stellen mit diesem Fehler">{d.externalKey} </a>)}{e.defects.length === 0 && '–'}</td>
              </tr>
            ))}</tbody>
          </table>{!execs.data && !execs.error && <div className="empty small">Lädt …</div>}{execs.data?.items.length === 0 && <div className="empty">{total === 0 ? 'Noch keine Tests im Zyklus – über „+ Tests aufnehmen“ oder „Risikobasiert auswählen …“ einplanen.' : 'Keine Einträge für diese Filter.'}</div>}</div>
          <Pager total={execs.data?.total ?? 0} page={page} size={EXEC_PAGE} onPage={setPage} />
        </div>
      </div>
      {execId && <div className="detail-pane">
        <ExecutionPanel key={execId} id={execId} statuses={statuses} projectKey={projectKey} onSaved={execs.reload} wide={wide} onToggleWide={toggleWide} onClose={() => void select(null)} />
      </div>}
      {offline && <OfflineDialog cycleId={cycleId} canExecute={canExecute} onClose={() => setOffline(false)} onDone={() => execs.reload()} />}
      {ciOpen && <CiRunDialog cycleId={cycleId} available={!!gitlab.data?.available} reason={gitlab.data?.reason ?? null} refs={gitlab.data?.ciRefs ?? []} canEdit={canEdit} onClose={() => setCiOpen(false)} />}
      {importingResults && <AutomationImportDialog projectKey={projectKey} cycleId={cycleId} planId={c?.planId} onClose={() => setImportingResults(false)}
        onDone={(id) => { setImportingResults(false); execs.reload(); if (id !== cycleId) navigate(['p', projectKey, 'cycles', id]); }} />}
      {risk && <RiskSelectionDialog projectKey={projectKey} cycleId={cycleId} onClose={() => setRisk(false)} onAdded={() => { setRisk(false); execs.reload(); }} />}
      {adding && <AddTests projectKey={projectKey} cycleId={cycleId} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); execs.reload(); }} />}
      {editing && c && plans.data && <CycleEditor projectKey={projectKey} plans={plans.data} cycle={c} onClose={() => setEditing(false)}
        onSaved={() => { setEditing(false); cycle.reload(); }} />}
      {editingConfig && c && <EditCycleConfiguration cycle={c} onClose={() => setEditingConfig(false)} onSaved={() => { setEditingConfig(false); cycle.reload(); }} />}
    </div>
  </>);
}

// ---------------------------------------------------------------------------------------------
// Formulare und Ausführung
// ---------------------------------------------------------------------------------------------

function AddTests({ projectKey, cycleId, onClose, onAdded }: { projectKey: string; cycleId: string; onClose: () => void; onAdded: () => void }) {
  const LIMIT = 200;
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<TestCaseListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [risk, setRisk] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  useEffect(() => {
    get<ExecutionPage>(`/api/cycles/${cycleId}/executions?limit=1000`).then((r) => setExisting(new Set(r.items.map((e) => e.testCaseId))), setError);
  }, [cycleId]);
  useEffect(() => {
    const t = setTimeout(() => {
      get<{ items: TestCaseListItem[]; total: number }>(`/api/projects/${projectKey}/test-cases?limit=${LIMIT}${query ? `&q=${encodeURIComponent(query)}` : ''}`).then((r) => { setItems(r.items); setTotal(r.total); }, setError);
    }, 250);
    return () => clearTimeout(t);
  }, [query, projectKey]);
  const add = async () => {
    try {
      const r = await api<{ added: number; warnings?: string[] }>('POST', `/api/cycles/${cycleId}/executions`, { testCaseIds: [...sel] });
      toast(`${plural(r.added, 'Test', 'Tests')} aufgenommen`);
      for (const w of r.warnings ?? []) toast(w, 'info');
      onAdded();
    } catch (e) {
      setError(e);
    }
  };
  /** Wirklich alle Treffer der Suche – nicht nur die angezeigten – über die ID-Abfrage des Servers */
  const selectAll = async () => {
    setSelectingAll(true);
    try {
      const p = new URLSearchParams({ idsOnly: 'true', limit: '5000', offset: '0' });
      if (query) p.set('q', query);
      const r = await api<{ total: number; ids: string[] }>('GET', `/api/projects/${projectKey}/test-cases?${p}`);
      const ids = r.ids.filter((id) => !existing.has(id));
      setSel(new Set([...sel, ...ids]));
      if (r.total > r.ids.length) toast(`Es wurden die ersten ${r.ids.length.toLocaleString('de-DE')} von ${r.total.toLocaleString('de-DE')} Treffern berücksichtigt – Suche eingrenzen oder ein Testset verwenden`, 'info');
    } catch (e) {
      setError(e);
    } finally {
      setSelectingAll(false);
    }
  };
  const list = items ?? [];
  const selectable = list.filter((i) => !existing.has(i.id));
  const more = limitHint(list.length, total, 'Suche eingrenzen oder ein Testset verwenden');
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <Modal title="Tests in Zyklus aufnehmen (aktuelle Version)" help="cycles" onClose={onClose}
      footer={<><span className="muted small">{sel.size.toLocaleString('de-DE')} ausgewählt</span><span className="spacer" /><button onClick={onClose}>Abbrechen</button>
        <button className="primary" disabled={!sel.size} title={sel.size ? undefined : 'Erst Testfälle auswählen'} onClick={add}>Aufnehmen</button></>}>
      <ErrorNote error={error} />
      <div className="row">
        <input autoFocus type="search" placeholder="Suchen (Text, Schlüssel, Jira-Schlüssel) …" aria-label="Testfälle suchen" value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, width: 'auto' }} />
        <button className="small" disabled={!selectable.length || selectingAll} onClick={() => void selectAll()}
          title={total > list.length ? `Alle ${total.toLocaleString('de-DE')} Treffer der Suche (nicht nur die angezeigten), ohne bereits enthaltene` : 'Alle Treffer der Suche, ohne bereits enthaltene'}>{selectingAll ? 'wählt aus …' : 'alle Treffer auswählen'}</button>
        <TestSetPicker projectKey={projectKey} cycleId={cycleId} onAdded={onAdded} />
        <button className="small" onClick={() => setRisk(true)} title="Vorschlag nach Risiko im Zeit- oder Mengenbudget, optional mit KI">⚖ Risikobasiert …</button>
      </div>
      {more && <div className="small muted" role="status">{more}</div>}
      {risk && <RiskSelectionDialog projectKey={projectKey} cycleId={cycleId} onClose={() => setRisk(false)} onAdded={onAdded} />}
      <div className="table-wrap" style={{ maxHeight: 420 }}><table><tbody>
        {list.map((i) => {
          const already = existing.has(i.id);
          return (
            <tr key={i.id} className="clickable" onClick={() => !already && toggle(i.id)}>
              <td style={{ width: 28 }}><input type="checkbox" disabled={already} checked={already || sel.has(i.id)} style={{ width: 'auto' }}
                aria-label={`${i.legacyKey ?? i.key} ${i.title}${already ? ' (bereits im Zyklus)' : ''}`} onClick={(e) => e.stopPropagation()} onChange={() => toggle(i.id)} /></td>
              <td className="mono small">{i.legacyKey ?? i.key}</td><td>{i.title}</td><td className="small muted">{already ? 'bereits im Zyklus' : `v${i.currentVersion}`}</td>
            </tr>
          );
        })}
      </tbody></table>
        {items === null && !error && <div className="empty small">Lädt …</div>}
        {items !== null && list.length === 0 && <div className="empty">{query ? 'Keine Testfälle gefunden.' : 'Im Projekt gibt es noch keine Testfälle.'}</div>}
      </div>
    </Modal>
  );
}

/** Haupt-Status je Kategorie als Knopf (bestanden, fehlgeschlagen, blockiert), seltene Status in „⋯“ (kompakt). */
const PRIMARY = ['PASS', 'FAIL', 'BLOCKED'];
function StatusButtons({ value, onChange, statuses, small, label, compact }: { value: string; onChange: (c: string) => void; statuses: ExecutionStatus[]; small?: boolean; label: string; compact?: boolean }) {
  const main = compact ? statuses.filter((s) => PRIMARY.includes(s.code) || s.code === value) : statuses;
  const more = compact ? statuses.filter((s) => !main.includes(s)) : [];
  const icon: Record<string, string> = { PASSED: '✓ ', FAILED: '✗ ', BLOCKED: '⊘ ' };
  return (
    <div className="status-buttons" role="group" aria-label={label}>
      {main.map((s) => (
        <button key={s.code} aria-label={s.name} aria-pressed={value === s.code} className={`${small ? 'small' : ''} ${value === s.code ? 'on' : ''}`}
          style={value === s.code ? fillStyle(s.color) : undefined} onClick={() => onChange(value === s.code && compact ? 'NOT_EXECUTED' : s.code)}
          title={compact && value === s.code ? 'Erneut klicken: zurücksetzen' : undefined}>{compact ? icon[s.category] ?? '' : ''}{s.name}</button>
      ))}
      {more.length > 0 && (
        <select className="status-more" value="" aria-label={`${label}: weitere Status`} onChange={(e) => e.target.value && onChange(e.target.value)}>
          <option value="">⋯</option>
          {more.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
      )}
    </div>
  );
}

const NO_STEPS: ExecutionDetail['steps'] = [];

export function ExecutionPanel({ id, statuses, projectKey, onSaved, wide, onToggleWide, focus, onNext, onClose }: {
  id: string; statuses: ExecutionStatus[]; projectKey: string; onSaved: () => void; wide?: boolean; onToggleWide?: () => void;
  /** Fokusfenster: volle Breite, kein Umschalter */
  focus?: boolean;
  /** „Speichern & weiter“: nach erfolgreichem Speichern zur nächsten offenen Ausführung */
  onNext?: () => void;
  /** Durchführung schließen (Liste wieder in voller Breite) */
  onClose?: () => void;
}) {
  const canExecute = useCan(projectKey, 'execute');
  const ex = useApi<ExecutionDetail>(`/api/executions/${id}`);
  const cycleState = useApi<{ state?: string }>(ex.data ? `/api/cycles/${ex.data.cycleId}` : null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const canEditTc = useCan(projectKey, 'edit');
  const [viewingTc, setViewingTc] = useState(false);
  const [updatingVersion, setUpdatingVersion] = useState(false);
  // Testfall im Fokusfenster (oder anderswo) gespeichert: Hinweis, dass diese Ausführung bei ihrer Fassung bleibt
  useSync(['testcase'], (_k, key) => {
    const d = ex.data;
    if (!d || (key && key !== d.testCase.key)) return;
    void get<{ currentVersion: number }>(`/api/test-cases/${d.testCase.key}`).then((t) => {
      if (t.currentVersion === d.testCase.currentVersion) return;
      ex.reload();
      toast(`${d.testCase.key}: neue Fassung v${t.currentVersion} gespeichert – diese Ausführung bleibt bei v${d.version.versionNo}.`);
    }).catch(() => undefined);
  });
  const results_ = useApi<{ id: string; status: string; comment: string | null; recordedBy: string; recordedAt: string; note: string | null }[]>(historyOpen ? `/api/executions/${id}/results` : null);
  const history = useApi<{ id: string; cycleId: string; cycleName: string; release: string | null; status: string; versionNo: number; executedAt: string | null }[]>(
    ex.data ? `/api/test-cases/${ex.data.testCase.id}/executions` : null);
  // Bilder in Schritten verweisen auf Anhänge des Testfalls; Evidenzen hängen an der Ausführung
  const tcAttachments = useApi<{ id: string; fileName: string }[]>(ex.data ? `/api/attachments?ownerType=TEST_CASE&ownerId=${ex.data.testCase.id}` : null);
  const execAttachments = useApi<{ id: string; fileName: string; storage: string; sizeBytes: number | null }[]>(`/api/attachments?ownerType=TEST_EXECUTION&ownerId=${id}`);
  const [status, setStatus] = useState('');
  const [comment, setComment] = useState('');
  const [results, setResults] = useState<Record<string, StepResult>>({});
  const [defect, setDefect] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [reporting, setReporting] = useState<boolean | string>(false);
  // Fehler verknüpfen (Ticket oder Link): true = zur Ausführung, string = zu diesem Schritt
  const [linking, setLinking] = useState<boolean | string>(false);
  const [dirty, setDirty] = useState(false);
  const execFieldDefs = useFieldDefs('execution', projectKey);
  const canEdit = useCan(projectKey, 'edit');
  const [overriding, setOverriding] = useState(false);
  const [execFields, setExecFields] = useState<Record<string, unknown>>({});
  const [fieldsDirty, setFieldsDirty] = useState(false);
  useUnsavedGuard(dirty, `exec-${id}`);
  // Parametrisierte Tests: je Datenzeile ein Durchlauf; `results` gilt für den aktuellen Durchlauf
  const [cur, setCur] = useState(0);
  const [iters, setIters] = useState<Record<number, { status: string; comment: string; results: Record<string, StepResult> }>>({});
  const [iterStatus, setIterStatus] = useState('NOT_EXECUTED');
  const [iterComment, setIterComment] = useState('');
  // aktive Bearbeitungszeit (nur sichtbares Fenster) – wird beim Speichern übertragen
  const timer = useActiveTimer();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  // Tastaturbedienung: Handler wird je Render aktualisiert, Listener nur einmal registriert
  const [focusStep, setFocusStep] = useState(0);
  // Abschnitte (J1): auf-/zuklappbar (Standard offen), ohne Ergebnis; Tastatur überspringt sie
  const groups = useStepGroups(ex.data?.steps ?? NO_STEPS);
  useEffect(() => {
    const st = ex.data?.steps ?? [];
    if (st[focusStep]?.kind === 'group') { const n = st.findIndex((x, k) => k > focusStep && x.kind !== 'group'); if (n >= 0) setFocusStep(n); }
  }, [ex.data, focusStep]);
  const keyHandler = useRef<(ev: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const on = (ev: KeyboardEvent) => keyHandler.current(ev);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  useEffect(() => {
    if (!ex.data) return;
    setStatus(ex.data.status);
    setComment(ex.data.comment ?? '');
    if (ex.data.dataset) {
      const map = Object.fromEntries((ex.data.iterations ?? []).map((i) => [i.index, { status: i.status, comment: i.comment ?? '', results: Object.fromEntries(i.stepResults.map((r) => [r.stepId, r])) }]));
      setIters(map);
      // beim ersten nicht bestandenen Durchlauf weitermachen
      const firstOpen = ex.data.dataset.rows.findIndex((_, k) => !map[k] || ['NOT_EXECUTED', 'WIP'].includes(map[k]!.status));
      const k = firstOpen < 0 ? 0 : firstOpen;
      setCur(k);
      setResults(map[k]?.results ?? {});
      setIterStatus(map[k]?.status ?? 'NOT_EXECUTED');
      setIterComment(map[k]?.comment ?? '');
    } else setResults(Object.fromEntries(ex.data.stepResults.map((r) => [r.stepId, r])));
    setExecFields({ ...((ex.data as { customFields?: Record<string, unknown> }).customFields ?? {}) });
    setFieldsDirty(false);
    setDirty(false);
  }, [ex.data]);

  if (!ex.data) return <div className="pane muted">{ex.error ? <ErrorNote error={ex.error} /> : 'Lädt …'}</div>;
  const e = ex.data;
  const ds = e.dataset;
  const values = ds ? Object.fromEntries(ds.columns.map((c, k) => [c, ds.rows[cur]?.[k] ?? ''])) : null;
  const catOf = (code: string) => statuses.find((x) => x.code === code)?.category ?? 'OPEN';
  /** Alle Durchläufe einschließlich des aktuellen (noch nicht übernommenen) */
  const allIters = () => ({ ...iters, [cur]: { status: iterStatus, comment: iterComment, results } });
  const usable = (code: string) => statuses.find((y) => y.code === code)?.appliesTo !== 'step';
  /** Gesamtergebnis aus den Durchläufen – gleiche Regel wie auf dem Server (schlechtestes zählt) */
  const overallFromIters = () => {
    if (!ds) return status;
    const all = allIters();
    return deriveOverall(ds.rows.map((_, k) => all[k]?.status ?? 'NOT_EXECUTED'), catOf, usable);
  };
  const switchIter = (k: number) => {
    if (!ds || k === cur || k < 0 || k >= ds.rows.length) return;
    const all = allIters();
    setIters(all);
    setCur(k);
    setResults(all[k]?.results ?? {});
    setIterStatus(all[k]?.status ?? 'NOT_EXECUTED');
    setIterComment(all[k]?.comment ?? '');
  };
  const stepStatus = (sid: string) => results[sid]?.status ?? 'NOT_EXECUTED';
  const suggest = (code: string) => (ds ? setIterStatus(code) : setStatus(code));
  const setStep = (sid: string, patch: Partial<StepResult>) => {
    setDirty(true);
    const next = { ...results, [sid]: { ...(results[sid] ?? { stepId: sid, status: 'NOT_EXECUTED' }), ...patch } };
    setResults(next);
    // Ergebnis vorschlagen (gleiche Regel wie auf dem Server): nur bei Statusänderung, nicht beim Tippen eines Befunds
    if (patch.status) suggest(deriveOverall(checkSteps(e.steps).map((s) => next[s.id!]?.status ?? 'NOT_EXECUTED'), catOf, usable));
  };
  const save = async (): Promise<boolean> => {
    try {
      setError(null);
      const finalStatus = ds ? overallFromIters() : status;
      const iterations = ds ? Object.entries(allIters()).map(([k, v]) => ({
        index: Number(k), status: v.status, comment: v.comment || null,
        stepResults: Object.values(v.results).filter((r) => r.status !== 'NOT_EXECUTED' || r.comment),
      })).filter((i) => i.status !== 'NOT_EXECUTED' || i.comment || i.stepResults.length) : undefined;
      // eigene Felder zuerst – das Ergebnis bezieht sich dann auf den neuen Stand
      let updatedAt: string | undefined = e.updatedAt;
      if (fieldsDirty) {
        await api('PUT', `/api/executions/${id}/fields`, { values: Object.fromEntries(execFieldDefs.map((d) => [d.key, execFields[d.key] ?? null])) });
        updatedAt = undefined;
        setFieldsDirty(false);
      }
      const ok = await postResult(id, {
        status: finalStatus, comment: comment || null,
        stepResults: ds ? undefined : Object.values(results).filter((r) => r.status !== 'NOT_EXECUTED' || r.comment),
        // OpenProject-Nummern bzw. Jira-Schlüssel – das System leitet der Server ab
        defects: defect.trim() ? defect.split(',').map((k) => k.trim()).filter(Boolean).map((k) => ({ key: k.replace(/^#/, '') })) : [],
        iterations, durationSeconds: timer.peek(), ...(updatedAt ? { expectedUpdatedAt: updatedAt } : {}),
      }, e.testCase.key);
      if (!ok) { toast('Nicht gespeichert – Begründung fehlt', 'info'); return false; }
      timer.take();
      if (ds) setStatus(finalStatus);
      setDefect('');
      setSaved(true);
      setDirty(false);
      setTimeout(() => setSaved(false), 1500);
      const shown = ds ? overallFromIters() : status;
      toast(`Ergebnis ${e.testCase.key} gespeichert: ${statuses.find((x) => x.code === shown)?.name ?? shown}`);
      notifyChanged('execution', id);
      ex.reload();
      onSaved();
      return true;
    } catch (err) {
      setError(err);
      toast([403, 409].includes((err as { status?: number }).status ?? 0) ? (err as Error).message : 'Speichern fehlgeschlagen', 'bad');
      return false;
    }
  };
  const saveAndNext = async () => { if (await save()) onNext?.(); };
  /** Fehler melden: ungespeicherte Ergebnisse vorher sichern, damit Befunde in die Meldung einfließen */
  const openDefect = async (stepId?: string) => {
    if (dirty) await save();
    setReporting(stepId ?? true);
  };
  const others = (history.data ?? []).filter((h) => h.id !== id).slice(0, 8);
  keyHandler.current = (ev: KeyboardEvent) => {
    if (!canExecute || document.querySelector('.modal-backdrop')) return;
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      void save();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && onNext) {
      ev.preventDefault();
      void saveAndNext();
      return;
    }
    const t = ev.target instanceof Element ? ev.target : null;
    if (ev.metaKey || ev.ctrlKey || ev.altKey || t?.closest('input, textarea, select, [contenteditable="true"]')) return;
    const move = (d: number) => {
      // nächster sichtbarer Prüfschritt (Abschnitte und zugeklappte Schritte werden übersprungen)
      let n = focusStep;
      for (let k = focusStep + d; k >= 0 && k < e.steps.length; k += d) if (e.steps[k]!.kind !== 'group' && !groups.hidden(k)) { n = k; break; }
      setFocusStep(n);
      document.querySelector(`[data-step-row="${n}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    const STATUS: Record<string, string> = { p: 'PASS', f: 'FAIL', b: 'BLOCKED', n: 'NOT_EXECUTED', w: 'WIP' };
    const k = ev.key.toLowerCase();
    if (k === 'j' || ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
    else if (k === 'k' || ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
    else if (STATUS[k] && e.steps[focusStep] && e.steps[focusStep]!.kind !== 'group') {
      ev.preventDefault();
      setStep(e.steps[focusStep]!.id!, { status: STATUS[k]! });
      if (k === 'p') move(1);
    } else if (k === 'c' && e.steps[focusStep]) {
      ev.preventDefault();
      (document.querySelector(`[data-step-row="${focusStep}"] .we-surface, [data-step-row="${focusStep}"] textarea`) as HTMLElement | null)?.focus();
    }
  };
  // Evidenzen hängen an der Ausführung und werden sofort gespeichert (auch ohne „Ergebnis speichern“)
  const uploadEvidence = async (file: File) => {
    const a = await uploadAttachment('TEST_EXECUTION', id, file);
    execAttachments.reload();
    return a;
  };

  return (
    <WikiAttachments attachments={[...(tcAttachments.data ?? []), ...(execAttachments.data ?? [])]}>
    <div className="pane stack">
      <div className="row">
        <a className="badge accent mono" href={href(['p', projectKey, 'repo'], { tc: e.testCase.key })} title={`Fassung vom ${fmtDate(e.version.createdAt)} (${e.version.createdBy})`}>{e.testCase.key}@v{e.version.versionNo}</a>
        {e.testCase.legacyKey && <span className="badge neutral mono">Jira {e.testCase.legacyKey}</span>}
        {/* Zum Testfall, ohne die Durchführung zu verlassen: ansehen im Dialog (Fassung dieser Ausführung), bearbeiten im eigenen Fenster */}
        <button className="small" onClick={() => setViewingTc(true)} title={`${e.testCase.key} ansehen – zeigt die Fassung v${e.version.versionNo} dieser Ausführung`}><Icon>📄</Icon>Testfall</button>
        {canEditTc && <FocusLink to={`/f/${projectKey}/testcase/${e.testCase.key}`} name="anemo-testfall" className="btn small"
          title={`${e.testCase.key} im eigenen Fenster bearbeiten – die Durchführung bleibt offen; laufende Ausführungen behalten ihre Fassung`}><Icon>✎</Icon>Testfall bearbeiten</FocusLink>}
        <span className="spacer" />
        <span className="small muted">{e.executedBy ? `zuletzt ${e.executedBy}, ${fmtDate(e.executedAt)}` : 'noch nicht ausgeführt'}</span>
        {canExecute && <span className="small muted" title="Bearbeitungszeit: bisher erfasst + diese Sitzung (zählt nur bei sichtbarem Fenster)">⏱ {fmtDuration((e.durationSeconds ?? 0) + timer.peek()) === '–' ? '0 s' : fmtDuration((e.durationSeconds ?? 0) + timer.peek())}</span>}
        {!focus && <FocusLink to={`/f/${projectKey}/run/${id}`} name="anemo-run" className="btn ghost small" title="Durchführung im eigenen Fenster – volle Fläche, Speichern &amp; weiter"><span aria-hidden="true">⧉ </span>Fenster</FocusLink>}
        {onToggleWide && <button className="ghost small" onClick={onToggleWide} title={wide ? 'Liste wieder breiter' : 'Durchführung breiter anzeigen'} aria-label={wide ? 'Liste wieder breiter' : 'Durchführung breiter anzeigen'} aria-pressed={!!wide}>{wide ? '⇥' : '⇤'}</button>}
        {onClose && <button className="ghost small" onClick={onClose} title="Durchführung schließen" aria-label="Durchführung schließen">✕</button>}
      </div>
      <h3>{e.version.title}</h3>
      {updatingVersion && <VersionUpdateDialog executionId={id} onClose={() => setUpdatingVersion(false)} onDone={() => { ex.reload(); onSaved(); }} />}
      {viewingTc && <Modal size="large" help="execute" title={`Testfall ${e.testCase.key}`} onClose={() => setViewingTc(false)}>
        <TestCaseView idOrKey={e.testCase.key} projectKey={projectKey} initialVersion={e.version.versionNo} onChanged={() => ex.reload()} />
      </Modal>}
      {(e as { reviewState?: string }).reviewState === 'pending' && (
        <div className="notice warn row"><span aria-hidden="true">🤖 </span>Ergebnis eines KI-Agenten ({e.executedBy}) – KI-Ergebnisprüfung ausstehend.<span className="spacer" />
          {!canEdit && <span className="small muted">Prüfung durch die Testleitung (Rolle „Pflegen“)</span>}
          {canEdit && <><button className="small" onClick={async () => { const note = await askText({ title: 'Agentenergebnis ablehnen', label: 'Begründung', multiline: true, confirmLabel: 'Ablehnen' }); if (note !== null) { try { await api('POST', `/api/executions/${id}/review`, { decision: 'reject', note }); toast('Agentenergebnis abgelehnt'); } catch (err) { setError(err); toast((err as Error).message, 'bad'); } ex.reload(); onSaved(); } }}>Ablehnen</button>
            <button className="small primary" onClick={async () => { try { await api('POST', `/api/executions/${id}/review`, { decision: 'approve' }); toast('Agentenergebnis bestätigt'); } catch (err) { setError(err); toast((err as Error).message, 'bad'); } ex.reload(); onSaved(); }}>Ergebnis bestätigen</button></>}
        </div>
      )}
      {(e as { reviewState?: string; reviewNote?: string }).reviewState === 'escalated' && <div className="notice bad">Vom Agenten eskaliert: {(e as { reviewNote?: string }).reviewNote}</div>}
      {e.version.versionNo !== e.testCase.currentVersion && (
        <div className="notice warn row">
          Diese Ausführung bezieht sich auf v{e.version.versionNo} (Fassung vom {fmtDate(e.version.createdAt)}); aktuell ist v{e.testCase.currentVersion}.
          {canExecute && cycleState.data?.state !== 'closed' && <button className="small" onClick={() => setUpdatingVersion(true)}
            title="Vorschau: was sich ändert und welche Ergebnisse bleiben">Auf v{e.testCase.currentVersion} umstellen …</button>}
        </div>
      )}
      {((e.preconditions?.length ?? 0) > 0 || e.version.preconditions) && <div className="stack" style={{ gap: 4 }}><h4>Vorbedingungen</h4>
        {(e.preconditions ?? []).map((p) => (
          <details key={p.id} className="precondition" open>
            <summary><span className="badge neutral mono">{p.key}</span> <b>{p.title}</b> <span className="small muted">v{p.versionNo}{(p as { currentVersion?: number }).currentVersion && (p as { currentVersion?: number }).currentVersion !== p.versionNo ? ` (Fassung beim Einplanen; aktuell v${(p as { currentVersion?: number }).currentVersion})` : ''}</span></summary>
            {p.content && <Wiki text={fillParams(p.content, values)} />}
          </details>
        ))}
        {e.version.preconditions && <Wiki text={fillParams(e.version.preconditions, values)} />}</div>}
      {e.version.format === 'GHERKIN' && e.version.gherkin && <details><summary>Gherkin-Szenario</summary><GherkinView text={e.version.gherkin} /></details>}

      {canExecute && e.steps.length > 0 && <details className="small muted kbd-help"><summary>⌨ Tastatur</summary> <kbd>j</kbd>/<kbd>k</kbd> Schritt wechseln · <kbd>p</kbd> bestanden (weiter) · <kbd>f</kbd> fehlgeschlagen · <kbd>b</kbd> blockiert · <kbd>n</kbd> zurücksetzen · <kbd>c</kbd> Kommentar · <kbd>Strg</kbd>+<kbd>S</kbd> speichern{onNext && <> · <kbd>Strg</kbd>+<kbd>Enter</kbd> speichern &amp; weiter</>} · <kbd>?</kbd> alle Kürzel</details>}
      {ds && (
        <div className="iterations" role="tablist" aria-label="Durchläufe">
          <span className="small muted">Durchläufe ({ds.rows.length}):</span>
          {ds.rows.map((row, k) => {
            const st = k === cur ? iterStatus : iters[k]?.status ?? 'NOT_EXECUTED';
            const s = statuses.find((x) => x.code === st);
            return (
              <button key={k} role="tab" aria-selected={k === cur} className={`chip-btn ${k === cur ? 'on' : ''}`} onClick={() => switchIter(k)}
                title={ds.columns.map((c, i) => `${c} = ${row[i]}`).join(', ')}>
                <span className="status-dot" style={{ background: s?.color ?? '#aaa' }} />{k + 1}: {row.join(' · ').slice(0, 40)}
              </button>
            );
          })}
        </div>
      )}
      {ds && <div className="row small muted">Datensatz {e.datasetSource === 'cycle' ? 'für diesen Zyklus angepasst' : e.datasetSource === 'plan' ? 'für den Testplan angepasst' : 'des Testfalls'}
        {canEdit && <button className="small link" onClick={() => setOverriding(true)} title="Andere Datenzeilen nur für diesen Zyklus bzw. Testplan – der Testfall bleibt unverändert">anpassen …</button>}</div>}
      {overriding && <DatasetOverrideDialog executionId={id} onClose={() => setOverriding(false)} onSaved={() => { setOverriding(false); ex.reload(); }} />}
      {ds && values && <div className="notice info small">Durchlauf {cur + 1} von {ds.rows.length}: {ds.columns.map((c) => <span key={c} style={{ marginRight: 10 }}><b>{c}</b> = {values[c]}</span>)}
        {cur < ds.rows.length - 1 && <button className="small ghost" onClick={() => switchIter(cur + 1)}>Nächster Durchlauf ›</button>}</div>}
      {e.version.format === 'PLAIN' && <section className="stack plain-instruction" aria-label="Testanweisung" style={{ gap: 4 }}><h4>Testanweisung</h4>
        {e.version.plainText?.trim() ? <div className="wiki-readonly"><Wiki text={fillParams(e.version.plainText, values)} /></div> : <div className="small muted">Keine Testanweisung hinterlegt.</div>}
        <div className="small muted">Freitext-Testfall – Ergebnis als Gesamtstatus mit Befund erfassen.</div></section>}
      {/* ohne overflow-Container, damit die schwebende Werkzeugleiste der Kommentarfelder nicht abgeschnitten wird */}
      {e.version.format !== 'PLAIN' && <GroupToggleAll groups={groups} />}
      {e.version.format !== 'PLAIN' && <div className="steps-edit"><table className="steps run-steps">
        <colgroup><col style={{ width: 36 }} /><col /><col /><col style={{ width: 'clamp(200px, 30%, 280px)' }} /></colgroup>
        <thead><tr><th>#</th><th>Aktion / Testdaten</th><th>Erwartet</th><th>Ergebnis</th></tr></thead>
        <tbody>{e.steps.map((s, i) => {
          if (s.kind === 'group') {
            const ids = (groups.members.get(i) ?? []).map((k) => e.steps[k]!.id!);
            const done = ids.filter((sid) => stepStatus(sid) !== 'NOT_EXECUTED').length;
            const bad = ids.filter((sid) => ['FAILED', 'BLOCKED'].includes(catOf(stepStatus(sid)))).length;
            const legacy = results[s.id!];
            return (
              <GroupRow key={s.id} step={s} index={i} groups={groups} cols={4}
                extra={ids.length > 0 && <span className={`small ${bad ? 'bad-text' : 'muted'}`} title="erfasste Schrittergebnisse in diesem Abschnitt">{done}/{ids.length} erledigt{bad ? ` · ${bad} mit Fehler` : ''}</span>}>
                {/* Alt-Ergebnis aus Zephyr auf dem früheren Trennschritt: nur zur Information, zählt nicht */}
                {legacy && (legacy.status !== 'NOT_EXECUTED' || legacy.comment) && <div className="small muted legacy-result">
                  Ergebnis aus Zephyr: <StatusBadge code={legacy.status} statuses={statuses} />{legacy.comment && <> – <Wiki text={legacy.comment} compact /></>}
                </div>}
              </GroupRow>
            );
          }
          if (groups.hidden(i)) return null;
          const no = groups.numbers[i]!;
          return (<Fragment key={s.id}>
          {s.origin && s.origin.key !== e.steps[i - 1]?.origin?.key && <tr className="origin-row"><td colSpan={4}>↪ aufgerufen: <b>{s.origin.key}</b> „{s.origin.title}“ <span className="muted">v{s.origin.versionNo}</span></td></tr>}
          <tr data-step-row={i} className={`${canExecute && i === focusStep ? 'kbd-focus' : ''} ${s.origin ? 'from-call' : ''}`} onClick={() => setFocusStep(i)}>
            <td className="n">{no}</td>
            <td><Wiki text={fillParams(s.action, values)} />{s.data && <div className="small muted"><Wiki text={fillParams(s.data, values)} /></div>}
              {(tcAttachments.data ?? []).filter((a) => (a as { stepId?: string | null }).stepId === s.id).map((a) => <a key={a.id} className="chip" href={`/api/attachments/${a.id}/content`} target="_blank" rel="noreferrer noopener">📎 {a.fileName}</a>)}</td>
            <td><Wiki text={fillParams(s.expected, values)} /></td>
            <td>
              {results[s.id!]?.previous && <div className="small muted prev-result">vor Umstellung (v{results[s.id!]!.previous!.versionNo}): <StatusBadge code={results[s.id!]!.previous!.status} statuses={statuses} />
                {results[s.id!]!.previous!.comment && <> – <Wiki text={results[s.id!]!.previous!.comment!} compact /></>}</div>}
              <StatusButtons small compact label={`Status Schritt ${no}`} value={stepStatus(s.id!)} onChange={(c) => setStep(s.id!, { status: c })} statuses={statuses.filter((x) => (x.active && x.appliesTo !== 'execution') || x.code === stepStatus(s.id!))} />
              <div style={{ marginTop: 4 }}>
                <WikiEditor compact minRows={3} value={results[s.id!]?.comment ?? ''} onChange={(v) => setStep(s.id!, { comment: v })}
                  upload={canExecute ? uploadEvidence : undefined} placeholder="Tatsächliches Ergebnis / Beobachtung, Screenshot (Strg+V)" label={`Kommentar Schritt ${no}`} />
              </div>
              {((execAttachments.data ?? []).some((a) => (a as { stepId?: string | null }).stepId === s.id) || e.defects.some((d) => d.stepId === s.id)) && <div className="step-atts">
                {(execAttachments.data ?? []).filter((a) => (a as { stepId?: string | null }).stepId === s.id).map((a) => <a key={a.id} className="chip" href={`/api/attachments/${a.id}/content`} target="_blank" rel="noreferrer noopener"><span aria-hidden="true">📎 </span>{a.fileName}</a>)}
                {e.defects.filter((d) => d.stepId === s.id).map((d) => (
                  <span key={d.id} className="step-defect-badge" title={[d.title, d.status].filter(Boolean).join(' – ')}>
                    <span aria-hidden="true">🐞 </span>{d.url ? <a href={d.url} target="_blank" rel="noreferrer noopener" onClick={(ev) => ev.stopPropagation()}>{refLabel(d)}</a> : refLabel(d)}
                    {d.severity && <> <SeverityBadge value={d.severity} /></>}
                  </span>
                ))}
              </div>}
              {canExecute && cycleState.data?.state !== 'closed' && <ToolRow label={`Aktionen zu Schritt ${no}`}>
                <ToolFileButton ariaLabel={`Evidenz zu Schritt ${no} anhängen`} title="Datei als Evidenz zu diesem Schritt anhängen"
                  onFiles={async (fs) => { for (const f of fs) await uploadAttachment('TEST_EXECUTION', id, f, s.id).catch(setError); execAttachments.reload(); }}>Anhang</ToolFileButton>
                <ToolButton icon="🐞" attention={['FAILED', 'BLOCKED'].includes(catOf(stepStatus(s.id!)))} onClick={() => void openDefect(s.id!)}
                  title="Fehlermeldung zu diesem Schritt aus Vorlage – speichert vorher das Ergebnis" ariaLabel={`Fehler zu Schritt ${no} melden`}>Fehler melden</ToolButton>
                <ToolButton icon="🔗" onClick={() => setLinking(s.id!)} title="Vorhandenes Ticket oder einen Link als Fehler zu diesem Schritt verknüpfen" ariaLabel={`Fehler mit Schritt ${no} verknüpfen`}>Verknüpfen</ToolButton>
              </ToolRow>}
            </td>
          </tr>
        </Fragment>);
        })}</tbody>
      </table>{e.steps.length === 0 && <div className="empty">Keine Schritte – Gesamtergebnis direkt setzen.</div>}</div>}

      <div className="stack">
        {ds && <>
          <h4>Ergebnis Durchlauf {cur + 1}</h4>
          <StatusButtons compact label={`Ergebnis Durchlauf ${cur + 1}`} value={iterStatus} onChange={(c) => { setIterStatus(c); setDirty(true); }} statuses={statuses.filter((x) => (x.active && x.appliesTo !== 'step') || x.code === iterStatus)} />
          <textarea rows={2} placeholder={`Befund zu Durchlauf ${cur + 1} (optional)`} value={iterComment} onChange={(ev) => { setIterComment(ev.target.value); setDirty(true); }} aria-label={`Befund Durchlauf ${cur + 1}`} />
        </>}
        <h4>Gesamtergebnis</h4>
        {ds
          ? <div className="row small" aria-label="Gesamtergebnis"><StatusBadge code={overallFromIters()} statuses={statuses} /><span className="muted">ergibt sich aus den Durchläufen (schlechtestes Ergebnis zählt)</span></div>
          : <StatusButtons compact label="Gesamtergebnis" value={status} onChange={(c) => { setStatus(c); setDirty(true); }} statuses={statuses.filter((x) => (x.active && x.appliesTo !== 'step') || x.code === status)} />}
        <WikiEditor value={comment} onChange={(v) => { setComment(v); setDirty(true); }} upload={canExecute ? uploadEvidence : undefined} minRows={8} label="Befund / Kommentar zur Ausführung"
          placeholder="Kommentar / Beobachtung – Screenshots per Einfügen (Strg+V) oder Ablegen" />
        {canExecute && cycleState.data?.state !== 'closed' && <ToolRow label="Aktionen zum Ergebnis">
          <ToolFileButton ariaLabel="Evidenz zur Ausführung anhängen" title="Datei als Evidenz zur Ausführung anhängen"
            onFiles={async (fs) => { for (const f of fs) await uploadEvidence(new File([f], uniqueFileName(f, (execAttachments.data ?? []).map((a) => a.fileName)), { type: f.type })).catch(setError); }}>Anhang</ToolFileButton>
          <ToolButton icon="🐞" attention={['FAILED', 'BLOCKED', 'KNOWN_FAILURE'].includes(catOf(ds ? overallFromIters() : status))} onClick={() => void openDefect()}
            title="Fehlermeldung aus Vorlage – speichert vorher das Ergebnis">Fehler melden</ToolButton>
          <ToolButton icon="🔗" onClick={() => setLinking(true)} title="Vorhandenes Ticket oder einen Link als Fehler verknüpfen">Fehler verknüpfen</ToolButton>
        </ToolRow>}
        {canExecute && ['FAILED', 'BLOCKED', 'KNOWN_FAILURE'].includes(catOf(ds ? overallFromIters() : status)) && !comment.trim() && !e.defects.length && (
          <div className="small muted">{catOf(ds ? overallFromIters() : status) === 'KNOWN_FAILURE'
            ? 'Ein bekannter Fehler braucht einen Verweis: Ticket verknüpfen oder den Befund beschreiben.'
            : `Für „${statuses.find((x) => x.code === (ds ? overallFromIters() : status))?.name}“ bitte das tatsächliche Ergebnis beschreiben oder einen Fehler melden/verknüpfen.`}</div>
        )}
        {cycleState.data?.state === 'closed' && <div className="notice warn small">Der Zyklus ist abgeschlossen – Ergebnisse sind gesperrt. Wieder öffnen über „⋯ Mehr → Zyklus wieder öffnen“.</div>}
        <details className="small" onToggle={(ev) => setHistoryOpen((ev.target as HTMLDetailsElement).open)}>
          <summary>Verlauf der Ergebnisse</summary>
          {results_.data && (results_.data.length === 0 ? <div className="muted">Noch keine Ergebnisse gespeichert.</div> : (
            <ul className="result-history">{results_.data.map((r) => (
              <li key={r.id}><StatusBadge code={r.status} statuses={statuses} /> {fmtDate(r.recordedAt)} · {r.recordedBy}{r.note && <> · Begründung: {r.note}</>}{r.comment && <div className="muted">{r.comment.slice(0, 160)}</div>}</li>
            ))}</ul>
          ))}
        </details>
        <div className={`row ${focus ? 'exec-actions' : ''}`}>
          <span className="spacer" />
          {canExecute ? <>
            {dirty && <span className="small muted">ungespeichert</span>}
            <button className={onNext ? '' : 'primary'} onClick={save} title="Strg+S">{saved ? 'Gespeichert ✓' : 'Ergebnis speichern'}</button>
            {onNext && <button className="primary" onClick={saveAndNext} title="Strg+Enter">Speichern &amp; weiter ›</button>}
          </> : <span className="small muted">Nur Lesen – Ausführen erfordert die Rolle „Ausführen“.</span>}
        </div>
        {linking && <LinkDefectDialog title={linking === true ? 'Fehler verknüpfen' : `Fehler mit Schritt ${e.steps.findIndex((x) => x.id === linking) + 1} verknüpfen`}
          onClose={() => setLinking(false)} onSubmit={async (d) => {
            try {
              await api('POST', '/api/references', { ownerType: 'TEST_EXECUTION', ownerId: id, relation: 'DEFECT', externalKey: d.key, ...(d.provider ? { provider: d.provider } : {}),
                ...(d.title ? { title: d.title } : {}), ...(linking !== true ? { stepId: linking } : {}) });
              toast(`${d.title ?? d.key} verknüpft`);
              setLinking(false);
              ex.reload();
              onSaved();
            } catch (err) { toast((err as Error).message, 'bad'); }
          }} />}
        {reporting && <DefectDialog executionId={id} projectKey={projectKey} steps={e.steps} initialStepId={reporting === true ? undefined : reporting}
          failedStepIds={e.steps.filter((s) => ['FAILED', 'BLOCKED'].includes(statuses.find((x) => x.code === stepStatus(s.id!))?.category ?? '')).map((s) => s.id!)}
          onClose={() => setReporting(false)} onLinked={async () => { setReporting(false); if (dirty) await save(); else ex.reload(); onSaved(); }} />}
        {e.defects.length > 0 && <div className="small">Fehler: {e.defects.map((d) => (
          <span key={d.id} className="exec-defect">{d.url ? <a href={d.url} target="_blank" rel="noreferrer noopener" title={[d.title, d.status].filter(Boolean).join(' – ')}>{refLabel(d)}</a> : refLabel(d)}{d.status && <span className="muted"> ({d.status})</span>}
            {d.severity && <> <SeverityBadge value={d.severity} /></>}
            {d.stepId && e.steps.some((x) => x.id === d.stepId) && <span className="muted"> · Schritt {e.steps.findIndex((x) => x.id === d.stepId) + 1}</span>}
            {' '}<a href={searchHref(d.externalKey, { types: 'reference' })} title="Alle Stellen mit diesem Fehler" aria-label={`Alle Stellen mit ${d.externalKey} suchen`}><span aria-hidden="true">🔎</span></a>{'  '}</span>
        ))}</div>}
        <ErrorNote error={error} />
      </div>

      {execFieldDefs.length > 0 && <div className="stack"><h4>Felder der Ausführung</h4>
        <FieldInputs compact defs={execFieldDefs} values={execFields} onChange={(v) => { setExecFields(v); setFieldsDirty(true); setDirty(true); }} /></div>}

      {((execAttachments.data?.length ?? 0) > 0 || canExecute) && (
        <div className="stack">
          <div className="row"><h4>Evidenzen / Anhänge ({execAttachments.data?.length ?? 0})</h4>
            {canExecute && <label className="btn small" style={{ cursor: 'pointer' }}>+ Datei<input type="file" multiple hidden
              onChange={async (ev) => { const fs = [...(ev.target.files ?? [])]; ev.target.value = ''; for (const f of fs) await uploadEvidence(new File([f], uniqueFileName(f, (execAttachments.data ?? []).map((a) => a.fileName)), { type: f.type })).catch(setError); }} /></label>}
          </div>
          <div className="evidence">
            {(execAttachments.data ?? []).map((a) => (
              <span key={a.id} className="evidence-wrap">
                <a href={`/api/attachments/${a.id}/content`} target="_blank" rel="noreferrer noopener" className="evidence-item" title={a.fileName}>
                  {/\.(png|jpe?g|gif|webp)$/i.test(a.fileName) ? <img src={`/api/attachments/${a.id}/content`} alt={a.fileName} loading="lazy" /> : <span>📎</span>}
                  <span className="small">{a.fileName}</span>
                </a>
                {canExecute && cycleState.data?.state !== 'closed' && <button className="evidence-x" aria-label={`Evidenz ${a.fileName} löschen`} title="Evidenz löschen" onClick={async () => {
                  if (!(await askConfirm({ title: 'Evidenz löschen', message: `„${a.fileName}“ endgültig löschen?`, confirmLabel: 'Löschen', danger: true }))) return;
                  try { await api('DELETE', `/api/attachments/${a.id}`); execAttachments.reload(); toast('Evidenz gelöscht'); } catch (err) { setError(err); }
                }}>✕</button>}
              </span>
            ))}
          </div>
        </div>
      )}

      {others.length > 0 && (
        <div className="stack">
          <h4>Dieser Test in anderen Kontexten</h4>
          <div className="table-wrap"><table><tbody>{others.map((h) => (
            <tr key={h.id} className="clickable" onClick={() => navigate(['p', projectKey, 'cycles', h.cycleId], { exec: h.id })}>
              <td><a href={href(['p', projectKey, 'cycles', h.cycleId], { exec: h.id })} onClick={(ev) => ev.stopPropagation()}>{h.cycleName}</a></td><td className="small">{h.release ?? '–'}</td><td className="small">v{h.versionNo}</td>
              <td><StatusBadge code={h.status} statuses={statuses} /></td><td className="small">{fmtDate(h.executedAt)}</td>
            </tr>
          ))}</tbody></table></div>
        </div>
      )}
    </div>
    </WikiAttachments>
  );
}

// ---------------------------------------------------------------------------------------------
// Konfiguration: Filter-Kodierung und Auswertung
// ---------------------------------------------------------------------------------------------

/** URL-Parameter "database:Oracle,client:Desktop" ⇄ Configuration */
function parseCfg(v: string): Configuration {
  const out: Configuration = {};
  for (const part of v.split(',').filter(Boolean)) {
    const i = part.indexOf(':');
    if (i > 0) (out[part.slice(0, i)] ??= []).push(part.slice(i + 1));
  }
  return out;
}
const formatCfg = (c: Configuration) => Object.entries(c).flatMap(([k, vs]) => vs.map((v) => `${k}:${v}`)).join(',');

/** Ergebnisse je Merkmalswert – z. B. "Wie schlägt sich Oracle gegenüber SQL Server?" */
function ConfigurationResults({ projectKey, planId, statuses }: { projectKey: string; planId: string | undefined; statuses: ExecutionStatus[] }) {
  const dims = useDimensions();
  const stats = useApi<{ dimension: string; value: string; cycles: number; byStatus: Record<string, number> }[]>(
    `/api/projects/${projectKey}/configuration-stats${planId ? `?planId=${planId}` : ''}`);
  if (!stats.data) return <div className="muted">Lädt …</div>;
  if (!stats.data.length) return <div className="empty">Keine Zyklen mit erkannter Konfiguration.</div>;
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>Ausführungen je Merkmalswert. Ein Zyklus mit mehreren Werten (z. B. „SQL+ORA“) zählt bei jedem Wert. Fehlerquote = (nicht bestanden + blockiert) / ausgeführt.</p>
      {dims.map((d) => {
        const rows = stats.data!.filter((s) => s.dimension === d.key);
        if (!rows.length) return null;
        return (
          <div key={d.key} className="card"><div className="card-body stack">
            <h3>{d.name}</h3>
            <div className="table-wrap"><table>
              <thead><tr><th>Wert</th><th>Zyklen</th><th>Ausführungen</th><th style={{ width: 260 }}>Ergebnisse</th><th>Fehlerquote</th></tr></thead>
              <tbody>{rows.sort((a, b) => b.cycles - a.cycles).map((r) => {
                const total = Object.values(r.byStatus).reduce((a, b) => a + b, 0);
                const executed = total - (r.byStatus.NOT_EXECUTED ?? 0);
                const bad = (r.byStatus.FAIL ?? 0) + (r.byStatus.BLOCKED ?? 0);
                const rate = executed ? (100 * bad) / executed : 0;
                return (
                  <tr key={r.value} className="clickable" onClick={() => navigate(['p', projectKey, 'cycles'], { plan: planId ?? null, cfg: `${d.key}:${r.value}` })}>
                    <td><a href={href(['p', projectKey, 'cycles'], { plan: planId ?? null, cfg: `${d.key}:${r.value}` })} onClick={(ev) => ev.stopPropagation()}>{r.value}</a></td><td>{r.cycles}</td><td>{total}</td>
                    <td><Progress byStatus={r.byStatus} statuses={statuses} total={total} /></td>
                    <td className={rate >= 20 ? 'rate-bad' : ''}>{executed ? `${rate.toFixed(1)} %` : '–'}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          </div></div>
        );
      })}
    </div>
  );
}

/** Datensatz nur für diesen Zyklus bzw. Testplan anpassen (Zyklus vor Plan vor Testfall). */
function DatasetOverrideDialog({ executionId, onClose, onSaved }: { executionId: string; onClose: () => void; onSaved: () => void }) {
  const d = useApi<{ testCase: Dataset | null; plan: Dataset | null; cycle: Dataset | null; planId: string | null; cycleId: string; testCaseId: string }>(`/api/executions/${executionId}/datasets`);
  const [scope, setScope] = useState<'cycle' | 'plan'>('cycle');
  const [value, setValue] = useState<Dataset | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  if (!d.data) return null;
  const data = d.data;
  const existing = scope === 'cycle' ? data.cycle : data.plan;
  const current = value === undefined ? existing ?? (scope === 'cycle' ? data.plan : null) ?? data.testCase : value;
  const save = async (dataset: Dataset | null) => {
    try {
      await api('PUT', '/api/dataset-overrides', { scope, scopeId: scope === 'cycle' ? data.cycleId : data.planId, testCaseId: data.testCaseId, dataset });
      toast(dataset ? `Datensatz für ${scope === 'cycle' ? 'diesen Zyklus' : 'den Testplan'} gespeichert` : 'Anpassung entfernt');
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal size="large" title="Datensatz anpassen" onClose={onClose}
      footer={<>{existing && <button className="ghost danger" onClick={async () => { if (await askConfirm({ title: 'Anpassung entfernen', message: `Danach gilt wieder der Datensatz ${scope === 'cycle' ? 'des Testplans bzw. Testfalls' : 'des Testfalls'}. Bereits erfasste Durchläufe behalten ihre Werte.`, confirmLabel: 'Entfernen', danger: true })) void save(null); }}>Anpassung entfernen …</button>}<span className="spacer" />
        <button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!current?.rows.length} title={current?.rows.length ? undefined : 'Mindestens eine Datenzeile'} onClick={() => save(current ?? null)}>Speichern</button></>}>
      <ErrorNote error={error} />
      <p className="small muted">Der Testfall bleibt unverändert. Anpassungen gelten für alle Ausführungen dieses Testfalls im gewählten Zyklus bzw. Testplan;
        der Zyklus hat Vorrang vor dem Plan. Bereits erfasste Durchläufe behalten ihre Werte.</p>
      <div className="row" role="radiogroup" aria-label="Geltungsbereich">
        <label className="row small"><input type="radio" name="dataset-scope" value="cycle" style={{ width: 'auto' }} checked={scope === 'cycle'} onChange={() => { setScope('cycle'); setValue(undefined); }} /> nur dieser Zyklus{data.cycle ? ' (angepasst)' : ''}</label>
        <label className="row small"><input type="radio" name="dataset-scope" value="plan" style={{ width: 'auto' }} checked={scope === 'plan'} disabled={!data.planId} onChange={() => { setScope('plan'); setValue(undefined); }} /> ganzer Testplan{data.plan ? ' (angepasst)' : ''}{!data.planId ? ' – Zyklus hat keinen Plan' : ''}</label>
      </div>
      <DatasetEditor value={current} onChange={(v) => setValue(v)} />
    </Modal>
  );
}
