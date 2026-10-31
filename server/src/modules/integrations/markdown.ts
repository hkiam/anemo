/**
 * Jira-Wiki-Markup → Markdown (CommonMark) für Systeme wie OpenProject. Grundlage ist derselbe Parser wie für die
 * Anzeige in Anemo (shared/wiki) – was dort richtig aussieht, kommt so auch im Ticket an: Überschriften, Formatierung,
 * Listen, Tabellen, Code/Noformat, Panels und Zitate; Farben entfallen (Markdown kennt keine), Strichfolgen wie
 * „----->“ bleiben Text.
 *
 * Sicherheit: Die Ausgabe hängt nicht vom Sanitizer der Gegenstelle ab – Links nur mit http(s)/mailto (sonst nur der
 * Text), rohes HTML wird maskiert (`<` → `&lt;`), Bilder werden nie eingebettet, sondern als Link ausgegeben (kein
 * Nachladen externer Bilder, kein Tracking der Ticketleser). Das gilt auch für Markdown, das schon im Text steht.
 */
import { type Block, type Inline, parse } from '../../../../shared/wiki/parse.ts';

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s<>"]+$/i;
const safeUrl = (u: string) => (SAFE_URL.test(u.trim()) ? u.trim().replace(/[()]/g, (c) => encodeURIComponent(c)) : null);
const EMO: Record<string, string> = { tick: '✓', cross: '✗', warning: '⚠', information: 'ℹ', question: '?', plus: '+', minus: '−', thumbsup: '👍', thumbsdown: '👎', smile: '🙂', sad: '🙁', wink: '😉', lightbulb: '💡', star: '★' };

/** Text maskieren: HTML als Entität, Markdown-Zeichen mit Backslash – vorhandene Markdown-Links/-Bilder werden geprüft übernommen. */
function text(s: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const m of s.matchAll(/(!?)\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g)) {
    parts.push(escape(s.slice(last, m.index)));
    parts.push(mdLink(m[2] || (m[1] ? 'Bild' : m[3]!), m[3]!));
    last = m.index! + m[0].length;
  }
  parts.push(escape(s.slice(last)));
  return parts.join('');
}
const escape = (s: string) => s
  .replace(/&(?![a-z]+;|#\d+;)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/([\\`*_[\]~|])/g, '\\$1');
function mdLink(label: string, url: string): string {
  const u = safeUrl(url);
  const t = escape(label.replace(/[[\]]/g, '').trim() || url.trim());
  return u ? `[${t}](${u})` : t;
}

function inl(c: Inline[]): string {
  return c.map((x) => {
    if (typeof x === 'string') return text(x);
    switch (x.t) {
      case 'b': return wrap('**', inl(x.c));
      case 'i': case 'cite': return wrap('*', inl(x.c));
      case 's': return wrap('~~', inl(x.c));
      case 'u': case 'sup': case 'sub': case 'color': return inl(x.c);
      case 'mono': return `\`${x.text.replace(/`/g, 'ʼ')}\``;
      case 'br': return '  \n';
      case 'link': {
        const label = x.c.map((y) => (typeof y === 'string' ? y : '')).join('') || x.href;
        return x.href.startsWith('#') ? text(label) : mdLink(label, x.href);
      }
      case 'attachment': return `\`${x.name.replace(/`/g, 'ʼ')}\``;
      case 'mention': return `@${text(x.user)}`;
      case 'img': return safeUrl(x.src) ? mdLink(`Bild: ${x.src.split('/').pop() ?? 'Bild'}`, x.src) : `\`${x.src.replace(/`/g, 'ʼ')}\``;
      case 'emo': return EMO[x.name] ?? '';
    }
  }).join('');
}
/** Leere bzw. nur aus Leerraum bestehende Formatierung nicht ausgeben (`****` würde als Text erscheinen) */
const wrap = (m: string, s: string) => (s.trim() ? `${m}${s.trim()}${m}` : s);

/** Zeilenanfänge, die Markdown als Struktur lesen würde (Liste, Überschrift, Zitat, Nummer), maskieren. */
const line = (s: string) => s.replace(/^(\s*)([-+#>]|\d+[.)])(?=\s|$)/, (_, sp: string, m: string) => `${sp}\\${m}`);

function blocks(bs: Block[], depth = 0): string[] {
  const out: string[] = [];
  for (const b of bs) {
    switch (b.t) {
      case 'p': out.push(inl(b.c).split('\n').map(line).join('\n')); break;
      case 'h': out.push(`${'#'.repeat(b.level)} ${inl(b.c).replace(/\s*\n\s*/g, ' ')}`); break;
      case 'list': out.push(listMd(b, depth)); break;
      case 'table': {
        const rows = b.rows.map((r) => `| ${r.cells.map((c) => inl(c).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|') || ' ').join(' | ')} |`);
        const n = Math.max(1, ...b.rows.map((r) => r.cells.length));
        out.push([rows[0] ?? '|  |', `|${' --- |'.repeat(n)}`, ...rows.slice(1)].join('\n'));
        break;
      }
      case 'code': {
        const fence = b.text.includes('```') ? '~~~~' : '```';
        out.push(`${fence}${b.lang ?? ''}\n${b.text}\n${fence}`);
        break;
      }
      case 'panel': out.push(quote([...(b.title ? [`**${text(b.title)}**`] : []), ...blocks(b.c)])); break;
      case 'quote': out.push(quote(blocks(b.c))); break;
      case 'hr': out.push('---'); break;
    }
  }
  return out;
}
const quote = (parts: string[]) => parts.join('\n\n').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

function listMd(b: Extract<Block, { t: 'list' }>, depth: number): string {
  const pad = '  '.repeat(depth);
  return b.items.map((it) => {
    const head = `${pad}${b.ordered ? '1.' : '-'} ${inl(it.c).split('\n').join(`\n${pad}  `)}`;
    const children = it.children.map((c) => (c.t === 'list' ? listMd(c, depth + 1) : blocks([c], depth + 1).map((x) => x.split('\n').map((l) => `${pad}  ${l}`).join('\n')).join('\n')));
    return [head, ...children].join('\n');
  }).join('\n');
}

export function wikiToMarkdown(wiki: string): string {
  return blocks(parse(wiki)).join('\n\n');
}
