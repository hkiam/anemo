import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.ts';

/**
 * Persönliche Einstellung (auf dem Server je Benutzer, damit sie an jedem Rechner gilt). Ein lokaler Zwischenspeicher
 * sorgt dafür, dass die Seite gleich im gespeicherten Zustand aufgebaut wird; Änderungen werden gebündelt gespeichert.
 */
export function usePreference<T>(name: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const cacheKey = `anemo.pref.${name}`;
  const read = (): T => { try { const s = localStorage.getItem(cacheKey); return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } };
  const [value, setValue] = useState<T>(read);
  const latest = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touched = useRef(false);
  useEffect(() => {
    touched.current = false;
    const v = read();
    latest.current = v;
    setValue(v);
    let cancelled = false;
    api<{ value: T | null }>('GET', `/api/me/preferences/${name}`).then((r) => {
      // eine schon begonnene Änderung nicht vom (älteren) Serverstand überschreiben lassen
      if (cancelled || touched.current || r.value === null) return;
      latest.current = r.value;
      setValue(r.value);
      try { localStorage.setItem(cacheKey, JSON.stringify(r.value)); } catch { /* egal */ }
    }).catch(() => { /* Standard bzw. lokaler Stand */ });
    return () => { cancelled = true; };
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = useCallback((v: T | ((prev: T) => T)) => {
    const next = typeof v === 'function' ? (v as (p: T) => T)(latest.current) : v;
    touched.current = true;
    latest.current = next;
    setValue(next);
    try { localStorage.setItem(cacheKey, JSON.stringify(next)); } catch { /* egal */ }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void api('PUT', `/api/me/preferences/${name}`, { value: next }).catch(() => { /* bleibt lokal */ }); }, 700);
  }, [name, cacheKey]);
  return [value, update];
}

/** Spaltenbreiten in Pixeln je Spaltenname; fehlend = Standard aus dem Stylesheet. */
export type ColumnWidths = Record<string, number | undefined>;

/**
 * Ziehgriff zwischen zwei Spalten eines Rasters (role="separator"). Er sitzt am rechten Rand von `pane` und wird
 * über dem Raster positioniert, damit er beim Scrollen der Spalte stehen bleibt. Ziehen, Pfeiltasten (Umschalt =
 * größere Schritte) oder Doppelklick (= Standardbreite).
 */
export function ColumnHandle({ container, pane, label, min, max, onResize, onReset, layout }: {
  container: RefObject<HTMLElement | null>; pane: RefObject<HTMLElement | null>; label: string;
  min: number; max: () => number; onResize: (px: number) => void; onReset: () => void;
  /** ändert sich, wenn sich links davon etwas verschiebt (z. B. Breite der vorigen Spalte) */
  layout?: unknown;
}) {
  const [left, setLeft] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  // nach dem Rendern messen: der Griff steht im DOM vor den Spalten, deren Refs sind im Layout-Effekt noch nicht gesetzt
  useEffect(() => {
    const c = container.current;
    const p = pane.current;
    if (!c || !p) return;
    // ausgeblendete Spalte (display: none) → kein Griff
    const place = () => { setLeft(p.offsetWidth ? p.offsetLeft + p.offsetWidth : null); setNow(Math.round(p.offsetWidth)); };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(c);
    ro.observe(p);
    return () => ro.disconnect();
  }, [container, pane, layout]);
  const clamp = (px: number) => Math.round(Math.max(min, Math.min(Math.max(min, max()), px)));
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !pane.current) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = pane.current.offsetWidth;
    document.body.classList.add('col-resizing');
    const move = (ev: PointerEvent) => onResize(clamp(start + ev.clientX - startX));
    const up = () => {
      document.body.classList.remove('col-resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const cur = pane.current?.offsetWidth ?? now;
    if (e.key === 'ArrowLeft') { e.preventDefault(); onResize(clamp(cur - step)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); onResize(clamp(cur + step)); }
    else if (e.key === 'Home') { e.preventDefault(); onResize(min); }
    else if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); onReset(); }
  };
  if (left === null) return null;
  return (
    <div className="col-handle" style={{ left }} role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
      aria-valuenow={now} aria-valuemin={min} title={`${label}: ziehen; Doppelklick oder Enter = Standardbreite`}
      onPointerDown={onPointerDown} onDoubleClick={onReset} onKeyDown={onKeyDown} />
  );
}

/**
 * Seitenlayout mit verstellbarer linker Spalte (Klasse `planning`: Planung, Test-Health, Handbuch). Die Breite gilt
 * je Seite (`name`) und wird persönlich gespeichert. Die linke Spalte ist das erste Kind.
 */
export function SideLayout({ name, className = '', children }: { name: string; className?: string; children: ReactNode }) {
  const [width, setWidth] = usePreference<number | null>(`layout.${name}`, null);
  const container = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement | null>(null);
  const [ready, setReady] = useState(0);
  useLayoutEffect(() => {
    const first = container.current?.querySelector<HTMLElement>(':scope > :not(.col-handle)') ?? null;
    if (first !== pane.current) { pane.current = first; setReady((r) => r + 1); }
  });
  const style = width ? { ['--col-1' as string]: `${width}px` } as CSSProperties : undefined;
  return (
    <div ref={container} className={`planning resizable ${className}`} style={style}>
      <ColumnHandle container={container} pane={pane} layout={ready} label="Breite der Navigation" min={180}
        max={() => Math.min(640, (container.current?.clientWidth ?? 1200) - 480)}
        onResize={setWidth} onReset={() => setWidth(null)} />
      {children}
    </div>
  );
}
