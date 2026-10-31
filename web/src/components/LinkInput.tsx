import { useState } from 'react';
import { useApi } from '../api.ts';
import { Modal } from './common.tsx';

export interface LinkSettings { enabled: boolean; domains: string[] }
/** Sind freie Links (URL mit Kurznamen) in der Administration erlaubt? */
export function useLinkSettings(): LinkSettings {
  return useApi<LinkSettings>('/api/link-settings').data ?? { enabled: false, domains: [] };
}

/** Vorschlag für den Kurznamen aus der Adresse: Host ohne www plus letzter Pfadteil. */
export function suggestTitle(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
    return [u.hostname.replace(/^www\./, ''), last].filter(Boolean).join(' – ').slice(0, 80);
  } catch { return ''; }
}

export const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

/** Kurzname, wie er gespeichert wird: Eingabe oder – leer gelassen – der Vorschlag aus der Adresse. */
export const linkTitle = (url: string, title: string) => title.trim() || suggestTitle(url.trim());

/** Eingabe Adresse + Kurzname (Kurzname wird angezeigt, die Adresse ist das Ziel; leer = Vorschlag im Platzhalter). */
export function UrlLinkFields({ url, title, onUrl, onTitle, settings, idPrefix }: {
  url: string; title: string; onUrl: (v: string) => void; onTitle: (v: string) => void; settings: LinkSettings; idPrefix: string;
}) {
  return (
    <div className="grid2">
      <label className="field" htmlFor={`${idPrefix}-url`}>Adresse (URL)
        <input id={`${idPrefix}-url`} type="url" value={url} placeholder="https://…" onChange={(e) => onUrl(e.target.value)}
          aria-invalid={!!url && !isUrl(url)} />
        {settings.domains.length > 0 && <span className="small muted">Erlaubt: {settings.domains.join(', ')}</span>}
      </label>
      <label className="field" htmlFor={`${idPrefix}-title`}>Kurzname (wird angezeigt)
        <input id={`${idPrefix}-title`} value={title} maxLength={80} placeholder={isUrl(url) ? suggestTitle(url) : 'z. B. Bug 123 im Altsystem'} onChange={(e) => onTitle(e.target.value)} />
      </label>
    </div>
  );
}

export type DefectEntry = { key: string; title?: string; provider?: 'url' };

/** „Fehler verknüpfen“: Ticket-Schlüssel (OpenProject-Nummer, Jira-Schlüssel) oder – falls erlaubt – Link mit Kurznamen. */
export function LinkDefectDialog({ title = 'Fehler verknüpfen', hint, onSubmit, onClose }: {
  title?: string; hint?: string; onSubmit: (e: DefectEntry) => void | Promise<void>; onClose: () => void;
}) {
  const settings = useLinkSettings();
  const [mode, setMode] = useState<'ticket' | 'url'>('ticket');
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const ok = mode === 'ticket' ? !!key.trim() : isUrl(url) && !!linkTitle(url, name);
  const submit = () => onSubmit(mode === 'ticket' ? { key: key.trim() } : { provider: 'url', key: url.trim(), title: linkTitle(url, name) });
  return (
    <Modal title={title} help="defects" onClose={onClose}
      footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!ok} onClick={submit}>Verknüpfen</button></>}>
      {hint && <p className="small muted">{hint}</p>}
      {settings.enabled && <div className="seg-tabs" role="tablist" aria-label="Art der Verknüpfung">
        <button role="tab" aria-selected={mode === 'ticket'} className={mode === 'ticket' ? 'on' : ''} onClick={() => setMode('ticket')}>Ticket</button>
        <button role="tab" aria-selected={mode === 'url'} className={mode === 'url' ? 'on' : ''} onClick={() => setMode('url')}>Link (URL)</button>
      </div>}
      {mode === 'ticket'
        ? <label className="field">Ticket-Schlüssel
            <input autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="z. B. PROJ-315, OpenProject-Nummer 4711 oder Jira-Schlüssel"
              onKeyDown={(e) => { if (e.key === 'Enter' && ok) void submit(); }} />
          </label>
        : <UrlLinkFields url={url} title={name} onUrl={setUrl} onTitle={setName} settings={settings} idPrefix="defect-link" />}
    </Modal>
  );
}
