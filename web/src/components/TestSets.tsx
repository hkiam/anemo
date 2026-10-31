import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { askConfirm, askText, toast } from '../ux.tsx';
import { ErrorNote, Modal } from './common.tsx';
import { plural } from '../text.ts';

export interface TestSet { id: string; name: string; description: string | null; kind: 'static' | 'dynamic'; query: string | null; testCaseIds: string[]; count: number | null; error?: string }

/** Neues Testset aus der aktuellen Auswahl (statisch) bzw. dem aktuellen Filter (dynamisch). */
export async function createTestSet(projectKey: string, kind: 'static' | 'dynamic', payload: { testCaseIds?: string[]; query?: string }) {
  const name = await askText({
    title: kind === 'static' ? 'Auswahl als Testset speichern' : 'Filter als Testset speichern', label: 'Name', placeholder: 'z. B. Smoke, Regression Kern',
    hint: kind === 'static' ? 'Feste Liste der ausgewählten Testfälle.' : 'Wird bei jeder Verwendung neu ausgewertet – neue passende Testfälle kommen automatisch dazu.',
    confirmLabel: 'Speichern',
  });
  if (!name) return null;
  const s = await api<TestSet>('POST', `/api/projects/${projectKey}/test-sets`, { name, kind, ...payload });
  toast(`Testset „${name}“ gespeichert`);
  return s;
}

/** Verwaltung der Testsets eines Projekts: anzeigen (Filter anwenden bzw. Testfälle markieren), umbenennen, löschen. */
export function TestSetsDialog({ projectKey, canEdit, onClose, onApply, selection, filterQuery }: {
  projectKey: string; canEdit: boolean; onClose: () => void; onApply: (s: TestSet, ids: string[]) => void;
  /** aktuelle Auswahl in der Liste (für „+ Aus Auswahl“) bzw. aktueller Filter (für „+ Aus Filter“) */
  selection: string[]; filterQuery: string | null;
}) {
  const sets = useApi<TestSet[]>(`/api/projects/${projectKey}/test-sets`);
  const cycles = useApi<{ items: { id: string; name: string; state?: string }[] }>(`/api/projects/${projectKey}/cycles?limit=50`);
  const [error, setError] = useState<unknown>(null);
  const [planning, setPlanning] = useState<string | null>(null);
  const create = async (kind: 'static' | 'dynamic') => {
    try {
      if (await createTestSet(projectKey, kind, kind === 'static' ? { testCaseIds: selection } : { query: filterQuery ?? '' })) sets.reload();
    } catch (e) {
      setError(e);
    }
  };
  const addToCycle = async (s: TestSet, cycleId: string) => {
    const name = cycles.data?.items.find((c) => c.id === cycleId)?.name ?? '';
    if (!(await askConfirm({ title: `„${s.name}“ einplanen`, message: `${s.count ?? 0} Testfälle in den Zyklus „${name}“ aufnehmen? Bereits enthaltene werden übersprungen.`, confirmLabel: 'Aufnehmen' }))) return;
    try {
      const r = await api<{ added: number; total: number; warnings: string[] }>('POST', `/api/cycles/${cycleId}/executions/from-test-set`, { testSetId: s.id });
      toast(`„${s.name}“: ${r.added} von ${r.total} Testfällen in den Zyklus aufgenommen`);
      for (const w of r.warnings) toast(w, 'info');
      setPlanning(null);
    } catch (e) {
      setError(e);
    }
  };
  const apply = async (s: TestSet) => {
    try {
      const tcs = await api<{ id: string }[]>('GET', `/api/test-sets/${s.id}/test-cases`);
      onApply(s, tcs.map((t) => t.id));
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal title="Testsets" help="testsets" onClose={onClose} footer={<><span className="spacer" /><button onClick={onClose}>Schließen</button></>}>
      <ErrorNote error={error ?? sets.error} />
      <p className="small muted"><b>Testsets</b> sind wiederkehrende Testumfänge für Zyklen (z. B. „Smoke“, „Regression Kern“): <b>fest</b> = feste Liste von Testfällen,
        <b> dynamisch</b> = gespeicherter Filter, der bei jeder Verwendung neu ausgewertet wird. Anders als <i>Ansichten</i> (nur gespeicherte Listenfilter) lassen sich Testsets
        direkt in Zyklen einplanen.</p>
      {canEdit && <div className="row">
        <button className="small" disabled={!selection.length} onClick={() => create('static')} title={selection.length ? '' : 'Erst Testfälle in der Liste ankreuzen'}>+ Aus aktueller Auswahl ({selection.length})</button>
        <button className="small" disabled={!filterQuery} onClick={() => create('dynamic')} title={filterQuery ? `Gespeichert wird: ${decodeURIComponent(filterQuery.replace(/\+/g, ' '))}` : 'Erst einen Filter setzen (Suche, Abfrage, Ordner, Status, Label, Testart, Priorität)'}>+ Aus aktuellem Filter</button>
      </div>}
      {!sets.data && !sets.error && <div className="small muted">Lädt …</div>}
      {sets.data?.length === 0 && <div className="empty">Noch keine Testsets.</div>}
      <div className="table-wrap"><table><tbody>
        {sets.data?.map((s) => (
          <tr key={s.id}>
            <td><strong>{s.name}</strong>{s.description && <div className="small muted">{s.description}</div>}
              {s.kind === 'dynamic' && s.query && <div className="small muted mono" title="gespeicherter Filter">{decodeURIComponent(s.query.replace(/\+/g, ' '))}</div>}</td>
            <td className="fit small">{s.kind === 'static' ? 'fest' : 'dynamisch'}</td>
            <td className="fit small">{s.count === null ? <span className="err" title={s.error}>Filter ungültig</span> : plural(s.count, 'Testfall', 'Testfälle')}</td>
            <td className="fit" style={{ whiteSpace: 'nowrap' }}>
              <button className="small" onClick={() => apply(s)} title={s.kind === 'dynamic' ? 'Filter anwenden' : 'Testfälle in der Liste markieren'}>Anzeigen</button>
              {canEdit && (planning === s.id
                ? <select autoFocus aria-label="Zyklus wählen" style={{ width: 'auto' }} value="" onChange={(e) => e.target.value && addToCycle(s, e.target.value)} onBlur={() => setPlanning(null)}>
                    <option value="">Zyklus wählen …</option>
                    {(cycles.data?.items ?? []).filter((c) => c.state !== 'closed').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                : <button className="small" onClick={() => setPlanning(s.id)} disabled={s.count === null}>In Zyklus aufnehmen …</button>)}
              {canEdit && <button className="small ghost" onClick={async () => {
                const name = await askText({ title: 'Testset umbenennen', label: 'Name', initial: s.name });
                if (name) { try { await api('PUT', `/api/test-sets/${s.id}`, { name }); toast('Testset umbenannt'); } catch (e) { setError(e); } sets.reload(); }
              }} title="Umbenennen" aria-label={`Testset ${s.name} umbenennen`}>✎</button>}
              {canEdit && <button className="small ghost danger" aria-label={`Testset ${s.name} löschen`} onClick={async () => {
                if (!(await askConfirm({ title: 'Testset löschen', message: `„${s.name}“ löschen? Die Testfälle bleiben unverändert.`, confirmLabel: 'Löschen', danger: true }))) return;
                try { await api('DELETE', `/api/test-sets/${s.id}`); toast(`Testset „${s.name}“ gelöscht`); } catch (e) { setError(e); }
                sets.reload();
              }}>✕</button>}
            </td>
          </tr>
        ))}
      </tbody></table></div>
    </Modal>
  );
}

/** In „Tests aufnehmen“: ganzes Testset auf einmal einplanen (serverseitig, ohne Größengrenze). */
export function TestSetPicker({ projectKey, cycleId, onAdded }: { projectKey: string; cycleId: string; onAdded: () => void }) {
  const sets = useApi<TestSet[]>(`/api/projects/${projectKey}/test-sets`);
  if (!sets.data?.length) return null;
  return (
    <select value="" aria-label="Aus Testset" style={{ width: 'auto' }} onChange={async (e) => {
      const s = sets.data!.find((x) => x.id === e.target.value);
      if (!s) return;
      // Auswahl allein ändert nichts – erst nach Rückfrage (Pfeiltasten im Auswahlfeld lösen sonst sofort aus)
      if (!(await askConfirm({ title: `Testset „${s.name}“ aufnehmen`, message: `${plural(s.count ?? 0, 'Testfall', 'Testfälle')} in diesen Zyklus aufnehmen? Bereits enthaltene werden übersprungen.`, confirmLabel: 'Aufnehmen' }))) return;
      try {
        const r = await api<{ added: number; total: number; warnings: string[] }>('POST', `/api/cycles/${cycleId}/executions/from-test-set`, { testSetId: s.id });
        toast(`„${s.name}“: ${r.added} von ${r.total} Testfällen aufgenommen${r.total > r.added ? ' (übrige bereits im Zyklus bzw. veraltet)' : ''}`);
        for (const w of r.warnings) toast(w, 'info');
        onAdded();
      } catch (err) {
        toast((err as Error).message, 'bad');
      }
    }}>
      <option value="">ganzes Testset aufnehmen …</option>
      {sets.data.map((s) => <option key={s.id} value={s.id} disabled={s.count === null}>{s.name} ({s.count ?? 'Filter ungültig'})</option>)}
    </select>
  );
}
