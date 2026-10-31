import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { parseCucumber, parseJUnit } from '../src/modules/automation/index.ts';
import { type TestEnv, testEnv } from './helpers.ts';

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="akte" tests="4">
  <testcase classname="de.example.akte.AkteIT" name="AU-T1 öffnet Akte" time="1.25"/>
  <testcase classname="de.example.akte.AkteIT" name="test_AU_T2_speichern" time="0.5">
    <failure message="expected &lt;200&gt; but was &lt;500&gt;" type="AssertionError"><![CDATA[at AkteIT.java:42]]></failure>
  </testcase>
  <testcase classname="de.example.akte.AkteIT" name="ohne Bezug"><skipped/></testcase>
  <testcase classname="de.example.akte.Legacy" name="Fall AU-77 alt" />
</testsuite></testsuites>`;

const CUCUMBER = [{ name: 'Akte', uri: 'features/akte.feature', tags: [], elements: [{
  type: 'scenario', name: 'Akte archivieren', tags: [{ name: '@AU-T3' }],
  steps: [
    { keyword: 'Angenommen ', name: 'eine offene Akte', result: { status: 'passed', duration: 1_000_000 } },
    { keyword: 'Wenn ', name: 'ich archiviere', result: { status: 'failed', error_message: 'Button fehlt' } },
    { keyword: 'Dann ', name: 'ist sie archiviert', result: { status: 'skipped' } },
  ],
}] }];

describe('Parser', () => {
  it('JUnit: Status, Meldung (Entities, CDATA), Dauer', () => {
    const r = parseJUnit(JUNIT);
    assert.equal(r.length, 4);
    assert.deepEqual(r.map((x) => x.status), ['passed', 'failed', 'skipped', 'passed']);
    assert.equal(r[1]!.message, 'expected <200> but was <500>\nat AkteIT.java:42');
    assert.equal(r[0]!.durationMs, 1250);
    assert.equal(r[0]!.id, 'de.example.akte.AkteIT.AU-T1 öffnet Akte');
  });
  it('Cucumber: Szenario mit Schritten und Tags', () => {
    const [r] = parseCucumber(CUCUMBER);
    assert.equal(r!.status, 'failed');
    assert.deepEqual(r!.tags, ['AU-T3']);
    assert.deepEqual(r!.steps.map((s) => s.status), ['passed', 'failed', 'skipped']);
  });
});

describe('Ergebnisimport (D1)', () => {
  let env: TestEnv;
  const post = async (body: string, query: string, type = 'application/xml') => {
    const res = await env.app.request(`/api/projects/AU/automation-results?${query}`, { method: 'POST', body, headers: { 'content-type': type, 'x-anemo-user': 'ci-bot' } });
    return { status: res.status, body: await res.json() };
  };
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'AU', name: 'Auto' });
    await env.call('POST', '/api/projects/AU/test-cases', { content: { title: 'Akte öffnen', steps: [{ action: 'a', expected: 'b' }] } });
    await env.call('POST', '/api/projects/AU/test-cases', { content: { title: 'Akte speichern', steps: [{ action: 'a', expected: 'b' }] } });
    await env.call('POST', '/api/projects/AU/test-cases', { content: { title: 'Archivieren', format: 'GHERKIN',
      gherkin: '# language: de\nFunktionalität: Akte\n  Szenario: Akte archivieren\n    Angenommen eine offene Akte\n    Wenn ich archiviere\n    Dann ist sie archiviert\n' } });
    await env.db`update test_case set legacy_key = 'AU-77' where key = 'AU-T2'`;
  });
  after(() => env.close());

  it('übernimmt JUnit in einen Zyklus, ordnet über Schlüssel/Altschlüssel zu und meldet Unzugeordnetes', async () => {
    const r = await post(JUNIT, 'cycle=Nightly%201.4&build=1.4.0');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.total, 4);
    assert.equal(r.body.mapped, 3);
    assert.deepEqual(r.body.unmapped.map((u: any) => u.name), ['ohne Bezug']);
    assert.deepEqual(r.body.results, { PASS: 1, FAIL: 1 });
    const items = (await env.call('GET', `/api/cycles/${r.body.cycleId}/executions`)).body.items;
    const t2 = items.find((e: any) => e.testCaseKey === 'AU-T2');
    assert.equal(t2.status, 'FAIL', 'zwei Ergebnisse → schlechtestes gewinnt');
    const detail = (await env.call('GET', `/api/executions/${t2.id}`)).body;
    assert.match(detail.comment, /expected <200> but was <500>/);
    assert.equal(detail.executedBy, 'ci-bot');
    const cycle = (await env.call('GET', `/api/cycles/${r.body.cycleId}`)).body;
    assert.equal(cycle.build, '1.4.0');
  });

  it('gleicher Zyklusname ohne Angabe → neuer Zyklus mit Zusatz und Hinweis (kein stilles Zusammenführen)', async () => {
    const a = await post(JUNIT, 'cycle=Abnahme&environment=iPad');
    const b = await post(JUNIT, 'cycle=Abnahme&environment=iPhone');
    assert.notEqual(a.body.cycleId, b.body.cycleId);
    assert.deepEqual([a.body.cycleName, a.body.cycleCreated, b.body.cycleName, b.body.cycleCreated], ['Abnahme', true, 'Abnahme (2)', true]);
    assert.match(b.body.warnings[0], /gibt es schon/);
    // Ergänzen nur ausdrücklich – mit Warnung bei abweichender Umgebung
    const c = await post(JUNIT, `cycleId=${a.body.cycleId}&environment=iPhone`);
    assert.equal(c.body.cycleId, a.body.cycleId);
    assert.equal(c.body.cycleCreated, false);
    assert.match(c.body.warnings.join(' '), /Umgebung weicht ab/);
  });

  it('Gerät als Konfiguration: neuer Zyklus erhält es, Anhängen mit anderem Gerät warnt', async () => {
    const a = await post(JUNIT, 'cycle=Matrix&device=iPad&configuration=os%3DiOS');
    const cycle = (await env.call('GET', `/api/cycles/${a.body.cycleId}`)).body;
    assert.deepEqual([cycle.configuration.device, cycle.configuration.os], [['iPad'], ['iOS']]);
    const b = await post(JUNIT, 'cycle=Matrix&ifExists=append&device=iPhone');
    assert.equal(b.body.cycleId, a.body.cycleId);
    assert.match(b.body.warnings.join(' '), /Konfiguration weicht ab \(device\)/);
  });

  it('gleicher Zyklusname mit ifExists=append → gleicher Zyklus; Zuordnung bleibt nach Umbenennung über den Verweis', async () => {
    const renamed = JUNIT.replace('AU-T1 öffnet Akte', 'oeffnet Akte (umbenannt)');
    const first = await post(JUNIT, 'cycle=Nightly%201.5&ifExists=append');
    const refs = (await env.call('GET', `/api/references/by-key/automation/${encodeURIComponent('de.example.akte.AkteIT.AU-T1 öffnet Akte')}`)).body;
    assert.equal(refs.length, 1, 'Automatisierungsverweis angelegt');
    const again = await post(renamed, 'cycle=Nightly%201.5&ifExists=append');
    assert.equal(again.body.cycleId, first.body.cycleId);
    // Umbenannter Test ohne Schlüssel: nicht zuordenbar, bis er verknüpft wird
    assert.ok(again.body.unmapped.some((u: any) => u.name === 'oeffnet Akte (umbenannt)'));
    await env.call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: refs[0].ownerId, provider: 'automation', externalKey: 'de.example.akte.AkteIT.oeffnet Akte (umbenannt)', relation: 'AUTOMATION' });
    const third = await post(renamed, 'cycle=Nightly%201.5&ifExists=append');
    assert.ok(!third.body.unmapped.some((u: any) => u.name === 'oeffnet Akte (umbenannt)'));
  });

  it('Cucumber: Gherkin-Testfall erhält Schrittergebnisse', async () => {
    const r = await post(JSON.stringify(CUCUMBER), 'cycle=BDD', 'application/json');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const [e] = (await env.call('GET', `/api/cycles/${r.body.cycleId}/executions`)).body.items;
    const d = (await env.call('GET', `/api/executions/${e.id}`)).body;
    assert.equal(d.status, 'FAIL');
    assert.deepEqual(d.stepResults.map((s: any) => s.status), ['PASS', 'FAIL', 'NOT_EXECUTED']);
    assert.equal(d.stepResults[1].comment, 'Button fehlt');
  });

  const scenario = (tags: string[], status: string, line: number, msg?: string) => ({ type: 'scenario', name: `Szenario ${line}`, line, tags: tags.map((name) => ({ name })),
    steps: [{ keyword: 'Wenn ', name: 'etwas', result: { status, ...(msg ? { error_message: msg } : {}) } }] });
  const feature = (...elements: unknown[]) => JSON.stringify([{ name: 'Mobil', uri: 'features/mobil.feature', tags: [], elements }]);

  it('@bekannter-fehler: Status „Fehlgeschlagen (bekannt)“ mit Befund', async () => {
    const r = await post(feature(scenario(['@AU-T1', '@bekannter-fehler', '@fehler:Anzeige-ohne-Ticket'], 'failed', 5, 'Layout bricht')), 'cycle=Bekannt', 'application/json');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.knownFailures, r.body.results], [['AU-T1'], { FAIL_KNOWN: 1 }]);
    const [e] = (await env.call('GET', `/api/cycles/${r.body.cycleId}/executions`)).body.items;
    const d = (await env.call('GET', `/api/executions/${e.id}`)).body;
    assert.equal(d.status, 'FAIL_KNOWN');
    assert.match(d.comment, /Bekannter Fehler.*Anzeige-ohne-Ticket/);
  });

  it('Wiederholungsversuch: letzter Versuch zählt, Vermerk im Verlauf; Fundstelle ordnet ohne Tag zu', async () => {
    const r = await post(feature(scenario(['@AU-T2'], 'failed', 12, 'Zeitüberschreitung'), scenario(['@AU-T2'], 'passed', 12)), 'cycle=Retry', 'application/json');
    assert.deepEqual([r.body.results, r.body.retriedPassed], [{ PASS: 1 }, ['AU-T2']]);
    const [n] = await env.db<{ n: number }[]>`select count(*)::int as n from execution_result r join test_execution e on e.id = r.execution_id
      where e.cycle_id = ${r.body.cycleId} and r.note like '%Wiederholung:%'`;
    assert.equal(n!.n, 1);
    // gleiche Fundstelle (Datei:Zeile), Tag entfernt → Zuordnung über die gemerkte Fundstelle
    const again = await post(feature(scenario([], 'passed', 12)), 'cycle=Retry&ifExists=append', 'application/json');
    assert.deepEqual([again.body.mapped, again.body.unmapped.length], [1, 0]);
  });

  it('Fehlschlag im letzten Lauf, Fix im nächsten regulären Lauf: kein Wiederholungsversuch (Review)', async () => {
    const first = await post(feature(scenario(['@AU-T1'], 'failed', 5, 'kaputt')), 'cycle=Nacht', 'application/json');
    assert.equal(first.status, 201, JSON.stringify(first.body));
    // kurz danach erneut gestartet und bestanden: Wiederholung
    const retry = await post(feature(scenario(['@AU-T1'], 'passed', 5)), 'cycle=Nacht&ifExists=append', 'application/json');
    assert.deepEqual(retry.body.retriedPassed, ['AU-T1']);
    // am nächsten Tag: Fehlschlag liegt lange zurück
    await post(feature(scenario(['@AU-T1'], 'failed', 5, 'wieder kaputt')), 'cycle=Nacht&ifExists=append', 'application/json');
    await env.db`update test_execution set executed_at = now() - interval '1 day' where cycle_id = ${first.body.cycleId}`;
    const fixed = await post(feature(scenario(['@AU-T1'], 'passed', 5)), 'cycle=Nacht&ifExists=append', 'application/json');
    assert.deepEqual(fixed.body.retriedPassed, []);
  });

  it('lehnt Unlesbares und Leeres ab', async () => {
    assert.equal((await post('{kaputt', 'cycle=x', 'application/json')).status, 400);
    assert.equal((await post('<testsuites/>', 'cycle=x')).status, 400);
  });
});
