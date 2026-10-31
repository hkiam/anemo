import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { ErrorNote } from '../components/common.tsx';
import { invalidateDimensions, useDimensions } from '../components/Configuration.tsx';
import type { ConfigCount, ConfigDimension, ConfigValue } from '../types.ts';
import { askConfirm } from '../ux.tsx';

/**
 * Verwaltung der Testkonfigurationen: Merkmale und Werte mit Erkennungsregeln (reguläre Ausdrücke, ohne
 * Groß-/Kleinschreibung, geprüft gegen Zyklusname + Umgebung + Build), Neuklassifizierung und eine Liste
 * nicht erkannter Angaben zum Nachschärfen der Regeln.
 */
export function ConfigAdmin() {
  const [reload, setReload] = useState(0);
  const dims = useDimensions(reload);
  const counts = useApi<ConfigCount[]>(`/api/configuration/counts?r=${reload}`);
  const [selected, setSelected] = useState('database');
  const unclassified = useApi<{ text: string; cycles: number }[]>(`/api/configuration/unclassified?dimension=${selected}&limit=50&r=${reload}`);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const reclassify = async () => {
    try {
      const r = await api<{ total: number; changed: number }>('POST', '/api/configuration/reclassify', {});
      setResult(`${r.changed} von ${r.total} automatisch erkannten Zyklen geändert (manuell festgelegte bleiben unverändert).`);
      invalidateDimensions();
      setReload((x) => x + 1);
    } catch (e) {
      setError(e);
    }
  };
  const dim = dims.find((d) => d.key === selected);

  return (
    <div className="page" tabIndex={0} role="region" aria-label="Konfigurationen"><div className="page-wide stack">
      <div className="row"><h2>Testkonfigurationen</h2><span className="spacer" /><button className="primary" onClick={reclassify}>Alle Zyklen neu klassifizieren</button></div>
      <p className="small muted" style={{ margin: 0 }}>
        Merkmale wie Datenbank oder Client werden aus Zyklusname, Umgebung und Build erkannt. Je Wert gibt es reguläre Ausdrücke
        (eine Zeile je Ausdruck, Groß-/Kleinschreibung egal). Änderungen wirken nach „neu klassifizieren“; manuell festgelegte
        Zyklus-Konfigurationen werden dabei nie überschrieben.
      </p>
      {result && <div className="notice ok">{result}</div>}
      <ErrorNote error={error} />
      <div className="tabs">
        {dims.map((d) => <a key={d.key} href="#" className={selected === d.key ? 'active' : ''} aria-current={selected === d.key ? 'true' : undefined} onClick={(e) => { e.preventDefault(); setSelected(d.key); }}>{d.name}</a>)}
      </div>
      {dim && <DimensionEditor key={`${dim.key}-${reload}`} dim={dim} counts={(counts.data ?? []).filter((c) => c.dimension === dim.key)} onChanged={() => { invalidateDimensions(); setReload((x) => x + 1); }} />}
      <div className="card"><div className="card-body stack">
        <h3>Zyklen ohne erkannten Wert für „{dim?.name}“</h3>
        <p className="small muted" style={{ margin: 0 }}>Häufigste Umgebungsangaben bzw. Zyklusnamen ohne Treffer – Grundlage, um Regeln zu ergänzen.</p>
        <div className="table-wrap" style={{ maxHeight: 320 }} tabIndex={0} role="region" aria-label="Zyklen ohne erkannten Wert"><table><tbody>
          {unclassified.data?.map((u) => <tr key={u.text}><td className="small">{u.text}</td><td className="small muted" style={{ width: 80 }}>{u.cycles} Zyklen</td></tr>)}
        </tbody></table></div>
      </div></div>
    </div></div>
  );
}

function DimensionEditor({ dim, counts, onChanged }: { dim: ConfigDimension; counts: ConfigCount[]; onChanged: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState({ value: '', patterns: '' });
  const count = (v: string) => counts.find((c) => c.value === v)?.cycles ?? 0;
  const save = async (value: string, patterns: string, description?: string | null) => {
    try {
      await api('PUT', `/api/configuration/dimensions/${dim.key}/values`, { value, description: description ?? null, patterns: patterns.split('\n').map((p) => p.trim()).filter(Boolean) });
      onChanged();
    } catch (e) {
      setError(e);
    }
  };
  const remove = async (v: ConfigValue) => {
    if (!(await askConfirm({ title: 'Wert löschen', message: `Wert „${v.value}“ samt Regeln löschen? Zyklen behalten ihre bisherige Zuordnung bis zur Neuklassifizierung.`, confirmLabel: 'Löschen', danger: true }))) return;
    try {
      await api('DELETE', `/api/configuration/values/${v.id}`);
      onChanged();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="card"><div className="card-body stack">
      <div><h3>{dim.name}</h3>{dim.description && <div className="small muted">{dim.description}</div>}</div>
      <ErrorNote error={error} />
      {dim.extractPattern && (
        <div className="notice info small">Offener Wertebereich: Werte werden über <code>{dim.extractPattern}</code> aus dem Text übernommen.
          {counts.length > 0 && <> Häufigste: {counts.slice(0, 12).map((c) => `${c.value} (${c.cycles})`).join(', ')}{counts.length > 12 ? ' …' : ''}</>}</div>
      )}
      {dim.values.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Wert</th><th>Erkennungsregeln (reguläre Ausdrücke)</th><th>Zyklen</th><th /></tr></thead>
          <tbody>{dim.values.map((v) => <ValueRow key={v.id} v={v} count={count(v.value)} onSave={(p, d) => save(v.value, p, d)} onDelete={() => remove(v)} />)}</tbody>
        </table></div>
      )}
      {!dim.extractPattern && (
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <input placeholder="Neuer Wert, z. B. MariaDB" value={adding.value} onChange={(e) => setAdding({ ...adding, value: e.target.value })} style={{ width: 200 }} />
          <textarea rows={2} className="mono" placeholder="Regeln, je Zeile ein Ausdruck, z. B. maria ?db" value={adding.patterns} onChange={(e) => setAdding({ ...adding, patterns: e.target.value })} style={{ flex: 1 }} />
          <button disabled={!adding.value || !adding.patterns.trim()} onClick={() => { save(adding.value, adding.patterns); setAdding({ value: '', patterns: '' }); }}>Hinzufügen</button>
        </div>
      )}
    </div></div>
  );
}

function ValueRow({ v, count, onSave, onDelete }: { v: ConfigValue; count: number; onSave: (patterns: string, description: string | null) => void; onDelete: () => void }) {
  const [patterns, setPatterns] = useState(v.patterns.join('\n'));
  const [description, setDescription] = useState(v.description ?? '');
  const dirty = patterns !== v.patterns.join('\n') || description !== (v.description ?? '');
  return (
    <tr>
      <td style={{ width: 200 }}><strong>{v.value}</strong>
        <input className="small" placeholder="Beschreibung" aria-label="Beschreibung des Werts" value={description} onChange={(e) => setDescription(e.target.value)} style={{ marginTop: 4 }} /></td>
      <td><textarea rows={Math.max(1, v.patterns.length)} className="mono" aria-label="Erkennungsmuster (je Zeile eines)" value={patterns} onChange={(e) => setPatterns(e.target.value)} spellCheck={false} /></td>
      <td className="small">{count}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button className="small" disabled={!dirty} onClick={() => onSave(patterns, description || null)}>Speichern</button>
        <button className="small ghost danger" onClick={onDelete} title="Wert löschen" aria-label="Wert löschen">✕</button>
      </td>
    </tr>
  );
}
