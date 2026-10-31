/**
 * Abschnitte (Gruppen) in Testschritten (Stufe J1). Ein Abschnitt ist ein Schritt mit `kind: 'group'`: kein
 * Prüfschritt, ohne Ergebnis. Alle folgenden Schritte bis zum nächsten Abschnitt gehören dazu (flache Liste – Schritt-IDs,
 * Ergebnisse, Aufrufe und Sortierung bleiben unverändert).
 *
 * In Zephyr wurden Abschnitte mit Pfeil- bzw. Strichzeilen nachgebildet (Aktion „------>“, Erwartet „<------“, Name
 * als Überschrift in den Testdaten). `detectGroup` erkennt diese Trennschritte und leitet Titel, Untertitel, Kennzeichen
 * und Beschreibung ab; der Originaltext bleibt in `legacy` erhalten.
 */

export interface GroupFields {
  kind: 'group';
  /** angezeigter Abschnittsname (leer = „Abschnitt“, zur Nacharbeit markiert) */
  title: string;
  /** zweite Überschrift (wenn Aktion und Testdaten je eine Überschrift tragen) */
  subtitle?: string | null;
  /** Kennzeichen vor dem Pfeil, z. B. „INAKTIV“ oder „NEUE TESTSCHRITTE“ */
  marker?: string | null;
  /** weiterer Inhalt der Testdaten bzw. Aktion (Wiki-Markup) */
  note?: string | null;
  /** Originalinhalt des Trennschritts aus der Übernahme */
  legacy?: { action: string; data: string; expected: string } | null;
}

export interface StepLike { id?: string | undefined; kind?: string | null | undefined; action?: string; data?: string; expected?: string }

// Parameter bewusst als `object`: Schritt-Typen der Module unterscheiden sich (z. B. Schema-Varianten ohne `kind`)
export const isGroup = (s: object | null | undefined): boolean => (s as StepLike | null | undefined)?.kind === 'group';

/** Farbangaben, Hervorhebungen und Leerraum entfernen (nur für die Erkennung, nicht für die Ausgabe). */
const plain = (s: string) => s.replace(/\{color(?::[^}]*)?\}/gi, '').replace(/[*_+^~]/g, '').replace(/\{\{|\}\}/g, '').replace(/[ \t ]+/g, ' ').trim();

/** Linie aus Strichen bzw. Gleichheitszeichen mit oder ohne Pfeilspitze. */
const RULE = /<?[-=]{8,}>?|<[-=]{3,}|[-=]{3,}>/g;
const HR = /^-{4,}$/m;
const HEADING = /^h[1-6]\.[ \t]*(.+)$/m;
/** Panel mit Titel ({panel:title=Name|…}) – in Zephyr ebenfalls als Abschnittsname genutzt */
const PANEL = /\{panel:(?:[^}|]*\|)*?title=([^}|]+)[^}]*\}/;

/** Rest einer Pfeilzeile ohne Linien, Überschriftenkennung und Füllzeichen. */
function residue(s: string): string {
  return plain(s).replace(RULE, ' ').replace(HR, ' ').replace(/^h[1-6]\.[ \t]*/gm, '').replace(/\s+/g, ' ').replace(/^[\s\-–:|]+|[\s\-–:|]+$/g, '').trim();
}

/** Ist der Text (nach Entfernen der Formatierung) eine Pfeil- bzw. Strichzeile, ggf. mit kurzem Begriff? */
function isRuleText(s: string): boolean {
  const p = plain(s);
  if (!p) return false;
  const hasRule = new RegExp(RULE.source).test(p) || HR.test(p);
  return hasRule && residue(s).length <= 60 && !/\n.*\n.*\n.*\n/.test(p.replace(/\n\s*\n/g, '\n'));
}

const cleanTitle = (s: string) => plain(s).replace(RULE, ' ').replace(/\s+/g, ' ').replace(/^[\s\-–:|/]+|[\s\-–:|/]+$/g, '').slice(0, 120).trim();

/** Testdaten ohne Überschriftenzeile und ohne leere Farbblöcke; leer → null. */
function restOf(wiki: string, without: RegExp | null): string | null {
  let s = wiki.replace(/\r\n?/g, '\n');
  if (without) s = s.replace(without, '');
  s = s.replace(/\{color(?::[^}]*)?\}\s*\{color\}/gi, '').replace(/^\s*\{panel\}\s*$/gm, '').replace(/^\s*-{4,}\s*$/gm, '').trim();
  return plain(s) ? s : null;
}

/**
 * Trennschritt aus Zephyr erkennen. Regeln (Planung Stufe J, Entscheidung 1):
 * – Aktion = Pfeil-/Strichzeile (ggf. mit Begriff oder Überschrift + Linie), Erwartet = Pfeilzeile oder leer.
 * – Titel: Überschrift der Aktion; sonst Überschrift der Testdaten; sonst Begriff der Pfeilzeile; sonst erste
 *   Textzeile der Testdaten. Tragen Aktion und Testdaten je eine Überschrift, wird die zweite zum Untertitel.
 * – Begriff vor dem Pfeil neben einer Testdaten-Überschrift (z. B. „INAKTIV“) wird Kennzeichen.
 * – übriger Inhalt der Testdaten wird Beschreibung; nichts geht verloren (Original in `legacy`).
 */
export function detectGroup(step: { action?: string; data?: string; expected?: string }): GroupFields | null {
  const action = step.action ?? '';
  const data = step.data ?? '';
  const expected = step.expected ?? '';
  const actionHeading = HEADING.exec(action);
  if (!isRuleText(action)) return null;
  if (plain(expected) && !isRuleText(expected)) return null;
  // Ohne Gegenpfeil, Überschrift und Testdaten muss die Linie eindeutig sein (Pfeilspitze oder reine Wiki-Linie)
  if (!plain(expected) && !actionHeading && !plain(data) && !/[<>]/.test(plain(action)) && !/^-{4,}$/.test(plain(action))) return null;

  const dataHeading = HEADING.exec(data) ?? PANEL.exec(data);
  const term = residue(action);
  const legacy = { action, data, expected };
  if (actionHeading) {
    const title = cleanTitle(actionHeading[1]!);
    return dataHeading
      ? { kind: 'group', title, subtitle: cleanTitle(dataHeading[1]!) || null, marker: null, note: restOf(data, dataHeading[0].startsWith('{panel') ? PANEL : HEADING), legacy }
      : { kind: 'group', title, subtitle: null, marker: null, note: restOf(data, null), legacy };
  }
  if (dataHeading) {
    return { kind: 'group', title: cleanTitle(dataHeading[1]!), subtitle: null, marker: term ? cleanTitle(term) : null, note: restOf(data, dataHeading[0].startsWith('{panel') ? PANEL : HEADING), legacy };
  }
  if (term) return { kind: 'group', title: cleanTitle(term), subtitle: null, marker: null, note: restOf(data, null), legacy };
  const rest = restOf(data, null);
  const first = rest ? rest.split('\n').map(cleanTitle).find(Boolean) ?? '' : '';
  if (first && first.length <= 80) {
    const remaining = rest!.split('\n').slice(rest!.split('\n').findIndex((l) => cleanTitle(l)) + 1).join('\n').trim();
    return { kind: 'group', title: first, subtitle: null, marker: null, note: plain(remaining) ? remaining : null, legacy };
  }
  return { kind: 'group', title: '', subtitle: null, marker: null, note: rest, legacy };
}

/** Schritt in einen Abschnitt umwandeln (ID bleibt), sofern er ein Trennschritt ist; sonst unverändert. */
export function convertStep<S extends StepLike>(step: S): S | (S & GroupFields) {
  if (isGroup(step) || (step as { call?: unknown }).call) return step;
  const g = detectGroup(step);
  return g ? { ...step, ...g, action: '', data: '', expected: '' } : step;
}

/** Einzeiliger Name aus Wiki-Text (Formatierung, Linien und Überschriftkennung entfernt), höchstens 120 Zeichen. */
export const plainTitle = (wiki: string) => cleanTitle((wiki ?? '').replace(/^h[1-6]\.[ \t]*/gm, '').split('\n').find((l) => cleanTitle(l)) ?? '');

/** Abschnittsname für Anzeigen (leer → „Abschnitt“). */
export const groupTitle = (s: object) => (s as { title?: string | null }).title?.trim() || 'Abschnitt';

export interface StepRange { group: number | null; steps: number[] }

/**
 * Zuordnung Abschnitt → Schritte (Indizes). Schritte vor dem ersten Abschnitt bilden einen Bereich ohne Abschnitt
 * (`group: null`). Leere Abschnitte haben `steps: []`.
 */
export function stepRanges(steps: readonly object[]): StepRange[] {
  const out: StepRange[] = [];
  let cur: StepRange | null = null;
  steps.forEach((s, i) => {
    if (isGroup(s)) { cur = { group: i, steps: [] }; out.push(cur); return; }
    if (!cur) { cur = { group: null, steps: [] }; out.push(cur); }
    cur.steps.push(i);
  });
  return out;
}

/** Laufende Nummer je Prüfschritt (Abschnitte zählen nicht mit); für Abschnitte null. */
export function stepNumbers(steps: readonly object[]): (number | null)[] {
  let n = 0;
  return steps.map((s) => (isGroup(s) ? null : ++n));
}

/** Nur die Prüfschritte (für Ergebnisse, Zählungen, Aufwand). */
export const checkSteps = <S extends object>(steps: readonly S[]): S[] => steps.filter((s) => !isGroup(s));
