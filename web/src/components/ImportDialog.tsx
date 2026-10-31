import { useState } from 'react';
import { api } from '../api.ts';
import { notifyChanged, toast } from '../ux.tsx';
import { ErrorNote, Modal } from './common.tsx';

interface Preview { sheets: string[]; header: string[]; mapping: Record<string, string>; rowCount: number; sample: string[][]; targets: { id: string; label: string }[] }
interface Result {
  dryRun: boolean; created: number; updated: number; unchanged: number; failed: number;
  items: { row: number; key: string | null; title: string; action: 'created' | 'updated' | 'unchanged' | 'failed'; message?: string }[];
}
const ACTION: Record<Result['items'][number]['action'], [string, string]> = {
  created: ['neu', 'ok'], updated: ['aktualisiert', 'accent'], unchanged: ['unverändert', 'neutral'], failed: ['Fehler', 'bad'],
};

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

/**
 * Testfälle aus Excel/CSV: Datei wählen → Spalten zuordnen (aus Zephyr/Xray erkannt) → Probelauf → Import.
 * Je Schritt eine Zeile; eine Zeile mit Titel bzw. neuem Schlüssel beginnt einen neuen Testfall.
 */
export function ImportDialog({ projectKey, folderId, folderName, onClose, onDone }: {
  projectKey: string; folderId: string | null; folderName: string | null; onClose: () => void; onDone: () => void;
}) {
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [sheet, setSheet] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<'upsert' | 'create'>('upsert');
  const [intoFolder, setIntoFolder] = useState(!!folderId);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = async (f: File, sheetNo = 0) => {
    setError(null); setResult(null); setBusy(true);
    try {
      const b64 = await toBase64(f);
      const p = await api<Preview>('POST', `/api/projects/${projectKey}/test-cases/import/preview`, { fileName: f.name, contentBase64: b64, sheet: sheetNo });
      setFile({ name: f.name, b64 });
      setPreview(p);
      setMapping(p.mapping);
      setSheet(sheetNo);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const reloadSheet = async (no: number) => {
    if (!file) return;
    setBusy(true);
    try {
      const p = await api<Preview>('POST', `/api/projects/${projectKey}/test-cases/import/preview`, { fileName: file.name, contentBase64: file.b64, sheet: no });
      setPreview(p); setMapping(p.mapping); setSheet(no); setResult(null);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const r = await api<Result>('POST', `/api/projects/${projectKey}/test-cases/import`, {
        fileName: file.name, contentBase64: file.b64, sheet, mapping, mode, dryRun, folderId: intoFolder ? folderId : null,
      });
      setResult(r);
      if (!dryRun) {
        toast(`Import: ${r.created} neu, ${r.updated} aktualisiert${r.failed ? `, ${r.failed} mit Fehler` : ''}`, r.failed ? 'info' : 'ok');
        notifyChanged('testcase');
        onDone();
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const mapped = new Set(Object.values(mapping).filter((t) => t && t !== 'ignore'));
  const hasTitle = mapped.has('title') || (mode === 'upsert' && mapped.has('key'));

  return (
    <Modal size="large" title="Testfälle importieren (Excel/CSV)" onClose={onClose}
      footer={<>
        {result && !result.dryRun ? <><span className="spacer" /><button className="primary" onClick={onClose}>Fertig</button></> : <>
          <span className="small muted">{preview ? `${preview.rowCount} Zeilen` : ''}</span><span className="spacer" />
          <button onClick={onClose}>Abbrechen</button>
          <button disabled={!preview || busy || !hasTitle} onClick={() => run(true)} title="Prüft alles, speichert nichts">Probelauf</button>
          <button className="primary" disabled={!preview || busy || !hasTitle} onClick={() => run(false)}>{busy ? 'Läuft …' : 'Importieren'}</button>
        </>}
      </>}>
      <ErrorNote error={error} />
      {!preview && <div className="stack">
        <p className="small muted">Unterstützt: <b>.xlsx</b> und <b>.csv</b> (Semikolon, Komma oder Tab; UTF-8 oder Windows-1252). Je Schritt eine Zeile –
          eine Zeile mit Titel bzw. neuem Schlüssel beginnt einen neuen Testfall. Spalten aus Zephyr- und Xray-Exporten sowie aus dem Anemo-Export werden erkannt.
          Tipp: Erst exportieren, in Excel bearbeiten, wieder importieren.</p>
        <label className="dropzone">
          <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); }} />
          <span>{busy ? 'Datei wird gelesen …' : <><span aria-hidden="true">📄 </span>Datei wählen oder hierher ziehen</>}</span>
        </label>
      </div>}
      {preview && file && <div className="stack">
        <div className="row small"><b>{file.name}</b>
          {preview.sheets.length > 1 && <label className="row">Tabellenblatt
            <select value={sheet} onChange={(e) => void reloadSheet(Number(e.target.value))} style={{ width: 'auto' }} aria-label="Tabellenblatt">{preview.sheets.map((s, i) => <option key={s} value={i}>{s}</option>)}</select></label>}
          <button className="small ghost" onClick={() => { setPreview(null); setFile(null); setResult(null); }}>andere Datei</button></div>
        <div className="grid2">
          <fieldset className="field multi"><legend>Vorgehen</legend>
            <label className="row small"><input type="radio" name="import-mode" value="upsert" style={{ width: 'auto' }} checked={mode === 'upsert'} onChange={() => setMode('upsert')} /> Vorhandene per Schlüssel aktualisieren, übrige neu anlegen</label>
            <label className="row small"><input type="radio" name="import-mode" value="create" style={{ width: 'auto' }} checked={mode === 'create'} onChange={() => setMode('create')} /> Alle als neue Testfälle anlegen</label>
          </fieldset>
          <fieldset className="field multi"><legend>Ablage</legend>
            <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={intoFolder} disabled={!folderId} onChange={(e) => setIntoFolder(e.target.checked)} />
              {folderId ? <>In Ordner „{folderName}“ (Spalte „Ordner“ legt Unterordner an)</> : 'Ordner links wählen, um dort abzulegen'}</label>
          </fieldset>
        </div>
        <div className="table-wrap" style={{ maxHeight: 340 }}><table className="import-map">
          <thead><tr><th>Spalte in der Datei</th><th>übernehmen als</th><th>Beispielwerte</th></tr></thead>
          <tbody>{preview.header.map((h, i) => (
            <tr key={i}>
              <td><b>{h || `Spalte ${i + 1}`}</b></td>
              <td><select value={mapping[i] ?? 'ignore'} onChange={(e) => setMapping({ ...mapping, [i]: e.target.value })} aria-label={`Zuordnung ${h || i + 1}`}>
                {preview.targets.map((t) => <option key={t.id} value={t.id} disabled={t.id !== 'ignore' && !t.id.startsWith('step.') && mapped.has(t.id) && mapping[i] !== t.id}>{t.label}</option>)}
              </select></td>
              <td className="small muted">{preview.sample.map((r) => r[i]).filter(Boolean).slice(0, 3).map((v) => v!.slice(0, 40)).join(' · ')}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {!hasTitle && <div className="notice warn small">Bitte eine Spalte als „Titel“ zuordnen (oder „Schlüssel“, um nur zu aktualisieren).</div>}
        <p className="small muted">Beim Aktualisieren ändern nur zugeordnete, nicht leere Zellen den Testfall; Schritte werden ersetzt, wenn die Datei Schrittzeilen enthält.
          Jede Änderung ergibt eine neue Version mit Änderungsnotiz „Import aus …“; Schritt-IDs bleiben erhalten, damit Ergebnisse zuordenbar bleiben.</p>
      </div>}
      {result && <div className="stack">
        <div className={`notice ${result.failed ? 'warn' : 'ok'}`}>
          {result.dryRun ? 'Probelauf – nichts gespeichert: ' : 'Import abgeschlossen: '}
          <b>{result.created}</b> neu, <b>{result.updated}</b> aktualisiert, {result.unchanged} unverändert{result.failed ? <>, <b>{result.failed}</b> mit Fehler</> : ''}.
        </div>
        <div className="table-wrap" style={{ maxHeight: 280 }}><table>
          <thead><tr><th className="fit">Zeile</th><th className="fit">Schlüssel</th><th>Titel</th><th className="fit">Ergebnis</th></tr></thead>
          <tbody>{[...result.items].sort((a, b) => (a.action === 'failed' ? -1 : 0) - (b.action === 'failed' ? -1 : 0) || a.row - b.row).map((it) => (
            <tr key={`${it.row}-${it.key}`}><td className="fit small">{it.row}</td><td className="fit mono small">{it.key ?? '–'}</td>
              <td>{it.title}{it.message && <div className="small err">{it.message}</div>}</td>
              <td className="fit"><span className={`badge ${ACTION[it.action][1]}`}>{ACTION[it.action][0]}</span></td></tr>
          ))}</tbody>
        </table></div>
      </div>}
    </Modal>
  );
}
