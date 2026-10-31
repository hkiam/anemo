import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inline, parse } from '../../shared/wiki/parse.ts';

describe('Jira-Wiki-Parser', () => {
  it('Panel mit Titel und Optionen, darin Code-Makro', () => {
    const b = parse('{panel:title=Desktop|borderStyle=solid|borderColor=#ccc|titleBGColor=#ccffcc}\n{code} Vorgehen {code}\n{panel}');
    assert.equal(b.length, 1);
    assert.deepEqual(b[0], { t: 'panel', title: 'Desktop', c: [{ t: 'code', text: ' Vorgehen ', lang: null }] });
  });

  it('Beispiel aus dem Bestand: Panel mit Unterstreichung, Liste, verschachtelter Strichliste, Kursiv und Bild', () => {
    const text = '{panel}\n+auf Akte:+ \n\n* es öffnet sich der Dialog _Einfügen_ mit den folgenden Auswahlmöglichkeiten:\n\n-- Bezug\n \n\n* im unteren Bereich wird der Inhalt angezeigt\n* es werden keine Davor/ Danach einsortieren angezeigt.\n\n  !dialog.png|thumbnail! \n\n{panel}\n{panel}';
    const b = parse(text);
    const panel = b[0] as Extract<(typeof b)[number], { t: 'panel' }>;
    assert.equal(panel.t, 'panel');
    assert.deepEqual(panel.c[0], { t: 'p', c: [{ t: 'u', c: ['auf Akte:'] }] });
    const list = panel.c[1] as any;
    assert.equal(list.t, 'list');
    assert.deepEqual(list.items[0].c, ['es öffnet sich der Dialog ', { t: 'i', c: ['Einfügen'] }, ' mit den folgenden Auswahlmöglichkeiten:']);
    const img = panel.c.flatMap((x: any) => (x.t === 'p' ? x.c : [])).find((x: any) => x.t === 'img');
    assert.deepEqual(img, { t: 'img', src: 'dialog.png', options: { thumbnail: 'true' } });
    // überzähliges {panel}{panel} am Ende ergibt ein leeres Panel, keinen Absturz
    assert.equal(b.length, 2);
  });

  it('verschachtelte Listen * ** # und Strichlisten - --', () => {
    const b = parse('* eins\n** eins-a\n* zwei\n# erstens\n- strich\n-- unterstrich') as any[];
    assert.equal(b[0].t, 'list');
    assert.equal(b[0].items[0].children[0].items[0].c[0], 'eins-a');
    assert.equal(b[1].ordered, true);
    assert.equal(b[2].items[0].children[0].items[0].c[0], 'unterstrich');
  });

  it('Tabellen mit Kopfzellen, Links und Bildern mit | in den Zellen', () => {
    const b = parse('||ID||Testname||aktiv||\n|REG_1|[Log|http://hudson/x] !a.png|width=200!|ja|') as any[];
    assert.equal(b[0].t, 'table');
    assert.deepEqual(b[0].rows[0].header, [true, true, true]);
    assert.equal(b[0].rows[1].cells.length, 3);
    assert.deepEqual(b[0].rows[1].cells[1][0], { t: 'link', href: 'http://hudson/x', c: ['Log'] });
  });

  it('Inline: fett, farbig, mono, Zeilenumbruch, Emoticons, Erwähnung, Anhang-Link, Bild-URL', () => {
    assert.deepEqual(inline('*fett* und {color:red}rot{color}'), [{ t: 'b', c: ['fett'] }, ' und ', { t: 'color', color: 'red', c: ['rot'] }]);
    assert.deepEqual(inline('{{code}}\\\\neu (/) (x)'), [{ t: 'mono', text: 'code' }, { t: 'br' }, 'neu ', { t: 'emo', name: 'check' }, ' ', { t: 'emo', name: 'cross' }]);
    assert.deepEqual(inline('[~emusterfrau] [^log.txt]'), [{ t: 'mention', user: 'emusterfrau' }, ' ', { t: 'attachment', name: 'log.txt' }]);
    assert.deepEqual(inline('!http://jira.example.invalid:8080/secure/attachment/42465/Anmerkungen.png!')[0],
      { t: 'img', src: 'http://jira.example.invalid:8080/secure/attachment/42465/Anmerkungen.png', options: {} });
  });

  it('keine Fehlinterpretation von Bindestrichen, Dateinamen und Schlüsseln', () => {
    assert.deepEqual(inline('DEMO-4102 und datei_name_x.txt sowie 3 - 4'), ['DEMO-4102 und datei_name_x.txt sowie 3 - 4']);
    assert.deepEqual(inline('Achtung!'), ['Achtung!']);
  });

  it('Überschriften, Zitat, Linie, Noformat', () => {
    const b = parse('h2. Titel\nbq. Zitat\n----\n{noformat}*nicht fett*{noformat}') as any[];
    assert.deepEqual(b.map((x) => x.t), ['h', 'quote', 'hr', 'code']);
    assert.equal(b[3].text, '*nicht fett*');
  });

  it('Farben über mehrere Zeilen/Listenpunkte und verwaiste Farbmarkierungen', () => {
    const b = parse('{color:red}rot beginnt\n* weiter rot\n* -durch-{color} normal\nnoch ein {color} ohne Anfang') as any[];
    const all = JSON.stringify(b);
    assert.ok(!all.includes('{color'), all);
    assert.deepEqual(b[0].c[0], { t: 'color', color: 'red', c: ['rot beginnt'] });
    assert.deepEqual(b[1].items[1].c[0], { t: 'color', color: 'red', c: [{ t: 's', c: ['durch'] }] });
  });

  it('Stern-Emoticons (*y) usw. vor Farbe und Fettschrift', () => {
    assert.deepEqual(inline('(*y) {color:blue}*Then*{color} Ergebnis'),
      [{ t: 'emo', name: 'star-yellow' }, ' ', { t: 'color', color: 'blue', c: [{ t: 'b', c: ['Then'] }] }, ' Ergebnis']);
  });

  it('Leerzeilen innerhalb einer Farbe bleiben Absatzgrenzen', () => {
    const b = parse('{color:red}eins\n\nzwei{color}') as any[];
    assert.equal(b.length, 2);
  });
});
