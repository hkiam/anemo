/**
 * Brücke zwischen Strukturbaum und bearbeitbarem DOM (contentEditable).
 * - toDom erzeugt Elemente ausschließlich über createElement/textContent (kein HTML-Durchreichen).
 * - fromDom liest beliebiges DOM (eigene Editorfläche, eingefügtes HTML aus Word/Browser) und behält nur, was
 *   Jira-Markup ausdrücken kann. Damit ist Einfügen zugleich Bereinigen: Skripte, Stile, Ereignisattribute fallen weg.
 */
import type { Block, Inline } from '../../../shared/wiki/parse.ts';

export type ImageResolver = (src: string) => string | null;

const EMOJI: Record<string, string> = {
  check: '✅', cross: '❌', warning: '⚠️', question: '❓', info: 'ℹ️', on: '💡', off: '⚫', star: '⭐',
  thumbsup: '👍', thumbsdown: '👎', plus: '➕', minus: '➖',
  'star-yellow': '⭐', 'star-red': '🔴', 'star-green': '🟢', 'star-blue': '🔵',
};

// ---------------------------------------------------------------------------------------------
// Strukturbaum → DOM
// ---------------------------------------------------------------------------------------------

export function toDom(doc: Document, blocks: Block[], resolve: ImageResolver): DocumentFragment {
  const frag = doc.createDocumentFragment();
  for (const b of blocks) frag.append(blockEl(doc, b, resolve));
  return frag;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, children: (Node | string)[] = [], attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

const atom = (doc: Document, label: string, attrs: Record<string, string>, cls = 'wiki-atom') =>
  el(doc, 'span', [label], { contenteditable: 'false', class: cls, ...attrs });

export function imageEl(doc: Document, src: string, options: Record<string, string>, resolve: ImageResolver): HTMLElement {
  const url = resolve(src);
  const opts = JSON.stringify(options);
  if (!url) return atom(doc, `🖼 ${src.split('/').pop()}`, { 'data-img': src, 'data-options': opts, title: 'Bild nicht als Anhang vorhanden' }, 'wiki-missing');
  const img = el(doc, 'img', [], { src: url, alt: src.split('/').pop()!, 'data-img': src, 'data-options': opts });
  if (options.width && /^\d+$/.test(options.width)) img.style.width = `${options.width}px`;
  return img;
}

export function attachmentEl(doc: Document, name: string): HTMLElement {
  return atom(doc, `📎 ${name}`, { 'data-attachment': name });
}

function inlineEls(doc: Document, nodes: Inline[], resolve: ImageResolver): (Node | string)[] {
  return nodes.map((n) => inlineEl(doc, n, resolve));
}

function inlineEl(doc: Document, n: Inline, resolve: ImageResolver): Node | string {
  if (typeof n === 'string') return n;
  const kids = () => inlineEls(doc, 'c' in n ? n.c : [], resolve);
  switch (n.t) {
    case 'b': return el(doc, 'strong', kids());
    case 'i': return el(doc, 'em', kids());
    case 'u': return el(doc, 'u', kids());
    case 's': return el(doc, 's', kids());
    case 'sup': return el(doc, 'sup', kids());
    case 'sub': return el(doc, 'sub', kids());
    case 'cite': return el(doc, 'cite', kids());
    case 'mono': return el(doc, 'code', [n.text]);
    case 'br': return el(doc, 'br');
    case 'color': {
      const s = el(doc, 'span', kids(), { 'data-color': n.color });
      if (/^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(n.color)) s.style.color = n.color;
      return s;
    }
    case 'emo': return atom(doc, EMOJI[n.name] ?? '•', { 'data-emo': n.name });
    case 'mention': return atom(doc, `@${n.user}`, { 'data-mention': n.user }, 'chip');
    case 'attachment': return attachmentEl(doc, n.name);
    case 'img': return imageEl(doc, n.src, n.options, resolve);
    case 'link': {
      const a = el(doc, 'a', kids(), { 'data-href': n.href, title: n.href });
      if (/^(https?:|mailto:)/i.test(n.href)) a.setAttribute('href', n.href);
      return a;
    }
  }
}

function blockEl(doc: Document, b: Block, resolve: ImageResolver): Node {
  switch (b.t) {
    case 'p': return el(doc, 'p', inlineEls(doc, b.c, resolve));
    case 'h': return el(doc, `h${Math.min(6, Math.max(1, b.level))}` as 'h1', inlineEls(doc, b.c, resolve));
    case 'hr': return el(doc, 'hr');
    case 'code': return el(doc, 'pre', [b.text], b.lang ? { 'data-lang': b.lang } : {});
    case 'quote': return el(doc, 'blockquote', [toDom(doc, b.c, resolve)]);
    case 'panel': {
      const title = el(doc, 'div', [b.title ?? 'Hinweis'], { class: 'wiki-panel-title', contenteditable: 'false' });
      return el(doc, 'div', [title, el(doc, 'div', [toDom(doc, b.c, resolve)], { class: 'wiki-panel-body' })],
        { class: 'wiki-panel', 'data-panel': b.title ?? '' });
    }
    case 'list': return el(doc, b.ordered ? 'ol' : 'ul', b.items.map((it) => el(doc, 'li', [...inlineEls(doc, it.c, resolve), toDom(doc, it.children, resolve)])));
    case 'table': return el(doc, 'table', [el(doc, 'tbody', b.rows.map((r) =>
      el(doc, 'tr', r.cells.map((c, i) => el(doc, r.header[i] ? 'th' : 'td', inlineEls(doc, c, resolve))))))]);
  }
}

// ---------------------------------------------------------------------------------------------
// DOM → Strukturbaum
// ---------------------------------------------------------------------------------------------

const SKIP = new Set(['STYLE', 'SCRIPT', 'META', 'TITLE', 'HEAD', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'svg', 'SVG', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'IFRAME', 'OBJECT']);
const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'PRE', 'BLOCKQUOTE', 'UL', 'OL', 'TABLE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'DL', 'ADDRESS', 'BODY', 'CENTER']);
const MARKS: Record<string, 'b' | 'i' | 'u' | 's' | 'sup' | 'sub' | 'cite'> = {
  STRONG: 'b', B: 'b', EM: 'i', I: 'i', U: 'u', INS: 'u', S: 's', STRIKE: 's', DEL: 's', SUP: 'sup', SUB: 'sub', CITE: 'cite',
};

const isEl = (n: Node): n is HTMLElement => n.nodeType === 1;
const cleanText = (s: string) => s.replace(/ /g, ' ').replace(/[​﻿]/g, '');

/** Inline-Knoten zusammenfassen: benachbarte Texte vereinen, leere Formatierungen entfernen. */
function tidy(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    if (typeof n === 'string') {
      if (!n) continue;
      if (typeof out.at(-1) === 'string') out[out.length - 1] = (out.at(-1) as string) + n;
      else out.push(n);
    } else if ('c' in n && n.t !== 'link' && n.c.length === 0) {
      continue;
    } else out.push(n);
  }
  return out;
}

function trimInlines(nodes: Inline[]): Inline[] {
  const out = [...nodes];
  while (out.length && out[0] && typeof out[0] !== 'string' && out[0].t === 'br') out.shift();
  while (out.length && typeof out.at(-1) !== 'string' && (out.at(-1) as { t: string }).t === 'br') out.pop();
  if (typeof out[0] === 'string') out[0] = out[0].replace(/^\s+/, '');
  if (typeof out.at(-1) === 'string') out[out.length - 1] = (out.at(-1) as string).replace(/\s+$/, '');
  return tidy(out);
}

function inlineOf(node: Node): Inline[] {
  if (node.nodeType === 3) return [cleanText(node.textContent ?? '')];
  if (!isEl(node) || SKIP.has(node.tagName)) return [];
  const e = node;
  const kids = () => tidy([...e.childNodes].flatMap(inlineOf));
  const d = e.dataset;
  if (d.img !== undefined) return [{ t: 'img', src: d.img, options: parseOptions(d.options) }];
  if (d.attachment !== undefined) return [{ t: 'attachment', name: d.attachment }];
  if (d.emo !== undefined) return [{ t: 'emo', name: d.emo }];
  if (d.mention !== undefined) return [{ t: 'mention', user: d.mention }];
  if (d.color !== undefined) return [{ t: 'color', color: d.color, c: kids() }];
  switch (e.tagName) {
    case 'BR': return [{ t: 'br' }];
    case 'CODE': case 'KBD': case 'SAMP': case 'TT': return [{ t: 'mono', text: cleanText(e.textContent ?? '') }];
    case 'IMG': {
      const src = e.getAttribute('src') ?? '';
      // Fremde Bilder nur als Verweis (http/https); eingebettete data:-Bilder werden beim Einfügen hochgeladen
      return /^https?:\/\//i.test(src) ? [{ t: 'img', src, options: {} }] : [];
    }
    case 'A': {
      const href = d.href ?? e.getAttribute('href') ?? '';
      const c = kids();
      if (!href || /^javascript:/i.test(href)) return c;
      return [{ t: 'link', href, c: c.length ? c : [href] }];
    }
    case 'FONT': {
      const color = e.getAttribute('color');
      return color ? [{ t: 'color', color, c: kids() }] : kids();
    }
  }
  const mark = MARKS[e.tagName];
  if (mark) return [{ t: mark, c: kids() }];
  // Inline-Stile aus Word/Browsern auswerten (fett/kursiv), alles andere verwerfen
  const style = e.getAttribute('style') ?? '';
  if (e.tagName === 'SPAN' && /font-weight:\s*(bold|[6-9]00)/i.test(style)) return [{ t: 'b', c: kids() }];
  if (e.tagName === 'SPAN' && /font-style:\s*italic/i.test(style)) return [{ t: 'i', c: kids() }];
  if (BLOCK_TAGS.has(e.tagName) || e.tagName === 'LI' || e.tagName === 'TR') {
    // Block innerhalb eines Inline-Kontexts (z. B. Absatz in Tabellenzelle): mit Umbrüchen abflachen
    const parts = blocksOf(e).map(flatten).filter((x) => x.length);
    return parts.flatMap((p, i) => (i ? [{ t: 'br' } as Inline, ...p] : p));
  }
  return kids();
}

function parseOptions(raw: string | undefined): Record<string, string> {
  try {
    const o = JSON.parse(raw ?? '{}');
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/** Block zu Inline-Folge (für Listenpunkte und Tabellenzellen). */
function flatten(b: Block): Inline[] {
  switch (b.t) {
    case 'p': case 'h': return b.c;
    case 'code': return [{ t: 'mono', text: b.text }];
    case 'hr': return [];
    case 'quote': case 'panel': return b.c.map(flatten).filter((x) => x.length).flatMap((p, i) => (i ? [{ t: 'br' } as Inline, ...p] : p));
    case 'list': return b.items.flatMap((it, i) => (i ? [{ t: 'br' } as Inline, ...it.c] : it.c));
    case 'table': return b.rows.flatMap((r, i) => (i ? [{ t: 'br' } as Inline, ...r.cells.flat()] : r.cells.flat()));
  }
}

function preText(e: HTMLElement): string {
  let s = '';
  const walk = (n: Node) => {
    if (n.nodeType === 3) s += n.textContent ?? '';
    else if (isEl(n)) {
      if (n.tagName === 'BR') s += '\n';
      else {
        if ((n.tagName === 'DIV' || n.tagName === 'P') && s && !s.endsWith('\n')) s += '\n';
        n.childNodes.forEach(walk);
      }
    }
  };
  e.childNodes.forEach(walk);
  return cleanText(s).replace(/^\n+|\n+$/g, '');
}

function listOf(e: HTMLElement): Extract<Block, { t: 'list' }> {
  const items: { c: Inline[]; children: Block[] }[] = [];
  for (const li of [...e.children].filter((x): x is HTMLElement => isEl(x))) {
    if (li.tagName === 'UL' || li.tagName === 'OL') {
      // falsch verschachtelte Liste (Browser): an den vorherigen Punkt hängen
      if (items.length) items.at(-1)!.children.push(listOf(li));
      else items.push({ c: [], children: [listOf(li)] });
      continue;
    }
    const inl: Inline[] = [];
    const children: Block[] = [];
    for (const n of [...li.childNodes]) {
      if (isEl(n) && (n.tagName === 'UL' || n.tagName === 'OL')) children.push(listOf(n));
      else {
        const parts = inlineOf(n);
        if (inl.length && isEl(n) && (n.tagName === 'P' || n.tagName === 'DIV') && parts.length) inl.push({ t: 'br' });
        inl.push(...parts);
      }
    }
    items.push({ c: trimInlines(inl), children });
  }
  return { t: 'list', ordered: e.tagName === 'OL', items };
}

export function blocksOf(root: Node): Block[] {
  const out: Block[] = [];
  let run: Inline[] = [];
  const flushRun = () => {
    const c = trimInlines(run);
    if (c.length) out.push({ t: 'p', c });
    run = [];
  };
  for (const n of [...root.childNodes]) {
    if (!isEl(n) || !(BLOCK_TAGS.has(n.tagName) || n.dataset.panel !== undefined)) {
      run.push(...inlineOf(n));
      continue;
    }
    flushRun();
    const e = n;
    if (e.dataset.panel !== undefined) {
      const body = e.querySelector(':scope > .wiki-panel-body') ?? e;
      out.push({ t: 'panel', title: e.dataset.panel || null, c: blocksOf(body) });
      continue;
    }
    switch (e.tagName) {
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
        const c = trimInlines([...e.childNodes].flatMap(inlineOf));
        if (c.length) out.push({ t: 'h', level: Number(e.tagName[1]), c });
        break;
      }
      case 'HR': out.push({ t: 'hr' }); break;
      case 'PRE': {
        const text = preText(e);
        if (text) out.push({ t: 'code', text, lang: e.dataset.lang ?? null });
        break;
      }
      case 'BLOCKQUOTE': {
        const c = blocksOf(e);
        if (c.length) out.push({ t: 'quote', c });
        break;
      }
      case 'UL': case 'OL': {
        const l = listOf(e);
        if (l.items.some((it) => it.c.length || it.children.length)) out.push(l);
        break;
      }
      case 'TABLE': {
        const rows = [...e.querySelectorAll('tr')].map((tr) => {
          const cells = [...tr.children].filter((x): x is HTMLElement => isEl(x) && (x.tagName === 'TD' || x.tagName === 'TH'));
          return { header: cells.map((c) => c.tagName === 'TH'), cells: cells.map((c) => trimInlines([...c.childNodes].flatMap(inlineOf))) };
        }).filter((r) => r.cells.length);
        if (rows.length) out.push({ t: 'table', rows });
        break;
      }
      default: {
        // P, DIV, SECTION …: enthält es weitere Blöcke, rekursiv, sonst Absatz
        const hasBlocks = [...e.children].some((x) => BLOCK_TAGS.has(x.tagName) || (x as HTMLElement).dataset?.panel !== undefined);
        if (hasBlocks) out.push(...blocksOf(e));
        else {
          const c = trimInlines([...e.childNodes].flatMap(inlineOf));
          if (c.length) out.push({ t: 'p', c });
        }
      }
    }
  }
  flushRun();
  return out;
}
