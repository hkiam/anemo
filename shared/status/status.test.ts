import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveOverall, flakyByConfiguration, flakySwitches } from './status.ts';

const CAT: Record<string, string> = { FAIL_KNOWN: 'KNOWN_FAILURE', NOT_EXECUTED: 'OPEN', WIP: 'IN_PROGRESS', PASS: 'PASSED', OK2: 'PASSED', MANGEL: 'PASSED_WITH_ISSUES', FAIL: 'FAILED', BLOCKED: 'BLOCKED', INVALID: 'INVALID', NA: 'NOT_APPLICABLE' };
const d = (...c: string[]) => deriveOverall(c, (x) => CAT[x]);

describe('Gesamtergebnis ableiten', () => {
  it('schlechtestes zählt, Mangel bleibt sichtbar, ungültig nur wenn alles ungültig', () => {
    assert.equal(d(), 'NOT_EXECUTED');
    assert.equal(d('PASS', 'FAIL', 'BLOCKED'), 'FAIL');
    assert.equal(d('PASS', 'BLOCKED'), 'BLOCKED');
    assert.equal(d('PASS', 'FAIL_KNOWN'), 'FAIL_KNOWN', 'bekannter Fehler bei sonst bestandenen Teilen');
    assert.equal(d('FAIL_KNOWN', 'FAIL'), 'FAIL', 'unerwarteter Fehlschlag geht vor');
    assert.equal(d('FAIL_KNOWN', 'NOT_EXECUTED'), 'WIP', 'offene Teile: noch in Arbeit');
    assert.equal(d('FAIL_KNOWN', 'MANGEL'), 'FAIL_KNOWN');
    assert.equal(d('PASS', 'MANGEL'), 'MANGEL');
    assert.equal(d('PASS', 'INVALID'), 'PASS');
    assert.equal(d('INVALID', 'INVALID'), 'INVALID');
    // nicht anwendbar ist neutral wie ungültig (Review F8)
    assert.equal(d('PASS', 'NA'), 'PASS');
    assert.equal(d('NA', 'NA'), 'NA');
    assert.equal(d('NA', 'FAIL'), 'FAIL');
    assert.equal(d('NA', 'INVALID'), 'INVALID');
    assert.equal(d('PASS', 'NOT_EXECUTED'), 'WIP');
    assert.equal(d('NOT_EXECUTED', 'NOT_EXECUTED'), 'NOT_EXECUTED');
    assert.equal(d('OK2', 'OK2'), 'OK2');
    assert.equal(d('PASS', 'OK2'), 'OK2');
  });
});

describe('Wackelnd (gemeinsame Definition Test-Health/Risiko)', () => {
  it('mind. 3 Wechsel bestanden/fehlgeschlagen in den letzten 8, andere Kategorien zählen nicht', () => {
    assert.equal(flakySwitches(['PASSED', 'FAILED', 'PASSED', 'FAILED']), 3);
    assert.equal(flakySwitches(['PASSED', 'BLOCKED', 'FAILED', 'OPEN']), 1);
    assert.equal(flakySwitches(['PASSED', 'PASSED', 'PASSED', 'PASSED', 'PASSED', 'PASSED', 'PASSED', 'PASSED', 'FAILED', 'PASSED', 'FAILED']), 0, 'nur die letzten 8');
  });
  it('je Konfiguration: reproduzierbarer Fehler unter Oracle, bestanden unter SQL Server = nicht wackelnd', () => {
    const ora = '{"database":["Oracle"]}', sql = '{"database":["SQL Server"]}';
    const h = [ora, sql, ora, sql, ora, sql].map((configuration) => ({ configuration, category: configuration === ora ? 'FAILED' : 'PASSED' }));
    assert.equal(flakySwitches(h.map((x) => x.category)), 5, 'über Konfigurationen hinweg sähe es wackelnd aus');
    assert.equal(flakyByConfiguration(h).flaky, false);
    assert.equal(flakyByConfiguration([...h, ...['PASSED', 'FAILED', 'PASSED', 'FAILED'].map((category) => ({ configuration: sql, category }))]).flaky, true);
  });
});
