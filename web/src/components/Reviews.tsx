import { useState } from 'react';
import { api, fmtDate, useApi } from '../api.ts';
import { href } from '../router.ts';
import { useCan } from '../session.tsx';
import type { ExecutionStatus } from '../types.ts';
import { ErrorNote, StatusBadge, Wiki } from './common.tsx';
import { askText, toast } from '../ux.tsx';

interface Item { id: string; cycleId: string; cycleName: string; key: string; title: string; status: string; executedBy: string | null; executedAt: string | null; reviewState: 'pending' | 'escalated'; comment: string | null; evidence: number }

/** KI-Ergebnisprüfung: Ergebnisse von KI-Agenten prüfen, Eskalationen übernehmen (ADR-0024). */
export function ReviewQueue({ projectKey, statuses }: { projectKey: string; statuses: ExecutionStatus[] }) {
  const q = useApi<Item[]>(`/api/projects/${projectKey}/reviews`);
  const canExecute = useCan(projectKey, 'execute');
  const [error, setError] = useState<unknown>(null);
  async function decide(i: Item, decision: 'approve' | 'reject') {
    const note = decision === 'reject' ? await askText({ title: `Ergebnis ${i.key} ablehnen`, label: 'Begründung (geht in den Kommentar)', multiline: true, confirmLabel: 'Ablehnen' }) : null;
    if (decision === 'reject' && note === null) return;
    try {
      await api('POST', `/api/executions/${i.id}/review`, { decision, note });
      toast(decision === 'approve' ? `${i.key}: Ergebnis bestätigt` : `${i.key}: Ergebnis abgelehnt – Test zurückgesetzt`);
      q.reload();
    } catch (e) {
      setError(e);
    }
  }
  const pending = q.data?.filter((i) => i.reviewState === 'pending') ?? [];
  const escalated = q.data?.filter((i) => i.reviewState === 'escalated') ?? [];
  const row = (i: Item) => (
    <div key={i.id} className="card"><div className="card-body stack" style={{ gap: 6 }}>
      <div className="row">
        <a className="mono small" href={href(['p', projectKey, 'cycles', i.cycleId], { exec: i.id })}>{i.key}</a><strong>{i.title}</strong>
        <StatusBadge code={i.status} statuses={statuses} /><span className="small muted">{i.cycleName} · {i.executedBy ?? '–'} · {fmtDate(i.executedAt)}</span>{i.evidence ? <span className="small muted" title={`${i.evidence} Evidenzen`}><span aria-hidden="true">📎 </span>{i.evidence}<span className="sr-only"> Evidenzen</span></span> : null}
        <span className="spacer" />
        {canExecute && i.reviewState === 'pending' && <>
          <button className="small" onClick={() => decide(i, 'reject')} aria-label={`Ergebnis ${i.key} ablehnen`}>Ablehnen …</button>
          <button className="small primary" onClick={() => decide(i, 'approve')} aria-label={`Ergebnis ${i.key} bestätigen`}>Ergebnis bestätigen</button>
        </>}
        {i.reviewState === 'escalated' && <a className="btn small" href={href(['p', projectKey, 'cycles', i.cycleId], { exec: i.id })}>Übernehmen und ausführen</a>}
      </div>
      {i.comment && <div className="small"><Wiki text={i.comment} compact /></div>}
    </div></div>
  );
  return (
    <div className="stack">
      <h2><span aria-hidden="true">🤖 </span>KI-Ergebnisprüfung</h2>
      <p className="small muted">Ergebnisse von KI-Agenten zählen erst nach der KI-Ergebnisprüfung durch QA als belastbar (Abschlussbericht und Cockpit weisen offene Prüfungen aus).
        Nicht zu verwechseln mit der Testfall-Freigabe (Vier-Augen-Prüfung) und der Freigabeentscheidung zum Release.
        Ablehnen setzt den Test zurück. Eskalierte Fälle hat ein Agent an Menschen übergeben.</p>
      <ErrorNote error={error ?? q.error} />
      {!q.data && !q.error && <div className="small muted">Lädt …</div>}
      <h3>Prüfung ausstehend ({pending.length})</h3>
      {pending.length === 0 && <div className="small muted">Nichts zu prüfen.</div>}
      {pending.map(row)}
      <h3>Eskaliert ({escalated.length})</h3>
      {escalated.length === 0 && <div className="small muted">Keine eskalierten Fälle.</div>}
      {escalated.map(row)}
    </div>
  );
}
