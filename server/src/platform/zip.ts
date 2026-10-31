/**
 * ZIP ohne Abhängigkeiten: Schreiber (Streaming, für Lieferpakete, Excel und Projektpakete) und Leser (Projektpakete).
 *
 * Schreiber: Texte werden komprimiert (Deflate), Binärdateien (Bilder, PDF – meist bereits komprimiert) gespeichert.
 * ZIP64 (Einträge oder Paket über 4 GiB, mehr als 65 535 Einträge) wird nur geschrieben, wo es nötig ist. Gestreamte
 * Einträge (Größe vorab unbekannt) tragen immer ZIP64-Angaben und einen Datendeskriptor (ADR-0027).
 *
 * Leser: liest aus einer Datei mit wahlfreiem Zugriff über das Zentralverzeichnis (auch ZIP64), prüft Namen gegen
 * Zip-Slip, begrenzt Anzahl, Gesamtgröße und Kompressionsverhältnis (Zip-Bomben) und prüft CRC und Größe beim Lesen.
 */
import { createReadStream } from 'node:fs';
import { type FileHandle, open, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { crc32, createDeflateRaw, createInflateRaw, deflateRawSync } from 'node:zlib';
import { HttpError } from './http.ts';

export type ZipEntry =
  | { name: string; data: Buffer | string }
  | { name: string; path: string }
  /** Inhalt wird beim Schreiben erzeugt (z. B. NDJSON aus einem Datenbank-Cursor) und komprimiert */
  | { name: string; stream: () => AsyncIterable<Buffer | string> };

export interface ZipWriteOptions {
  now?: Date;
  /** ZIP64-Angaben auch ohne Notwendigkeit schreiben (Tests) */
  forceZip64?: boolean;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

const dosTime = (d: Date) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d: Date) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

async function fileCrc(path: string): Promise<number> {
  let c = 0;
  for await (const chunk of createReadStream(path)) c = crc32(chunk as Buffer, c);
  return c;
}

/** Erweiterungsfeld ZIP64 (0x0001) mit den übergebenen 64-Bit-Werten in der vorgeschriebenen Reihenfolge. */
function zip64Extra(values: number[]): Buffer {
  const b = Buffer.alloc(4 + 8 * values.length);
  b.writeUInt16LE(0x0001, 0); b.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return b;
}

/** Komprimiert einen Strom und liefert die komprimierten Teile; CRC und Größe stehen danach in `stats`. */
async function* deflateStream(source: AsyncIterable<Buffer | string>, stats: { crc: number; size: number; compressed: number }): AsyncGenerator<Buffer> {
  async function* counted() {
    for await (const chunk of source) {
      const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (!b.length) continue;
      stats.crc = crc32(b, stats.crc);
      stats.size += b.length;
      yield b;
    }
  }
  const deflate = Readable.from(counted()).pipe(createDeflateRaw());
  for await (const out of deflate) {
    stats.compressed += (out as Buffer).length;
    yield out as Buffer;
  }
}

export async function* zipStream(entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>, opts: ZipWriteOptions = {}): AsyncGenerator<Buffer> {
  const now = opts.now ?? new Date();
  const force = !!opts.forceZip64;
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  for await (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    if (name.length > MAX16) throw new Error(`Dateiname im Archiv zu lang: ${e.name.slice(0, 80)}…`);
    const localOffset = offset;
    let method: number, crc: number, size: number, compressed: number;
    let zip64: boolean;
    const streamed = 'stream' in e;
    const header = (flags: number, m: number, c: number, cs: number, us: number, extra: Buffer) => {
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(extra.length ? 45 : 20, 4); local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(m, 8); local.writeUInt16LE(dosTime(now), 10); local.writeUInt16LE(dosDate(now), 12);
      local.writeUInt32LE(c >>> 0, 14); local.writeUInt32LE(cs, 18); local.writeUInt32LE(us, 22);
      local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
      return local;
    };
    if (streamed) {
      // Größe unbekannt: ZIP64-Platzhalter im lokalen Kopf, echte Werte im Datendeskriptor
      method = 8; zip64 = true;
      const extra = zip64Extra([0, 0]);
      const local = header(0x0808, method, 0, MAX32, MAX32, extra); // UTF-8-Namen + Datendeskriptor
      yield local; yield name; yield extra;
      offset += local.length + name.length + extra.length;
      const stats = { crc: 0, size: 0, compressed: 0 };
      for await (const chunk of deflateStream(e.stream(), stats)) yield chunk;
      ({ crc, size, compressed } = stats);
      const dd = Buffer.alloc(24);
      dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc >>> 0, 4);
      dd.writeBigUInt64LE(BigInt(compressed), 8); dd.writeBigUInt64LE(BigInt(size), 16);
      yield dd;
      offset += compressed + dd.length;
    } else {
      let payload: Buffer | null = null;
      if ('data' in e) {
        const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
        const deflated = deflateRawSync(raw);
        const useDeflate = deflated.length < raw.length;
        payload = useDeflate ? deflated : raw;
        method = useDeflate ? 8 : 0;
        crc = crc32(raw);
        size = raw.length;
        compressed = payload.length;
      } else {
        size = (await stat(e.path)).size;
        crc = await fileCrc(e.path);
        method = 0;
        compressed = size;
      }
      zip64 = force || size >= MAX32 || compressed >= MAX32;
      const extra = zip64 ? zip64Extra([size, compressed]) : Buffer.alloc(0);
      const local = header(0x0800, method, crc, zip64 ? MAX32 : compressed, zip64 ? MAX32 : size, extra);
      yield local; yield name; if (extra.length) yield extra;
      if (payload) yield payload;
      else {
        let read = 0;
        for await (const chunk of createReadStream((e as { path: string }).path)) { read += (chunk as Buffer).length; yield chunk as Buffer; }
        if (read !== size) throw new Error(`Datei hat sich beim Packen verändert: ${e.name}`);
      }
      offset += local.length + name.length + extra.length + compressed;
    }
    // Zentralverzeichnis: ZIP64-Felder nur für Werte, die nicht in 32 Bit passen (bzw. für ZIP64-Einträge)
    const bigSizes = zip64 || size >= MAX32 || compressed >= MAX32;
    const bigOffset = force || localOffset >= MAX32;
    const cextra = bigSizes || bigOffset ? zip64Extra([...(bigSizes ? [size, compressed] : []), ...(bigOffset ? [localOffset] : [])]) : Buffer.alloc(0);
    const cd = Buffer.alloc(46);
    const version = cextra.length ? 45 : 20;
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(version, 4); cd.writeUInt16LE(version, 6); cd.writeUInt16LE(streamed ? 0x0808 : 0x0800, 8);
    cd.writeUInt16LE(method, 10); cd.writeUInt16LE(dosTime(now), 12); cd.writeUInt16LE(dosDate(now), 14);
    cd.writeUInt32LE(crc >>> 0, 16); cd.writeUInt32LE(bigSizes ? MAX32 : compressed, 20); cd.writeUInt32LE(bigSizes ? MAX32 : size, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(cextra.length, 30); cd.writeUInt32LE(bigOffset ? MAX32 : localOffset, 42);
    central.push(cd, name, cextra);
    count++;
  }
  const cdBuf = Buffer.concat(central);
  const cdOffset = offset;
  const needZip64 = force || count >= MAX16 || cdOffset >= MAX32 || cdBuf.length >= MAX32;
  yield cdBuf;
  if (needZip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0); rec.writeBigUInt64LE(44n, 4); rec.writeUInt16LE(45, 12); rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(count), 24); rec.writeBigUInt64LE(BigInt(count), 32);
    rec.writeBigUInt64LE(BigInt(cdBuf.length), 40); rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(cdOffset + cdBuf.length), 8); loc.writeUInt32LE(1, 16);
    yield rec; yield loc;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(needZip64 ? MAX16 : count, 8); end.writeUInt16LE(needZip64 ? MAX16 : count, 10);
  end.writeUInt32LE(needZip64 ? MAX32 : cdBuf.length, 12); end.writeUInt32LE(needZip64 ? MAX32 : cdOffset, 16);
  yield end;
}

// ---- Leser ----

/** Fehler beim Lesen eines Archivs; wird als 400 mit verständlicher Meldung gemeldet. */
export class ZipError extends HttpError {
  constructor(message: string) { super(400, message); }
}

export interface ZipReadLimits {
  /** höchstens so viele Einträge */
  maxEntries?: number;
  /** Summe der entpackten Größen */
  maxTotalBytes?: number;
  /** höchstens so groß je Eintrag (entpackt) */
  maxEntryBytes?: number;
  /** Kompressionsverhältnis entpackt/gepackt für Einträge ab 1 MiB */
  maxRatio?: number;
}

export interface ZipEntryInfo {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export interface ZipReader {
  entries: Map<string, ZipEntryInfo>;
  /** Inhalt als Strom; prüft am Ende CRC und Größe */
  stream(name: string): Readable;
  /** Inhalt vollständig (nur für kleine Einträge, z. B. manifest.json) */
  read(name: string): Promise<Buffer>;
  close(): Promise<void>;
}

/** Erlaubte Namen: relative Pfade ohne „..“, ohne Laufwerk, ohne Backslash und Steuerzeichen. */
export function safeEntryName(name: string): boolean {
  if (!name || name.length > 1024 || name.startsWith('/') || /[\\\0-\x1f]/.test(name) || /^[A-Za-z]:/.test(name)) return false;
  return name.split('/').every((seg, i, all) => seg !== '..' && seg !== '.' && (seg !== '' || i === all.length - 1));
}

const DEFAULT_LIMITS: Required<ZipReadLimits> = {
  maxEntries: 2_000_000, maxTotalBytes: 256 * 1024 ** 3, maxEntryBytes: 64 * 1024 ** 3, maxRatio: 1000,
};

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const b = Buffer.alloc(length);
  const { bytesRead } = await fh.read(b, 0, length, position);
  if (bytesRead !== length) throw new ZipError('Beschädigtes Archiv (unerwartetes Dateiende)');
  return b;
}

export async function openZip(path: string, limits: ZipReadLimits = {}): Promise<ZipReader> {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const fh = await open(path, 'r');
  try {
    const fileSize = (await fh.stat()).size;
    if (fileSize < 22) throw new ZipError('Keine gültige ZIP-Datei');
    const tailLen = Math.min(fileSize, 22 + MAX16 + 20);
    const tail = await readAt(fh, fileSize - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new ZipError('Keine gültige ZIP-Datei (Verzeichnisende fehlt)');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) {
      const recOffset = Number(tail.readBigUInt64LE(eocd - 20 + 8));
      if (recOffset + 56 > fileSize) throw new ZipError('Beschädigtes Archiv (ZIP64-Verzeichnisende)');
      const rec = await readAt(fh, recOffset, 56);
      if (rec.readUInt32LE(0) !== 0x06064b50) throw new ZipError('Beschädigtes Archiv (ZIP64-Verzeichnisende)');
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    if (count > lim.maxEntries) throw new ZipError(`Zu viele Einträge im Archiv (${count}, höchstens ${lim.maxEntries})`);
    if (cdOffset + cdSize > fileSize) throw new ZipError('Beschädigtes Archiv (Zentralverzeichnis)');
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = new Map<string, ZipEntryInfo>();
    let total = 0;
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipError('Beschädigtes Archiv (Zentralverzeichnis)');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28), elen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      if (p + 46 + nlen + elen + clen > cd.length) throw new ZipError('Beschädigtes Archiv (Zentralverzeichnis)');
      const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8');
      // ZIP64-Erweiterung: Werte in der Reihenfolge Größe, gepackte Größe, Position – nur die mit 0xFFFFFFFF
      let e = p + 46 + nlen;
      const eEnd = e + elen;
      while (e + 4 <= eEnd) {
        const id = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          const next = () => { if (q + 8 > e + 4 + len) throw new ZipError(`Beschädigter ZIP64-Eintrag: ${name}`); const v = Number(cd.readBigUInt64LE(q)); q += 8; return v; };
          if (size === MAX32) size = next();
          if (compressedSize === MAX32) compressedSize = next();
          if (localOffset === MAX32) localOffset = next();
        }
        e += 4 + len;
      }
      p += 46 + nlen + elen + clen;
      if (flags & 0x0001) throw new ZipError(`Verschlüsselte Einträge werden nicht unterstützt: ${name}`);
      if (method !== 0 && method !== 8) throw new ZipError(`Nicht unterstützte Kompression (${method}) in ${name}`);
      if (!safeEntryName(name)) throw new ZipError(`Unzulässiger Dateiname im Archiv: ${name.slice(0, 200)}`);
      if (entries.has(name)) throw new ZipError(`Doppelter Eintrag im Archiv: ${name}`);
      if (size > lim.maxEntryBytes) throw new ZipError(`Datei im Archiv zu groß: ${name}`);
      if (method === 0 && size !== compressedSize) throw new ZipError(`Beschädigter Eintrag im Archiv: ${name}`);
      if (method === 8 && size >= 1024 * 1024 && size / Math.max(1, compressedSize) > lim.maxRatio) {
        throw new ZipError(`Auffälliges Kompressionsverhältnis (mögliche Zip-Bombe): ${name}`);
      }
      if (localOffset + 30 + compressedSize > cdOffset) throw new ZipError(`Beschädigter Eintrag im Archiv: ${name}`);
      total += size;
      if (total > lim.maxTotalBytes) throw new ZipError('Archiv entpackt zu groß');
      entries.set(name, { name, method, crc, compressedSize, size, localOffset });
    }

    const dataStart = async (info: ZipEntryInfo) => {
      const local = await readAt(fh, info.localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new ZipError(`Beschädigter Eintrag im Archiv: ${info.name}`);
      return info.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    };
    const stream = (name: string): Readable => {
      const info = entries.get(name);
      if (!info) throw new ZipError(`Eintrag fehlt im Archiv: ${name}`);
      async function* gen() {
        const start = await dataStart(info!);
        if (start + info!.compressedSize > cdOffset) throw new ZipError(`Beschädigter Eintrag im Archiv: ${name}`);
        let raw: AsyncIterable<Buffer> = (async function* () {
          let pos = start, left = info!.compressedSize;
          while (left > 0) {
            const n = Math.min(left, 1024 * 1024);
            yield await readAt(fh, pos, n);
            pos += n; left -= n;
          }
        })();
        if (info!.method === 8) raw = Readable.from(raw).pipe(createInflateRaw());
        let crc = 0, size = 0;
        try {
          for await (const chunk of raw) {
            size += (chunk as Buffer).length;
            if (size > info!.size) throw new ZipError(`Eintrag größer als angegeben (mögliche Zip-Bombe): ${name}`);
            crc = crc32(chunk as Buffer, crc);
            yield chunk as Buffer;
          }
        } catch (e) {
          if (e instanceof ZipError) throw e;
          throw new ZipError(`Beschädigter Eintrag im Archiv: ${name}`);
        }
        if (size !== info!.size || (crc >>> 0) !== (info!.crc >>> 0)) throw new ZipError(`Prüfsumme stimmt nicht: ${name}`);
      }
      return Readable.from(gen());
    };
    return {
      entries,
      stream,
      async read(name) {
        const parts: Buffer[] = [];
        for await (const c of stream(name)) parts.push(c as Buffer);
        return Buffer.concat(parts);
      },
      close: () => fh.close(),
    };
  } catch (e) {
    await fh.close();
    throw e;
  }
}
