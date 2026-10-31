/**
 * Kleine Texthilfen für Zahlenangaben und Zeiträume in der Oberfläche.
 */

/** „1 Zyklus“, „3 Zyklen“ – mit deutscher Tausendertrennung. */
export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('de-DE')} ${n === 1 ? one : many}`;
}

/** Nur das passende Wort ohne Zahl („Testfall“ bzw. „Testfälle“). */
export const pluralWord = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * Zeitraum aus zwei bereits formatierten Datumsangaben: „5.10.2026 – 9.10.2026“, „ab 5.10.2026“, „bis 9.10.2026“
 * oder „–“, wenn beide fehlen. Formatierer liefern für fehlende Werte oft selbst „–“ – das gilt hier als leer.
 */
export function fmtRange(from: string | null | undefined, to: string | null | undefined): string {
  const f = from && from !== '–' ? from : '';
  const t = to && to !== '–' ? to : '';
  if (f && t) return `${f} – ${t}`;
  if (f) return `ab ${f}`;
  if (t) return `bis ${t}`;
  return '–';
}

/** „N von M angezeigt“-Hinweis für Listen mit fester Obergrenze; null, wenn alles sichtbar ist. */
export function limitHint(shown: number, total: number | null | undefined, refine = 'Suche verfeinern'): string | null {
  if (total === null || total === undefined || total <= shown) return null;
  return `${shown.toLocaleString('de-DE')} von ${total.toLocaleString('de-DE')} angezeigt – ${refine}`;
}
