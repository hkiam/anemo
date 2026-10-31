import { useEffect, useState } from 'react';
import { api, useApi } from '../api.ts';
import { toast } from '../ux.tsx';
import { ErrorNote, Modal } from './common.tsx';

/** Projektkontext für KI-Skills: Glossar, Fachbegriffe, Stilregeln – wird an jeden Prompt des Projekts angehängt. */
export function AiContextDialog({ projectKey, onClose }: { projectKey: string; onClose: () => void }) {
  const p = useApi<{ aiContext?: string | null }>(`/api/projects/${projectKey}`);
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (p.data) setText(p.data.aiContext ?? ''); }, [p.data]);
  const save = async () => {
    try {
      await api('PUT', `/api/projects/${projectKey}/ai-context`, { aiContext: text.trim() || null });
      toast(`KI-Kontext für ${projectKey} gespeichert`);
      onClose();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal title={`KI-Kontext ${projectKey}`} onClose={onClose} footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" onClick={save}>Speichern</button></>}>
      <ErrorNote error={error ?? p.error} />
      <p className="small muted">Glossar, Fachbegriffe und Stilregeln dieses Projekts. KI-Skills (Entwurf, Prüfung, Fehlermeldung, Fazit) beachten sie verbindlich – das
        verbessert die Vorschläge deutlich, ohne ein Modell zu trainieren. Höchstens 8.000 Zeichen; keine Zugangsdaten oder personenbezogenen Daten.</p>
      <textarea rows={14} value={text} maxLength={8000} onChange={(e) => setText(e.target.value)} aria-label="KI-Kontext"
        placeholder={'Glossar:\n- Warenkorb = Liste der ausgewählten Artikel vor dem Bezahlen\n- Bestellung = …\n\nStilregeln:\n- Erwartete Ergebnisse im Präsens, beobachtbar formulieren\n- Rollen: Sachbearbeiter, Geschäftsstelle, Richter'} />
      <div className="small muted">{text.length} / 8000</div>
    </Modal>
  );
}
