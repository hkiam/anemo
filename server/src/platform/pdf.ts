/**
 * PDF aus Markdown ohne Abhängigkeiten (Berichte als PDF): Überschriften, Absätze mit **fett**, Listen,
 * Tabellen (Spaltenbreiten nach Inhalt, Zeilenumbruch in Zellen, Kopfzeile auf jeder Seite wiederholt),
 * Codeblöcke, Trennlinien; Kopfzeile mit Titel, Fußzeile mit Text und „Seite x von y“.
 *
 * Barrierefrei nach PDF/UA-1 (BITV 2.0) und archivfähig nach PDF/A-2b:
 * - Tagged PDF: Strukturbaum (Document, H1–H4, P, L/LI/Lbl/LBody, Table/THead/TBody/TR/TH/TD, Code), jeder Inhalt
 *   als markierter Inhalt mit MCID und ParentTree; Kopf-/Fußzeilen, Linien, Flächen und die auf Folgeseiten
 *   wiederholte Tabellenkopfzeile sind Artefakte. Lesereihenfolge = Reihenfolge im Inhaltsstrom.
 * - Sprache de-DE, Dokumenttitel im Info-Dictionary und in den XMP-Metadaten (DisplayDocTitle).
 * - Schriften DejaVu Sans/Sans Bold/Sans Mono (server/assets/fonts, Bitstream-Vera-Lizenz) eingebettet als
 *   Teilmenge (Type0/CIDFontType2, Identity-H, ToUnicode) – Unicode-Zeichen wie ✓ ✗ → ≥ bleiben erhalten.
 * - OutputIntent sRGB (server/assets/icc, CC0), Dokument-ID, keine Transparenz, keine Verschlüsselung.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { loadTrueType, type TrueType } from './pdf-font.ts';

const A4 = { w: 595.28, h: 841.89 };
const M = { left: 50, right: 50, top: 62, bottom: 62 };
const WIDTH = A4.w - M.left - M.right;
const LANG = 'de-DE';
const ASSETS = new URL('../../assets/', import.meta.url);

type Font = 'R' | 'B' | 'C';
const FONT_FILES: Record<Font, string> = { R: 'fonts/DejaVuSans.ttf', B: 'fonts/DejaVuSans-Bold.ttf', C: 'fonts/DejaVuSansMono.ttf' };
let fontCache: Record<Font, TrueType> | undefined;
const ttf = (f: Font): TrueType => {
  fontCache ??= { R: loadTrueType(new URL(FONT_FILES.R, ASSETS)), B: loadTrueType(new URL(FONT_FILES.B, ASSETS)), C: loadTrueType(new URL(FONT_FILES.C, ASSETS)) };
  return fontCache[f];
};

/** Ersatz für Zeichen, die in der Schrift fehlen (Emoji u. a.) */
const REPLACE: Record<string, string> = { '⏱': '', '🔒': '', '🐞': '', '✨': '', '🤖': '', '⧉': '', '‍': '', '️': '', '︎': '' };

interface Glyph { gid: number; text: string }
const glyphCache: Record<Font, Map<string, Glyph[]>> = { R: new Map(), B: new Map(), C: new Map() };

/** Zeichen → Glyphen der Schrift; fehlende Zeichen werden ersetzt, Emoji weggelassen, sonst „?“. */
export function glyphs(s: string, font: Font): Glyph[] {
  const out: Glyph[] = [];
  const t = ttf(font);
  const cache = glyphCache[font];
  for (const ch of s.normalize('NFC')) {
    let g = cache.get(ch);
    if (!g) {
      const c = ch.codePointAt(0)!;
      const gid = t.cmap.get(c === 9 ? 32 : c);
      if (c < 32 && c !== 9) g = [];
      else if (gid) g = [{ gid, text: c === 9 ? ' ' : ch }];
      else if (REPLACE[ch] !== undefined) g = glyphs(REPLACE[ch], font);
      else if (c > 0xffff || (c >= 0x2600 && c <= 0x27bf) || (c >= 0xfe00 && c <= 0xfe0f)) g = []; // Emoji/Symbole ohne Glyphe
      else g = [{ gid: t.cmap.get(63)!, text: '?' }];
      cache.set(ch, g);
    }
    out.push(...g);
  }
  return out;
}

/** Breite in pt */
function width(text: string, font: Font, size: number): number {
  const t = ttf(font);
  let w = 0;
  for (const g of glyphs(text, font)) w += t.advance(g.gid);
  return (w * size) / 1000;
}

interface Run { text: string; font: Font }

/** Inline-Markdown: **fett**, `code`, [Text](url), ![Bild](…) */
function inline(s: string, base: Font = 'R'): Run[] {
  const clean = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, a) => `[Bild${a ? `: ${a}` : ''}]`).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1').replace(/<br\s*\/?>/gi, ' ');
  const runs: Run[] = [];
  let bold = base === 'B';
  for (const part of clean.split(/(\*\*|`)/)) {
    if (part === '**') { bold = !bold; continue; }
    if (part === '`') continue;
    if (part) runs.push({ text: part.replace(/\\([|*_`#])/g, '$1'), font: bold ? 'B' : base === 'C' ? 'C' : 'R' });
  }
  return runs;
}

/** Zeilenumbruch über Wörter mit gemischten Schriften. */
function wrap(runs: Run[], size: number, max: number): Run[][] {
  const words: Run[] = [];
  for (const r of runs) for (const w of r.text.split(/(\s+)/)) if (w) words.push({ text: w, font: r.font });
  const lines: Run[][] = [];
  let line: Run[] = [];
  let lw = 0;
  const push = () => { while (line.length && !line.at(-1)!.text.trim()) line.pop(); lines.push(line); line = []; lw = 0; };
  for (const w of words) {
    if (/\n/.test(w.text)) { push(); continue; }
    if (!w.text.trim() && !line.length) continue;
    let ww = width(w.text, w.font, size);
    if (lw + ww > max && line.length) {
      push();
      if (!w.text.trim()) continue;
    }
    // überlange Wörter (URLs, Schlüssel) hart trennen
    let text = w.text;
    while (ww > max) {
      let cut = text.length;
      while (cut > 1 && width(text.slice(0, cut), w.font, size) > max - lw) cut--;
      line.push({ text: text.slice(0, cut), font: w.font });
      push();
      text = text.slice(cut);
      ww = width(text, w.font, size);
    }
    line.push({ text, font: w.font });
    lw += ww;
  }
  if (line.length || !lines.length) push();
  return lines;
}

/** Element des Strukturbaums; Kinder sind Elemente oder markierte Inhalte (Seite, MCID). */
interface Elem { type: string; attrs?: string; parent?: Elem; kids: (Elem | { page: number; mcid: number })[]; ref?: number }
const isElem = (k: Elem['kids'][number]): k is Elem => 'type' in k;

class Layout {
  pages: string[][] = [[]];
  /** je Seite: MCID → Strukturelement (für den ParentTree) */
  marks: Elem[][] = [[]];
  /** benutzte Glyphen je Schrift (GID der Schrift → CID im PDF und Unicode-Text) für Teilmenge, Breiten und ToUnicode */
  used: Record<Font, Map<number, { cid: number; text: string }>> = { R: new Map(), B: new Map(), C: new Map() };
  doc: Elem = { type: 'Document', kids: [] };
  y = A4.h - M.top;
  private get ops() { return this.pages.at(-1)!; }
  newPage() { this.pages.push([]); this.marks.push([]); this.y = A4.h - M.top; }
  ensure(h: number) { if (this.y - h < M.bottom) this.newPage(); }
  /** neues Strukturelement unter parent */
  elem(type: string, parent: Elem, attrs?: string): Elem {
    const e: Elem = { type, parent, kids: [], attrs };
    parent.kids.push(e);
    return e;
  }
  /** Inhalt als markierten Inhalt des Elements auf der aktuellen Seite */
  marked(e: Elem, ops: string[]) {
    const page = this.pages.length - 1;
    const mcid = this.marks[page]!.push(e) - 1;
    e.kids.push({ page, mcid });
    this.ops.push(`/${e.type} <</MCID ${mcid}>> BDC`, ...ops, 'EMC');
  }
  artifact(ops: string[]) { this.ops.push('/Artifact BMC', ...ops, 'EMC'); }
  show(text: string, font: Font): string {
    const used = this.used[font];
    let hex = '';
    for (const g of glyphs(text, font)) {
      let u = used.get(g.gid);
      if (!u) used.set(g.gid, u = { cid: used.size + 1, text: g.text }); // CID 0 bleibt .notdef
      hex += u.cid.toString(16).padStart(4, '0');
    }
    return `<${hex.toUpperCase()}> Tj`;
  }
  /** eine Textzeile; die Läufe folgen ohne neue Position aufeinander (Vorschub = /W-Breiten wie beim Umbruch) */
  textOps(x: number, y: number, runs: Run[], size: number, color = '0 0 0'): string[] {
    if (!runs.length) return [];
    let font: Font | undefined;
    const shown = runs.map((r) => {
      const tf = r.font === font ? '' : `/F${r.font} ${size} Tf `;
      font = r.font;
      return `${tf}${this.show(r.text, r.font)}`;
    });
    return [`BT ${color} rg ${x.toFixed(2)} ${y.toFixed(2)} Td ${shown.join(' ')} ET`];
  }
  lineOps(x1: number, y1: number, x2: number, y2: number, gray = 0.75, w = 0.5) { return `${gray} G ${w} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`; }
  line(x1: number, y1: number, x2: number, y2: number, gray = 0.75, w = 0.5) { this.artifact([this.lineOps(x1, y1, x2, y2, gray, w)]); }
  rect(x: number, y: number, w: number, h: number, gray: number) { this.artifact([`${gray} g ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 g`]); }
  /** Absatz in das Element e; mit bullet entstehen darin Lbl und LBody (e ist dann das LI). Liefert das Element mit dem Text. */
  paragraph(e: Elem, runs: Run[], size: number, opts: { indent?: number; before?: number; after?: number; bullet?: string; color?: string } = {}): Elem {
    const indent = opts.indent ?? 0;
    const lh = size * 1.35;
    const lines = wrap(runs, size, WIDTH - indent);
    const lbl = opts.bullet ? this.elem('Lbl', e) : undefined;
    const body = opts.bullet ? this.elem('LBody', e) : e;
    this.y -= opts.before ?? 0;
    lines.forEach((l, i) => {
      this.ensure(lh);
      this.y -= lh;
      if (i === 0 && lbl) this.marked(lbl, this.textOps(M.left + indent - 11, this.y + 2, [{ text: opts.bullet!, font: 'R' }], size));
      if (l.length) this.marked(body, this.textOps(M.left + indent, this.y + 2, l, size, opts.color));
    });
    this.y -= opts.after ?? 4;
    return body;
  }
  table(rows: string[][], size = 8.5) {
    if (!rows.length) return;
    const n = Math.max(...rows.map((r) => r.length));
    const pad = 3;
    const cells = rows.map((r) => Array.from({ length: n }, (_, i) => inline(r[i] ?? '', 'R')));
    const natural = Array.from({ length: n }, (_, c) => Math.max(...cells.map((r, ri) => r[c]!.reduce((a, x) => a + width(x.text, ri === 0 ? 'B' : x.font, size), 0))) + 2 * pad);
    const longestWord = (r: Run[][], c: number) => Math.max(0, ...r[c]!.flatMap((x) => x.text.split(/\s+/)).map((w) => width(w, 'B', size)));
    const minW = Array.from({ length: n }, (_, c) => Math.min(120, Math.max(28, ...cells.map((r) => longestWord(r, c) + 2 * pad))));
    let widths = natural.map((w, i) => Math.max(w, minW[i]!));
    const sum = widths.reduce((a, b) => a + b, 0);
    if (sum > WIDTH) {
      // erst auf Mindestbreite, Rest anteilig nach Inhalt verteilen
      const minSum = minW.reduce((a, b) => a + b, 0);
      const extra = Math.max(0, WIDTH - minSum);
      const want = widths.map((w, i) => w - minW[i]!);
      const wantSum = want.reduce((a, b) => a + b, 0) || 1;
      widths = minW.map((m, i) => (minSum > WIDTH ? (m * WIDTH) / minSum : m + (want[i]! * extra) / wantSum));
    }
    const total = widths.reduce((a, b) => a + b, 0);
    const lh = size * 1.3;
    const layoutRow = (r: Run[][], header: boolean) => r.map((c, i) => wrap(header ? c.map((x) => ({ ...x, font: 'B' as Font })) : c, size, widths[i]! - 2 * pad));
    const header = layoutRow(cells[0]!, true);
    const table = this.elem('Table', this.doc);
    const thead = this.elem('THead', table);
    const tbody = cells.length > 1 ? this.elem('TBody', table) : undefined;
    /** Zeile zeichnen; parent fehlt bei der wiederholten Kopfzeile (Artefakt) */
    const drawRow = (lines: Run[][][], header: boolean, parent?: Elem) => {
      const h = Math.max(...lines.map((l) => l.length)) * lh + 2 * pad;
      const top = this.y;
      if (header) this.rect(M.left, top - h, total, h, 0.92);
      const tr = parent ? this.elem('TR', parent) : undefined;
      let x = M.left;
      lines.forEach((cl, i) => {
        const ops = cl.flatMap((l, k) => this.textOps(x + pad, top - pad - (k + 1) * lh + 2.5, l, size));
        if (!tr) this.artifact(ops);
        else {
          const cell = header ? this.elem('TH', tr, '<< /O /Table /Scope /Column >>') : this.elem('TD', tr);
          if (ops.length) this.marked(cell, ops);
        }
        x += widths[i]!;
      });
      this.line(M.left, top - h, M.left + total, top - h, 0.8);
      this.y -= h;
    };
    this.ensure(30);
    this.line(M.left, this.y, M.left + total, this.y, 0.6);
    drawRow(header, true, thead);
    for (const r of cells.slice(1)) {
      const lines = layoutRow(r, false);
      const h = Math.max(...lines.map((l) => l.length)) * lh + 2 * pad;
      if (this.y - h < M.bottom) { this.newPage(); this.line(M.left, this.y, M.left + total, this.y, 0.6); drawRow(header, true); }
      drawRow(lines, false, tbody);
    }
    this.y -= 8;
  }
}

const xml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const utf16 = (s: string) => `<FEFF${Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase()}>`;
const utf16hex = (s: string) => Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase();

/** XMP-Metadaten: Titel, Sprache, Autor, Daten und Kennungen für PDF/A-2b und PDF/UA-1 (mit Erweiterungsschema für pdfuaid) */
function xmp(o: { title: string; author?: string; created: string }): string {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
    xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(o.title)}</rdf:li></rdf:Alt></dc:title>
${o.author ? `   <dc:creator><rdf:Seq><rdf:li>${xml(o.author)}</rdf:li></rdf:Seq></dc:creator>\n` : ''}   <dc:language><rdf:Bag><rdf:li>${LANG}</rdf:li></rdf:Bag></dc:language>
   <xmp:CreateDate>${o.created}</xmp:CreateDate>
   <xmp:ModifyDate>${o.created}</xmp:ModifyDate>
   <xmp:MetadataDate>${o.created}</xmp:MetadataDate>
   <xmp:CreatorTool>Anemo</xmp:CreatorTool>
   <pdf:Producer>Anemo</pdf:Producer>
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
   <pdfuaid:part>1</pdfuaid:part>
   <pdfaExtension:schemas>
    <rdf:Bag>
     <rdf:li rdf:parseType="Resource">
      <pdfaSchema:schema>PDF/UA Universal Accessibility Schema</pdfaSchema:schema>
      <pdfaSchema:namespaceURI>http://www.aiim.org/pdfua/ns/id/</pdfaSchema:namespaceURI>
      <pdfaSchema:prefix>pdfuaid</pdfaSchema:prefix>
      <pdfaSchema:property>
       <rdf:Seq>
        <rdf:li rdf:parseType="Resource">
         <pdfaProperty:name>part</pdfaProperty:name>
         <pdfaProperty:valueType>Integer</pdfaProperty:valueType>
         <pdfaProperty:category>internal</pdfaProperty:category>
         <pdfaProperty:description>Indicates, which part of ISO 14289 standard is followed</pdfaProperty:description>
        </rdf:li>
       </rdf:Seq>
      </pdfaSchema:property>
     </rdf:li>
    </rdf:Bag>
   </pdfaExtension:schemas>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** ToUnicode-CMap: CID → Unicode */
function toUnicode(used: Map<number, { cid: number; text: string }>): string {
  const entries = [...used.values()].map((u) => [u.cid, u.text] as const);
  const blocks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100);
    blocks.push(`${part.length} beginbfchar\n${part.map(([g, t]) => `<${g.toString(16).padStart(4, '0').toUpperCase()}> <${utf16hex(t)}>`).join('\n')}\nendbfchar`);
  }
  return ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap', '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def', '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange', ...blocks,
    'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end'].join('\n');
}

/** Markdown (wie von den Berichten erzeugt) als PDF. */
export function markdownToPdf(md: string, o: { title: string; footer?: string; author?: string }): Buffer {
  const L = new Layout();
  const lines = md.replace(/\r/g, '').split('\n');
  // offene Listen je Tiefe; verschachtelte Listen hängen am LBody des letzten Eintrags
  const lists: { l: Elem; ordered: boolean; body?: Elem }[] = [];
  let lastHeading = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (!t) { L.y -= 3; continue; }
    const li = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (!li || /^(-{3,}|\*{3,})$/.test(t)) lists.length = 0;
    if (t.startsWith('```')) {
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.trim().startsWith('```')) code.push(lines[i]!);
      const c = L.elem('Code', L.elem('P', L.doc));
      for (const x of code) L.paragraph(c, [{ text: x || ' ', font: 'C' }], 8, { indent: 8, after: 0 });
      L.y -= 6;
      continue;
    }
    if (t.startsWith('|')) {
      const block: string[][] = [];
      for (; i < lines.length && lines[i]!.trim().startsWith('|'); i++) {
        const row = lines[i]!.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
        if (row.every((c) => /^:?-{2,}:?$/.test(c))) continue;
        block.push(row);
      }
      i--;
      L.table(block);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      const level = h[1]!.length;
      const size = [0, 17, 13.5, 11.5, 10.5][level]!;
      // Strukturebene ohne Sprünge (PDF/UA): höchstens eine Ebene tiefer als die vorige Überschrift
      lastHeading = Math.min(level, lastHeading + 1);
      L.ensure(size * 3);
      L.paragraph(L.elem(`H${lastHeading}`, L.doc), inline(h[2]!, 'B'), size, { before: level <= 2 ? 10 : 6, after: 3, color: level <= 2 ? '0.09 0.27 0.55' : '0 0 0' });
      if (level === 2) L.line(M.left, L.y + 1, A4.w - M.right, L.y + 1, 0.8);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) { L.ensure(10); L.line(M.left, L.y - 4, A4.w - M.right, L.y - 4, 0.7); L.y -= 10; continue; }
    if (li) {
      const ordered = /\d/.test(li[2]!);
      let depth = Math.min(3, Math.floor(li[1]!.length / 2), lists.length);
      if (lists.length > depth + 1) lists.length = depth + 1;
      if (lists[depth] && lists[depth]!.ordered !== ordered) lists.length = depth;
      if (!lists[depth]) {
        const parent = depth > 0 ? lists[depth - 1]!.body : L.doc;
        if (!parent) depth = 0;
        lists[depth] = { l: L.elem('L', parent ?? L.doc, `<< /O /List /ListNumbering /${ordered ? 'Decimal' : 'Disc'} >>`), ordered };
        lists.length = depth + 1;
      }
      const entry = lists[depth]!;
      entry.body = L.paragraph(L.elem('LI', entry.l), inline(li[3]!), 9.5, { indent: 14 + depth * 12, bullet: ordered ? li[2] : '•', after: 1 });
      continue;
    }
    L.paragraph(L.elem('P', L.doc), inline(t), 9.5, { after: 3 });
  }

  // Seiten zusammensetzen: Kopf- und Fußzeile (Artefakte) mit Gesamtseitenzahl
  const total = L.pages.length;
  const gray = '0.45 0.45 0.45';
  const pageOps = L.pages.map((ops, i) => {
    const pageNo = `Seite ${i + 1} von ${total}`;
    const head = ['/Artifact <</Type /Pagination /Subtype /Header>> BDC', ...L.textOps(M.left, A4.h - 36, [{ text: o.title.slice(0, 120), font: 'R' }], 7.5, gray),
      L.lineOps(M.left, A4.h - 42, A4.w - M.right, A4.h - 42, 0.85), 'EMC'];
    const foot = ['/Artifact <</Type /Pagination /Subtype /Footer>> BDC',
      ...(o.footer ? L.textOps(M.left, 34, [{ text: o.footer.slice(0, 140), font: 'R' }], 7.5, gray) : []),
      ...L.textOps(A4.w - M.right - width(pageNo, 'R', 7.5), 34, [{ text: pageNo, font: 'R' }], 7.5, gray),
      L.lineOps(M.left, 46, A4.w - M.right, 46, 0.85), 'EMC'];
    return [...head, ...ops, ...foot].join('\n');
  });

  // PDF-Objekte
  const objs: (string | Buffer)[] = [];
  const add = (o2: string | Buffer) => { objs.push(o2); return objs.length; };
  const stream = (dict: string, data: Buffer, compress = true) => {
    const body = compress ? deflateSync(data) : data;
    return add(Buffer.concat([Buffer.from(`<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${body.length} >>\nstream\n`), body, Buffer.from('\nendstream')]));
  };
  const catalog = add('');
  const pages = add('');

  // Schriften: Teilmenge, Breiten, ToUnicode
  const fontRefs: Partial<Record<Font, number>> = {};
  for (const f of ['R', 'B', 'C'] as Font[]) {
    const used = L.used[f];
    if (!used.size) continue;
    const t = ttf(f);
    // Reihenfolge der CIDs: order[cid] = GID der Schrift
    const order = [0, ...used.keys()];
    const tag = createHash('md5').update(`${f}:${order.join(',')}`).digest().subarray(0, 6).reduce((s, b) => s + String.fromCharCode(65 + (b % 26)), '');
    const name = `${tag}+${t.name}`;
    const program = t.subset(order);
    const file = stream(`/Length1 ${program.length}`, program);
    const desc = add(`<< /Type /FontDescriptor /FontName /${name} /Flags ${32 + (t.fixedPitch ? 1 : 0)} /FontBBox [${t.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${t.ascent} /Descent ${t.descent} /CapHeight ${t.capHeight} /StemV ${f === 'B' ? 120 : 80} /FontFile2 ${file} 0 R >>`);
    // /W: Breiten der CIDs 1…n (aus hmtx, gerundet wie beim Setzen)
    const w = `1 [${order.slice(1).map((g) => t.advance(g)).join(' ')}]`;
    const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /DW 1000 /W [${w}] /CIDToGIDMap /Identity >>`);
    const tu = stream('', Buffer.from(toUnicode(used), 'latin1'));
    fontRefs[f] = add(`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${tu} 0 R >>`);
  }
  const fontRes = (Object.entries(fontRefs) as [Font, number][]).map(([f, r]) => `/F${f} ${r} 0 R`).join(' ');

  // Seiten
  const kids: number[] = pageOps.map(() => add(''));
  pageOps.forEach((content, i) => {
    const s = stream('', Buffer.from(content, 'latin1'));
    objs[kids[i]! - 1] = `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Contents ${s} 0 R /Resources << /Font << ${fontRes} >> >> /StructParents ${i} /Tabs /S >>`;
  });

  // Strukturbaum
  const structRoot = add('');
  const all: Elem[] = [];
  const number = (e: Elem) => { e.ref = add(''); all.push(e); e.kids.filter(isElem).forEach(number); };
  number(L.doc);
  for (const e of all) {
    // markierte Inhalte auf nur einer Seite: /Pg am Element und MCID als Zahl, sonst Verweis (MCR) mit Seite
    const onPages = new Set(e.kids.filter((x) => !isElem(x)).map((x) => (x as { page: number }).page));
    const pg = onPages.size === 1 ? kids[[...onPages][0]!] : undefined;
    const k = e.kids.map((x) => (isElem(x) ? `${x.ref} 0 R` : pg ? String(x.mcid) : `<< /Type /MCR /Pg ${kids[x.page]} 0 R /MCID ${x.mcid} >>`));
    objs[e.ref! - 1] = `<< /Type /StructElem /S /${e.type} /P ${e.parent ? e.parent.ref : structRoot} 0 R${pg ? ` /Pg ${pg} 0 R` : ''}${e.attrs ? ` /A ${e.attrs}` : ''}${k.length ? ` /K ${k.length === 1 ? k[0] : `[${k.join(' ')}]`}` : ''} >>`;
  }
  const nums = L.marks.map((m, i) => `${i} [${m.map((e) => `${e.ref} 0 R`).join(' ')}]`).join(' ');
  objs[structRoot - 1] = `<< /Type /StructTreeRoot /K ${L.doc.ref} 0 R /ParentTree << /Nums [${nums}] >> /ParentTreeNextKey ${total} >>`;

  // Metadaten, OutputIntent, Info
  const now = new Date();
  const iso = `${now.toISOString().slice(0, 19)}+00:00`;
  const pdfDate = `D:${iso.slice(0, 19).replace(/[-:T]/g, '')}+00'00'`;
  const meta = stream('/Type /Metadata /Subtype /XML', Buffer.from(xmp({ title: o.title, author: o.author, created: iso }), 'utf8'), false);
  const icc = stream('/N 3', readFileSync(new URL('icc/sRGB-v2-micro.icc', ASSETS)));
  const intent = add(`<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB IEC61966-2.1) /RegistryName (http://www.color.org) /Info (sRGB IEC61966-2.1) /DestOutputProfile ${icc} 0 R >>`);
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R /StructTreeRoot ${structRoot} 0 R /MarkInfo << /Marked true >> /Lang (${LANG}) /ViewerPreferences << /DisplayDocTitle true >> /Metadata ${meta} 0 R /OutputIntents [${intent} 0 R] >>`;
  objs[pages - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${utf16(o.title)} /Producer (Anemo) /Creator (Anemo) ${o.author ? `/Author ${utf16(o.author)} ` : ''}/CreationDate (${pdfDate}) /ModDate (${pdfDate}) >>`);

  // Objekte ohne Strom (vor allem der Strukturbaum) komprimiert in Objektströmen, dazu ein Querverweisstrom (PDF 1.5+)
  const loose = objs.map((o2, i) => (typeof o2 === 'string' ? i + 1 : 0)).filter((n) => n);
  const where = new Map<number, [number, number]>(); // Objekt → [Objektstrom, Index]
  for (let k = 0; k < loose.length; k += 200) {
    const chunk = loose.slice(k, k + 200);
    const bodies = chunk.map((n) => Buffer.from(`${objs[n - 1] as string}\n`, 'latin1'));
    let off = 0;
    const header = chunk.map((n, j) => { const h = `${n} ${off}`; off += bodies[j]!.length; return h; }).join(' ') + '\n';
    const stm = stream(`/Type /ObjStm /N ${chunk.length} /First ${Buffer.byteLength(header)}`, Buffer.concat([Buffer.from(header), ...bodies]));
    chunk.forEach((n, j) => where.set(n, [stm, j]));
  }
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = new Map<number, number>();
  let pos = parts[0]!.length;
  objs.forEach((o2, i) => {
    if (typeof o2 === 'string') return;
    offsets.set(i + 1, pos);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o2, Buffer.from('\nendobj\n')]);
    parts.push(b);
    pos += b.length;
  });
  const id = createHash('md5').update(Buffer.concat(parts)).update(iso).digest('hex').toUpperCase();
  const xrefNo = objs.length + 1;
  offsets.set(xrefNo, pos);
  const rows = Buffer.alloc(7 * (xrefNo + 1));
  rows.writeUInt8(0, 0); rows.writeUInt32BE(0, 1); rows.writeUInt16BE(65535, 5);
  for (let n = 1; n <= xrefNo; n++) {
    const inStm = where.get(n);
    rows.writeUInt8(inStm ? 2 : 1, 7 * n);
    rows.writeUInt32BE(inStm ? inStm[0] : offsets.get(n)!, 7 * n + 1);
    rows.writeUInt16BE(inStm ? inStm[1] : 0, 7 * n + 5);
  }
  const xdata = deflateSync(rows);
  parts.push(Buffer.from(`${xrefNo} 0 obj\n<< /Type /XRef /Size ${xrefNo + 1} /W [1 4 2] /Root ${catalog} 0 R /Info ${info} 0 R /ID [<${id}> <${id}>] /Filter /FlateDecode /Length ${xdata.length} >>\nstream\n`, 'latin1'),
    xdata, Buffer.from(`\nendstream\nendobj\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
