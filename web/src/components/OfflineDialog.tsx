import { useState } from 'react';
import { api } from '../api.ts';
import { currentUser } from '../session.tsx';
import type { OfflineResult } from '../types.ts';
import { askConfirm, notifyChanged, toast } from '../ux.tsx';
import { plural } from '../text.ts';
import { ErrorNote, Modal } from './common.tsx';

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

const ACTION: Record<OfflineResult['items'][number]['action'], [string, string]> = {
  updated: ['übernommen', 'ok'], unchanged: ['unverändert', 'neutral'], conflict: ['Konflikt', 'warn'], error: ['Fehler', 'bad'],
};

/**
 * Excel-Rundlauf: Ausführungen als Arbeitsmappe ausgeben, ohne Anemo ausfüllen (z. B. in einer abgeschotteten Umgebung)
 * und wieder einlesen – erst als Probelauf, dann übernehmen. Seit der Ausgabe in Anemo geänderte Ausführungen sind Konflikte.
 */
export function OfflineDialog({ cycleId, canExecute, onClose, onDone }: { cycleId: string; canExecute: boolean; onClose: () => void; onDone: () => void }) {
  const [mine, setMine] = useState(false);
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<OfflineResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Konflikte aus dem Probelauf ohne Überschreiben – für die Rückfrage beim Übernehmen mit Überschreiben
  const [conflictKeys, setConflictKeys] = useState<string[]>([]);
  const q = new URLSearchParams();
  if (mine) q.set('assignee', currentUser());
  if (onlyOpen) q.set('onlyOpen', 'true');
  const download = `/api/cycles/${cycleId}/offline${q.toString() ? `?${q}` : ''}`;

  const run = async (data: string, dryRun: boolean, f = force) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<OfflineResult>('POST', `/api/cycles/${cycleId}/offline`, { contentBase64: data, dryRun, ...(f ? { force: true } : {}) });
      setResult(r);
      if (dryRun && !f) setConflictKeys(r.items.filter((i) => i.action === 'conflict').map((i) => i.key));
      if (!dryRun) {
        toast(`Excel-Rundlauf: ${r.updated} übernommen${r.conflicts ? `, ${r.conflicts} Konflikte` : ''}${r.errors ? `, ${r.errors} Fehler` : ''}`, r.errors || r.conflicts ? 'info' : 'ok');
        notifyChanged('execution');
        onDone();
      }
    } catch (e) {
      setError(e);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    try {
      const data = await toBase64(f);
      setFile({ name: f.name, data });
      await run(data, true);
    } catch (e) { setError(e); }
  };
  const applied = result && !result.dryRun;
  const apply = async () => {
    if (!file) return;
    if (force && !(await askConfirm({ title: 'Geänderte Ergebnisse überschreiben?', danger: true, confirmLabel: 'Überschreiben und übernehmen',
      message: <>Mit „auch seit der Ausgabe geänderte überschreiben“ ersetzt die Arbeitsmappe Ergebnisse, die inzwischen in Anemo erfasst wurden
        {conflictKeys.length ? <> – laut Probelauf {plural(conflictKeys.length, 'Ausführung', 'Ausführungen')}: {conflictKeys.slice(0, 8).join(', ')}{conflictKeys.length > 8 ? ' …' : ''}</> : ''}.
        Die bisherigen Ergebnisse bleiben nur im Ergebnisverlauf sichtbar.</> }))) return;
    await run(file.data, false);
  };
  const items = result?.items ?? [];
  const shown = items.filter((i) => i.action !== 'unchanged');

  return (
    <Modal size="large" title="Excel-Rundlauf" help="excel-roundtrip" onClose={onClose}
      footer={<><span className="spacer" />
        <button onClick={onClose}>{applied ? 'Schließen' : 'Abbrechen'}</button>
        {canExecute && !applied && <button className="primary" disabled={!file || !result || busy || result.updated === 0}
          onClick={() => void apply()} title={!file ? 'Erst die ausgefüllte Arbeitsmappe einlesen' : result && result.updated === 0 ? 'Nichts zu übernehmen' : 'Ergebnisse aus der Arbeitsmappe speichern'}>{busy && file ? 'Übernimmt …' : 'Übernehmen'}</button>}</>}>
      <p className="small muted" style={{ marginTop: 0 }}>Für Umgebungen ohne Zugriff auf Anemo: Arbeitsmappe ausgeben, dort „Neuer Status“, Kommentar, Fehler und
        Schrittbefunde eintragen, danach hier einlesen. Jede Zeile wird einzeln geprüft; wurde eine Ausführung seit der Ausgabe in Anemo geändert,
        meldet der Probelauf einen Konflikt und überschreibt nichts. Parametrisierte Tests haben ein eigenes Blatt „Durchläufe“ – dort das
        Ergebnis je Datenzeile eintragen; das Gesamtergebnis ergibt sich daraus.</p>

      <section className="stack offline-section">
        <h4>1. Ausgeben</h4>
        <div className="row small">
          <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={mine} onChange={(e) => setMine(e.target.checked)} /> nur mir zugewiesene</label>
          <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> nur offene</label>
          <span className="spacer" />
          <a className="btn small" href={download} download>⇩ Arbeitsmappe herunterladen</a>
        </div>
      </section>

      {canExecute ? <section className="stack offline-section">
        <h4>2. Einlesen</h4>
        <label className="dropzone" style={{ minHeight: 90 }}>
          <input type="file" accept=".xlsx" aria-label="Ausgefüllte Arbeitsmappe" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void pick(f); }} />
          <span><span aria-hidden="true">📄 </span>{file ? `${file.name} – andere Datei wählen` : 'Ausgefüllte Arbeitsmappe (.xlsx) wählen oder hierher ziehen'}</span>
        </label>
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={force} disabled={!!applied}
          onChange={(e) => { setForce(e.target.checked); if (file) void run(file.data, true, e.target.checked); }} />
          auch seit der Ausgabe geänderte überschreiben (Konflikte übernehmen)</label>
        <ErrorNote error={error} />
        {busy && <div className="small muted" role="status">{result ? 'Übernimmt …' : 'Probelauf läuft …'}</div>}
        {result && <>
          <div className={`notice ${result.errors ? 'bad' : result.conflicts ? 'warn' : result.dryRun ? 'info' : 'ok'}`} data-testid="offline-summary">
            <strong>{result.dryRun ? 'Probelauf' : 'Übernommen'}:</strong> {result.updated} übernommen · {result.unchanged} unverändert · {result.conflicts} {result.conflicts === 1 ? 'Konflikt' : 'Konflikte'} · {result.errors} Fehler
            {result.dryRun && <span className="muted"> – noch nichts gespeichert</span>}
          </div>
          {shown.length > 0 ? <div className="table-wrap" style={{ maxHeight: 320 }}><table>
            <thead><tr><th className="fit">Schlüssel</th><th className="fit">Aktion</th><th className="fit">Status</th><th>Meldung</th></tr></thead>
            <tbody>{shown.map((i, k) => (
              <tr key={`${i.key}-${k}`}><td className="fit mono small">{i.key}</td>
                <td className="fit"><span className={`badge ${ACTION[i.action][1]}`}>{ACTION[i.action][0]}</span></td>
                <td className="fit small">{i.status ?? '–'}</td><td className="small">{i.message ?? ''}</td></tr>
            ))}</tbody>
          </table></div> : <div className="small muted">Keine Änderungen in der Arbeitsmappe gefunden.</div>}
        </>}
      </section> : <div className="small muted">Einlesen erfordert die Rolle „Ausführen“.</div>}
    </Modal>
  );
}
