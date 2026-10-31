import { useState } from 'react';
import { fmtDate, useApi } from '../api.ts';
import { ErrorNote, Modal, Wiki } from './common.tsx';

/** Stufe J3: letzte Änderung je Schrittzelle (aus den Versionen abgeleitet). */
export type CellField = 'action' | 'data' | 'expected' | 'title';
export interface CellInfo { versionNo: number; by: string; at: string; changes: number }
export interface CellSummary { versionNo: number; cells: Record<string, Partial<Record<CellField, CellInfo>>> }

export const FIELD_LABEL: Record<CellField, string> = { action: 'Aktion', data: 'Testdaten', expected: 'Erwartetes Ergebnis', title: 'Abschnittsname' };

export const cellText = (i: CellInfo) => `zuletzt geändert ${fmtDate(i.at)} von ${i.by} (v${i.versionNo})${i.changes > 1 ? ` · ${i.changes} Fassungen` : ''}`;

/** Kleine Markierung in der Zelle: Tooltip (Maus und Tastatur), Klick öffnet den Verlauf der Zelle. */
export function CellMeta({ info, label, onOpen }: { info: CellInfo | undefined; label: string; onOpen: () => void }) {
  if (!info) return null;
  return (
    <button type="button" className="cell-meta" onClick={(e) => { e.stopPropagation(); onOpen(); }} title={`${cellText(info)} – Verlauf anzeigen`}
      aria-label={`${label}: ${cellText(info)}. Verlauf anzeigen`}>
      <span aria-hidden="true">🕘</span><span className="cell-meta-text">v{info.versionNo} · {info.by}</span>
    </button>
  );
}

/** Verlauf einer Zelle: alle Fassungen mit Person und Zeit, neueste zuerst. */
export function CellHistoryDialog({ testCaseId, stepId, field, upTo, title, onClose }: {
  testCaseId: string; stepId: string; field: CellField; upTo?: number | null; title: string; onClose: () => void;
}) {
  const h = useApi<{ versionNo: number; by: string; at: string; value: string }[]>(`/api/test-cases/${testCaseId}/cells/${encodeURIComponent(stepId)}/${field}${upTo ? `?version=${upTo}` : ''}`);
  return (
    <Modal title={title} help="versions" onClose={onClose}>
      <ErrorNote error={h.error} />
      {!h.data && !h.error && <div className="muted small" role="status">Lädt …</div>}
      {h.data?.length === 0 && <p className="muted">Keine Änderungen.</p>}
      <ol className="cell-history">
        {h.data?.map((x, i) => (
          <li key={x.versionNo}>
            <div className="small"><b>v{x.versionNo}</b> · {fmtDate(x.at)} · {x.by}{i === 0 && <span className="badge neutral" style={{ marginLeft: 6 }}>aktuell</span>}</div>
            <div className={i === 0 ? 'diff-new prose' : 'prose'}>{x.value ? <Wiki text={x.value} compact /> : <span className="muted">(leer)</span>}</div>
          </li>
        ))}
      </ol>
    </Modal>
  );
}

/** Zustand für die Schritttabelle: Zusammenfassung, Hervorhebung „seit vN“ und geöffneter Verlauf. */
export function useCellHistory(testCaseId: string | undefined, versionNo: number | null | undefined) {
  const summary = useApi<CellSummary>(testCaseId && versionNo ? `/api/test-cases/${testCaseId}/cells?version=${versionNo}` : null);
  const [since, setSince] = useState<number | null>(null);
  const [open, setOpen] = useState<{ stepId: string; field: CellField; title: string } | null>(null);
  return { summary: summary.data, since, setSince, open, setOpen, testCaseId, versionNo };
}
export type CellHistoryState = ReturnType<typeof useCellHistory>;
