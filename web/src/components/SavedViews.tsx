import { useRef, useState } from 'react';
import { api, useApi } from '../api.ts';
import { useCan } from '../session.tsx';
import { askConfirm, askText, DropPanel, toast } from '../ux.tsx';

interface View { id: string; name: string; query: string; shared: boolean; ownerName: string; mine: boolean }

/** Gespeicherte Ansichten: aktuelle Filter (URL) als Lesezeichen sichern und wieder aufrufen. */
export function SavedViews({ projectKey, page, base }: { projectKey: string; page: 'repo' | 'cycles' | 'health'; base: string }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const views = useApi<View[]>(open ? `/api/projects/${projectKey}/views?page=${page}` : null);
  const canShare = useCan(projectKey, 'edit');
  const current = window.location.hash.split('?')[1] ?? '';
  async function save() {
    const name = await askText({ title: 'Ansicht speichern', label: 'Name der Ansicht', placeholder: 'z. B. Offene Regression Oracle', hint: 'Speichert die aktuellen Filter und die Sortierung.', confirmLabel: 'Speichern' });
    if (!name?.trim()) return;
    const shared = canShare && (await askConfirm({ title: 'Ansicht freigeben?', message: `„${name.trim()}“ für alle im Projekt freigeben oder nur für Sie speichern?`, confirmLabel: 'Für alle freigeben' }));
    try {
      await api('POST', `/api/projects/${projectKey}/views`, { page, name: name.trim(), query: current, shared });
      toast(`Ansicht „${name.trim()}“ gespeichert${shared ? ' (für alle)' : ''}`);
    } catch (e) { toast(`Ansicht nicht gespeichert: ${(e as Error).message}`, 'bad'); }
    views.reload();
  }
  async function remove(v: View) {
    if (!(await askConfirm({ title: 'Ansicht löschen', message: `Ansicht „${v.name}“ löschen?`, confirmLabel: 'Löschen', danger: true }))) return;
    try { await api('DELETE', `/api/views/${v.id}`); toast(`Ansicht „${v.name}“ gelöscht`); } catch (e) { toast(`Löschen fehlgeschlagen: ${(e as Error).message}`, 'bad'); }
    views.reload();
  }
  return (
    <span className="account" ref={anchorRef}>
      <button className="small" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Gespeicherte Filter (Lesezeichen für die aktuelle Liste)"><span aria-hidden="true">☆ </span>Ansichten ▾</button>
      {open && <>
        <DropPanel anchor={anchorRef} onClose={() => setOpen(false)} style={{ minWidth: 280 }}>
          <button className="ghost" onClick={save} disabled={!current}>{current ? '+ Aktuelle Filter speichern …' : 'Erst filtern, dann speichern'}</button>
          {!views.data && !views.error && <span className="small muted">Lädt …</span>}
          {views.data?.length === 0 && <span className="small muted">Noch keine Ansichten.</span>}
          {views.data?.map((v) => (
            <div key={v.id} className="row" style={{ gap: 4 }}>
              <a href={`${base}${v.query ? `?${v.query}` : ''}`} onClick={() => setOpen(false)} style={{ flex: 1 }}>{v.shared && <span aria-hidden="true">👥 </span>}{v.name}{v.shared && <span className="sr-only"> (für alle freigegeben)</span>}</a>
              {!v.mine && <span className="small muted">{v.ownerName}</span>}
              {v.mine && <button className="ghost small" onClick={() => remove(v)} title="löschen" aria-label={`Ansicht „${v.name}“ löschen`}>✕</button>}
            </div>
          ))}
        </DropPanel>
      </>}
    </span>
  );
}
