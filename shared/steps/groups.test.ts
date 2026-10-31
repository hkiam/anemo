import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { convertStep, detectGroup, stepNumbers, stepRanges } from './groups.ts';

const ARROW = '{color:#b3c3d3}-------------------------------------->{color}';
const BACK = '{color:#b3c3d3}<--------------------------------------{color}';

describe('Trennschritte aus Zephyr erkennen', () => {
  it('häufigste Form: Pfeile, Name als Überschrift in den Testdaten', () => {
    const g = detectGroup({ action: ARROW, expected: BACK, data: 'h6. Einstellungen\n\n{color:#1f2764}  {color}' });
    assert.equal(g?.title, 'Einstellungen');
    assert.equal(g?.note, null);
    assert.equal(g?.marker, null);
    assert.deepEqual(g?.legacy, { action: ARROW, expected: BACK, data: 'h6. Einstellungen\n\n{color:#1f2764}  {color}' });
  });
  it('Überschrift in der Aktion mit Linie; Testdaten werden Beschreibung', () => {
    const g = detectGroup({ action: 'h2. Import Version 2\n----', expected: '', data: 'Import mit *Wert A*' });
    assert.equal(g?.title, 'Import Version 2');
    assert.equal(g?.note, 'Import mit *Wert A*');
  });
  it('Überschrift in Aktion und Testdaten: Aktion = Titel, Testdaten = Untertitel', () => {
    const g = detectGroup({ action: 'h6. Teil A\n----', expected: '', data: 'h6. Variante 1\nweitere Angaben' });
    assert.deepEqual([g?.title, g?.subtitle, g?.note], ['Teil A', 'Variante 1', 'weitere Angaben']);
  });
  it('Markierung vor dem Pfeil wird Kennzeichen, Titel aus den Testdaten', () => {
    const g = detectGroup({ action: `*INAKTIV*\n\n${ARROW}`, expected: BACK, data: 'Hinweis zur Änderung\n\nh6. Ablage /' });
    assert.deepEqual([g?.title, g?.marker, g?.note], ['Ablage', 'INAKTIV', 'Hinweis zur Änderung']);
    assert.equal(detectGroup({ action: `Klonen - ${ARROW}`, expected: BACK, data: 'h6. Anbieter' })?.marker, 'Klonen');
    assert.equal(detectGroup({ action: `{Color:blue}${ARROW}{Color}`, expected: BACK, data: 'h6. Anbieter' })?.marker, null, 'Farbangaben in jeder Schreibweise');
  });
  it('Begriff in der Pfeilzeile ohne Überschrift wird Titel', () => {
    assert.equal(detectGroup({ action: '------- Aufräumen ------->', expected: '<--------------' })?.title, 'Aufräumen');
  });
  it('nur Linien, Text in Testdaten: erste Zeile wird Titel, Rest Beschreibung', () => {
    const g = detectGroup({ action: '--------------------', expected: '--------------------', data: 'Vorbereitung\nDaten anlegen' });
    assert.deepEqual([g?.title, g?.note], ['Vorbereitung', 'Daten anlegen']);
  });
  it('Wiki-Linien (----) in Aktion und Erwartet', () => {
    assert.equal(detectGroup({ action: '----', expected: '----', data: 'h6. Prüfung' })?.title, 'Prüfung');
    assert.deepEqual(detectGroup({ action: 'h3. Teil B\n----', expected: '----', data: 'h3. Fall 2' })?.subtitle, 'Fall 2');
    assert.equal(detectGroup({ action: '----', expected: '', data: '' })?.title, '');
  });
  it('Name als Panel-Titel in den Testdaten', () => {
    const g = detectGroup({ action: '----', expected: '----', data: '{panel:title=Aufräumen|borderStyle=solid|bgColor=#eee}{panel}' });
    assert.deepEqual([g?.title, g?.note], ['Aufräumen', null]);
  });
  it('ohne Namen: leerer Titel (Nacharbeit)', () => {
    assert.equal(detectGroup({ action: ARROW, expected: BACK, data: '' })?.title, '');
  });
  it('keine Trennschritte: echte Prüfschritte bleiben unverändert', () => {
    assert.equal(detectGroup({ action: 'Maske öffnen', expected: 'Maske erscheint' }), null);
    assert.equal(detectGroup({ action: ARROW, expected: 'Dialog wird angezeigt und Daten sind gespeichert' }), null);
    assert.equal(detectGroup({ action: 'Kennwort --------', expected: '', data: '' }), null, 'Linie ohne Pfeil, ohne Namen und Gegenpfeil ist kein Abschnitt');
    assert.equal(detectGroup({ action: 'Tabelle:\n||a||b||\n|1|2|\n|3|4|\n|5|6|\n------------', expected: '' }), null);
    assert.equal(detectGroup({ action: '', expected: '' }), null);
  });
  it('Umwandlung behält die Schritt-ID und leert die Prüffelder', () => {
    const s = convertStep({ id: 'zapi-1', action: ARROW, expected: BACK, data: 'h6. Test' });
    assert.equal(s.id, 'zapi-1');
    assert.equal((s as { kind?: string }).kind, 'group');
    assert.equal(s.action, '');
    assert.deepEqual(convertStep({ id: 'x', action: 'a', expected: 'b', data: '' }), { id: 'x', action: 'a', expected: 'b', data: '' });
  });
});

describe('Bereiche und Nummern', () => {
  const steps = [{ action: 'a' }, { kind: 'group' }, { action: 'b' }, { action: 'c' }, { kind: 'group' }, { kind: 'group' }, { action: 'd' }];
  it('Schritte vor dem ersten Abschnitt, leere Abschnitte', () => {
    assert.deepEqual(stepRanges(steps), [{ group: null, steps: [0] }, { group: 1, steps: [2, 3] }, { group: 4, steps: [] }, { group: 5, steps: [6] }]);
  });
  it('Nummern nur für Prüfschritte', () => {
    assert.deepEqual(stepNumbers(steps), [1, null, 2, 3, null, null, 4]);
  });
});
