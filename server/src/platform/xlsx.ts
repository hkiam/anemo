/**
 * Excel-Dateien (XLSX, Office Open XML) ohne Abhängigkeiten: Schreiben mehrerer Tabellenblätter mit fetter
 * Kopfzeile, fixierter erster Zeile, Autofilter und Spaltenbreiten; Lesen von Tabellenblättern als Text-Zeilen.
 * Werte werden nie als Formel geschrieben (Schutz vor Formel-Injektion beim Öffnen in Excel).
 */
import { inflateRawSync } from 'node:zlib';
import { HttpError } from './http.ts';
import { type ZipEntry, zipStream } from './zip.ts';

export type Cell = string | number | boolean | Date | null | undefined;
export interface Sheet { name: string; header: string[]; rows: Cell[][]; widths?: number[] }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // in XML unzulässige Steuerzeichen entfernen
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const col = (i: number): string => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const sheetName = (s: string) => s.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Tabelle';
/** Excel-Datum: Tage seit 1899-12-30 */
const serial = (d: Date) => (d.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000 - d.getTimezoneOffset() / 1440;

function sheetXml(s: Sheet, strings: Map<string, number>): string {
  const idx = (v: string) => { let i = strings.get(v); if (i === undefined) { i = strings.size; strings.set(v, i); } return i; };
  const cell = (v: Cell, r: number, c: number, style = 0): string => {
    const ref = `${col(c)}${r}`;
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : `<c r="${ref}" s="2"><v>${serial(v)}</v></c>`;
    return `<c r="${ref}" t="s"${style ? ` s="${style}"` : ''}><v>${idx(String(v).slice(0, 32_000))}</v></c>`;
  };
  const widths = s.header.map((h, i) => s.widths?.[i] ?? Math.min(60, Math.max(8, h.length + 2,
    ...s.rows.slice(0, 200).map((r) => { const v = r[i]; return v instanceof Date ? 16 : Math.min(60, String(v ?? '').split('\n')[0]!.length + 2); }))));
  const rows = [
    `<row r="1">${s.header.map((h, c) => cell(h, 1, c, 1)).join('')}</row>`,
    ...s.rows.map((r, i) => `<row r="${i + 2}">${r.map((v, c) => cell(v, i + 2, c, typeof v === 'string' && v.includes('\n') ? 3 : 0)).join('')}</row>`),
  ];
  const last = `${col(Math.max(0, s.header.length - 1))}${s.rows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rows.join('')}</sheetData>
${s.header.length ? `<autoFilter ref="A1:${last}"/>` : ''}
</worksheet>`;
}

/** XLSX-Datei als Buffer. */
export async function writeXlsx(sheets: Sheet[]): Promise<Buffer> {
  const strings = new Map<string, number>();
  const sheetXmls = sheets.map((s) => sheetXml(s, strings));
  const names = new Set<string>();
  const unique = sheets.map((s) => { let n = sheetName(s.name); let k = 2; while (names.has(n)) n = `${sheetName(s.name).slice(0, 28)} ${k++}`; names.add(n); return n; });
  const files: ZipEntry[] = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${unique.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${sheets.map((s, i) => s.header.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(unique[i]!).replace(/'/g, "''")}'!$A$1:$${col(s.header.length - 1)}$${s.rows.length + 1}</definedName></definedNames>` : '').join('').replace(/<\/definedNames><definedNames>/g, '')}</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    ...sheetXmls.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x })),
    { name: 'xl/sharedStrings.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.size}" uniqueCount="${strings.size}">${[...strings.keys()].map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>` },
  ];
  const chunks: Buffer[] = [];
  for await (const c of zipStream(files)) chunks.push(c);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------------------------

/**
 * Harte Grenzen beim Lesen (Schutz vor präparierten Dateien, Sicherheitsreview Teil 2, Befund 1): Eine kleine,
 * stark komprimierte Datei darf weder den Speicher füllen (Zeilen-/Spaltenindex aus der Datei) noch die
 * Ereignisschleife blockieren (alles wird linear mit indexOf gescannt, keine Lazy-Regex über das ganze Blatt).
 */
export const XLSX_LIMITS = {
  /** größte Zeilennummer mit Inhalt (fachlich; Excel selbst kann 1 048 576) */
  rows: 200_000,
  /** größter Spaltenindex mit Inhalt (fachlich; Excel selbst kann 16 384) */
  cols: 1_000,
  /** Zellen der Ergebnis-Tabelle insgesamt (Summe der Zeilenlängen über alle Blätter) */
  cells: 5_000_000,
  /** gelesene <row>/<c>-Elemente insgesamt (auch leere) */
  elements: 10_000_000,
  /** Tabellenblätter */
  sheets: 50,
  /** entpackte Bytes insgesamt */
  bytes: 200 * 1024 * 1024,
};
const EXCEL_MAX_ROW = 1_048_576;
const EXCEL_MAX_COL = 16_384;

/** Fehler beim Lesen einer Excel-Datei; wird als 400 mit verständlicher Meldung gemeldet. */
export class XlsxError extends HttpError {
  constructor(message: string) { super(400, message); }
}

/** Einträge eines ZIP-Archivs (Zentralverzeichnis), entpackt bei Bedarf. */
export function unzip(buf: Buffer, maxEntryBytes = 100 * 1024 * 1024): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new XlsxError('Keine gültige ZIP-/XLSX-Datei');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, () => Buffer>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('Beschädigtes ZIP-Verzeichnis');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    out.set(name, () => {
      if (usize > maxEntryBytes) throw new XlsxError(`Datei im Archiv zu groß: ${name}`);
      if (local + 30 > buf.length) throw new XlsxError('Beschädigtes ZIP-Archiv');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) {
        try { return inflateRawSync(data, { maxOutputLength: maxEntryBytes }); } catch (e) {
          throw new XlsxError((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? `Datei im Archiv zu groß: ${name}` : `Beschädigter Eintrag im Archiv: ${name}`);
        }
      }
      throw new XlsxError(`Nicht unterstützte Kompression (${method}) in ${name}`);
    });
  }
  return out;
}

const codePoint = (n: number) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\uFFFD');
const unesc = (s: string) => (s.includes('&') ? s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d{1,8});/g, (_, d) => codePoint(Number(d))).replace(/&#x([0-9a-f]{1,8});/gi, (_, h) => codePoint(parseInt(h, 16))).replace(/&amp;/g, '&') : s);

interface Element { attrs: string; body: string }
/**
 * Elemente eines Namens linear durchlaufen (nicht verschachtelt, wie <row>, <c>, <si>, <t>, <sheet>). Fehlt ein
 * Schließ-Tag, gilt das Element als leer, und für alle weiteren wird nicht mehr gesucht – so bleibt die Laufzeit
 * auch bei präparierten Dateien linear.
 */
function* elements(xml: string, tag: string, from = 0, to = xml.length): Generator<Element> {
  const open = `<${tag}`, close = `</${tag}>`;
  let pos = from, noMoreClose = false;
  for (;;) {
    const start = xml.indexOf(open, pos);
    if (start < 0 || start >= to) return;
    const after = xml.charCodeAt(start + open.length);
    // nur genau dieses Element (<c …> statt <col …>): danach Leerraum, „>“ oder „/“
    if (!(after === 62 || after === 47 || after === 32 || after === 9 || after === 10 || after === 13)) { pos = start + open.length; continue; }
    const gt = xml.indexOf('>', start + open.length);
    if (gt < 0 || gt >= to) return;
    const selfClosing = xml.charCodeAt(gt - 1) === 47;
    const attrs = xml.slice(start + open.length, selfClosing ? gt - 1 : gt);
    pos = gt + 1;
    let body = '';
    if (!selfClosing && !noMoreClose) {
      const end = xml.indexOf(close, gt + 1);
      if (end < 0 || end >= to) noMoreClose = true;
      else { body = xml.slice(gt + 1, end); pos = end + close.length; }
    }
    yield { attrs, body };
  }
}
const attrRe = new Map<string, RegExp>();
const attr = (attrs: string, name: string): string | undefined => {
  let re = attrRe.get(name);
  if (!re) attrRe.set(name, re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  const m = re.exec(attrs);
  return m ? (m[1] ?? m[2]) : undefined;
};
/** Text eines <si>/<is>-Elements (auch Rich Text mit mehreren <t>) */
const textOf = (xml: string) => { let s = ''; for (const t of elements(xml, 't')) s += unesc(t.body); return s; };
/** Inhalt des ersten Kindelements (ohne Regex über den ganzen Text) */
const firstBody = (xml: string, tag: string): string | undefined => { for (const e of elements(xml, tag)) return e.body; return undefined; };

/** Spaltenindex (0-basiert) aus einer Zellreferenz wie „AB12“; -1 ohne Buchstaben, Infinity bei Überlauf. */
function columnOf(ref: string): number {
  let ci = 0, k = 0;
  for (; k < ref.length; k++) {
    const ch = ref.charCodeAt(k);
    if (ch < 65 || ch > 90) break;
    ci = ci * 26 + ch - 64;
    if (ci > EXCEL_MAX_COL) return Infinity;
  }
  return k === 0 ? -1 : ci - 1;
}

/** Tabellenblätter einer XLSX-Datei als Zeilen von Texten (leere Zellen = ''). */
export function readXlsx(buf: Buffer): { name: string; rows: string[][] }[] {
  const zip = unzip(buf);
  let bytes = 0;
  const get = (n: string) => {
    const b = zip.get(n)?.();
    if (!b) return undefined;
    bytes += b.length;
    if (bytes > XLSX_LIMITS.bytes) throw new XlsxError(`Excel-Datei zu groß (entpackt mehr als ${XLSX_LIMITS.bytes / 1024 / 1024} MB)`);
    return b.toString('utf8');
  };
  const wb = get('xl/workbook.xml');
  if (!wb) throw new XlsxError('Keine Excel-Arbeitsmappe (xl/workbook.xml fehlt)');
  const rels = get('xl/_rels/workbook.xml.rels') ?? '';
  const target = new Map<string | undefined, string | undefined>();
  for (const r of elements(rels, 'Relationship')) target.set(attr(r.attrs, 'Id'), attr(r.attrs, 'Target'));
  const sharedXml = get('xl/sharedStrings.xml') ?? '';
  const shared: string[] = [];
  let elementCount = 0, cellCount = 0;
  const tick = () => {
    if (++elementCount > XLSX_LIMITS.elements) throw new XlsxError(`Excel-Datei zu umfangreich (mehr als ${XLSX_LIMITS.elements.toLocaleString('de-DE')} Elemente)`);
  };
  for (const si of elements(sharedXml, 'si')) { tick(); shared.push(textOf(si.body)); }

  const sheetRefs = [...elements(wb, 'sheet')];
  if (sheetRefs.length > XLSX_LIMITS.sheets) throw new XlsxError(`Zu viele Tabellenblätter (höchstens ${XLSX_LIMITS.sheets})`);
  // dasselbe Blatt nur einmal lesen, auch wenn die Arbeitsmappe es mehrfach nennt
  const parsed = new Map<string, string[][]>();
  const readSheet = (path: string): string[][] => {
    const known = parsed.get(path);
    if (known) return known;
    const xml = get(path) ?? '';
    const rows: string[][] = [];
    let lastRow = 0;
    for (const r of elements(xml, 'row')) {
      tick();
      const rAttr = attr(r.attrs, 'r');
      const rowNo = rAttr !== undefined && /^\d{1,10}$/.test(rAttr) ? Number(rAttr) : lastRow + 1;
      if (rowNo < 1 || rowNo > EXCEL_MAX_ROW) throw new XlsxError(`Ungültige Zeilennummer ${rowNo} (Excel erlaubt höchstens ${EXCEL_MAX_ROW.toLocaleString('de-DE')})`);
      lastRow = rowNo;
      // Zellen dünn sammeln: nur Zellen mit Inhalt belegen Speicher
      const cells: [number, string][] = [];
      let next = 0;
      for (const c of elements(r.body, 'c')) {
        tick();
        const ref = attr(c.attrs, 'r');
        let ci = ref !== undefined ? columnOf(ref) : -1;
        if (ci < 0) ci = next;
        if (!(ci < EXCEL_MAX_COL)) throw new XlsxError(`Ungültige Zellreferenz ${String(ref).slice(0, 20)} in Zeile ${rowNo} (Excel erlaubt höchstens ${EXCEL_MAX_COL.toLocaleString('de-DE')} Spalten)`);
        next = ci + 1;
        const type = attr(c.attrs, 't');
        const v = c.body ? firstBody(c.body, 'v') : undefined;
        let val = '';
        if (type === 's') val = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') val = textOf(firstBody(c.body, 'is') ?? '');
        else if (type === 'b') val = v === '1' ? 'ja' : 'nein';
        else val = v !== undefined ? unesc(v) : '';
        if (val === '') continue;
        if (ci >= XLSX_LIMITS.cols) throw new XlsxError(`Zu viele Spalten: Zelle ${String(ref ?? '').slice(0, 20)} in Zeile ${rowNo} liegt hinter Spalte ${XLSX_LIMITS.cols.toLocaleString('de-DE')}`);
        cells.push([ci, val]);
      }
      if (!cells.length) continue;
      if (rowNo > XLSX_LIMITS.rows) throw new XlsxError(`Zu viele Zeilen: Zeile ${rowNo.toLocaleString('de-DE')} mit Inhalt, höchstens ${XLSX_LIMITS.rows.toLocaleString('de-DE')} Zeilen erlaubt`);
      let width = 0;
      for (const [ci] of cells) if (ci >= width) width = ci + 1;
      cellCount += width;
      if (cellCount > XLSX_LIMITS.cells) throw new XlsxError(`Excel-Datei zu umfangreich (mehr als ${XLSX_LIMITS.cells.toLocaleString('de-DE')} Zellen)`);
      const row: string[] = new Array<string>(width).fill('');
      for (const [ci, val] of cells) row[ci] = val;
      while (rows.length < rowNo - 1) rows.push([]);
      rows[rowNo - 1] = row;
    }
    parsed.set(path, rows);
    return rows;
  };
  return sheetRefs.map((m) => {
    const name = unesc(attr(m.attrs, 'name') ?? 'Tabelle');
    const rid = attr(m.attrs, 'r:id');
    const t = (target.get(rid) ?? '').replace(/^\/?xl\//, '');
    return { name, rows: readSheet(`xl/${t}`) };
  });
}
