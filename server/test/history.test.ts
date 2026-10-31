import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateStepCreation, NOT_PRESERVED, reconstructHistory, versionAt, type HistoryInput } from '../src/modules/migration/history.ts';

const H = 3600_000;
const base = (over: Partial<HistoryInput> = {}): HistoryInput => ({
  createdAt: 0,
  current: {
    fields: { summary: 'Akte öffnen (neu)', description: 'Beschreibung', priority: 'Hoch', labels: ['Akte'] },
    steps: [
      { id: '10', order: 1, step: 'Anmelden', data: 'admin', result: 'Dashboard' },
      { id: '11', order: 2, step: 'Akte öffnen', data: '12345', result: 'Akte mit Dokumenten' },
      { id: '30', order: 3, step: 'Abmelden', data: '', result: 'Login-Maske' },
    ],
  },
  zephyr: [], jira: [], stepCreated: {}, ...over,
});

describe('Versionsrekonstruktion', () => {
  it('nimmt Feldänderungen rückwärts zurück und bildet Sitzungen', () => {
    const { versions, diagnostics } = reconstructHistory(base({
      zephyr: [
        { t: 10 * H, author: 'anna', event: 'TESTSTEP_UPDATED', stepId: '11', items: [{ field: 'RESULT', old: 'Akte wird angezeigt', new: 'Akte mit Dokumenten' }] },
        { t: 10 * H + 60_000, author: 'anna', event: 'TESTSTEP_UPDATED', stepId: '10', items: [{ field: 'DATA', old: null, new: 'admin' }] },
      ],
      jira: [{ t: 20 * H, author: 'bert', field: 'summary', from: 'Akte öffnen', to: 'Akte öffnen (neu)' }],
    }));
    assert.equal(diagnostics.sessions, 2);
    assert.equal(diagnostics.inconsistent, 0);
    assert.equal(versions.length, 3);
    assert.equal(versions[0]!.fields.summary, 'Akte öffnen');
    assert.equal(versions[0]!.steps[1]!.result, 'Akte wird angezeigt');
    assert.equal(versions[0]!.steps[0]!.data, '');
    assert.equal(versions[1]!.author, 'anna');
    assert.equal(versions[1]!.steps[1]!.result, 'Akte mit Dokumenten');
    assert.equal(versions[1]!.fields.summary, 'Akte öffnen');
    assert.match(versions[2]!.changeNote, /Titel geändert/);
    assert.deepEqual(versions[2]!.fields, base().current.fields);
  });

  it('stellt gelöschte Schritte wieder her – mit letztem bekannten Inhalt oder als "nicht überliefert"', () => {
    const { versions, diagnostics } = reconstructHistory(base({
      zephyr: [
        { t: 1 * H, author: 'anna', event: 'TESTSTEP_UPDATED', stepId: '20', items: [{ field: 'STEP', old: 'alt', new: 'Drucken' }] },
        { t: 5 * H, author: 'anna', event: 'TESTSTEP_DELETED', stepId: '20', items: [{ field: null, old: '3', new: null }] },
        { t: 6 * H, author: 'anna', event: 'TESTSTEP_DELETED', stepId: '21', items: [{ field: null, old: '4', new: null }] },
      ],
    }));
    assert.equal(diagnostics.unknownStepContent, 1);
    const before = versions[0]!;
    assert.deepEqual(before.steps.map((s) => s.id), ['10', '11', '20', '30', '21']);
    assert.equal(before.steps.find((s) => s.id === '20')!.step, 'alt');
    assert.equal(before.steps.find((s) => s.id === '21')!.step, NOT_PRESERVED);
    assert.equal(versions.at(-1)!.steps.length, 3);
  });

  it('Schritte aus der ersten Erfassung (≤ 24 h nach Anlage) gehören zur Ursprungsfassung', () => {
    const { versions, diagnostics } = reconstructHistory(base({ stepCreated: { '10': 2 * H, '11': 3 * H, '30': 20 * H } }));
    assert.equal(diagnostics.estimatedStepCreations, 0);
    assert.equal(versions.length, 0);
  });

  it('entfernt später hinzugefügte Schritte aus älteren Versionen (Zeitpunkt geschätzt)', () => {
    const { versions, diagnostics } = reconstructHistory(base({ stepCreated: { '10': 0, '11': 0, '30': 48 * H } }));
    assert.equal(diagnostics.estimatedStepCreations, 1);
    assert.deepEqual(versions[0]!.steps.map((s) => s.id), ['10', '11']);
    assert.deepEqual(versions[1]!.steps.map((s) => s.id), ['10', '11', '30']);
    assert.match(versions[1]!.changeNote, /hinzugefügt \(Zeitpunkt geschätzt\)/);
  });

  it('Schritt ohne Löscheintrag, aber mit Änderungen: bis zur letzten Änderung vorhanden', () => {
    const { versions, diagnostics } = reconstructHistory(base({
      zephyr: [{ t: 2 * H, author: 'anna', event: 'TESTSTEP_UPDATED', stepId: '25', items: [{ field: 'STEP', old: 'a', new: 'b' }] }],
    }));
    assert.equal(diagnostics.deletionsWithoutEvent, 1);
    assert.ok(versions[0]!.steps.some((s) => s.id === '25' && s.step === 'a'));
    assert.ok(!versions.at(-1)!.steps.some((s) => s.id === '25'));
  });

  it('meldet Lücken, wenn "neuer Wert" nicht zum Folgezustand passt', () => {
    const { diagnostics } = reconstructHistory(base({
      zephyr: [{ t: H, author: 'x', event: 'TESTSTEP_UPDATED', stepId: '10', items: [{ field: 'STEP', old: 'a', new: 'passt nicht' }] }],
    }));
    assert.equal(diagnostics.inconsistent, 1);
  });

  it('ohne Historie: keine Versionen', () => {
    assert.equal(reconstructHistory(base()).versions.length, 0);
  });
});

describe('Schätzung des Anlegezeitpunkts und Zeitzuordnung', () => {
  it('obere Schranke = frühester Nachweis eines Schritts mit gleicher oder höherer ID', () => {
    const est = estimateStepCreation(new Map([['5', 100], ['9', 50], ['12', 300]]), ['1', '5', '7', '9', '12', '15']);
    assert.deepEqual(Object.fromEntries(est), { '1': 50, '5': 50, '7': 50, '9': 50, '12': 300 });
  });

  it('versionAt wählt die zum Zeitpunkt gültige Version', () => {
    const v = [{ validFrom: 0, n: 1 }, { validFrom: 10, n: 2 }, { validFrom: 20, n: 3 }];
    assert.equal(versionAt(v, 15).n, 2);
    assert.equal(versionAt(v, 20).n, 3);
    assert.equal(versionAt(v, -5).n, 1);
  });
});
