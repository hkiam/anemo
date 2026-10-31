import { useEffect, useState } from 'react';
import { api, get } from '../api.ts';
import type { ConfigDimension, Configuration, Cycle } from '../types.ts';
import { ErrorNote, Modal } from './common.tsx';

let dimsCache: Promise<ConfigDimension[]> | null = null;
export function useDimensions(reloadKey = 0): ConfigDimension[] {
  const [d, setD] = useState<ConfigDimension[]>([]);
  useEffect(() => {
    if (reloadKey) dimsCache = null;
    dimsCache ??= get<ConfigDimension[]>('/api/configuration/dimensions');
    dimsCache.then(setD, () => (dimsCache = null));
  }, [reloadKey]);
  return d;
}
export const invalidateDimensions = () => { dimsCache = null; };

/** Konfiguration als kompakte Chips ("Datenbank: Oracle, SQL Server"); Klick filtert optional. */
export function ConfigChips({ configuration, dims, onPick, evidence }: {
  configuration: Configuration | undefined; dims: ConfigDimension[];
  onPick?: (dimension: string, value: string) => void; evidence?: Cycle['configurationEvidence'];
}) {
  const entries = dims.filter((d) => configuration?.[d.key]?.length);
  if (!entries.length) return <span className="muted small">–</span>;
  return (
    <span className="chips">
      {entries.flatMap((d) => configuration![d.key]!.map((v) => {
        const ev = evidence?.[d.key]?.find((e) => e.value === v);
        const title = `${d.name}: ${v}${ev ? ` – erkannt aus „${ev.match}“` : ''}`;
        return onPick
          ? <button key={`${d.key}:${v}`} type="button" className="chip cfg" title={title} onClick={(e) => { e.stopPropagation(); onPick(d.key, v); }}><span className="muted">{d.name}:</span> {v}</button>
          : <span key={`${d.key}:${v}`} className="chip cfg" title={title}><span className="muted">{d.name}:</span> {v}</span>;
      }))}
    </span>
  );
}

/** Mehrfachauswahl je Merkmal; freie Werte (z. B. Testsystem) als Komma-Liste. */
export function ConfigurationEditor({ value, onChange, dims }: { value: Configuration; onChange: (c: Configuration) => void; dims: ConfigDimension[] }) {
  const toggle = (dim: string, v: string) => {
    const cur = new Set(value[dim] ?? []);
    cur.has(v) ? cur.delete(v) : cur.add(v);
    onChange({ ...value, [dim]: [...cur] });
  };
  return (
    <div className="stack">
      {dims.map((d) => (
        <div key={d.key} className="row" style={{ alignItems: 'flex-start' }}>
          <strong style={{ width: 150 }} title={d.description ?? ''}>{d.name}</strong>
          {d.values.length > 0 ? (
            <div className="chips" style={{ flex: 1 }}>
              {d.values.map((v) => (
                <button key={v.value} type="button" className={`chip-btn ${value[d.key]?.includes(v.value) ? 'on' : ''}`} onClick={() => toggle(d.key, v.value)} title={v.description ?? ''}>{v.value}</button>
              ))}
            </div>
          ) : (
            <input style={{ flex: 1 }} placeholder="Werte, durch Komma getrennt" value={(value[d.key] ?? []).join(', ')}
              onChange={(e) => onChange({ ...value, [d.key]: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
          )}
        </div>
      ))}
    </div>
  );
}

export function EditCycleConfiguration({ cycle, onClose, onSaved }: { cycle: Cycle; onClose: () => void; onSaved: () => void }) {
  const dims = useDimensions();
  const [value, setValue] = useState<Configuration>(cycle.configuration ?? {});
  const [error, setError] = useState<unknown>(null);
  const save = async (configuration: Configuration | null) => {
    try {
      await api('PUT', `/api/cycles/${cycle.id}/configuration`, { configuration });
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal title={`Konfiguration: ${cycle.name}`} help="admin-configurations" onClose={onClose} footer={<>
      {cycle.configurationSource === 'manual' && <button onClick={() => save(null)} title="Konfiguration wieder aus Name/Umgebung/Build erkennen">Automatisch erkennen</button>}
      <span className="spacer" /><button onClick={onClose}>Abbrechen</button><button className="primary" onClick={() => save(value)}>Speichern (manuell)</button>
    </>}>
      <ErrorNote error={error} />
      <p className="small muted" style={{ margin: 0 }}>
        {cycle.configurationSource === 'manual' ? 'Manuell festgelegt – wird von der automatischen Erkennung nicht verändert.'
          : 'Automatisch erkannt aus Name, Umgebung und Build. Speichern legt die Konfiguration manuell fest.'}
        {cycle.environment && <> Umgebung laut Quelle: „{cycle.environment}“.</>}
      </p>
      <ConfigurationEditor value={value} onChange={setValue} dims={dims} />
    </Modal>
  );
}
