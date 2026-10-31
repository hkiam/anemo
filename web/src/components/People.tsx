import { useEffect, useId, useMemo, useState } from 'react';
import { get } from '../api.ts';
import { currentUser } from '../session.tsx';
import { Modal } from './common.tsx';

const cache = new Map<string, Promise<string[]>>();

/**
 * Bekannte Personen für Vorschläge (Benutzernamen): aktive Benutzer aus dem Verzeichnis (/api/directory) sowie
 * Zuständige und Tester aus dem Arbeitsstand des Projekts (auch übernommene Namen aus der Migration).
 */
export function usePeople(projectKey: string): string[] {
  const [people, setPeople] = useState<string[]>([]);
  useEffect(() => {
    let p = cache.get(projectKey);
    if (!p) {
      p = Promise.all([
        get<{ users: { username: string }[] }>('/api/directory').catch(() => ({ users: [] })),
        get<{ byAssignee: { assignee: string | null }[]; byTester: { executedBy: string }[] }>(`/api/projects/${projectKey}/workload`).catch(() => ({ byAssignee: [], byTester: [] })),
      ]).then(([dir, w]) => {
        const names = new Set<string>();
        for (const u of dir.users) names.add(u.username);
        for (const a of w.byAssignee) if (a.assignee) names.add(a.assignee);
        for (const t of w.byTester) if (t.executedBy) names.add(t.executedBy);
        return [...names].sort((a, b) => a.localeCompare(b, 'de'));
      });
      cache.set(projectKey, p);
      // nach einer Weile neu laden (neue Benutzer)
      setTimeout(() => cache.delete(projectKey), 5 * 60_000);
    }
    let alive = true;
    void p.then((list) => { if (alive) setPeople([...new Set([currentUser(), ...list])].filter(Boolean)); });
    return () => { alive = false; };
  }, [projectKey]);
  return people;
}

/**
 * Kleiner Eingabedialog mit Vorschlagsliste (Personen, Labels, Komponenten). Freie Eingaben bleiben möglich,
 * unbekannte Werte werden aber deutlich als „neu“ gekennzeichnet.
 */
export function SuggestDialog({ title, label, suggestions, initial = '', required = true, hint, confirmLabel = 'Übernehmen', unknownHint, onCancel, onSubmit }: {
  title: string; label: string; suggestions: string[]; initial?: string; required?: boolean; hint?: string; confirmLabel?: string;
  /** Hinweis, wenn der Wert nicht in den Vorschlägen steht (z. B. „Label wird neu angelegt“) */
  unknownHint?: string;
  onCancel: () => void; onSubmit: (value: string) => void;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const v = value.trim();
  const known = useMemo(() => new Set(suggestions.map((s) => s.toLowerCase())), [suggestions]);
  const parts = v.split(',').map((x) => x.trim()).filter(Boolean);
  const unknown = parts.filter((p) => !known.has(p.toLowerCase()));
  const disabled = required && !v;
  return (
    <Modal title={title} onClose={onCancel}
      footer={<><span className="spacer" /><button onClick={onCancel}>Abbrechen</button>
        <button className="primary" disabled={disabled} title={disabled ? 'Bitte einen Wert eingeben oder wählen' : undefined} onClick={() => onSubmit(v)}>{confirmLabel}</button></>}>
      <label className="field">{label}
        <input autoFocus list={`${id}-list`} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off"
          onKeyDown={(e) => { if (e.key === 'Enter' && !disabled) { e.preventDefault(); onSubmit(v); } }} />
        <datalist id={`${id}-list`}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
      </label>
      {hint && <div className="small muted">{hint}</div>}
      {unknownHint && unknown.length > 0 && suggestions.length > 0 && <div className="notice warn small" role="status">„{unknown.join('“, „')}“: {unknownHint}</div>}
      {suggestions.length > 0 && suggestions.length <= 30 && <div className="suggest-chips" aria-label="Vorschläge">
        {suggestions.map((s) => <button key={s} type="button" className="chip-btn small" onClick={() => setValue(s)}>{s}</button>)}
      </div>}
    </Modal>
  );
}
