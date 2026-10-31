/**
 * TrueType-Schriften für PDF ohne Abhängigkeiten: Tabellen lesen (cmap, hmtx, glyf/loca), Zeichen auf Glyphen
 * abbilden, Breiten liefern und eine Teilmenge (nur benutzte Glyphen, dicht neu nummeriert) für die Einbettung als
 * CIDFontType2 mit Identity-H und CIDToGIDMap Identity erzeugen (CID = neue Glyphnummer).
 */
import { readFileSync } from 'node:fs';

export interface TrueType {
  /** PostScript-Name (aus der name-Tabelle) */
  name: string;
  unitsPerEm: number;
  numGlyphs: number;
  bbox: [number, number, number, number];
  ascent: number;
  descent: number;
  capHeight: number;
  fixedPitch: boolean;
  /** Unicode → Glyphnummer */
  cmap: Map<number, number>;
  /** Vorschub je Glyphe in 1/1000 em (gerundet; dieselben Werte stehen im PDF unter /W) */
  advance(gid: number): number;
  /** Schriftprogramm nur mit den angegebenen Glyphen (und ihren Bestandteilen), neu nummeriert: order[i] → i */
  subset(order: number[]): Buffer;
}

interface Table { offset: number; length: number }

export function loadTrueType(path: string | URL): TrueType {
  return parseTrueType(readFileSync(path));
}

export function parseTrueType(buf: Buffer): TrueType {
  const tables = new Map<string, Table>();
  const numTables = buf.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const r = 12 + i * 16;
    tables.set(buf.toString('latin1', r, r + 4), { offset: buf.readUInt32BE(r + 8), length: buf.readUInt32BE(r + 12) });
  }
  const tab = (tag: string) => {
    const t = tables.get(tag);
    if (!t) throw new Error(`TrueType: Tabelle ${tag} fehlt`);
    return t;
  };
  const head = tab('head').offset;
  const unitsPerEm = buf.readUInt16BE(head + 18);
  const scale = (v: number) => Math.round((v * 1000) / unitsPerEm);
  const bbox: [number, number, number, number] = [buf.readInt16BE(head + 36), buf.readInt16BE(head + 38), buf.readInt16BE(head + 40), buf.readInt16BE(head + 42)].map(scale) as [number, number, number, number];
  const longLoca = buf.readInt16BE(head + 50) === 1;
  const hhea = tab('hhea').offset;
  const numberOfHMetrics = buf.readUInt16BE(hhea + 34);
  const numGlyphs = buf.readUInt16BE(tab('maxp').offset + 4);
  const hmtx = tab('hmtx').offset;
  const widths = new Uint16Array(numGlyphs);
  for (let g = 0; g < numGlyphs; g++) widths[g] = scale(buf.readUInt16BE(hmtx + 4 * Math.min(g, numberOfHMetrics - 1)));

  const os2 = tables.get('OS/2');
  const capHeight = os2 && buf.readUInt16BE(os2.offset) >= 2 ? scale(buf.readInt16BE(os2.offset + 88)) : bbox[3];
  const post = tables.get('post');
  const fixedPitch = post ? buf.readUInt32BE(post.offset + 12) !== 0 : false;

  // cmap: bevorzugt Format 12 (volles Unicode), sonst Format 4 (BMP); eingebettete Teilmengen haben keine
  const cmap = new Map<number, number>();
  const cm = tables.get('cmap')?.offset ?? -1;
  const subs: { pid: number; eid: number; off: number }[] = [];
  for (let i = 0; cm >= 0 && i < buf.readUInt16BE(cm + 2); i++) subs.push({ pid: buf.readUInt16BE(cm + 4 + i * 8), eid: buf.readUInt16BE(cm + 6 + i * 8), off: cm + buf.readUInt32BE(cm + 8 + i * 8) });
  const f12 = subs.find((s) => s.pid === 3 && s.eid === 10 && buf.readUInt16BE(s.off) === 12);
  const f4 = subs.find((s) => s.pid === 3 && s.eid === 1 && buf.readUInt16BE(s.off) === 4);
  if (f12) {
    const n = buf.readUInt32BE(f12.off + 12);
    for (let i = 0; i < n; i++) {
      const g = f12.off + 16 + i * 12;
      const start = buf.readUInt32BE(g); const end = buf.readUInt32BE(g + 4); const gid = buf.readUInt32BE(g + 8);
      for (let c = start; c <= end; c++) cmap.set(c, gid + c - start);
    }
  } else if (f4) {
    const segX2 = buf.readUInt16BE(f4.off + 6);
    const ends = f4.off + 14; const starts = ends + segX2 + 2; const deltas = starts + segX2; const ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = buf.readUInt16BE(ends + 2 * s); const start = buf.readUInt16BE(starts + 2 * s);
      const delta = buf.readInt16BE(deltas + 2 * s); const ro = buf.readUInt16BE(ranges + 2 * s);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let gid: number;
        if (ro === 0) gid = (c + delta) & 0xffff;
        else {
          gid = buf.readUInt16BE(ranges + 2 * s + ro + 2 * (c - start));
          if (gid) gid = (gid + delta) & 0xffff;
        }
        if (gid) cmap.set(c, gid);
      }
    }
  } else if (cm >= 0) throw new Error('TrueType: keine Unicode-cmap');

  let name = 'Font';
  const nm = tables.get('name');
  if (nm) {
    const count = buf.readUInt16BE(nm.offset + 2); const strings = nm.offset + buf.readUInt16BE(nm.offset + 4);
    for (let i = 0; i < count; i++) {
      const r = nm.offset + 6 + i * 12;
      if (buf.readUInt16BE(r + 6) !== 6) continue;
      const pid = buf.readUInt16BE(r); const len = buf.readUInt16BE(r + 8); const off = strings + buf.readUInt16BE(r + 10);
      name = pid === 3 || pid === 0 ? Buffer.from(buf.subarray(off, off + len)).swap16().toString('utf16le') : buf.toString('latin1', off, off + len);
      break;
    }
    name = name.replace(/[^A-Za-z0-9-]/g, '');
  }

  const loca = tab('loca').offset;
  const glyf = tab('glyf').offset;
  const glyphRange = (g: number): [number, number] => longLoca
    ? [buf.readUInt32BE(loca + 4 * g), buf.readUInt32BE(loca + 4 * g + 4)]
    : [buf.readUInt16BE(loca + 2 * g) * 2, buf.readUInt16BE(loca + 2 * g + 2) * 2];

  /** Teilmenge mit neuer, dichter Nummerierung: Glyphe order[i] erhält die Nummer i (order[0] muss .notdef = 0 sein). */
  function subset(order: number[]): Buffer {
    const list = [...order];
    const index = new Map(list.map((g, i) => [g, i]));
    const parts: Buffer[] = [];
    const offsets: number[] = [];
    let pos = 0;
    // die Liste wächst, wenn zusammengesetzte Glyphen Bestandteile nachziehen; deren Verweise werden umnummeriert
    for (let i = 0; i < list.length; i++) {
      const [a, b] = glyphRange(list[i]!);
      offsets.push(pos);
      if (b <= a) continue;
      const data = Buffer.from(buf.subarray(glyf + a, glyf + b));
      if (data.readInt16BE(0) < 0) {
        let p = 10;
        for (;;) {
          const flags = data.readUInt16BE(p);
          const comp = data.readUInt16BE(p + 2);
          let ni = index.get(comp);
          if (ni === undefined) { ni = list.push(comp) - 1; index.set(comp, ni); }
          data.writeUInt16BE(ni, p + 2);
          p += 4 + (flags & 0x1 ? 4 : 2) + (flags & 0x8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
          if (!(flags & 0x20)) break;
        }
      }
      parts.push(data);
      pos += data.length;
      if (pos % 4) { const padLen = 4 - (pos % 4); parts.push(Buffer.alloc(padLen)); pos += padLen; }
    }
    offsets.push(pos);
    const n = list.length;
    const newLoca = Buffer.alloc(4 * (n + 1));
    offsets.forEach((o, i) => newLoca.writeUInt32BE(o, 4 * i));
    // hmtx: Vorschub und linker Rand je neuer Glyphe
    const hm = Buffer.alloc(4 * n);
    list.forEach((g, i) => {
      const adv = buf.readUInt16BE(hmtx + 4 * Math.min(g, numberOfHMetrics - 1));
      const lsb = g < numberOfHMetrics ? buf.readInt16BE(hmtx + 4 * g + 2) : buf.readInt16BE(hmtx + 4 * numberOfHMetrics + 2 * (g - numberOfHMetrics));
      hm.writeUInt16BE(adv, 4 * i);
      hm.writeInt16BE(lsb, 4 * i + 2);
    });
    const copy = (tag: string) => { const x = tab(tag); return Buffer.from(buf.subarray(x.offset, x.offset + x.length)); };
    const newHead = copy('head');
    newHead.writeUInt32BE(0, 8); // checkSumAdjustment, unten neu berechnet
    newHead.writeInt16BE(1, 50); // lange loca
    const newHhea = copy('hhea');
    newHhea.writeUInt16BE(n, 34);
    const newMaxp = copy('maxp');
    newMaxp.writeUInt16BE(n, 4);
    const out: Record<string, Buffer> = { head: newHead, hhea: newHhea, maxp: newMaxp, hmtx: hm, loca: newLoca, glyf: Buffer.concat(parts) };
    // weitere Tabellen, die PDF für eingebettete TrueType-Schriften verlangt (ISO 32000-1, 9.9): Hinting
    for (const t of ['cvt ', 'fpgm', 'prep']) if (tables.has(t)) out[t] = copy(t);
    return writeSfnt(out);
  }

  return { name, unitsPerEm, numGlyphs, bbox, ascent: scale(buf.readInt16BE(hhea + 4)), descent: scale(buf.readInt16BE(hhea + 6)), capHeight, fixedPitch, cmap, advance: (g) => widths[g] ?? 0, subset };
}

function checksum(b: Buffer): number {
  const p = b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b;
  let sum = 0;
  for (let i = 0; i < p.length; i += 4) sum = (sum + p.readUInt32BE(i)) >>> 0;
  return sum;
}

function writeSfnt(tables: Record<string, Buffer>): Buffer {
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  const pow = 2 ** Math.floor(Math.log2(n));
  const header = Buffer.alloc(12 + 16 * n);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(n, 4);
  header.writeUInt16BE(pow * 16, 6);
  header.writeUInt16BE(Math.log2(pow), 8);
  header.writeUInt16BE(n * 16 - pow * 16, 10);
  const body: Buffer[] = [];
  let off = header.length;
  let headAt = 0;
  tags.forEach((tag, i) => {
    const data = tables[tag]!;
    const r = 12 + i * 16;
    header.write(tag, r, 'latin1');
    header.writeUInt32BE(checksum(data), r + 4);
    header.writeUInt32BE(off, r + 8);
    header.writeUInt32BE(data.length, r + 12);
    if (tag === 'head') headAt = off;
    const padded = data.length % 4 ? Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]) : data;
    body.push(padded);
    off += padded.length;
  });
  const font = Buffer.concat([header, ...body]);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8);
  return font;
}
