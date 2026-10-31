/**
 * Fokusfenster (#/f/…): einzelne Aufgaben mit maximaler Fläche – Durchführung, Testfall bearbeiten, Testplan und
 * Testzyklus pflegen. Ohne Hauptnavigation; im eigenen Fenster mit „Schließen“, sonst mit „Zurück“.
 */
import { type ReactNode, useEffect, useMemo } from 'react';
import { useApi } from '../api.ts';
import { StatusBadge, useStatuses } from '../components/common.tsx';
import { href, navigate, type Route } from '../router.ts';
import type { ExecutionStatus } from '../types.ts';
import { confirmLeave, inPopup, usePageTitle, useSync } from '../ux.tsx';
import { ExecutionPanel } from './Cycles.tsx';
import { CycleFormPage, PlanFormPage, TestCaseEditPage } from './FocusForms.tsx';
import { SessionWorkspace, useSessionMeta } from '../components/Sessions.tsx';
import { BrandMark } from '../components/Brand.tsx';
import { HelpPanel, HelpToggle } from '../components/HelpPanel.tsx';

export function FocusFrame({ crumbs, title, back, right, children }: { crumbs: ReactNode[]; title: string; back: string; right?: ReactNode; children: ReactNode }) {
  usePageTitle(title);
  const popup = inPopup();
  return (
    <div className="focus-app">
      <header className="focus-bar">
        <BrandMark size={22} />
        <nav className="crumbs" aria-label="Pfad">{crumbs.map((c, i) => <span key={i} className="row" style={{ gap: 6 }}>{i > 0 && '›'}{c}</span>)}</nav>
        <span className="spacer" />
        {right}
        <HelpToggle />
        {popup
          ? <button className="small" onClick={async () => { if (await confirmLeave()) window.close(); }} title="Fenster schließen (Esc im Hauptfenster bleibt erhalten)">Schließen</button>
          : <a className="btn small" href={back} onClick={async (e) => { e.preventDefault(); if (await confirmLeave()) window.location.hash = back.replace(/^#/, ''); }}>‹ Zurück</a>}
      </header>
      <div className="app-row"><main className="focus-main">{children}</main><HelpPanel /></div>
    </div>
  );
}

export function FocusApp({ route }: { route: Route }) {
  const [, projectKey, kind, id] = route.path;
  if (!projectKey || !kind) return <div className="empty">Unbekannte Ansicht</div>;
  if (kind === 'run' && id) return <RunPage projectKey={projectKey} execId={id} />;
  if (kind === 'cycle-run' && id) return <CycleRunStart projectKey={projectKey} cycleId={id} />;
  if (kind === 'session' && id) return <SessionPage projectKey={projectKey} sessionId={id} />;
  if (kind === 'testcase') return <TestCaseEditPage projectKey={projectKey} tcKey={id === 'new' ? null : id ?? null} folderId={route.query.get('folder')} />;
  if (kind === 'plan') return <PlanFormPage projectKey={projectKey} planId={id === 'new' ? null : id ?? null} />;
  if (kind === 'cycle') return <CycleFormPage projectKey={projectKey} cycleId={id === 'new' ? null : id ?? null} defaultPlanId={route.query.get('plan')} />;
  return <div className="empty">Unbekannte Ansicht</div>;
}

interface RunItem { id: string; testCaseKey: string; title: string; status: string }

/** Durchführung im Fokus: Fortschritt im Zyklus, vorige/nächste, „Speichern & weiter“ zur nächsten offenen. */
function RunPage({ projectKey, execId }: { projectKey: string; execId: string }) {
  const statuses = useStatuses();
  const ex = useApi<{ cycleId: string; testCase: { key: string } }>(`/api/executions/${execId}`);
  const cycle = useApi<{ name: string; planName: string | null; build: string | null }>(ex.data ? `/api/cycles/${ex.data.cycleId}` : null);
  const list = useApi<{ items: RunItem[] }>(ex.data ? `/api/cycles/${ex.data.cycleId}/executions?limit=1000&sort=order` : null);
  useSync(['execution'], () => list.reload());
  const items = list.data?.items ?? [];
  const idx = items.findIndex((i) => i.id === execId);
  const open = (s: string) => ['OPEN', 'IN_PROGRESS'].includes(statuses.find((x) => x.code === s)?.category ?? 'OPEN');
  const done = items.filter((i) => !open(i.status)).length;
  const nextOpen = useMemo(() => {
    for (let k = 1; k <= items.length; k++) {
      const c = items[(idx + k) % items.length];
      if (c && c.id !== execId && open(c.status)) return c;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, idx, execId, statuses]);
  const go = async (target: RunItem | null | undefined) => {
    if (target && (await confirmLeave())) navigate(['f', projectKey, 'run', target.id]);
  };
  const cycleHref = ex.data ? href(['p', projectKey, 'cycles', ex.data.cycleId], { exec: execId }) : href(['p', projectKey, 'cycles']);
  return (
    <FocusFrame
      title={`${ex.data?.testCase.key ?? 'Durchführung'} · ${cycle.data?.name ?? ''}`}
      back={cycleHref}
      crumbs={[<span key="p">{projectKey}</span>, cycle.data?.planName && <span key="pl">{cycle.data.planName}</span>,
        <a key="c" href={cycleHref} target={inPopup() ? '_blank' : undefined} rel="noreferrer">{cycle.data?.name ?? '…'}</a>,
        <strong key="t">{ex.data?.testCase.key}</strong>].filter(Boolean) as ReactNode[]}
      right={items.length > 0 && <>
        <span className="small muted" title="erledigt / gesamt im Zyklus">{done} / {items.length} erledigt</span>
        <div className="progress" style={{ width: 120 }}><span style={{ flex: done, background: 'var(--ok)' }} /><span style={{ flex: items.length - done }} /></div>
        <button className="small" disabled={idx <= 0} onClick={() => go(items[idx - 1])} title="Vorige Ausführung" aria-label="Vorige Ausführung">‹</button>
        <span className="small">{idx + 1}/{items.length}</span>
        <button className="small" disabled={idx < 0 || idx >= items.length - 1} onClick={() => go(items[idx + 1])} title="Nächste Ausführung" aria-label="Nächste Ausführung">›</button>
        {nextOpen && <button className="small" onClick={() => go(nextOpen)} title={`Nächste offene: ${nextOpen.testCaseKey}`}>Nächste offene ›</button>}
      </>}>
      <div className="focus-page">
        <ExecutionPanel key={execId} id={execId} statuses={statuses} projectKey={projectKey} focus onSaved={() => list.reload()}
          onNext={nextOpen ? () => navigate(['f', projectKey, 'run', nextOpen.id]) : undefined} />
        {items.length > 0 && items.every((i) => !open(i.status)) && <div className="notice ok">Alle Ausführungen dieses Zyklus sind erledigt. ✓</div>}
        <RunList items={items} current={execId} statuses={statuses} onPick={go} />
      </div>
    </FocusFrame>
  );
}

function RunList({ items, current, statuses, onPick }: { items: RunItem[]; current: string; statuses: ExecutionStatus[]; onPick: (i: RunItem) => void }) {
  if (items.length < 2) return null;
  return (
    <details className="card"><summary className="card-body" style={{ cursor: 'pointer' }}><strong>Alle Ausführungen des Zyklus</strong> <span className="small muted">({items.length})</span></summary>
      <div className="table-wrap" style={{ maxHeight: 360, margin: '0 12px 12px' }}><table><tbody>
        {items.map((i) => (
          <tr key={i.id} className={`clickable ${i.id === current ? 'selected' : ''}`} onClick={() => onPick(i)}>
            <td className="fit mono small">{i.testCaseKey}</td><td>{i.title}</td><td className="fit"><StatusBadge code={i.status} statuses={statuses} /></td>
          </tr>
        ))}
      </tbody></table></div>
    </details>
  );
}

/** Einstieg „Zyklus durchführen“: springt zur ersten offenen Ausführung (sonst zur ersten überhaupt). */
function CycleRunStart({ projectKey, cycleId }: { projectKey: string; cycleId: string }) {
  const statuses = useStatuses();
  const list = useApi<{ items: RunItem[] }>(`/api/cycles/${cycleId}/executions?limit=1000&sort=order`);
  useEffect(() => {
    if (!list.data || !statuses.length) return;
    const isOpen = (s: string) => ['OPEN', 'IN_PROGRESS'].includes(statuses.find((x) => x.code === s)?.category ?? 'OPEN');
    const target = list.data.items.find((i) => isOpen(i.status)) ?? list.data.items[0];
    if (target) window.location.replace(href(['f', projectKey, 'run', target.id]));
  }, [list.data, statuses, projectKey]);
  if (list.data && list.data.items.length === 0) return <div className="empty">Dieser Zyklus enthält noch keine Tests. <a href={href(['p', projectKey, 'cycles', cycleId])}>Zum Zyklus</a></div>;
  return <div className="empty">{list.error ? 'Zyklus nicht gefunden.' : 'Lädt …'}</div>;
}

/** Explorative Sitzung im Fokusfenster. */
function SessionPage({ projectKey, sessionId }: { projectKey: string; sessionId: string }) {
  const s = useSessionMeta(sessionId);
  const back = s.data ? href(['p', projectKey, 'cycles', s.data.cycleId]) : href(['p', projectKey, 'cycles']);
  return (
    <FocusFrame title={`Sitzung · ${s.data?.charter.slice(0, 40) ?? ''}`} back={back}
      crumbs={[<span key="p">{projectKey}</span>, s.data?.planName && <span key="pl">{s.data.planName}</span>,
        <a key="c" href={back} target={inPopup() ? '_blank' : undefined} rel="noreferrer">{s.data?.cycleName ?? '…'}</a>, <strong key="t">Explorative Sitzung</strong>].filter(Boolean) as ReactNode[]}>
      <div className="focus-page wide"><SessionWorkspace projectKey={projectKey} sessionId={sessionId} /></div>
    </FocusFrame>
  );
}
