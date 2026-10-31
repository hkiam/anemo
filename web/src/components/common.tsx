import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { get } from '../api.ts';
import { tint } from '../color.ts';
import { useFocusTrap } from '../ux.tsx';
import type { ExecutionStatus, GherkinDoc, TestCaseStatus, Workflow } from '../types.ts';
import { HelpButton } from './HelpPanel.tsx';

let statusCache: Promise<ExecutionStatus[]> | null = null;

export function useStatuses(): ExecutionStatus[] {
  const [s, setS] = useState<ExecutionStatus[]>([]);
  useEffect(() => {
    statusCache ??= get<ExecutionStatus[]>('/api/execution-statuses');
    statusCache.then(setS, () => (statusCache = null));
  }, []);
  return s;
}

/** Nach Änderungen in der Administration neu laden */
export function invalidateStatuses(): void {
  statusCache = null;
  workflowCache = null;
}

let workflowCache: Promise<Workflow> | null = null;
export function useWorkflow(): Workflow | null {
  const [w, setW] = useState<Workflow | null>(null);
  useEffect(() => {
    workflowCache ??= get<Workflow>('/api/test-case-workflow');
    workflowCache.then(setW, () => (workflowCache = null));
  }, []);
  return w;
}

/** Zielstatus eines Testfalls: erlaubte Übergänge bzw. alle aktiven Status, wenn der Ausgangsstatus frei ist. */
export function nextStatuses(w: Workflow, from: string): TestCaseStatus[] {
  const rules = w.transitions.filter((t) => t.from === from).map((t) => t.to);
  return w.statuses.filter((s) => s.active && s.code !== from && (rules.length === 0 || rules.includes(s.code)));
}

/** Testfallstatus: Schrift in Textfarbe (lesbar in Hell und Dunkel), die Statusfarbe als Punkt, Rahmen und Tönung. */
export function TestCaseStatusBadge({ code, workflow }: { code: string; workflow: Workflow | null }) {
  const s = workflow?.statuses.find((x) => x.code === code);
  const c = s?.color ?? '#888888';
  return (
    <span className="badge status-badge" style={{ background: tint(c, 0.12), borderColor: tint(c, 0.55) }} title={s?.description ?? undefined}>
      <span className="status-dot" style={{ background: c }} aria-hidden="true" />{s?.name ?? code}
    </span>
  );
}

export function StatusBadge({ code, statuses }: { code: string; statuses: ExecutionStatus[] }) {
  const s = statuses.find((x) => x.code === code);
  return (
    <span className="badge neutral" title={code}>
      <span className="status-dot" style={{ background: s?.color ?? '#999' }} aria-hidden="true" />
      {s?.name ?? code}
    </span>
  );
}

/** Zahlen je Status als Satz für Screenreader und Tooltip: „3 Bestanden, 1 Blockiert, 2 Nicht ausgeführt (von 6)“. */
export function describeCounts(byStatus: Record<string, number>, statuses: ExecutionStatus[], total?: number): string {
  const known = statuses.filter((s) => byStatus[s.code]).map((s) => `${byStatus[s.code]} ${s.name}`);
  const unknown = Object.entries(byStatus).filter(([k, v]) => v && !statuses.some((s) => s.code === k)).map(([k, v]) => `${v} ${k}`);
  const parts = [...known, ...unknown];
  if (!parts.length) return 'keine Ausführungen';
  return `${parts.join(', ')}${total ? ` (von ${total})` : ''}`;
}

/** Fortschrittsbalken je Status; für Hilfstechnik als Bild mit den Zahlen beschrieben. */
export function Progress({ byStatus, statuses, total, label }: { byStatus: Record<string, number>; statuses: ExecutionStatus[]; total: number; label?: string }) {
  if (!total) return <div className="progress" role="img" aria-label={label ? `${label}: keine Ausführungen` : 'Keine Ausführungen'} />;
  const text = `${label ? `${label}: ` : 'Fortschritt: '}${describeCounts(byStatus, statuses, total)}`;
  return (
    <div className="progress" role="img" aria-label={text} title={text}>
      {statuses.filter((s) => byStatus[s.code]).map((s) => (
        <span key={s.code} style={{ width: `${(100 * byStatus[s.code]!) / total}%`, background: s.color }} />
      ))}
    </div>
  );
}

export interface LegendItem {
  label: string; color: string; value?: number | string;
  /** Darstellung des Schlüssels: Fläche (Standard), Linie, gestrichelte Linie oder schraffierte Fläche */
  shape?: 'box' | 'line' | 'dashed' | 'hatched';
}

/**
 * Legende für Diagramme – Farbe nie als einziges Merkmal: Name und (optional) Zahl stehen als Text daneben.
 * Beispiel: `<Legend title="Verlauf der Ausführungen" items={[{ label: 'Bestanden', color: s.color, value: 12 }]} />`.
 */
export function Legend({ items, title, className }: { items: LegendItem[]; title?: string; className?: string }) {
  return (
    <ul className={`legend ${className ?? ''}`} aria-label={title ?? 'Legende'}>
      {items.map((i) => (
        <li key={i.label}>
          <span className={`legend-key ${i.shape ?? 'box'}`} style={{ '--key': i.color } as CSSProperties} aria-hidden="true" />
          <span>{i.label}</span>{i.value !== undefined && <strong className="legend-value">{i.value}</strong>}
        </li>
      ))}
    </ul>
  );
}

export function Chips({ items }: { items: string[] }) {
  if (!items.length) return <span className="muted">–</span>;
  return <div className="chips">{items.map((i) => <span key={i} className="chip">{i}</span>)}</div>;
}

/** Offene Dialoge (oberster zuletzt) – Esc schließt nur den obersten. */
const modalStack: string[] = [];

/**
 * Dialog mit Fokusfalle: Startfokus auf dem ersten Eingabefeld (bzw. einem autoFocus-Feld), sonst dem Primärknopf;
 * Tab bleibt im Dialog; nach dem Schließen kehrt der Fokus zum auslösenden Element zurück.
 */
/** Dialog; `help` (Thema aus shared/help/topics.ts) zeigt im Kopf einen „?“-Knopf zur passenden Hilfe. */
export function Modal({ title, onClose, children, footer, size, help }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'large'; help?: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  useEffect(() => {
    modalStack.push(id);
    // Esc gehört zuerst einer offenen Rückfrage (askConfirm/askText), dann dem obersten Dialog
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.dialog-layer') && modalStack.at(-1) === id && onClose();
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); modalStack.splice(modalStack.indexOf(id), 1); };
  }, [onClose, id]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className={`modal ${size ?? ''}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`}>
        <div className="modal-head"><h3 id={`${id}-t`}>{title}</h3>{help && <HelpButton topic={help} />}<span className="spacer" /><button className="ghost" onClick={onClose} aria-label="Schließen">✕</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="notice bad error-note" role="alert">{error instanceof Error ? error.message : String(error)}</div>;
}

// Jira-Wiki-Markup: siehe ../wiki (Parser + sichere Darstellung inkl. eingebetteter Bilder)
export { Wiki, WikiAttachments } from '../wiki/Wiki.tsx';

// ---- Gherkin-Darstellung mit Hervorhebung ----

const GK_KEYWORDS = /^(\s*)(Funktionalität|Funktion|Feature|Grundlage|Hintergrund|Background|Szenariogrundriss|Scenario Outline|Szenario|Scenario|Beispiele|Examples|Regel|Rule|Angenommen|Gegeben seien|Gegeben sei|Given|Wenn|When|Dann|Then|Und|And|Aber|But)(:?)(.*)$/;

export function GherkinView({ text, doc }: { text: string; doc?: GherkinDoc | null }) {
  const errLines = new Set((doc?.errors ?? []).map((e) => e.line));
  return (
    <pre className="code">
      {text.split('\n').map((line, i) => {
        let content: ReactNode = line;
        const m = GK_KEYWORDS.exec(line);
        if (/^\s*#/.test(line)) content = <span className="gk-comment">{line}</span>;
        else if (/^\s*@/.test(line)) content = <span className="gk-tag">{line}</span>;
        else if (m) {
          content = <>{m[1]}<span className="gk-kw">{m[2]}{m[3]}</span>{m[4]!.split(/(<[^>]+>|"[^"]*")/).map((p, k) =>
            /^[<"]/.test(p) ? <span key={k} className="gk-str">{p}</span> : p)}</>;
        }
        return <div key={i} className={errLines.has(i + 1) ? 'gk-line-err' : undefined}>{content || ' '}</div>;
      })}
    </pre>
  );
}
