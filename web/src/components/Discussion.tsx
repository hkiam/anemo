import { useEffect, useState } from 'react';
import { api, fmtDate, useApi } from '../api.ts';
import { currentUser, useCan } from '../session.tsx';
import { askConfirm, toast, useUnsavedGuard } from '../ux.tsx';
import { usePeople } from './People.tsx';
import { ErrorNote } from './common.tsx';

interface Comment {
  id: string; ownerType: string; ownerId: string; versionNo: number | null; parentId: string | null; author: string; body: string;
  createdAt: string; editedAt: string | null; resolvedAt: string | null; resolvedBy: string | null;
}

/** @erwähnungen hervorheben, Zeilenumbrüche erhalten */
function Body({ text }: { text: string }) {
  return <div className="comment-body">{text.split(/(@[\p{L}\p{N}._-]{2,60})/u).map((part, i) => (part.startsWith('@') ? <span key={i} className="mention">{part}</span> : <span key={i}>{part}</span>))}</div>;
}

/**
 * Diskussion an Testfall bzw. Vorbedingung: Anmerkungen (optional zu einer Version), Antworten, erledigt/wieder offen.
 * Erwähnte Personen (@name) werden benachrichtigt, wenn sie das in ihren Benachrichtigungen aktiviert haben.
 */
export function Discussion({ projectKey, ownerType, ownerId, versionNo, onCount }: {
  projectKey: string; ownerType: 'TEST_CASE' | 'PRECONDITION'; ownerId: string; versionNo?: number; onCount?: (open: number) => void;
}) {
  const list = useApi<Comment[]>(`/api/comments?ownerType=${ownerType}&ownerId=${ownerId}`);
  const canEdit = useCan(projectKey, 'edit');
  const me = currentUser();
  const people = usePeople(projectKey);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string; original: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const all = list.data ?? [];
  const top = all.filter((c) => !c.parentId);
  const open = top.filter((c) => !c.resolvedAt);
  const shown = showDone ? top : open;
  const done = top.length - open.length;
  // Schutz ungespeicherter Eingaben (Anmerkung, Antwort, Bearbeitung)
  const dirty = !!text.trim() || !!reply.trim() || (!!editing && editing.body !== editing.original);
  useUnsavedGuard(dirty, `discussion-${ownerId}`);
  useEffect(() => { if (onCount && list.data) onCount(open.length); }, [list.data, open.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const post = async (body: string, parentId: string | null) => {
    try {
      const r = await api<{ unreachableMentions?: string[] }>('POST', '/api/comments', { ownerType, ownerId, body, parentId, versionNo: parentId ? null : versionNo ?? null });
      for (const name of r?.unreachableMentions ?? []) toast(`@${name} hat keinen Zugriff und wird nicht benachrichtigt`, 'info');
      list.reload();
      return true;
    } catch (e) { setError(e); toast(`Nicht gespeichert: ${(e as Error).message}`, 'bad'); return false; }
  };
  const patch = async (id: string, body: Record<string, unknown>) => {
    try { await api('PATCH', `/api/comments/${id}`, body); list.reload(); return true; } catch (e) { setError(e); toast(`Nicht gespeichert: ${(e as Error).message}`, 'bad'); return false; }
  };
  const remove = async (c: Comment, isReply: boolean) => {
    if (!(await askConfirm({ title: isReply ? 'Antwort löschen' : 'Anmerkung löschen', message: isReply ? 'Diese Antwort löschen?' : 'Anmerkung samt Antworten löschen?', confirmLabel: 'Löschen', danger: true }))) return;
    try { await api('DELETE', `/api/comments/${c.id}`); list.reload(); toast(isReply ? 'Antwort gelöscht' : 'Anmerkung gelöscht'); } catch (e) { setError(e); toast(`Löschen fehlgeschlagen: ${(e as Error).message}`, 'bad'); }
  };
  const cancelEdit = async () => {
    if (editing && editing.body !== editing.original && !(await askConfirm({ title: 'Änderung verwerfen?', message: 'Die Änderung an der Anmerkung geht verloren.', confirmLabel: 'Verwerfen', danger: true }))) return;
    setEditing(null);
  };
  const cancelReply = async () => {
    if (reply.trim() && !(await askConfirm({ title: 'Antwort verwerfen?', message: 'Die begonnene Antwort geht verloren.', confirmLabel: 'Verwerfen', danger: true }))) return;
    setReply(''); setReplyTo(null);
  };
  /** Kopfzeile und Text einer Anmerkung bzw. Antwort mit Bearbeiten/Löschen für eigene Beiträge */
  const head = (c: Comment, isReply: boolean) => (
    <div className="row small"><b>{c.author}</b><span className="muted">{fmtDate(c.createdAt)}{c.editedAt ? ' · bearbeitet' : ''}</span>
      {!isReply && c.versionNo && <span className="badge neutral" title="Anmerkung bezieht sich auf diese Version">zu v{c.versionNo}</span>}
      {!isReply && c.resolvedAt && <span className="badge ok">erledigt von {c.resolvedBy}</span>}
      <span className="spacer" />
      {!isReply && (c.author === me || canEdit) && <button className="small ghost" onClick={() => void patch(c.id, { resolved: !c.resolvedAt })}>{c.resolvedAt ? 'wieder öffnen' : '✓ erledigt'}</button>}
      {c.author === me && <button className="small ghost" onClick={() => setEditing({ id: c.id, body: c.body, original: c.body })} aria-label={isReply ? `Antwort von ${fmtDate(c.createdAt)} bearbeiten` : 'Anmerkung bearbeiten'} title="Bearbeiten">✎</button>}
      {c.author === me && <button className="small ghost danger" aria-label={isReply ? `Antwort von ${fmtDate(c.createdAt)} löschen` : 'Anmerkung löschen'} title="Löschen" onClick={() => void remove(c, isReply)}>✕</button>}
    </div>
  );
  const body = (c: Comment, isReply: boolean) => (editing?.id === c.id
    ? <div className="stack" style={{ gap: 4 }}>
        <textarea rows={3} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} aria-label={isReply ? 'Antwort bearbeiten' : 'Anmerkung bearbeiten'} autoFocus />
        <div className="row"><span className="spacer" /><button className="small" onClick={() => void cancelEdit()}>Abbrechen</button>
          <button className="small primary" disabled={!editing.body.trim()} title={editing.body.trim() ? undefined : 'Eine leere Anmerkung lässt sich nicht speichern – zum Entfernen „Löschen“ verwenden'}
            onClick={async () => { if (await patch(c.id, { body: editing.body.trim() })) { setEditing(null); toast('Änderung gespeichert'); } }}>Speichern</button></div></div>
    : <Body text={c.body} />);
  return (
    <div className="discussion stack">
      <div className="row"><h4 style={{ flex: 1 }}>Diskussion{open.length ? ` (${open.length} offen)` : ''}</h4>
        {done > 0 && <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> {done} erledigte zeigen</label>}</div>
      <ErrorNote error={error ?? list.error} />
      {!list.data && !list.error && <div className="small muted">Lädt …</div>}
      {list.data && shown.length === 0 && <div className="small muted">{top.length ? 'Keine offenen Anmerkungen.' : 'Noch keine Anmerkungen – z. B. Hinweise aus der Testfall-Freigabe oder Rückfragen.'}</div>}
      {shown.map((c) => {
        const replies = all.filter((r) => r.parentId === c.id);
        return (
          <div key={c.id} className={`comment ${c.resolvedAt ? 'resolved' : ''}`}>
            {head(c, false)}
            {body(c, false)}
            {replies.map((r) => <div key={r.id} className="comment reply">{head(r, true)}{body(r, true)}</div>)}
            {replyTo === c.id
              ? <div className="stack reply-box" style={{ gap: 4 }}>
                  <textarea rows={3} autoFocus value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Antwort … @name benachrichtigt eine Person" aria-label={`Antwort an ${c.author}`} />
                  <MentionHints text={reply} people={people} onPick={setReply} />
                  <div className="row"><span className="spacer" /><button className="small" onClick={() => void cancelReply()}>Abbrechen</button>
                    <button className="small primary" disabled={!reply.trim()} title={reply.trim() ? undefined : 'Bitte eine Antwort schreiben'} onClick={async () => { if (await post(reply.trim(), c.id)) { setReply(''); setReplyTo(null); toast('Antwort gespeichert'); } }}>Antworten</button></div></div>
              : <button className="small link" onClick={() => { if (!reply.trim()) setReplyTo(c.id); else void cancelReply().then(() => setReplyTo(c.id)); }}>Antworten</button>}
          </div>
        );
      })}
      <div className="stack" style={{ gap: 4 }}>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Anmerkung schreiben … @name benachrichtigt eine Person" aria-label="Neue Anmerkung" />
        <MentionHints text={text} people={people} onPick={setText} />
        <div className="row"><span className="small muted">{versionNo ? `bezieht sich auf v${versionNo}` : ''}</span><span className="spacer" />
          <button className="small primary" disabled={!text.trim()} title={text.trim() ? undefined : 'Bitte eine Anmerkung schreiben'} onClick={async () => { if (await post(text.trim(), null)) { setText(''); toast('Anmerkung gespeichert'); } }}>Anmerken</button></div>
      </div>
    </div>
  );
}

/** Personenvorschläge, solange hinter einem „@“ getippt wird – ein Klick ergänzt den Benutzernamen. */
function MentionHints({ text, people, onPick }: { text: string; people: string[]; onPick: (v: string) => void }) {
  const m = /(^|\s)@([\p{L}\p{N}._-]*)$/u.exec(text);
  if (!m) return null;
  const typed = m[2]!.toLowerCase();
  const hits = people.filter((p) => p.toLowerCase().startsWith(typed) && p.toLowerCase() !== typed).slice(0, 8);
  if (!hits.length) return null;
  return (
    <div className="row small mention-hints" aria-label="Personen erwähnen">
      <span className="muted">Erwähnen:</span>
      {hits.map((p) => <button key={p} type="button" className="chip-btn small" onClick={() => onPick(`${text.slice(0, text.length - m[2]!.length)}${p} `)}>@{p}</button>)}
    </div>
  );
}
