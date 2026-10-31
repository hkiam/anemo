import { stepNumbers } from '../../../shared/steps/groups.ts';
import { useEffect, useState } from 'react';
import { api, useApi } from '../api.ts';
import type { Severity, Step } from '../types.ts';
import { SeveritySelect } from './Severity.tsx';
import { WikiEditor } from '../wiki/WikiEditor.tsx';
import { ErrorNote, Modal } from './common.tsx';
import { askConfirm, toast, useUnsavedGuard } from '../ux.tsx';

interface Draft { templateId: string; title: string; body: string; target: { provider: string; available: boolean; reason: string | null; externalProject: string | null } }
const providerName = (p: string) => (p === 'jira' ? 'Jira' : p === 'openproject' ? 'OpenProject' : p);
interface Template { id: string; name: string; projectId: string | null }

/**
 * Fehler aus einer Ausführung melden: Vorlage wählen, Text prüfen, im Fremdsystem anlegen – oder, solange
 * keine Integration eingerichtet ist, Text kopieren und den angelegten Fehler von Hand verknüpfen.
 */
export function DefectDialog({ executionId, projectKey, steps, failedStepIds, initialStepId, onClose, onLinked }: {
  executionId: string; projectKey: string; steps: Step[]; failedStepIds: string[]; initialStepId?: string; onClose: () => void; onLinked: () => void;
}) {
  const stepNos = stepNumbers(steps);
  const templates = useApi<Template[]>(`/api/defect-templates?project=${projectKey}`);
  const [templateId, setTemplateId] = useState<string | undefined>();
  const [stepId, setStepId] = useState<string | undefined>(initialStepId ?? failedStepIds[0]);
  const [severity, setSeverity] = useState<Severity | ''>('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const assist = useApi<{ llm: { model: string } | null }>('/api/assist/status');
  const [aiRev, setAiRev] = useState(0);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiModel, setAiModel] = useState<string | null>(null);
  const formulate = async () => {
    setAiBusy(true);
    setError(null);
    try {
      const r = await api<{ title: string; body: string; model: string }>('POST', `/api/executions/${executionId}/assist/defect`);
      setTitle(r.title);
      setBody(r.body);
      setAiModel(r.model);
      setAiRev((x) => x + 1);
    } catch (e) {
      setError(e);
    } finally {
      setAiBusy(false);
    }
  };
  const [manualKey, setManualKey] = useState('');
  const [provider, setProvider] = useState('openproject');
  useEffect(() => { if (draft?.target.provider === 'jira') setProvider('jira'); }, [draft?.target.provider]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<Draft>('POST', `/api/executions/${executionId}/defect-draft`, { templateId, stepId }).then((d) => {
      setDraft(d);
      setTitle(d.title);
      setBody(d.body);
      setTemplateId((t) => t ?? d.templateId);
    }, setError);
  }, [executionId, templateId, stepId]);

  async function create() {
    setBusy(true);
    try {
      await api('POST', `/api/executions/${executionId}/defects`, { title, body, ...(stepId ? { stepId } : {}), ...(severity ? { severity } : {}) });
      onLinked();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function linkManual() {
    try {
      await api('POST', '/api/references', { ownerType: 'TEST_EXECUTION', ownerId: executionId, provider, externalKey: manualKey.trim(), relation: 'DEFECT', title, ...(stepId ? { stepId } : {}), ...(severity ? { severity } : {}) });
      onLinked();
    } catch (e) {
      setError(e);
    }
  }
  async function copy() {
    const text = `${title}\n\n${body}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Ersatzweg ohne Zwischenablage-API (z. B. ohne HTTPS): Text markieren und kopieren
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) { toast('Kopieren nicht möglich – bitte Titel und Beschreibung von Hand markieren und kopieren', 'bad'); return; }
    }
    setCopied(true);
    toast('Text der Fehlermeldung kopiert');
    setTimeout(() => setCopied(false), 1500);
  }
  // Schutz ungespeicherter Eingaben: Titel oder Text weicht vom Entwurf der Vorlage ab bzw. Schlüssel eingegeben
  const dirty = !!draft && (title !== draft.title || body !== draft.body || !!manualKey.trim());
  useUnsavedGuard(dirty, `defect-${executionId}`);
  const close = async () => {
    if (dirty && !(await askConfirm({ title: 'Fehlermeldung verwerfen?', message: 'Titel und Beschreibung wurden bearbeitet. Beim Schließen gehen die Änderungen verloren.', confirmLabel: 'Verwerfen', danger: true }))) return;
    onClose();
  };
  const manualOk = !!manualKey.trim();

  return (
    <Modal size="large" title="Fehler melden" help="defects" onClose={() => void close()}
      footer={<>
        {assist.data?.llm && <button onClick={formulate} disabled={aiBusy} title={`Titel und Beschreibung aus Schritten, Befunden und Konfiguration formulieren (${assist.data.llm.model})`}><span aria-hidden="true">✨ </span>{aiBusy ? 'Formuliert …' : 'Formulieren'}</button>}
        <button onClick={copy} disabled={!draft} title={draft ? 'Titel und Beschreibung in die Zwischenablage' : 'Entwurf wird noch geladen'}>{copied ? 'Kopiert ✓' : 'Text kopieren'}</button>
        <span className="spacer" />
        <button onClick={() => void close()}>Abbrechen</button>
        {draft?.target.available && <button className="primary" onClick={create} disabled={busy || !title.trim()} title={!title.trim() ? 'Bitte einen Titel eingeben' : undefined}>{busy ? 'Legt an …' : `In ${providerName(draft.target.provider)} anlegen${draft.target.externalProject ? ` (${draft.target.externalProject})` : ''}`}</button>}
        {draft && !draft.target.available && <button className="primary" onClick={linkManual} disabled={!manualOk} title={manualOk ? undefined : 'Erst Schlüssel bzw. Nummer des angelegten Fehlers eingeben'}>Verknüpfen</button>}
      </>}>
      <ErrorNote error={error} />
      <div className="grid2">
        <label className="field">Vorlage
          <select value={templateId ?? ''} onChange={(e) => setTemplateId(e.target.value || undefined)}>
            {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name}{t.projectId ? ' (Projekt)' : ''}</option>)}
          </select>
        </label>
        <label className="field">Betroffener Schritt
          <select value={stepId ?? ''} onChange={(e) => setStepId(e.target.value || undefined)}>
            <option value="">– ganzer Test –</option>
            {steps.map((s, i) => s.kind === 'group' ? null : <option key={s.id} value={s.id}>{failedStepIds.includes(s.id!) ? '✗ ' : ''}{stepNos[i]}. {s.action.split('\n')[0]!.slice(0, 80)}</option>)}
          </select>
        </label>
        <SeveritySelect value={severity} onChange={setSeverity} />
      </div>
      {draft && <div className={`small ${draft.target.available ? 'muted' : ''}`} data-testid="defect-target">
        {draft.target.available
          ? <>Wird in <b>{providerName(draft.target.provider)}</b>{draft.target.externalProject ? <> (Projekt {draft.target.externalProject})</> : ''} angelegt und mit dieser Ausführung{stepId ? ' und dem gewählten Schritt' : ''} verknüpft.</>
          : <>Ziel: {providerName(draft.target.provider)} – direktes Anlegen derzeit nicht möglich (siehe unten).</>}
      </div>}
      {aiModel && <div className="notice info small"><span aria-hidden="true">✨ </span>Von {aiModel} formuliert – bitte prüfen. Die Vorlage bleibt die Grundlage; Rückverweis und Anhänge ergänzt Anemo beim Anlegen.</div>}
      <label className="field">Titel<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={255} /></label>
      <div className="field">Beschreibung
        {draft && <WikiEditor key={`${draft.templateId}-${stepId}-${aiRev}`} value={body} onChange={setBody} minRows={14} label="Beschreibung der Fehlermeldung" />}
      </div>
      {draft && !draft.target.available && (
        <div className="notice warn stack">
          <div><strong>Direktes Anlegen nicht möglich:</strong> {draft.target.reason}. Text kopieren, im Ticketsystem anlegen und hier verknüpfen –
            der Nachtest-Bezug bleibt so erhalten.</div>
          <div className="row">
            <select value={provider} onChange={(e) => setProvider(e.target.value)} style={{ width: 'auto' }} aria-label="System">
              <option value="openproject">OpenProject</option><option value="jira">Jira</option>
            </select>
            <input placeholder="Schlüssel/Nummer des angelegten Fehlers" aria-label="Schlüssel bzw. Nummer des angelegten Fehlers" value={manualKey} onChange={(e) => setManualKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && manualOk) void linkManual(); }} style={{ flex: 1, width: 'auto' }} />
          </div>
        </div>
      )}
    </Modal>
  );
}
