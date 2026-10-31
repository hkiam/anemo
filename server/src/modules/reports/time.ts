/**
 * Datum und Zeit in Berichten – einheitlich in Europe/Berlin (Fach-Review Teil 3, Befund 12): Berichtszeitraum,
 * Stichtag, Burn-down und Cockpit bilden Tagesgrenzen in derselben Zeitzone, unabhängig von der Zeitzone des
 * Server-Prozesses (im Container meist UTC). Arbeitstage werden rechnerisch bestimmt, nicht per Tagesschleife.
 */
import { badRequest } from '../../platform/http.ts';

export const REPORT_TZ = 'Europe/Berlin';

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function parts(d: Date) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Kalendertag (YYYY-MM-DD) eines Zeitpunkts in Europe/Berlin – auch für Jahre < 1000 vierstellig. */
export function berlinDay(d: Date): string {
  const p = parts(d);
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
}

/** Abstand Europe/Berlin zu UTC in Minuten zu einem Zeitpunkt (Sommerzeit +120, Winterzeit +60). */
function offsetMinutes(d: Date): number {
  const p = parts(d);
  const local = new Date(0);
  local.setUTCFullYear(p.y, p.m - 1, p.d);
  local.setUTCHours(p.h, p.mi, p.s, 0);
  return Math.round((local.getTime() - (d.getTime() - d.getUTCMilliseconds())) / 60_000);
}

/** Zeitpunkt zu Kalendertag und Uhrzeit in Europe/Berlin. */
export function berlinTime(day: string, time = '00:00:00.000'): Date {
  const guess = new Date(`${day}T${time}Z`);
  let at = new Date(guess.getTime() - offsetMinutes(guess) * 60_000);
  const second = offsetMinutes(at); // an der Umstellung auf Sommer-/Winterzeit nachkorrigieren
  if (second !== offsetMinutes(guess)) at = new Date(guess.getTime() - second * 60_000);
  return at;
}
/** Beginn (00:00) bzw. Ende (23:59:59,999) eines Kalendertags in Europe/Berlin. */
export const berlinDayStart = (day: string) => berlinTime(day, '00:00:00.000');
export const berlinDayEnd = (day: string) => berlinTime(day, '23:59:59.999');

/**
 * Plausible Datumswerte für Berichte (Zyklusdaten, Berichtszeitraum, Stichtag). Außerhalb dieses Bereichs werden
 * Zyklusdaten ignoriert bzw. Anfragen mit 400 abgelehnt – statt Rechenschleifen über Jahrtausende oder 500.
 */
export const PLAUSIBLE = { from: '2000-01-01', to: '2100-12-31' };
export const isPlausibleDay = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && s >= PLAUSIBLE.from && s <= PLAUSIBLE.to;
export function requirePlausibleDay(s: string, what: string): string {
  if (!isPlausibleDay(s)) throw badRequest(`${what}: Datum außerhalb des unterstützten Bereichs (${PLAUSIBLE.from.slice(0, 4)}–${PLAUSIBLE.to.slice(0, 4)})`);
  return s;
}

// ---- Kalendertage und Arbeitstage (Mo–Fr) rechnerisch ----

/** Tagesnummer seit 1970-01-01 (UTC-Kalender, ohne Zeitzone) */
export const dayNo = (s: string) => Math.round(new Date(`${s}T00:00:00Z`).getTime() / 86_400_000);
export const fromDayNo = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => fromDayNo(dayNo(s) + n);
// Index 0 = Montag, 1970-01-05
const mondayIdx = (s: string) => dayNo(s) - 4;
const mod = (a: number, b: number) => ((a % b) + b) % b;
/** Anzahl Arbeitstage vor dem Tag mit Montagsindex k (relativ zum Ursprung) */
const workdaysBefore = (k: number) => Math.floor(k / 7) * 5 + Math.min(mod(k, 7), 5);
export const isWorkday = (s: string) => mod(mondayIdx(s), 7) < 5;
/** Arbeitstage im halboffenen Intervall [a, b) */
export const workdays = (a: string, b: string) => (b > a ? workdaysBefore(mondayIdx(b)) - workdaysBefore(mondayIdx(a)) : 0);
/** Verspätung in Arbeitstagen: Arbeitstage nach `end` bis einschließlich `forecast` (endet der Plan am Wochenende, zählt der Montag danach als 1). */
export const workdaysLate = (end: string, forecast: string) => (forecast > end ? workdays(addDays(end, 1), addDays(forecast, 1)) : 0);
/** n-ter Arbeitstag nach dem Tag s (n ≥ 1) */
export function addWorkdays(s: string, n: number): string {
  const target = workdaysBefore(mondayIdx(s) + 1) + n - 1;
  return fromDayNo(Math.floor(target / 5) * 7 + mod(target, 5) + 4);
}
/** Erster der letzten n Arbeitstage bis einschließlich `s` (Fenster für das Tempo; Wochenenden liegen darin). */
export function workdayWindowStart(s: string, n: number): string {
  const target = workdaysBefore(mondayIdx(s) + 1) - n;
  return fromDayNo(Math.floor(target / 5) * 7 + mod(target, 5) + 4);
}
