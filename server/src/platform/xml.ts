/**
 * Kleiner, toleranter XML-Parser ohne Abhängigkeiten (für Ergebnisdateien von Testwerkzeugen): Elemente,
 * Attribute, Text, CDATA; Kommentare, Deklarationen und DOCTYPE werden übersprungen. Keine Entitäten aus DTDs
 * (Schutz vor XXE/„Billion Laughs“). Nicht geschlossene Elemente werden am Ende geschlossen.
 */
import { badRequest } from './http.ts';

export interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string }

const codePoint = (n: number) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\uFFFD');
const decode = (s: string) => (!s.includes('&') ? s : s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d{1,8});/g, (_, n: string) => codePoint(Number(n)))
  .replace(/&#x([0-9a-f]{1,8});/gi, (_, n: string) => codePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&'));

/**
 * Grenzen gegen präparierte Dateien (Sicherheitsreview Teil 2, Befund 1): Verschachtelungstiefe und Anzahl der
 * Elemente. Überschreitungen ergeben 400 mit verständlicher Meldung statt Speicherüberlauf oder Blockade.
 */
export const XML_LIMITS = { depth: 256, elements: 2_000_000 };

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
/** Attribute linear lesen (keine Regex mit Rückverfolgung über lange Tags). */
function parseAttrs(body: string, from: number, out: Record<string, string>): void {
  const n = body.length;
  let i = from;
  while (i < n) {
    while (i < n && isSpace(body.charCodeAt(i))) i++;
    const nameStart = i;
    while (i < n && !isSpace(body.charCodeAt(i)) && body[i] !== '=') i++;
    const name = body.slice(nameStart, i);
    while (i < n && isSpace(body.charCodeAt(i))) i++;
    if (body[i] !== '=') { if (i === nameStart) i++; continue; }
    i++;
    while (i < n && isSpace(body.charCodeAt(i))) i++;
    const q = body[i];
    if (q !== '"' && q !== "'") continue;
    const end = body.indexOf(q, i + 1);
    const value = body.slice(i + 1, end < 0 ? n : end);
    i = end < 0 ? n : end + 1;
    if (name && /^[\w:.-]+$/.test(name)) out[name] = decode(value);
  }
}

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  // offene Elemente je Name: ein Schließ-Tag ohne passendes offenes Element wird in O(1) übersprungen
  const open = new Map<string, number>();
  let count = 0;
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const top = stack.at(-1)!;
    if (lt < 0) { top.text += decode(xml.slice(i)); break; }
    if (lt > i) top.text += decode(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt + 9); top.text += xml.slice(lt + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue; }
    if (xml.startsWith('<?', lt)) { const e = xml.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (xml.startsWith('<!', lt)) {
      // DOCTYPE inkl. internem Teil überspringen
      let depth = 0, k = lt + 2;
      for (; k < n; k++) { if (xml[k] === '[') depth++; else if (xml[k] === ']') depth--; else if (xml[k] === '>' && depth <= 0) break; }
      i = k + 1;
      continue;
    }
    // Tag-Ende suchen, Anführungszeichen in Attributen beachten
    let k = lt + 1, q: string | null = null;
    for (; k < n; k++) { const ch = xml[k]; if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break; }
    const raw = xml.slice(lt + 1, k);
    i = k + 1;
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      if (!open.get(name)) continue; // kein passendes offenes Element
      // bis zum passenden Element schließen (jedes Element wird höchstens einmal geschlossen)
      for (;;) {
        const x = stack.pop()!;
        open.set(x.name, open.get(x.name)! - 1);
        if (x.name === name) break;
      }
      continue;
    }
    const self = raw.endsWith('/');
    const body = self ? raw.slice(0, -1) : raw;
    const m = /^[^\s/>]+/.exec(body);
    if (!m) continue;
    if (++count > XML_LIMITS.elements) throw badRequest(`XML-Datei zu umfangreich (mehr als ${XML_LIMITS.elements.toLocaleString('de-DE')} Elemente)`);
    const node: XmlNode = { name: m[0], attrs: {}, children: [], text: '' };
    parseAttrs(body, m[0].length, node.attrs);
    top.children.push(node);
    if (!self) {
      if (stack.length > XML_LIMITS.depth) throw badRequest(`XML-Datei zu tief verschachtelt (höchstens ${XML_LIMITS.depth} Ebenen)`);
      stack.push(node);
      open.set(node.name, (open.get(node.name) ?? 0) + 1);
    }
  }
  return root;
}

/** Alle Nachfahren mit diesem Namen (Tiefensuche, in Dokumentreihenfolge). */
export function findAll(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}
export const child = (node: XmlNode, name: string) => node.children.find((c) => c.name === name);
export const children = (node: XmlNode, name: string) => node.children.filter((c) => c.name === name);
/** Text eines Elements samt Nachfahren */
export function textOf(node: XmlNode | undefined): string {
  if (!node) return '';
  return (node.text + node.children.map(textOf).join('')).trim();
}
