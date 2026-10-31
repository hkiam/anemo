import { LinkDefectDialog } from './LinkInput.tsx';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { api, useApi } from '../api.ts';
import { currentUser, useCan } from '../session.tsx';
import type { ExecutionStatus } from '../types.ts';
import { ActionMenu, askConfirm, askText, notifyChanged, toast } from '../ux.tsx';
import { ErrorNote, Modal } from './common.tsx';
import { WikiEditor } from '../wiki/WikiEditor.tsx';
import { postResult } from './resultSave.ts';
import { fillStyle, readableOn } from '../color.ts';
import { SuggestDialog, usePeople } from './People.tsx';
import { limitHint, plural } from '../text.ts';
import { FieldInputs, useFieldDefs } from './Fields.tsx';

interface BulkResult { updated: number; removed: number; moved: number; skipped: { id: string; key: string; reason: string }[]; missing: number }

/** Ergebnis der Massenbearbeitung als verständliche Meldung, Übersprungenes mit Grund. */
function report(r: BulkResult, what: string) {
  const done = r.updated + r.removed + r.moved;
  toast(`${plural(done, 'Ausführung', 'Ausführungen')} ${what}${r.skipped.length ? ` – ${r.skipped.length} übersprungen` : ''}`, r.skipped.length ? 'info' : 'ok');
  if (r.skipped.length) {
    const reasons = new Map<string, string[]>();
    for (const s of r.skipped) reasons.set(s.reason, [...(reasons.get(s.reason) ?? []), s.key]);
    for (const [reason, keys] of [...reasons].slice(0, 3)) toast(`${reason}: ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ' …' : ''}`, 'info');
  }
}

/**
 * Massenbearbeitung für gewählte Ausführungen (Zyklus oder projektweite Suche): Ergebnis, Zuweisung, Fehler,
 * Felder; mit Pflegerecht auch Entfernen und Verschieben. „Alle Treffer“ holt die IDs der ganzen Abfrage.
 */
export function ExecutionBulkBar({ projectKey, selected, statuses, total, onSelectAll, onClear, onDone }: {
  projectKey: string; selected: Set<string>; statuses: ExecutionStatus[]; total?: number | undefined;
  onSelectAll?: (() => Promise<void>) | undefined; onClear: () => void; onDone: () => void;
}) {
  const canEdit = useCan(projectKey, 'edit');
  const canExecute = useCan(projectKey, 'execute');
  const [dialog, setDialog] = useState<'status' | 'fields' | 'move' | 'assign' | 'defect' | null>(null);
  const people = usePeople(projectKey);
  // Projektregel „nur Zuständige“: ohne Pflegerecht nur selbst übernehmen bzw. eigene zurückgeben
  const project = useApi<{ executeOnlyAssignee?: boolean }>(`/api/projects/${projectKey}`);
  const onlyOwn = !!project.data?.executeOnlyAssignee && !canEdit;
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const run = async (body: Record<string, unknown>, what: string) => {
    setBusy(true);
    try {
      const r = await api<BulkResult>('POST', '/api/executions/bulk', { ids: [...selected], ...body });
      report(r, what);
      notifyChanged('execution');
      onClear();
      onDone();
      setDialog(null);
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  if (!selected.size) return null;
  return (
    <div className="bulk-bar row small" role="toolbar" aria-label="Massenbearbeitung Ausführungen">
      <strong>{selected.size} ausgewählt</strong>
      {onSelectAll && total !== undefined && total > selected.size && (
        <button className="small link" disabled={selecting} onClick={async () => { setSelecting(true); try { await onSelectAll(); } finally { setSelecting(false); } }}>
          {selecting ? 'wählt aus …' : `alle ${total.toLocaleString('de-DE')} Treffer auswählen`}</button>
      )}
      <button className="small ghost" onClick={onClear}>Auswahl aufheben</button>
      <span className="spacer" />
      {canExecute && <button className="small" disabled={busy} onClick={() => setDialog('status')}>Ergebnis setzen …</button>}
      {canExecute && !onlyOwn && <button className="small" disabled={busy} onClick={() => setDialog('assign')}>Zuweisen …</button>}
      {canExecute && onlyOwn && <>
        <button className="small" disabled={busy} title="Nicht zugewiesene Ausführungen selbst übernehmen – in diesem Projekt weist nur die Testleitung anderen zu"
          onClick={() => void run({ assignee: currentUser() }, `von ${currentUser()} übernommen`)}>Übernehmen</button>
        <button className="small" disabled={busy} title="Eigene Zuweisungen zurückgeben (danach nicht zugewiesen)"
          onClick={() => void run({ assignee: null }, 'zurückgegeben')}>Zurückgeben</button>
      </>}
      {(canExecute || canEdit) && <ActionMenu label="⋯ Mehr" items={[
        { label: '🐞 Fehler verknüpfen …', hidden: !canExecute, onClick: () => setDialog('defect') },
        { label: '☰ Feld setzen …', hidden: !canExecute, onClick: () => setDialog('fields') },
        { label: '↦ In anderen Zyklus verschieben …', hidden: !canEdit, onClick: () => setDialog('move') },
        { label: '🗑 Aus dem Zyklus entfernen', title: 'Nur nicht ausgeführte – Ergebnisse bleiben zur Nachvollziehbarkeit', hidden: !canEdit, onClick: async () => {
          if (await askConfirm({ title: 'Ausführungen entfernen', message: `${selected.size} Einträge aus ihren Zyklen entfernen? Bereits ausgeführte bleiben erhalten und werden übersprungen.`, confirmLabel: 'Entfernen', danger: true })) void run({ remove: true }, 'entfernt');
        } },
      ]} />}
      {dialog === 'status' && <StatusDialog statuses={statuses} count={selected.size} busy={busy} onClose={() => setDialog(null)}
        onApply={(status, comment) => void run({ status, ...(comment ? { comment } : {}) }, `auf „${statuses.find((s) => s.code === status)?.name ?? status}“ gesetzt`)} />}
      {dialog === 'defect' && <LinkDefectDialog title={`Fehler mit ${selected.size} Ausführung${selected.size === 1 ? '' : 'en'} verknüpfen`} onClose={() => setDialog(null)}
        onSubmit={(d) => void run({ addDefects: [{ key: d.key, ...(d.provider ? { provider: d.provider } : {}), ...(d.title ? { title: d.title } : {}) }] }, 'mit Fehler verknüpft')} />}
      {dialog === 'fields' && <FieldsDialog projectKey={projectKey} count={selected.size} onClose={() => setDialog(null)} onApply={(fields) => void run({ fields }, 'mit neuem Feldwert')} />}
      {dialog === 'assign' && <SuggestDialog title={`${plural(selected.size, 'Ausführung', 'Ausführungen')} zuweisen`} label="Zuständige Person (Benutzername)" suggestions={people}
        required={false} hint="Leer lassen, um die Zuweisung zu entfernen." confirmLabel="Zuweisen" unknownHint="unbekannter Benutzername – bitte prüfen, sonst landet die Arbeit bei niemandem"
        onCancel={() => setDialog(null)} onSubmit={(who) => void run({ assignee: who || null }, who ? `an ${who} zugewiesen` : 'ohne Zuweisung')} />}
      {dialog === 'move' && <MoveDialog projectKey={projectKey} count={selected.size} onClose={() => setDialog(null)} onApply={(cycleId) => void run({ moveToCycleId: cycleId }, 'verschoben')} />}
    </div>
  );
}

function StatusDialog({ statuses, count, busy, onClose, onApply }: { statuses: ExecutionStatus[]; count: number; busy: boolean; onClose: () => void; onApply: (status: string, comment: string) => void }) {
  const usable = statuses.filter((s) => s.active && s.appliesTo !== 'step');
  const [status, setStatus] = useState(usable.find((s) => s.category === 'PASSED')?.code ?? usable[0]?.code ?? '');
  const [comment, setComment] = useState('');
  const cat = statuses.find((s) => s.code === status)?.category;
  const needs = cat === 'FAILED' || cat === 'BLOCKED' || cat === 'KNOWN_FAILURE';
  return (
    <Modal title={`Ergebnis für ${plural(count, 'Ausführung', 'Ausführungen')} setzen`} help="exec-search" onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={busy || !status} title={!status ? 'Erst ein Ergebnis wählen' : undefined} onClick={() => onApply(status, comment.trim())}>Übernehmen</button></>}>
      <div className="status-buttons" role="group" aria-label="Ergebnis">
        {usable.map((s) => <button key={s.code} type="button" aria-pressed={status === s.code} className={status === s.code ? 'on' : ''}
          style={status === s.code ? fillStyle(s.color) : undefined} onClick={() => setStatus(s.code)}>{s.name}</button>)}
      </div>
      <div className="field">Befund / Kommentar{needs && <span className="small muted"> – bei Fehlschlag/Blockade bzw. bekanntem Fehler als Nachweis nötig (oder bereits verknüpfter Fehler)</span>}
        <WikiEditor value={comment} onChange={setComment} minRows={8} label="Befund für alle gewählten Ausführungen"
          placeholder="gilt für alle gewählten; leer = bisherigen Kommentar behalten" /></div>
      <p className="small muted">Screenshots und Dateien bitte je Ausführung in der Durchführung anhängen – hier gilt der Text für alle gewählten.</p>
      <p className="small muted">Schritt- und Durchlaufergebnisse bleiben unverändert; die Änderung steht im Ergebnisverlauf jeder Ausführung („Massenbearbeitung“).
        Ausführungen in abgeschlossenen Zyklen werden übersprungen.</p>
    </Modal>
  );
}

function FieldsDialog({ projectKey, count, onClose, onApply }: { projectKey: string; count: number; onClose: () => void; onApply: (v: Record<string, unknown>) => void }) {
  const defs = useFieldDefs('execution', projectKey);
  const [key, setKey] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const k = key || defs[0]?.key || '';
  const def = defs.find((d) => d.key === k);
  return (
    <Modal title={`Feld für ${plural(count, 'Ausführung', 'Ausführungen')} setzen`} help="exec-search" onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!def} title={def ? undefined : 'Keine eigenen Felder für Ausführungen definiert'} onClick={() => onApply({ [k]: values[k] ?? null })}>Übernehmen</button></>}>
      {!defs.length ? <p className="muted">Für Ausführungen sind keine eigenen Felder definiert (Administration → Felder &amp; Prioritäten).</p> : <>
        <label className="field">Feld<select value={k} onChange={(e) => { setKey(e.target.value); setValues({}); }}>{defs.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}</select></label>
        {def && <FieldInputs defs={[{ ...def, required: false }]} values={values} onChange={setValues} />}
      </>}
    </Modal>
  );
}

function MoveDialog({ projectKey, count, onClose, onApply }: { projectKey: string; count: number; onClose: () => void; onApply: (cycleId: string) => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  // Suchtext geht an den Server (q) – so greift die Obergrenze erst nach dem Filtern
  const LIMIT = 200;
  const cycles = useApi<{ total: number; items: { id: string; name: string; planName: string | null; state?: string }[] }>(`/api/projects/${projectKey}/cycles?limit=${LIMIT}${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`);
  const [target, setTarget] = useState('');
  const open = (cycles.data?.items ?? []).filter((c) => c.state !== 'closed');
  const closed = (cycles.data?.items.length ?? 0) - open.length;
  const more = limitHint(cycles.data?.items.length ?? 0, cycles.data?.total, 'Suche verfeinern');
  const confirm = async () => {
    const name = open.find((c) => c.id === target)?.name ?? '';
    if (await askConfirm({ title: `${plural(count, 'Ausführung', 'Ausführungen')} verschieben`, message: `Nach „${name}“ verschieben? Ergebnisse wandern mit; Testfälle, die im Ziel schon enthalten sind, werden übersprungen.`, confirmLabel: 'Verschieben' })) onApply(target);
  };
  return (
    <Modal title={`${plural(count, 'Ausführung', 'Ausführungen')} verschieben`} help="exec-search" onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!target} title={target ? undefined : 'Erst einen Zielzyklus wählen'} onClick={() => void confirm()}>Verschieben</button></>}>
      <ErrorNote error={cycles.error} />
      <input type="search" placeholder="Zyklus suchen …" aria-label="Zielzyklus suchen" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <fieldset className="plain-fieldset"><legend className="sr-only">Zielzyklus</legend>
      <div className="table-wrap" style={{ maxHeight: 320 }}><table><tbody>
        {open.map((c) => (
          <tr key={c.id} className={`clickable ${target === c.id ? 'selected' : ''}`} onClick={() => setTarget(c.id)}>
            <td style={{ width: 28 }}><input type="radio" name="move-target" value={c.id} checked={target === c.id} onChange={() => setTarget(c.id)} style={{ width: 'auto' }} aria-label={`${c.name}${c.planName ? ` (${c.planName})` : ''}`} /></td>
            <td>{c.name}<div className="small muted">{c.planName ?? 'ohne Testplan'}</div></td>
          </tr>
        ))}
      </tbody></table>
        {!cycles.data && !cycles.error && <div className="empty small">Lädt …</div>}
        {cycles.data && open.length === 0 && <div className="empty">{closed ? `Nur abgeschlossene Zyklen gefunden (${closed}) – dorthin lässt sich nichts verschieben.` : 'Keine Zyklen gefunden.'}</div>}
      </div></fieldset>
      {more && <div className="small muted" role="status">{more}{closed ? ` (davon ${closed} abgeschlossen ausgeblendet)` : ''}</div>}
      <p className="small muted">Ergebnisse wandern mit. Testfälle, die im Ziel schon enthalten sind, werden übersprungen. Abgeschlossene Zyklen sind ausgeblendet.</p>
    </Modal>
  );
}

/**
 * Schnellausführung in Listen: ✓ speichert sofort „bestanden“, ✗/⊘ fragen nach dem Befund (Nachweis).
 * Schritt- und Durchlaufergebnisse bleiben unverändert.
 */
export function QuickStatus({ execution, statuses, disabled, onSaved }: {
  execution: { id: string; status: string; updatedAt?: string; testCaseKey?: string; comment?: string | null };
  statuses: ExecutionStatus[]; disabled?: boolean; onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Rückgängig nach ✓: vorheriger Stand für 10 Sekunden
  const [undo, setUndo] = useState<{ status: string; comment: string | null } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);
  const pick = (cat: string) => statuses.find((s) => s.category === cat && s.active && s.appliesTo !== 'step' && ['PASS', 'FAIL', 'BLOCKED'].includes(s.code))
    ?? statuses.find((s) => s.category === cat && s.active && s.appliesTo !== 'step');
  const name = (code: string) => statuses.find((s) => s.code === code)?.name ?? code;
  const post = async (status: string, comment: string | null, expected?: string) => {
    const ok = await postResult(execution.id, { status, comment, ...(expected ? { expectedUpdatedAt: expected } : {}) }, execution.testCaseKey ?? 'Ausführung');
    if (!ok) return false;
    notifyChanged('execution', execution.id);
    onSaved();
    return true;
  };
  const save = async (cat: 'PASSED' | 'FAILED' | 'BLOCKED') => {
    const st = pick(cat);
    if (!st || st.code === execution.status) return;
    const prevCat = statuses.find((s) => s.code === execution.status)?.category;
    let comment = execution.comment ?? null;
    if (cat !== 'PASSED') {
      const t = await askText({ title: `${execution.testCaseKey ?? 'Ausführung'}: ${st.name}`, label: cat === 'FAILED' ? 'Tatsächliches Ergebnis / Befund' : 'Grund der Blockade',
        initial: execution.comment ?? '', confirmLabel: 'Speichern', multiline: true,
        hint: 'Für ausführliche Befunde mit Screenshots die Durchführung öffnen.' });
      if (t === null) return;
      comment = t.trim() || null;
    } else if (prevCat === 'FAILED' || prevCat === 'BLOCKED') {
      // ein Fehlklick würde ein dokumentiertes Problem überschreiben
      if (!(await askConfirm({ title: `${execution.testCaseKey ?? 'Ausführung'} auf „${st.name}“ setzen?`,
        message: `Das bisherige Ergebnis ist „${name(execution.status)}“. Es bleibt im Ergebnisverlauf erhalten, gilt danach aber nicht mehr.`, confirmLabel: `Auf „${st.name}“ setzen` }))) return;
    }
    setBusy(true);
    try {
      const before = { status: execution.status, comment: execution.comment ?? null };
      if (!(await post(st.code, comment, execution.updatedAt))) return;
      toast(`${execution.testCaseKey ?? 'Ausführung'}: ${st.name}${cat === 'PASSED' ? ' – Rückgängig direkt am Eintrag möglich' : ''}`);
      if (cat === 'PASSED') {
        setUndo(before);
        if (undoTimer.current) clearTimeout(undoTimer.current);
        undoTimer.current = setTimeout(() => setUndo(null), 10_000);
      }
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const revert = async () => {
    if (!undo) return;
    setBusy(true);
    try {
      if (!(await post(undo.status, undo.comment))) return;
      toast(`${execution.testCaseKey ?? 'Ausführung'}: zurück auf „${name(undo.status)}“`);
      setUndo(null);
    } catch (e) {
      toast((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  if (disabled) return null;
  const cur = statuses.find((s) => s.code === execution.status)?.category;
  // gewählter Status: Füllung in Statusfarbe mit lesbarer Schrift; sonst Statusfarbe nur beim Überfahren
  const color = (cat: string) => {
    const c = pick(cat)?.color;
    return (cur === cat ? { ...fillStyle(c), '--qs-color': c, '--qs-text': readableOn(c) } : { '--qs-color': c, '--qs-text': readableOn(c) }) as CSSProperties;
  };
  return (
    <span className="quick-status" onClick={(e) => e.stopPropagation()}>
      <button className={`qs pass ${cur === 'PASSED' ? 'on' : ''}`} style={color('PASSED')} disabled={busy} aria-pressed={cur === 'PASSED'} onClick={() => save('PASSED')} title="Bestanden (sofort speichern)" aria-label={`${execution.testCaseKey ?? ''} bestanden`}>✓</button>
      <button className={`qs fail ${cur === 'FAILED' ? 'on' : ''}`} style={color('FAILED')} disabled={busy} aria-pressed={cur === 'FAILED'} onClick={() => save('FAILED')} title="Fehlgeschlagen (mit Befund)" aria-label={`${execution.testCaseKey ?? ''} fehlgeschlagen`}>✗</button>
      <button className={`qs blocked ${cur === 'BLOCKED' ? 'on' : ''}`} style={color('BLOCKED')} disabled={busy} aria-pressed={cur === 'BLOCKED'} onClick={() => save('BLOCKED')} title="Blockiert (mit Grund)" aria-label={`${execution.testCaseKey ?? ''} blockiert`}>⊘</button>
      {undo && <button className="qs undo" disabled={busy} onClick={() => void revert()} title={`Zurück auf „${name(undo.status)}“`} aria-label={`${execution.testCaseKey ?? ''}: Ergebnis rückgängig machen`}>↶ Rückgängig</button>}
    </span>
  );
}
