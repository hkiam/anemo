import { useEffect, useState } from 'react';
import { get } from '../api.ts';

export type FieldScope = 'test_case' | 'cycle' | 'execution';
export type FieldType = 'text' | 'textarea' | 'select' | 'multiselect' | 'number' | 'date' | 'checkbox' | 'user';
export interface FieldDef {
  id: string; scope: FieldScope; key: string; name: string; type: FieldType; options: string[]; required: boolean;
  projectId: string | null; projectKey?: string | null; description: string | null; sortOrder: number; active: boolean;
  optionsSource?: { provider: 'jira' | 'openproject'; project?: string | null; kind: string; fieldId?: string | null } | null;
  optionsSyncedAt?: string | null; optionsSyncError?: string | null;
}
export interface Priority { code: string; color: string; sortOrder: number; isDefault: boolean; active: boolean; description: string | null }

/** Technische Schlüssel aus der Migration – nicht als fachliche Felder anzeigen. */
export const INTERNAL_KEYS = new Set(['jira', 'zephyr', 'comments', 'worklog', 'stepAttributes', 'created', 'retestFor', 'retestDefect', 'automation']);

const defCache = new Map<string, Promise<FieldDef[]>>();
let prioCache: Promise<Priority[]> | null = null;

/** Felddefinitionen (global + Projekt) eines Bereichs, zwischengespeichert. */
export function useFieldDefs(scope: FieldScope, projectKey: string | null | undefined): FieldDef[] {
  const [defs, setDefs] = useState<FieldDef[]>([]);
  useEffect(() => {
    const k = `${scope}:${projectKey ?? ''}`;
    if (!defCache.has(k)) defCache.set(k, get<FieldDef[]>(`/api/fields?scope=${scope}${projectKey ? `&project=${projectKey}` : ''}`));
    defCache.get(k)!.then(setDefs, () => defCache.delete(k));
  }, [scope, projectKey]);
  return defs;
}

export function usePriorities(): Priority[] {
  const [p, setP] = useState<Priority[]>([]);
  useEffect(() => {
    prioCache ??= get<Priority[]>('/api/priorities');
    prioCache.then(setP, () => (prioCache = null));
  }, []);
  return p;
}

/** Nach Änderungen in der Administration neu laden */
export function invalidateFields(): void {
  defCache.clear();
  prioCache = null;
}

export function PriorityBadge({ value, priorities }: { value: string | null | undefined; priorities: Priority[] }) {
  if (!value) return <span className="muted">–</span>;
  const p = priorities.find((x) => x.code === value);
  return <span className="prio" title={p?.description ?? 'Priorität'}><span className="prio-dot" style={{ background: p?.color ?? '#888' }} />{value}</span>;
}

export function PrioritySelect({ value, onChange, priorities, label = 'Priorität', allowEmpty = true }: {
  value: string | null; onChange: (v: string | null) => void; priorities: Priority[]; label?: string; allowEmpty?: boolean;
}) {
  const known = priorities.some((p) => p.code === value);
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label={label}>
      {allowEmpty && <option value="">– keine –</option>}
      {value && !known && <option value={value}>{value} (übernommen)</option>}
      {priorities.map((p) => <option key={p.code} value={p.code}>{p.code}{p.isDefault ? ' (Standard)' : ''}</option>)}
    </select>
  );
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === '' ? [] : String(v).split(/[,;]\s*/));

/** Anzeige eines Feldwerts (Datum deutsch, Liste mit Komma, Häkchen). */
export function fieldText(def: Pick<FieldDef, 'type'> | undefined, v: unknown): string {
  if (v === undefined || v === null || v === '') return '–';
  if (def?.type === 'checkbox') return v === true || v === 'true' ? 'ja' : 'nein';
  if (def?.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return new Date(`${v.slice(0, 10)}T00:00:00`).toLocaleDateString('de-DE');
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Eingabefelder für eigene Felder; Pflichtfelder markiert. */
export function FieldInputs({ defs, values, onChange, compact }: {
  defs: FieldDef[]; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; compact?: boolean;
}) {
  if (!defs.length) return null;
  const set = (k: string, v: unknown) => onChange({ ...values, [k]: v });
  return (
    <div className={compact ? 'field-grid compact' : 'field-grid'}>
      {defs.map((d) => {
        const v = values[d.key];
        const label = <>{d.name}{d.required && <span className="req" title="Pflichtfeld"> *</span>}</>;
        const hint = d.description ? <span className="small muted">{d.description}</span> : null;
        switch (d.type) {
          case 'textarea':
            return <label key={d.id} className="field span2">{label}<textarea rows={3} value={String(v ?? '')} onChange={(e) => set(d.key, e.target.value)} />{hint}</label>;
          case 'select': {
            const cur = v === undefined || v === null ? '' : String(v);
            return <label key={d.id} className="field">{label}
              <select value={cur} onChange={(e) => set(d.key, e.target.value || null)}>
                <option value="">–</option>
                {cur && !d.options.includes(cur) && <option value={cur}>{cur} (übernommen)</option>}
                {d.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>{hint}</label>;
          }
          case 'multiselect': {
            const cur = asList(v);
            return <fieldset key={d.id} className="field multi"><legend>{label}</legend>
              <div className="chips-select">
                {[...new Set([...d.options, ...cur])].map((o) => (
                  <label key={o} className={`chip-toggle ${cur.includes(o) ? 'on' : ''}`}>
                    <input type="checkbox" checked={cur.includes(o)} onChange={(e) => set(d.key, e.target.checked ? [...cur, o] : cur.filter((x) => x !== o))} />{o}
                  </label>
                ))}
              </div>{hint}</fieldset>;
          }
          case 'checkbox':
            return <label key={d.id} className="field row check"><input type="checkbox" style={{ width: 'auto' }} checked={v === true || v === 'true'} onChange={(e) => set(d.key, e.target.checked)} /> {label}</label>;
          case 'number':
            return <label key={d.id} className="field">{label}<input type="number" step="any" value={v === undefined || v === null ? '' : String(v)} onChange={(e) => set(d.key, e.target.value === '' ? null : Number(e.target.value))} />{hint}</label>;
          case 'date':
            return <label key={d.id} className="field">{label}<input type="date" value={typeof v === 'string' ? v.slice(0, 10) : ''} onChange={(e) => set(d.key, e.target.value || null)} />{hint}</label>;
          default:
            return <label key={d.id} className="field">{label}<input value={String(v ?? '')} onChange={(e) => set(d.key, e.target.value)} placeholder={d.type === 'user' ? 'Benutzername' : ''} />{hint}</label>;
        }
      })}
    </div>
  );
}

/** Werte lesend: definierte Felder in ihrer Reihenfolge, danach übernommene Werte ohne Definition. */
export function FieldValues({ defs, values, showUndefined = true }: { defs: FieldDef[]; values: Record<string, unknown> | null | undefined; showUndefined?: boolean }) {
  const vals = values ?? {};
  const defined = defs.filter((d) => vals[d.key] !== undefined && vals[d.key] !== null && vals[d.key] !== '');
  const known = new Set(defs.map((d) => d.key));
  const other = showUndefined ? Object.entries(vals).filter(([k, v]) => !known.has(k) && !INTERNAL_KEYS.has(k) && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) : [];
  if (!defined.length && !other.length) return null;
  return (
    <dl className="field-values">
      {defined.map((d) => <div key={d.key}><dt>{d.name}</dt><dd>{fieldText(d, vals[d.key])}</dd></div>)}
      {other.map(([k, v]) => <div key={k} className="muted" title="Übernommener Wert ohne Felddefinition (Administration → Felder & Prioritäten)"><dt>{k}</dt><dd>{fieldText(undefined, v)}</dd></div>)}
    </dl>
  );
}
