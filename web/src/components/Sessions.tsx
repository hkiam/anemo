import { type DefectEntry, LinkDefectDialog } from './LinkInput.tsx';
import { useEffect, useRef, useState } from 'react';
import { api, uploadAttachment, useApi } from '../api.ts';
import { href } from '../router.ts';
import { askText, FocusLink, fmtDuration, notifyChanged, toast, useSync, useUnsavedGuard } from '../ux.tsx';
import { WikiEditor } from '../wiki/WikiEditor.tsx';
import { ErrorNote, Modal, Wiki, WikiAttachments } from './common.tsx';
import { useCan } from '../session.tsx';
import type { Severity } from '../types.ts';
import { SeveritySelect } from './Severity.tsx';

export interface Finding { id?: string; kind: 'bug' | 'question' | 'idea' | 'note'; text: string; at?: string; by?: string; defectKey?: string | null; testCaseKey?: string | null }
export interface Session {
  id: string; cycleId: string; charter: string; areas: string | null; timeboxMinutes: number; tester: string | null;
  status: 'planned' | 'running' | 'paused' | 'done' | 'debriefed'; startedAt: string | null; endedAt: string | null; elapsedSeconds: number;
  notes: string | null; summary: string | null; findings: Finding[]; cycleName?: string; planName?: string | null;
  debriefNote?: string | null; debriefedBy?: string | null; tbs?: { test: number; bug: number; setup: number } | null;
}

export const FINDING_KIND: Record<Finding['kind'], { label: string; icon: string }> = {
  bug: { label: 'Fehler', icon: '🐞' }, question: { label: 'Frage', icon: '❓' }, idea: { label: 'Idee', icon: '💡' }, note: { label: 'Notiz', icon: '📝' },
};
const STATUS: Record<Session['status'], [string, string]> = { planned: ['geplant', 'neutral'], running: ['läuft', 'ok'], paused: ['pausiert', 'warn'], done: ['abgeschlossen', 'accent'], debriefed: ['nachbesprochen', 'accent'] };

/** Explorative Sitzungen eines Zyklus: Liste und „+ Sitzung“; die Arbeit selbst findet im Fokusfenster statt. */
export function SessionsPanel({ projectKey, cycleId, canExecute }: { projectKey: string; cycleId: string; canExecute: boolean }) {
  const list = useApi<Session[]>(`/api/cycles/${cycleId}/sessions`);
  const [creating, setCreating] = useState(false);
  useSync(['execution'], () => list.reload());
  const items = list.data ?? [];
  if (!items.length && !canExecute) return null;
  return (
    <section className="sessions" aria-label="Explorative Sitzungen">
      <div className="row small">
        <strong>Explorative Sitzungen</strong> <span className="muted">({items.length})</span><span className="spacer" />
        {canExecute && <button className="small" onClick={() => setCreating(true)} title="Freies, zielgerichtetes Testen mit Zeitrahmen und Protokoll">+ Explorative Sitzung</button>}
      </div>
      {items.length > 0 && <div className="stack" style={{ marginTop: 4, gap: 0 }}>
        {items.map((s) => (
          <div key={s.id} className="session-item">
            <span className={`badge ${STATUS[s.status][1]}`}>{STATUS[s.status][0]}</span>
            <span className="session-charter" title={s.charter}>{s.charter}</span>
            <span className="small muted">{s.tester ?? '–'} · ⏱ {fmtDuration(s.elapsedSeconds) === '–' ? '0 s' : fmtDuration(s.elapsedSeconds)} / {s.timeboxMinutes} min
              {s.findings.length > 0 && <> · {s.findings.filter((f) => f.kind === 'bug').length} 🐞 · {s.findings.length} Beobachtungen</>}</span>
            <FocusLink to={`/f/${projectKey}/session/${s.id}`} name="anemo-sitzung" className="btn small">{s.status === 'done' || s.status === 'debriefed' ? 'Ansehen' : '⧉ Öffnen'}</FocusLink>
          </div>
        ))}
      </div>}
      {creating && <NewSession cycleId={cycleId} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); list.reload(); }} />}
    </section>
  );
}

function NewSession({ cycleId, onClose, onCreated }: { cycleId: string; onClose: () => void; onCreated: (s: Session) => void }) {
  const [f, setF] = useState({ charter: '', areas: '', timeboxMinutes: '60', tester: '' });
  const minutes = Math.min(480, Math.max(5, Number(f.timeboxMinutes) || 60));
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    try {
      const s = await api<Session>('POST', `/api/cycles/${cycleId}/sessions`, { charter: f.charter, areas: f.areas || null, timeboxMinutes: minutes, tester: f.tester || null });
      toast('Sitzung geplant');
      notifyChanged('execution');
      onCreated(s);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal title="Explorative Sitzung planen" help="sessions" onClose={onClose} footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={f.charter.trim().length < 3} onClick={save}>Planen</button></>}>
      <ErrorNote error={error} />
      <label className="field">Auftrag (Charter): Ziel der Sitzung
        <textarea autoFocus rows={3} value={f.charter} onChange={(e) => setF({ ...f, charter: e.target.value })}
          placeholder="Erkunde <Bereich> mit <Mitteln>, um <Risiken/Informationen> zu finden – z. B. „Erkunde den Druck großer Akten, um Abbrüche und Performance-Probleme zu finden“" />
      </label>
      <div className="grid2">
        <label className="field">Bereiche / Schwerpunkte<input value={f.areas} onChange={(e) => setF({ ...f, areas: e.target.value })} placeholder="z. B. Druck, Export, Rechte" /></label>
        <label className="field">Zeitrahmen (Timebox, Minuten)<input type="number" min={5} max={480} value={f.timeboxMinutes} onChange={(e) => setF({ ...f, timeboxMinutes: e.target.value })} /></label>
        <label className="field">Tester (leer = ich)<input value={f.tester} onChange={(e) => setF({ ...f, tester: e.target.value })} /></label>
      </div>
    </Modal>
  );
}

/** Sitzung durchführen (Fokusfenster): Zeitnahme, Protokoll mit Screenshots, Beobachtungen, Zusammenfassung, Nachbesprechung. */
export function SessionWorkspace({ projectKey, sessionId }: { projectKey: string; sessionId: string }) {
  const s = useApi<Session>(`/api/sessions/${sessionId}`);
  const atts = useApi<{ id: string; fileName: string }[]>(`/api/attachments?ownerType=EXPLORATORY_SESSION&ownerId=${sessionId}`);
  const canEdit = useCan(projectKey, 'edit');
  const [notes, setNotes] = useState('');
  const [summary, setSummary] = useState('');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [kind, setKind] = useState<Finding['kind']>('bug');
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filing, setFiling] = useState<Finding | null>(null);
  useUnsavedGuard(dirty, `session-${sessionId}`);
  // Bearbeitungsstand: Eingaben während eines laufenden Speicherns dürfen nicht überschrieben werden
  const rev = useRef(0);
  const initialized = useRef(false);
  const loadedAt = useRef(Date.now());
  useEffect(() => {
    if (!s.data) return;
    if (!initialized.current || rev.current === 0) {
      setNotes(s.data.notes ?? '');
      setSummary(s.data.summary ?? '');
      initialized.current = true;
    }
    setFindings(s.data.findings);
    loadedAt.current = Date.now();
  }, [s.data]);
  const edit = (fn: () => void) => { fn(); rev.current++; setDirty(true); };
  const save = async () => {
    const at = rev.current;
    try {
      await api('PUT', `/api/sessions/${sessionId}`, { notes, summary });
      if (rev.current === at) { rev.current = 0; setDirty(false); }
      setSavedAt(new Date());
      notifyChanged('execution');
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  };
  // Ungespeichertes alle 30 s sichern – Notizen gehen nie verloren, auch wenn währenddessen weitergetippt wird
  const saveRef = useRef(save);
  saveRef.current = save;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => { const t = setInterval(() => { if (dirtyRef.current) void saveRef.current(); }, 30_000); return () => clearInterval(t); }, []);
  const timer = async (action: 'start' | 'pause' | 'stop') => {
    if (dirty && !(await save())) return;
    try {
      await api('POST', `/api/sessions/${sessionId}/timer`, { action, ...(action === 'stop' ? { summary } : {}) });
      if (action === 'stop') toast('Sitzung abgeschlossen');
      notifyChanged('execution');
      s.reload();
    } catch (e) {
      setError(e);
    }
  };
  const apply = async (call: Promise<Session>) => {
    try {
      const r = await call;
      setFindings(r.findings);
      notifyChanged('execution');
    } catch (e) {
      setError(e);
    }
  };
  const add = () => {
    if (!text.trim()) return;
    void apply(api<Session>('POST', `/api/sessions/${sessionId}/findings`, { kind, text: text.trim() }));
    setText('');
  };
  const patch = (f: Finding, body: Partial<Finding>) => apply(api<Session>('PATCH', `/api/sessions/${sessionId}/findings/${f.id}`, body));
  const toTestCase = async (f: Finding) => {
    const title = await askText({ title: 'Als Testfall übernehmen', label: 'Titel des Testfalls', initial: f.text.split('\n')[0]!.slice(0, 120), confirmLabel: 'Testfall anlegen' });
    if (!title) return;
    try {
      const tc = await api<{ key: string }>('POST', `/api/projects/${projectKey}/test-cases`, {
        content: { title, objective: `Aus explorativer Sitzung „${s.data!.charter}“:\n${f.text}`, steps: [{ action: '', data: '', expected: '' }] },
      });
      await patch(f, { testCaseKey: tc.key });
      notifyChanged('testcase', tc.key);
      toast(`Testfall ${tc.key} angelegt – Schritte im Testfall ergänzen`);
    } catch (e) {
      setError(e);
    }
  };
  const [linkingFinding, setLinkingFinding] = useState<Finding | null>(null);
  const linkDefect = (f: Finding) => setLinkingFinding(f);
  const doLink = async (f: Finding, d: DefectEntry) => {
    try {
      await api('POST', '/api/references', { ownerType: 'EXPLORATORY_SESSION', ownerId: sessionId, externalKey: d.key, relation: 'DEFECT',
        ...(d.provider ? { provider: d.provider } : {}), ...(d.title ? { title: d.title } : {}) });
      await patch(f, { defectKey: d.title ?? d.key });
      setLinkingFinding(null);
    } catch (e) {
      setError(e);
    }
  };
  if (!s.data) return <div className="empty">{s.error ? <ErrorNote error={s.error} /> : 'Lädt …'}</div>;
  const d = s.data;
  const done = d.status === 'done' || d.status === 'debriefed';
  const planned = d.status === 'planned';
  const locked = done || planned;
  return (
    <WikiAttachments attachments={atts.data}>
      {linkingFinding && <LinkDefectDialog hint="Fehler im Ticketsystem anlegen (Text: Kopieren-Knopf am Fund) und hier verknüpfen – oder einen Link mit Kurznamen hinterlegen."
        onClose={() => setLinkingFinding(null)} onSubmit={(d) => void doLink(linkingFinding, d)} />}
      <div className="stack session-work">
        <div className="card"><div className="card-body stack">
          <div className="row"><span className={`badge ${STATUS[d.status][1]}`}>{STATUS[d.status][0]}</span><strong className="session-title">{d.charter}</strong></div>
          {d.areas && <div className="small muted">Bereiche: {d.areas}</div>}
          <SessionClock session={d} loadedAt={loadedAt.current} onAction={timer} canFinish={!!summary.trim()} />
          {planned && <div className="notice info small">Zum Protokollieren die Sitzung starten – die Zeit läuft ab „▶ Start“ gegen den Zeitrahmen.</div>}
        </div></div>
        <ErrorNote error={error} />

        <div className="session-grid">
          <section className="card"><div className="card-body stack">
            <h3>Protokoll</h3>
            {locked ? <div className="wiki-readonly">{notes ? <Wiki text={notes} /> : <span className="muted">{planned ? 'Noch kein Protokoll.' : 'Kein Protokoll.'}</span>}</div> : (
              <WikiEditor value={notes} onChange={(v) => edit(() => setNotes(v))} minRows={16} label="Protokoll der Sitzung"
                upload={async (file) => { const a = await uploadAttachment('EXPLORATORY_SESSION', sessionId, file); atts.reload(); return a; }}
                placeholder="Was wurde wie getestet, Beobachtungen, Screenshots per Strg+V …" />
            )}
            {!locked && <div className="row small"><span className="spacer" /><span className="muted" aria-live="polite">{dirty ? 'ungespeichert – wird automatisch gesichert' : savedAt ? `gesichert ${savedAt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : 'gesichert'}</span>
              <button className="small" disabled={!dirty} onClick={() => save()}>Jetzt sichern</button></div>}
          </div></section>

          <section className="card"><div className="card-body stack">
            <h3>Beobachtungen ({findings.length})</h3>
            {!locked && <div className="finding-add">
              <div className="row" role="radiogroup" aria-label="Art der Beobachtung">
                {(Object.keys(FINDING_KIND) as Finding['kind'][]).map((k) => (
                  <button key={k} role="radio" aria-checked={kind === k} className={`small chip-btn ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{FINDING_KIND[k].icon} {FINDING_KIND[k].label}</button>
                ))}
              </div>
              <div className="row"><input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                placeholder="Beobachtung beschreiben, Enter = übernehmen" aria-label="Beobachtung" style={{ flex: 1, width: 'auto' }} />
                <button className="primary small" disabled={!text.trim()} onClick={add} aria-label="Beobachtung übernehmen">+</button></div>
            </div>}
            {findings.length === 0 && <div className="small muted">Noch keine Beobachtungen.</div>}
            <ul className="findings">{findings.map((f) => (
              <li key={f.id}>
                <span title={FINDING_KIND[f.kind].label}>{FINDING_KIND[f.kind].icon}</span>
                <span className="finding-text">{f.text}</span>
                <span className="row small finding-actions">
                  {!f.defectKey && f.kind === 'bug' && <button className="small" onClick={() => setFiling(f)} disabled={filing?.id === f.id} title="Fehler im Ticketsystem (OpenProject bzw. Jira) anlegen und verknüpfen">🐞 Als Fehler anlegen</button>}
                  {f.defectKey ? <span className="badge bad">{f.defectKey}</span> : f.kind === 'bug' && !done && <>
                    <button className="small" onClick={async () => { await navigator.clipboard?.writeText(`${f.text}\n\nGefunden in explorativer Sitzung „${d.charter}“ (${d.cycleName ?? ''})`).catch(() => {}); toast('Text für die Fehlermeldung kopiert', 'info'); }}>Text kopieren</button>
                    <button className="small" onClick={() => linkDefect(f)}>→ Fehler verknüpfen</button></>}
                  {f.testCaseKey ? <a className="badge accent" href={href(['p', projectKey, 'repo'], { tc: f.testCaseKey })} target="_blank" rel="noreferrer">{f.testCaseKey}</a>
                    : !done && <button className="small" onClick={() => toTestCase(f)}>→ Testfall</button>}
                  {!done && !f.defectKey && !f.testCaseKey && <button className="ghost small danger" aria-label="Beobachtung entfernen"
                    onClick={() => apply(api<Session>('DELETE', `/api/sessions/${sessionId}/findings/${f.id}`))}>✕</button>}
                </span>
              </li>
            ))}</ul>
          </div></section>
        </div>

        <section className="card"><div className="card-body stack">
          <h3>Zusammenfassung</h3>
          <textarea id="session-summary" rows={4} value={summary} disabled={done} onChange={(e) => edit(() => setSummary(e.target.value))}
            placeholder="Was wurde abgedeckt, was nicht? Wichtigste Risiken, Empfehlung für weitere Tests (Pflicht zum Abschließen)" />
        </div></section>

        {filing && <FindingDefectDialog sessionId={sessionId} finding={filing} onClose={() => setFiling(null)}
          onCreated={(key) => { setFiling(null); toast(`Fehler ${key} angelegt und verknüpft`); notifyChanged('execution'); s.reload(); }} />}
        {done && <Debrief session={d} canEdit={canEdit} onDone={() => s.reload()} />}
      </div>
    </WikiAttachments>
  );
}

/** Fehler-Beobachtung als Fehler anlegen: Titel (vorbelegt aus dem Text) und Schweregrad; Grund bei 409 (z. B. keine Anbindung) wird angezeigt. */
function FindingDefectDialog({ sessionId, finding, onClose, onCreated }: { sessionId: string; finding: Finding; onClose: () => void; onCreated: (key: string) => void }) {
  const [title, setTitle] = useState(finding.text.split('\n')[0]!.slice(0, 200));
  const [severity, setSeverity] = useState<Severity | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const create = async () => {
    if (busy) return; // kein Doppelanlegen
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ externalKey: string }>('POST', `/api/sessions/${sessionId}/findings/${finding.id}/defect`, { title: title.trim(), ...(severity ? { severity } : {}) });
      onCreated(r.externalKey);
    } catch (e) {
      setError(e);
      if ((e as { status?: number }).status === 409) toast((e as Error).message, 'info');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Beobachtung als Fehler anlegen" help="defects" onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={busy || !title.trim()} title={!title.trim() ? 'Bitte einen Titel eingeben' : busy ? 'Wird angelegt …' : undefined} onClick={create}>{busy ? 'Legt an …' : 'Fehler anlegen'}</button></>}>
      <ErrorNote error={error} />
      <label className="field">Titel<input autoFocus value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} /></label>
      <SeveritySelect value={severity} onChange={setSeverity} />
      <div className="small muted">Die Beschreibung enthält die Beobachtung, Auftrag, Tester, Zyklus und einen Rückverweis auf die Sitzung. Angelegt wird im Ticketsystem des Projekts (OpenProject bzw. Jira).</div>
    </Modal>
  );
}

/** Zeitnahme gegen den Zeitrahmen – eigene Komponente, damit nur die Uhr jede Sekunde neu zeichnet. */
function SessionClock({ session: d, loadedAt, onAction, canFinish }: { session: Session; loadedAt: number; onAction: (a: 'start' | 'pause' | 'stop') => void; canFinish: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (d.status !== 'running') return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [d.status]);
  const elapsed = d.elapsedSeconds + (d.status === 'running' ? Math.round((Date.now() - loadedAt) / 1000) : 0);
  const pct = Math.min(100, Math.round((elapsed / (d.timeboxMinutes * 60)) * 100));
  const over = elapsed > d.timeboxMinutes * 60;
  const done = d.status === 'done' || d.status === 'debriefed';
  return (
    <div className="row timer-row">
      <span className={`timer ${over ? 'over' : ''}`} aria-live="off">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
      <span className="small muted">von {d.timeboxMinutes} min Zeitrahmen{over ? ' – überschritten' : ''}</span>
      <div className="progress" style={{ flex: 1, minWidth: 120 }}><span style={{ flex: pct, background: over ? 'var(--danger)' : 'var(--accent)' }} /><span style={{ flex: 100 - pct }} /></div>
      {!done && d.status !== 'running' && <button className="primary" onClick={() => onAction('start')}>{d.status === 'planned' ? '▶ Start' : '▶ Weiter'}</button>}
      {d.status === 'running' && <button onClick={() => onAction('pause')}>⏸ Pause</button>}
      {!done && d.status !== 'planned' && <button onClick={() => {
        if (!canFinish) { toast('Bitte zuerst eine kurze Zusammenfassung schreiben (unten).', 'info'); document.getElementById('session-summary')?.focus(); return; }
        onAction('stop');
      }}>■ Abschließen</button>}
    </div>
  );
}

/** Nachbesprechung (SBTM-Debriefing) durch die Testleitung mit Zeitanteilen Test/Bug/Setup. */
function Debrief({ session: d, canEdit, onDone }: { session: Session; canEdit: boolean; onDone: () => void }) {
  const [note, setNote] = useState(d.debriefNote ?? '');
  const [tbs, setTbs] = useState({ test: d.tbs?.test ?? 70, bug: d.tbs?.bug ?? 20, setup: d.tbs?.setup ?? 10 });
  const [error, setError] = useState<unknown>(null);
  const sum = tbs.test + tbs.bug + tbs.setup;
  if (d.status === 'debriefed' && !canEdit) return null;
  const save = async () => {
    try {
      await api('POST', `/api/sessions/${d.id}/debrief`, { note, tbs });
      toast('Nachbesprechung gespeichert');
      onDone();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <section className="card"><div className="card-body stack">
      <h3>Nachbesprechung {d.status === 'debriefed' && <span className="badge accent">nachbesprochen{d.debriefedBy ? ` von ${d.debriefedBy}` : ''}</span>}</h3>
      <ErrorNote error={error} />
      {canEdit ? <>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Ergebnis der Nachbesprechung" placeholder="Ergebnis des Gesprächs mit der Testleitung, Folgeaufträge" />
        <div className="row small">Zeitanteile:
          {(['test', 'bug', 'setup'] as const).map((k) => (
            <label key={k} className="row">{{ test: 'Test', bug: 'Fehler', setup: 'Vorbereitung' }[k]}
              <input type="number" min={0} max={100} value={tbs[k]} onChange={(e) => setTbs({ ...tbs, [k]: Number(e.target.value) || 0 })} style={{ width: 70 }} aria-label={`Anteil ${k}`} /> %</label>
          ))}
          <span className={sum === 100 ? 'muted' : 'err'}>Summe {sum} %</span>
          <span className="spacer" /><button className="primary small" disabled={note.trim().length < 3 || sum !== 100} onClick={save}>Nachbesprochen</button>
        </div>
      </> : <div className="small muted">Die Nachbesprechung führt die Testleitung.</div>}
      {d.status === 'debriefed' && !canEdit && d.debriefNote && <div>{d.debriefNote}</div>}
    </div></section>
  );
}

/** Für den Fokusrahmen: Titel und Rücksprung */
export function useSessionMeta(sessionId: string) {
  return useApi<Session>(`/api/sessions/${sessionId}`);
}
