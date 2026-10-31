/**
 * Ergebnisstatus nach Kategorie – gemeinsame Regeln für Server und Oberfläche (eine Quelle der Wahrheit):
 * Ableitung des Gesamtergebnisses aus Schritten bzw. Durchläufen („schlechtestes zählt“) und Kennzahlen.
 */
export type Category = 'OPEN' | 'IN_PROGRESS' | 'PASSED' | 'PASSED_WITH_ISSUES' | 'KNOWN_FAILURE' | 'FAILED' | 'BLOCKED' | 'INVALID' | 'NOT_APPLICABLE';

export const isOpen = (c: string | undefined) => c === 'OPEN' || c === 'IN_PROGRESS' || c === undefined;
/** Bestanden im Sinne der Bestehensquote (auch „mit Einschränkung“) */
export const isPassed = (c: string | undefined) => c === 'PASSED' || c === 'PASSED_WITH_ISSUES';
export const isFailedOrBlocked = (c: string | undefined) => c === 'FAILED' || c === 'BLOCKED';
/** Dokumentierter bekannter Fehler: fehlgeschlagen, aber mit Verweis – blockiert die Freigabe nicht (Restrisiko) */
export const isKnownFailure = (c: string | undefined) => c === 'KNOWN_FAILURE';
/** Nicht in Ordnung: fehlgeschlagen, blockiert oder bekannter Fehler – für Abdeckung und Risiko (nicht „nicht getestet“) */
export const isNotOk = (c: string | undefined) => isFailedOrBlocked(c) || isKnownFailure(c);
/** Ohne Aussage über das Ergebnis: ungültig bzw. nicht anwendbar – zählen weder als ausgeführt noch als offen */
export const isNeutral = (c: string | undefined) => c === 'INVALID' || c === 'NOT_APPLICABLE';

export interface DeriveDefaults { fail: string; blocked: string; pass: string; wip: string; open: string; invalid: string; known: string; na?: string }
export const DEFAULTS: DeriveDefaults = { fail: 'FAIL', blocked: 'BLOCKED', pass: 'PASS', wip: 'WIP', open: 'NOT_EXECUTED', invalid: 'INVALID', known: 'FAIL_KNOWN', na: 'NA' };

/**
 * Gesamtergebnis aus Teilergebnissen: fehlgeschlagen vor blockiert vor offen/in Arbeit vor „fehlgeschlagen (bekannt)“
 * vor „bestanden mit Einschränkung“ vor bestanden; nur ungültige bzw. nicht anwendbare Teile ergeben „ungültig“ bzw.
 * „nicht anwendbar“ (beide sind neutral und zählen sonst nicht). Ein eigener Status einer Kategorie wird
 * übernommen, wenn er für Ausführungen gilt (`usable`), sonst der Standardstatus.
 */
export function deriveOverall(codes: string[], categoryOf: (code: string) => string | undefined, usable: (code: string) => boolean = () => true, d: DeriveDefaults = DEFAULTS): string {
  if (!codes.length) return d.open;
  const cats = codes.map((c) => categoryOf(c) ?? 'OPEN');
  const pick = (cat: string, fallback: string) => codes.find((c, i) => cats[i] === cat && usable(c)) ?? fallback;
  if (cats.includes('FAILED')) return pick('FAILED', d.fail);
  if (cats.includes('BLOCKED')) return pick('BLOCKED', d.blocked);
  if (cats.every(isNeutral)) return cats.includes('INVALID') ? pick('INVALID', d.invalid) : pick('NOT_APPLICABLE', d.na ?? 'NA');
  // nur bestanden bzw. bekannte Fehler (und Neutrales): bekannter Fehler – ein unerwarteter Fehlschlag wäre oben FAILED
  if (cats.includes('KNOWN_FAILURE') && cats.every((c) => isPassed(c) || isNeutral(c) || c === 'KNOWN_FAILURE')) return pick('KNOWN_FAILURE', d.known);
  if (cats.every((c) => isPassed(c) || isNeutral(c))) {
    if (cats.includes('PASSED_WITH_ISSUES')) return pick('PASSED_WITH_ISSUES', d.pass);
    // eigener „bestanden“-Status (z. B. aus Zephyr) ist spezifischer als der Standard
    return codes.find((c, i) => cats[i] === 'PASSED' && c !== d.pass && usable(c)) ?? d.pass;
  }
  return cats.some((c) => !isOpen(c)) ? d.wip : d.open;
}

/** Rang für den Vergleich zweier Ergebnisse (kleiner = schlechter) */
const RANK: Record<string, number> = { FAILED: 0, BLOCKED: 1, IN_PROGRESS: 2, OPEN: 3, KNOWN_FAILURE: 4, PASSED_WITH_ISSUES: 5, PASSED: 6, INVALID: 7, NOT_APPLICABLE: 8 };
export const rank = (c: string | undefined) => RANK[c ?? 'OPEN'] ?? 3;

/**
 * „Wackelnd“ (flaky) – eine Definition für Test-Health und Risikobewertung (Review Teil 3, Befund 17): mindestens
 * {@link FLAKY_MIN_SWITCHES} Wechsel zwischen bestanden und fehlgeschlagen in den letzten {@link FLAKY_WINDOW}
 * Ergebnissen (Kategorien, neueste zuerst). Andere Kategorien (blockiert, offen, ungültig, „mit Einschränkung“)
 * zählen nicht. Die Ergebnisse sind je Konfiguration zu betrachten (siehe {@link flakyByConfiguration}): Ein Test, der
 * unter Oracle reproduzierbar scheitert und unter SQL Server besteht, ist konfigurationsabhängig, nicht wackelnd.
 */
export const FLAKY_WINDOW = 8;
export const FLAKY_MIN_SWITCHES = 3;

export function flakySwitches(categoriesNewestFirst: (string | undefined)[]): number {
  const recent = categoriesNewestFirst.slice(0, FLAKY_WINDOW).filter((c) => c === 'PASSED' || c === 'FAILED');
  return recent.slice(1).filter((c, i) => c !== recent[i]).length;
}

/** Größte Wechselzahl über die Konfigurationen eines Testfalls; `flaky`, wenn eine Konfiguration die Schwelle erreicht. */
export function flakyByConfiguration(history: { configuration: string; category: string | undefined }[]): { switches: number; flaky: boolean; configuration: string | null } {
  const groups = new Map<string, (string | undefined)[]>();
  for (const h of history) (groups.get(h.configuration) ?? groups.set(h.configuration, []).get(h.configuration)!).push(h.category);
  let best = { switches: 0, flaky: false, configuration: null as string | null };
  for (const [configuration, cats] of groups) {
    const switches = flakySwitches(cats);
    if (switches > best.switches) best = { switches, flaky: switches >= FLAKY_MIN_SWITCHES, configuration };
  }
  return best;
}
