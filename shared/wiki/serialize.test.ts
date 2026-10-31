import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from './parse.ts';
import { roundTrips, sameTree, serialize } from './serialize.ts';

const SAMPLES = [
  'Einfacher Text',
  '*fett* und _kursiv_ und +unterstrichen+ und -durch- und {{mono}}',
  'Zeile 1\nZeile 2\n\nNeuer Absatz',
  'h2. Überschrift\n\nText mit [Link|https://example.org] und [https://example.org]',
  '* eins\n* zwei\n** zwei.eins\n*# nummeriert\n# A\n# B',
  '||Kopf 1||Kopf 2||\n|Zelle *fett*|[^datei.pdf]|',
  '{panel:title=Hinweis}\nInhalt mit !bild.png|thumbnail!\n{panel}',
  '{code:java}\nint a = 1; // *kein* Markup\n{code}',
  '{quote}\nZitat\n{quote}',
  '{color:red}rot{color} normal (/) (x) (!) [~max]',
  'Preis: 5 * 3 - 2 = 13, a_b_c und [Klammer]',
  'Text mit \\* Stern',
  '----',
  'H^2^O und CO~2~ und ??Zitat??',
  '!https://jira.example/secure/attachment/123/screenshot.png!',
];

describe('Wiki-Serializer', () => {
  for (const s of SAMPLES) {
    it(`Round-Trip: ${JSON.stringify(s).slice(0, 50)}`, () => {
      const tree = parse(s);
      const again = parse(serialize(tree));
      assert.ok(sameTree(tree, again), `\n${serialize(tree)}\n${JSON.stringify(tree)}\n${JSON.stringify(again)}`);
      assert.ok(roundTrips(s));
    });
  }

  it('maskiert Sonderzeichen nur, wenn sie sonst als Markup gelesen würden', () => {
    assert.equal(serialize([{ t: 'p', c: ['Datei-Name und 3-4 Tage'] }]), 'Datei-Name und 3-4 Tage');
    assert.equal(serialize([{ t: 'p', c: ['*kein fett*'] }]), '\\*kein fett\\*');
  });

  it('setzt Leerraum vor/hinter Formatierungsmarken', () => {
    assert.equal(serialize([{ t: 'p', c: ['a', { t: 'b', c: [' fett '] }, 'b'] }]), 'a *fett* b');
  });

  it('schreibt Umbrüche vor Blockanfängen als \\\\', () => {
    const tree = parse('Absatz\\\\* kein Listenpunkt');
    assert.ok(sameTree(tree, parse(serialize(tree))));
  });
});

import { documentedChanges } from './changelog.ts';
describe('Änderungstabellen', () => {
  it('erkennt Bearbeiter/Datum/Grund, ignoriert Datentabellen', () => {
    const t = 'Text\n||Bearbeiter||Datum||Grund||\n|mh|03.02.2019|Schritt 3 an 7.4 angepasst|\n|ab|2020-05-01|*neu* Vorbedingung|\n\n||Checkbox||Bezeichnung||Alter Wert||\n|x|a|b|';
    assert.deepEqual(documentedChanges(t), [
      { date: '2020-05-01', sortKey: '2020-05-01', author: 'ab', note: 'neu Vorbedingung' },
      { date: '2019-02-03', sortKey: '2019-02-03', author: 'mh', note: 'Schritt 3 an 7.4 angepasst' },
    ]);
    assert.deepEqual(documentedChanges('||Datum||Wert||\n|1.1.20|x|'), []);
  });
});

import { parse as parseWiki } from './parse.ts';
describe('Bestandsmarkup aus Jira (Renderfehler)', () => {
  it('Makronamen unabhängig von Groß-/Kleinschreibung', () => {
    const b = parseWiki('{Panel:title=Datenbank|borderStyle=solid|borderColor=#ccc|titleBGColor=#F5F5F5}\n\nProzedur einspielen\n{Code}\nAktionen\n{Code}\n{Panel}');
    assert.equal(b.length, 1);
    assert.equal(b[0]!.t, 'panel');
    const p = b[0] as Extract<typeof b[number], { t: 'panel' }>;
    assert.equal(p.title, 'Datenbank');
    assert.deepEqual(p.c, [{ t: 'p', c: ['Prozedur einspielen'] }, { t: 'code', text: 'Aktionen', lang: null }]);
    assert.deepEqual(parseWiki('{QUote}\nzitiert\n{QUOTE}'), [{ t: 'quote', c: [{ t: 'p', c: ['zitiert'] }] }]);
    assert.deepEqual(parseWiki('{Color:red}rot{Color}'), [{ t: 'p', c: [{ t: 'color', color: 'red', c: ['rot'] }] }]);
    assert.deepEqual(parseWiki('{COde:xml}\n<a>{Panel}</a>\n{code}'), [{ t: 'code', text: '<a>{Panel}</a>', lang: 'xml' }], 'Originalschreibweise im Code');
  });
  it('Monospace wird nicht von Kursiv/Fett zerschnitten', () => {
    assert.deepEqual(parseWiki('_Hinweis: Feld {{feld_name__x}}, siehe oben_'), [{ t: 'p', c: [{ t: 'i', c: ['Hinweis: Feld ', { t: 'mono', text: 'feld_name__x' }, ', siehe oben'] }] }]);
    assert.deepEqual(parseWiki('Wert {{a_b}} und _kursiv_'), [{ t: 'p', c: ['Wert ', { t: 'mono', text: 'a_b' }, ' und ', { t: 'i', c: ['kursiv'] }] }]);
    assert.deepEqual(parseWiki('*{{fett}}*'), [{ t: 'p', c: [{ t: 'b', c: [{ t: 'mono', text: 'fett' }] }] }]);
    assert.deepEqual(parseWiki('{{{Platzhalter}}}'), [{ t: 'p', c: [{ t: 'mono', text: '{Platzhalter}' }] }]);
  });
  it('bq. beendet eine Liste', () => {
    const b = parseWiki('* Punkt\nbq. Zitat');
    assert.deepEqual(b.map((x) => x.t), ['list', 'quote']);
  });
});

describe('Eckige Klammern ohne Linkziel', () => {
  it('bleiben Text mit formatiertem Inhalt; echte Links bleiben Links', () => {
    assert.deepEqual(parseWiki('[{color:#ff0000}Hinweis{color}] Text'), [{ t: 'p', c: ['[', { t: 'color', color: '#ff0000', c: ['Hinweis'] }, '] Text'] }]);
    assert.deepEqual(parseWiki("['Wert {{a.b}}']"), [{ t: 'p', c: ["['Wert ", { t: 'mono', text: 'a.b' }, "']"] }]);
    assert.equal((parseWiki('[Doku|https://x.test]')[0] as any).c[0].t, 'link');
    assert.equal((parseWiki('[https://x.test]')[0] as any).c[0].t, 'link');
    assert.equal((parseWiki('[DEMO-1234]')[0] as any).c[0].t, 'link');
    assert.equal((parseWiki('[^bild.png]')[0] as any).c[0].t, 'attachment');
  });
});

describe('Hinweisboxen', () => {
  it('{info}/{warning} als Kasten mit Titel', () => {
    assert.deepEqual(parseWiki('{Info}\nWichtig\n{info}'), [{ t: 'panel', title: 'Info', c: [{ t: 'p', c: ['Wichtig'] }] }]);
    assert.deepEqual(parseWiki('{warning:title=Achtung}\nx\n{warning}'), [{ t: 'panel', title: 'Achtung', c: [{ t: 'p', c: ['x'] }] }]);
  });
});
