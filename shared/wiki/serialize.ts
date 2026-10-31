/**
 * Strukturbaum → Jira-Wiki-Markup (Gegenstück zu parse.ts). Der visuelle Editor speichert weiterhin Markup,
 * damit Bestand, Export und Jira-/Zephyr-Herkunft gültig bleiben. Verlustfreiheit wird nicht angenommen,
 * sondern geprüft: {@link roundTrips} vergleicht parse(serialize(parse(x))) mit parse(x).
 */
import { type Block, type Inline, inline, parse } from './parse.ts';

const EMO_CODE: Record<string, string> = {
  check: '/', cross: 'x', warning: '!', question: '?', info: 'i', on: 'on', off: 'off', star: '*',
  thumbsup: 'y', thumbsdown: 'n', plus: '+', minus: '-',
  'star-yellow': '*y', 'star-red': '*r', 'star-green': '*g', 'star-blue': '*b',
};
const MARK: Record<string, string> = { b: '*', i: '_', u: '+', s: '-', sup: '^', sub: '~', cite: '??' };

/** Zeichen, die in Fließtext als Markup gelesen würden – nur bei Bedarf maskieren. */
const SPECIAL = /[*_+\-^~?{}[\]!|]/g;

type Ctx = 'para' | 'cell' | 'line';

function text(s: string, ctx: Ctx): string {
  let out = s;
  if (ctx === 'cell') out = out.replace(/\|/g, '\\|');
  const plain = inline(out);
  if (plain.length === 1 && plain[0] === s) return out;
  if (plain.length === 0 && s === '') return '';
  return s.replace(SPECIAL, '\\$&');
}

function inlines(nodes: Inline[], ctx: Ctx): string {
  return nodes.map((n) => inlineNode(n, ctx)).join('');
}

function inlineNode(n: Inline, ctx: Ctx): string {
  if (typeof n === 'string') return text(n, ctx);
  switch (n.t) {
    case 'b': case 'i': case 'u': case 's': case 'sup': case 'sub': case 'cite': {
      // Leerraum gehört vor/hinter die Markierung (Jira verlangt Nicht-Leerzeichen an beiden Enden)
      const inner = inlines(n.c, ctx);
      const lead = /^\s*/.exec(inner)![0];
      const trail = /\s*$/.exec(inner.slice(lead.length))![0];
      const core = inner.slice(lead.length, inner.length - trail.length);
      if (!core) return inner;
      return `${lead}${MARK[n.t]}${core}${MARK[n.t]}${trail}`;
    }
    case 'mono': return `{{${n.text}}}`;
    case 'br': {
      // Im Absatz als echter Zeilenumbruch (lesbar), sonst als \\ (Listen, Tabellen)
      return ctx === 'para' ? '\n' : '\\\\';
    }
    case 'color': return `{color:${n.color}}${inlines(n.c, ctx)}{color}`;
    case 'emo': return `(${EMO_CODE[n.name] ?? 'i'})`;
    case 'mention': return `[~${n.user}]`;
    case 'attachment': return `[^${n.name}]`;
    case 'img': {
      const opts = Object.entries(n.options).map(([k, v]) => (v === 'true' ? k : `${k}=${v}`)).join(',');
      return `!${n.src}${opts ? `|${opts}` : ''}!`;
    }
    case 'link': {
      const label = inlines(n.c, ctx);
      return n.c.length === 1 && n.c[0] === n.href ? `[${n.href}]` : `[${label}|${n.href}]`;
    }
  }
}

/** Zeilen, die als Blockanfang gelesen würden, dürfen nach einem Umbruch im Absatz nicht beginnen. */
const BLOCK_START = /^\s*([*#-]+\s|h[1-6]\.\s|bq\.\s|\||-{4,}\s*$)|^\s*$/;
function paragraph(nodes: Inline[]): string {
  const raw = inlines(nodes, 'para');
  const lines = raw.split('\n');
  // Umbrüche, nach denen etwas wie ein Blockanfang steht, als \\ schreiben
  // ebenso am Absatzanfang (führende Umbrüche gingen beim Einlesen verloren)
  return lines.reduce((acc, l, i) => (i === 0 ? l : !acc.trim() || BLOCK_START.test(l) ? `${acc}\\\\${l}` : `${acc}\n${l}`), '');
}

function block(b: Block): string {
  switch (b.t) {
    case 'p': return paragraph(b.c);
    case 'h': return `h${b.level}. ${inlines(b.c, 'line')}`;
    case 'hr': return '----';
    case 'code': return `{code${b.lang ? `:${b.lang}` : ''}}\n${b.text}\n{code}`;
    case 'quote': return `{quote}\n${blocks(b.c)}\n{quote}`;
    case 'panel': return `{panel${b.title ? `:title=${b.title}` : ''}}\n${blocks(b.c)}\n{panel}`;
    case 'list': return list(b, '');
    case 'table': return b.rows.map((r) => {
      const cells = r.cells.map((c, i) => `${r.header[i] ? '||' : '|'}${inlines(c, 'cell') || ' '}`);
      return `${cells.join('')}${r.header.at(-1) ? '||' : '|'}`;
    }).join('\n');
  }
}

function list(l: Extract<Block, { t: 'list' }>, prefix: string): string {
  const marker = prefix + (l.ordered ? '#' : '*');
  return l.items.map((it) => {
    const head = `${marker} ${inlines(it.c, 'line')}`;
    const children = it.children.map((c) => (c.t === 'list' ? list(c, marker) : block(c)));
    return [head, ...children].join('\n');
  }).join('\n');
}

export function blocks(bs: Block[]): string {
  return bs.map(block).join('\n\n');
}

export const serialize = blocks;

/** Tiefer Vergleich von Strukturbäumen (Schlüsselreihenfolge egal). */
export function sameTree(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameTree(x, (b as unknown[])[i]));
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameTree((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Lässt sich der Text verlustfrei über den Strukturbaum neu schreiben? */
export function roundTrips(markup: string): boolean {
  const tree = parse(markup);
  return sameTree(tree, parse(serialize(tree)));
}
