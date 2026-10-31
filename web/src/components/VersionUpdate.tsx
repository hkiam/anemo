import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { plural } from '../text.ts';
import { toast } from '../ux.tsx';
import { ErrorNote, Modal } from './common.tsx';

export interface VersionUpdatePlan {
  from: number; to: number; upToDate: boolean; canUpdate: boolean; reason: string | null;
  added: { no: number | null; text: string }[];
  changed: { no: number | null; text: string; hadResult: boolean }[];
  removed: { no: number | null; text: string; hadResult: boolean }[];
  moved: number;
  results: { kept: number; reset: number; dropped: number };
  preconditions: { key: string; from: number; to: number }[];
  datasetChanged: boolean;
}

const label = (x: { no: number | null; text: string }) => `${x.no ? `${x.no}. ` : ''}${x.text}`;

/** Stufe J2: Ausführung auf die aktuelle Testfallfassung umstellen – erst Vorschau, dann bestätigen. */
export function VersionUpdateDialog({ executionId, onClose, onDone }: { executionId: string; onClose: () => void; onDone: () => void }) {
  const p = useApi<VersionUpdatePlan>(`/api/executions/${executionId}/update-preview`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const d = p.data;
  const run = async () => {
    setBusy(true);
    try {
      await api('POST', `/api/executions/${executionId}/update-version`);
      toast(d ? `Auf v${d.to} umgestellt${d.results.reset ? ` – ${plural(d.results.reset, 'Schritt', 'Schritte')} wieder offen` : ''}` : 'Umgestellt');
      onDone();
      onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={d ? `Auf Fassung v${d.to} umstellen (bisher v${d.from})` : 'Auf aktuelle Fassung umstellen'} help="execute" onClose={onClose}
      footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!d?.canUpdate || d.upToDate || busy} onClick={() => void run()}
        title={d?.reason ?? undefined}>{busy ? 'Stellt um …' : 'Umstellen'}</button></>}>
      <ErrorNote error={error ?? p.error} />
      {!d && !p.error && <div className="muted small" role="status">Lädt …</div>}
      {d?.upToDate && <p>Die Ausführung nutzt bereits die aktuelle Fassung.</p>}
      {d && !d.upToDate && <div className="stack">
        {!d.canUpdate && <div className="notice warn">{d.reason}</div>}
        <p className="small">Unveränderte Schritte behalten ihr Ergebnis. Geänderte Schritte werden wieder <b>offen</b>; ihr bisheriges Ergebnis
          bleibt als „vor Umstellung“ sichtbar. Der bisherige Stand bleibt im Verlauf der Ergebnisse erhalten.</p>
        <table className="kv">
          <tbody>
            <tr><th>Ergebnisse</th><td>{d.results.kept} bleiben · <b>{d.results.reset} wieder offen</b> · {d.results.dropped} entfallen (Schritt entfernt)</td></tr>
            {d.preconditions.length > 0 && <tr><th>Vorbedingungen</th><td>{d.preconditions.map((x) => `${x.key} v${x.from || '–'} → v${x.to}`).join(', ')}</td></tr>}
            {d.datasetChanged && <tr><th>Datensatz</th><td className="bad-text">geändert – erfasste Durchläufe beginnen neu</td></tr>}
            {d.moved > 0 && <tr><th>Reihenfolge</th><td>{plural(d.moved, 'Schritt verschoben', 'Schritte verschoben')}</td></tr>}
          </tbody>
        </table>
        {d.changed.length > 0 && <details open><summary>Geändert ({d.changed.length})</summary><ul className="small">
          {d.changed.map((x, i) => <li key={i}>{label(x)}{x.hadResult && <span className="muted"> – Ergebnis wird zurückgesetzt</span>}</li>)}</ul></details>}
        {d.added.length > 0 && <details open><summary>Neu ({d.added.length})</summary><ul className="small">{d.added.map((x, i) => <li key={i}>{label(x)}</li>)}</ul></details>}
        {d.removed.length > 0 && <details open><summary>Entfernt ({d.removed.length})</summary><ul className="small">
          {d.removed.map((x, i) => <li key={i}>{label(x)}{x.hadResult && <span className="muted"> – Ergebnis nur noch im Verlauf</span>}</li>)}</ul></details>}
        {!d.changed.length && !d.added.length && !d.removed.length && <p className="small muted">Keine Änderungen an den Schritten.</p>}
      </div>}
    </Modal>
  );
}
