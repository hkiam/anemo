import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeText, parseCsv, writeCsv } from '../src/platform/csv.ts';
import { readXlsx, writeXlsx } from '../src/platform/xlsx.ts';

describe('Excel und CSV', () => {
  it('XLSX: Schreiben und Lesen ergibt dieselben Werte (Umlaute, Zeilenumbrüche, Zahlen, mehrere Blätter)', async () => {
    const buf = await writeXlsx([
      { name: 'Testfälle', header: ['Schlüssel', 'Titel', 'Anzahl', 'Text'], rows: [['DEMO-T1', 'Akte öffnen „schnell“', 3, 'Zeile 1\nZeile 2'], ['DEMO-T2', '=1+1', 0, '<b>&</b>']] },
      { name: 'Schritte', header: ['Nr'], rows: [[1], [2]] },
    ]);
    assert.equal(buf.subarray(0, 2).toString(), 'PK');
    const sheets = readXlsx(buf);
    assert.deepEqual(sheets.map((s) => s.name), ['Testfälle', 'Schritte']);
    assert.deepEqual(sheets[0]!.rows, [['Schlüssel', 'Titel', 'Anzahl', 'Text'], ['DEMO-T1', 'Akte öffnen „schnell“', '3', 'Zeile 1\nZeile 2'], ['DEMO-T2', '=1+1', '0', '<b>&</b>']]);
    assert.deepEqual(sheets[1]!.rows, [['Nr'], ['1'], ['2']]);
  });
  it('CSV: Semikolon, Anführungszeichen, Zeilenumbrüche, Formel-Schutz, BOM', () => {
    const buf = writeCsv(['A', 'B'], [['x;y', 'Er sagte "Hallo"'], ['=SUM(A1)', 'a\nb'], [-5, null]]);
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = decodeText(buf);
    assert.match(text, /'=SUM/);
    assert.deepEqual(parseCsv(text).slice(0, 4), [['A', 'B'], ['x;y', 'Er sagte "Hallo"'], ['=SUM(A1)', 'a\nb'], ['-5', '']]);
  });
  it('CSV: Komma-Trennung und Windows-1252 werden erkannt', () => {
    const latin = Buffer.from([0x54, 0x69, 0x74, 0x65, 0x6c, 0x2c, 0x4e, 0x72, 0x0d, 0x0a, 0xc4, 0x72, 0x67, 0x65, 0x72, 0x2c, 0x31]);
    assert.deepEqual(parseCsv(decodeText(latin)), [['Titel', 'Nr'], ['Ärger', '1']]);
  });
});
