/**
 * Jira-Wiki-Markup → reiner Text (für Titel, Betreffzeilen, Vorschauen). Grundlage ist derselbe Parser wie für die
 * Anzeige: Formatierung, Farben, Makros und Bilder verschwinden, Linktexte und Erwähnungen bleiben.
 */
import { type Block, type Inline, parse } from './parse.ts';

const EMO: Record<string, string> = { tick: '✓', cross: '✗', warning: '!', information: 'i', question: '?', plus: '+', minus: '-', thumbsup: '+1', thumbsdown: '-1' };

export function inlineText(c: Inline[]): string {
  return c.map((x) => {
    if (typeof x === 'string') return x;
    switch (x.t) {
      case 'mono': return x.text;
      case 'br': return '\n';
      case 'link': return inlineText(x.c);
      case 'attachment': return x.name;
      case 'mention': return `@${x.user}`;
      case 'img': return '';
      case 'emo': return EMO[x.name] ?? '';
      default: return 'c' in x ? inlineText(x.c) : '';
    }
  }).join('');
}

function blockLines(b: Block): string[] {
  switch (b.t) {
    case 'p': case 'h': return [inlineText(b.c)];
    case 'list': return b.items.flatMap((it) => [inlineText(it.c), ...it.children.flatMap(blockLines)]);
    case 'table': return b.rows.map((r) => r.cells.map(inlineText).join(' | '));
    case 'panel': return [...(b.title ? [b.title] : []), ...b.c.flatMap(blockLines)];
    case 'quote': return b.c.flatMap(blockLines);
    case 'code': return b.text.split('\n');
    case 'hr': return [];
  }
}

/** Reiner Text, Zeilen erhalten (Leerzeilen entfernt). */
export function wikiToText(wiki: string | null | undefined): string {
  return parse(wiki).flatMap(blockLines).flatMap((l) => l.split('\n')).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/**
 * Erste aussagekräftige Zeile (mit Buchstaben oder Ziffern) als Kurztext, höchstens `max` Zeichen. Zeilen nur aus
 * Zeichen wie „----->“ (gezeichnete Pfeile, Trennlinien) zählen nicht.
 */
export function wikiSummary(wiki: string | null | undefined, max = 80): string {
  const line = wikiToText(wiki).split('\n').find((l) => /[\p{L}\p{N}]/u.test(l)) ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
