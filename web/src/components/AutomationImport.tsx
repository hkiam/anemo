import { useState } from 'react';
import { api, useApi } from '../api.ts';
import type { TestCaseListItem } from '../types.ts';
import { notifyChanged, toast } from '../ux.tsx';
import { ErrorNote, Modal } from './common.tsx';

interface ImportResult {
  cycleId: string; formatLabel: string; total: number; mapped: number; testCases: number; results: Record<string, number>;
  unmapped: { id: string; name: string; suite: string; status: string }[];
  defects: { created: string[]; reused: string[]; skipped: number; reason: string | null };
}
const FORMATS = 'JUnit, Cucumber, Behave, TestNG, NUnit, xUnit.net, MSTest (TRX), Robot Framework, Playwright, Jest';

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

/**
 * Ergebnisse automatisierter Tests aus einer Datei übernehmen (Format wird erkannt). Nicht erkannte Ergebnisse
 * lassen sich einmalig einem Testfall zuordnen – ab dem nächsten Import gilt die Zuordnung.
 */
export function AutomationImportDialog({ projectKey, cycleId, planId, onClose, onDone }: {
  projectKey: string; cycleId?: string | undefined; planId?: string | null | undefined; onClose: () => void; onDone: (cycleId: string) => void;
}) {
  const status = useApi<{ available: boolean; reason: string | null }>(`/api/projects/${projectKey}/integrations/openproject/status`);
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState<'this' | 'new'>(cycleId ? 'this' : 'new');
  const [cycleName, setCycleName] = useState(`Automatisiert ${new Date().toISOString().slice(0, 10)}`);
  const [build, setBuild] = useState('');
  const [createDefects, setCreateDefects] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async () => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const r = await api<ImportResult>('POST', `/api/projects/${projectKey}/automation-import`, {
        fileName: file.name, contentBase64: await toBase64(file), createDefects,
        ...(target === 'this' && cycleId ? { cycleId } : { cycleName, ...(build ? { build } : {}), ...(planId ? { planId } : {}) }),
      });
      setResult(r);
      toast(`${r.formatLabel}: ${r.mapped} von ${r.total} Ergebnissen übernommen`);
      notifyChanged('execution');
      notifyChanged('cycle', r.cycleId);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal size="large" title="Ergebnisse automatisierter Tests übernehmen" onClose={onClose}
      footer={result
        ? <><span className="spacer" /><button className="primary" onClick={() => onDone(result.cycleId)}>Zum Zyklus</button></>
        : <><span className="spacer" /><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!file || busy} onClick={run}>{busy ? 'Übernimmt …' : 'Übernehmen'}</button></>}>
      <ErrorNote error={error} />
      {!result && <div className="stack">
        <p className="small muted">Unterstützt: {FORMATS}. Testfälle werden über einen gespeicherten Automatisierungsverweis, einen Testfallschlüssel
          (z. B. <span className="mono">DEMO-T12</span>) im Namen, Tag oder in der Kategorie bzw. den Jira-Altschlüssel zugeordnet. Für die Pipeline gibt es
          denselben Import per API (Administration → Anbindungen → CI &amp; KI-Agenten).</p>
        <label className="dropzone">
          <input type="file" accept=".xml,.json,.trx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Ergebnisdatei" />
          <span>{file ? `📄 ${file.name}` : '📄 Ergebnisdatei wählen oder hierher ziehen'}</span>
        </label>
        <fieldset className="field multi"><legend>Ziel</legend>
          {cycleId && <label className="row small"><input type="radio" style={{ width: 'auto' }} checked={target === 'this'} onChange={() => setTarget('this')} /> in diesen Zyklus</label>}
          <label className="row small"><input type="radio" style={{ width: 'auto' }} checked={target === 'new'} onChange={() => setTarget('new')} /> neuer bzw. gleichnamiger Zyklus</label>
          {target === 'new' && <div className="grid2">
            <label className="field">Zyklusname<input value={cycleName} onChange={(e) => setCycleName(e.target.value)} /></label>
            <label className="field">Build<input value={build} onChange={(e) => setBuild(e.target.value)} placeholder="optional" /></label>
          </div>}
        </fieldset>
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={createDefects} onChange={(e) => setCreateDefects(e.target.checked)} disabled={!status.data?.available} />
          Für fehlgeschlagene Tests Fehler anlegen (OpenProject bzw. Jira je nach Projektzuordnung; ein offener Fehler des Testfalls wird wiederverwendet, höchstens 20 neue je Import)
          {status.data && !status.data.available && <span className="muted"> – {status.data.reason}</span>}</label>
      </div>}
      {result && <ResultView projectKey={projectKey} r={result} />}
    </Modal>
  );
}

function ResultView({ projectKey, r }: { projectKey: string; r: ImportResult }) {
  const [assigned, setAssigned] = useState<Record<string, string>>({});
  return (
    <div className="stack">
      <div className={`notice ${r.unmapped.length ? 'warn' : 'ok'}`}>{r.formatLabel}: <b>{r.mapped}</b> von {r.total} Ergebnissen übernommen, {r.testCases} Testfälle
        ({Object.entries(r.results).map(([k, n]) => `${k}: ${n}`).join(', ') || '–'}).</div>
      {(r.defects.created.length > 0 || r.defects.reused.length > 0) && <div className="notice info small">Fehler: {r.defects.created.length} neu angelegt
        {r.defects.created.length ? ` (${r.defects.created.join(', ')})` : ''}, {r.defects.reused.length} vorhandene verknüpft{r.defects.skipped ? `, ${r.defects.skipped} übersprungen` : ''}.</div>}
      {r.defects.reason && <div className="notice warn small">Fehleranlage: {r.defects.reason}</div>}
      {r.unmapped.length > 0 && <>
        <h4>Nicht zugeordnet ({r.unmapped.length})</h4>
        <p className="small muted">Einmal zuordnen – ab dem nächsten Import werden diese Ergebnisse automatisch übernommen.</p>
        <div className="table-wrap" style={{ maxHeight: 300 }}><table><tbody>
          {r.unmapped.slice(0, 200).map((u) => (
            <tr key={u.id}><td>{u.name}<div className="small muted">{u.suite}</div></td><td className="fit small">{u.status}</td>
              <td className="fit">{assigned[u.id] ? <span className="badge ok">→ {assigned[u.id]}</span>
                : <AssignTestCase projectKey={projectKey} onPick={async (t) => {
                  try { await api('POST', `/api/projects/${projectKey}/automation-mapping`, { resultId: u.id, name: u.name, testCaseId: t.id }); setAssigned((a) => ({ ...a, [u.id]: t.key })); }
                  catch (e) { toast((e as Error).message, 'bad'); }
                }} />}</td></tr>
          ))}
        </tbody></table></div>
      </>}
    </div>
  );
}

function AssignTestCase({ projectKey, onPick }: { projectKey: string; onPick: (t: TestCaseListItem) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const list = useApi<{ items: TestCaseListItem[] }>(open && q.length > 1 ? `/api/projects/${projectKey}/test-cases?limit=10&q=${encodeURIComponent(q)}` : null);
  return (
    <span className="aql-box" style={{ display: 'inline-block', minWidth: 220 }}>
      <input type="search" value={q} placeholder="Testfall zuordnen …" onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} aria-label="Testfall zuordnen" />
      {open && (list.data?.items.length ?? 0) > 0 && <ul className="aql-suggest">{list.data!.items.map((t) => (
        <li key={t.id} onMouseDown={(e) => { e.preventDefault(); onPick(t); setOpen(false); }}><span className="mono small">{t.key}</span> {t.title}</li>
      ))}</ul>}
    </span>
  );
}
