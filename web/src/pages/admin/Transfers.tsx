import { useEffect, useState } from 'react';
import { api, useApi } from '../../api.ts';
import { ErrorNote } from '../../components/common.tsx';
import { href } from '../../router.ts';
import { askText, toast } from '../../ux.tsx';
import { type Transfer, TransferTable } from '../Transfer.tsx';

/** Administration: Freigabe von Exporten sensibler Projekte und Protokoll aller Übertragungen (ADR-0027). */
export function TransfersAdmin() {
  const [filter, setFilter] = useState<'pending' | ''>('pending');
  const rows = useApi<Transfer[]>(`/api/admin/project-transfers?limit=200${filter ? `&status=${filter}` : ''}`);
  const running = rows.data?.some((t) => t.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(rows.reload, 2000);
    return () => clearInterval(timer);
  }, [running, rows.reload]);

  const decide = async (t: Transfer, approve: boolean) => {
    const note = await askText({
      title: approve ? `Export ${t.projectKey} freigeben` : `Export ${t.projectKey} ablehnen`,
      label: approve ? 'Bemerkung (optional)' : 'Begründung', required: !approve, multiline: true,
      hint: `Angefordert von ${t.requestedBy}${t.options?.note ? `: „${t.options.note}“` : ''}. Nach der Freigabe kann ${t.requestedBy} das Paket 24 Stunden lang abrufen.`,
      confirmLabel: approve ? 'Freigeben' : 'Ablehnen',
    });
    if (note === null) return;
    try {
      await api('POST', `/api/admin/project-transfers/${t.id}/decision`, { approve, ...(note.trim() ? { note } : {}) });
      toast(approve ? `Export ${t.projectKey} freigegeben` : `Export ${t.projectKey} abgelehnt`);
      rows.reload();
    } catch (e) { toast((e as Error).message, 'bad'); }
  };

  return (
    <div className="stack">
      <div className="row wrap"><h2 style={{ flex: 1 }}>Projektübertragungen</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value as 'pending' | '')} aria-label="Filter" style={{ width: 'auto' }}>
          <option value="pending">offene Freigaben</option><option value="">alle Vorgänge</option></select>
        <a className="btn" href={href(['transfer'])}>Selbst exportieren oder importieren …</a></div>
      <p className="small muted">Exporte aus eingeschränkten Projekten bzw. Projekten mit gesperrten externen Diensten brauchen eine Freigabe. Wer exportieren und
        importieren darf, steht unter Benutzer bzw. Gruppen (Recht „Projekte übertragen“). Jeder Vorgang bleibt hier mit Prüfsumme und Größe des Pakets nachvollziehbar.</p>
      <ErrorNote error={rows.error} />
      <TransferTable rows={rows.data ?? []} onChanged={rows.reload} onDecide={decide} />
    </div>
  );
}
