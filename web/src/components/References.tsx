import { useEffect, useState } from 'react';
import { api, useApi } from '../api.ts';
import { type Reference, SEVERITIES } from '../types.ts';
import { ErrorNote, Modal } from './common.tsx';
import { searchHref } from './Search.tsx';
import { SeverityBadge } from './Severity.tsx';
import { isUrl, linkTitle as shownTitle, UrlLinkFields, useLinkSettings } from './LinkInput.tsx';
import { ActionMenu, askConfirm, toast } from '../ux.tsx';
import { defectResolution } from '../../../shared/status/resolution.ts';
import { href } from '../router.ts';
import { useSession } from '../session.tsx';

type OwnerType = 'TEST_CASE' | 'TEST_CYCLE' | 'TEST_PLAN' | 'TEST_EXECUTION';
export const RELATION_LABEL: Record<string, string> = {
  REQUIREMENT: 'Anforderung', STORY: 'Story (Anwenderanforderung)', EPIC: 'Epic (übergeordnetes Vorhaben)', DEFECT: 'Fehler', SUBTASK: 'Unteraufgabe', RELATED: 'Bezug',
  AUTOMATION: 'Automatisierung', DOCUMENTATION: 'Dokumentation',
};
const PROVIDER_LABEL: Record<string, string> = { openproject: 'OpenProject', jira: 'Jira', gitlab: 'GitLab', automation: 'Automatisierung', url: 'Link' };
/** Anzeigename eines Verweises: Kurzname bei freien Links, #Nummer bei OpenProject, !MR bzw. @Commit bei GitLab, sonst der Schlüssel. */
export const refLabel = (r: { provider: string; externalKey: string; title?: string | null }) =>
  r.provider === 'url' ? r.title || r.externalKey : r.provider === 'openproject' && /^\d+$/.test(r.externalKey) ? `#${r.externalKey}` : r.provider === 'gitlab' ? r.externalKey.replace(/^.*?([!@])/, '$1') : r.externalKey;
const shortKey = refLabel;
const URL_STATUS = ['offen', 'behoben', 'abgelehnt'] as const;

/** Verweise eines QA-Objekts auf Tickets (OpenProject, Jira) – anzeigen, verknüpfen, lösen. */
export function References({ ownerType, ownerId, projectKey, canEdit, compact }: { ownerType: OwnerType; ownerId: string; projectKey: string; canEdit: boolean; compact?: boolean }) {
  const refs = useApi<Reference[]>(`/api/references?ownerType=${ownerType}&ownerId=${ownerId}`);
  const [linking, setLinking] = useState(false);
  // dasselbe Ticket an mehreren Schritten: eine Zeile (mit allen Einträgen zum Lösen)
  const merged = Object.values((refs.data ?? []).reduce<Record<string, Reference & { ids: string[]; steps: number }>>((a, r) => {
    const k = `${r.relation}|${r.provider}|${r.externalKey}`;
    const m = a[k];
    if (m) { m.ids.push(r.id); if (r.stepId) m.steps++; } else a[k] = { ...r, ids: [r.id], steps: r.stepId ? 1 : 0 };
    return a;
  }, {}));
  const byRelation = merged.reduce<Record<string, Reference[]>>((a, r) => ((a[r.relation] ??= []).push(r), a), {});
  async function remove(r: Reference) {
    if (!(await askConfirm({ title: 'Verknüpfung lösen', message: `Verknüpfung mit ${shortKey(r)} lösen? ${r.provider === 'url' ? 'Die verlinkte Seite' : 'Das Ticket'} selbst bleibt unverändert.`, confirmLabel: 'Lösen', danger: true }))) return;
    try {
      for (const id of (r as Reference & { ids?: string[] }).ids ?? [r.id]) await api('DELETE', `/api/references/${id}`);
      toast(`Verknüpfung mit ${shortKey(r)} gelöst`);
    } catch (e) {
      toast(`Lösen fehlgeschlagen: ${(e as Error).message}`, 'bad');
    }
    refs.reload();
  }
  async function setLinkStatus(r: Reference, status: string) {
    try {
      await api('PATCH', `/api/references/${r.id}`, { status });
      toast(`${shortKey(r)}: ${status}`);
    } catch (e) {
      toast(`Status nicht gespeichert: ${(e as Error).message}`, 'bad');
    }
    refs.reload();
  }
  async function setSeverity(r: Reference, severity: string) {
    try {
      await api('PATCH', `/api/references/${r.id}`, { severity: severity || null });
      toast(severity ? `Schweregrad ${shortKey(r)}: ${severity}` : `Schweregrad ${shortKey(r)} entfernt`);
    } catch (e) {
      toast(`Schweregrad nicht gespeichert: ${(e as Error).message}`, 'bad');
    }
    refs.reload();
  }
  const all = refs.data ?? [];
  return (
    <div className="stack refs" style={{ gap: 6 }}>
      <div className="row"><h4>Verweise ({all.length})</h4>{canEdit && <button className="small" onClick={() => setLinking(true)}><span aria-hidden="true">🔗 </span>Verknüpfen …</button>}</div>
      {Object.entries(byRelation).map(([rel, list]) => (
        <RefGroup key={rel} relation={rel} list={list} canEdit={canEdit} compact={!!compact}
          onRemove={(r) => void remove(r)} onSeverity={(r, v) => void setSeverity(r, v)} onLinkStatus={(r, v) => void setLinkStatus(r, v)} />
      ))}
      {!all.length && <span className="muted small">–</span>}
      {linking && <LinkDialog ownerType={ownerType} ownerId={ownerId} projectKey={projectKey} onClose={() => setLinking(false)} onLinked={() => { setLinking(false); refs.reload(); }} />}
    </div>
  );
}

const RESOLUTION_LABEL = { open: 'offen', fixed: 'erledigt', rejected: 'abgelehnt' } as const;
const COLLAPSED = 8;

/**
 * Verweise einer Art (z. B. Fehler) als Liste: eine Zeile je Ticket mit Schlüssel, Titel, Status und Schweregrad;
 * Aktionen im Zeilenmenü. Lange Listen: Filter offen/erledigt, Suche und Einklappen.
 */
function RefGroup({ relation, list, canEdit, compact, onRemove, onSeverity, onLinkStatus }: {
  relation: string; list: Reference[]; canEdit: boolean; compact: boolean;
  onRemove: (r: Reference) => void; onSeverity: (r: Reference, v: string) => void; onLinkStatus: (r: Reference, v: string) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'open' | 'done'>('all');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState(false);
  const res = (r: Reference) => defectResolution(r.status);
  const openCount = list.filter((r) => res(r) === 'open').length;
  const long = list.length > COLLAPSED;
  // offene zuerst, dann nach Schlüssel (natürliche Sortierung: PROJ-815 vor PROJ-1035)
  const sorted = [...list].sort((a, b) => Number(res(a) !== 'open') - Number(res(b) !== 'open') || a.externalKey.localeCompare(b.externalKey, 'de', { numeric: true }));
  const needle = q.trim().toLowerCase();
  const shown = sorted.filter((r) => (filter === 'all' || (filter === 'open') === (res(r) === 'open'))
    && (!needle || `${r.externalKey} ${r.title ?? ''} ${r.status ?? ''}`.toLowerCase().includes(needle)));
  const visible = long && !expanded && !needle ? shown.slice(0, COLLAPSED) : shown;
  const isDefect = relation === 'DEFECT';
  return (
    <section className="ref-group" aria-label={RELATION_LABEL[relation] ?? relation}>
      <div className="ref-group-head">
        <strong>{RELATION_LABEL[relation] ?? relation}</strong>
        {isDefect && list.length > 1 && <span className="small muted">{openCount} offen · {list.length - openCount} erledigt bzw. abgelehnt</span>}
        <span className="spacer" />
        {long && <>
          <div className="seg-tabs small" role="group" aria-label="Filter">
            {([['all', `Alle (${list.length})`], ['open', `Offen (${openCount})`], ['done', `Erledigt (${list.length - openCount})`]] as const).map(([k, l]) => (
              <button key={k} type="button" aria-pressed={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
          <input type="search" className="ref-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtern …" aria-label={`${RELATION_LABEL[relation] ?? relation} filtern`} />
        </>}
      </div>
      <ul className="ref-list">
        {visible.map((r) => {
          const state = res(r);
          return (
            <li key={r.id} className={`ref-row ${state !== 'open' ? 'is-done' : ''}`}>
              <span className="ref-key">
                <span className="ref-provider">{PROVIDER_LABEL[r.provider] ?? r.provider}</span>
                {r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener" className="mono">{shortKey(r)}</a> : <span className="mono">{shortKey(r)}</span>}
              </span>
              <span className="ref-title" title={r.title ?? undefined}>{!compact && r.provider !== 'url' ? r.title : ''}{r.stepId && <span className="muted small" title="Fehler zu Schritten der Ausführung"> · {((r as Reference & { steps?: number }).steps ?? 1) > 1 ? `an ${(r as Reference & { steps?: number }).steps} Schritten` : 'Schritt'}</span>}</span>
              <span className="ref-meta">
                {r.severity && <SeverityBadge value={r.severity} />}
                {(r.status || r.provider === 'url') && <span className={`ref-status ${state}`} title={r.status ? `Status im Ticketsystem: ${r.status}` : 'Status von Hand'}>{r.status ?? RESOLUTION_LABEL[state]}</span>}
              </span>
              <span className="ref-actions">
                <ActionMenu label="⋯" ariaLabel={`Aktionen zu ${shortKey(r)}`} items={[
                  { label: '🔎 Alle Stellen mit diesem Verweis', onClick: () => { window.location.hash = searchHref(r.externalKey, { types: 'reference' }).replace(/^#/, ''); } },
                  ...(canEdit && isDefect ? [
                    ...SEVERITIES.map((sv) => ({ label: `${r.severity === sv ? '● ' : ''}Schweregrad: ${sv}`, title: 'Schweregrad aus Anemo-Sicht', onClick: () => onSeverity(r, sv) })),
                    ...(r.severity ? [{ label: 'Schweregrad entfernen', onClick: () => onSeverity(r, '') }] : []),
                  ] : []),
                  ...(canEdit && isDefect && r.provider === 'url' ? URL_STATUS.map((st) => ({ label: `${(r.status ?? 'offen') === st ? '● ' : ''}Status: ${st}`, title: 'Status von Hand – Links werden nicht abgeglichen', onClick: () => onLinkStatus(r, st) })) : []),
                  ...(canEdit ? [{ label: '✕ Verknüpfung lösen …', onClick: () => onRemove(r) }] : []),
                ]} />
              </span>
            </li>
          );
        })}
        {visible.length === 0 && <li className="muted small">Keine Treffer.</li>}
      </ul>
      {long && !needle && shown.length > COLLAPSED && <button type="button" className="link small" onClick={() => setExpanded((x) => !x)}>
        {expanded ? 'Weniger anzeigen' : `Alle ${shown.length} anzeigen`}</button>}
    </section>
  );
}

interface WorkItem { resolved?: boolean; verified?: boolean; key: string; title: string | null; status: string | null; type: string | null; url: string | null }

function LinkDialog({ ownerType, ownerId, projectKey, onClose, onLinked }: { ownerType: OwnerType; ownerId: string; projectKey: string; onClose: () => void; onLinked: () => void }) {
  const me = useSession();
  const op = useApi<{ available: boolean; reason: string | null; externalProject: string | null; configured?: boolean; allowed?: boolean }>(`/api/projects/${projectKey}/integrations/openproject/status`);
  // OpenProject eingerichtet und erlaubt, Projekt aber nicht zugeordnet: Verknüpfen per Nummer möglich, Suche nicht
  const opByNumber = !!op.data && !op.data.available && !!op.data.configured && !!op.data.allowed;
  const [opNo, setOpNo] = useState('');
  const [opItem, setOpItem] = useState<WorkItem | null>(null);
  const git = useApi<{ available: boolean; project?: string }>(`/api/projects/${projectKey}/gitlab/status`);
  const [provider, setProvider] = useState<'openproject' | 'jira' | 'gitlab' | 'url'>('openproject');
  const linkSettings = useLinkSettings();
  const [linkUrl, setLinkUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [relation, setRelation] = useState(ownerType === 'TEST_EXECUTION' ? 'DEFECT' : 'REQUIREMENT');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<WorkItem[] | null>(null);
  const [manual, setManual] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    // ohne nutzbares OpenProject auf Jira wechseln – außer Verknüpfen per Nummer ist möglich
    if (op.data && !op.data.available && !(op.data.configured && op.data.allowed)) setProvider('jira');
  }, [op.data]);
  useEffect(() => {
    setOpItem(null);
    setError(null);
    if (!opByNumber || provider !== 'openproject' || !/^(#?\d+|[A-Za-z][A-Za-z0-9_]*-\d+)$/.test(opNo.trim())) return;
    const t = setTimeout(() => { api<WorkItem>('GET', `/api/projects/${projectKey}/integrations/openproject/work-items/${encodeURIComponent(opNo.trim().replace('#', '').toUpperCase())}`).then(setOpItem, setError); }, 300);
    return () => clearTimeout(t);
  }, [opNo, opByNumber, provider, projectKey]);
  useEffect(() => {
    const searchable = (provider === 'openproject' && op.data?.available) || (provider === 'gitlab' && git.data?.available);
    if (!searchable || q.trim().length < 2) return setResults(null);
    const url = provider === 'gitlab' ? `/api/projects/${projectKey}/gitlab/search?q=` : `/api/projects/${projectKey}/integrations/openproject/search?q=`;
    const t = setTimeout(() => { api<WorkItem[]>('GET', `${url}${encodeURIComponent(q.trim())}`).then(setResults, setError); }, 300);
    return () => clearTimeout(t);
  }, [q, provider, projectKey, op.data, git.data]);
  async function link(key: string, extra: Partial<WorkItem> = {}) {
    try {
      await api('POST', '/api/references', {
        ownerType, ownerId, provider, externalKey: key, relation, url: extra.url ?? null, title: extra.title ?? null, status: extra.status ?? null,
      });
      onLinked();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Modal help="references" title={linkSettings.enabled ? 'Mit Ticket oder Link verknüpfen' : 'Mit Ticket verknüpfen'} onClose={onClose} footer={<><span className="spacer" /><button onClick={onClose}>Abbrechen</button></>}>
      <ErrorNote error={error} />
      <div className="grid2">
        <label className="field">System
          <select value={provider} onChange={(e) => { setProvider(e.target.value as 'openproject' | 'jira' | 'gitlab' | 'url'); setResults(null); setQ(''); }}>
            <option value="openproject" disabled={!op.data?.available && !opByNumber}>OpenProject{op.data?.externalProject ? ` (${op.data.externalProject})` : opByNumber ? ' (per Nummer)' : ''}</option>
            <option value="gitlab" disabled={!git.data?.available}>GitLab – Merge-Request/Commit{git.data?.project ? ` (${git.data.project})` : ''}</option>
            <option value="jira">Jira (Schlüssel eingeben)</option>
            {linkSettings.enabled && <option value="url">Link (URL mit Kurznamen)</option>}
          </select>
        </label>
        <label className="field">Art der Beziehung
          <select value={relation} onChange={(e) => setRelation(e.target.value)}>
            {Object.entries(RELATION_LABEL).filter(([k]) => k !== 'AUTOMATION').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      {op.data && !op.data.available && (
        <div className="notice warn small">
          <b>OpenProject-Suche nicht verfügbar:</b> {op.data.reason}.
          {opByNumber && ' Ein Arbeitspaket lässt sich trotzdem über seine Nummer verknüpfen.'}
          {me.isSystemAdmin && op.data.configured && <> <a href={href(['admin', 'openproject'])}>Projekt jetzt zuordnen →</a></>}
          {!me.isSystemAdmin && op.data.configured && op.data.allowed && ' Die Zuordnung legt die Systemadministration fest (Administration → Anbindungen → OpenProject).'}
        </div>
      )}
      {provider === 'url' ? (
        <div className="stack">
          <UrlLinkFields url={linkUrl} title={linkTitle} onUrl={setLinkUrl} onTitle={setLinkTitle} settings={linkSettings} idPrefix="ref-link" />
          <div className="row"><span className="small muted" style={{ flex: 1 }}>Links werden nicht abgeglichen; der Status eines Fehler-Links wird von Hand gepflegt.</span>
            <button className="primary" disabled={!isUrl(linkUrl) || !shownTitle(linkUrl, linkTitle)} onClick={() => link(linkUrl.trim(), { title: shownTitle(linkUrl, linkTitle), url: linkUrl.trim() })}>Verknüpfen</button></div>
        </div>
      ) : provider === 'openproject' && opByNumber ? (
        <div className="stack">
          <input autoFocus placeholder="Nummer oder Schlüssel, z. B. 1234 oder PROJ-315" value={opNo} onChange={(e) => setOpNo(e.target.value)} aria-label="Nummer oder Schlüssel des Arbeitspakets" />
          {opItem && <div className="row"><span className="mono small">#{opItem.key}</span><span style={{ flex: 1 }}>{opItem.title ?? <span className="muted">(ohne Titel)</span>}</span>
            {(opItem.type || opItem.status) && <span className="small muted">{[opItem.type, opItem.status].filter(Boolean).join(' · ')}</span>}
            <button className="primary" onClick={() => link(opItem.key, opItem)}>Verknüpfen</button></div>}
          {opItem && opItem.resolved === false && <div className="notice info small">#{opItem.key} – Titel und Status werden ohne Projektzuordnung nicht aus OpenProject übernommen. Die Verknüpfung ist trotzdem möglich.</div>}
        </div>
      ) : provider !== 'jira' ? <>
        <input autoFocus placeholder={provider === 'gitlab' ? 'Merge-Request suchen oder Commit-SHA eingeben' : 'Arbeitspaket suchen: Titel oder Nummer'} value={q} onChange={(e) => setQ(e.target.value)}
          aria-label={provider === 'gitlab' ? 'Merge-Request oder Commit suchen' : 'Arbeitspaket suchen'} />
        <div className="table-wrap" style={{ maxHeight: 340 }}><table><tbody>
          {q.trim().length >= 2 && results === null && <tr><td className="muted small">Sucht …</td></tr>}
          {results?.length === 0 && <tr><td className="empty">Keine Treffer.</td></tr>}
          {results?.map((w) => {
            const label = provider === 'gitlab' ? w.key.replace(/^.*?([!@])/, '$1') : `#${w.key}`;
            return (
              <tr key={w.key} className="clickable" onClick={() => link(w.key, w)}>
                <td className="fit mono small">{label}</td><td>{w.title ?? <span className="muted">(ohne Titel)</span>}</td><td className="fit small muted">{w.type}</td><td className="fit small">{w.status}</td>
                <td className="fit"><button className="small" onClick={(e) => { e.stopPropagation(); void link(w.key, w); }} aria-label={`${label} verknüpfen`}>Verknüpfen</button></td>
              </tr>
            );
          })}
        </tbody></table></div>
        <p className="small muted">{provider === 'gitlab' ? 'Der Status des Merge-Requests (offen/gemergt) wird regelmäßig abgeglichen.' : 'Beim Verknüpfen erhält das Arbeitspaket einen Kommentar mit Rückverweis auf Anemo; Status und Titel werden regelmäßig abgeglichen.'}</p>
      </> : (
        <div className="row">
          <input autoFocus placeholder="Jira-Schlüssel, z. B. DEMO-1234" aria-label="Jira-Schlüssel" value={manual} onChange={(e) => setManual(e.target.value.toUpperCase())} style={{ flex: 1, width: 'auto' }} />
          <button className="primary" disabled={!/^[A-Z][A-Z0-9_]+-\d+$/.test(manual.trim())} onClick={() => link(manual.trim())}>Verknüpfen</button>
        </div>
      )}
    </Modal>
  );
}
