import { useState } from 'react';
import { api } from '../api.ts';
import type { Content } from '../types.ts';
import { ErrorNote, Modal } from './common.tsx';

/** Testfall-Entwurf aus Anforderungstext per KI – wird im Editor geprüft und erst dort gespeichert (ADR-0023). */
export function DraftDialog({ projectKey, onClose, onDraft }: { projectKey: string; onClose: () => void; onDraft: (c: Partial<Content>, model: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const d = await api<{ title: string; objective: string | null; preconditions: string | null; gherkin: string | null; steps: { action: string; data: string; expected: string }[]; model: string }>(
        'POST', `/api/projects/${projectKey}/assist/draft`, { requirement: text });
      onDraft({ title: d.title, objective: d.objective, preconditions: d.preconditions, steps: d.steps, gherkin: d.gherkin, format: 'CLASSIC' }, d.model);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="✨ Testfall aus Anforderung entwerfen" help="tc-ai" onClose={onClose}
      footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={busy || text.trim().length < 20} onClick={go}>{busy ? 'Entwurf entsteht …' : 'Entwurf erzeugen'}</button></>}>
      <ErrorNote error={error} />
      <label className="field">Anforderungstext (z. B. aus OpenProject/Jira kopiert)
        <textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder="Als Sachbearbeiter möchte ich … damit …&#10;Akzeptanzkriterien: …" autoFocus />
      </label>
      <p className="small muted">Das KI-Modell schlägt Titel, Vorbedingungen, Schritte und ein Gherkin-Szenario vor. Der Entwurf öffnet im Editor – prüfen, anpassen,
        dann speichern. Nichts wird ohne Ihre Bestätigung angelegt.</p>
    </Modal>
  );
}
