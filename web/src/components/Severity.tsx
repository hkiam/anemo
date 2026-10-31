import { SEVERITIES, type Severity } from '../types.ts';

const TONE: Record<Severity, string> = { Gravierend: 'bad', Hoch: 'bad', Mittel: 'warn', Gering: 'neutral', Kosmetisch: 'neutral' };

/** Schweregrad eines Fehlers als Abzeichen (nichts, wenn keiner gesetzt ist). Ältere Werte erscheinen unverändert. */
export function SeverityBadge({ value }: { value: string | null | undefined }) {
  if (!value) return null;
  return <span className={`badge ${TONE[value as Severity] ?? 'neutral'}`} title={`Schweregrad des Fehlers: ${value}`}>{value}</span>;
}

/** Auswahl des Schweregrads; leer = keine Angabe. */
export function SeveritySelect({ value, onChange, label = 'Schweregrad' }: { value: Severity | ''; onChange: (v: Severity | '') => void; label?: string }) {
  return (
    <label className="field">{label}
      <select value={value} onChange={(e) => onChange(e.target.value as Severity | '')} title="Schweregrad des Fehlers – unabhängig von der Priorität des Testfalls">
        <option value="">– keine Angabe –</option>
        {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </label>
  );
}
