import { useEffect, useState } from 'react';
import { api, useApi } from '../../api.ts';
import { ErrorNote, invalidateStatuses, Modal } from '../../components/common.tsx';
import { toast } from '../../ux.tsx';
import type { ExecutionStatus, StatusCategory, TestCaseStatus, TestCaseStatusCategory, Workflow } from '../../types.ts';

const EXEC_CATEGORY: Record<StatusCategory, string> = {
  OPEN: 'Offen', IN_PROGRESS: 'In Arbeit', PASSED: 'Bestanden', PASSED_WITH_ISSUES: 'Bestanden mit Einschränkungen', KNOWN_FAILURE: 'Fehlgeschlagen (bekannter Fehler)', FAILED: 'Fehlgeschlagen', BLOCKED: 'Blockiert', INVALID: 'Ungültig', NOT_APPLICABLE: 'Nicht anwendbar',
};
const APPLIES: Record<ExecutionStatus['appliesTo'], string> = { both: 'Ausführung und Schritt', execution: 'nur Ausführung', step: 'nur Schritt' };
const TC_CATEGORY: Record<TestCaseStatusCategory, string> = { DRAFT: 'Entwurf', REVIEW: 'In Prüfung (Review)', APPROVED: 'Freigegeben (Testfall-Freigabe)', DEPRECATED: 'Veraltet' };

/** Grautöne der Voreinstellung bzw. Migration – Farbe offenbar nicht gepflegt */
const DEFAULT_GREYS = new Set(['#6b778c', '#888888', '#8993a4', '#999999', '#a0a0a0', '#808080']);
const ENGLISH = /^(open|draft|review|in review|ready|ready for review|approved|done|closed|outdated|deprecated|obsolete|in progress|to do|todo|new|rejected|accepted|final|wip)$/i;
/**
 * Übernommene Status, die vermutlich noch gepflegt werden müssen: englischer bzw. technischer Name (z. B. „Outdated“,
 * „Review!“), Satzzeichen im Namen oder unveränderte Standardfarbe ohne Beschreibung.
 */
function needsCare(s: { name: string; color: string; description: string | null; code: string }, colorRule = true): string | null {
  const name = s.name.trim();
  if (ENGLISH.test(name)) return 'englischer Name – deutsch benennen';
  if (/[!?*#]/.test(name)) return 'Satzzeichen im Namen';
  if (colorRule && DEFAULT_GREYS.has(s.color.toLowerCase()) && !s.description) return 'Standardfarbe, keine Beschreibung';
  return null;
}

const Swatch = ({ color }: { color: string }) => <span className="status-dot" style={{ background: color }} />;

/** Administration: Ausführungs-/Schrittstatus und Testfall-Workflow (ADR-0013). */
export function StatusWorkflow({ tab }: { tab: 'execution' | 'testcase' }) {
  return (
    <div className="stack">
      <h2>Status &amp; Workflow</h2>
      <div className="tabs">
        <a href="#/admin/workflow" className={tab === 'execution' ? 'active' : ''} aria-current={tab === 'execution' ? 'page' : undefined}>Ausführung &amp; Schritte</a>
        <a href="#/admin/workflow/testcase" className={tab === 'testcase' ? 'active' : ''} aria-current={tab === 'testcase' ? 'page' : undefined}>Testfall-Workflow</a>
      </div>
      {tab === 'execution' ? <ExecutionStatuses /> : <TestCaseWorkflow />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function ExecutionStatuses() {
  const list = useApi<ExecutionStatus[]>('/api/execution-statuses');
  const [editing, setEditing] = useState<ExecutionStatus | 'new' | null>(null);
  return (
    <div className="stack">
      <p className="small muted">
        Die <strong>Kategorie</strong> bestimmt, wie ein Status in Auswertungen, Filtern („fehlgeschlagen“, „offen“) und beim
        Vorschlag des Gesamtergebnisses zählt. Deaktivierte Status bleiben an bestehenden Ergebnissen erhalten, werden aber
        nicht mehr angeboten.
      </p>
      <div className="row"><span className="spacer" /><button className="primary" onClick={() => setEditing('new')}>+ Status</button></div>
      <ErrorNote error={list.error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th className="fit" /><th>Name</th><th className="fit">Code</th><th className="fit">Kategorie</th><th className="fit">gilt für</th><th className="fit">verwendet</th><th className="fit" /></tr></thead>
          <tbody>
            {list.data?.map((s) => (
              <tr key={s.code} className={s.active ? '' : 'muted'}>
                <td className="fit"><Swatch color={s.color} /></td>
                <td>{s.name}{!s.active && <span className="badge" style={{ marginLeft: 6 }}>deaktiviert</span>}
                  {s.active && needsCare(s, false) && <span className="badge warn" style={{ marginLeft: 6 }}>prüfen: {needsCare(s, false)}</span>}
                  {s.description && <div className="small muted">{s.description}</div>}</td>
                <td className="fit mono small">{s.code}</td>
                <td className="fit small">{EXEC_CATEGORY[s.category]}</td>
                <td className="fit small">{APPLIES[s.appliesTo]}</td>
                <td className="fit small">{s.inUse?.toLocaleString('de-DE') ?? '–'}</td>
                <td className="fit"><button className="small" onClick={() => setEditing(s)}>Bearbeiten</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <ExecutionStatusEditor status={editing === 'new' ? null : editing} nextSort={(list.data?.length ?? 0) + 1}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidateStatuses(); list.reload(); }} />}
    </div>
  );
}

function ExecutionStatusEditor({ status, nextSort, onClose, onSaved }: { status: ExecutionStatus | null; nextSort: number; onClose: () => void; onSaved: () => void }) {
  type Form = Pick<ExecutionStatus, 'code' | 'name' | 'color' | 'category' | 'appliesTo' | 'active' | 'sortOrder' | 'description'>;
  const [f, setF] = useState<Form>(() => status ?? {
    code: '', name: '', color: '#6b778c', category: 'FAILED', appliesTo: 'both', active: true, sortOrder: nextSort, description: null,
  });
  const [error, setError] = useState<unknown>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  async function save() {
    try {
      await api('PUT', `/api/admin/execution-statuses/${encodeURIComponent(f.code)}`, {
        name: f.name, color: f.color, category: f.category, appliesTo: f.appliesTo, active: f.active, sortOrder: f.sortOrder, description: f.description || null,
      });
      onSaved();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Modal title={status ? `Status „${status.name}“` : 'Neuer Ausführungsstatus'} help="admin-workflow" onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Abbrechen</button><button className="primary" onClick={save} disabled={!f.code || !f.name} title={!f.code || !f.name ? 'Code und Name sind Pflicht' : undefined}>Speichern</button></>}>
      <ErrorNote error={error} />
      <div className="grid2">
        <label className="field">Code (A–Z, 0–9, _)<input value={f.code} disabled={!!status} onChange={(e) => set({ code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} autoFocus={!status} /></label>
        <label className="field">Name<input value={f.name} onChange={(e) => set({ name: e.target.value })} autoFocus={!!status} /></label>
        <label className="field">Kategorie
          <select value={f.category} onChange={(e) => set({ category: e.target.value as StatusCategory })} disabled={status?.code === 'NOT_EXECUTED'}>
            {Object.entries(EXEC_CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="field">gilt für
          <select value={f.appliesTo} onChange={(e) => set({ appliesTo: e.target.value as ExecutionStatus['appliesTo'] })}>
            {Object.entries(APPLIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="field">Farbe<input type="color" value={f.color} onChange={(e) => set({ color: e.target.value })} style={{ height: 34, padding: 2 }} /></label>
        <label className="field">Reihenfolge<input type="number" value={f.sortOrder} onChange={(e) => set({ sortOrder: Number(e.target.value) })} /></label>
      </div>
      <label className="field">Beschreibung (wann verwenden?)<textarea rows={3} value={f.description ?? ''} onChange={(e) => set({ description: e.target.value })} /></label>
      <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.active} disabled={status?.code === 'NOT_EXECUTED'} onChange={(e) => set({ active: e.target.checked })} />
        aktiv (wird bei der Durchführung angeboten)</label>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------

function TestCaseWorkflow() {
  const wf = useApi<Workflow>('/api/test-case-workflow');
  const [editing, setEditing] = useState<TestCaseStatus | 'new' | null>(null);
  const [rules, setRules] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (wf.data) setRules(new Set(wf.data.transitions.map((t) => `${t.from}→${t.to}`)));
    setDirty(false);
  }, [wf.data]);

  const statuses = wf.data?.statuses ?? [];
  const toggle = (from: string, to: string) => {
    setRules((r) => {
      const n = new Set(r);
      const k = `${from}→${to}`;
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
    setDirty(true);
  };
  async function saveRules() {
    try {
      await api('PUT', '/api/admin/test-case-transitions', { transitions: [...rules].map((k) => { const [from, to] = k.split('→'); return { from, to }; }) });
      toast('Übergänge gespeichert');
      invalidateStatuses();
      wf.reload();
    } catch (e) {
      setError(e);
    }
  }
  const free = (from: string) => ![...rules].some((k) => k.startsWith(`${from}→`));

  return (
    <div className="stack">
      <p className="small muted">
        Status eines Testfalls mit Bedeutung (Kategorie). Übernommene Jira-Status stehen ebenfalls hier und können umbenannt,
        eingeordnet oder deaktiviert werden. Der <strong>Ausgangsstatus</strong> gilt für neue Testfälle und Kopien.
      </p>
      <div className="row"><span className="spacer" /><button className="primary" onClick={() => setEditing('new')}>+ Status</button></div>
      <ErrorNote error={error ?? wf.error} />
      {(() => {
        const care = statuses.filter((s) => s.active && needsCare(s));
        return care.length > 0 && <div className="notice warn small" role="status">
          <b>{care.length === 1 ? '1 Status wirkt' : `${care.length} Status wirken`} ungepflegt</b> (meist aus der Migration übernommen): {care.map((s) => `„${s.name}“`).join(', ')}.
          Diese Namen erscheinen so in Listen und Berichten. Bitte deutsch benennen, Kategorie und Farbe zuordnen oder deaktivieren – „Bearbeiten“ in der jeweiligen Zeile.
        </div>;
      })()}
      <div className="table-wrap">
        <table>
          <thead><tr><th className="fit" /><th>Name</th><th className="fit">Code</th><th className="fit">Kategorie</th><th className="fit">Testfälle</th><th className="fit" /></tr></thead>
          <tbody>
            {statuses.map((s) => (
              <tr key={s.code} className={s.active ? '' : 'muted'}>
                <td className="fit"><Swatch color={s.color} /></td>
                <td>{s.name}{s.isInitial && <span className="badge accent" style={{ marginLeft: 6 }}>Ausgangsstatus</span>}
                  {!s.active && <span className="badge" style={{ marginLeft: 6 }}>deaktiviert</span>}
                  {s.active && needsCare(s) && <span className="badge warn" style={{ marginLeft: 6 }} title={needsCare(s)!}>prüfen: {needsCare(s)}</span>}
                  {s.description && <div className="small muted">{s.description}</div>}</td>
                <td className="fit mono small">{s.code}</td>
                <td className="fit small">{TC_CATEGORY[s.category]}</td>
                <td className="fit small">{s.inUse?.toLocaleString('de-DE')}</td>
                <td className="fit"><button className="small" onClick={() => setEditing(s)}>Bearbeiten</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row"><h3>Erlaubte Übergänge</h3><span className="spacer" />
        {dirty && <span className="small muted">ungespeicherte Änderungen</span>}
        <button className="primary" disabled={!dirty} onClick={saveRules}>Übergänge speichern</button>
      </div>
      <p className="small muted">Zeile = von, Spalte = nach. Hat ein Status keine Haken, ist der Wechsel von ihm aus frei.</p>
      <div className="table-wrap">
        <table className="matrix">
          <thead><tr><th>von \ nach</th>{statuses.filter((s) => s.active).map((s) => <th key={s.code} className="small" title={s.code}>{s.name}</th>)}</tr></thead>
          <tbody>
            {statuses.filter((s) => s.active).map((from) => (
              <tr key={from.code}>
                <th className="small" style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>{from.name}{free(from.code) && <span className="muted"> · frei</span>}</th>
                {statuses.filter((s) => s.active).map((to) => (
                  <td key={to.code} style={{ textAlign: 'center' }}>
                    {from.code !== to.code && <input type="checkbox" style={{ width: 'auto' }} aria-label={`${from.name} → ${to.name}`}
                      checked={rules.has(`${from.code}→${to.code}`)} onChange={() => toggle(from.code, to.code)} />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <TestCaseStatusEditor status={editing === 'new' ? null : editing} nextSort={statuses.length + 1}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidateStatuses(); wf.reload(); }} />}
    </div>
  );
}

function TestCaseStatusEditor({ status, nextSort, onClose, onSaved }: { status: TestCaseStatus | null; nextSort: number; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Omit<TestCaseStatus, 'inUse'>>(() => status ?? {
    code: '', name: '', category: 'DRAFT', color: '#6b778c', sortOrder: nextSort, active: true, isInitial: false, description: null,
  });
  const [error, setError] = useState<unknown>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  async function save() {
    try {
      await api('PUT', `/api/admin/test-case-statuses/${encodeURIComponent(f.code)}`, {
        name: f.name, category: f.category, color: f.color, sortOrder: f.sortOrder, active: f.active, isInitial: f.isInitial, description: f.description || null,
      });
      onSaved();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Modal title={status ? `Testfall-Status „${status.name}“` : 'Neuer Testfall-Status'} help="admin-workflow" onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Abbrechen</button><button className="primary" onClick={save} disabled={!f.code || !f.name} title={!f.code || !f.name ? 'Code und Name sind Pflicht' : undefined}>Speichern</button></>}>
      <ErrorNote error={error} />
      <div className="grid2">
        <label className="field">Code<input value={f.code} disabled={!!status} onChange={(e) => set({ code: e.target.value.replace(/[/\\?#]/g, '') })} autoFocus={!status} /></label>
        <label className="field">Name<input value={f.name} onChange={(e) => set({ name: e.target.value })} autoFocus={!!status} /></label>
        <label className="field">Kategorie
          <select value={f.category} onChange={(e) => set({ category: e.target.value as TestCaseStatusCategory })}>
            {Object.entries(TC_CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="field">Farbe<input type="color" value={f.color} onChange={(e) => set({ color: e.target.value })} style={{ height: 34, padding: 2 }} /></label>
        <label className="field">Reihenfolge<input type="number" value={f.sortOrder} onChange={(e) => set({ sortOrder: Number(e.target.value) })} /></label>
      </div>
      <label className="field">Beschreibung<textarea rows={3} value={f.description ?? ''} onChange={(e) => set({ description: e.target.value })} /></label>
      <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.isInitial} onChange={(e) => set({ isInitial: e.target.checked })} />Ausgangsstatus für neue Testfälle</label>
      <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.active} onChange={(e) => set({ active: e.target.checked })} />aktiv (wählbar)</label>
    </Modal>
  );
}
