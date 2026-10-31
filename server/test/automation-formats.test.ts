import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { parseResults } from '../src/modules/automation/parse.ts';
import { type TestEnv, testEnv } from './helpers.ts';

const TESTNG = `<?xml version="1.0" encoding="UTF-8"?><testng-results skipped="1" failed="1" passed="1"><suite name="S"><test name="T"><class name="de.example.LoginTest">
<test-method status="PASS" signature="setup()" name="setup" is-config="true" duration-ms="3"/>
<test-method status="PASS" signature="ok()" name="anmelden_AFX_T1" duration-ms="120"/>
<test-method status="FAIL" signature="bad()" name="falschesPasswort" duration-ms="80"><exception class="java.lang.AssertionError"><message><![CDATA[expected <403> but was <200>]]></message></exception></test-method>
<test-method status="SKIP" name="sso" duration-ms="0"/></class></test></suite></testng-results>`;
const NUNIT3 = `<test-run><test-suite type="Assembly"><test-case id="1" name="Drucken" fullname="Demo.Tests.DruckTests.Drucken" result="Passed" duration="0.5"><properties><property name="Category" value="AFX-T2"/></properties></test-case>
<test-case name="Export" fullname="Demo.Tests.DruckTests.Export" result="Failed" duration="1.2"><failure><message><![CDATA[PDF leer]]></message><stack-trace><![CDATA[at Export()]]></stack-trace></failure></test-case></test-suite></test-run>`;
const NUNIT2 = `<test-results><test-suite><results><test-case name="Demo.Tests.A.Ok" executed="True" result="Success" time="0.1"/><test-case name="Demo.Tests.A.Ign" executed="False" result="Ignored"/></results></test-suite></test-results>`;
const XUNIT = `<assemblies><assembly name="x.dll"><collection><test name="Demo.Tests.Akte.Oeffnen" type="Demo.Tests.Akte" method="Oeffnen" time="0.2" result="Pass"><traits><trait name="Category" value="smoke"/></traits></test>
<test name="Demo.Tests.Akte.Schliessen" type="Demo.Tests.Akte" method="Schliessen" time="0.3" result="Fail"><failure><message>Assert.Equal() Failure</message></failure></test></collection></assembly></assemblies>`;
const TRX = `<?xml version="1.0" encoding="utf-8"?><TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>
<UnitTestResult testId="a1" testName="Anmelden" outcome="Passed" duration="00:00:01.5000000"/>
<UnitTestResult testId="a2" testName="Abmelden" outcome="Failed" duration="00:00:00.2500000"><Output><ErrorInfo><Message>Timeout</Message><StackTrace>at Abmelden</StackTrace></ErrorInfo></Output></UnitTestResult></Results>
<TestDefinitions><UnitTest name="Anmelden" id="a1"><TestCategory><TestCategoryItem TestCategory="AFX-T1"/></TestCategory><TestMethod className="Demo.Ui.LoginTests, Vis.Ui" name="Anmelden"/></UnitTest>
<UnitTest name="Abmelden" id="a2"><TestMethod className="Demo.Ui.LoginTests" name="Abmelden"/></UnitTest></TestDefinitions></TestRun>`;
const ROBOT = `<?xml version="1.0" encoding="UTF-8"?><robot generator="Robot 7.0"><suite name="Akte"><suite name="Basis"><test name="Akte anlegen" id="s1-s1-t1">
<kw name="Open Browser"><arguments><arg>chrome</arg></arguments><status status="PASS" start="2026-10-11T10:00:00" elapsed="1.0"/></kw>
<kw name="Click Button"><status status="FAIL" elapsed="0.5">Element not found</status></kw>
<tags><tag>AFX-T3</tag><tag>smoke</tag></tags><status status="FAIL" start="2026-10-11T10:00:00" elapsed="1.7">Element not found</status></test></suite></suite></robot>`;
const BEHAVE = JSON.stringify([{ keyword: 'Feature', name: 'Login', status: 'failed', tags: ['web'], location: 'features/login.feature:1', elements: [
  { type: 'scenario', name: 'Gast meldet sich an', tags: ['AFX-T1'], status: 'failed', steps: [
    { keyword: 'Given', name: 'ein Gast', result: { status: 'passed', duration: 0.1 } },
    { keyword: 'Then', name: 'Startseite', result: { status: 'failed', duration: 0.2, error_message: ['Assertion failed', 'Zeile 2'] } }] }] }]);
const PLAYWRIGHT = JSON.stringify({ config: {}, suites: [{ title: 'akte.spec.ts', file: 'akte.spec.ts', specs: [], suites: [{ title: 'Akte', specs: [
  { title: 'öffnen @AFX-T1', tags: ['@smoke'], tests: [{ projectName: 'chromium', results: [{ status: 'failed', duration: 50, error: { message: '\u001b[31mexpect failed\u001b[39m' } }, { status: 'passed', duration: 40 }] }] },
  { title: 'drucken', tests: [{ projectName: 'firefox', results: [{ status: 'timedOut', duration: 30000, error: { message: 'Timeout' } }] }] }] }] }] });
const JEST = JSON.stringify({ testResults: [{ name: '/repo/src/akte.test.ts', assertionResults: [
  { fullName: 'Akte öffnet AFX-T2', title: 'öffnet AFX-T2', ancestorTitles: ['Akte'], status: 'passed', duration: 5 },
  { fullName: 'Akte schließt', title: 'schließt', ancestorTitles: ['Akte'], status: 'failed', failureMessages: ['Error: \u001b[2mkaputt\u001b[22m'] }] }] });

describe('Ergebnisformate der Testautomatisierung', () => {
  it('erkennt Formate und liest Status, Meldungen, Dauer, Tags', () => {
    const t = parseResults(TESTNG);
    assert.equal(t.format, 'testng');
    assert.deepEqual(t.results.map((r) => [r.name, r.status]), [['anmelden_AFX_T1', 'passed'], ['falschesPasswort', 'failed'], ['sso', 'skipped']]);
    assert.match(t.results[1]!.message!, /403/);
    const n3 = parseResults(NUNIT3);
    assert.equal(n3.format, 'nunit');
    assert.deepEqual(n3.results.map((r) => [r.suite, r.name, r.status, r.tags.join()]), [['Demo.Tests.DruckTests', 'Drucken', 'passed', 'AFX-T2'], ['Demo.Tests.DruckTests', 'Export', 'failed', '']]);
    assert.deepEqual(parseResults(NUNIT2).results.map((r) => r.status), ['passed', 'skipped']);
    const x = parseResults(XUNIT);
    assert.equal(x.format, 'xunit');
    assert.deepEqual(x.results.map((r) => [r.name, r.status]), [['Oeffnen', 'passed'], ['Schliessen', 'failed']]);
    const trx = parseResults(TRX);
    assert.equal(trx.format, 'trx');
    assert.deepEqual(trx.results.map((r) => [r.suite, r.name, r.status, r.durationMs, r.tags.join()]), [['Demo.Ui.LoginTests', 'Anmelden', 'passed', 1500, 'AFX-T1'], ['Demo.Ui.LoginTests', 'Abmelden', 'failed', 250, '']]);
    const rb = parseResults(ROBOT);
    assert.equal(rb.format, 'robot');
    assert.equal(rb.results[0]!.suite, 'Akte.Basis');
    assert.deepEqual(rb.results[0]!.tags, ['AFX-T3', 'smoke']);
    assert.deepEqual(rb.results[0]!.steps.map((s) => s.status), ['passed', 'failed']);
    assert.equal(rb.results[0]!.durationMs, 1700);
    const bh = parseResults(BEHAVE);
    assert.equal(bh.format, 'behave');
    assert.deepEqual(bh.results[0]!.tags, ['web', 'AFX-T1']);
    assert.match(bh.results[0]!.message!, /Assertion failed\nZeile 2/);
    const pw = parseResults(PLAYWRIGHT);
    assert.equal(pw.format, 'playwright');
    assert.deepEqual(pw.results.map((r) => [r.name, r.status]), [['öffnen @AFX-T1 [chromium]', 'passed'], ['drucken [firefox]', 'failed']], 'letzter Versuch zählt');
    const js = parseResults(JEST);
    assert.equal(js.format, 'jest');
    assert.deepEqual(js.results.map((r) => r.status), ['passed', 'failed']);
    assert.equal(js.results[1]!.message, 'Error: kaputt', 'Farbcodes entfernt');
    assert.equal(parseResults('<testsuite><testcase name="a"/></testsuite>').format, 'junit');
  });

  it('XML ohne externe Entitäten (XXE) – DOCTYPE wird ignoriert', () => {
    const r = parseResults(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><testsuite><testcase name="&e;"/></testsuite>`);
    assert.equal(r.results[0]!.name, '&e;');
  });
});

describe('Import über die Oberfläche, Zuordnung, automatische Fehler', () => {
  let env: TestEnv;
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'AFX', name: 'Formate' });
    for (const t of ['Anmelden', 'Drucken', 'Akte']) await env.call('POST', '/api/projects/AFX/test-cases', { content: { title: t, steps: [{ action: 'x', expected: 'y' }] } });
  });
  after(() => env.close());

  it('TRX hochladen: Zuordnung über Kategorie, nicht erkannte nachträglich zuordnen', async () => {
    const r = (await env.call('POST', '/api/projects/AFX/automation-import', { fileName: 'r.trx', contentBase64: Buffer.from(TRX).toString('base64'), cycleName: 'Nightly', build: '7.5.1' })).body;
    assert.equal(r.formatLabel, 'MSTest/TRX');
    assert.equal(r.mapped, 1);
    assert.equal(r.unmapped.length, 1);
    assert.equal(r.unmapped[0].name, 'Abmelden');
    // nicht erkanntes Ergebnis dauerhaft zuordnen → nächster Import findet es
    assert.equal((await env.call('POST', '/api/projects/AFX/automation-mapping', { resultId: r.unmapped[0].id, name: 'Abmelden', testCaseId: 'AFX-T3' })).body.key, 'AFX-T3');
    const r2 = (await env.call('POST', '/api/projects/AFX/automation-import', { fileName: 'r.trx', contentBase64: Buffer.from(TRX).toString('base64'), cycleName: 'Nightly' })).body;
    assert.equal(r2.unmapped.length, 0);
    assert.equal(r2.results.FAIL, 1);
    assert.equal(r2.defects.created.length, 0, 'ohne Option keine Fehler');
  });

  it('Fehler automatisch: ohne OpenProject mit Begründung übersprungen; offener Fehler wird wiederverwendet', async () => {
    const c = (await env.call('POST', '/api/projects/AFX/cycles', { name: 'Hand' })).body;
    await env.call('POST', `/api/cycles/${c.id}/executions`, { testCaseIds: ['AFX-T2'] });
    const [e] = (await env.call('GET', `/api/cycles/${c.id}/executions`)).body.items;
    await env.call('POST', `/api/executions/${e.id}/result`, { status: 'FAIL', comment: 'Export leer', defects: [{ provider: 'jira', key: 'PROJ-900' }] });
    const r = (await env.call('POST', '/api/projects/AFX/automation-import', { fileName: 'n.xml', contentBase64: Buffer.from(NUNIT3).toString('base64'), cycleName: 'CI', createDefects: true })).body;
    assert.equal(r.results.PASS, 1, 'Drucken über Kategorie AFX-T2');
    const ex = (await env.call('GET', `/api/cycles/${r.cycleId}/executions`)).body.items;
    assert.equal(ex.length, 1);
    // Export (fehlgeschlagen) ist nicht zugeordnet → kein Fehler; zuordnen und erneut importieren
    await env.call('POST', '/api/projects/AFX/automation-mapping', { resultId: 'Demo.Tests.DruckTests.Export', testCaseId: 'AFX-T2' });
    const r2 = (await env.call('POST', '/api/projects/AFX/automation-import', { fileName: 'n.xml', contentBase64: Buffer.from(NUNIT3).toString('base64'), cycleName: 'CI2', createDefects: true })).body;
    assert.deepEqual(r2.defects.reused, ['PROJ-900'], 'offener Fehler des Testfalls wiederverwendet');
    assert.equal(r2.defects.created.length, 0);
  });
});
