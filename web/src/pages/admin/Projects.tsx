import { useState } from 'react';
import { api, useApi } from '../../api.ts';
import { ErrorNote, Modal } from '../../components/common.tsx';
import { AccessLog } from './AccessLog.tsx';
import { ProjectMembers } from './ProjectMembers.tsx';
import { ActionMenu, askConfirm, askText, notifyChanged, toast } from '../../ux.tsx';
import { AiContextDialog } from '../../components/AiContext.tsx';

interface AdminProject { id: string; key: string; name: string; visibility: 'internal' | 'restricted'; externalServices: 'allowed' | 'blocked'; requireFailureEvidence: boolean; members: number; testCases: number; executeOnlyAssignee?: boolean }

export function Projects() {
  const projects = useApi<AdminProject[]>('/api/admin/projects');
  const [open, setOpen] = useState<AdminProject | null>(null);
  const [logOf, setLogOf] = useState<AdminProject | null>(null);
  const [filter, setFilter] = useState('');
  const [only, setOnly] = useState<'' | 'internal' | 'restricted'>('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [aiCtx, setAiCtx] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function setExternal(p: AdminProject, externalServices: AdminProject['externalServices']) {
    if (externalServices === 'allowed' && p.visibility === 'restricted'
      && !(await askConfirm({ title: 'Externe Dienste freigeben', message: `${p.key} ist eingeschränkt. Inhalte dürfen dann an externe Dienste (z. B. KI, Integrationen) übertragen werden. Fortfahren?`, confirmLabel: 'Freigeben', danger: true }))) return;
    try {
      await api('PUT', `/api/projects/${p.key}/external-services`, { externalServices });
      projects.reload();
    } catch (e) {
      setError(e);
    }
  }
  async function setEvidence(p: AdminProject, requireFailureEvidence: boolean) {
    try {
      await api('PUT', `/api/projects/${p.key}/settings`, { requireFailureEvidence });
      toast(`${p.key}: Nachweispflicht bei Fehlschlag ${requireFailureEvidence ? 'an' : 'aus'}`);
      projects.reload();
    } catch (e) {
      setError(e);
    }
  }
  async function setOnlyAssignee(p: AdminProject, executeOnlyAssignee: boolean) {
    try {
      await api('PUT', `/api/projects/${p.key}/settings`, { executeOnlyAssignee });
      toast(`${p.key}: Ergebnisse ${executeOnlyAssignee ? 'nur noch durch die zuständige Person' : 'durch alle mit Recht „Ausführen“'}`);
      projects.reload();
    } catch (e) {
      setError(e);
    }
  }
  async function rename(p: AdminProject) {
    const name = await askText({ title: `${p.key} umbenennen`, label: 'Name', initial: p.name, confirmLabel: 'Umbenennen',
      hint: 'Der Schlüssel bleibt – er steckt in allen Testfallschlüsseln (z. B. ' + p.key + '-T1).' });
    if (!name?.trim() || name.trim() === p.name) return;
    try { await api('PATCH', `/api/projects/${p.key}`, { name: name.trim() }); notifyChanged('project', p.key); projects.reload(); toast('Projekt umbenannt'); } catch (e) { setError(e); }
  }
  async function remove(p: AdminProject) {
    const typed = await askText({
      title: `Projekt ${p.key} endgültig löschen`, label: 'Zur Bestätigung den Projektschlüssel eingeben', placeholder: p.key, confirmLabel: 'Endgültig löschen',
      hint: `Löscht ${p.testCases} Testfälle mit allen Versionen, Zyklen, Ausführungen, Anhängen und Verweisen. Das Ereignisprotokoll bleibt erhalten. Nicht rückgängig zu machen.`,
    });
    if (typed === null) return;
    try {
      const r = await api<{ testCases: number; cycles: number; executions: number }>('DELETE', `/api/projects/${p.key}`, { confirmKey: typed.trim() });
      toast(`Projekt ${p.key} gelöscht (${r.testCases} Testfälle, ${r.cycles} Zyklen, ${r.executions} Ausführungen)`);
      notifyChanged('project', p.key);
      projects.reload();
    } catch (e) { setError(e); }
  }
  /** Rückfrage vor dem Einschränken: ohne Mitglieder sehen es danach nur noch Systemadministratoren. */
  async function confirmRestrict(list: AdminProject[]): Promise<boolean> {
    const empty = list.filter((p) => p.members === 0);
    return askConfirm({
      title: list.length === 1 ? `${list[0]!.key} einschränken` : `${list.length} Projekte einschränken`,
      message: <div className="stack">
        <span>Nur Mitglieder sehen {list.length === 1 ? 'das Projekt' : 'diese Projekte'} danach noch (Suche, Berichte, Anhänge eingeschlossen). Zugriffe werden protokolliert, externe Dienste werden gesperrt.</span>
        {empty.length > 0 && <span className="notice warn">Ohne Mitglieder: {empty.map((p) => p.key).join(', ')} – bis Sie Mitglieder oder Gruppen zuordnen, sehen diese nur Systemadministratoren.</span>}
      </div>,
      confirmLabel: 'Einschränken',
    });
  }
  async function setVisibility(list: AdminProject[], visibility: AdminProject['visibility']) {
    const todo = list.filter((p) => p.visibility !== visibility);
    if (!todo.length) return;
    if (visibility === 'restricted' && !(await confirmRestrict(todo))) return;
    try {
      for (const p of todo) await api('PUT', `/api/projects/${p.key}/visibility`, { visibility });
      toast(`${todo.length === 1 ? todo[0]!.key : `${todo.length} Projekte`}: ${visibility === 'restricted' ? 'eingeschränkt' : 'intern'}`);
      setSel(new Set());
      projects.reload();
    } catch (e) {
      setError(e);
      projects.reload();
    }
  }
  const shown = (projects.data ?? []).filter((p) => (!only || p.visibility === only) && `${p.key} ${p.name}`.toLowerCase().includes(filter.toLowerCase()));
  const selected = shown.filter((p) => sel.has(p.id));
  const restrictedCount = (projects.data ?? []).filter((p) => p.visibility === 'restricted').length;

  return (
    <div className="stack">
      <div className="row">
        <h2>Projekte &amp; Rechte</h2><span className="spacer" />
        <select value={only} onChange={(e) => setOnly(e.target.value as typeof only)} aria-label="Nach Sichtbarkeit filtern" style={{ width: 'auto' }}>
          <option value="">Alle ({projects.data?.length ?? 0})</option>
          <option value="internal">Intern ({(projects.data?.length ?? 0) - restrictedCount})</option>
          <option value="restricted">Eingeschränkt ({restrictedCount})</option>
        </select>
        <input type="search" placeholder="Schlüssel oder Name filtern …" aria-label="Projekte filtern" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 240 }} />
        <button className="primary" onClick={() => setCreating(true)}>+ Projekt</button>
      </div>
      {creating && <NewProject existing={(projects.data ?? []).map((p) => p.key)} onClose={() => setCreating(false)}
        onCreated={(key) => { setCreating(false); projects.reload(); setFilter(key); }} />}
      {selected.length > 0 && (
        <div className="notice info row">{selected.length} ausgewählt<span className="spacer" />
          <button className="small" onClick={() => setVisibility(selected, 'restricted')}>Einschränken</button>
          <button className="small" onClick={() => setVisibility(selected, 'internal')}>Intern machen</button>
          <button className="small ghost" onClick={() => setSel(new Set())}>Auswahl aufheben</button>
        </div>
      )}
      <p className="small muted">
        <strong>Intern:</strong> alle angemeldeten Benutzer dürfen lesen, Mitglieder erhalten weitere Rechte.{' '}
        <strong>Eingeschränkt:</strong> nur Mitglieder sehen das Projekt überhaupt (z. B. Behörden mit besonderem Schutzbedarf); Zugriffe werden protokolliert.{' '}
        <strong>Externe Dienste gesperrt:</strong> keine Inhalte an KI-Funktionen oder Integrationen, die Inhalte übertragen.
      </p>
      <ErrorNote error={error ?? projects.error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th style={{ width: 28 }}><input type="checkbox" style={{ width: 'auto' }} aria-label="Alle angezeigten auswählen"
            checked={shown.length > 0 && shown.every((p) => sel.has(p.id))} onChange={(e) => setSel(e.target.checked ? new Set(shown.map((p) => p.id)) : new Set())} /></th><th className="fit">Schlüssel</th><th>Name</th><th className="fit">Testfälle</th><th className="fit">Sichtbarkeit</th><th className="fit wrap">Externe Dienste</th><th className="fit wrap" title="Fehlgeschlagen/blockiert nur mit Kommentar oder verknüpftem Fehler">Nachweis&shy;pflicht</th><th className="fit wrap" title="Zugewiesene Ausführungen darf nur die zuständige Person erfassen (Testleitung ausgenommen)">Nur Zu&shy;ständige</th><th className="fit">Mitglieder</th><th className="fit" /></tr></thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id} className={sel.has(p.id) ? 'selected' : ''}>
                <td><input type="checkbox" style={{ width: 'auto' }} aria-label={`${p.key} auswählen`} checked={sel.has(p.id)}
                  onChange={(e) => setSel((s) => { const n = new Set(s); e.target.checked ? n.add(p.id) : n.delete(p.id); return n; })} /></td>
                <td className="fit"><strong>{p.key}</strong></td>
                <td>{p.name}</td>
                <td className="fit small">{p.testCases}</td>
                <td className="fit">
                  <select style={{ width: 'auto' }} value={p.visibility} onChange={(e) => setVisibility([p], e.target.value as AdminProject['visibility'])} aria-label={`Sichtbarkeit ${p.key}`}>
                    <option value="internal">Intern</option>
                    <option value="restricted">Eingeschränkt</option>
                  </select>
                </td>
                <td className="fit">
                  <select style={{ width: 'auto' }} value={p.externalServices} onChange={(e) => setExternal(p, e.target.value as AdminProject['externalServices'])} aria-label={`Externe Dienste ${p.key}`}>
                    <option value="allowed">erlaubt</option>
                    <option value="blocked">gesperrt</option>
                  </select>
                </td>
                <td className="fit"><input type="checkbox" style={{ width: 'auto' }} checked={p.requireFailureEvidence} aria-label={`Nachweispflicht ${p.key}`}
                  onChange={(e) => setEvidence(p, e.target.checked)} title="Fehlgeschlagen/blockiert nur mit Kommentar oder verknüpftem Fehler speichern" /></td>
                <td className="fit"><input type="checkbox" style={{ width: 'auto' }} checked={!!p.executeOnlyAssignee} aria-label={`Nur Zuständige ${p.key}`}
                  onChange={(e) => setOnlyAssignee(p, e.target.checked)} title="Zugewiesene Ausführungen darf nur die zuständige Person erfassen; nicht zugewiesene bleiben offen, die Testleitung ist ausgenommen" /></td>
                <td className="fit small">{p.visibility === 'restricted' && p.members === 0 ? <span className="badge warn" title="Eingeschränkt ohne Mitglieder – nur Systemadministratoren sehen das Projekt">0 ⚠</span> : p.members}</td>
                <td className="fit" style={{ whiteSpace: 'normal' }}>
                  <button className="small" onClick={() => setOpen(p)} aria-label={`Mitglieder von ${p.key} …`}>Mitglieder …</button>{' '}
                  <ActionMenu label="⋯ Mehr" ariaLabel={`Weitere Aktionen zu Projekt ${p.key}`} items={[
                    { label: '✎ Umbenennen …', onClick: () => void rename(p) },
                    { label: 'KI-Kontext …', title: 'Glossar und Stilregeln für KI-Skills', onClick: () => setAiCtx(p.key) },
                    { label: 'Zugriffsprotokoll …', title: 'Wer hat das eingeschränkte Projekt geöffnet', onClick: () => setLogOf(p), hidden: p.visibility !== 'restricted' },
                    { label: '🗑 Projekt löschen …', title: 'Mit allen Inhalten – Bestätigung durch Eingabe des Schlüssels', onClick: () => void remove(p) },
                  ]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {aiCtx && <AiContextDialog projectKey={aiCtx} onClose={() => setAiCtx(null)} />}
      {logOf && (
        <Modal size="large" title={`Zugriffsprotokoll ${logOf.key}`} onClose={() => setLogOf(null)} footer={<button onClick={() => setLogOf(null)}>Schließen</button>}>
          <AccessLog projectKey={logOf.key} />
        </Modal>
      )}
      {open && (
        <Modal title={`Mitglieder ${open.key} – ${open.name}`} help="admin-projects" onClose={() => { setOpen(null); projects.reload(); }}
          footer={<button onClick={() => { setOpen(null); projects.reload(); }}>Schließen</button>}>
          <ProjectMembers projectKey={open.key} />
        </Modal>
      )}
    </div>
  );
}

function NewProject({ existing, onClose, onCreated }: { existing: string[]; onClose: () => void; onCreated: (key: string) => void }) {
  const [f, setF] = useState({ key: '', name: '', description: '', restricted: false });
  const [error, setError] = useState<unknown>(null);
  const key = f.key.trim().toUpperCase();
  const keyError = !key ? null : !/^[A-Z][A-Z0-9_]{1,19}$/.test(key) ? 'Großbuchstaben, Ziffern und _, 2–20 Zeichen, beginnt mit Buchstaben'
    : existing.includes(key) ? 'Dieser Schlüssel ist bereits vergeben' : null;
  const save = async () => {
    try {
      await api('POST', '/api/projects', { key, name: f.name.trim(), description: f.description.trim() || null });
      if (f.restricted) await api('PUT', `/api/projects/${key}/visibility`, { visibility: 'restricted' });
      toast(`Projekt ${key} angelegt${f.restricted ? ' (eingeschränkt)' : ''} – jetzt Mitglieder zuordnen`);
      notifyChanged('project', key);
      onCreated(key);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal title="Neues Projekt" help="admin-projects" onClose={onClose} footer={<><button onClick={onClose}>Abbrechen</button>
      <button className="primary" disabled={!key || !!keyError || !f.name.trim()} onClick={save}>Anlegen</button></>}>
      <ErrorNote error={error} />
      <div className="grid2">
        <label className="field">Schlüssel<input autoFocus value={f.key} onChange={(e) => setF({ ...f, key: e.target.value.toUpperCase() })} placeholder="z. B. DEMO" maxLength={20} />
          {keyError ? <span className="small err">{keyError}</span> : <span className="small muted">Präfix der Testfälle, z. B. {key || 'DEMO'}-T1; nicht änderbar</span>}</label>
        <label className="field">Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Online-Shop" /></label>
      </div>
      <label className="field">Beschreibung<textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.restricted} onChange={(e) => setF({ ...f, restricted: e.target.checked })} />
        Eingeschränkt (nur Mitglieder sehen das Projekt; externe Dienste gesperrt)</label>
    </Modal>
  );
}
