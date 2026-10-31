import { useRef, useState } from 'react';
import { DropPanel, Icon } from '../ux.tsx';
import { useApi } from '../api.ts';

interface Profile { id: string; name: string; isDefault: boolean }
export interface ReportItem { label: string; path: string; hint?: string; zip?: boolean }

/** Berichte erzeugen: Profil wählen, als HTML (druckbar → PDF), Markdown oder JSON öffnen bzw. Lieferpaket laden. */
export function ReportMenu({ items }: { items: ReportItem[] }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const profiles = useApi<Profile[]>(open ? '/api/report-profiles' : null);
  const [profile, setProfile] = useState('');
  const link = (path: string, extra: Record<string, string> = {}) => {
    const u = new URL(path, window.location.origin);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    if (profile) u.searchParams.set('profile', profile);
    return `${u.pathname}${u.search}`;
  };
  return (
    <span className="account" ref={anchorRef}>
      <button className="small" onClick={() => setOpen((o) => !o)} aria-expanded={open}><Icon>📄</Icon>Berichte<Icon>▾</Icon></button>
      {open && <>
        <DropPanel anchor={anchorRef} onClose={() => setOpen(false)} className="report-panel">
          <label className="field">Profil
            <select value={profile} onChange={(e) => setProfile(e.target.value)}>
              <option value="">Standard</option>
              {profiles.data?.filter((p) => !p.isDefault).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {items.map((it) => (
            <div key={it.path} className="report-item">
              <div><strong>{it.label}</strong>{it.hint && <div className="small muted">{it.hint}</div>}</div>
              {it.zip
                ? <a className="btn small" href={link(it.path)} download>ZIP laden</a>
                : <span className="row">
                  <a className="btn small" href={link(it.path)} target="_blank" rel="noreferrer" title="Im Browser öffnen (mit Bildern und Evidenzen)">Ansehen</a>
                  <a className="btn small" href={link(it.path, { format: 'pdf', download: 'true' })} download title="PDF-Datei (Text und Tabellen, A4)">PDF</a>
                  <a className="btn small" href={link(it.path, { format: 'md', download: 'true' })} download>MD</a>
                  <a className="btn small" href={link(it.path, { format: 'json', download: 'true' })} download>JSON</a>
                </span>}
            </div>
          ))}
        </DropPanel>
      </>}
    </span>
  );
}
