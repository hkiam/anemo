/**
 * Kombinatorische Testdaten (Stufe H): alle Kombinationen oder paarweise Abdeckung („Pairwise“, alle Wertepaare je
 * zwei Parameter kommen mindestens einmal vor) mit Ausschlussregeln. Deterministisch (IPO-Verfahren), damit die
 * gleiche Eingabe immer dieselben Zeilen liefert.
 */

export interface Parameter { name: string; values: string[] }
/** Ausschluss: Kombinationen, in denen alle genannten Parameter genau diese Werte haben, sind verboten. */
export type Exclusion = Record<string, string>;

type Row = (string | null)[];

function violates(row: Row, params: Parameter[], exclusions: Exclusion[]): boolean {
  return exclusions.some((ex) => {
    const entries = Object.entries(ex);
    return entries.length > 0 && entries.every(([p, v]) => {
      const i = params.findIndex((x) => x.name === p);
      return i >= 0 && row[i] === v;
    });
  });
}

/** Obergrenze der Suchschritte je Vervollständigung (Schutz vor exponentiellen Fällen mit vielen Regeln). */
const SEARCH_BUDGET = 200_000;

/**
 * Freie Stellen einer Zeile zulässig belegen (Tiefensuche mit Rücksprung). `prefer` ordnet die Werte je Stelle
 * (höher = zuerst), z. B. nach Zahl neu abgedeckter Paare. Null, wenn es keine zulässige Vervollständigung gibt.
 */
function complete(row: Row, params: Parameter[], exclusions: Exclusion[], prefer?: (i: number, v: string, row: Row) => number): Row | null {
  const r = [...row];
  if (violates(r, params, exclusions)) return null;
  if (!exclusions.length) {
    for (let i = 0; i < r.length; i++) {
      if (r[i] !== null) continue;
      const vals = prefer ? [...params[i]!.values].sort((x, y) => prefer(i, y, r) - prefer(i, x, r)) : params[i]!.values;
      r[i] = vals[0]!;
    }
    return r;
  }
  const free = r.map((x, i) => (x === null ? i : -1)).filter((i) => i >= 0);
  let budget = SEARCH_BUDGET;
  const dfs = (k: number): boolean => {
    if (k === free.length) return true;
    if (--budget < 0) return false;
    const i = free[k]!;
    const vals = prefer ? [...params[i]!.values].sort((x, y) => prefer(i, y, r) - prefer(i, x, r)) : params[i]!.values;
    for (const v of vals) {
      r[i] = v;
      if (!violates(r, params, exclusions) && dfs(k + 1)) return true;
    }
    r[i] = null;
    return false;
  };
  return dfs(0) ? r : null;
}

/**
 * Ein Paar ist zulässig (möglich), wenn es eine vollständige Zeile ohne Regelverstoß gibt, die es enthält – auch
 * Regeln über mehr als zwei Parameter und das Zusammenspiel mehrerer Regeln werden so berücksichtigt.
 */
function pairPossible(params: Parameter[], exclusions: Exclusion[], i: number, a: string, k: number, b: string): boolean {
  if (!exclusions.length) return true;
  const row: Row = params.map(() => null);
  row[i] = a;
  row[k] = b;
  return complete(row, params, exclusions) !== null;
}

function validate(params: Parameter[]) {
  if (!params.length) throw new Error('Mindestens ein Parameter nötig');
  for (const p of params) {
    if (!p.name.trim()) throw new Error('Parametername fehlt');
    if (!p.values.length) throw new Error(`Parameter „${p.name}“ hat keine Werte`);
    if (new Set(p.values).size !== p.values.length) throw new Error(`Parameter „${p.name}“ hat doppelte Werte`);
  }
  if (new Set(params.map((p) => p.name)).size !== params.length) throw new Error('Parameternamen doppelt');
}

/** Alle Kombinationen (kartesisches Produkt) ohne ausgeschlossene; höchstens `limit` Zeilen. */
export function allCombinations(params: Parameter[], exclusions: Exclusion[] = [], limit = 5000): string[][] {
  validate(params);
  const total = params.reduce((n, p) => n * p.values.length, 1);
  if (total > limit * 20) throw new Error(`${total.toLocaleString('de-DE')} Kombinationen – bitte paarweise erzeugen`);
  let rows: Row[] = [[]];
  for (const p of params) rows = rows.flatMap((r) => p.values.map((v) => [...r, v]));
  const ok = rows.filter((r) => !violates(r, params, exclusions)) as string[][];
  if (ok.length > limit) throw new Error(`${ok.length.toLocaleString('de-DE')} Kombinationen – höchstens ${limit}; bitte paarweise erzeugen`);
  return ok;
}

/** Paarweise Abdeckung nach IPO (In-Parameter-Order). Liefert Zeilen in der Reihenfolge der Parameter. */
export function pairwise(params: Parameter[], exclusions: Exclusion[] = []): string[][] {
  validate(params);
  if (params.length === 1) return params[0]!.values.filter((v) => !violates([v], params, exclusions)).map((v) => [v]);
  // Parameter mit vielen Werten zuerst – ergibt weniger Zeilen; am Ende in ursprüngliche Reihenfolge zurück
  const order = params.map((_, i) => i).sort((a, b) => params[b]!.values.length - params[a]!.values.length || a - b);
  const P = order.map((i) => params[i]!);
  const n = P.length;
  const key = (i: number, a: string, k: number, b: string) => `${i}\u0000${a}\u0000${k}\u0000${b}`;
  let rows: Row[] = [];
  for (const a of P[0]!.values) for (const b of P[1]!.values) {
    const r: Row = Array(n).fill(null);
    r[0] = a; r[1] = b;
    if (!violates(r, P, exclusions)) rows.push(r);
  }
  for (let k = 2; k < n; k++) {
    // offene Paare (i<k, Wert a) × (k, Wert b)
    const open = new Set<string>();
    for (let i = 0; i < k; i++) for (const a of P[i]!.values) for (const b of P[k]!.values) if (pairPossible(P, exclusions, i, a, k, b)) open.add(key(i, a, k, b));
    // horizontal: bestehende Zeilen um Parameter k erweitern
    for (const r of rows) {
      let best: string | null = null;
      let bestGain = -1;
      for (const b of P[k]!.values) {
        const trial = [...r]; trial[k] = b;
        if (violates(trial, P, exclusions)) continue;
        let gain = 0;
        for (let i = 0; i < k; i++) if (r[i] !== null && open.has(key(i, r[i]!, k, b))) gain++;
        if (gain > bestGain) { bestGain = gain; best = b; }
      }
      if (best === null) continue;
      // nichts gewonnen und Zeile hat noch freie Stellen: offen lassen, damit die vertikale Phase sie nutzen kann
      if (bestGain === 0 && r.some((x, j) => j < k && x === null)) continue;
      r[k] = best;
      for (let i = 0; i < k; i++) if (r[i] !== null) open.delete(key(i, r[i]!, k, best));
    }
    // vertikal: übrige Paare in Zeilen mit freien Stellen unterbringen oder neue Zeilen anlegen
    for (const pk of [...open]) {
      if (!open.has(pk)) continue;
      const [is, a, , b] = pk.split('\u0000');
      const i = Number(is);
      let placed = false;
      for (const r of rows) {
        if ((r[k] !== null && r[k] !== b) || (r[i] !== null && r[i] !== a)) continue;
        if (r[i] === a && r[k] === b) { placed = true; break; }
        const trial = [...r]; trial[i] = a!; trial[k] = b!;
        if (violates(trial, P, exclusions)) continue;
        r[i] = a!; r[k] = b!;
        placed = true;
        break;
      }
      if (!placed) {
        const r: Row = Array(n).fill(null);
        r[i] = a!; r[k] = b!;
        if (violates(r, P, exclusions)) { open.delete(pk); continue; }
        rows.push(r);
      }
      open.delete(pk);
      // weitere Paare, die die geänderte/neue Zeile jetzt abdeckt, streichen
      for (const r of rows) for (let x = 0; x < k; x++) if (r[x] !== null && r[k] !== null) open.delete(key(x, r[x]!, k, r[k]!));
    }
  }
  // Review Teil 3, Befund 13: Freie Stellen nicht mehr mit dem erstbesten Wert füllen und unzulässige Zeilen (samt nur
  // dort abgedeckter Paare) verwerfen, sondern jede Zeile zulässig vervollständigen – bevorzugt mit Werten, die noch
  // fehlende Paare abdecken. Danach jedes noch fehlende mögliche Paar gezielt in einer eigenen Zeile unterbringen.
  const missing = new Set<string>();
  for (let i = 0; i < n; i++) for (let k = i + 1; k < n; k++) {
    for (const a of P[i]!.values) for (const b of P[k]!.values) if (pairPossible(P, exclusions, i, a, k, b)) missing.add(key(i, a, k, b));
  }
  const gain = (i: number, v: string, r: Row) => {
    let g = 0;
    for (let j = 0; j < n; j++) if (j !== i && r[j] !== null && missing.has(j < i ? key(j, r[j]!, i, v) : key(i, v, j, r[j]!))) g++;
    return g;
  };
  const cover = (r: Row) => { for (let i = 0; i < n; i++) for (let k = i + 1; k < n; k++) missing.delete(key(i, r[i]!, k, r[k]!)); };
  const done: Row[] = [];
  for (const r of rows) {
    const full = complete(r, P, exclusions, gain);
    if (!full) continue;
    done.push(full);
    cover(full);
  }
  while (missing.size) {
    const pk = missing.values().next().value!;
    const [is, a, ks, b] = pk.split('\u0000');
    const r: Row = Array(n).fill(null);
    r[Number(is)] = a!; r[Number(ks)] = b!;
    const full = complete(r, P, exclusions, gain);
    missing.delete(pk);
    if (!full) continue; // nur bei erschöpftem Suchbudget
    done.push(full);
    cover(full);
  }
  rows = done;
  // Dubletten entfernen, Spalten zurück in Eingabereihenfolge
  const seen = new Set<string>();
  const back = order.map((_, j) => order.indexOf(j));
  return rows.map((r) => back.map((i) => r[i]!)).filter((r) => { const s = r.join('\u0000'); if (seen.has(s)) return false; seen.add(s); return true; });
}

/**
 * Nicht abgedeckte mögliche Paare (für Tests und Anzeige „100 % paarweise abgedeckt“). Paare, die durch die
 * Ausschlussregeln (auch in Kombination) unmöglich sind, gelten nicht als fehlend.
 */
export function uncoveredPairs(params: Parameter[], rows: string[][], exclusions: Exclusion[] = []): string[] {
  const missing: string[] = [];
  for (let i = 0; i < params.length; i++) for (let k = i + 1; k < params.length; k++) {
    for (const a of params[i]!.values) for (const b of params[k]!.values) {
      if (!pairPossible(params, exclusions, i, a, k, b)) continue;
      if (!rows.some((r) => r[i] === a && r[k] === b)) missing.push(`${params[i]!.name}=${a} & ${params[k]!.name}=${b}`);
    }
  }
  return missing;
}
