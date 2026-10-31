/**
 * UX-Grundlagen: Fokusfenster, fensterübergreifende Aktualisierung, Seitentitel, Schutz ungespeicherter Eingaben,
 * Rückmeldungen (Toasts) und eigene Dialoge statt prompt()/confirm().
 */
import { type CSSProperties, type KeyboardEvent as RKeyboardEvent, type ReactNode, type RefObject, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// ---------------------------------------------------------------------------------------------
// Fokusfenster
// ---------------------------------------------------------------------------------------------

/** Öffnet eine Ansicht im eigenen, großen Fenster (gleichnamige Fenster werden wiederverwendet). */
export function openFocus(hashPath: string, name = 'anemo-fokus'): void {
  const url = `${window.location.origin}${window.location.pathname}#${hashPath.replace(/^#/, '')}`;
  const w = Math.min(window.screen.availWidth - 40, 1600);
  const h = Math.min(window.screen.availHeight - 60, 1050);
  const win = window.open(url, name, `popup=yes,width=${w},height=${h},left=20,top=20`);
  win?.focus();
}

/** Link, der per Klick ein Fokusfenster öffnet; Strg/Cmd-Klick bzw. Mittelklick öffnet einen normalen Tab. */
export function FocusLink({ to, name, children, className, title }: { to: string; name?: string; children: ReactNode; className?: string; title?: string }) {
  return (
    <a href={`#${to.replace(/^#/, '')}`} className={className} title={title ?? 'Im eigenen Fenster öffnen (Strg/Cmd-Klick: neuer Tab)'}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        openFocus(to, name);
      }}>{children}</a>
  );
}

/** Läuft diese Seite in einem Fokusfenster (vom Hauptfenster geöffnet)? */
export const inPopup = () => !!window.opener && window.name.startsWith('anemo-');

// ---------------------------------------------------------------------------------------------
// Fensterübergreifende Aktualisierung
// ---------------------------------------------------------------------------------------------

export type SyncKind = 'execution' | 'testcase' | 'cycle' | 'plan' | 'project';
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('anemo') : null;
const local = new EventTarget();

/** Änderung melden – andere Fenster (und Komponenten in diesem) laden betroffene Listen neu. */
export function notifyChanged(kind: SyncKind, id?: string): void {
  channel?.postMessage({ kind, id });
  local.dispatchEvent(new CustomEvent('changed', { detail: { kind, id } }));
}

export function useSync(kinds: SyncKind[], onChange: (kind: SyncKind, id?: string) => void): void {
  const cb = useRef(onChange);
  cb.current = onChange;
  const key = kinds.join(',');
  useEffect(() => {
    const wanted = new Set(key.split(','));
    const handle = (d: { kind: SyncKind; id?: string }) => wanted.has(d.kind) && cb.current(d.kind, d.id);
    const onMsg = (e: MessageEvent) => handle(e.data);
    const onLocal = (e: Event) => handle((e as CustomEvent).detail);
    channel?.addEventListener('message', onMsg);
    local.addEventListener('changed', onLocal);
    return () => {
      channel?.removeEventListener('message', onMsg);
      local.removeEventListener('changed', onLocal);
    };
  }, [key]);
}

// ---------------------------------------------------------------------------------------------
// Seitentitel und ungespeicherte Eingaben
// ---------------------------------------------------------------------------------------------

/** Fenster-/Tab-Titel – bei mehreren Fenstern unterscheidbar. */
export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (title) document.title = `${title} – Anemo`;
    return () => { document.title = 'Anemo'; };
  }, [title]);
}

const unsaved = new Set<string>();

/** Warnt beim Schließen/Neuladen und bei Wechseln in der Anwendung, solange Eingaben ungespeichert sind. */
export function useUnsavedGuard(dirty: boolean, key = 'default'): void {
  useEffect(() => {
    if (!dirty) return;
    unsaved.add(key);
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => {
      unsaved.delete(key);
      window.removeEventListener('beforeunload', h);
    };
  }, [dirty, key]);
}

/** Vor einem Wechsel in der Anwendung nachfragen, wenn irgendwo ungespeicherte Eingaben sind. */
export async function confirmLeave(): Promise<boolean> {
  if (!unsaved.size) return true;
  const ok = await askConfirm({ title: 'Ungespeicherte Eingaben', message: 'Es gibt ungespeicherte Eingaben. Verwerfen und fortfahren?', confirmLabel: 'Verwerfen', danger: true });
  if (ok) unsaved.clear();
  return ok;
}

// ---------------------------------------------------------------------------------------------
// Symbole (Emojis, ⋯, ▾) für Hilfstechnik ausblenden
// ---------------------------------------------------------------------------------------------

/**
 * Dekoratives Symbol, das Screenreader überspringen (aria-hidden). Die Bedeutung trägt der Text daneben:
 * `<button><Icon>🐞</Icon> Fehler verknüpfen</button>`. Steht das Symbol allein, braucht der Knopf ein `aria-label`.
 */
export function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return <span aria-hidden="true" className={className ? `icon ${className}` : 'icon'}>{children}</span>;
}

const LEADING_SYMBOL = /^([\p{Extended_Pictographic}←-⯿️‍]+)\s*/u;
const TRAILING_SYMBOL = /\s*([▾▸▴↗→⧉↵]+)$/u;

/** Text mit führendem bzw. abschließendem Symbol („🐞 Fehler verknüpfen“, „Mehr ▾“): Symbol als <Icon>, Text bleibt. */
export function withIcons(text: string): ReactNode {
  const lead = LEADING_SYMBOL.exec(text);
  const rest = lead ? text.slice(lead[0].length) : text;
  const trail = TRAILING_SYMBOL.exec(rest);
  const core = trail ? rest.slice(0, rest.length - trail[0].length) : rest;
  if (!core.trim() || (!lead && !trail)) return text; // nur Symbol: Name muss von außen kommen (aria-label)
  return <>{lead && <><Icon>{lead[1]}</Icon> </>}{core}{trail && <> <Icon>{trail[1]}</Icon></>}</>;
}

// ---------------------------------------------------------------------------------------------
// Fokusführung (Dialoge, Menüs)
// ---------------------------------------------------------------------------------------------

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, '
  + '[tabindex]:not([tabindex="-1"]), [contenteditable="true"], [contenteditable=""]';

/** Sichtbare, per Tab erreichbare Elemente in Dokumentreihenfolge. */
export function focusables(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => e.tabIndex >= 0 && e.getClientRects().length > 0
    && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[inert], [aria-hidden="true"]'));
}

const FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), select, textarea, [contenteditable="true"], [contenteditable=""]';

/** Startfokus eines Dialogs: erstes Eingabefeld im Inhalt, sonst der Primärknopf, sonst das erste Bedienelement. */
function initialFocus(root: HTMLElement): HTMLElement | null {
  const body = root.querySelector<HTMLElement>('.modal-body') ?? root;
  const list = focusables(body);
  return list.find((e) => e.matches(FIELD))
    ?? root.querySelector<HTMLElement>('.modal-foot button.primary:not(:disabled)')
    ?? list[0] ?? null;
}

const trapStack: HTMLElement[] = [];
/** Auslöser je geöffnetem Menü – Ziel der Fokusrückgabe, wenn ein Dialog aus einem Menüeintrag geöffnet wurde. */
const panelTriggers = new WeakMap<Element, () => HTMLElement | null>();

/**
 * Fokusfalle für modale Ebenen: Startfokus setzen (sofern nicht schon ein autoFocus-Feld im Dialog den Fokus hat),
 * Tab/Umschalt+Tab im Dialog halten (nur die oberste Ebene) und beim Schließen den Fokus an das auslösende Element
 * zurückgeben. Das Wurzelelement braucht `tabIndex={-1}`.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, initial?: (root: HTMLElement) => HTMLElement | null | undefined): void {
  // vor dem Einhängen merken – autoFocus im Dialog verschiebt den Fokus schon beim Einfügen
  const [previous] = useState(() => {
    const a = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null;
    // aus einem Menü heraus geöffnet: der Menüeintrag verschwindet gleich – dann zum Auslöser des Menüs zurück
    const panel = a?.closest('.drop-panel');
    return { el: a, fallback: panel ? panelTriggers.get(panel) : undefined };
  });
  const pick = useRef(initial);
  pick.current = initial;
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    trapStack.push(root);
    if (!root.contains(document.activeElement)) (pick.current?.(root) ?? initialFocus(root) ?? root).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented || trapStack.at(-1) !== root) return; // Editoren nutzen Tab selbst (Einrücken)
      const list = focusables(root);
      const active = document.activeElement;
      if (!list.length) { e.preventDefault(); root.focus(); return; }
      if (e.shiftKey && (active === list[0] || !root.contains(active) || active === root)) { e.preventDefault(); list.at(-1)!.focus(); }
      else if (!e.shiftKey && (active === list.at(-1) || !root.contains(active))) { e.preventDefault(); list[0]!.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      trapStack.splice(trapStack.indexOf(root), 1);
      const active = document.activeElement;
      const back = previous.el?.isConnected ? previous.el : previous.fallback?.();
      if (back && (!active || active === document.body || root.contains(active))) back.focus({ preventScroll: true });
    };
  }, [ref, previous]);
}

// ---------------------------------------------------------------------------------------------
// Rückmeldungen (Toasts)
// ---------------------------------------------------------------------------------------------

type Tone = 'ok' | 'bad' | 'info';
type ToastItem = { id: number; text: string; tone: Tone; count: number; stamp: number };
const toastBus = new EventTarget();
let nextToast = 1;
const TOAST_MS = 6000;

/**
 * Kurze Rückmeldung. Erfolg/Info verschwinden nach 6 s (Pause bei Mauszeiger oder Fokus), Fehler („bad“) bleiben,
 * bis sie geschlossen werden, und werden sofort angesagt. Gleiche Meldungen werden zusammengefasst („3× …“).
 */
export function toast(text: string, tone: Tone = 'ok'): void {
  toastBus.dispatchEvent(new CustomEvent('toast', { detail: { text, tone } }));
}

export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const { text, tone } = (e as CustomEvent<{ text: string; tone: Tone }>).detail;
      setItems((xs) => {
        const same = xs.find((x) => x.text === text && x.tone === tone);
        if (same) return xs.map((x) => (x === same ? { ...x, count: x.count + 1, stamp: Date.now() } : x));
        return [...xs, { id: nextToast++, text, tone, count: 1, stamp: Date.now() }].slice(-8);
      });
    };
    toastBus.addEventListener('toast', on);
    return () => toastBus.removeEventListener('toast', on);
  }, []);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const list = (bad: boolean) => items.filter((t) => (t.tone === 'bad') === bad).map((t) => <ToastView key={t.id} t={t} onClose={dismiss} />);
  // zwei dauerhafte Live-Regionen: Fehler sofort (alert), sonst höflich (status)
  return (
    <div className="toasts">
      <div className="toast-list" role="alert">{list(true)}</div>
      <div className="toast-list" role="status" aria-live="polite">{list(false)}</div>
    </div>
  );
}

function ToastView({ t, onClose }: { t: ToastItem; onClose: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(TOAST_MS);
  useEffect(() => { remaining.current = TOAST_MS; }, [t.stamp]);
  useEffect(() => {
    if (t.tone === 'bad' || paused) return;
    const start = Date.now();
    const timer = setTimeout(() => onClose(t.id), remaining.current);
    return () => { clearTimeout(timer); remaining.current = Math.max(1500, remaining.current - (Date.now() - start)); };
  }, [paused, t.stamp, t.tone, t.id, onClose]);
  return (
    <div className={`toast ${t.tone}`} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false); }}>
      <span className="toast-text">{t.count > 1 && <span className="toast-count">{t.count}× </span>}{t.text}</span>
      <button type="button" className="ghost small toast-close" onClick={() => onClose(t.id)} aria-label="Meldung schließen" title="Schließen">✕</button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Dialoge (statt prompt/confirm)
// ---------------------------------------------------------------------------------------------

interface AskText { kind: 'text'; title: string; label?: string; initial?: string; placeholder?: string; multiline?: boolean; required?: boolean; confirmLabel?: string; hint?: string; resolve: (v: string | null) => void }
interface AskConfirm { kind: 'confirm'; title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; resolve: (v: boolean) => void }
type Ask = AskText | AskConfirm;
const dialogBus = new EventTarget();

export function askText(o: Omit<AskText, 'kind' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => dialogBus.dispatchEvent(new CustomEvent('ask', { detail: { ...o, kind: 'text', resolve } })));
}
/** Rückfrage; mit `danger` liegt der Startfokus auf „Abbrechen“ (Enter löst dann nichts Endgültiges aus). */
export function askConfirm(o: Omit<AskConfirm, 'kind' | 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => dialogBus.dispatchEvent(new CustomEvent('ask', { detail: { ...o, kind: 'confirm', resolve } })));
}

export function DialogHost() {
  const [ask, setAsk] = useState<(Ask & { seq: number }) | null>(null);
  useEffect(() => {
    let seq = 0;
    const on = (e: Event) => setAsk({ ...(e as CustomEvent<Ask>).detail, seq: ++seq });
    dialogBus.addEventListener('ask', on);
    return () => dialogBus.removeEventListener('ask', on);
  }, []);
  if (!ask) return null;
  return <AskView key={ask.seq} ask={ask} onDone={() => setAsk(null)} />;
}

function AskView({ ask, onDone }: { ask: Ask; onDone: () => void }) {
  const [value, setValue] = useState(ask.kind === 'text' ? ask.initial ?? '' : '');
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useFocusTrap(ref, (root) => root.querySelector<HTMLElement>(ask.kind === 'text' ? 'input, textarea' : ask.danger ? '[data-safe]' : '[data-primary]'));
  const close = (ok: boolean) => {
    if (ask.kind === 'text') ask.resolve(ok ? value.trim() : null);
    else ask.resolve(ok);
    onDone();
  };
  const disabled = ask.kind === 'text' && ask.required !== false && !value.trim();
  const describedBy = ask.kind === 'confirm' ? `${id}-d` : ask.hint ? `${id}-h` : undefined;
  return (
    <div className="modal-backdrop dialog-layer" onMouseDown={(e) => e.target === e.currentTarget && close(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        // Enter bestätigt nur im einzeiligen Textfeld; sonst gilt der fokussierte Knopf (bei „danger“: Abbrechen)
        if (e.key === 'Enter' && ask.kind === 'text' && !ask.multiline && (e.target as HTMLElement).tagName === 'INPUT' && !disabled) { e.preventDefault(); close(true); }
      }}>
      <div ref={ref} tabIndex={-1} className="modal small-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={describedBy}>
        <div className="modal-head"><h3 id={`${id}-t`}>{ask.title}</h3></div>
        <div className="modal-body">
          {ask.kind === 'confirm' ? <div id={`${id}-d`}>{ask.message}</div> : (
            <label className="field">{ask.label}
              {ask.multiline
                ? <textarea rows={5} value={value} placeholder={ask.placeholder} aria-label={ask.label ? undefined : ask.title} aria-describedby={describedBy} onChange={(e) => setValue(e.target.value)} />
                : <input value={value} placeholder={ask.placeholder} aria-label={ask.label ? undefined : ask.title} aria-describedby={describedBy} onChange={(e) => setValue(e.target.value)} />}
              {ask.hint && <span id={`${id}-h`} className="small muted">{ask.hint}</span>}
            </label>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" data-safe onClick={() => close(false)}>Abbrechen</button>
          <button type="button" data-primary className={ask.kind === 'confirm' && ask.danger ? 'primary danger-fill' : 'primary'} disabled={disabled}
            onClick={() => close(true)}>{ask.confirmLabel ?? (ask.kind === 'confirm' ? 'OK' : 'Übernehmen')}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Aktionsmenü und Tastenkürzel
// ---------------------------------------------------------------------------------------------

const MENU_ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

/**
 * Aufklappendes Menü als schwebende Ebene (Portal, position: fixed): wird nicht von scrollenden Bereichen
 * abgeschnitten und bleibt im Fenster – rechtsbündig zum Knopf, bei Platzmangel nach rechts verschoben.
 *
 * Tastatur: Beim Öffnen erhält der erste Eintrag den Fokus; ↑/↓/Pos1/Ende wechseln zwischen den Einträgen
 * (`role="menuitem"`, sonst Knöpfe und Links), ein Buchstabe springt zum passenden Eintrag. Esc schließt und
 * fokussiert den Auslöser, Tab schließt und geht vom Auslöser aus weiter. Nach einer Auswahl steht der Fokus wieder
 * auf dem Auslöser (ein daraus geöffneter Dialog gibt ihn beim Schließen dorthin zurück).
 */
export function DropPanel({ anchor, onClose, className = '', style, role, label, id, children }: {
  anchor: RefObject<HTMLElement | null>; onClose: () => void; className?: string; style?: CSSProperties; role?: string;
  /** zugänglicher Name des Menüs */
  label?: string; id?: string; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const w = panel.current?.offsetWidth ?? 260;
      if (!a) return;
      const vw = document.documentElement.clientWidth;
      setPos({ top: a.bottom + 6, left: Math.max(8, Math.min(a.right - w, vw - w - 8)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor]);
  const trigger = useCallback((): HTMLElement | null => {
    const a = anchor.current;
    if (!a) return null;
    return a.matches(FOCUSABLE) ? a : a.querySelector<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])');
  }, [anchor]);
  const close = useCallback(() => { trigger()?.focus({ preventScroll: true }); onClose(); }, [trigger, onClose]);
  const items = (): HTMLElement[] => {
    const p = panel.current;
    if (!p) return [];
    const menu = [...p.querySelectorAll<HTMLElement>(MENU_ITEM)];
    return menu.length ? menu : focusables(p).filter((e) => e.matches('button, a[href]'));
  };
  useEffect(() => {
    const p = panel.current;
    if (p) panelTriggers.set(p, trigger);
    const list = items();
    const first = list.find((e) => e.getAttribute('aria-disabled') !== 'true') ?? list[0] ?? (p ? focusables(p)[0] : undefined);
    first?.focus({ preventScroll: true });
    return () => {
      // geschlossen (Auswahl, Klick daneben): Fokus zurück an den Auslöser, sofern ihn nicht schon ein Dialog hat
      const active = document.activeElement;
      if (!active || active === document.body || p?.contains(active)) trigger()?.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Esc auch dann, wenn der Fokus außerhalb des Menüs steht (z. B. nach einem Mausklick daneben)
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) close(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [close]);
  const onKeyDown = (e: RKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    const list = items();
    const inField = target.matches(FIELD);
    if (e.key === 'Tab') {
      // Menü: Tab verlässt es; Formular-Panel: erst an den Rändern
      const all = panel.current ? focusables(panel.current) : [];
      const leaving = list.length && panel.current?.querySelector(MENU_ITEM) ? true
        : e.shiftKey ? target === all[0] : target === all.at(-1);
      if (leaving) close(); // kein preventDefault: Tab geht vom Auslöser aus weiter
      return;
    }
    if (inField || !list.length || e.altKey || e.ctrlKey || e.metaKey) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    let n = -1;
    if (e.key === 'ArrowDown') n = (i + 1) % list.length;
    else if (e.key === 'ArrowUp') n = i <= 0 ? list.length - 1 : i - 1;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = list.length - 1;
    else if (e.key.length === 1 && /\p{L}|\p{N}/u.test(e.key)) {
      const k = e.key.toLowerCase();
      const text = (el: HTMLElement) => (el.textContent ?? '').replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
      const order = [...list.slice(i + 1), ...list.slice(0, i + 1)];
      const hit = order.find((el) => text(el).startsWith(k));
      if (hit) n = list.indexOf(hit);
    }
    if (n >= 0) { e.preventDefault(); list[n]!.focus(); }
  };
  return createPortal(<>
    <div className="qs-backdrop" onClick={close} />
    <div ref={panel} id={id} role={role} aria-label={label} className={`account-panel drop-panel ${className}`} onKeyDown={onKeyDown}
      style={{ ...style, top: pos?.top ?? -9999, left: pos?.left ?? -9999, maxHeight: pos ? `calc(100vh - ${pos.top + 8}px)` : undefined }}>
      {children}
    </div>
  </>, document.body);
}

/**
 * Eintrag eines Aktionsmenüs. `disabled`: sichtbar, aber nicht auslösbar (aria-disabled); der Grund steht in
 * `reason` (oder `title`) und erscheint als Untertitel und Tooltip.
 */
export interface MenuAction { label: string; title?: string; onClick: () => void; hidden?: boolean; disabled?: boolean; reason?: string }

/**
 * „⋯ Mehr“: seltene Aktionen gebündelt, damit Kopfzeilen ruhig bleiben. Besteht `label` nur aus einem Symbol
 * (z. B. „⋯“), sollte `ariaLabel` den Bezug nennen („Weitere Aktionen zu DEMO-T1“).
 */
export function ActionMenu({ label = '⋯ Mehr', ariaLabel, items }: { label?: string; ariaLabel?: string; items: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuId = useId();
  const visible = items.filter((i) => !i.hidden);
  const close = useCallback(() => setOpen(false), []);
  if (!visible.length) return null;
  const menuName = ariaLabel ?? (label.replace(/[^\p{L}\p{N}\s-]/gu, '').trim() || 'Weitere Aktionen');
  return (
    <span className="account" ref={anchorRef}>
      <button type="button" className="small" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel} onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true); } }}>{withIcons(label)}</button>
      {open && (
        <DropPanel anchor={anchorRef} onClose={close} className="action-menu" role="menu" label={menuName} id={menuId}>
          {visible.map((i) => {
            const sub = i.disabled ? i.reason ?? i.title : i.title;
            return (
              <button key={i.label} type="button" role="menuitem" tabIndex={-1} className={`ghost ${i.disabled ? 'is-disabled' : ''}`}
                aria-disabled={i.disabled || undefined} title={i.disabled ? sub : undefined}
                onClick={() => { if (i.disabled) return; setOpen(false); i.onClick(); }}>
                <span>{withIcons(i.label)}</span>{sub && <span className="small muted">{sub}</span>}
              </button>
            );
          })}
        </DropPanel>
      )}
    </span>
  );
}

const SHORTCUTS: { area: string; keys: [string, string][] }[] = [
  { area: 'Überall', keys: [['Strg/⌘ + K', 'Schnellsuche'], ['F1', 'Hilfe zur aktuellen Ansicht ein- und ausblenden'], ['?', 'Diese Übersicht'], ['Esc', 'Dialog bzw. Menü schließen'], ['↓ / ↑ / Pos1 / Ende', 'Im geöffneten Menü wechseln']] },
  { area: 'Durchführung', keys: [['j / k  bzw. ↓ / ↑', 'Schritt wechseln'], ['p', 'Schritt bestanden, weiter zum nächsten'], ['f', 'Schritt fehlgeschlagen'],
    ['b', 'Schritt blockiert'], ['n', 'Schritt zurücksetzen'], ['c', 'Befund zum Schritt schreiben'], ['Strg/⌘ + S', 'Ergebnis speichern'],
    ['Strg/⌘ + Enter', 'Speichern & weiter (Fokusfenster)']] },
  { area: 'Editoren (Testfall, Texte)', keys: [['Strg/⌘ + S', 'Testfall speichern'], ['Strg/⌘ + B / I / U', 'Fett / kursiv / unterstrichen'],
    ['Strg/⌘ + K', 'Link einfügen (im Textfeld)'], ['Strg/⌘ + V', 'Screenshot einfügen'], ['Tab / Umschalt + Tab', 'Listeneintrag ein-/ausrücken']] },
];

export const SHORTCUT_EVENT = 'anemo:shortcuts';
export const showShortcuts = () => window.dispatchEvent(new Event(SHORTCUT_EVENT));

/** Übersicht der Tastenkürzel; öffnet mit „?“ (außerhalb von Eingabefeldern) oder über das Kontomenü. */
export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (e.key === 'Escape') setOpen(false);
      if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey || t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('.modal-backdrop')) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    const onShow = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(SHORTCUT_EVENT, onShow);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(SHORTCUT_EVENT, onShow); };
  }, []);
  if (!open) return null;
  return <ShortcutDialog onClose={() => setOpen(false)} />;
}

function ShortcutDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, (root) => root.querySelector<HTMLElement>('.modal-head button'));
  return (
    <div className="modal-backdrop dialog-layer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-label="Tastenkürzel" style={{ width: 'min(640px, 100%)' }}>
        <div className="modal-head"><h3>Tastenkürzel</h3><span className="spacer" /><button className="ghost" onClick={onClose} aria-label="Schließen">✕</button></div>
        <div className="modal-body stack">
          {SHORTCUTS.map((g) => (
            <div key={g.area}><h4>{g.area}</h4>
              <table className="shortcut-table"><tbody>{g.keys.map(([k, d]) => (
                <tr key={k}><td>{k.split(/(\s\+\s|\s\/\s|\s+bzw\.\s+)/).map((p, i) => (/^\s/.test(p) ? <span key={i} className="muted">{p}</span> : <kbd key={i} className="kbd">{p}</kbd>))}</td><td>{d}</td></tr>
              ))}</tbody></table>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Plattformgerechte Zusatztaste: „⌘“ auf Apple-Geräten, sonst „Strg“. */
export const IS_APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? navigator.userAgent);
export const MOD_KEY = IS_APPLE ? '⌘' : 'Strg';
/** Tastenkürzel-Hinweise nur bei Maus/Trackpad zeigen (auf Touchgeräten gibt es meist keine Tastatur). */
export const hasFinePointer = () => typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

// ---------------------------------------------------------------------------------------------
// Parametrisierte Tests und Dauer
// ---------------------------------------------------------------------------------------------

/** Platzhalter einsetzen: ${spalte} (klassisch) und <spalte> (Gherkin). */
export function fillParams(text: string, values: Record<string, string> | null | undefined): string {
  if (!values || !text) return text;
  return text.replace(/\$\{([^}]+)\}|<([^<>\s][^<>]*)>/g, (m, a: string | undefined, b: string | undefined) => {
    const k = (a ?? b ?? '').trim();
    return Object.hasOwn(values, k) ? values[k]! : m;
  });
}

/** Schätzung aus „90“, „1h 30m“, „1,5 h“, „2d“ (Arbeitstag = 8 h) in Minuten; null bei leer, NaN bei unlesbar. */
export function parseEstimate(s: string): number | null {
  const t = s.trim().toLowerCase().replace(',', '.');
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  let total = 0;
  let ok = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(w|d|t|h|std|m|min)\w*/g)) {
    ok = true;
    const n = Number(m[1]);
    total += m[2] === 'w' ? n * 2400 : m[2] === 'd' || m[2] === 't' ? n * 480 : m[2] === 'h' || m[2] === 'std' ? n * 60 : n;
  }
  return ok ? Math.round(total) : Number.NaN;
}
export const fmtMinutes = (m: number | null | undefined) => (m === null || m === undefined ? '–' : fmtDuration(m * 60));

/** Dauer lesbar: 45 s, 12 min, 1 h 05 min */
export function fmtDuration(s: number | null | undefined): string {
  if (!s) return '–';
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/**
 * Aktive Bearbeitungszeit messen: zählt nur bei sichtbarem Fenster und Aktivität – nach 5 Minuten ohne Eingabe
 * (Maus, Tastatur, Scrollen) ruht die Uhr bis zur nächsten Eingabe (Mittagspause, verdeckte Fenster).
 * peek() liefert die Sekunden seit dem letzten take(); take() setzt zurück (erst nach erfolgreichem Speichern aufrufen).
 */
export function useActiveTimer(idleMs = 5 * 60_000): { take: () => number; peek: () => number } {
  const acc = useRef(0);
  const since = useRef<number | null>(null);
  const lastInput = useRef(Date.now());
  const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
  const pause = (at = Date.now()) => {
    if (since.current !== null) { acc.current += Math.max(0, at - since.current); since.current = null; }
  };
  useEffect(() => {
    if (visible()) since.current = Date.now();
    const onVis = () => (visible() ? (since.current = Date.now(), lastInput.current = Date.now()) : pause());
    const onInput = () => {
      const now = Date.now();
      if (since.current === null && visible()) since.current = now;
      lastInput.current = now;
    };
    // Leerlauf: Uhr beim letzten Input anhalten (die Leerlaufzeit zählt nicht)
    const idle = setInterval(() => { if (since.current !== null && Date.now() - lastInput.current > idleMs) pause(lastInput.current + 1000); }, 15_000);
    document.addEventListener('visibilitychange', onVis);
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'pointermove'] as const) window.addEventListener(ev, onInput, { passive: true });
    return () => {
      clearInterval(idle);
      document.removeEventListener('visibilitychange', onVis);
      for (const ev of ['pointerdown', 'keydown', 'wheel', 'pointermove'] as const) window.removeEventListener(ev, onInput);
    };
  }, [idleMs]);
  const peek = () => Math.round((acc.current + (since.current !== null ? Math.max(0, Math.min(Date.now(), lastInput.current + idleMs) - since.current) : 0)) / 1000);
  return {
    peek,
    take: () => {
      const s = peek();
      acc.current = 0;
      since.current = visible() ? Date.now() : null;
      return s;
    },
  };
}
