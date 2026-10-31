import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classicToGherkin, executableSteps, gherkinToClassic, parseGherkin } from '../src/modules/testcases/index.ts';

const DE = `# language: de
@regression
Funktionalität: Dokument ablegen
  Als Sachbearbeiter:in möchte ich PDFs ablegen.

  Grundlage:
    Angenommen eine geöffnete Akte

  Szenario: PDF in einer Akte ablegen
    Angenommen der Benutzer besitzt Schreibrechte
    Wenn der Benutzer ein PDF hochlädt
    Dann wird ein Dokument erzeugt
    Und das Dokument befindet sich in der Akte

  Szenariogrundriss: Dateitypen
    Wenn der Benutzer eine Datei vom Typ <typ> hochlädt
    Dann ist das Ergebnis <ergebnis>

    Beispiele:
      | typ  | ergebnis  |
      | pdf  | abgelegt  |
      | exe  | abgelehnt |
`;

describe('Gherkin-Parser', () => {
  it('parst deutsches Gherkin mit Grundlage, Szenario und Grundriss', () => {
    const doc = parseGherkin(DE);
    assert.deepEqual(doc.errors, []);
    assert.equal(doc.language, 'de');
    assert.equal(doc.feature?.name, 'Dokument ablegen');
    assert.deepEqual(doc.feature?.tags, ['@regression']);
    assert.equal(doc.background.length, 1);
    assert.equal(doc.scenarios.length, 2);
    assert.equal(doc.scenarios[0]!.steps[0]!.type, 'given', 'Angenommen → given');
    assert.deepEqual(doc.scenarios[1]!.examples[0]!.rows, [['pdf', 'abgelegt'], ['exe', 'abgelehnt']]);
  });

  it('parst englisches Gherkin mit Tabellen und DocStrings', () => {
    const doc = parseGherkin(`Feature: Login
  Scenario: valid login
    Given the users
      | name | role |
      | anna | admin |
    When she logs in with
      """
      {"user": "anna"}
      """
    Then the dashboard is shown
`);
    assert.deepEqual(doc.errors, []);
    assert.equal(doc.language, 'en');
    assert.deepEqual(doc.scenarios[0]!.steps[0]!.table, [['name', 'role'], ['anna', 'admin']]);
    assert.equal(doc.scenarios[0]!.steps[1]!.docString, '{"user": "anna"}');
  });

  it('meldet Fehler mit Zeilennummern', () => {
    const doc = parseGherkin(`Funktionalität: X
  Szenario: A
    Und ohne Vorgänger
    Unsinn hier
  Szenariogrundriss: B
    Wenn <x>
`);
    const lines = doc.errors.map((e) => e.line);
    assert.ok(lines.includes(3), 'Und als erster Schritt');
    assert.ok(lines.includes(4), 'unerwartete Zeile');
    assert.ok(doc.errors.some((e) => /keine Beispiele/.test(e.message)));
  });

  it('warnt bei Szenario ohne Dann', () => {
    const doc = parseGherkin('Feature: X\n  Scenario: A\n    When something\n');
    assert.deepEqual(doc.errors, []);
    assert.match(doc.warnings[0]!.message, /kein überprüfbares Ergebnis/);
  });

  it('liefert stabile ausführbare Schritte; Dann wird zur Erwartung', () => {
    const a = executableSteps(DE);
    const b = executableSteps(DE);
    assert.deepEqual(a.map((s) => s.id), b.map((s) => s.id));
    const then = a.find((s) => s.expected.includes('wird ein Dokument erzeugt'));
    assert.ok(then);
    assert.equal(then.action, '');
  });
});

describe('Umwandlung klassisch ↔ Gherkin', () => {
  const classic = {
    title: 'Akte öffnen',
    preconditions: '- Benutzer ist angemeldet\n- Akte 12345 existiert',
    steps: [{ action: 'Akte öffnen', data: '12345', expected: 'Akte wird angezeigt' }],
  };

  it('klassisch → Gherkin ergibt valides Gherkin', () => {
    const { gherkin, hints } = classicToGherkin(classic);
    assert.deepEqual(parseGherkin(gherkin).errors, []);
    assert.match(gherkin, /Angenommen Benutzer ist angemeldet\n\s+Und Akte 12345 existiert/);
    assert.match(gherkin, /Wenn Akte öffnen \(Testdaten: 12345\)\n\s+Dann Akte wird angezeigt/);
    assert.deepEqual(hints, []);
  });

  it('weist auf fehlende Erwartungen und mehrere Wenn/Dann-Blöcke hin', () => {
    const { hints } = classicToGherkin({ title: 'X', steps: [{ action: 'a' }, { action: 'b', expected: 'c' }] });
    assert.ok(hints.some((h) => /kein erwartetes Ergebnis/.test(h)));
    assert.ok(hints.some((h) => /Wenn\/Dann-Blöcke/.test(h)));
  });

  it('Gherkin → klassisch: Angenommen wird Vorbedingung, Wenn/Dann werden Schritte', () => {
    const r = gherkinToClassic(classicToGherkin(classic).gherkin);
    assert.equal(r.preconditions, 'Benutzer ist angemeldet\nAkte 12345 existiert');
    assert.deepEqual(r.steps, [{ action: 'Akte öffnen (Testdaten: 12345)', data: '', expected: 'Akte wird angezeigt' }]);
  });
});
