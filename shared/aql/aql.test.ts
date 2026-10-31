import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse, parseDate, tokenize, validate } from './aql.ts';

describe('Abfragesprache', () => {
  it('zerlegt Felder mit Unterfeld, Datumswerte und Zeichenketten', () => {
    const t = tokenize('feld."Team A" = x UND ausgeführt >= 01.10.2026 UND konfiguration.db IN (Oracle, "SQL Server")');
    assert.deepEqual(t.slice(0, 5).map((x) => [x.kind, x.value]), [['word', 'feld'], ['dot', '.'], ['string', 'Team A'], ['op', '='], ['word', 'x']]);
    assert.ok(t.some((x) => x.value === '01.10.2026'));
  });
  it('verknüpft implizit mit UND, ODER bindet schwächer, NICHT IN und IST NICHT LEER', () => {
    const q = parse('status = Fehlgeschlagen label = smoke ODER priorität IST NICHT LEER UND label NICHT IN (a, b)', 'testcase');
    assert.equal(q.where!.type, 'or');
    const [left, right] = (q.where as { items: { type: string; items?: { op?: string }[] }[] }).items;
    assert.equal(left!.type, 'and');
    assert.deepEqual(right!.items!.map((c) => c.op), ['notempty', 'notin']);
  });
  it('englische Synonyme und Sortierung', () => {
    const q = parse('status = FAIL AND assignee = me() ORDER BY executed DESC', 'execution');
    assert.equal(q.order[0]!.field.name, 'ausgeführt');
    assert.equal(q.order[0]!.desc, true);
  });
  it('freie Wörter sind Volltext', () => {
    assert.deepEqual(parse('Akte drucken', 'testcase').where, { type: 'and', items: [{ type: 'text', value: 'Akte', pos: 0 }, { type: 'text', value: 'drucken', pos: 5 }] });
  });
  it('Fehler mit Position und Vorschlag', () => {
    assert.match(validate('stauts = x', 'testcase')!.message, /meinten Sie „status“/);
    assert.equal(validate('label = smoke UND (status = x', 'testcase')!.message, '„)“ erwartet (Abfrage endet zu früh)');
    assert.match(validate('erstellt > gestern', 'testcase')!.message, /Datum erwartet/);
    assert.match(validate('zugewiesen = ich()', 'testcase')!.message, /Unbekanntes Feld|kein/);
    assert.equal(validate('ausgeführt > -7d UND dauer < 30', 'execution'), null);
  });
  it('relative Datumsangaben', () => {
    const now = new Date(2026, 9, 11, 15, 0);
    assert.deepEqual(parseDate({ raw: '-7d', quoted: false, pos: 0 }, now), new Date(2026, 9, 4));
    assert.deepEqual(parseDate({ raw: '-1m', quoted: false, pos: 0 }, now), new Date(2026, 8, 11));
    assert.deepEqual(parseDate({ raw: '01.10.2026', quoted: false, pos: 0 }, now), new Date(2026, 9, 1));
  });
});
