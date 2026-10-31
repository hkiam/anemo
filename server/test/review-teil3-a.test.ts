import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readXlsx, writeXlsx } from '../src/platform/xlsx.ts';
import { zipStream } from '../src/platform/zip.ts';
import { parseXml } from '../src/platform/xml.ts';
import { HttpError } from '../src/platform/http.ts';
import { type TestEnv, testEnv } from './helpers.ts';

/**
 * Regressionstests zu Sicherheitsreview Teil 2 (Befunde 1, 7, 8, 9) und Fach-Review Teil 3
 * (Befunde 2, 8–12, 21 – Berichte).
 */

async function zip(files: { name: string; data: string }[]): Promise<Buffer> {
  const c: Buffer[] = [];
  for await (const x of zipStream(files)) c.push(x);
  return Buffer.concat(c);
}
const WB = '<workbook><sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets></workbook>';
const RELS = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
const book = (sheet: string, wb = WB) => zip([{ name: 'xl/workbook.xml', data: wb }, { name: 'xl/_rels/workbook.xml.rels', data: RELS }, { name: 'xl/worksheets/sheet1.xml', data: sheet }]);
/** Läuft schnell und endet mit 400 (HttpError) – kein Speicherüberlauf, keine Blockade. */
function fastReject(fn: () => unknown, pattern: RegExp, ms = 1000) {
  const t = Date.now();
  assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === 400 && pattern.test(e.message));
  assert.ok(Date.now() - t < ms, `zu langsam: ${Date.now() - t} ms`);
}
function fast<T>(fn: () => T, ms = 1000): T {
  const t = Date.now();
  const r = fn();
  assert.ok(Date.now() - t < ms, `zu langsam: ${Date.now() - t} ms`);
  return r;
}

describe('Sicherheit 1: Excel- und XML-Parser gegen präparierte Dateien', () => {
  it('Zeilennummer 400 000 000 → 400 statt Speicherüberlauf', async () => {
    fastReject(() => readXlsx(Buffer.from([])), /ZIP/);
    const b = await book('<sheetData><row r="400000000"><c r="A400000000" t="inlineStr"><is><t>x</t></is></c></row></sheetData>');
    assert.ok(b.length < 1000);
    fastReject(() => readXlsx(b), /Zeilennummer/);
  });
  it('fachliche Zeilengrenze mit Inhalt; leere Formatzeilen weit unten stören nicht', async () => {
    fastReject(() => readXlsx(Buffer.alloc(0)), /ZIP/);
    const b = await book('<sheetData><row r="300000"><c r="A300000"><v>1</v></c></row></sheetData>');
    fastReject(() => readXlsx(b), /Zu viele Zeilen/);
    const ok = await book('<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="1048576" ht="20"/></sheetData>');
    const [s] = fast(() => readXlsx(ok));
    assert.deepEqual(s!.rows, [['1']]);
  });
  it('Spaltenreferenz ZZZZ1 bzw. ZZZZZZZ1 → 400 statt riesiger Zeile', async () => {
    fastReject(() => readXlsx(Buffer.alloc(0)), /ZIP/);
    for (const ref of ['ZZZZ1', 'ZZZZZZZ1']) {
      const b = await book(`<sheetData><row r="1"><c r="${ref}"><v>1</v></c></row></sheetData>`);
      fastReject(() => readXlsx(b), /Zellreferenz/);
    }
    const wide = await book('<sheetData><row r="1"><c r="BZZ1"><v>1</v></c></row></sheetData>');
    fastReject(() => readXlsx(wide), /Zu viele Spalten/);
    // leere, nur formatierte Zelle weit rechts: kein Fehler, kein Auffüllen
    const styled = await book('<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="XFD1" s="1"/></row></sheetData>');
    assert.deepEqual(fast(() => readXlsx(styled))[0]!.rows, [['1']]);
  });
  it('100 000 nicht geschlossene <row> laufen linear', async () => {
    const b = await book('<row>'.repeat(100_000));
    assert.deepEqual(fast(() => readXlsx(b))[0]!.rows, []);
    const c = await book('<row><c r="A1"><v>1</v>' + '<c>'.repeat(200_000));
    fast(() => readXlsx(c));
    const s = await zip([{ name: 'xl/workbook.xml', data: WB }, { name: 'xl/_rels/workbook.xml.rels', data: RELS },
      { name: 'xl/sharedStrings.xml', data: '<si><t>'.repeat(100_000) }, { name: 'xl/worksheets/sheet1.xml', data: '' }]);
    fast(() => readXlsx(s));
  });
  it('zu viele Tabellenblätter bzw. dasselbe große Blatt mehrfach', async () => {
    const many = '<workbook><sheets>' + '<sheet name="a" r:id="rId1"/>'.repeat(51) + '</sheets></workbook>';
    fastReject(() => readXlsx(Buffer.alloc(0)), /ZIP/);
    const b = await book('<sheetData/>', many);
    fastReject(() => readXlsx(b), /Tabellenblätter/);
  });
  it('normale Arbeitsmappen werden unverändert gelesen (Rundlauf)', async () => {
    const buf = await writeXlsx([{ name: 'T', header: ['A', 'B', 'C'], rows: [['x', 1, true], [null, '', 'z & <y>'], ['', '', ''], ['letzte']] }]);
    const [s] = readXlsx(buf);
    assert.deepEqual(s!.rows, [['A', 'B', 'C'], ['x', '1', 'ja'], ['', '', 'z & <y>'], [], ['letzte']]);
  });
  it('XML: 50 000 offene und 50 000 fremde Schließ-Tags laufen linear; Tiefe und Elementzahl begrenzt', () => {
    const n = 50_000;
    // tief verschachtelt → 400
    fastReject(() => parseXml('<a>'.repeat(n) + '</b>'.repeat(n)), /verschachtelt/);
    // flach mit vielen fremden Schließ-Tags → schnell
    const flat = '<r>' + '<a/>'.repeat(n) + '</b>'.repeat(n) + '</r>';
    assert.equal(fast(() => parseXml(flat)).children[0]!.children.length, n);
    // Schließ-Tag schließt bis zum passenden Element
    const x = parseXml('<r><a><b>t</a><c/></r>');
    assert.deepEqual(x.children[0]!.children.map((c) => c.name), ['a', 'c']);
    // lange Tags und Attribute ohne Rückverfolgung
    fast(() => parseXml(`<a ${'x'.repeat(2_000_000)}>`));
    assert.deepEqual(parseXml(`<a b="1" c = '2' d e="&#99999999;"/>`).children[0]!.attrs, { b: '1', c: '2', e: '�' });
    fastReject(() => parseXml('<a/>'.repeat(2_000_001)), /umfangreich/, 3000);
  });
});

describe('Berichte: Sitzungsfehler, Statusbericht, Stichtag, Archiv, Burn-down (Fach-Review Teil 3; Sicherheit 8/9)', () => {
  let env: TestEnv;
  const call = <T = any>(m: string, p: string, b?: unknown) => env.call<T>(m, p, b);
  const json = async (p: string) => (await call('GET', p)).body;
  const tcId = async (key: string) => (await json(`/api/test-cases/${key}`)).id as string;
  async function setup(key: string, titles: string[], cycleOpts: Record<string, unknown> = {}) {
    await call('POST', '/api/projects', { key, name: key });
    for (const t of titles) await call('POST', `/api/projects/${key}/test-cases`, { content: { title: t, steps: [{ action: 'a', expected: 'b' }] } });
    const plan = (await call('POST', `/api/projects/${key}/plans`, { name: 'R' })).body;
    const cycle = (await call('POST', `/api/projects/${key}/cycles`, { name: 'Lauf', planId: plan.id, ...cycleOpts })).body;
    await call('POST', `/api/cycles/${cycle.id}/executions`, { testCaseIds: titles.map((_, i) => `${key}-T${i + 1}`) });
    const execs = (await json(`/api/cycles/${cycle.id}/executions`)).items as any[];
    return { plan, cycle, execs };
  }
  before(async () => { env = await testEnv(); });
  after(() => env.close());

  it('Fach 2: Sitzungsfund als Fehler zählt in Abschlussbericht, Kriterium, Statusbericht und Top-Fehler', async () => {
    const { plan, cycle, execs } = await setup('SF', ['A']);
    await call('POST', `/api/executions/${execs[0].id}/result`, { status: 'PASS' });
    await env.db`update test_plan set exit_criteria = ${env.db.json({ maxOpenDefects: 0 })} where id = ${plan.id}`;
    const before_ = await json(`/api/reports/completion/${plan.id}?format=json`);
    assert.equal(before_.criteria.find((c: any) => c.label === 'Offene Fehler').met, true);
    assert.notEqual(before_.assessment.recommendation, 'not-recommended');
    const s = (await call('POST', `/api/cycles/${cycle.id}/sessions`, { charter: 'Druck erkunden' })).body;
    const f = (await call('POST', `/api/sessions/${s.id}/findings`, { kind: 'bug', text: 'Druck bricht ab' })).body;
    assert.ok(f);
    assert.equal((await call('POST', '/api/references', { ownerType: 'EXPLORATORY_SESSION', ownerId: s.id, provider: 'jira', externalKey: 'SES-1', relation: 'DEFECT' })).status, 201);
    const r = await json(`/api/reports/completion/${plan.id}?format=json`);
    const d = r.defects.find((x: any) => x.key === 'SES-1');
    assert.ok(d, 'Sitzungsfehler in der Fehlerliste');
    assert.deepEqual([d.executions, d.sessions], [0, 1]);
    const crit = r.criteria.find((c: any) => c.label === 'Offene Fehler');
    assert.deepEqual([crit.actual, crit.met], ['1', false]);
    assert.equal(r.assessment.recommendation, 'not-recommended');
    assert.ok(r.assessment.reasons.some((x: string) => /verknüpfter? Fehler noch offen/.test(x)));
    const st = await json(`/api/reports/status/${plan.id}?format=json`);
    assert.deepEqual(st.inPeriod.newDefects.map((x: any) => x.key), ['SES-1']);
    const top = await json('/api/projects/SF/top-defects');
    assert.equal(top.find((x: any) => x.externalKey === 'SES-1')?.sessions, 1);
    const cockpit = await json(`/api/plans/${plan.id}/cockpit`);
    assert.ok(cockpit.openDefects.some((x: any) => x.key === 'SES-1'));
  });

  it('Fach 8: Statusbericht zählt Ausführungen, nicht Speichervorgänge; neue Fehlschläge nur bei Wechsel', async () => {
    const { plan, execs } = await setup('ST', ['A', 'B', 'C']);
    for (const comment of ['erst', 'ergänzt', 'nochmals ergänzt']) await call('POST', `/api/executions/${execs[0].id}/result`, { status: 'FAIL', comment });
    // B: schon vor dem Zeitraum fehlgeschlagen, im Zeitraum erneut gespeichert → kein neuer Fehlschlag
    await call('POST', `/api/executions/${execs[1].id}/result`, { status: 'FAIL', comment: 'alt' });
    await env.db`update execution_result set recorded_at = now() - interval '20 days' where execution_id = ${execs[1].id}`;
    await call('POST', `/api/executions/${execs[1].id}/result`, { status: 'FAIL', comment: 'noch kaputt' });
    // C: im Zeitraum fehlgeschlagen, danach bestanden → kein Fehlschlag mehr
    await call('POST', `/api/executions/${execs[2].id}/result`, { status: 'FAIL' });
    await call('POST', `/api/executions/${execs[2].id}/result`, { status: 'PASS' });
    const r = await json(`/api/reports/status/${plan.id}?format=json`);
    assert.equal(r.inPeriod.executed, 3);
    assert.equal(r.inPeriod.failed, 2);
    assert.equal(r.inPeriod.passed, 1);
    assert.deepEqual(r.inPeriod.byTester, [{ tester: 'tester', executed: 3 }]);
    assert.deepEqual(r.inPeriod.newFailures.map((x: any) => x.key), ['ST-T1']);
  });

  it('Fach 9/10/21: Stichtag mit veralteten Versionen; archivierte Testfälle und Zyklen; Verlauf begrenzt', async () => {
    const { plan, cycle, execs } = await setup('AS', ['A', 'B']);
    const [a, b] = [await tcId('AS-T1'), await tcId('AS-T2')];
    assert.equal((await call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: a, provider: 'jira', externalKey: 'REQ-1', relation: 'REQUIREMENT' })).status, 201);
    await call('POST', `/api/executions/${execs[0].id}/result`, { status: 'PASS' });
    await call('POST', `/api/executions/${execs[1].id}/result`, { status: 'PASS' });
    // Testfall A: v1 vor 20 Tagen bestanden, v2 vor 10 Tagen angelegt
    await env.db`update test_execution set created_at = now() - interval '30 days' where cycle_id = ${cycle.id}`;
    await env.db`update test_case_version set created_at = now() - interval '40 days' where test_case_id = any(${[a, b]}::uuid[])`;
    await env.db`update execution_result set recorded_at = now() - interval '20 days' where execution_id = ${execs[0].id}`;
    const tc = await json('/api/test-cases/AS-T1');
    await call('PUT', '/api/test-cases/AS-T1/content', { content: { ...tc.version, title: 'A (neu)' } });
    await env.db`update test_case_version set created_at = now() - interval '10 days' where test_case_id = ${a} and version_no = 2`;
    const hist = await json(`/api/plans/${plan.id}/coverage-history?weeks=3`);
    assert.deepEqual(hist.map((h: any) => [h.OK, h.NOT_RUN]), [[1, 0], [0, 1], [0, 1]], 'vor 7 Tagen war v1 schon veraltet');
    assert.equal((await call('GET', `/api/plans/${plan.id}/coverage-history?weeks=27`)).status, 400);
    // archivierter Testfall außerhalb des Plans sperrt die Abdeckung nicht (A jetzt auf v2 bestanden)
    await env.db`update test_execution set test_case_version_id = (select id from test_case_version where test_case_id = ${a} and version_no = 2) where id = ${execs[0].id}`;
    await call('POST', '/api/projects/AS/test-cases', { content: { title: 'Alt', steps: [{ action: 'a', expected: 'b' }] } });
    await call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: await tcId('AS-T3'), provider: 'jira', externalKey: 'REQ-1', relation: 'REQUIREMENT' });
    const testsOf = async () => (await json(`/api/reports/traceability/${plan.id}?format=json`)).requirements[0].tests.map((t: any) => [t.key, t.inPlan, t.outdated]);
    assert.deepEqual(await testsOf(), [['AS-T1', true, false], ['AS-T3', false, false]], 'T3 nicht eingeplant → NOT_RUN');
    assert.equal((await call('POST', '/api/test-cases/archive', { ids: ['AS-T3'], archived: true })).status, 200);
    assert.deepEqual(await testsOf(), [['AS-T1', true, false]]);
    assert.deepEqual((await json(`/api/reports/traceability/${plan.id}?format=json`)).totals, { OK: 1, NOK: 0, NOT_RUN: 0, UNCOVERED: 0 });
    // archivierter Zyklus mit offenen Ausführungen: weder im Abschlussbericht noch im Burn-down
    const extra = (await call('POST', '/api/projects/AS/cycles', { name: 'Alt-Lauf', planId: plan.id })).body;
    await call('POST', `/api/cycles/${extra.id}/executions`, { testCaseIds: ['AS-T1', 'AS-T2'] });
    assert.equal((await json(`/api/reports/completion/${plan.id}?format=json`)).openItems.length, 0, 'gleicher Testfall: letztes Ergebnis zählt');
    assert.equal((await json(`/api/plans/${plan.id}/burndown`)).remaining, 2);
    assert.equal((await call('POST', `/api/cycles/${extra.id}/archive`, { archived: true })).status, 200);
    const c = await json(`/api/reports/completion/${plan.id}?format=json`);
    assert.deepEqual([c.cycles.length, c.archivedCycles, c.current.total], [1, 1, 2]);
    assert.equal((await json(`/api/plans/${plan.id}/burndown`)).remaining, 0);
    const md = await (await env.app.request(`/api/reports/completion/${plan.id}?format=md`, { headers: { 'x-anemo-user': 'tester' } })).text();
    assert.match(md, /1 archivierte Zyklen/);
  });

  it('Fach 11/12, Sicherheit 8: Tempo über Arbeitstage, Zurücksetzen, historischer Stichtag, unplausible Daten', async () => {
    const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    const { plan, cycle, execs } = await setup('BD', ['A', 'B', 'C', 'D'], { startDate: day(-30), endDate: day(30) });
    await env.db`update test_execution set created_at = now() - interval '30 days' where cycle_id = ${cycle.id}`;
    for (const e of execs.slice(0, 3)) await call('POST', `/api/executions/${e.id}/result`, { status: 'PASS' });
    // Ausführung C wieder auf offen gesetzt → nicht erledigt
    await call('POST', `/api/executions/${execs[2].id}/result`, { status: 'NOT_EXECUTED' });
    const b = await json(`/api/plans/${plan.id}/burndown`);
    assert.equal(b.remaining, 2);
    assert.equal(b.points.find((p: any) => p.remaining !== null && p.day === b.asOf).remaining, 2);
    // 2 erledigt in den letzten 10 Arbeitstagen → 0,2 je Arbeitstag (nicht 2 „je Tag mit Aktivität“)
    assert.equal(b.velocity, 0.2);
    // historischer Bericht: Stand zum Ende des Zeitraums, später angelegte Ausführungen fehlen
    await env.db`update execution_result set recorded_at = now() - interval '5 days' where execution_id = ${execs[0].id}`;
    const late = (await call('POST', '/api/projects/BD/test-cases', { content: { title: 'E', steps: [{ action: 'a', expected: 'b' }] } })).body;
    await call('POST', `/api/cycles/${cycle.id}/executions`, { testCaseIds: [late.key] });
    const to = day(-3);
    const st = await json(`/api/reports/status/${plan.id}?format=json&from=${day(-10)}&to=${to}`);
    assert.equal(st.burndown.asOf, to);
    assert.equal(st.burndown.remaining, 3, 'zum 3. Tag zurück: A erledigt, B–D offen, E noch nicht angelegt');
    // Zeitraumgrenzen in Europe/Berlin: nach Mitternacht am Folgetag gehört nicht mehr dazu
    // (23:30 UTC ist 00:30 Uhr Winterzeit bzw. 01:30 Uhr Sommerzeit – in beiden Fällen schon der Folgetag)
    await env.db`update execution_result set recorded_at = ${new Date(`${to}T23:30:00Z`)} where execution_id = ${execs[0].id}`;
    const st2 = await json(`/api/reports/status/${plan.id}?format=json&from=${day(-10)}&to=${to}`);
    assert.equal(st2.inPeriod.executed, 0);
    // unplausible Zyklusdaten: schnell, kein 500
    await env.db`update test_cycle set start_date = '0001-01-01', end_date = '9999-12-31' where id = ${cycle.id}`;
    const t = Date.now();
    const r = await call('GET', `/api/plans/${plan.id}/burndown`);
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t < 1000);
    assert.equal(r.body.end, null);
    assert.equal((await call('GET', `/api/reports/status/${plan.id}?format=json&from=0999-01-01`)).status, 400);
    assert.equal((await call('GET', `/api/reports/traceability/${plan.id}?format=json&asOf=0500-01-01`)).status, 400);
  });

  it('Sicherheit 9: Komplexitätsgrenzen der Abfragesprache, auch für dynamische Testsets; statement_timeout', async () => {
    await call('POST', '/api/projects', { key: 'QL', name: 'QL' });
    const many = Array.from({ length: 31 }, (_, i) => `titel ~ x${i}`).join(' und ');
    const r = await call('GET', `/api/projects/QL/test-cases?aql=${encodeURIComponent(many)}`);
    assert.equal(r.status, 400);
    assert.match(r.body.detail, /Zu viele Bedingungen/);
    const deep = `${'('.repeat(11)}titel ~ x${')'.repeat(11)}`;
    assert.match((await call('GET', `/api/projects/QL/test-cases?aql=${encodeURIComponent(deep)}`)).body.detail, /verschachtelt/);
    assert.equal((await call('GET', `/api/projects/QL/test-cases?aql=${encodeURIComponent('titel ~ x und (status = Entwurf oder priorität = Hoch)')}`)).status, 200);
    const set = await call('POST', '/api/projects/QL/test-sets', { name: 'Zu komplex', kind: 'dynamic', query: `aql=${encodeURIComponent(many)}` });
    assert.equal(set.status, 400);
    assert.match(set.body.detail, /Zu viele Bedingungen/);
    const [row] = await env.db<{ statementTimeout: string }[]>`show statement_timeout`;
    assert.equal(row!.statementTimeout, '30s');
  });
});

describe('Burn-down: Verspätung in Arbeitstagen', () => {
  it('endet der Plan am Wochenende, ist der Montag danach 1 Arbeitstag zu spät (nicht 0)', async () => {
    const { workdaysLate } = await import('../src/modules/reports/time.ts');
    assert.equal(workdaysLate('2026-11-08', '2026-11-09'), 1, 'Sonntag → Montag');
    assert.equal(workdaysLate('2026-11-07', '2026-11-09'), 1, 'Samstag → Montag');
    assert.equal(workdaysLate('2026-11-06', '2026-11-09'), 1, 'Freitag → Montag');
    assert.equal(workdaysLate('2026-11-04', '2026-11-05'), 1, 'Mittwoch → Donnerstag');
    assert.equal(workdaysLate('2026-11-04', '2026-11-11'), 5);
    assert.equal(workdaysLate('2026-11-09', '2026-11-09'), 0);
  });
});
