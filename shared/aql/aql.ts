/**
 * Anemo-Abfragesprache (Stufe H2) – Parser und Feldkatalog, gemeinsam für Server (SQL) und Oberfläche
 * (Prüfung, Autovervollständigung). Deutsch mit englischen Synonymen, angelehnt an ZQL/JQL:
 *
 *   status = Fehlgeschlagen UND zyklus ~ "Regression" UND konfiguration.datenbank = Oracle UND ausgeführt > -7d
 *   label IN (Smoke, Kern) ODER NICHT priorität IST LEER SORTIERT NACH geändert AB
 *
 * Bedingungen ohne UND/ODER werden mit UND verknüpft; ein freies Wort ist eine Volltextsuche.
 */

export type Scope = 'testcase' | 'execution';
export type FieldType = 'key' | 'text' | 'enum' | 'list' | 'user' | 'date' | 'number' | 'bool' | 'fulltext' | 'custom' | 'config' | 'ref';
export type Op = '=' | '!=' | '~' | '!~' | '<' | '<=' | '>' | '>=' | 'in' | 'notin' | 'empty' | 'notempty';

export interface FieldInfo {
  name: string;
  aliases: string[];
  type: FieldType;
  scopes: Scope[];
  help: string;
  /** feste Werte für die Autovervollständigung (z. B. Kategorien) */
  values?: string[];
  sortable?: boolean;
}

export const FIELDS: FieldInfo[] = [
  { name: 'text', aliases: ['volltext', 'fulltext'], type: 'fulltext', scopes: ['testcase', 'execution'], help: 'Volltext (Titel, Inhalt bzw. Kommentar)' },
  { name: 'schlüssel', aliases: ['schluessel', 'key', 'testfall', 'testcase'], type: 'key', scopes: ['testcase', 'execution'], help: 'Testfall-Schlüssel oder Jira-Altschlüssel, z. B. DEMO-T12', sortable: true },
  { name: 'titel', aliases: ['title', 'name'], type: 'text', scopes: ['testcase', 'execution'], help: 'Titel des Testfalls', sortable: true },
  { name: 'status', aliases: [], type: 'enum', scopes: ['testcase', 'execution'], help: 'Testfall: Workflow-Status; Ausführung: Ergebnis', sortable: true },
  { name: 'kategorie', aliases: ['statuskategorie', 'category'], type: 'enum', scopes: ['testcase', 'execution'], help: 'Statuskategorie',
    values: ['Entwurf', 'Review', 'Freigegeben', 'Veraltet', 'Offen', 'In Arbeit', 'Bestanden', 'Bestanden mit Einschränkung', 'Fehlgeschlagen', 'Blockiert', 'Ungültig'] },
  { name: 'priorität', aliases: ['prioritaet', 'prio', 'priority'], type: 'enum', scopes: ['testcase', 'execution'], help: 'Priorität des Testfalls', sortable: true },
  { name: 'label', aliases: ['labels'], type: 'list', scopes: ['testcase', 'execution'], help: 'Label des Testfalls' },
  { name: 'komponente', aliases: ['komponenten', 'component', 'components'], type: 'list', scopes: ['testcase', 'execution'], help: 'Komponente des Testfalls' },
  { name: 'ordner', aliases: ['folder'], type: 'text', scopes: ['testcase', 'execution'], help: 'Ordner; „=“ Pfad inkl. Unterordner (A/B), „~“ Teil eines Ordnernamens' },
  { name: 'owner', aliases: ['verantwortlich'], type: 'user', scopes: ['testcase'], help: 'Verantwortliche Person; ich() = ich' },
  { name: 'erstellt', aliases: ['created'], type: 'date', scopes: ['testcase', 'execution'], help: 'Anlagedatum, z. B. > -30d oder >= 01.10.2026', sortable: true },
  { name: 'ersteller', aliases: ['creator', 'createdby'], type: 'user', scopes: ['testcase'], help: 'Wer den Testfall angelegt hat' },
  { name: 'geändert', aliases: ['geaendert', 'updated'], type: 'date', scopes: ['testcase'], help: 'Datum der aktuellen Version', sortable: true },
  { name: 'geändertvon', aliases: ['geaendertvon', 'updatedby'], type: 'user', scopes: ['testcase'], help: 'Autor der aktuellen Version' },
  { name: 'version', aliases: [], type: 'number', scopes: ['testcase'], help: 'Aktuelle Versionsnummer' },
  { name: 'format', aliases: [], type: 'enum', scopes: ['testcase'], help: 'Klassisch, Gherkin oder Freitext', values: ['Klassisch', 'Gherkin', 'Freitext'] },
  { name: 'schritte', aliases: ['steps'], type: 'number', scopes: ['testcase'], help: 'Anzahl der Schritte' },
  { name: 'schätzung', aliases: ['schaetzung', 'aufwand', 'estimate'], type: 'number', scopes: ['testcase', 'execution'], help: 'Geplanter Aufwand in Minuten; IST LEER = ohne Schätzung' },
  { name: 'parametrisiert', aliases: ['datensatz', 'parameterized'], type: 'bool', scopes: ['testcase'], help: 'Hat einen Datensatz (ja/nein)' },
  { name: 'testart', aliases: ['testtype'], type: 'list', scopes: ['testcase', 'execution'], help: 'Testart (aus Zephyr übernommen)' },
  { name: 'anforderung', aliases: ['requirement'], type: 'ref', scopes: ['testcase', 'execution'], help: 'Verknüpfte Anforderung/Story (Ticket-Schlüssel)' },
  { name: 'fehler', aliases: ['defect', 'bug'], type: 'ref', scopes: ['testcase', 'execution'], help: 'Verknüpfter Fehler (Ticket-Schlüssel); IST NICHT LEER = mit Fehler' },
  { name: 'verweis', aliases: ['reference', 'ticket'], type: 'ref', scopes: ['testcase', 'execution'], help: 'Beliebiger Ticketverweis' },
  { name: 'ergebnis', aliases: ['letztesergebnis', 'lastresult'], type: 'enum', scopes: ['testcase'], help: 'Letztes Ergebnis über alle Zyklen (Status oder Kategorie)' },
  { name: 'ausgeführt', aliases: ['ausgefuehrt', 'executed', 'executedon'], type: 'date', scopes: ['testcase', 'execution'], help: 'Ausführungsdatum (Testfall: zuletzt ausgeführt)', sortable: true },
  { name: 'ausgeführtvon', aliases: ['ausgefuehrtvon', 'executedby', 'tester'], type: 'user', scopes: ['testcase', 'execution'], help: 'Wer ausgeführt hat' },
  { name: 'zyklus', aliases: ['testzyklus', 'cycle'], type: 'text', scopes: ['testcase', 'execution'], help: 'Name des Testzyklus (Testfall: in irgendeinem Zyklus eingeplant)', sortable: true },
  { name: 'archiviert', aliases: ['archived'], type: 'bool', scopes: ['testcase', 'execution'], help: 'Archiviert (Testfall bzw. Zyklus)' },
  { name: 'zugewiesen', aliases: ['assignee', 'zuständig', 'zustaendig'], type: 'user', scopes: ['execution'], help: 'Zuständige Person; ich() = ich; IST LEER = niemand', sortable: true },
  { name: 'plan', aliases: ['testplan', 'release-plan'], type: 'text', scopes: ['execution'], help: 'Testplan' },
  { name: 'release', aliases: ['version-release', 'fixversion'], type: 'text', scopes: ['execution'], help: 'Release des Zyklus' },
  { name: 'build', aliases: [], type: 'text', scopes: ['execution'], help: 'Build des Zyklus' },
  { name: 'umgebung', aliases: ['environment'], type: 'text', scopes: ['execution'], help: 'Umgebung des Zyklus' },
  { name: 'zyklusstatus', aliases: ['cyclestate'], type: 'enum', scopes: ['execution'], help: 'geplant, aktiv, abgeschlossen', values: ['geplant', 'aktiv', 'abgeschlossen'] },
  { name: 'kommentar', aliases: ['comment', 'befund'], type: 'text', scopes: ['execution'], help: 'Kommentar/Befund der Ausführung' },
  { name: 'dauer', aliases: ['duration'], type: 'number', scopes: ['execution'], help: 'Bearbeitungsdauer in Minuten' },
  { name: 'prüfung', aliases: ['pruefung', 'review'], type: 'enum', scopes: ['execution'], help: 'KI-Ergebnisprüfung', values: ['ausstehend', 'freigegeben', 'abgelehnt', 'eskaliert'] },
  { name: 'veraltet', aliases: ['outdated'], type: 'bool', scopes: ['execution'], help: 'Bezieht sich auf eine ältere Testfallversion' },
  { name: 'feld', aliases: ['field', 'cf'], type: 'custom', scopes: ['testcase', 'execution'], help: 'Eigenes Feld: feld.Name bzw. feld."Name mit Leerzeichen"' },
  { name: 'konfiguration', aliases: ['config', 'cfg'], type: 'config', scopes: ['execution'], help: 'Konfigurationsmerkmal: konfiguration.datenbank = Oracle' },
];

const norm = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[-_ ]/g, '');

export function findField(name: string, scope: Scope): FieldInfo | undefined {
  const n = norm(name);
  return FIELDS.find((f) => f.scopes.includes(scope) && (norm(f.name) === n || f.aliases.some((a) => norm(a) === n)));
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length]![b.length]!;
}

export function suggestField(name: string, scope: Scope): string | null {
  const n = norm(name);
  let best: [string, number] | null = null;
  for (const f of FIELDS.filter((x) => x.scopes.includes(scope))) {
    for (const cand of [f.name, ...f.aliases]) {
      const dist = distance(n, norm(cand));
      if (!best || dist < best[1]) best = [f.name, dist];
    }
  }
  return best && best[1] <= Math.max(2, Math.floor(n.length / 3)) ? best[0] : null;
}

// ---------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------

export type TokenKind = 'word' | 'string' | 'op' | 'lparen' | 'rparen' | 'comma' | 'dot' | 'eof';
export interface Token { kind: TokenKind; value: string; pos: number; end: number }

export class AqlError extends Error {
  pos: number;
  end: number;
  constructor(message: string, pos: number, end: number = pos + 1) {
    super(message);
    this.pos = pos;
    this.end = end;
  }
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    const start = i;
    if (ch === '"' || ch === "'" || ch === '„' || ch === '“') {
      const close = ch === '„' ? '“' : ch;
      let s = '';
      i++;
      while (i < input.length && input[i] !== close && !(ch === '„' && input[i] === '"')) {
        if (input[i] === '\\' && i + 1 < input.length) { s += input[i + 1]; i += 2; continue; }
        s += input[i++];
      }
      if (i >= input.length) throw new AqlError('Anführungszeichen nicht geschlossen', start, input.length);
      i++;
      tokens.push({ kind: 'string', value: s, pos: start, end: i });
      continue;
    }
    if (ch === '(') { tokens.push({ kind: 'lparen', value: ch, pos: i, end: ++i }); continue; }
    if (ch === ')') { tokens.push({ kind: 'rparen', value: ch, pos: i, end: ++i }); continue; }
    if (ch === ',') { tokens.push({ kind: 'comma', value: ch, pos: i, end: ++i }); continue; }
    const two = input.slice(i, i + 2);
    if (['!=', '!~', '<=', '>=', '<>'].includes(two)) { tokens.push({ kind: 'op', value: two === '<>' ? '!=' : two, pos: i, end: i + 2 }); i += 2; continue; }
    if ('=~<>'.includes(ch)) { tokens.push({ kind: 'op', value: ch, pos: i, end: ++i }); continue; }
    if (ch === '.' && tokens.length && tokens.at(-1)!.kind === 'word' && tokens.at(-1)!.end === i) { tokens.push({ kind: 'dot', value: '.', pos: i, end: ++i }); continue; }
    // Wort: alles bis Leerzeichen/Operator/Klammer/Komma; Datumsangaben (01.10.2026, -7d) bleiben ein Wort
    while (i < input.length && !/[\s()=,~<>!"'„“]/.test(input[i]!)) {
      if (input[i] === '.' && !/^[\d+-]/.test(input.slice(start, i)) && /[\p{L}_]/u.test(input[i + 1] ?? '') ) break;
      if (input[i] === '.' && /^[\p{L}_]/u.test(input.slice(start, i)) && /["'„]/.test(input[i + 1] ?? '')) break;
      i++;
    }
    if (i === start) throw new AqlError(`Unerwartetes Zeichen „${ch}“`, i);
    tokens.push({ kind: 'word', value: input.slice(start, i), pos: start, end: i });
  }
  tokens.push({ kind: 'eof', value: '', pos: input.length, end: input.length });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

export interface Value { raw: string; quoted: boolean; pos: number; func?: 'ich' | 'heute' }
export type Node =
  | { type: 'and' | 'or'; items: Node[] }
  | { type: 'not'; item: Node }
  | { type: 'cond'; field: FieldInfo; path: string | null; op: Op; values: Value[]; pos: number; end: number }
  | { type: 'text'; value: string; pos: number };
export interface SortKey { field: FieldInfo; path: string | null; desc: boolean }
export interface Query { where: Node | null; order: SortKey[] }

const KW = {
  and: ['und', 'and', '&&'], or: ['oder', 'or', '||'], not: ['nicht', 'not'], in: ['in'], is: ['ist', 'is'],
  empty: ['leer', 'empty', 'null'], order: ['sortiert', 'order'], by: ['nach', 'by'],
  asc: ['auf', 'aufsteigend', 'asc'], desc: ['ab', 'absteigend', 'desc'],
};
const isKw = (t: Token, k: keyof typeof KW) => t.kind === 'word' && KW[k].includes(t.value.toLowerCase());
const FUNCS: Record<string, 'ich' | 'heute'> = { 'ich': 'ich', 'me': 'ich', 'currentuser': 'ich', 'heute': 'heute', 'today': 'heute', 'now': 'heute', 'jetzt': 'heute' };

/**
 * Komplexitätsgrenzen (Sicherheitsreview Teil 2, Befund 9): Jede Bedingung wird zu einer SQL-Bedingung, manche zu
 * korrelierten Unterabfragen. Länge, Anzahl der Bedingungen, Werte je IN-Liste und Klammer-/NICHT-Tiefe sind daher
 * begrenzt; Überschreitungen ergeben eine verständliche Fehlermeldung mit Position.
 */
export const AQL_LIMITS = { length: 4000, conditions: 30, values: 200, depth: 10 };

export function parse(input: string, scope: Scope): Query {
  if (input.length > AQL_LIMITS.length) throw new AqlError(`Abfrage zu lang (höchstens ${AQL_LIMITS.length} Zeichen)`, AQL_LIMITS.length, input.length);
  const tokens = tokenize(input);
  let p = 0;
  let conditions = 0, depth = 0;
  const counted = (n: Node, pos: number, end: number): Node => {
    if (++conditions > AQL_LIMITS.conditions) {
      throw new AqlError(`Zu viele Bedingungen (höchstens ${AQL_LIMITS.conditions}) – bitte die Abfrage vereinfachen oder ein Testset bzw. einen Ordner verwenden`, pos, end);
    }
    return n;
  };
  const deeper = (t: Token) => {
    if (++depth > AQL_LIMITS.depth) throw new AqlError(`Zu tief verschachtelt (höchstens ${AQL_LIMITS.depth} Ebenen aus Klammern und NICHT)`, t.pos, t.end);
  };
  const peek = (o = 0) => tokens[Math.min(p + o, tokens.length - 1)]!;
  const next = () => tokens[p++]!;
  const expect = (kind: TokenKind, what: string) => {
    const t = peek();
    if (t.kind !== kind) throw new AqlError(`${what} erwartet${t.kind === 'eof' ? ' (Abfrage endet zu früh)' : `, gefunden „${t.value}“`}`, t.pos, t.end);
    return next();
  };

  const value = (): Value => {
    const t = peek();
    if (t.kind === 'string') { next(); return { raw: t.value, quoted: true, pos: t.pos }; }
    if (t.kind === 'word') {
      next();
      const fn = FUNCS[t.value.toLowerCase()];
      if (fn && peek().kind === 'lparen' && peek(1).kind === 'rparen') { next(); next(); return { raw: t.value, quoted: false, pos: t.pos, func: fn }; }
      return { raw: t.value, quoted: false, pos: t.pos };
    }
    throw new AqlError(`Wert erwartet${t.kind === 'eof' ? '' : `, gefunden „${t.value}“`}`, t.pos, t.end);
  };

  const fieldRef = (): { field: FieldInfo; path: string | null; pos: number } | null => {
    const t = peek();
    if (t.kind !== 'word') return null;
    const f = findField(t.value, scope);
    const isCond = peek(1).kind === 'op' || peek(1).kind === 'dot' || isKw(peek(1), 'in') || isKw(peek(1), 'is')
      || (isKw(peek(1), 'not') && isKw(peek(2), 'in'));
    if (!f) {
      if (isCond) {
        const s = suggestField(t.value, scope);
        throw new AqlError(`Unbekanntes Feld „${t.value}“${s ? ` – meinten Sie „${s}“?` : ''}`, t.pos, t.end);
      }
      return null;
    }
    if (!isCond) return null;
    next();
    let path: string | null = null;
    if (f.type === 'custom' || f.type === 'config') {
      expect('dot', `Punkt nach „${t.value}“ (z. B. ${f.name}.Name)`);
      const n = peek();
      if (n.kind !== 'word' && n.kind !== 'string') throw new AqlError('Feldname erwartet', n.pos, n.end);
      next();
      path = n.value;
    } else if (peek().kind === 'dot') throw new AqlError(`„${f.name}“ hat keine Unterfelder`, peek().pos);
    return { field: f, path, pos: t.pos };
  };

  const condition = (): Node | null => {
    const start = p;
    const ref = fieldRef();
    if (!ref) { p = start; return null; }
    const t = peek();
    let op: Op;
    let values: Value[];
    if (isKw(t, 'is')) {
      next();
      const neg = isKw(peek(), 'not') ? (next(), true) : false;
      if (!isKw(peek(), 'empty')) throw new AqlError('LEER erwartet (IST LEER / IST NICHT LEER)', peek().pos, peek().end);
      next();
      op = neg ? 'notempty' : 'empty';
      values = [];
    } else if (isKw(t, 'in') || (isKw(t, 'not') && isKw(peek(1), 'in'))) {
      const neg = isKw(t, 'not');
      next(); if (neg) next();
      expect('lparen', '„(“');
      values = [value()];
      while (peek().kind === 'comma') {
        next();
        values.push(value());
        if (values.length > AQL_LIMITS.values) throw new AqlError(`Zu viele Werte in der Liste (höchstens ${AQL_LIMITS.values})`, values.at(-1)!.pos);
      }
      expect('rparen', '„)“');
      op = neg ? 'notin' : 'in';
    } else {
      const o = expect('op', 'Vergleich (=, !=, ~, <, >, IN, IST LEER)');
      op = o.value as Op;
      values = [value()];
    }
    checkOp(ref.field, op, ref.pos);
    return counted({ type: 'cond', field: ref.field, path: ref.path, op, values, pos: ref.pos, end: tokens[p - 1]!.end }, ref.pos, tokens[p - 1]!.end);
  };

  const primary = (): Node => {
    const t = peek();
    if (t.kind === 'lparen') {
      deeper(t);
      next();
      const n = orExpr();
      expect('rparen', '„)“');
      depth--;
      return n;
    }
    const c = condition();
    if (c) return c;
    if (t.kind === 'string' || t.kind === 'word') {
      if (t.kind === 'word' && (isKw(t, 'and') || isKw(t, 'or'))) throw new AqlError(`„${t.value}“ ohne Bedingung davor`, t.pos, t.end);
      next();
      return counted({ type: 'text', value: t.value, pos: t.pos }, t.pos, t.end);
    }
    throw new AqlError(t.kind === 'eof' ? 'Bedingung erwartet (Abfrage endet zu früh)' : `Unerwartet: „${t.value}“`, t.pos, t.end);
  };
  const notExpr = (): Node => {
    if (isKw(peek(), 'not') && !isKw(peek(1), 'in')) {
      deeper(peek());
      next();
      const item = notExpr();
      depth--;
      return { type: 'not', item };
    }
    return primary();
  };
  const andExpr = (): Node => {
    const items = [notExpr()];
    for (;;) {
      const t = peek();
      if (isKw(t, 'and')) { next(); items.push(notExpr()); continue; }
      if (t.kind === 'eof' || t.kind === 'rparen' || isKw(t, 'or') || isKw(t, 'order')) break;
      items.push(notExpr()); // implizites UND
    }
    return items.length === 1 ? items[0]! : { type: 'and', items };
  };
  const orExpr = (): Node => {
    const items = [andExpr()];
    while (isKw(peek(), 'or')) { next(); items.push(andExpr()); }
    return items.length === 1 ? items[0]! : { type: 'or', items };
  };

  const where = peek().kind === 'eof' || isKw(peek(), 'order') ? null : orExpr();
  const order: SortKey[] = [];
  if (isKw(peek(), 'order')) {
    next();
    if (!isKw(peek(), 'by')) throw new AqlError('„NACH“ erwartet (SORTIERT NACH feld)', peek().pos, peek().end);
    next();
    do {
      if (order.length) next();
      const t = expect('word', 'Feld zum Sortieren');
      const f = findField(t.value, scope);
      if (!f) throw new AqlError(`Unbekanntes Feld „${t.value}“`, t.pos, t.end);
      if (!f.sortable) throw new AqlError(`Nach „${f.name}“ kann nicht sortiert werden`, t.pos, t.end);
      let desc = false;
      if (isKw(peek(), 'desc')) { next(); desc = true; } else if (isKw(peek(), 'asc')) next();
      order.push({ field: f, path: null, desc });
    } while (peek().kind === 'comma');
  }
  if (peek().kind !== 'eof') throw new AqlError(`Unerwartet: „${peek().value}“`, peek().pos, peek().end);
  return { where, order };
}

function checkOp(f: FieldInfo, op: Op, pos: number) {
  const allowed: Record<FieldType, Op[]> = {
    fulltext: ['~', '=', '!~', '!='],
    key: ['=', '!=', '~', '!~', 'in', 'notin'],
    text: ['=', '!=', '~', '!~', 'in', 'notin', 'empty', 'notempty'],
    enum: ['=', '!=', 'in', 'notin', 'empty', 'notempty', '<', '<=', '>', '>='],
    list: ['=', '!=', '~', 'in', 'notin', 'empty', 'notempty'],
    user: ['=', '!=', 'in', 'notin', 'empty', 'notempty', '~'],
    date: ['=', '!=', '<', '<=', '>', '>=', 'empty', 'notempty'],
    number: ['=', '!=', '<', '<=', '>', '>=', 'in', 'notin', 'empty', 'notempty'],
    bool: ['=', '!='],
    ref: ['=', '!=', '~', 'in', 'notin', 'empty', 'notempty'],
    custom: ['=', '!=', '~', '!~', '<', '<=', '>', '>=', 'in', 'notin', 'empty', 'notempty'],
    config: ['=', '!=', 'in', 'notin', 'empty', 'notempty'],
  };
  if (!allowed[f.type].includes(op)) {
    const label = { in: 'IN', notin: 'NICHT IN', empty: 'IST LEER', notempty: 'IST NICHT LEER' }[op as string] ?? op;
    throw new AqlError(`„${label}“ passt nicht zu „${f.name}“ (${f.help})`, pos);
  }
}

/**
 * Relatives oder absolutes Datum → ISO-Zeitpunkt. -7d, +2w, -1m, -1y, -4h; 2026-10-01; 01.10.2026; heute().
 */
export function parseDate(v: Value, now = new Date()): Date {
  if (v.func === 'heute') return startOfDay(now);
  const s = v.raw.trim().toLowerCase();
  const rel = /^([+-]?\d+)\s*([hdwmy]|std|t|tage?|w|wochen?|m|monate?|j|jahre?)$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]![0]!;
    const d = new Date(now);
    if (unit === 'h' || rel[2] === 'std') d.setHours(d.getHours() + n);
    else if (unit === 'd' || unit === 't') d.setDate(d.getDate() + n);
    else if (unit === 'w') d.setDate(d.getDate() + 7 * n);
    else if (unit === 'm') d.setMonth(d.getMonth() + n);
    else d.setFullYear(d.getFullYear() + n);
    return unit === 'h' || rel[2] === 'std' ? d : startOfDay(d);
  }
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (de) return new Date(Number(de[3]), Number(de[2]) - 1, Number(de[1]));
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  throw new AqlError(`Datum erwartet (z. B. -7d, 01.10.2026, heute()), gefunden „${v.raw}“`, v.pos, v.pos + v.raw.length);
}
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function parseBool(v: Value): boolean {
  const s = v.raw.toLowerCase();
  if (['ja', 'true', 'wahr', 'yes', '1', 'j'].includes(s)) return true;
  if (['nein', 'false', 'falsch', 'no', '0', 'n'].includes(s)) return false;
  throw new AqlError(`ja oder nein erwartet, gefunden „${v.raw}“`, v.pos, v.pos + v.raw.length);
}

/** Zuordnung deutscher Kategorienamen zu internen Kategorien (Testfall- und Ausführungsstatus). */
export const CATEGORY_ALIASES: Record<string, string[]> = {
  DRAFT: ['entwurf', 'draft'], REVIEW: ['review', 'prüfung', 'pruefung'], APPROVED: ['freigegeben', 'approved'], DEPRECATED: ['veraltet', 'deprecated'],
  OPEN: ['offen', 'open', 'nicht ausgeführt', 'nicht ausgefuehrt'], IN_PROGRESS: ['in arbeit', 'inarbeit', 'in_progress', 'wip'],
  PASSED: ['bestanden', 'passed', 'ok'], PASSED_WITH_ISSUES: ['bestanden mit einschränkung', 'bestanden mit einschraenkung', 'passed_with_issues', 'mit einschränkung'],
  KNOWN_FAILURE: ['bekannt', 'bekannter fehler', 'fehlgeschlagen (bekannt)', 'known', 'known_failure'],
  FAILED: ['fehlgeschlagen', 'failed', 'nok'], BLOCKED: ['blockiert', 'blocked'], INVALID: ['ungültig', 'ungueltig', 'invalid'],
  NOT_APPLICABLE: ['nicht anwendbar', 'n/a', 'na', 'not_applicable', 'not applicable'],
};
export function categoryOf(raw: string): string | null {
  const s = raw.toLowerCase().trim();
  for (const [cat, names] of Object.entries(CATEGORY_ALIASES)) if (cat.toLowerCase() === s || names.includes(s)) return cat;
  return null;
}

/** Hilfe für die Oberfläche: Felder eines Bereichs mit Beschreibung. */
export function fieldsFor(scope: Scope): FieldInfo[] {
  return FIELDS.filter((f) => f.scopes.includes(scope));
}

/** Prüft eine Abfrage ohne Datenbank; liefert Fehler mit Position oder null. */
export function validate(input: string, scope: Scope): AqlError | null {
  try {
    const q = parse(input, scope);
    const walk = (n: Node | null): void => {
      if (!n) return;
      if (n.type === 'and' || n.type === 'or') n.items.forEach(walk);
      else if (n.type === 'not') walk(n.item);
      else if (n.type === 'cond') {
        if (n.field.type === 'date') n.values.forEach((v) => parseDate(v));
        if (n.field.type === 'bool') n.values.forEach((v) => parseBool(v));
        if (n.field.type === 'number') n.values.forEach((v) => { if (!Number.isFinite(Number(v.raw.replace(',', '.')))) throw new AqlError(`Zahl erwartet, gefunden „${v.raw}“`, v.pos); });
      }
    };
    walk(q.where);
    return null;
  } catch (e) {
    if (e instanceof AqlError) return e;
    throw e;
  }
}
