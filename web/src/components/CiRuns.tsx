import { useEffect, useState } from 'react';
import { api, fmtDate, useApi } from '../api.ts';
import type { CiRun } from '../types.ts';
import { toast } from '../ux.tsx';
import { ErrorNote, Modal } from './common.tsx';

const STATUS: Record<string, [string, string]> = {
  created: ['angelegt', 'neutral'], waiting_for_resource: ['wartet', 'neutral'], preparing: ['bereitet vor', 'neutral'], pending: ['wartet', 'neutral'],
  running: ['läuft', 'accent'], success: ['erfolgreich', 'ok'], failed: ['fehlgeschlagen', 'bad'], canceled: ['abgebrochen', 'warn'],
  skipped: ['übersprungen', 'neutral'], manual: ['manuell', 'neutral'], scheduled: ['geplant', 'neutral'],
};

export function CiStatusBadge({ status }: { status: string }) {
  const [label, tone] = STATUS[status] ?? [status, 'neutral'];
  return <span className={`badge ${tone}`}>{label}</span>;
}

/** Kompakte Anzeige des letzten CI-Laufs im Zyklus-Kopf. */
export function LastCiRun({ cycleId }: { cycleId: string }) {
  const runs = useApi<CiRun[]>(`/api/cycles/${cycleId}/ci-runs`);
  const last = runs.data?.[0];
  if (!last) return null;
  const body = <>CI {last.ref} <CiStatusBadge status={last.status} /></>;
  return last.url
    ? <a className="chip" href={last.url} target="_blank" rel="noreferrer noopener" title={`Letzte Pipeline #${last.externalId}, ${fmtDate(last.createdAt)} von ${last.triggeredBy}`}>{body}</a>
    : <span className="chip" title={`Letzte Pipeline #${last.externalId}, ${fmtDate(last.createdAt)}`}>{body}</span>;
}

/**
 * GitLab-Pipeline für den Zyklus starten (Branch/Tag, Variablen); die Pipeline erhält die Anemo-Variablen und meldet
 * ihre Ergebnisse über automation-results zurück. Darunter die letzten Läufe.
 */
export function CiRunDialog({ cycleId, available, reason, refs = [], canEdit, onClose }: {
  cycleId: string; available: boolean; reason: string | null; refs?: string[]; canEdit: boolean; onClose: () => void;
}) {
  const runs = useApi<CiRun[]>(`/api/cycles/${cycleId}/ci-runs`);
  const [ref, setRef] = useState('');
  const [vars, setVars] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // laufende Pipelines alle 15 Sekunden automatisch aktualisieren, solange der Dialog offen ist
  const active = (runs.data ?? []).some((r) => ['created', 'waiting_for_resource', 'preparing', 'pending', 'running'].includes(r.status));
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  useEffect(() => { if (runs.data) setCheckedAt(new Date()); }, [runs.data]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => runs.reload(), 15_000);
    return () => clearInterval(t);
  }, [active, runs.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const lines = vars.split('\n').map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}=/.test(l));
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const variables = Object.fromEntries(lines.map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1)]; }));
      const r = await api<CiRun>('POST', `/api/cycles/${cycleId}/ci-runs`, { ...(ref.trim() ? { ref: ref.trim() } : {}), ...(lines.length ? { variables } : {}) });
      toast(`Pipeline #${r.externalId} gestartet (${r.ref})`);
      runs.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal size="large" title="CI-Pipeline starten" help="ci" onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Schließen</button>
        {canEdit && <button className="primary" disabled={!available || busy || bad.length > 0} title={available ? undefined : reason ?? undefined} onClick={start}>{busy ? 'Startet …' : '▶ Pipeline starten'}</button>}</>}>
      <ErrorNote error={error} />
      {!available && <div className="notice warn small">CI-Start nicht möglich: {reason ?? 'GitLab ist für dieses Projekt nicht eingerichtet'}.</div>}
      {canEdit && <>
        <div className="grid2">
          <label className="field">Zweig/Tag{refs.length > 1
            ? <select value={ref} onChange={(e) => setRef(e.target.value)} disabled={!available}>
                <option value="">Standard ({refs[0]})</option>{refs.slice(1).map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            : <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={refs[0] ? `Standard: ${refs[0]}` : 'Standard des Projekts'} disabled={!available} />}
            <span className="small muted">Erlaubt sind nur der CI-Zweig des Projekts und die in der GitLab-Zuordnung freigegebenen Zweige.</span></label>
          <label className="field">Variablen (je Zeile SCHLÜSSEL=Wert)
            <textarea rows={3} value={vars} onChange={(e) => setVars(e.target.value)} placeholder={'TEST_BROWSER=chromium\nTEST_SUITE=smoke'} disabled={!available} aria-invalid={bad.length > 0} />
          </label>
        </div>
        {bad.length > 0 && <div className="small err">Ungültige Zeile: {bad[0]} – erwartet SCHLÜSSEL=Wert (Buchstaben, Ziffern, _).</div>}
        <div className="small muted">Die Pipeline erhält ANEMO_URL, ANEMO_PROJECT, ANEMO_CYCLE_ID, ANEMO_CYCLE_NAME und ggf. ANEMO_BUILD und meldet
          Ergebnisse über automation-results zurück (Token: Kontomenü oben rechts → API-Tokens, in GitLab als CI-Variable ANEMO_TOKEN hinterlegen). Eigene Variablen brauchen das Präfix TEST_ oder müssen in der GitLab-Zuordnung freigegeben sein (Administration → GitLab); ANEMO_ ist reserviert.
          Ohne eingestellte öffentliche Adresse (ANEMO_PUBLIC_URL) startet Anemo keine Pipeline.</div>
        {lines.some((l) => !/^TEST_/.test(l)) && bad.length === 0 && <div className="small muted">Hinweis: Variablen ohne TEST_-Präfix gehen nur, wenn sie freigegeben sind – sonst lehnt der Server den Start ab.</div>}
      </>}
      <h4>Letzte Läufe</h4>
      {runs.error ? <ErrorNote error={runs.error} /> : !runs.data ? <div className="small muted">Lädt …</div> : runs.data.length === 0 ? <div className="small muted">Noch keine Läufe für diesen Zyklus.</div> : (
        <div className="table-wrap"><table>
          <thead><tr><th className="fit">Pipeline</th><th>Branch/Tag</th><th className="fit">Status</th><th className="fit">gestartet</th></tr></thead>
          <tbody>{runs.data.map((r) => (
            <tr key={r.id}>
              <td className="fit mono small">{r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener">#{r.externalId}</a> : `#${r.externalId}`}</td>
              <td className="small">{r.ref}</td><td className="fit"><CiStatusBadge status={r.status} /></td>
              <td className="fit small">{fmtDate(r.createdAt)}<div className="muted">{r.triggeredBy}</div></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {runs.data && runs.data.length > 0 && <div className="row small">
        <button className="small" onClick={() => runs.reload()} disabled={runs.loading}><span aria-hidden="true">↻ </span>{runs.loading ? 'Aktualisiert …' : 'Status aktualisieren'}</button>
        <span className="muted" role="status">{active ? 'Laufende Pipelines werden alle 15 Sekunden aktualisiert' : ''}{checkedAt ? `${active ? ' · ' : ''}Stand ${checkedAt.toLocaleTimeString('de-DE')}` : ''}</span>
      </div>}
    </Modal>
  );
}
