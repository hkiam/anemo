/**
 * Farbhilfen für lesbare Kontraste (WCAG 2.2, 1.4.3): Textfarbe auf frei gewählten Status-/Prioritätsfarben,
 * Kontrastverhältnis und eine abgedunkelte bzw. aufgehellte Variante für Text in Statusfarbe.
 */
import type { CSSProperties } from 'react';

/** Dunkle Schrift auf hellen Flächen – dunkler als --text, damit auch mittlere Töne (z. B. #2E8B57) ≥ 4,5:1 erreichen. */
export const DARK_TEXT = '#0b0f14';
export const LIGHT_TEXT = '#ffffff';

type Rgb = [number, number, number];

/** #rgb, #rgba, #rrggbb, #rrggbbaa sowie rgb()/rgba(); Alphakanal wird ignoriert. */
export function parseColor(c: string | null | undefined): Rgb | null {
  if (!c) return null;
  const s = c.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((x) => x + x).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Relative Luminanz 0 (schwarz) … 1 (weiß); unlesbare Farben gelten als mittelgrau. */
export function luminance(c: string | Rgb | null | undefined): number {
  const rgb = Array.isArray(c) ? c : parseColor(c as string | null | undefined);
  if (!rgb) return 0.2;
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** Kontrastverhältnis zweier Farben (1 … 21). */
export function contrast(a: string | Rgb, b: string | Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Lesbare Schriftfarbe auf einer Hintergrundfarbe: Weiß, solange es ≥ 4,5:1 erreicht, sonst die Farbe mit dem
 * höheren Kontrast (in der Regel fast schwarz). Beispiel: `style={{ background: s.color, color: readableOn(s.color) }}`.
 */
export function readableOn(bg: string | null | undefined): string {
  const white = contrast(LIGHT_TEXT, bg ? parseColor(bg) ?? [128, 128, 128] : [128, 128, 128]);
  if (white >= 4.5) return LIGHT_TEXT;
  const dark = contrast(DARK_TEXT, bg ? parseColor(bg) ?? [128, 128, 128] : [128, 128, 128]);
  return dark >= white ? DARK_TEXT : LIGHT_TEXT;
}

/** Füllung in Statusfarbe mit passender Schrift – für gewählte Statusknöpfe, Balkenbeschriftungen u. Ä. */
export function fillStyle(color: string | null | undefined): CSSProperties {
  const c = color ?? '#888888';
  return { background: c, borderColor: c, color: readableOn(c) };
}

const hex = (rgb: Rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

/**
 * Textfarbe in Statusfarbe, aber lesbar: mischt `fg` schrittweise mit Schwarz (auf hellem `bg`) bzw. Weiß (auf dunklem
 * `bg`), bis das Kontrastverhältnis `min` erreicht ist. Für Text, der die Statusfarbe tragen soll (Legenden, Zahlen).
 */
export function ensureContrast(fg: string, bg: string, min = 4.5): string {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return fg;
  if (contrast(f, b) >= min) return hex(f);
  const target: Rgb = luminance(b) > 0.18 ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const mix = f.map((v, i) => v + (target[i]! - v) * t) as Rgb;
    if (contrast(mix, b) >= min) return hex(mix);
  }
  return hex(target);
}

/** Durchscheinende Variante einer Hex-Farbe (#rrggbb + Alpha), z. B. als Badge-Hintergrund. */
export function tint(color: string | null | undefined, alpha: number): string {
  const rgb = parseColor(color);
  if (!rgb) return 'transparent';
  return `${hex(rgb)}${Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0')}`;
}
