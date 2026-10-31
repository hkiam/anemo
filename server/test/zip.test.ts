import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openZip, safeEntryName, type ZipEntry, type ZipWriteOptions, zipStream } from '../src/platform/zip.ts';

/** Unabhängiger Leser zur Gegenprobe (Python zipfile), falls vorhanden */
function pythonCheck(path: string): string[] | null {
  try {
    const out = execFileSync('python3', ['-I', '-c', 'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint("\\n".join(z.namelist()))', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.trim().split('\n');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  }
}

describe('ZIP: Schreiber und Leser mit ZIP64 (Stufe K1)', () => {
  let dir: string;
  const write = async (name: string, entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>, opts?: ZipWriteOptions) => {
    const parts: Buffer[] = [];
    for await (const c of zipStream(entries, opts)) parts.push(c);
    const path = join(dir, name);
    await writeFile(path, Buffer.concat(parts));
    return path;
  };
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'anemo-zip-')); });
  after(() => rm(dir, { recursive: true, force: true }));

  for (const forceZip64 of [false, true]) {
    it(`Rundlauf mit Daten-, Datei- und Strom-Einträgen${forceZip64 ? ' (ZIP64 erzwungen)' : ''}`, async () => {
      const file = join(dir, 'bild.bin');
      const binary = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 256));
      await writeFile(file, binary);
      const lines = Array.from({ length: 20_000 }, (_, i) => `${JSON.stringify({ n: i, text: 'Testfall öffnen – „Akte“' })}\n`);
      const path = await write(`rund-${forceZip64}.zip`, [
        { name: 'manifest.json', data: '{"format":"x"}' },
        { name: 'files/bild', path: file },
        { name: 'daten.ndjson', stream: async function* () { for (const l of lines) yield l; } },
        { name: 'leer.ndjson', stream: async function* () {} },
      ], { forceZip64 });
      const z = await openZip(path);
      try {
        assert.deepEqual([...z.entries.keys()], ['manifest.json', 'files/bild', 'daten.ndjson', 'leer.ndjson']);
        assert.equal((await z.read('manifest.json')).toString(), '{"format":"x"}');
        assert.deepEqual(await z.read('files/bild'), binary);
        assert.equal((await z.read('daten.ndjson')).toString(), lines.join(''));
        assert.equal((await z.read('leer.ndjson')).length, 0);
        assert.ok(z.entries.get('daten.ndjson')!.compressedSize < z.entries.get('daten.ndjson')!.size / 5, 'NDJSON wird komprimiert');
      } finally { await z.close(); }
      const names = pythonCheck(path);
      if (names) assert.deepEqual(names, ['manifest.json', 'files/bild', 'daten.ndjson', 'leer.ndjson']);
    });
  }

  it('ohne Notwendigkeit kein ZIP64 (kleine Pakete und Lieferpakete bleiben unverändert)', async () => {
    const path = await write('klein.zip', [{ name: 'a.txt', data: 'hallo' }]);
    const buf = await readFile(path);
    assert.equal(buf.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])), -1, 'kein ZIP64-Verzeichnisende');
    assert.equal(buf.readUInt16LE(4), 20, 'Version 2.0 genügt');
  });

  it('mehr als 65 535 Einträge: ZIP64-Verzeichnisende, lesbar von beiden Lesern', async () => {
    const n = 70_000;
    const path = await write('viele.zip', (function* () { for (let i = 0; i < n; i++) yield { name: `e/${i}`, data: String(i) }; })());
    const buf = await readFile(path);
    assert.ok(buf.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])) > 0, 'ZIP64-Verzeichnisende vorhanden');
    const z = await openZip(path);
    try {
      assert.equal(z.entries.size, n);
      assert.equal((await z.read('e/69999')).toString(), '69999');
    } finally { await z.close(); }
    const names = pythonCheck(path);
    if (names) assert.equal(names.length, n);
  });

  it('Namen: Zip-Slip und absolute Pfade werden abgelehnt', async () => {
    for (const ok of ['manifest.json', 'files/abc', 'a/b/c.ndjson']) assert.ok(safeEntryName(ok), ok);
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', './a', 'a\u0000b', '']) assert.ok(!safeEntryName(bad), bad);
    const path = await write('slip.zip', [{ name: '../boese.txt', data: 'x' }]);
    await assert.rejects(openZip(path), /Unzulässiger Dateiname/);
  });

  it('Grenzen: Anzahl, Gesamtgröße, Kompressionsverhältnis', async () => {
    const path = await write('bombe.zip', [{ name: 'nullen', data: Buffer.alloc(20 * 1024 * 1024) }, { name: 'b', data: 'x' }]);
    await assert.rejects(openZip(path, { maxEntries: 1 }), /Zu viele Einträge/);
    await assert.rejects(openZip(path, { maxTotalBytes: 1024 * 1024, maxRatio: 1e9 }), /entpackt zu groß/);
    await assert.rejects(openZip(path, { maxRatio: 100 }), /Kompressionsverhältnis/);
  });

  it('veränderter Inhalt fällt über die CRC auf; kein ZIP wird abgelehnt', async () => {
    const path = await write('crc.zip', [{ name: 'a.bin', data: Buffer.from('0123456789abcdef'.repeat(4)) }]);
    const buf = await readFile(path);
    const at = 30 + 'a.bin'.length + 3;
    buf[at] = buf[at]! ^ 0xff; // gespeichertes Byte im Inhalt kippen
    await writeFile(path, buf);
    const z = await openZip(path);
    try { await assert.rejects(z.read('a.bin'), /Prüfsumme stimmt nicht/); } finally { await z.close(); }
    const junk = join(dir, 'junk.zip');
    await writeFile(junk, Buffer.from('kein Archiv, nur Text'.repeat(3)));
    await assert.rejects(openZip(junk), /Keine gültige ZIP-Datei/);
  });
});
