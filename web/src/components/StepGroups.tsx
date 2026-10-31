import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { groupTitle, isGroup, stepNumbers, stepRanges } from '../../../shared/steps/groups.ts';
import type { Step } from '../types.ts';
import { plural } from '../text.ts';
import { Wiki } from './common.tsx';

/**
 * Abschnitte (Stufe J1) in Schritttabellen: Zuordnung Schritt → Abschnitt, Auf-/Zuklappen (Standard: alles offen) und
 * Nummern nur für Prüfschritte.
 */
export function useStepGroups(steps: Step[]) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const info = useMemo(() => {
    const ranges = stepRanges(steps);
    const groupOf = new Map<number, number>(); // Schrittindex → Index des Abschnitts
    const members = new Map<number, number[]>();
    for (const r of ranges) if (r.group !== null) { members.set(r.group, r.steps); for (const i of r.steps) groupOf.set(i, r.group); }
    return { numbers: stepNumbers(steps), groupOf, members, hasGroups: steps.some(isGroup) };
  }, [steps]);
  const keyOf = useCallback((i: number) => steps[i]?.id ?? `#${i}`, [steps]);
  const toggle = useCallback((i: number) => setClosed((c) => { const n = new Set(c); const k = keyOf(i); if (n.has(k)) n.delete(k); else n.add(k); return n; }), [keyOf]);
  const setAll = useCallback((open: boolean) => setClosed(open ? new Set() : new Set(steps.flatMap((s, i) => (isGroup(s) ? [keyOf(i)] : [])))), [steps, keyOf]);
  /** Schritt i ausgeblendet, weil sein Abschnitt zugeklappt ist? */
  const hidden = (i: number) => { const g = info.groupOf.get(i); return g !== undefined && closed.has(keyOf(g)); };
  const isOpen = (i: number) => !closed.has(keyOf(i));
  return { ...info, toggle, setAll, hidden, isOpen, anyClosed: closed.size > 0 };
}

export type StepGroups = ReturnType<typeof useStepGroups>;

/** Kopfzeile eines Abschnitts in einer Tabelle (über alle Spalten). */
export function GroupRow({ step, index, groups, cols, extra, children }: {
  step: Step; index: number; groups: StepGroups; cols: number; extra?: ReactNode; children?: ReactNode;
}) {
  const count = groups.members.get(index)?.length ?? 0;
  const open = groups.isOpen(index);
  const title = groupTitle(step);
  return (
    <tr className="step-group">
      <td colSpan={cols}>
        <div className="step-group-head">
          <button type="button" className="ghost small step-group-toggle" aria-expanded={open} onClick={() => groups.toggle(index)}
            title={open ? 'Abschnitt zuklappen' : 'Abschnitt aufklappen'}>
            <span aria-hidden="true" className="caret">{open ? '▾' : '▸'}</span>
            <span className={step.title?.trim() ? 'step-group-title' : 'step-group-title muted'}>{title}</span>
          </button>
          {step.subtitle && <span className="step-group-sub">{step.subtitle}</span>}
          {step.marker && <span className="badge warn" title="Kennzeichen aus der Übernahme">{step.marker}</span>}
          <span className="small muted">{plural(count, 'Schritt', 'Schritte')}</span>
          {extra}
        </div>
        {step.note && open && <div className="step-group-note small"><Wiki text={step.note} compact /></div>}
        {children}
      </td>
    </tr>
  );
}

/** „Alle aufklappen / zuklappen“ über einer Schritttabelle (nur wenn es Abschnitte gibt). */
export function GroupToggleAll({ groups }: { groups: StepGroups }) {
  if (!groups.hasGroups) return null;
  return (
    <div className="row small step-groups-all">
      <button type="button" className="link" onClick={() => groups.setAll(true)}>Alle Abschnitte aufklappen</button>
      <span aria-hidden="true">·</span>
      <button type="button" className="link" onClick={() => groups.setAll(false)}>Alle zuklappen</button>
    </div>
  );
}
