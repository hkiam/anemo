import { useState } from 'react';
import { api, fmtDate, useApi } from '../api.ts';
import { useCan } from '../session.tsx';
import { askConfirm, toast } from '../ux.tsx';
import { WikiEditor } from '../wiki/WikiEditor.tsx';
import { ErrorNote, Modal, Wiki } from './common.tsx';
import { Discussion } from './Discussion.tsx';

export interface Precondition {
  id: string; key: string; title: string; content: string | null; currentVersion: number; archivedAt: string | null; usage?: number;
  createdBy: string; updatedAt: string;
}

/** Verknüpfte Vorbedingungen (lesend): Schlüssel, Titel, Inhalt der aktuellen Version. */
export function PreconditionList({ projectKey, ids, compact }: { projectKey: string; ids: string[]; compact?: boolean }) {
  const list = useApi<Precondition[]>(ids.length ? `/api/projects/${projectKey}/preconditions?ids=${ids.join(',')}` : null);
  if (!ids.length) return null;
  const byId = new Map((list.data ?? []).map((p) => [p.id, p]));
  return (
    <div className={`precondition-list ${compact ? 'compact' : ''}`}>
      {ids.map((id) => byId.get(id)).filter(Boolean).map((p) => (
        <details key={p!.id} className="precondition" open={!compact}>
          <summary><span className="badge neutral mono">{p!.key}</span> <b>{p!.title}</b> <span className="small muted">v{p!.currentVersion}</span>
            {p!.archivedAt && <span className="badge warn" title="archiviert – bleibt an bestehenden Testfällen">archiviert</span>}</summary>
          {p!.content ? <Wiki text={p!.content} /> : <span className="small muted">ohne Beschreibung</span>}
        </details>
      ))}
    </div>
  );
}

/** Auswahl im Testfall-Editor: verknüpfte Vorbedingungen, suchen, neu anlegen. */
export function PreconditionPicker({ projectKey, value, onChange }: { projectKey: string; value: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const found = useApi<Precondition[]>(open ? `/api/projects/${projectKey}/preconditions${q ? `?q=${encodeURIComponent(q)}` : ''}` : null);
  const chosen = useApi<Precondition[]>(value.length ? `/api/projects/${projectKey}/preconditions?ids=${value.join(',')}` : null);
  const byId = new Map((chosen.data ?? []).map((p) => [p.id, p]));
  const move = (i: number, d: number) => { const n = [...value]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; onChange(n); };
  return (
    <div className="stack" style={{ gap: 6 }}>
      {value.length > 0 && <ul className="precondition-chips">
        {value.map((id, i) => {
          const p = byId.get(id);
          return <li key={id}><span className="badge neutral mono">{p?.key ?? '…'}</span> {p?.title}
            <span className="spacer" />
            <button type="button" className="ghost small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="nach oben">↑</button>
            <button type="button" className="ghost small" aria-label={`${p?.key ?? 'Vorbedingung'} entfernen`} onClick={() => onChange(value.filter((x) => x !== id))}>✕</button></li>;
        })}
      </ul>}
      <div className="aql-box">
        <input type="search" value={q} placeholder="Wiederverwendbare Vorbedingung suchen und verknüpfen …" onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }} aria-label="Vorbedingung suchen" />
        {open && <ul className="aql-suggest" role="listbox">
          {(found.data ?? []).filter((p) => !value.includes(p.id)).slice(0, 12).map((p) => (
            <li key={p.id} onMouseDown={(e) => { e.preventDefault(); onChange([...value, p.id]); setQ(''); setOpen(false); }}>
              <span className="mono small">{p.key}</span> {p.title} <span className="small muted">{p.usage ? `· in ${p.usage} Testfällen` : ''}</span></li>
          ))}
          <li onMouseDown={(e) => { e.preventDefault(); setCreating(true); setOpen(false); }}><b>+ Neue Vorbedingung{q ? ` „${q}“` : ''} anlegen …</b></li>
        </ul>}
      </div>
      {creating && <PreconditionEditor projectKey={projectKey} initialTitle={q} onClose={() => setCreating(false)}
        onSaved={(p) => { setCreating(false); setQ(''); onChange([...value, p.id]); }} />}
    </div>
  );
}

export function PreconditionEditor({ projectKey, existing, initialTitle, onClose, onSaved }: {
  projectKey: string; existing?: Precondition; initialTitle?: string; onClose: () => void; onSaved: (p: Precondition) => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? initialTitle ?? '');
  const [content, setContent] = useState(existing?.content ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    try {
      const p = existing
        ? await api<Precondition>('PUT', `/api/preconditions/${existing.id}`, { title, content: content || null, changeNote: note || null, expectedVersion: existing.currentVersion })
        : await api<Precondition>('POST', `/api/projects/${projectKey}/preconditions`, { title, content: content || null });
      toast(existing ? `${p.key} gespeichert (v${p.currentVersion}) – gilt in allen verwendenden Testfällen` : `Vorbedingung ${p.key} angelegt`);
      onSaved(p);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal size="large" title={existing ? `Vorbedingung ${existing.key} bearbeiten` : 'Neue Vorbedingung'} onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!title.trim()} onClick={save}>Speichern</button></>}>
      <ErrorNote error={error} />
      <label className="field">Titel<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="z. B. Testmandant mit Akte vorbereitet" /></label>
      <div className="field">Beschreibung (was muss vorliegen, wie herstellen)
        <WikiEditor label="Beschreibung" value={content} onChange={setContent} minRows={8} placeholder="Daten, Rechte, Systemzustand – ggf. mit Schritten zum Herstellen" /></div>
      {existing && <label className="field">Änderungsnotiz<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional – erscheint in der Versionshistorie" /></label>}
      {existing && (existing.usage ?? 0) > 0 && <div className="notice info small">Die Änderung gilt sofort in {existing.usage} Testfällen (neue Version der Vorbedingung, Testfälle bleiben unverändert).</div>}
    </Modal>
  );
}

/** Verwaltung aller Vorbedingungen eines Projekts. */
export function PreconditionsDialog({ projectKey, onClose }: { projectKey: string; onClose: () => void }) {
  const canEdit = useCan(projectKey, 'edit');
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const list = useApi<Precondition[]>(`/api/projects/${projectKey}/preconditions?archived=${archived}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const [editing, setEditing] = useState<Precondition | 'new' | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); list.reload(); } catch (e) { setError(e); } };
  return (
    <Modal size="large" title="Vorbedingungen" onClose={onClose} footer={<button onClick={onClose}>Schließen</button>}>
      <p className="small muted">Wiederverwendbare Vorbedingungen werden einmal gepflegt und in beliebig vielen Testfällen verknüpft. Änderungen ergeben eine neue Version
        und gelten sofort überall; Durchführung und Berichte zeigen den aktuellen Stand mit Versionsnummer.</p>
      <ErrorNote error={error ?? list.error} />
      <div className="row">
        <input type="search" placeholder="Suchen …" aria-label="Vorbedingungen suchen" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, width: 'auto' }} />
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={archived} onChange={(e) => setArchived(e.target.checked)} /> archivierte zeigen</label>
        {canEdit && <button className="primary small" onClick={() => setEditing('new')}>+ Vorbedingung</button>}
      </div>
      <div className="table-wrap" style={{ maxHeight: 420 }}><table>
        <thead><tr><th className="fit">Schlüssel</th><th>Titel</th><th className="fit">Version</th><th className="fit">verwendet</th><th className="fit" /></tr></thead>
        <tbody>{(list.data ?? []).map((p) => (
          <tr key={p.id} className={`clickable ${p.archivedAt ? 'muted' : ''}`} onClick={() => setDetail(p.id)}>
            <td className="fit mono small">{p.key}</td><td><button type="button" className="link" onClick={(e) => { e.stopPropagation(); setDetail(p.id); }} title="Inhalt, Versionen und Verwendung ansehen">{p.title}</button>{p.archivedAt && <span className="badge warn"> archiviert</span>}</td>
            <td className="fit small">v{p.currentVersion}</td><td className="fit small">{p.usage ?? 0}</td>
            <td className="fit" onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
              {canEdit && <button className="small" onClick={() => setEditing(p)} title="Bearbeiten" aria-label={`${p.key} bearbeiten`}>✎</button>}
              {canEdit && <button className="small ghost" title={p.archivedAt ? 'Wiederherstellen' : 'Archivieren (nicht mehr neu verknüpfbar)'}
                aria-label={`${p.key} ${p.archivedAt ? 'wiederherstellen' : 'archivieren'}`}
                onClick={() => act(() => api('POST', `/api/preconditions/${p.id}/archive`, { archived: !p.archivedAt }))}><span aria-hidden="true">{p.archivedAt ? '↺' : '🗄'}</span></button>}
              {canEdit && !p.usage && <button className="small ghost danger" aria-label={`${p.key} löschen`} onClick={async () => {
                if (await askConfirm({ title: `${p.key} löschen`, message: 'Endgültig löschen? Nur möglich, wenn nie verwendet.', confirmLabel: 'Löschen', danger: true })) await act(() => api('DELETE', `/api/preconditions/${p.id}`));
              }}>✕</button>}
            </td>
          </tr>
        ))}</tbody>
      </table>{list.data?.length === 0 && <div className="empty">Keine Vorbedingungen.</div>}</div>
      {editing && <PreconditionEditor projectKey={projectKey} existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
      {detail && <PreconditionDetail id={detail} projectKey={projectKey} onClose={() => setDetail(null)} />}
    </Modal>
  );
}

function PreconditionDetail({ id, projectKey, onClose }: { id: string; projectKey: string; onClose: () => void }) {
  const d = useApi<Precondition & { versions: { versionNo: number; changeNote: string | null; createdAt: string; createdBy: string }[]; usedBy: { key: string; title: string }[] }>(`/api/preconditions/${id}`);
  if (!d.data) return null;
  const p = d.data;
  return (
    <Modal size="large" title={`${p.key} – ${p.title}`} onClose={onClose} footer={<button onClick={onClose}>Schließen</button>}>
      {p.content ? <Wiki text={p.content} /> : <p className="muted">ohne Beschreibung</p>}
      <div className="grid2">
        <div><h4>Verwendet in ({p.usedBy.length})</h4><ul className="small">{p.usedBy.map((u) => <li key={u.key}><a href={`#/p/${projectKey}/repo?tc=${u.key}`}>{u.key}</a> {u.title}</li>)}</ul></div>
        <div><h4>Versionen</h4><ul className="small">{p.versions.map((v) => <li key={v.versionNo}>v{v.versionNo} · {fmtDate(v.createdAt)} · {v.createdBy}{v.changeNote ? ` – ${v.changeNote}` : ''}</li>)}</ul></div>
      </div>
      <Discussion projectKey={projectKey} ownerType="PRECONDITION" ownerId={p.id} />
    </Modal>
  );
}
