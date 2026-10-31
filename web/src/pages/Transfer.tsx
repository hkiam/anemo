import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, fmtDate, UNAUTHORIZED_EVENT, useApi } from '../api.ts';
import { ErrorNote, useStatuses, useWorkflow } from '../components/common.tsx';
import { usePriorities } from '../components/Fields.tsx';
import { href } from '../router.ts';
import { useSession } from '../session.tsx';
import { askConfirm, toast, usePageTitle } from '../ux.tsx';
import type { Project } from '../types.ts';

/** Projekte übertragen (ADR-0027): Export anfordern, eigene Vorgänge, Import mit Probelauf. */

export interface Transfer {
  id: string; direction: 'export' | 'import'; projectKey: string; status: string; sensitive: boolean;
  options: { scope?: { kind: string }; note?: string | null; summary?: Record<string, number> | null; source?: { key: string; name: string }; package?: Uploaded['package'] } | null;
  requestedBy: string; requestedAt: string; decidedBy: string | null; decisionNote: string | null; expiresAt: string | null; downloads: number;
  packageBytes: string | null; counts: Record<string, number> | null; error: string | null; progress: { phase: string; type?: string; done?: number } | null;
  report: Report | { fileName?: string } | null;
}

interface Report {
  dryRun: boolean; mode: 'new' | 'existing';
  source: { key: string; name: string; exportedAt: string; exportedBy: string; anemo: string };
  target: { key: string; name: string; projectId: string | null };
  counts: Record<string, number>;
  changes: Record<string, { created: number; updated: number; skipped: number }>;
  keyMap: Record<string, string>;
  persons: { login: string; displayName: string | null; target: string; how: string }[];
  catalog: { kind: string; code: string; action: string; target?: string }[];
  conflicts: string[]; warnings: string[]; problems: string[];
}

interface Uploaded {
  transfer: Transfer;
  package: { project: { key: string; name: string; visibility: string }; formatVersion: string; anemo: { version: string }; exportedAt: string; exportedBy: string;
    counts: Record<string, number>; persons: { login: string; displayName: string | null; email: string | null }[]; warnings: string[] };
  suggestedTarget: { key: string; name: string };
}

export const TYPE_LABEL: Record<string, string> = {
  'folders': 'Ordner', 'field-definitions': 'Felder', 'field-templates': 'Feldvorlagen', 'defect-templates': 'Fehlervorlagen', 'preconditions': 'Vorbedingungen',
  'precondition-versions': 'Vorbedingungsversionen', 'step-blocks': 'Bausteine', 'test-sets': 'Testsets', 'test-cases': 'Testfälle', 'test-case-versions': 'Testfallversionen',
  'plans': 'Testpläne', 'cycles': 'Zyklen', 'executions': 'Ausführungen', 'execution-results': 'Ergebnisverlauf', 'sessions': 'Sitzungen', 'dataset-overrides': 'Datensätze',
  'comments': 'Kommentare', 'references': 'Verweise', 'attachments': 'Anhänge', 'views': 'Ansichten', 'members': 'Mitglieder', 'integrations': 'Anbindungen',
  'webhooks': 'Webhooks', 'files': 'Anhangsdateien',
};

export const STATUS: Record<string, [string, string]> = {
  pending: ['wartet', 'warn'], approved: ['freigegeben', 'accent'], running: ['läuft', 'accent'], ready: ['bereit', 'ok'], done: ['erledigt', 'ok'],
  rejected: ['abgelehnt', 'bad'], failed: ['fehlgeschlagen', 'bad'],
};
export const statusLabel = (t: Transfer) => (t.direction === 'export' && t.status === 'pending' ? ['wartet auf Freigabe', 'warn'] : t.direction === 'import' && t.status === 'pending' ? ['hochgeladen', 'neutral'] : STATUS[t.status] ?? [t.status, 'neutral']) as [string, string];
export const progressText = (p: Transfer['progress']) => (p ? `${p.phase}${p.type ? ` · ${TYPE_LABEL[p.type] ?? p.type}` : ''}${p.done ? ` (${p.done})` : ''}` : '');
const mb = (v: string | number | null) => (v === null ? '–' : `${(Number(v) / 1024 / 1024).toFixed(1)} MB`);

export function TransferPage() {
  usePageTitle('Projekte übertragen');
  const me = useSession();
  const transfers = useApi<Transfer[]>('/api/project-transfers');
  const [importing, setImporting] = useState<Uploaded | 'new' | null>(null);
  const busy = transfers.data?.some((t) => t.status === 'running' || (t.direction === 'export' && t.status === 'approved'));
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(transfers.reload, 1500);
    return () => clearInterval(timer);
  }, [busy, transfers.reload]);

  /** liegendes Paket wieder aufnehmen (ohne erneutes Hochladen) */
  const resume = async (t: Transfer) => {
    try {
      const cur = await api<Transfer & { suggestedTarget: Uploaded['suggestedTarget'] }>('GET', `/api/package-imports/${t.id}`);
      if (!cur.options?.package) { toast('Für dieses Paket fehlt die Übersicht – bitte erneut hochladen', 'bad'); return; }
      setImporting({ transfer: cur, package: cur.options.package, suggestedTarget: cur.suggestedTarget });
      document.getElementById('import')?.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { toast((e as Error).message, 'bad'); }
  };

  if (!me.permissions?.includes('PROJECT_TRANSFER')) {
    return <div className="page"><div className="page-narrow notice warn">Dafür fehlt das Recht „Projekte übertragen“. Es wird von der Systemadministration vergeben.</div></div>;
  }
  return (
    <div className="page"><div className="page-wide stack">
      <h2>Projekte übertragen</h2>
      <p className="small muted">Ganze Projekte oder eine Auswahl als Projektpaket exportieren und in diese oder eine andere Anemo-Instanz importieren.
        Exportieren darf, wer im Projekt Projektadmin ist; eingeschränkte Projekte brauchen zusätzlich eine Freigabe der Systemadministration.</p>
      <ExportForm onRequested={transfers.reload} />
      <section className="stack" id="import">
        <div className="row"><h3 style={{ flex: 1 }}>Importieren</h3>
          {!importing && <button className="primary" onClick={() => setImporting('new')}>Paket hochladen …</button>}</div>
        {importing && <ImportWizard key={importing === 'new' ? 'new' : importing.transfer.id} initial={importing === 'new' ? null : importing} onClose={() => { setImporting(null); transfers.reload(); }} />}
      </section>
      <section className="stack">
        <h3>Meine Vorgänge</h3>
        <ErrorNote error={transfers.error} />
        <TransferTable rows={transfers.data ?? []} own onChanged={transfers.reload} onResume={resume} />
      </section>
    </div></div>
  );
}

/** Tabelle der Vorgänge; `own`: eigene (Abruf, Verwerfen), sonst Administration (Freigabe) */
export function TransferTable({ rows, own, onChanged, onDecide, onResume }: {
  rows: Transfer[]; own?: boolean; onChanged: () => void; onDecide?: (t: Transfer, approve: boolean) => void; onResume?: (t: Transfer) => void;
}) {
  const discard = async (t: Transfer) => {
    if (!(await askConfirm({ title: 'Paket verwerfen', message: `Hochgeladenes Paket ${t.projectKey} verwerfen?`, confirmLabel: 'Verwerfen', danger: true }))) return;
    try { await api('DELETE', `/api/package-imports/${t.id}`); onChanged(); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const expired = (t: Transfer) => !!t.expiresAt && new Date(t.expiresAt).getTime() < Date.now();
  return (
    <div className="table-wrap" role="region" aria-label="Vorgänge" tabIndex={0}>
      <table>
        <thead><tr><th className="fit">Zeit</th><th>Vorgang</th>{!own && <th>Person</th>}<th>Umfang</th><th className="fit">Stand</th><th className="fit" /></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={own ? 5 : 6} className="empty">Noch keine Vorgänge.</td></tr>}
          {rows.map((t) => {
            const [label, tone] = statusLabel(t);
            const scope = t.options?.scope?.kind === 'selection' ? `Auswahl${t.options.summary?.['test-cases'] !== undefined ? ` (${t.options.summary['test-cases']} Testfälle)` : ''}` : 'komplett';
            return (
              <tr key={t.id}>
                <td className="fit small">{fmtDate(t.requestedAt)}</td>
                <td>{t.direction === 'export' ? 'Export' : 'Import'} <strong>{t.projectKey}</strong>
                  {t.direction === 'import' && t.options?.source && t.options.source.key !== t.projectKey && <span className="small muted"> aus {t.options.source.key}</span>}
                  {t.sensitive && <span className="badge warn" style={{ marginLeft: 6 }} title="eingeschränkt bzw. externe Dienste gesperrt">sensibel</span>}
                  {t.options?.note && <div className="small muted">{t.options.note}</div>}
                  {t.error && <div className="small" style={{ color: 'var(--danger)' }}>{t.error}</div>}
                </td>
                {!own && <td className="small">{t.requestedBy}{t.decidedBy && <div className="muted">entschieden: {t.decidedBy}{t.decisionNote ? ` – ${t.decisionNote}` : ''}</div>}</td>}
                <td className="small">{t.direction === 'export' ? scope : ''}{t.packageBytes ? ` · ${mb(t.packageBytes)}` : ''}
                  {t.counts?.['test-cases'] !== undefined && <span className="muted"> · {t.counts['test-cases']} Testfälle</span>}</td>
                <td className="fit small"><span className={`badge ${tone}`}>{label}</span>
                  {t.status === 'running' && <div className="muted">{progressText(t.progress)}</div>}
                  {t.expiresAt && ['ready', 'done', 'approved', 'pending'].includes(t.status) && <div className="muted">{expired(t) ? 'abgelaufen' : `bis ${fmtDate(t.expiresAt)}`}</div>}</td>
                <td className="fit">
                  {own && t.direction === 'export' && (t.status === 'ready' || t.status === 'done') && !expired(t) &&
                    <a className="btn small" href={`/api/project-transfers/${t.id}/download`} download>Herunterladen</a>}
                  {own && t.direction === 'import' && t.status === 'pending' && !expired(t) && <span className="row" style={{ gap: 4 }}>
                    {onResume && <button className="small primary" onClick={() => onResume(t)}>Fortsetzen</button>}
                    <button className="small" onClick={() => discard(t)}>Verwerfen</button></span>}
                  {onDecide && t.status === 'pending' && t.direction === 'export' && <span className="row" style={{ gap: 4 }}>
                    <button className="small primary" onClick={() => onDecide(t, true)}>Freigeben</button>
                    <button className="small" onClick={() => onDecide(t, false)}>Ablehnen</button></span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ExportForm({ onRequested }: { onRequested: () => void }) {
  const me = useSession();
  const projects = useApi<Project[]>('/api/projects');
  const manageable = (projects.data ?? []).filter((p) => me.isSystemAdmin || me.projectRoles[p.key] === 'PROJECT_ADMIN');
  const [key, setKey] = useState('');
  const project = key || manageable[0]?.key || '';
  const [kind, setKind] = useState<'complete' | 'selection'>('complete');
  const [tests, setTests] = useState('');
  const [query, setQuery] = useState('');
  const [sets, setSets] = useState<string[]>([]);
  const [cycles, setCycles] = useState<string[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [plans, setPlans] = useState<string[]>([]);
  const [versions, setVersions] = useState<'all' | 'current'>('all');
  const [executions, setExecutions] = useState(true);
  const [attachments, setAttachments] = useState(true);
  const [comments, setComments] = useState(true);
  const [pseudonymize, setPseudonymize] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  const sel = kind === 'selection' && project;
  const testSets = useApi<{ id: string; name: string; count?: number }[]>(sel ? `/api/projects/${project}/test-sets` : null);
  const cycleList = useApi<{ items: { id: string; name: string }[] }>(sel && executions ? `/api/projects/${project}/cycles?limit=500` : null);
  const planList = useApi<{ id: string; name: string; release: string | null }[]>(sel && executions ? `/api/projects/${project}/plans` : null);
  const folderList = useApi<{ id: string; parentId: string | null; name: string }[]>(sel ? `/api/projects/${project}/folders` : null);
  const folderPath = useMemo(() => {
    const byId = new Map((folderList.data ?? []).map((f) => [f.id, f]));
    const path = (id: string): string => { const f = byId.get(id); return f ? (f.parentId ? `${path(f.parentId)} / ${f.name}` : f.name) : ''; };
    return (folderList.data ?? []).map((f) => ({ id: f.id, label: path(f.id) })).sort((a, b) => a.label.localeCompare(b.label));
  }, [folderList.data]);
  const toggle = (list: string[], set: (v: string[]) => void, id: string, on: boolean) => set(on ? [...list, id] : list.filter((x) => x !== id));

  async function request() {
    setError(null); setSending(true);
    try {
      const scope = kind === 'complete' ? { kind } : {
        kind, ...(tests.trim() ? { testCases: tests.split(/[\s,;]+/).filter(Boolean) } : {}), ...(query.trim() ? { query } : {}),
        ...(sets.length ? { testSets: sets } : {}), ...(cycles.length && executions ? { cycles } : {}), ...(plans.length && executions ? { plans } : {}),
        ...(folders.length ? { folders } : {}),
      };
      const t = await api<Transfer>('POST', `/api/projects/${project}/exports`, { scope, options: { versions, executions, attachments, comments, pseudonymize }, ...(note.trim() ? { note } : {}) });
      toast(t.status === 'pending' ? `Export ${project} angefordert – wartet auf Freigabe der Systemadministration` : `Export ${project} wird erstellt`);
      onRequested();
    } catch (e) { setError(e); } finally { setSending(false); }
  }

  return (
    <section className="stack">
      <h3>Exportieren</h3>
      {!manageable.length && projects.data && <div className="small muted">Sie sind in keinem Projekt Projektadmin.</div>}
      {manageable.length > 0 && <>
        <div className="grid2">
          <label className="field">Quellprojekt<select value={project} onChange={(e) => { setKey(e.target.value); setSets([]); setCycles([]); setFolders([]); setPlans([]); }}>
            {manageable.map((p) => <option key={p.key} value={p.key}>{p.key} – {p.name}{p.visibility === 'restricted' ? ' (eingeschränkt)' : ''}</option>)}
          </select></label>
          <fieldset className="field"><legend>Umfang</legend>
            <label className="row"><input type="radio" name="scope" checked={kind === 'complete'} onChange={() => setKind('complete')} style={{ width: 'auto' }} /> komplettes Projekt</label>
            <label className="row"><input type="radio" name="scope" checked={kind === 'selection'} onChange={() => setKind('selection')} style={{ width: 'auto' }} /> Auswahl</label>
          </fieldset>
        </div>
        {kind === 'selection' && <div className="stack" style={{ paddingLeft: 12, borderLeft: '3px solid var(--border)' }}>
          <p className="small muted">Alles, was die Auswahl braucht, kommt automatisch mit: aufgerufene Testfälle, Vorbedingungen, übergeordnete Ordner, Felder und Vorlagen.</p>
          <div className="grid2">
            <label className="field">Testfälle (Schlüssel)<input value={tests} onChange={(e) => setTests(e.target.value)} placeholder={`${project}-T1, ${project}-T7`} /></label>
            <label className="field">Abfrage<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="z. B. komponente = Akte und status = Freigegeben" /></label>
          </div>
          <Picker title="Ordner (mit Unterordnern)" items={folderPath} selected={folders} onToggle={(id, on) => toggle(folders, setFolders, id, on)} />
          <Picker title="Testsets" items={(testSets.data ?? []).map((s) => ({ id: s.id, label: s.name }))} selected={sets} onToggle={(id, on) => toggle(sets, setSets, id, on)} />
          {executions && <Picker title="Testpläne (mit allen Zyklen, Ausführungen und ihren Testfällen)" items={(planList.data ?? []).map((p) => ({ id: p.id, label: p.release ? `${p.name} (${p.release})` : p.name }))}
            selected={plans} onToggle={(id, on) => toggle(plans, setPlans, id, on)} />}
          {executions && <Picker title="Zyklen (mit Ausführungen und ihren Testfällen)" items={(cycleList.data?.items ?? []).map((c) => ({ id: c.id, label: c.name }))} selected={cycles}
            onToggle={(id, on) => toggle(cycles, setCycles, id, on)} />}
        </div>}
        <fieldset className="field"><legend>Optionen</legend>
          <label className="row">Versionen <select value={versions} onChange={(e) => setVersions(e.target.value as 'all' | 'current')} style={{ width: 'auto' }}>
            <option value="all">alle</option><option value="current">nur aktuelle (dazu freigegebene und ausgeführte)</option></select></label>
          <label className="row"><input type="checkbox" checked={executions} onChange={(e) => setExecutions(e.target.checked)} style={{ width: 'auto' }} /> Testpläne, Zyklen, Ausführungen und Ergebnisse</label>
          <label className="row"><input type="checkbox" checked={attachments} onChange={(e) => setAttachments(e.target.checked)} style={{ width: 'auto' }} /> Anhänge</label>
          <label className="row"><input type="checkbox" checked={comments} onChange={(e) => setComments(e.target.checked)} style={{ width: 'auto' }} /> Kommentare</label>
          <label className="row"><input type="checkbox" checked={pseudonymize} onChange={(e) => setPseudonymize(e.target.checked)} style={{ width: 'auto' }} />
            Personen pseudonymisieren („Person 1…n“, ohne Mitglieder; Namen in Freitexten bleiben)</label>
        </fieldset>
        <label className="field">Anlass (für die Freigabe und das Protokoll)<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="z. B. Umzug in die Betriebsinstanz" /></label>
        <ErrorNote error={error} />
        <div className="row"><span className="spacer" /><button className="primary" disabled={!project || sending} onClick={request}>Export anfordern</button></div>
      </>}
    </section>
  );
}

function Picker({ title, items, selected, onToggle }: { title: string; items: { id: string; label: string }[]; selected: string[]; onToggle: (id: string, on: boolean) => void }) {
  if (!items.length) return null;
  return (
    <details>
      <summary>{title}{selected.length ? ` – ${selected.length} gewählt` : ''}</summary>
      <div className="table-wrap" style={{ maxHeight: 220 }}>
        {items.map((i) => (
          <label key={i.id} className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={selected.includes(i.id)} onChange={(e) => onToggle(i.id, e.target.checked)} /> {i.label}</label>
        ))}
      </div>
    </details>
  );
}

/** Paket hochladen (mit Fortschritt), Ziel und Zuordnungen wählen, Probelauf, Einspielen im Hintergrund. */
function ImportWizard({ initial, onClose }: { initial: Uploaded | null; onClose: () => void }) {
  const me = useSession();
  const [up, setUp] = useState<Uploaded | null>(initial);
  const [percent, setPercent] = useState<number | null>(null);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [key, setKey] = useState(initial?.suggestedTarget.key ?? '');
  const [name, setName] = useState(initial?.suggestedTarget.name ?? '');
  const [folderId, setFolderId] = useState('');
  const [persons, setPersons] = useState<Record<string, string | null>>({});
  const [statusMap, setStatusMap] = useState<Record<string, string>>({});
  const [tcStatusMap, setTcStatusMap] = useState<Record<string, string>>({});
  const [prioMap, setPrioMap] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<Record<string, string>>({});
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState<Transfer | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const projects = useApi<Project[]>(mode === 'existing' ? '/api/projects' : null);
  const manageable = (projects.data ?? []).filter((p) => me.isSystemAdmin || me.projectRoles[p.key] === 'PROJECT_ADMIN');
  const folders = useApi<{ id: string; parentId: string | null; name: string }[]>(mode === 'existing' && key ? `/api/projects/${key}/folders` : null);
  const directory = useApi<{ users: { id: string; username: string; displayName: string }[] }>(up ? '/api/directory' : null);
  const statuses = useStatuses();
  const workflow = useWorkflow();
  const priorities = usePriorities();

  function upload(file: File) {
    setError(null); setPercent(0);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/package-imports');
    xhr.setRequestHeader('content-type', 'application/zip');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setPercent(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      setPercent(null);
      let data: { detail?: string } & Partial<Uploaded> = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* kein JSON */ }
      if (xhr.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      if (xhr.status !== 201) { setError(new ApiError(xhr.status, data.detail ?? `Hochladen fehlgeschlagen (${xhr.status})`)); return; }
      const u = data as Uploaded;
      setUp(u); setKey(u.suggestedTarget.key); setName(u.suggestedTarget.name);
    };
    xhr.onerror = () => { setPercent(null); setError(new Error('Hochladen fehlgeschlagen (Verbindung)')); };
    xhr.send(file);
  }

  const clean = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([, v]) => v));
  const options = () => ({
    target: mode === 'new' ? { mode, key: key.trim().toUpperCase(), name: name.trim() } : { mode, key, ...(folderId ? { folderId } : {}) },
    persons: Object.fromEntries(Object.entries(persons).filter(([, v]) => v !== undefined)),
    executionStatuses: clean(statusMap), testCaseStatuses: clean(tcStatusMap), priorities: clean(prioMap),
    ...(mode === 'existing' ? { conflicts } : {}),
  });
  async function preview() {
    if (!up) return;
    setError(null); setBusy(true);
    try { setReport(await api<Report>('POST', `/api/package-imports/${up.transfer.id}/preview`, options())); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  async function apply() {
    if (!up || !(await askConfirm({ title: 'Paket einspielen', message: mode === 'new' ? `Neues Projekt ${key} aus ${up.package.project.key} anlegen?` : `Paket ${up.package.project.key} in das Projekt ${key} einspielen?`, confirmLabel: 'Einspielen' }))) return;
    setError(null); setBusy(true);
    try {
      setRunning(await api<Transfer>('POST', `/api/package-imports/${up.transfer.id}/apply?background=true`, options()));
    } catch (e) { setError(e); setBusy(false); }
  }
  useEffect(() => {
    if (!running || running.status !== 'running' || !up) return;
    const timer = setInterval(async () => {
      try {
        const t = await api<Transfer>('GET', `/api/package-imports/${up.transfer.id}`);
        setRunning(t);
        if (t.status !== 'running') {
          setBusy(false);
          if (t.report) setReport(t.report as Report);
          if (t.status === 'done') toast(`Projekt ${(t.report as Report).target.key} eingespielt`);
        }
      } catch (e) { setError(e); }
    }, 1000);
    return () => clearInterval(timer);
  }, [running, up]);

  if (!up) {
    return (
      <div className="stack card card-body">
        <label className="field">Projektpaket (*.anemo.zip)<input type="file" accept=".zip,application/zip" disabled={percent !== null} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>
        {percent !== null && <div className="small">Wird hochgeladen und geprüft … {percent} %</div>}
        <ErrorNote error={error} />
        <div className="row"><span className="spacer" /><button onClick={onClose}>Abbrechen</button></div>
      </div>
    );
  }
  const pkg = up.package;
  /** fehlende Katalogeinträge (bzw. schon zugeordnete) je Art mit den Einträgen dieser Instanz */
  const mappings: { kind: string; label: string; map: Record<string, string>; set: (f: (m: Record<string, string>) => Record<string, string>) => void; choices: { code: string; name: string }[]; hint: string }[] = [
    { kind: 'Ergebnisstatus', label: 'Ergebnisstatus zuordnen', map: statusMap, set: setStatusMap, choices: statuses.map((x) => ({ code: x.code, name: x.name })), hint: 'nötig zum Einspielen' },
    { kind: 'Testfallstatus', label: 'Testfallstatus zuordnen', map: tcStatusMap, set: setTcStatusMap, choices: (workflow?.statuses ?? []).map((x) => ({ code: x.code, name: x.name })), hint: 'sonst als Text übernommen' },
    { kind: 'Priorität', label: 'Prioritäten zuordnen', map: prioMap, set: setPrioMap, choices: priorities.map((x) => ({ code: x.code, name: x.code })), hint: 'sonst als Text übernommen' },
  ];
  const done = running?.status === 'done';
  return (
    <div className="stack card card-body">
      <div className="small">Paket <strong>{pkg.project.key} – {pkg.project.name}</strong>{pkg.project.visibility === 'restricted' && <span className="badge warn" style={{ marginLeft: 6 }}>eingeschränkt</span>}
        <span className="muted"> · exportiert {fmtDate(pkg.exportedAt)} von {pkg.exportedBy} · Anemo {pkg.anemo.version} · Format {pkg.formatVersion}</span></div>
      <div className="small muted">{Object.entries(pkg.counts).filter(([, n]) => n).map(([t, n]) => `${n} ${TYPE_LABEL[t] ?? t}`).join(' · ')}</div>
      {pkg.warnings.length > 0 && <div className="notice warn small">{pkg.warnings.join(' · ')}</div>}
      {!done && <>
        <fieldset className="field"><legend>Ziel</legend>
          <label className="row"><input type="radio" name="target" checked={mode === 'new'} onChange={() => { setMode('new'); setKey(up.suggestedTarget.key); setReport(null); }} style={{ width: 'auto' }} /> neues Projekt</label>
          <label className="row"><input type="radio" name="target" checked={mode === 'existing'} onChange={() => { setMode('existing'); setKey(''); setReport(null); }} style={{ width: 'auto' }} />
            in ein bestehendes Projekt (Vorhandenes wird aktualisiert statt verdoppelt)</label>
        </fieldset>
        {mode === 'new' ? (
          <div className="grid2">
            <label className="field">Projektschlüssel<input value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="z. B. SHOP2" /></label>
            <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          </div>
        ) : (
          <div className="grid2">
            <label className="field">Zielprojekt<select value={key} onChange={(e) => { setKey(e.target.value); setFolderId(''); }}>
              <option value="">– wählen –</option>{manageable.map((p) => <option key={p.key} value={p.key}>{p.key} – {p.name}</option>)}</select></label>
            <label className="field">Zielordner für neue Ordner und Testfälle<select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">(oberste Ebene)</option>{(folders.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
          </div>
        )}
        {mode === 'existing' && <details>
          <summary>Regeln für Objekte, die es im Ziel schon gibt</summary>
          <p className="small muted">Aktualisieren: die neuere Fassung gewinnt; Testfälle bekommen neue Versionen. Abgeschlossene Zyklen bleiben immer unverändert.</p>
          <div className="grid2">
            {['test-cases', 'preconditions', 'plans', 'cycles', 'executions', 'comments', 'test-sets'].map((t) => (
              <label key={t} className="field">{TYPE_LABEL[t]}<select value={conflicts[t] ?? ''} onChange={(e) => setConflicts((c) => { const { [t]: _, ...rest } = c; return e.target.value ? { ...rest, [t]: e.target.value } : rest; })}>
                <option value="">Standard (aktualisieren)</option><option value="update">aktualisieren</option><option value="skip">überspringen</option>
                {!['test-sets', 'executions'].includes(t) && <option value="new">als Kopie neu anlegen</option>}
              </select></label>
            ))}
          </div>
        </details>}
        {pkg.persons.length > 0 && <details open={pkg.persons.length <= 8}>
          <summary>Personen ({pkg.persons.length})</summary>
          <div className="table-wrap" style={{ maxHeight: 260 }}><table><tbody>
            {pkg.persons.map((p) => (
              <tr key={p.login}><td>{p.login}</td><td className="small muted">{p.displayName ?? ''}{p.email ? ` · ${p.email}` : ''}</td>
                <td><select aria-label={`Zuordnung ${p.login}`} value={persons[p.login] === null ? '__text' : persons[p.login] ?? ''}
                  onChange={(e) => setPersons((m) => { const n = { ...m }; if (e.target.value === '') delete n[p.login]; else n[p.login] = e.target.value === '__text' ? null : e.target.value; return n; })}>
                  <option value="">automatisch (gleicher Login bzw. E-Mail)</option><option value="__text">als Text übernehmen</option>
                  {(directory.data?.users ?? []).map((u) => <option key={u.id} value={u.username}>{u.displayName} ({u.username})</option>)}
                </select></td></tr>
            ))}
          </tbody></table></div>
        </details>}
        {mappings.map((g) => {
          const items = (report?.catalog ?? []).filter((c) => c.kind === g.kind && (c.action === 'fehlt' || g.map[c.code]));
          if (!items.length) return null;
          return (
            <div key={g.kind} className="stack">
              <strong className="small">{g.label} <span className="muted">({g.hint})</span></strong>
              {items.map((c) => (
                <label key={c.code} className="row small">„{c.code}“ →
                  <select value={g.map[c.code] ?? ''} onChange={(e) => g.set((m) => ({ ...m, [c.code]: e.target.value }))} style={{ width: 'auto' }}>
                    <option value="">– wählen –</option>{g.choices.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}</select></label>
              ))}
            </div>
          );
        })}
      </>}
      {report && <ReportView report={report} />}
      {running?.status === 'running' && <div className="small">Wird eingespielt … {progressText(running.progress)}</div>}
      <ErrorNote error={error} />
      <div className="row">
        {!done && <button onClick={async () => { await api('DELETE', `/api/package-imports/${up.transfer.id}`).catch(() => {}); onClose(); }} disabled={busy}>Verwerfen</button>}
        <span className="spacer" />
        {done && report && <a className="btn" href={href(['p', report.target.key, 'repo'])}>Zum Projekt {report.target.key}</a>}
        {done ? <button className="primary" onClick={onClose}>Schließen</button> : <>
          <button onClick={preview} disabled={busy || !key || (mode === 'new' && !name.trim())}>Probelauf</button>
          <button className="primary" onClick={apply} disabled={busy || !report || report.problems.length > 0 || !report.dryRun}
            title={!report ? 'Zuerst den Probelauf ansehen' : report.problems.length ? 'Erst die Hinderungsgründe beheben' : undefined}>Einspielen</button>
        </>}
      </div>
    </div>
  );
}

export function ReportView({ report }: { report: Report }) {
  const rows = Object.entries(report.changes).filter(([, c]) => c.created || c.updated || c.skipped);
  const unmatched = report.persons.filter((p) => p.how === 'als Text');
  return (
    <div className="stack">
      <strong>{report.dryRun ? 'Probelauf' : 'Ergebnis'}: {report.source.key} → {report.target.key}{report.mode === 'existing' ? ' (bestehendes Projekt)' : ' (neues Projekt)'}</strong>
      {report.problems.length > 0 && <div className="notice warn"><strong>Hinderungsgründe</strong><ul>{report.problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
      {rows.length > 0 && <div className="table-wrap"><table>
        <thead><tr><th>Art</th><th className="num">neu</th><th className="num">aktualisiert</th><th className="num">unverändert</th></tr></thead>
        <tbody>{rows.map(([t, c]) => <tr key={t}><td>{TYPE_LABEL[t] ?? t}</td><td className="num">{c.created}</td><td className="num">{c.updated}</td><td className="num">{c.skipped}</td></tr>)}</tbody>
      </table></div>}
      {report.counts.files > 0 && <div className="small muted">{report.counts.files} Anhangsdateien</div>}
      {unmatched.length > 0 && <div className="small">Ohne Konto, als Text übernommen: {unmatched.map((p) => p.login).join(', ')}</div>}
      {report.catalog.some((c) => c.action === 'angelegt' || c.action === 'als Projektfeld') && <div className="small">Angelegt: {report.catalog.filter((c) => c.action === 'angelegt' || c.action === 'als Projektfeld').map((c) => `${c.kind} ${c.code}${c.action === 'als Projektfeld' ? ' (Projektfeld)' : ''}`).join(', ')}</div>}
      {report.conflicts.length > 0 && <details><summary className="small">Konflikte und Hinweise zu Vorhandenem ({report.conflicts.length})</summary><ul className="small">{report.conflicts.map((c) => <li key={c}>{c}</li>)}</ul></details>}
      {report.warnings.length > 0 && <details><summary className="small">Warnungen ({report.warnings.length})</summary><ul className="small">{report.warnings.map((w) => <li key={w}>{w}</li>)}</ul></details>}
    </div>
  );
}
