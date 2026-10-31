import { plainTitle, stepNumbers, stepRanges } from '../../../shared/steps/groups.ts';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, uploadAttachment, useApi } from '../api.ts';
import type { Content, Format, GherkinDoc, Step, TestCaseDetail } from '../types.ts';
import type { WikiAttachment } from '../wiki/Wiki.tsx';
import { uniqueFileName, WikiEditor } from '../wiki/WikiEditor.tsx';
import { ErrorNote, GherkinView, Modal, WikiAttachments } from './common.tsx';
import { ActionMenu, confirmLeave, notifyChanged, openFocus, toast, useUnsavedGuard } from '../ux.tsx';
import { DatasetEditor } from './DatasetEditor.tsx';
import { FieldInputs, PrioritySelect, useFieldDefs, usePriorities } from './Fields.tsx';
import { askConfirm, askText } from '../ux.tsx';
import { useCan } from '../session.tsx';
import { PreconditionPicker } from './Preconditions.tsx';
import { CallStepCell, TestCasePickerDialog } from './CallSteps.tsx';
import { StepBlockEditor, StepBlockPicker } from './StepLibrary.tsx';

const emptyContent = (): Content => ({
  title: '', format: 'CLASSIC', gherkin: null, objective: null, preconditions: null, testData: null, priority: null,
  labels: [], components: [], steps: [{ action: '', data: '', expected: '' }], sections: [], customFields: {},
});

const GHERKIN_TEMPLATE = `# language: de
Funktionalität:

  Szenario:
    Angenommen
    Wenn
    Dann
`;

interface Props {
  projectKey: string;
  folderId?: string | null;
  existing?: TestCaseDetail;
  /** Vorbelegung für neue Testfälle (z. B. KI-Entwurf aus einer Anforderung) */
  initial?: Partial<Content>;
  onClose: () => void;
  onSaved: (key: string) => void;
  /** Als ganze Seite (Fokusfenster) statt als Dialog. */
  asPage?: boolean;
  /** Kennzeichnung, wenn der Inhalt aus einem KI-Entwurf stammt (z. B. „testcase-draft · Modell“) */
  aiAssisted?: string | null;
}

const FORMAT_LABEL: Record<Format, string> = { CLASSIC: 'Klassisch (Schritte)', GHERKIN: 'Gherkin (BDD)', PLAIN: 'Freitext' };
const stepHasContent = (s: Step) => !!(s.action?.trim() || s.data?.trim() || s.expected?.trim() || s.call || s.kind === 'group');

/** Klassische Schritte als Wiki-Text (nummerierte Liste) – für den Wechsel zu „Freitext“. */
function stepsToPlain(steps: Step[]): string {
  return steps.filter(stepHasContent).map((s) => {
    if (s.kind === 'group') return `h4. ${s.title || 'Abschnitt'}`;
    const parts = [s.action.trim()];
    if (s.data.trim()) parts.push(`Testdaten: ${s.data.trim()}`);
    if (s.expected.trim()) parts.push(`Erwartet: ${s.expected.trim()}`);
    return `# ${parts.join(' \\\\ ').replace(/\n+/g, '\\\\')}`;
  }).join('\n');
}

interface ReviewFinding { severity: 'hoch' | 'mittel' | 'niedrig'; step: number | null; problem: string; suggestion: string }

/**
 * Anlegen/Bearbeiten. Speichern eines bestehenden Testfalls erzeugt eine neue Version –
 * historische Ausführungen bleiben an ihrer Version.
 */
export function TestCaseEditor({ projectKey, folderId, existing, initial, onClose, onSaved, asPage, aiAssisted }: Props) {
  const [c, setC] = useState<Content>(() => (existing ? structuredClone(existing.version) : { ...emptyContent(), ...initial }));
  const baseline = useRef(JSON.stringify(c));
  const dirty = JSON.stringify(c) !== baseline.current;
  useUnsavedGuard(dirty, `tc-${existing?.id ?? 'new'}`);
  const close = async () => { if (!dirty || (await confirmLeave())) onClose(); };
  const [changeNote, setChangeNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [doc, setDoc] = useState<GherkinDoc | null>(null);
  const [hints, setHints] = useState<string[]>([]);
  const assist = useApi<{ enabled: boolean; llm: { model: string } | null }>('/api/assist/status');
  const [review, setReview] = useState<{ findings: ReviewFinding[]; model: string } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const runReview = async () => {
    setReviewing(true);
    setError(null);
    try {
      setReview(await api('POST', `/api/projects/${projectKey}/assist/review`, {
        title: c.title, objective: c.objective, preconditions: c.preconditions, testData: c.testData, format: c.format, gherkin: c.gherkin, plainText: c.plainText ?? null,
        steps: c.steps.filter((s) => s.kind !== 'group').map((s) => ({ action: s.action, data: s.data, expected: s.expected })), dataset: c.dataset ?? null,
      }));
    } catch (e) {
      setError(e);
    } finally {
      setReviewing(false);
    }
  };
  const set = <K extends keyof Content>(k: K, v: Content[K]) => setC((x) => ({ ...x, [k]: v }));
  const fieldDefs = useFieldDefs('test_case', projectKey);
  // Feldvorlagen (J5): systemweit + Projekt; Standardvorlagen füllen neue Schritte vor
  const tplList = useApi<{ id: string; name: string; content: string; fields: string[]; isDefault: boolean; projectKey: string | null }[]>(`/api/field-templates?project=${projectKey}`);
  const canManageProject = useCan(projectKey, 'manage');
  const tpl = (field: string) => (tplList.data ?? []).filter((t) => t.fields.includes(field)).map((t) => ({ id: t.id, name: t.name, content: t.content, scope: t.projectKey ? 'Projekt' : 'System' }));
  const defaultOf = (field: string) => {
    const list = (tplList.data ?? []).filter((t) => t.isDefault && t.fields.includes(field));
    return (list.find((t) => t.projectKey) ?? list[0])?.content ?? '';
  };
  const newStep = (): Step => ({ action: defaultOf('action'), data: defaultOf('data'), expected: defaultOf('expected') });
  const saveTemplate = (field: string) => (canManageProject ? async (content: string) => {
    const name = await askText({ title: 'Feldinhalt als Vorlage speichern', label: `Name der Vorlage (Projekt ${projectKey})`, confirmLabel: 'Speichern' });
    if (!name?.trim()) return;
    try {
      await api('POST', '/api/field-templates', { name: name.trim(), fields: [field], content, project: projectKey });
      toast(`Vorlage „${name.trim()}“ gespeichert`);
      tplList.reload();
    } catch (e) { toast((e as Error).message, 'bad'); }
  } : undefined);
  const [pickingCall, setPickingCall] = useState(false);
  const [pickingBlock, setPickingBlock] = useState(false);
  const [savingBlock, setSavingBlock] = useState<number[] | null>(null);
  /** markierte Schritte (Indizes) – Einfügeposition und Quelle für „Als Baustein speichern“ */
  const [marked, setMarked] = useState<number[]>([]);
  const priorities = usePriorities();
  // Neue Testfälle starten mit der Standard-Priorität der Werteliste
  useEffect(() => {
    if (!existing && !initial?.priority && c.priority === null && priorities.length) {
      const def = priorities.find((p) => p.isDefault);
      if (def) { setC((x) => ({ ...x, priority: def.code })); baseline.current = JSON.stringify({ ...c, priority: def.code }); }
    }
  }, [priorities]); // eslint-disable-line react-hooks/exhaustive-deps
  const removeAttachment = async (a: WikiAttachment) => {
    if (!(await askConfirm({ title: 'Anhang löschen', message: `„${a.fileName}“ endgültig löschen? Eingebettete Bilder im Text werden dann nicht mehr angezeigt.`, confirmLabel: 'Löschen', danger: true }))) return;
    try {
      await api('DELETE', `/api/attachments/${a.id}`);
      setUploaded((u) => u.filter((x) => x.id !== a.id));
      stored.reload();
    } catch (e) {
      setError(e);
    }
  };
  // Anhänge: bestehender Testfall → sofort hochladen; neuer Testfall → vormerken, nach dem Anlegen hochladen
  const stored = useApi<WikiAttachment[]>(existing ? `/api/attachments?ownerType=TEST_CASE&ownerId=${existing.id}` : null);
  const [pending, setPending] = useState<(WikiAttachment & { file: File })[]>([]);
  const [uploaded, setUploaded] = useState<WikiAttachment[]>([]);
  const attachments = useMemo(() => [...uploaded, ...(stored.data ?? []), ...pending], [uploaded, stored.data, pending]);
  useEffect(() => () => pending.forEach((p) => URL.revokeObjectURL(p.url!)), [pending]);
  const upload = async (file: File): Promise<WikiAttachment> => {
    if (existing) {
      const a = await uploadAttachment('TEST_CASE', existing.id, file);
      setUploaded((u) => [...u, a]);
      return a;
    }
    const a = { id: `pending-${pending.length}-${file.name}`, fileName: file.name, url: URL.createObjectURL(file), file };
    setPending((p) => [...p, a]);
    return a;
  };
  const addFiles = async (files: FileList | null) => {
    for (const f of [...(files ?? [])]) {
      try {
        await upload(new File([f], uniqueFileName(f, attachments.map((a) => a.fileName)), { type: f.type }));
      } catch (e) {
        setError(e);
      }
    }
  };

  // Live-Validierung des Gherkin-Texts (entprellt)
  useEffect(() => {
    if (c.format !== 'GHERKIN' || !c.gherkin) {
      setDoc(null);
      return;
    }
    const t = setTimeout(() => {
      api<GherkinDoc>('POST', '/api/gherkin/validate', { gherkin: c.gherkin }).then(setDoc, () => {});
    }, 300);
    return () => clearTimeout(t);
  }, [c.format, c.gherkin]);

  async function toGherkin() {
    const r = await api<{ gherkin: string; hints: string[] }>('POST', '/api/gherkin/from-classic', {
      title: c.title || 'Titel', objective: c.objective, preconditions: c.preconditions, steps: c.steps,
    });
    setC((x) => ({ ...x, format: 'GHERKIN', gherkin: r.gherkin }));
    setHints(['Vorschlag aus den klassischen Schritten – bitte fachlich prüfen, bevor gespeichert wird.', ...r.hints]);
  }

  async function toClassic() {
    const r = await api<{ preconditions: string | null; steps: Step[]; hints: string[] }>('POST', '/api/gherkin/to-classic', { gherkin: c.gherkin ?? '' });
    setC((x) => ({ ...x, format: 'CLASSIC', preconditions: r.preconditions ?? x.preconditions, steps: r.steps.length ? r.steps : x.steps }));
    setHints(['Vorschlag aus dem Gherkin-Text – bitte prüfen. Der Gherkin-Text bleibt bis zum Speichern erhalten.', ...r.hints]);
  }

  async function switchFormat(f: Format) {
    if (f === c.format) return;
    const filledSteps = c.steps.filter(stepHasContent);
    if (f === 'PLAIN') {
      let plainText = c.plainText ?? null;
      const from = c.format;
      if (!plainText?.trim() && from === 'CLASSIC' && filledSteps.length > 0) {
        const take = await askConfirm({
          title: 'Zu Freitext wechseln',
          message: `Ein Freitext-Test hat keine Schritte. Den Inhalt der ${filledSteps.length} Schritte als Text in die Testanweisung übernehmen?`,
          confirmLabel: 'Übernehmen',
        });
        if (take) plainText = stepsToPlain(c.steps);
      }
      setC((x) => ({ ...x, format: 'PLAIN', plainText }));
      setMarked([]);
      if (from === 'CLASSIC' && filledSteps.length) setHints(['Die Schritte bleiben bis zum Speichern im Editor erhalten (Wechsel zurück zu „Klassisch“ möglich); als Freitext gespeichert entfallen sie.']);
      else if (from === 'GHERKIN' && c.gherkin?.trim()) setHints(['Der Gherkin-Text bleibt bis zum Speichern erhalten; als Freitext gespeichert entfällt er.']);
      else setHints([]);
      return;
    }
    if (c.format === 'PLAIN' && c.plainText?.trim()) {
      if (f === 'CLASSIC' && filledSteps.length === 0) {
        const take = await askConfirm({
          title: 'Zu Klassisch wechseln', message: 'Die Testanweisung als ersten Schritt übernehmen? Sonst bleibt sie bis zum Speichern erhalten und entfällt dann.',
          confirmLabel: 'Als Schritt übernehmen',
        });
        if (take) {
          setC((x) => ({ ...x, format: 'CLASSIC', steps: [{ action: x.plainText ?? '', data: '', expected: '' }] }));
          setHints([]);
          return;
        }
      }
      setHints(['Die Testanweisung (Freitext) bleibt bis zum Speichern erhalten (Wechsel zurück möglich); gespeichert wird nur das gewählte Format.']);
    }
    setC((x) => ({ ...x, format: f, gherkin: f === 'GHERKIN' && !x.gherkin ? GHERKIN_TEMPLATE : x.gherkin }));
  }

  /** Bausteinschritte als Kopie einfügen (nach dem zuletzt markierten Schritt, sonst am Ende). */
  function insertBlock(block: { id: string; steps: { action: string; data: string; expected: string }[] }) {
    const copies: Step[] = block.steps.map((s) => ({ action: s.action, data: s.data, expected: s.expected, blockId: block.id }));
    const at = marked.length ? Math.max(...marked) : null;
    setC((x) => {
      if (at === null || at >= x.steps.length) return { ...x, steps: [...x.steps.filter(stepHasContent), ...copies] };
      return { ...x, steps: [...x.steps.slice(0, at + 1), ...copies, ...x.steps.slice(at + 1)] };
    });
    setMarked([]);
    setPickingBlock(false);
    toast(`${copies.length} Schritte eingefügt (Kopie aus der Bibliothek)`);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const content = c.format === 'PLAIN'
        ? { ...c, steps: [] }
        : { ...c, plainText: null, steps: c.steps.filter(stepHasContent) };
      if (existing) {
        await api('PUT', `/api/test-cases/${existing.id}/content`, { content, changeNote: changeNote || null, expectedVersion: existing.currentVersion, aiAssisted: aiAssisted ?? null });
        baseline.current = JSON.stringify(c);
        toast(`${existing.key} gespeichert (v${existing.currentVersion + 1})`);
        // Stufe J2: laufende Ausführungen behalten ihre Fassung – darauf hinweisen
        void api<{ total: number }>('GET', `/api/test-cases/${existing.id}/older-executions`).then((o) => {
          if (o.total) toast(`Gilt für neue Einplanungen: ${o.total === 1 ? '1 laufende Ausführung bleibt' : `${o.total} laufende Ausführungen bleiben`} bei der bisherigen Fassung. Umstellen in der Durchführung oder im Zyklus unter „Mehr“.`);
        }).catch(() => undefined);
        notifyChanged('testcase', existing.key);
        onSaved(existing.key);
      } else {
        const r = await api<TestCaseDetail>('POST', `/api/projects/${projectKey}/test-cases`, { content, folderId: folderId ?? null, changeNote: changeNote || null, aiAssisted: aiAssisted ?? null });
        for (const p of pending) await uploadAttachment('TEST_CASE', r.id, p.file);
        baseline.current = JSON.stringify(c);
        toast(`${r.key} angelegt`);
        notifyChanged('testcase', r.key);
        onSaved(r.key);
      }
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }

  const moveStep = (i: number, d: -1 | 1) => {
    const steps = [...c.steps];
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    set('steps', steps);
    setMarked([]);
  };
  // Abschnitt (J1) samt seinen Schritten um einen Block nach oben/unten verschieben
  const moveGroup = (i: number, d: -1 | 1) => {
    const blocks = stepRanges(c.steps).map((r) => (r.group === null ? r.steps : [r.group, ...r.steps]));
    const b = blocks.findIndex((x) => x[0] === i);
    const t = b + d;
    if (b < 0 || t < 0 || t >= blocks.length) return;
    [blocks[b], blocks[t]] = [blocks[t]!, blocks[b]!];
    set('steps', blocks.flat().map((k) => c.steps[k]!));
    setMarked([]);
  };
  // neuer Abschnitt vor dem ersten markierten Schritt, sonst am Ende
  const addGroup = () => {
    const at = marked.length ? Math.min(...marked) : c.steps.length;
    const g: Step = { kind: 'group', title: '', action: '', data: '', expected: '' };
    set('steps', [...c.steps.slice(0, at), g, ...c.steps.slice(at)]);
    setMarked([]);
  };
  const toGroup = (i: number) => set('steps', c.steps.map((x, k) => (k === i ? { id: x.id, kind: 'group' as const, title: plainTitle(x.action), note: [x.data, x.expected].filter((t) => t.trim()).join('\n') || null, action: '', data: '', expected: '' } : x)));
  const toStep = (i: number) => set('steps', c.steps.map((x, k) => (k === i ? { id: x.id, action: x.legacy?.action ?? (x.title ? `*${x.title}*` : ''), data: x.legacy?.data ?? x.note ?? '', expected: x.legacy?.expected ?? '' } : x)));
  const setGroup = (i: number, patch: Partial<Step>) => set('steps', c.steps.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const nos = stepNumbers(c.steps);
  const setStep = (i: number, k: keyof Step, v: string) => set('steps', c.steps.map((s, idx) => (idx === i ? { ...s, [k]: v } : s)));
  const fieldErrors = error instanceof ApiError ? error.issues : [];

  const title = existing ? `${existing.key} bearbeiten → wird v${existing.currentVersion + 1}` : 'Neuer Testfall';
  const footer = <>
    {dirty && <span className="small muted">ungespeichert</span>}
    {existing && <input placeholder="Änderungsnotiz (z. B. Schritt 3 an Version 7.4 angepasst)" value={changeNote} onChange={(e) => setChangeNote(e.target.value)} style={{ flex: 1, minWidth: 260 }} />}
    <button onClick={close}>{asPage ? 'Schließen' : 'Abbrechen'}</button>
    <button className="primary" onClick={save} disabled={saving || !c.title.trim()} title="Strg+S">{saving ? 'Speichert …' : 'Speichern'}</button>
  </>;
  // Strg/Cmd+S speichert
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void saveRef.current(); } };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  const popOut = async () => {
    if (dirty && !(await confirmLeave())) return;
    openFocus(existing ? `/f/${projectKey}/testcase/${existing.key}` : `/f/${projectKey}/testcase/new${folderId ? `?folder=${folderId}` : ''}`, 'anemo-testfall');
    onClose();
  };
  const frame = (body: ReactNode) => asPage
    ? <div className="focus-form"><h2>{title}</h2>{body}<div className="focus-actions">{footer}</div></div>
    : <Modal size="large" title={<span className="row">{title}<button className="ghost small" onClick={popOut} title="Im eigenen Fenster bearbeiten – volle Fläche">⧉ Fenster</button></span>} onClose={close} footer={footer}>{body}</Modal>;

  return frame(
      <WikiAttachments attachments={attachments}>
      <ErrorNote error={error && fieldErrors.length === 0 ? error : null} />
      {fieldErrors.length > 0 && <div className="notice bad">{fieldErrors.map((i, k) => <div key={k}>{i.message}</div>)}</div>}
      {hints.length > 0 && <div className="notice warn">{hints.map((h, k) => <div key={k}>{h}</div>)}</div>}

      <label className="field">Titel<input value={c.title} onChange={(e) => set('title', e.target.value)} autoFocus /></label>

      <div className="row">
        <span className="small muted">Format:</span>
        {(['CLASSIC', 'GHERKIN', 'PLAIN'] as Format[]).map((f) => (
          <button key={f} className={c.format === f ? 'primary small' : 'small'} aria-pressed={c.format === f} onClick={() => void switchFormat(f)}
            title={f === 'PLAIN' ? 'Unstrukturierter Test: Testanweisung als Freitext, Ergebnis nur als Ganzes – keine Schritte' : undefined}>{FORMAT_LABEL[f]}</button>
        ))}
        <span className="spacer" />
        {assist.data?.llm && <button className="small" onClick={runReview} disabled={reviewing || !c.title.trim()} title={`Testfall von der KI prüfen lassen (${assist.data.llm.model}) – ändert nichts`}>{reviewing ? 'Prüft …' : '✨ Prüfen'}</button>}
        {c.format === 'CLASSIC' && <button className="small" onClick={toGherkin} title="Erzeugt einen Vorschlag, speichert nichts">In Gherkin umwandeln …</button>}
        {c.format === 'GHERKIN' && <button className="small" onClick={toClassic} disabled={!c.gherkin}>In Schritte umwandeln …</button>}
      </div>

      {aiAssisted && <div className="notice info small">✨ Entwurf mit KI erstellt ({aiAssisted.split(' · ')[1] ?? aiAssisted}) – bitte fachlich prüfen. Die Version wird als „mit KI erstellt“ gekennzeichnet.</div>}
      {review && (
        <div className="notice review-box">
          <div className="row"><strong>✨ Prüfung ({review.model})</strong><span className="spacer" /><button className="ghost small" onClick={() => setReview(null)} aria-label="Prüfung schließen">✕</button></div>
          {review.findings.length === 0 ? <div className="small">Keine Befunde – der Testfall wirkt vollständig und eindeutig.</div> : (
            <ul className="review-list">{review.findings.map((f, i) => (
              <li key={i}><span className={`badge ${f.severity === 'hoch' ? 'bad' : f.severity === 'mittel' ? 'warn' : 'neutral'}`}>{f.severity}</span>
                {f.step && <span className="small muted"> Schritt {f.step}:</span>} {f.problem}{f.suggestion && <div className="small muted">→ {f.suggestion}</div>}</li>
            ))}</ul>
          )}
          <div className="small muted">Vorschläge der KI – übernehmen Sie, was passt. Gespeichert wird nur, was Sie ändern.</div>
        </div>
      )}

      <div className="grid2">
        <div className="field">Ziel / Beschreibung
          <WikiEditor label="Ziel / Beschreibung" value={c.objective} onChange={(v) => set('objective', v || null)} upload={upload} minRows={6} templates={tpl('objective')} onSaveTemplate={saveTemplate('objective')}
            placeholder="Was wird geprüft? Screenshots per Einfügen (Strg+V) oder Ablegen" />
        </div>
        <div className="field">Vorbedingungen
          <PreconditionPicker projectKey={projectKey} value={c.preconditionIds ?? []} onChange={(ids) => set('preconditionIds', ids)} />
          <WikiEditor label="Vorbedingungen" value={c.preconditions} onChange={(v) => set('preconditions', v || null)} upload={upload} minRows={4} templates={tpl('preconditions')} onSaveTemplate={saveTemplate('preconditions')}
            placeholder="Weitere, nur hier gültige Vorbedingungen (Freitext)" />
        </div>
      </div>

      {c.format === 'PLAIN' ? (
        <div className="stack editor-area">
          <div className="field">Testanweisung
            <WikiEditor label="Testanweisung" value={c.plainText ?? null} onChange={(v) => set('plainText', v || null)} upload={upload} minRows={10}
              placeholder="Was ist zu tun und was wird erwartet? Freitext mit Wiki-Markup (z. B. # nummerierte Liste)" />
          </div>
          <p className="small muted">Unstrukturierter Test: keine Schritte – in der Durchführung wird nur das Gesamtergebnis erfasst.</p>
        </div>
      ) : c.format === 'CLASSIC' ? (
        <div className="stack editor-area">
          <h4>Schritte</h4>
          <div className="steps-edit">
            <table className="steps">
              <colgroup><col style={{ width: 56 }} /><col style={{ width: '38%' }} /><col style={{ width: '22%' }} /><col style={{ width: '38%' }} /><col style={{ width: 92 }} /></colgroup>
              <thead><tr><th>#</th><th>Aktion</th><th>Testdaten</th><th>Erwartetes Ergebnis</th><th /></tr></thead>
              <tbody>
                {c.steps.map((s, i) => s.kind === 'group' ? (
                  <tr key={s.id ?? `new-${i}`} className="step-group edit">
                    <td className="n step-n"><span className="badge neutral" title="Abschnitt – kein Prüfschritt, ohne Ergebnis">§</span></td>
                    <td colSpan={3}>
                      <div className="row" style={{ gap: 6 }}>
                        <input value={s.title ?? ''} onChange={(e) => setGroup(i, { title: e.target.value })} placeholder="Name des Abschnitts, z. B. Einstellungen, Test durchführen, Aufräumen"
                          aria-label="Name des Abschnitts" maxLength={200} style={{ flex: 1, minWidth: 200, fontWeight: 600 }} />
                        {s.subtitle && <input value={s.subtitle} onChange={(e) => setGroup(i, { subtitle: e.target.value || null })} aria-label="Untertitel des Abschnitts" maxLength={200} style={{ flex: 1, minWidth: 160 }} />}
                        {s.marker && <span className="badge warn">{s.marker} <button type="button" className="chip-x" onClick={() => setGroup(i, { marker: null })} aria-label={`Kennzeichen ${s.marker} entfernen`}>✕</button></span>}
                      </div>
                      {(s.note !== null && s.note !== undefined) && <WikiEditor compact minRows={1} value={s.note} onChange={(v) => setGroup(i, { note: v || null })} upload={upload} label="Beschreibung des Abschnitts" />}
                      {(s.note === null || s.note === undefined) && <button type="button" className="link small" onClick={() => setGroup(i, { note: '' })}>+ Beschreibung</button>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="ghost small" onClick={() => moveGroup(i, -1)} title="Abschnitt mit seinen Schritten nach oben" aria-label={`Abschnitt ${s.title || ''} nach oben`}>↑</button>
                      <button className="ghost small" onClick={() => moveGroup(i, 1)} title="Abschnitt mit seinen Schritten nach unten" aria-label={`Abschnitt ${s.title || ''} nach unten`}>↓</button>
                      <ActionMenu label="⋯" ariaLabel={`Weitere Aktionen zu Abschnitt ${s.title || ''}`} items={[
                        { label: '↺ In Schritt zurückwandeln', title: s.legacy ? 'Ursprünglichen Trennschritt wiederherstellen' : 'Abschnitt wird ein normaler Schritt', onClick: () => toStep(i) },
                        { label: '✕ Abschnitt entfernen', title: 'Nur die Abschnittszeile – die Schritte bleiben', onClick: () => { set('steps', c.steps.filter((_, k) => k !== i)); setMarked([]); } },
                      ]} />
                    </td>
                  </tr>
                ) : (
                  <tr key={s.id ?? `new-${i}`} className={`${s.call ? 'call-step' : ''} ${marked.includes(i) ? 'marked' : ''}`.trim() || undefined}>
                    <td className="n step-n">
                      <label className="step-mark" title="Schritt markieren – Einfügeposition bzw. Auswahl für „Als Baustein speichern“">
                        <input type="checkbox" checked={marked.includes(i)} aria-label={`Schritt ${nos[i]} markieren`}
                          onChange={(e) => setMarked((m) => (e.target.checked ? [...m, i] : m.filter((x) => x !== i)))} />{nos[i]}</label>
                      {s.blockId && <span className="block-mark" title="Aus der Schrittbibliothek eingefügt (Kopie)" aria-label="aus Bibliothek">📚</span>}
                    </td>
                    {s.call
                      ? <td colSpan={3}><CallStepCell step={s} onChange={(next) => set('steps', c.steps.map((x, k) => (k === i ? next : x)))} /></td>
                      : <>
                        <td><WikiEditor compact minRows={3} value={s.action} onChange={(v) => setStep(i, 'action', v)} upload={upload} label={`Aktion ${nos[i]}`} templates={tpl('action')} onSaveTemplate={saveTemplate('action')} />
                          {existing && s.id && <StepAttachments testCaseId={existing.id} stepId={s.id} all={stored.data ?? []} onChanged={() => stored.reload()} />}</td>
                        <td><WikiEditor compact minRows={2} value={s.data} onChange={(v) => setStep(i, 'data', v)} upload={upload} label={`Testdaten ${nos[i]}`} templates={tpl('data')} onSaveTemplate={saveTemplate('data')} /></td>
                        <td><WikiEditor compact minRows={3} value={s.expected} onChange={(v) => setStep(i, 'expected', v)} upload={upload} label={`Erwartung ${nos[i]}`} templates={tpl('expected')} onSaveTemplate={saveTemplate('expected')} /></td>
                      </>}
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="ghost small" onClick={() => moveStep(i, -1)} title="nach oben" aria-label={`Schritt ${nos[i]} nach oben`}>↑</button>
                      <button className="ghost small" onClick={() => moveStep(i, 1)} title="nach unten" aria-label={`Schritt ${nos[i]} nach unten`}>↓</button>
                      <button className="ghost small danger" onClick={() => { set('steps', c.steps.filter((_, k) => k !== i)); setMarked([]); }} title="entfernen" aria-label={`Schritt ${nos[i]} entfernen`}>✕</button>
                      {!s.call && <button className="ghost small" onClick={() => toGroup(i)} title="In Abschnitt umwandeln (Aktion wird Name)" aria-label={`Schritt ${nos[i]} in Abschnitt umwandeln`}>§</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row"><button className="small" onClick={() => set('steps', [...c.steps, newStep()])}>+ Schritt</button>
            <button className="small" onClick={addGroup} title={`Abschnitt zur Gliederung (z. B. Einstellungen, Test, Aufräumen) – ${marked.length ? `vor Schritt ${nos[Math.min(...marked)] ?? ''}` : 'am Ende'}; kein Prüfschritt`}>§ Abschnitt</button>
            <button className="small" onClick={() => setPickingCall(true)} title="Schritte eines anderen Testfalls einsetzen (z. B. Anmelden) – einmal pflegen, überall nutzen">↪ Testfall aufrufen …</button>
            <button className="small" onClick={() => setPickingBlock(true)}
              title={`Schritte eines Bausteins als Kopie einfügen – ${marked.length ? `nach Schritt ${Math.max(...marked) + 1}` : 'am Ende'}`}>📚 Aus Bibliothek …</button>
            <button className="small" disabled={!c.steps.some((s) => !s.call && stepHasContent(s))}
              onClick={() => setSavingBlock((marked.length ? [...marked].sort((a, b) => a - b) : c.steps.map((_, k) => k)).filter((k) => c.steps[k] && !c.steps[k]!.call && stepHasContent(c.steps[k]!)))}
              title={marked.length ? `Die ${marked.length} markierten Schritte als wiederverwendbaren Baustein speichern` : 'Alle Schritte als wiederverwendbaren Baustein speichern (vorher markieren, um nur einige zu nehmen)'}>
              Als Baustein speichern …</button>
            {marked.length > 0 && <span className="small muted">{marked.length} markiert <button className="link small" onClick={() => setMarked([])}>aufheben</button></span>}
            {c.dataset && c.dataset.rows.length > 0 && <span className="badge neutral" title="Jede Datenzeile wird ein eigener Durchlauf">parametrisiert · {c.dataset.rows.length} Durchläufe</span>}</div>
          <div className="stack"><h4>Datensatz (parametrisierter Test)</h4>
            <DatasetEditor value={c.dataset} onChange={(d) => set('dataset', d)} /></div>
        </div>
      ) : (
        <div className="grid2 editor-area">
          <label className="field">Gherkin
            <textarea rows={Math.max(16, Math.min(40, (c.gherkin ?? '').split('\n').length + 2))} className="mono" spellCheck={false} value={c.gherkin ?? ''} onChange={(e) => set('gherkin', e.target.value)} />
          </label>
          <div className="stack">
            <span className="small muted">Vorschau &amp; Prüfung</span>
            {c.gherkin && <GherkinView text={c.gherkin} doc={doc} />}
            {doc && doc.errors.length === 0 && doc.warnings.length === 0 && <div className="notice ok">Gültig – {doc.scenarios.length} Szenario(s)</div>}
            {doc?.errors.map((e, k) => <div key={k} className="notice bad">Zeile {e.line}: {e.message}</div>)}
            {doc?.warnings.map((w, k) => <div key={k} className="notice warn">Zeile {w.line}: {w.message}</div>)}
          </div>
        </div>
      )}

      {c.format === 'GHERKIN' && <p className="small muted">Parametrisiert über Szenariogrundriss und „Beispiele“ – jede Beispielzeile wird ein Durchlauf.</p>}

      <div className="grid2">
        <div className="field">Testdaten<WikiEditor label="Testdaten" value={c.testData} onChange={(v) => set('testData', v || null)} upload={upload} minRows={3} templates={tpl('testData')} onSaveTemplate={saveTemplate('testData')} /></div>
        <label className="field">Priorität<PrioritySelect value={c.priority} onChange={(v) => set('priority', v)} priorities={priorities} /></label>
        <label className="field">Labels (Komma-getrennt)<input value={c.labels.join(', ')} onChange={(e) => set('labels', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} /></label>
        <label className="field">Komponenten (Komma-getrennt)<input value={c.components.join(', ')} onChange={(e) => set('components', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} /></label>
      </div>
      {fieldDefs.length > 0 && <div className="stack"><h4>Felder</h4>
        <FieldInputs defs={fieldDefs} values={c.customFields} onChange={(v) => set('customFields', v)} /></div>}
      <div className="stack">
        <div className="row"><h4>Anhänge ({attachments.length})</h4>
          <label className="btn small" style={{ cursor: 'pointer' }}>+ Datei<input type="file" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} /></label>
          <span className="small muted">{existing ? 'werden sofort am Testfall gespeichert' : 'werden mit dem Testfall angelegt'} · in Texte einbetten: Strg+V, Ablegen oder 📎</span>
        </div>
        {attachments.length > 0 && <div className="chips">{attachments.map((a) => <span key={a.id} className="chip">{a.url ? '⏳ ' : ''}{a.fileName}
          {existing && !a.url && <button type="button" className="chip-x" aria-label={`Anhang ${a.fileName} löschen`} onClick={() => removeAttachment(a)}>✕</button>}
          {!existing && a.url && <button type="button" className="chip-x" aria-label={`Anhang ${a.fileName} entfernen`} onClick={() => setPending((p) => p.filter((x) => x.id !== a.id))}>✕</button>}</span>)}</div>}
      </div>
      {c.sections.length > 0 && <p className="small muted">{c.sections.length} weitere Abschnitte (z. B. aus der Migration) bleiben unverändert erhalten.</p>}
      {pickingBlock && <StepBlockPicker projectKey={projectKey} insertAfter={marked.length ? Math.max(...marked) : null} onClose={() => setPickingBlock(false)} onInsert={insertBlock} />}
      {savingBlock && <StepBlockEditor projectKey={projectKey} initialSteps={savingBlock.map((k) => c.steps[k]!)} onClose={() => setSavingBlock(null)}
        onSaved={(b) => {
          const idx = new Set(savingBlock);
          setC((x) => ({ ...x, steps: x.steps.map((s, k) => (idx.has(k) && !s.blockId ? { ...s, blockId: b.id } : s)) }));
          setSavingBlock(null);
          setMarked([]);
        }} />}
      {pickingCall && <TestCasePickerDialog projectKey={projectKey} excludeId={existing?.id} onClose={() => setPickingCall(false)}
        onPick={(t) => { setPickingCall(false); set('steps', [...c.steps.filter((x) => x.action || x.data || x.expected || x.call), { action: `Testfall ${t.key} „${t.title}“ ausführen`, data: '', expected: '', call: { testCaseId: t.id, versionNo: null } }]); }} />}
      </WikiAttachments>
  );
}

/** Anhänge eines Schritts (bestehender Testfall): anzeigen, hinzufügen, löschen. */
function StepAttachments({ testCaseId, stepId, all, onChanged }: { testCaseId: string; stepId: string; all: WikiAttachment[]; onChanged: () => void }) {
  const mine = all.filter((a) => (a as WikiAttachment & { stepId?: string | null }).stepId === stepId);
  const add = async (files: FileList | null) => {
    for (const f of [...(files ?? [])]) {
      try { await uploadAttachment('TEST_CASE', testCaseId, f, stepId); } catch (e) { toast(`Anhang „${f.name}“: ${(e as Error).message}`, 'bad'); }
    }
    onChanged();
  };
  return (
    <div className="step-atts">
      {mine.map((a) => <span key={a.id} className="chip">📎 {a.fileName}
        <button type="button" className="chip-x" aria-label={`Anhang ${a.fileName} löschen`} onClick={async () => {
          if (await askConfirm({ title: 'Anhang löschen', message: `„${a.fileName}“ löschen?`, confirmLabel: 'Löschen', danger: true })) { await api('DELETE', `/api/attachments/${a.id}`).catch(() => null); onChanged(); }
        }}>✕</button></span>)}
      <label className="chip chip-add" title="Datei an diesen Schritt hängen (z. B. Bildschirmfoto, Beispieldatei)">+ 📎<input type="file" multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ''; }} /></label>
    </div>
  );
}
