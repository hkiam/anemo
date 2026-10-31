/**
 * Strukturbaum → HTML-Zeichenkette für Berichte und Lieferpakete (serverseitig). Jeder Text wird maskiert,
 * Links nur für http(s)/mailto, Farben nur unbedenkliche Werte – es wird nie Markup aus dem Inhalt durchgereicht.
 */
import { type Block, type Inline, inline, parse } from './parse.ts';

/** Bildquelle (Dateiname bzw. Jira-URL) → URL im Bericht; null = nicht vorhanden */
export type HtmlImageResolver = (src: string) => string | null;

const EMOJI: Record<string, string> = {
  check: '✅', cross: '❌', warning: '⚠️', question: '❓', info: 'ℹ️', on: '💡', off: '⚫', star: '⭐',
  thumbsup: '👍', thumbsdown: '👎', plus: '➕', minus: '➖',
  'star-yellow': '⭐', 'star-red': '🔴', 'star-green': '🟢', 'star-blue': '🔵',
};

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const safeColor = (c: string) => (/^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(c) ? c : null);
const safeHref = (h: string) => (/^(https?:|mailto:)/i.test(h) ? h : null);

function inlines(nodes: Inline[], img: HtmlImageResolver): string {
  return nodes.map((n) => inlineHtml(n, img)).join('');
}

function inlineHtml(n: Inline, img: HtmlImageResolver): string {
  if (typeof n === 'string') return esc(n);
  switch (n.t) {
    case 'b': return `<strong>${inlines(n.c, img)}</strong>`;
    case 'i': return `<em>${inlines(n.c, img)}</em>`;
    case 'u': return `<u>${inlines(n.c, img)}</u>`;
    case 's': return `<s>${inlines(n.c, img)}</s>`;
    case 'sup': return `<sup>${inlines(n.c, img)}</sup>`;
    case 'sub': return `<sub>${inlines(n.c, img)}</sub>`;
    case 'cite': return `<cite>${inlines(n.c, img)}</cite>`;
    case 'mono': return `<code>${esc(n.text)}</code>`;
    case 'br': return '<br>';
    case 'color': {
      const c = safeColor(n.color);
      return c ? `<span style="color:${c}">${inlines(n.c, img)}</span>` : inlines(n.c, img);
    }
    case 'emo': return EMOJI[n.name] ?? '';
    case 'mention': return `@${esc(n.user)}`;
    case 'attachment': return `📎 ${esc(n.name)}`;
    case 'img': {
      const url = img(n.src);
      const label = esc(n.src.split('/').pop() ?? n.src);
      return url ? `<img src="${esc(url)}" alt="${label}" class="wiki-img">` : `<span class="missing">🖼 ${label}</span>`;
    }
    case 'link': {
      const h = safeHref(n.href);
      return h ? `<a href="${esc(h)}">${inlines(n.c, img)}</a>` : inlines(n.c, img);
    }
  }
}

function blockHtml(b: Block, img: HtmlImageResolver): string {
  switch (b.t) {
    case 'p': return `<p>${inlines(b.c, img)}</p>`;
    case 'h': return `<h${Math.min(6, b.level + 3)}>${inlines(b.c, img)}</h${Math.min(6, b.level + 3)}>`;
    case 'hr': return '<hr>';
    case 'code': return `<pre>${esc(b.text)}</pre>`;
    case 'quote': return `<blockquote>${blocksHtml(b.c, img)}</blockquote>`;
    case 'panel': return `<div class="panel">${b.title ? `<div class="panel-title">${inlines(inline(b.title), img)}</div>` : ''}${blocksHtml(b.c, img)}</div>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      return `<${tag}>${b.items.map((it) => `<li>${inlines(it.c, img)}${blocksHtml(it.children, img)}</li>`).join('')}</${tag}>`;
    }
    case 'table': return `<table class="wiki-table">${b.rows.map((r) => `<tr>${r.cells.map((c, i) => (r.header[i] ? `<th>${inlines(c, img)}</th>` : `<td>${inlines(c, img)}</td>`)).join('')}</tr>`).join('')}</table>`;
  }
}

function blocksHtml(bs: Block[], img: HtmlImageResolver): string {
  return bs.map((b) => blockHtml(b, img)).join('');
}

/** Jira-Wiki-Text als sicheres HTML */
export function wikiToHtml(text: string | null | undefined, img: HtmlImageResolver = () => null): string {
  return text?.trim() ? blocksHtml(parse(text), img) : '';
}
