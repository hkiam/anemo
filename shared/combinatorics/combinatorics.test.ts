import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allCombinations, type Exclusion, type Parameter, pairwise, uncoveredPairs } from './combinatorics.ts';

const P: Parameter[] = [
  { name: 'Browser', values: ['Chrome', 'Firefox', 'Edge'] },
  { name: 'DB', values: ['Oracle', 'PostgreSQL', 'SQL Server'] },
  { name: 'Rolle', values: ['Admin', 'Leser'] },
  { name: 'OS', values: ['Windows', 'Linux'] },
];

describe('Kombinatorik', () => {
  it('alle Kombinationen mit Ausschluss', () => {
    const rows = allCombinations(P, [{ Browser: 'Edge', OS: 'Linux' }]);
    assert.equal(rows.length, 3 * 3 * 2 * 2 - 3 * 2);
    assert.ok(!rows.some((r) => r[0] === 'Edge' && r[3] === 'Linux'));
  });
  it('paarweise: deutlich weniger Zeilen, alle Paare abgedeckt', () => {
    const rows = pairwise(P);
    assert.ok(rows.length >= 9 && rows.length <= 11, `${rows.length} Zeilen`);
    assert.deepEqual(uncoveredPairs(P, rows), []);
  });
  it('paarweise mit Ausschlüssen: verbotene Paare nie, alle übrigen abgedeckt', () => {
    const ex = [{ Browser: 'Edge', OS: 'Linux' }, { DB: 'SQL Server', OS: 'Linux' }];
    const rows = pairwise(P, ex);
    assert.ok(!rows.some((r) => (r[0] === 'Edge' && r[3] === 'Linux') || (r[1] === 'SQL Server' && r[3] === 'Linux')));
    assert.deepEqual(uncoveredPairs(P, rows, ex), []);
  });
  it('großer Raum: 10 Parameter × 4 Werte', () => {
    const big = Array.from({ length: 10 }, (_, i) => ({ name: `p${i}`, values: ['a', 'b', 'c', 'd'] }));
    const rows = pairwise(big);
    assert.deepEqual(uncoveredPairs(big, rows), []);
    assert.ok(rows.length < 40, `${rows.length} statt 1 048 576`);
    assert.throws(() => allCombinations(big), /paarweise/);
  });
  it('deterministisch', () => assert.deepEqual(pairwise(P), pairwise(P)));

  it('Eigenschaftstest (fester Seed): mit Ausschlussregeln jedes mögliche Paar abgedeckt, keine verbotene Zeile', () => {
    // Review Teil 3, Befund 13: früher fehlten in ≈ 7 % der Zufallseingaben zulässige Paare
    let seed = 0x5eed1234;
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    let checked = 0, withRules = 0;
    for (let run = 0; run < 2000; run++) {
      const params: Parameter[] = Array.from({ length: int(3, 6) }, (_, i) => ({ name: `P${i}`, values: Array.from({ length: int(2, 4) }, (_, v) => `v${v}`) }));
      const exclusions: Exclusion[] = Array.from({ length: int(1, 3) }, () => {
        const ex: Exclusion = {};
        for (const p of [...params].sort(() => rnd() - 0.5).slice(0, rnd() < 0.8 ? 2 : 3)) ex[p.name] = p.values[int(0, p.values.length - 1)]!;
        return ex;
      });
      const all = allCombinations(params, exclusions);
      const rows = pairwise(params, exclusions);
      const label = JSON.stringify({ params: params.map((p) => p.values.length), exclusions });
      assert.ok(!rows.some((r) => exclusions.some((ex) => Object.entries(ex).every(([p, v]) => r[params.findIndex((x) => x.name === p)] === v))), `verbotene Zeile: ${label}`);
      // Orakel unabhängig vom Generator: jedes Paar, das in einer zulässigen Vollkombination vorkommt, muss abgedeckt sein
      const need = new Set<string>(), have = new Set<string>();
      const pairs = (r: string[], into: Set<string>) => { for (let i = 0; i < r.length; i++) for (let k = i + 1; k < r.length; k++) into.add(`${i}=${r[i]}&${k}=${r[k]}`); };
      all.forEach((r) => pairs(r, need));
      rows.forEach((r) => pairs(r, have));
      const lost = [...need].filter((x) => !have.has(x));
      assert.deepEqual(lost, [], `fehlende Paare: ${label}`);
      // uncoveredPairs meldet nur mögliche Paare – unmögliche (auch aus mehreren Regeln zusammen) nicht als fehlend
      assert.deepEqual(uncoveredPairs(params, rows, exclusions), [], label);
      assert.ok(rows.length <= Math.max(all.length, 1), label);
      checked++;
      if (all.length < params.reduce((n, p) => n * p.values.length, 1)) withRules++;
    }
    assert.equal(checked, 2000);
    assert.ok(withRules > 1500, `${withRules} Eingaben mit wirksamen Regeln`);
  });
  it('uncoveredPairs: durch mehrere Regeln zusammen unmögliches Paar gilt nicht als fehlend', () => {
    const params: Parameter[] = [{ name: 'A', values: ['a1', 'a2'] }, { name: 'B', values: ['b1', 'b2'] }, { name: 'C', values: ['c1', 'c2'] }];
    // A=a1 & B=b1 ist nur mit C=c1 oder C=c2 möglich – beides verboten
    const ex: Exclusion[] = [{ A: 'a1', B: 'b1', C: 'c1' }, { A: 'a1', B: 'b1', C: 'c2' }];
    const rows = pairwise(params, ex);
    assert.ok(!rows.some((r) => r[0] === 'a1' && r[1] === 'b1'));
    assert.deepEqual(uncoveredPairs(params, rows, ex), []);
  });
});
