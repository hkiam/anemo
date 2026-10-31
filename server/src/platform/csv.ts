/**
 * CSV lesen und schreiben (RFC 4180) – Excel-freundlich: Semikolon, UTF-8 mit BOM, CRLF. Beim Lesen werden
 * Trennzeichen (; , Tab) und Zeichensatz (UTF-8 bzw. Windows-1252 aus älterem Excel) erkannt.
 */
import { badRequest } from './http.ts';

/** Zellen, die Excel als Formel ausführen würde, mit Apostroph entschärfen (CSV-Injektion). */
const neutralize = (s: string) => (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s) ? `'${s}` : s);

export function writeCsv(header: string[], rows: (string | number | boolean | Date | null | undefined)[][], sep = ';'): Buffer {
  const fmt = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? (Number.isNaN(v.getTime()) ? '' : v.toISOString()) : typeof v === 'boolean' ? (v ? 'ja' : 'nein') : String(v);
    const n = neutralize(s);
    return /["\r\n]/.test(n) || n.includes(sep) ? `"${n.replace(/"/g, '""')}"` : n;
  };
  const text = [header, ...rows].map((r) => r.map(fmt).join(sep)).join('\r\n') + '\r\n';
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
}

/** Text aus Bytes: UTF-8 (mit/ohne BOM), sonst Windows-1252. */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** Obergrenze der Zellen (Schutz vor Speicherüberlauf durch Dateien aus lauter Trennzeichen) */
export const CSV_MAX_CELLS = 5_000_000;

export function parseCsv(input: string): string[][] {
  const firstLine = input.slice(0, input.search(/\r?\n/) >>> 0 || input.length);
  const counts = [';', ',', '\t'].map((s) => [s, firstLine.split(s).length] as const).sort((a, b) => b[1] - a[1]);
  const sep = counts[0]![1] > 1 ? counts[0]![0] : ';';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let cells = 0;
  const count = () => { if (++cells > CSV_MAX_CELLS) throw badRequest(`CSV-Datei zu umfangreich (mehr als ${CSV_MAX_CELLS.toLocaleString('de-DE')} Zellen)`); };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') { if (input[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') { quoted = true; continue; }
    if (ch === sep) { count(); row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      count(); row.push(cell); rows.push(row); row = []; cell = '';
      continue;
    }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  // vom Export entschärfte Formelzeichen wieder herstellen
  return rows.map((r) => r.map((c) => (/^'[=+\-@]/.test(c) ? c.slice(1) : c)));
}
