/**
 * Parser für Jira-Wiki-Markup (Jira 7 / Zephyr-Texte) → Strukturbaum. Keine HTML-Ausgabe, kein innerHTML:
 * gerendert wird ausschließlich über React-Elemente (siehe Wiki.tsx). Abgedeckt ist, was im migrierten
 * Bestand vorkommt: Panels, Code/Noformat, Zitate, Farben, Überschriften, verschachtelte Listen (* # -),
 * Tabellen, Links, Erwähnungen, Bilder (inkl. Optionen), Anhang-Links, Emoticons und Inline-Formatierungen.
 */

export type Inline =
  | string
  | { t: 'b' | 'i' | 'u' | 's' | 'sup' | 'sub' | 'cite'; c: Inline[] }
  | { t: 'mono'; text: string }
  | { t: 'br' }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'attachment'; name: string }
  | { t: 'mention'; user: string }
  | { t: 'img'; src: string; options: Record<string, string> }
  | { t: 'color'; color: string; c: Inline[] }
  | { t: 'emo'; name: string };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: { c: Inline[]; children: Block[] }[] }
  | { t: 'table'; rows: { header: boolean[]; cells: Inline[][] }[] }
  | { t: 'panel'; title: string | null; c: Block[] }
  | { t: 'code'; text: string; lang: string | null }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' };

// ---------------------------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------------------------

const EMOTICONS: Record<string, string> = {
  '/': 'check', x: 'cross', '!': 'warning', '?': 'question', i: 'info', on: 'on', off: 'off', '*': 'star',
  y: 'thumbsup', n: 'thumbsdown', '+': 'plus', '-': 'minus',
  '*y': 'star-yellow', '*r': 'star-red', '*g': 'star-green', '*b': 'star-blue', '!!': 'warning', '?!': 'question',
};

const NOT_WORD = '(?<![\\p{L}\\p{N}])';
const END_NOT_WORD = '(?![\\p{L}\\p{N}])';
const fmt = (marker: string) => new RegExp(`${NOT_WORD}${marker}(?=\\S)([^\\n]*?\\S)${marker}${END_NOT_WORD}`, 'u');

const INLINE_RULES: { re: RegExp; make: (m: RegExpExecArray) => Inline }[] = [
  { re: /\\\\/, make: () => ({ t: 'br' }) },
  // {{{x}}} → Monospace "{x}": Inhalt darf mit } enden
  { re: /\{\{([\s\S]+?)\}\}(?!\})/, make: (m) => ({ t: 'mono', text: m[1]! }) },
  // Makronamen sind in Jira unabhängig von Groß-/Kleinschreibung ({Color}, {COLOR})
  { re: /\{color:([^}]*)\}([\s\S]*?)\{color\}/i, make: (m) => ({ t: 'color', color: m[1]!.trim(), c: inline(m[2]!) }) },
  { re: /\{anchor:[^}]*\}/i, make: () => '' },
  { re: /!([^!\s|][^!\n|]*?)(?:\|([^!\n]*))?!/, make: (m) => ({ t: 'img', src: m[1]!.trim(), options: imageOptions(m[2]) }) },
  // Nur echte Links: mit "|", URL, Anhang (^), Person (~), Anker (#) oder Ticketschlüssel. Sonstige [eckige Klammern]
  // bleiben Text – ihr Inhalt wird normal formatiert (z. B. "[{color:red}Hinweis{color}]").
  { re: /\[(?=[^\]\n]*\||\s*(?:https?|ftp|file|mailto):|[\^~#]|[A-Z][A-Z0-9_]+-\d+\])([^\]\n]+)\]/, make: (m) => link(m[1]!) },
  { re: /\((\*[yrgb]|\/|x|!!|\?!|!|\?|i|on|off|\*|y|n|\+|-)\)/, make: (m) => ({ t: 'emo', name: EMOTICONS[m[1]!]! }) },
  { re: fmt('\\*'), make: (m) => ({ t: 'b', c: inline(m[1]!) }) },
  { re: fmt('_'), make: (m) => ({ t: 'i', c: inline(m[1]!) }) },
  { re: fmt('\\+'), make: (m) => ({ t: 'u', c: inline(m[1]!) }) },
  // Durchgestrichen: -Text-. Strichfolgen („---->“, „<----“, „-- Hinweis --“) sind Text, keine Marken – sonst würden
  // gezeichnete Pfeile und Trennlinien in lauter durchgestrichene Einzelstriche zerfallen.
  { re: /(?<![\p{L}\p{N}-])-(?=[^\s-])([^\n]*?[^\s-])-(?![\p{L}\p{N}-])/u, make: (m) => ({ t: 's', c: inline(m[1]!) }) },
  { re: fmt('\\^'), make: (m) => ({ t: 'sup', c: inline(m[1]!) }) },
  { re: fmt('~'), make: (m) => ({ t: 'sub', c: inline(m[1]!) }) },
  { re: fmt('\\?\\?'), make: (m) => ({ t: 'cite', c: inline(m[1]!) }) },
];

function imageOptions(raw: string | undefined): Record<string, string> {
  const o: Record<string, string> = {};
  for (const part of (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = part.split('=');
    o[k!.trim().toLowerCase()] = (v ?? 'true').trim();
  }
  return o;
}

function link(body: string): Inline {
  if (body.startsWith('~')) return { t: 'mention', user: body.slice(1) };
  if (body.startsWith('^')) return { t: 'attachment', name: body.slice(1) };
  const bar = body.lastIndexOf('|');
  const text = bar >= 0 ? body.slice(0, bar) : body;
  const target = (bar >= 0 ? body.slice(bar + 1) : body).trim();
  if (target.startsWith('^')) return { t: 'attachment', name: target.slice(1) };
  return { t: 'link', href: target, c: bar >= 0 ? inline(text) : [target] };
}

const MONO = INLINE_RULES[1]!;
const GLOBAL = new Map(INLINE_RULES.map((r) => [r, new RegExp(r.re.source, `${r.re.flags}gd`)]));

/**
 * Nächster Treffer einer Regel ab Position `pos`. Außer für Monospace wird auf dem Text gesucht, in dem
 * Monospace-Bereiche {{…}} maskiert sind – Marken darin (z. B. "_" in "{{feld_name}}") können so keine Formatierung
 * beginnen oder beenden. Gruppen werden auf den Originaltext abgebildet.
 */
function find(r: (typeof INLINE_RULES)[number], text: string, masked: string, pos: number): RegExpExecArray | null {
  const re = GLOBAL.get(r)!;
  re.lastIndex = pos;
  const src = r === MONO ? text : masked;
  const m = re.exec(src);
  if (!m || src === text) return m;
  const idx = (m as RegExpExecArray & { indices: ([number, number] | undefined)[] }).indices;
  const out = idx.map((p) => (p ? text.slice(p[0], p[1]) : undefined)) as unknown as RegExpExecArray;
  out.index = m.index;
  return out;
}

/**
 * Inline-Formatierungen. Linear statt „Rest neu parsen“: Maske einmal berechnen, je Regel den nächsten Treffer
 * merken (er bleibt gültig, solange er hinter der aktuellen Position liegt) und nur den gewählten Treffer aufbauen.
 * Tokens enden nie auf Buchstabe/Ziffer – die Wortgrenzen-Prüfung (Lookbehind) verhält sich daher wie zuvor.
 */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const parts: string[] = [];
  let last = 0;
  for (const mm of text.matchAll(new RegExp(MONO.re.source, 'g'))) {
    parts.push(text.slice(last, mm.index), '\u0001'.repeat(mm[0].length));
    last = mm.index + mm[0].length;
  }
  parts.push(text.slice(last));
  const masked = parts.join('');
  const next = new Map<(typeof INLINE_RULES)[number], RegExpExecArray | null>();
  let pos = 0;
  while (pos < text.length) {
    let best: { m: RegExpExecArray; r: (typeof INLINE_RULES)[number] } | null = null;
    for (const r of INLINE_RULES) {
      let m = next.get(r);
      if (m === undefined || (m !== null && m.index < pos)) {
        m = find(r, text, masked, pos);
        next.set(r, m);
      }
      if (m && (best === null || m.index < best.m.index)) best = { m, r };
    }
    if (!best) {
      out.push(unescape(text.slice(pos)));
      break;
    }
    if (best.m.index > pos) out.push(unescape(text.slice(pos, best.m.index)));
    const node = best.r.make(best.m);
    if (node !== '') out.push(node);
    pos = best.m.index + best.m[0].length;
    if (best.m[0].length === 0) pos++; // Sicherheitsnetz gegen Leertreffer
  }
  // benachbarte Texte zusammenfassen; übrig gebliebene Farbmarkierungen (mit Fett/Kursiv überkreuzt) entfernen
  return out.map((n) => (typeof n === 'string' ? n.replace(/\{color(?::[^}]*)?\}/gi, '') : n)).reduce<Inline[]>((a, n) => {
    if (typeof n === 'string' && typeof a.at(-1) === 'string') a[a.length - 1] = (a.at(-1) as string) + n;
    else if (n !== '') a.push(n);
    return a;
  }, []);
}

const unescape = (s: string) => s.replace(/\\([*_+\-^~?{}[\]!|#])/g, '$1');

// ---------------------------------------------------------------------------------------------
// Blöcke
// ---------------------------------------------------------------------------------------------

type Seg = { kind: 'text'; text: string } | { kind: 'macro'; name: string; params: string | null; raw: string };

const MACRO_RE = /\{(panel|code|noformat|quote|info|note|warning|tip)(?::([^}]*))?\}/gi;
const BOX_TITLE: Record<string, string> = { info: 'Info', note: 'Hinweis', warning: 'Warnung', tip: 'Tipp' };

function segments(text: string): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(MACRO_RE)) {
    if (m.index! > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    out.push({ kind: 'macro', name: m[1]!.toLowerCase(), params: m[2] ?? null, raw: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

function panelTitle(params: string | null): string | null {
  for (const part of (params ?? '').split('|')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim().toLowerCase() === 'title') return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * Farben dürfen in Jira über Zeilen und Listenpunkte reichen. Damit jede Zeile für sich korrekt ist, wird eine
 * offene Farbe am Zeilenende geschlossen und in der Folgezeile wieder geöffnet; verwaiste {color} entfallen.
 */
export function normalizeColors(text: string): string {
  let open: string | null = null;
  return text.split('\n').map((raw) => {
    if (!raw.trim()) return raw; // Leerzeilen bleiben leer (Absatzgrenzen)
    // Strukturelle Präfixe (Listenmarkierung, Überschrift, Zitat, Tabellenzelle) bleiben am Zeilenanfang
    const prefix = /^(\s*(?:[*#-]+\s+|h[1-6]\.\s+|bq\.\s+|\|\|?))/.exec(raw)?.[1] ?? '';
    const line = raw.slice(prefix.length);
    let out = prefix + (open !== null ? `{color:${open}}` : '');
    let last = 0;
    for (const m of line.matchAll(/\{color(?::([^}]*))?\}/gi)) {
      out += line.slice(last, m.index);
      last = m.index! + m[0].length;
      if (m[1] !== undefined) {
        if (open !== null) out += '{color}';
        open = m[1].trim();
        out += `{color:${open}}`;
      } else if (open !== null) {
        out += '{color}';
        open = null;
      } // verwaistes {color} → entfällt
    }
    out += line.slice(last);
    return open !== null ? `${out}{color}` : out;
  }).join('\n');
}

export function parse(text: string | null | undefined): Block[] {
  if (!text) return [];
  // Fehlerhafte Farbangaben aus dem Bestand tolerieren: Leerraum/Zeilenumbruch nach "color:" entfernen
  const cleaned = text.replace(/\r\n?/g, '\n').replace(/\{color:\s+/gi, '{color:');
  const segs = segments(normalizeColors(cleaned));
  let i = 0;
  // Jira-Semantik: Ein Makro gleichen Namens wird nicht verschachtelt – das nächste {name} schließt.
  const parseUntil = (closing: string | null): Block[] => {
    const blocks: Block[] = [];
    let buffer = '';
    const flush = () => {
      if (buffer.trim()) blocks.push(...lines(buffer));
      buffer = '';
    };
    while (i < segs.length) {
      const s = segs[i++]!;
      if (s.kind === 'text') {
        buffer += s.text;
        continue;
      }
      if (closing && s.name === closing && s.params === null) {
        flush();
        return blocks;
      }
      if (s.name === 'code' || s.name === 'noformat') {
        flush();
        let raw = '';
        while (i < segs.length) {
          const x = segs[i++]!;
          if (x.kind === 'macro' && x.name === s.name && x.params === null) break;
          raw += x.kind === 'text' ? x.text : x.raw; // Originalschreibweise im Code erhalten
        }
        blocks.push({ t: 'code', text: raw.replace(/^\n+|\n+$/g, ''), lang: s.name === 'code' ? (s.params?.split('|')[0] || null) : null });
        continue;
      }
      flush();
      const inner = parseUntil(s.name);
      blocks.push(s.name === 'quote' ? { t: 'quote', c: inner }
        : { t: 'panel', title: panelTitle(s.params) ?? BOX_TITLE[s.name] ?? null, c: inner });
    }
    flush();
    return blocks;
  };
  return parseUntil(null);
}

/** Splittet eine Tabellenzeile an | bzw. ||, ohne Links [a|b], Bilder !a|b! oder {{…}} zu zerteilen. */
const ATOMIC = /^(\[[^\]\n]*\]|![^!\s|][^!\n]*?(?:\|[^!\n]*)?!|\{\{[\s\S]*?\}\})/;
function splitRow(line: string): { header: boolean; text: string }[] {
  const cells: { header: boolean; text: string }[] = [];
  let cur = '';
  let header = false;
  let started = false;
  for (let k = 0; k < line.length; k++) {
    const atom = ATOMIC.exec(line.slice(k));
    if (atom) {
      cur += atom[0];
      k += atom[0].length - 1;
      continue;
    }
    const ch = line[k]!;
    if (ch === '|') {
      if (started) cells.push({ header, text: cur });
      header = line[k + 1] === '|';
      if (header) k++;
      cur = '';
      started = true;
      continue;
    }
    cur += ch;
  }
  if (started && cur.trim()) cells.push({ header, text: cur });
  return cells;
}

function lines(text: string): Block[] {
  const out: Block[] = [];
  const ls = text.split('\n');
  let para: string[] = [];
  const flushPara = () => {
    const t = para.join('\n').trim();
    if (t) out.push({ t: 'p', c: inline(t.replace(/\n/g, '\\\\')) });
    para = [];
  };
  for (let k = 0; k < ls.length; k++) {
    const line = ls[k]!;
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      continue;
    }
    const h = /^h([1-6])\.\s+(.*)$/.exec(trimmed);
    if (h) {
      flushPara();
      out.push({ t: 'h', level: Number(h[1]), c: inline(h[2]!) });
      continue;
    }
    if (/^-{4,}$/.test(trimmed)) {
      flushPara();
      out.push({ t: 'hr' });
      continue;
    }
    if (/^bq\.\s/.test(trimmed)) {
      flushPara();
      out.push({ t: 'quote', c: [{ t: 'p', c: inline(trimmed.slice(3).trim()) }] });
      continue;
    }
    if (/^[*#-]+\s/.test(trimmed) && !/^-{2,}\s*$/.test(trimmed)) {
      flushPara();
      const items: { marker: string; text: string }[] = [];
      while (k < ls.length && /^\s*[*#-]+\s/.test(ls[k]!)) {
        const m = /^\s*([*#-]+)\s+(.*)$/.exec(ls[k]!)!;
        items.push({ marker: m[1]!, text: m[2]! });
        k++;
        // Folgezeilen ohne Markierung gehören zum Eintrag (bis Leerzeile)
        while (k < ls.length && ls[k]!.trim() && !/^\s*([*#-]+\s|\||h[1-6]\.|bq\.\s)/.test(ls[k]!)) {
          items.at(-1)!.text += `\\\\${ls[k]!.trim()}`;
          k++;
        }
      }
      k--;
      out.push(...buildList(items));
      continue;
    }
    if (trimmed.startsWith('|')) {
      flushPara();
      const rows: { header: boolean[]; cells: Inline[][] }[] = [];
      let pending = '';
      while (k < ls.length && (ls[k]!.trim().startsWith('|') || (pending && ls[k]!.trim()))) {
        const l = ls[k]!.trim();
        pending = pending ? `${pending}\\\\${l}` : l;
        // Zeile ist vollständig, wenn sie mit | endet (Zellen können über mehrere Zeilen gehen)
        if (pending.endsWith('|') || (k + 1 < ls.length && ls[k + 1]!.trim().startsWith('|')) || k + 1 >= ls.length) {
          const cells = splitRow(pending);
          if (cells.length) rows.push({ header: cells.map((c) => c.header), cells: cells.map((c) => inline(c.text.trim())) });
          pending = '';
        }
        k++;
      }
      if (pending) {
        const cells = splitRow(pending);
        if (cells.length) rows.push({ header: cells.map((c) => c.header), cells: cells.map((c) => inline(c.text.trim())) });
      }
      k--;
      if (rows.length) out.push({ t: 'table', rows });
      continue;
    }
    para.push(line);
  }
  flushPara();
  return out;
}

/** Verschachtelte Listen aus Markierungen wie *, **, #, *#, -, -- */
function buildList(items: { marker: string; text: string }[]): Block[] {
  const root: Block[] = [];
  const stack: { depth: number; list: Extract<Block, { t: 'list' }> }[] = [];
  for (const it of items) {
    const depth = it.marker.length;
    const ordered = it.marker.endsWith('#');
    while (stack.length && stack.at(-1)!.depth > depth) stack.pop();
    let top = stack.at(-1);
    if (!top || top.depth < depth || top.list.ordered !== ordered) {
      const list: Extract<Block, { t: 'list' }> = { t: 'list', ordered, items: [] };
      if (top && top.depth < depth && top.list.items.length) top.list.items.at(-1)!.children.push(list);
      else if (top && top.depth === depth) {
        stack.pop();
        const parent = stack.at(-1);
        if (parent?.list.items.length) parent.list.items.at(-1)!.children.push(list);
        else root.push(list);
      } else root.push(list);
      stack.push({ depth, list });
      top = stack.at(-1)!;
    }
    top.list.items.push({ c: inline(it.text), children: [] });
  }
  return root;
}
