import { useState } from 'react';
import { api, ApiError, fmtDate, useApi } from '../api.ts';
import { useCan } from '../session.tsx';
import { askConfirm, toast, useUnsavedGuard } from '../ux.tsx';
import { plural } from '../text.ts';
import { WikiEditor } from '../wiki/WikiEditor.tsx';
import { ErrorNote, Modal, Wiki } from './common.tsx';

/** Schritt eines Bausteins (ohne ID – beim Einfügen vergibt der Server neue IDs). */
export interface BlockStep { action: string; data: string; expected: string }

export interface StepBlock {
  id: string; name: string; description: string | null; steps: BlockStep[]; tags: string[];
  usage: number; archivedAt: string | null; updatedAt: string; updatedBy: string;
}

const HINT = 'Eingefügte Schritte sind Kopien – spätere Änderungen am Baustein wirken nur auf künftiges Einfügen. '
  + 'Für zentral gepflegte Abläufe, die überall gleich bleiben sollen, eignet sich ein „aufrufbarer Test“ (↪ Testfall aufrufen).';

const hasContent = (s: BlockStep) => !!(s.action.trim() || s.data.trim() || s.expected.trim());
const blocksUrl = (projectKey: string, q: string, archived: boolean) =>
  `/api/projects/${projectKey}/step-blocks?archived=${archived}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`;

/** Schritte eines Bausteins lesend (Vorschau, Detail). */
export function BlockStepsPreview({ steps }: { steps: BlockStep[] }) {
  return (
    <div className="table-wrap">
      <table className="steps">
        <thead><tr><th>#</th><th>Aktion</th><th>Testdaten</th><th>Erwartetes Ergebnis</th></tr></thead>
        <tbody>{steps.map((s, i) => (
          <tr key={i}><td className="n">{i + 1}</td><td><Wiki text={s.action} compact /></td><td><Wiki text={s.data} compact /></td><td><Wiki text={s.expected} compact /></td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Tags({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return <span className="block-tags">{tags.map((t) => <span key={t} className="badge neutral">{t}</span>)}</span>;
}

/** Auswahl im Testfall-Editor: Baustein suchen, Schritte ansehen, als Kopie einfügen. */
export function StepBlockPicker({ projectKey, insertAfter, onClose, onInsert }: {
  projectKey: string; insertAfter?: number | null; onClose: () => void; onInsert: (block: StepBlock) => void;
}) {
  const [q, setQ] = useState('');
  const list = useApi<StepBlock[]>(blocksUrl(projectKey, q, false));
  const [chosenId, setChosenId] = useState<string | null>(null);
  const items = list.data ?? [];
  const chosen = items.find((b) => b.id === chosenId) ?? null;
  return (
    <Modal help="step-library" size="large" title="Schritte aus der Bibliothek einfügen" onClose={onClose}
      footer={<><span className="small muted">{insertAfter != null ? `Einfügen nach Schritt ${insertAfter + 1}` : 'Einfügen am Ende'}</span><span className="spacer" />
        <button onClick={onClose}>Abbrechen</button>
        <button className="primary" disabled={!chosen} title={chosen ? undefined : 'Erst einen Baustein wählen'} onClick={() => chosen && onInsert(chosen)}>Einfügen{chosen ? ` (${plural(chosen.steps.length, 'Schritt', 'Schritte')})` : ''}</button></>}>
      <p className="small muted">{HINT}</p>
      <ErrorNote error={list.error} />
      <input type="search" autoFocus placeholder="Baustein suchen (Name, Schlagwort, Schritttext) …" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Baustein suchen" />
      <div className="block-picker">
        <div className="table-wrap" style={{ maxHeight: 380 }}>
          <table>
            <thead><tr><th>Baustein</th><th className="fit">Schritte</th><th className="fit">verwendet</th></tr></thead>
            <tbody>{items.map((b) => (
              <tr key={b.id} className={`clickable ${b.id === chosenId ? 'selected' : ''}`} onClick={() => setChosenId(b.id)} onDoubleClick={() => onInsert(b)} aria-selected={b.id === chosenId}>
                <td><button type="button" className="link" aria-pressed={b.id === chosenId} onClick={(e) => { e.stopPropagation(); setChosenId(b.id); }}
                  title="Wählen (Doppelklick: sofort einfügen)"><b>{b.name}</b></button> <Tags tags={b.tags} />{b.description && <div className="small muted">{b.description}</div>}</td>
                <td className="fit small">{b.steps.length}</td>
                <td className="fit small" title="Testfälle, deren aktuelle Version Schritte aus diesem Baustein enthält">{b.usage}</td>
              </tr>
            ))}</tbody>
          </table>
          {!list.data && !list.error && <div className="empty small">Lädt …</div>}
          {list.data && items.length === 0 && <div className="empty">{q ? 'Kein Baustein gefunden.' : 'Noch keine Bausteine – über „Als Baustein speichern …“ oder die Verwaltung (Testfälle → Bausteine → Schrittbibliothek …) anlegen.'}</div>}
        </div>
        <div className="block-preview">
          {chosen ? <><div className="small muted">Vorschau „{chosen.name}“</div><BlockStepsPreview steps={chosen.steps} /></>
            : <div className="empty small">Baustein wählen, um die Schritte zu sehen.</div>}
        </div>
      </div>
    </Modal>
  );
}

/** Baustein anlegen oder bearbeiten (Name, Schlagworte, Beschreibung, Schritte). */
export function StepBlockEditor({ projectKey, existing, initialSteps, onClose, onSaved }: {
  projectKey: string; existing?: StepBlock; initialSteps?: BlockStep[]; onClose: () => void; onSaved: (b: StepBlock) => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [tags, setTags] = useState((existing?.tags ?? []).join(', '));
  const [description, setDescription] = useState(existing?.description ?? '');
  const [steps, setSteps] = useState<BlockStep[]>(() => {
    const s = (existing?.steps ?? initialSteps ?? []).map((x) => ({ action: x.action ?? '', data: x.data ?? '', expected: x.expected ?? '' }));
    return s.length ? s : [{ action: '', data: '', expected: '' }];
  });
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  // Ausgangsstand für den Schutz ungespeicherter Eingaben
  const [initialState] = useState(() => JSON.stringify([name, tags, description, steps]));
  const dirty = JSON.stringify([name, tags, description, steps]) !== initialState;
  useUnsavedGuard(dirty, `block-${existing?.id ?? 'neu'}`);
  const close = async () => {
    if (dirty && !(await askConfirm({ title: 'Baustein nicht gespeichert', message: 'Die Änderungen am Baustein gehen beim Schließen verloren.', confirmLabel: 'Verwerfen', danger: true }))) return;
    onClose();
  };
  const setStep = (i: number, k: keyof BlockStep, v: string) => setSteps((all) => all.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const move = (i: number, d: -1 | 1) => setSteps((all) => {
    const j = i + d;
    if (j < 0 || j >= all.length) return all;
    const n = [...all];
    [n[i], n[j]] = [n[j]!, n[i]!];
    return n;
  });
  const filled = steps.filter(hasContent);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim() || null, steps: filled, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) };
      const b = existing
        ? await api<StepBlock>('PUT', `/api/step-blocks/${existing.id}`, body)
        : await api<StepBlock>('POST', `/api/projects/${projectKey}/step-blocks`, body);
      toast(existing ? `Baustein „${b.name}“ gespeichert – gilt für künftiges Einfügen` : `Baustein „${b.name}“ angelegt`);
      onSaved(b);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };
  const issues = error instanceof ApiError ? error.issues : [];
  return (
    <Modal help="step-library" size="large" title={existing ? `Baustein „${existing.name}“ bearbeiten` : 'Neuer Baustein'} onClose={() => void close()}
      footer={<><span className="spacer" /><button onClick={() => void close()}>Abbrechen</button>
        <button className="primary" disabled={saving || !name.trim() || filled.length === 0} onClick={save}
          title={!name.trim() ? 'Bitte einen Namen eingeben' : filled.length === 0 ? 'Mindestens ein Schritt mit Inhalt' : undefined}>{saving ? 'Speichert …' : 'Speichern'}</button></>}>
      <ErrorNote error={error && issues.length === 0 ? error : null} />
      {issues.length > 0 && <div className="notice bad">{issues.map((i, k) => <div key={k}>{i.message}</div>)}</div>}
      <div className="grid2">
        <label className="field">Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Anmelden als Sachbearbeitung" /></label>
        <label className="field">Schlagworte (Komma-getrennt)<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="z. B. anmeldung, suche" /></label>
      </div>
      <label className="field">Beschreibung<input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional – wofür, Voraussetzungen" /></label>
      {existing && existing.usage > 0 && <div className="notice info small">Bereits in {existing.usage} Testfällen eingefügt. Dort bleiben die Schritte unverändert – Änderungen gelten nur für künftiges Einfügen.</div>}
      <h4>Schritte</h4>
      <div className="steps-edit">
        <table className="steps">
          <colgroup><col style={{ width: 36 }} /><col style={{ width: '38%' }} /><col style={{ width: '22%' }} /><col style={{ width: '38%' }} /><col style={{ width: 92 }} /></colgroup>
          <thead><tr><th>#</th><th>Aktion</th><th>Testdaten</th><th>Erwartetes Ergebnis</th><th /></tr></thead>
          <tbody>{steps.map((s, i) => (
            <tr key={i}>
              <td className="n">{i + 1}</td>
              <td><WikiEditor compact minRows={2} value={s.action} onChange={(v) => setStep(i, 'action', v)} label={`Baustein-Aktion ${i + 1}`} /></td>
              <td><WikiEditor compact minRows={2} value={s.data} onChange={(v) => setStep(i, 'data', v)} label={`Baustein-Testdaten ${i + 1}`} /></td>
              <td><WikiEditor compact minRows={2} value={s.expected} onChange={(v) => setStep(i, 'expected', v)} label={`Baustein-Erwartung ${i + 1}`} /></td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="ghost small" onClick={() => move(i, -1)} title="nach oben" aria-label={`Schritt ${i + 1} nach oben`}>↑</button>
                <button className="ghost small" onClick={() => move(i, 1)} title="nach unten" aria-label={`Schritt ${i + 1} nach unten`}>↓</button>
                <button className="ghost small danger" onClick={() => setSteps((all) => all.filter((_, j) => j !== i))} title="entfernen" aria-label={`Schritt ${i + 1} entfernen`}>✕</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="row"><button className="small" onClick={() => setSteps((all) => [...all, { action: '', data: '', expected: '' }])}>+ Schritt</button>
        {filled.length === 0 && <span className="small muted">Mindestens ein Schritt mit Inhalt</span>}</div>
    </Modal>
  );
}

/** Detail: Schritte und verwendende Testfälle. */
function StepBlockDetail({ id, projectKey, onClose }: { id: string; projectKey: string; onClose: () => void }) {
  const d = useApi<StepBlock & { usedBy: { key: string; title: string }[] }>(`/api/step-blocks/${id}`);
  if (d.error) return <Modal title="Baustein" onClose={onClose} footer={<><span className="spacer" /><button onClick={onClose}>Schließen</button></>}><ErrorNote error={d.error} /></Modal>;
  if (!d.data) return <Modal title="Baustein" onClose={onClose}><div className="muted small">Lädt …</div></Modal>;
  const b = d.data;
  return (
    <Modal size="large" title={`Baustein „${b.name}“`} onClose={onClose} footer={<><span className="spacer" /><button onClick={onClose}>Schließen</button></>}>
      <div className="row small"><Tags tags={b.tags} /><span className="muted">geändert {fmtDate(b.updatedAt)} von {b.updatedBy}</span>
        {b.archivedAt && <span className="badge warn">archiviert</span>}</div>
      {b.description && <p>{b.description}</p>}
      <BlockStepsPreview steps={b.steps} />
      <h4>Verwendet in {plural(b.usedBy.length, 'Testfall', 'Testfällen')}</h4>
      {b.usedBy.length > 0
        ? <ul className="small block-used">{b.usedBy.map((u) => <li key={u.key}><a href={`#/p/${projectKey}/repo?tc=${u.key}`} onClick={onClose}>{u.key}</a> {u.title}</li>)}</ul>
        : <p className="small muted">Noch in keinem Testfall (aktuelle Versionen, ohne archivierte Testfälle).</p>}
    </Modal>
  );
}

/** Verwaltung der Schrittbibliothek eines Projekts. */
export function StepLibraryDialog({ projectKey, onClose }: { projectKey: string; onClose: () => void }) {
  const canEdit = useCan(projectKey, 'edit');
  const canManage = useCan(projectKey, 'manage');
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const list = useApi<StepBlock[]>(blocksUrl(projectKey, q, archived));
  const [editing, setEditing] = useState<StepBlock | 'new' | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast(msg); list.reload(); } catch (e) { setError(e); }
  };
  return (
    <Modal help="step-library" size="large" title="Schrittbibliothek" onClose={onClose} footer={<><span className="spacer" /><button onClick={onClose}>Schließen</button></>}>
      <p className="small muted">Bausteine sind benannte, wiederkehrende Schrittfolgen (z. B. Anmelden, Suche öffnen), die im Testfall-Editor über „Aus Bibliothek …“
        eingefügt werden. {HINT}</p>
      <ErrorNote error={error ?? list.error} />
      <div className="row">
        <input type="search" placeholder="Suchen (Name, Schlagwort, Schritttext) …" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, width: 'auto' }} aria-label="Bausteine suchen" />
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={archived} onChange={(e) => setArchived(e.target.checked)} /> archivierte zeigen</label>
        {canEdit && <button className="primary small" onClick={() => setEditing('new')}>+ Baustein</button>}
      </div>
      <div className="table-wrap" style={{ maxHeight: 420 }}><table>
        <thead><tr><th>Name</th><th className="fit">Schritte</th><th className="fit">verwendet</th><th className="fit">geändert</th><th className="fit" /></tr></thead>
        <tbody>{(list.data ?? []).map((b) => (
          <tr key={b.id} className={`clickable ${b.archivedAt ? 'muted' : ''}`} onClick={() => setDetail(b.id)}>
            <td><button type="button" className="link" onClick={(e) => { e.stopPropagation(); setDetail(b.id); }} title="Schritte und Verwendung ansehen"><b>{b.name}</b></button> <Tags tags={b.tags} />{b.archivedAt && <span className="badge warn"> archiviert</span>}
              {b.description && <div className="small muted">{b.description}</div>}</td>
            <td className="fit small">{b.steps.length}</td>
            <td className="fit small" title="Testfälle, deren aktuelle Version Schritte aus diesem Baustein enthält">{plural(b.usage, 'Testfall', 'Testfälle')}</td>
            <td className="fit small">{fmtDate(b.updatedAt)}</td>
            <td className="fit" onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
              {canEdit && <button className="small" onClick={() => setEditing(b)} aria-label={`${b.name} bearbeiten`} title="Bearbeiten">✎</button>}
              {canEdit && <button className="small ghost" title={b.archivedAt ? 'Wiederherstellen' : 'Archivieren (nicht mehr zum Einfügen angeboten)'}
                aria-label={`${b.name} ${b.archivedAt ? 'wiederherstellen' : 'archivieren'}`}
                onClick={() => act(() => api('POST', `/api/step-blocks/${b.id}/archive`, { archived: !b.archivedAt }), b.archivedAt ? `„${b.name}“ wiederhergestellt` : `„${b.name}“ archiviert`)}><span aria-hidden="true">{b.archivedAt ? '↺' : '🗄'}</span></button>}
              {canManage && <button className="small ghost danger" aria-label={`${b.name} löschen`} title="Endgültig löschen (Projektadmin)" onClick={async () => {
                if (await askConfirm({
                  title: `Baustein „${b.name}“ löschen`, confirmLabel: 'Löschen', danger: true,
                  message: b.usage ? `Der Baustein ist in ${b.usage} Testfällen eingefügt. Die Schritte dort bleiben erhalten, verlieren aber den Bezug zur Bibliothek. Endgültig löschen?` : 'Endgültig löschen?',
                })) await act(() => api('DELETE', `/api/step-blocks/${b.id}`), `„${b.name}“ gelöscht`);
              }}>✕</button>}
            </td>
          </tr>
        ))}</tbody>
      </table>{!list.data && !list.error && <div className="empty small">Lädt …</div>}{list.data?.length === 0 && <div className="empty">{q ? 'Kein Baustein gefunden.' : 'Noch keine Bausteine.'}</div>}</div>
      {editing && <StepBlockEditor projectKey={projectKey} existing={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
      {detail && <StepBlockDetail id={detail} projectKey={projectKey} onClose={() => setDetail(null)} />}
    </Modal>
  );
}
