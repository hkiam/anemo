import { plural } from '../text.ts';
import { useMemo, useState } from 'react';
import type { Dataset } from '../types.ts';
import { allCombinations, type Exclusion, type Parameter, pairwise, uncoveredPairs } from '../../../shared/combinatorics/combinatorics.ts';
import { Modal } from './common.tsx';

/**
 * Datensatz eines parametrisierten Testfalls bearbeiten: Spalten (Parameter) und Zeilen (Durchläufe).
 * In Schritten werden Werte über ${spalte} eingesetzt; bei Gherkin genügen die „Beispiele“ des Szenariogrundrisses.
 */
export function DatasetEditor({ value, onChange }: { value: Dataset | null | undefined; onChange: (d: Dataset | null) => void }) {
  const d = value ?? null;
  if (!d) {
    return (
      <div className="row small">
        <button className="small" onClick={() => onChange({ columns: ['wert'], rows: [[''], ['']] })}>+ Datensatz</button>
        <CombinationsButton onApply={onChange} />
        <span className="muted">Ein Testfall, mehrere Durchläufe – z. B. je Benutzerrolle oder Dokumenttyp. In Schritten <span className="mono">{'${spalte}'}</span> verwenden.</span>
      </div>
    );
  }
  const setCol = (i: number, name: string) => onChange({ ...d, columns: d.columns.map((c, k) => (k === i ? name : c)) });
  const setCell = (r: number, c: number, v: string) => onChange({ ...d, rows: d.rows.map((row, k) => (k === r ? row.map((x, j) => (j === c ? v : x)) : row)) });
  const addCol = () => onChange({ columns: [...d.columns, `spalte${d.columns.length + 1}`], rows: d.rows.map((r) => [...r, '']) });
  const delCol = (i: number) => (d.columns.length === 1 ? onChange(null) : onChange({ columns: d.columns.filter((_, k) => k !== i), rows: d.rows.map((r) => r.filter((_, k) => k !== i)) }));
  const addRow = () => onChange({ ...d, rows: [...d.rows, d.columns.map(() => '')] });
  const delRow = (i: number) => onChange({ ...d, rows: d.rows.filter((_, k) => k !== i) });
  const paste = (text: string) => {
    // Tabelle aus Excel/Calc einfügen: Tabulatoren und Zeilen; erste Zeile = Spaltennamen
    const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
    if (lines.length < 2 || !lines[0]!.includes('\t')) return false;
    const [head, ...rows] = lines.map((l) => l.split('\t'));
    onChange({ columns: head!.map((h, i) => h.trim() || `spalte${i + 1}`), rows: rows.map((r) => head!.map((_, i) => r[i] ?? '')) });
    return true;
  };
  return (
    <div className="stack dataset-edit">
      <div className="table-wrap"><table className="steps">
        <thead><tr><th className="n">#</th>{d.columns.map((c, i) => (
          <th key={i}><span className="row" style={{ gap: 4 }}>
            <input value={c} aria-label={`Spaltenname ${i + 1}`} onChange={(e) => setCol(i, e.target.value.replace(/[^\p{L}\p{N}_ .-]/gu, ''))} style={{ fontWeight: 600 }} />
            <button className="ghost small danger" onClick={() => delCol(i)} title="Spalte entfernen" aria-label={`Spalte ${c} entfernen`}>✕</button>
          </span></th>))}
          <th style={{ width: 40 }}><button className="ghost small" onClick={addCol} title="Spalte hinzufügen" aria-label="Spalte hinzufügen">+</button></th></tr></thead>
        <tbody>{d.rows.map((r, ri) => (
          <tr key={ri}><td className="n">{ri + 1}</td>
            {r.map((v, ci) => <td key={ci}><input value={v} aria-label={`Zeile ${ri + 1}, ${d.columns[ci]}`} onChange={(e) => setCell(ri, ci, e.target.value)}
              onPaste={(e) => { if (ri === 0 && ci === 0 && paste(e.clipboardData.getData('text'))) e.preventDefault(); }} /></td>)}
            <td><button className="ghost small danger" onClick={() => delRow(ri)} title="Zeile entfernen" aria-label={`Zeile ${ri + 1} entfernen`}>✕</button></td></tr>
        ))}</tbody>
      </table></div>
      <div className="row small"><button className="small" onClick={addRow}>+ Durchlauf</button><CombinationsButton current={d} onApply={onChange} />
        <span className="muted">Platzhalter in Schritten: {d.columns.map((c) => <span key={c} className="mono" style={{ marginRight: 6 }}>{`\${${c}}`}</span>)}
          · Tabelle aus Excel einfügen: in das erste Feld (mit Kopfzeile)</span></div>
    </div>
  );
}

export function DatasetView({ value }: { value: Dataset }) {
  return (
    <div className="table-wrap"><table className="steps">
      <thead><tr><th className="n">#</th>{value.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
      <tbody>{value.rows.map((r, i) => <tr key={i}><td className="n">{i + 1}</td>{r.map((v, k) => <td key={k}>{v}</td>)}</tr>)}</tbody>
    </table></div>
  );
}

/** „⚙ Kombinationen …“: Parameter mit Werten → alle Kombinationen oder paarweise Abdeckung als Datensatz. */
export function CombinationsButton({ current, onApply, label = '⚙ Kombinationen …' }: { current?: Dataset | null; onApply: (d: Dataset) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="small" onClick={() => setOpen(true)} title="Durchläufe aus Parametern erzeugen: vollständig oder paarweise (Pairwise)">{label}</button>
    {open && <CombinationsDialog current={current ?? null} onClose={() => setOpen(false)} onApply={(d) => { setOpen(false); onApply(d); }} />}
  </>;
}

function CombinationsDialog({ current, onClose, onApply }: { current: Dataset | null; onClose: () => void; onApply: (d: Dataset) => void }) {
  // Vorbelegung aus dem vorhandenen Datensatz: Spalten mit ihren (verschiedenen) Werten
  const [params, setParams] = useState<{ name: string; values: string }[]>(() => current?.columns.length
    ? current.columns.map((c, i) => ({ name: c, values: [...new Set(current.rows.map((r) => r[i] ?? '').filter(Boolean))].join(', ') }))
    : [{ name: 'browser', values: 'Chrome, Firefox, Edge' }, { name: 'rolle', values: 'Admin, Leser' }]);
  const [exclusions, setExclusions] = useState('');
  const [mode, setMode] = useState<'pairwise' | 'all'>('pairwise');
  const parsed: Parameter[] = params.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), values: [...new Set(p.values.split(/[,;\n]/).map((v) => v.trim()).filter(Boolean))] }));
  const ex: Exclusion[] = exclusions.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => Object.fromEntries(l.split(/[,&]/).map((x) => x.split('=').map((y) => y.trim())).filter((x) => x.length === 2 && x[0] && x[1])));
  const result = useMemo(() => {
    try {
      const rows = mode === 'all' ? allCombinations(parsed, ex) : pairwise(parsed, ex);
      return { rows, error: null as string | null, total: parsed.reduce((n, p) => n * p.values.length, 1), missing: mode === 'pairwise' ? uncoveredPairs(parsed, rows, ex).length : 0 };
    } catch (e) {
      return { rows: [] as string[][], error: (e as Error).message, total: 0, missing: 0 };
    }
  }, [JSON.stringify(parsed), exclusions, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal size="large" title="Durchläufe kombinatorisch erzeugen" onClose={onClose}
      footer={<><span className="small muted">{result.error ?? `${plural(result.rows.length, 'Durchlauf', 'Durchläufe')}${mode === 'pairwise' ? ` statt ${result.total.toLocaleString('de-DE')} (alle Kombinationen)` : ''}`}</span>
        <span className="spacer" /><button onClick={onClose}>Abbrechen</button>
        <button className="primary" disabled={!!result.error || !result.rows.length || result.rows.length > 200}
          title={result.error ? result.error : !result.rows.length ? 'Erst Parameter mit Werten angeben' : result.rows.length > 200 ? `${result.rows.length} Durchläufe – höchstens 200 je Testfall` : undefined}
          onClick={() => onApply({ columns: parsed.map((p) => p.name), rows: result.rows })}>{current?.rows.length ? 'Datensatz ersetzen' : 'Übernehmen'}</button></>}>
      <p className="small muted">Je Parameter die Werte (mit Komma getrennt). <b>Paarweise</b> erzeugt nur so viele Durchläufe, dass jedes Wertepaar zweier
        Parameter mindestens einmal vorkommt – das findet erfahrungsgemäß die meisten Fehler aus Wechselwirkungen bei einem Bruchteil des Aufwands.</p>
      <div className="stack">
        {params.map((p, i) => (
          <div key={i} className="row">
            <input value={p.name} onChange={(e) => setParams(params.map((x, k) => (k === i ? { ...x, name: e.target.value.replace(/[^\p{L}\p{N}_ .-]/gu, '') } : x)))} placeholder="Parameter" aria-label={`Parameter ${i + 1}`} style={{ width: 160 }} />
            <input value={p.values} onChange={(e) => setParams(params.map((x, k) => (k === i ? { ...x, values: e.target.value } : x)))} placeholder="Werte, mit Komma getrennt" aria-label={`Werte ${i + 1}`} style={{ flex: 1, width: 'auto' }} />
            <button className="ghost small danger" onClick={() => setParams(params.filter((_, k) => k !== i))} aria-label={`Parameter ${i + 1} entfernen`}>✕</button>
          </div>
        ))}
        <div><button className="small" onClick={() => setParams([...params, { name: '', values: '' }])}>+ Parameter</button></div>
      </div>
      <label className="field">Ausschlüsse (je Zeile eine Kombination, die es nicht gibt)
        <textarea rows={3} value={exclusions} onChange={(e) => setExclusions(e.target.value)} placeholder={'browser=Edge, os=Linux\nrolle=Gast, modul=Admin'} className="mono" /></label>
      <fieldset className="plain-fieldset"><legend className="small">Verfahren</legend>
        <div className="row">
          <label className="row small"><input type="radio" name="combination-mode" value="pairwise" style={{ width: 'auto' }} checked={mode === 'pairwise'} onChange={() => setMode('pairwise')} /> paarweise (empfohlen)</label>
          <label className="row small"><input type="radio" name="combination-mode" value="all" style={{ width: 'auto' }} checked={mode === 'all'} onChange={() => setMode('all')} /> alle Kombinationen</label>
        </div>
      </fieldset>
      {result.error && <div className="notice bad small">{result.error}</div>}
      {result.rows.length > 200 && <div className="notice warn small">{result.rows.length} Durchläufe – höchstens 200 je Testfall. Bitte paarweise erzeugen oder Werte reduzieren.</div>}
      {!result.error && result.rows.length > 0 && <>
        {mode === 'pairwise' && <div className="small rate-ok">✓ Alle zulässigen Wertepaare abgedeckt{result.missing ? ` (außer ${result.missing})` : ''}</div>}
        <div className="table-wrap" style={{ maxHeight: 260 }}><table className="steps"><thead><tr><th className="n">#</th>{parsed.map((p) => <th key={p.name}>{p.name}</th>)}</tr></thead>
          <tbody>{result.rows.slice(0, 200).map((r, i) => <tr key={i}><td className="n">{i + 1}</td>{r.map((v, k) => <td key={k}>{v}</td>)}</tr>)}</tbody></table></div>
      </>}
    </Modal>
  );
}
