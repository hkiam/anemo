import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setLlmFetch } from '../src/modules/assist/index.ts';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Stufe G: Datensätze, Dauer, Testsets, Traceability, Sitzungen, KI-Skills', () => {
  let env: TestEnv;
  let planId = '';
  let cycleId = '';
  const ids: Record<string, string> = {};
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'GG', name: 'Stufe G' });
    await env.call('POST', '/api/projects', { key: 'HH', name: 'Anderes Projekt' });
    const mk = async (title: string, extra: object = {}) => (await env.call('POST', '/api/projects/GG/test-cases', { content: { title, steps: [{ action: 'Als ${rolle} anmelden', expected: 'Startseite für ${rolle}' }], ...extra } })).body;
    const a = await mk('Anmelden je Rolle', { dataset: { columns: ['rolle'], rows: [['Admin'], ['Leser'], ['Gast']] } });
    ids.a = a.id;
    ids.b = (await mk('Akte öffnen', { labels: ['smoke'] })).id;
    ids.c = (await mk('Akte drucken', { labels: ['smoke'] })).id;
    ids.d = (await env.call('POST', '/api/projects/GG/test-cases', { content: { title: 'Gherkin-Grundriss', format: 'GHERKIN',
      gherkin: '# language: de\nFunktionalität: F\n  Szenariogrundriss: S\n    Wenn ich <x> eingebe\n    Dann sehe ich <y>\n\n    Beispiele:\n      | x | y |\n      | 1 | eins |\n      | 2 | zwei |\n' } })).body.id;
    planId = (await env.call('POST', '/api/projects/GG/plans', { name: 'Release 1' })).body.id;
    cycleId = (await env.call('POST', '/api/projects/GG/cycles', { name: 'Lauf 1', planId })).body.id;
    await env.call('POST', `/api/cycles/${cycleId}/executions`, { testCaseIds: ['GG-T1', 'GG-T2', 'GG-T3', 'GG-T4'] });
  });
  after(async () => { setLlmFetch(null); await env.close(); });

  const execOf = async (key: string) => (await env.call('GET', `/api/cycles/${cycleId}/executions?limit=50`)).body.items.find((e: any) => e.testCaseKey === key);

  it('G1: Datensatz wird geprüft und ist versioniert; Gherkin-Beispiele werden zum Datensatz', async () => {
    const bad = await env.call('POST', '/api/projects/GG/test-cases', { content: { title: 'x', dataset: { columns: ['a', 'b'], rows: [['1']] } } });
    assert.equal(bad.status, 400);
    const e1 = (await env.call('GET', `/api/executions/${(await execOf('GG-T1')).id}`)).body;
    assert.deepEqual(e1.dataset, { columns: ['rolle'], rows: [['Admin'], ['Leser'], ['Gast']] });
    const e4 = (await env.call('GET', `/api/executions/${(await execOf('GG-T4')).id}`)).body;
    assert.deepEqual(e4.dataset, { columns: ['x', 'y'], rows: [['1', 'eins'], ['2', 'zwei']] });
    assert.equal((await env.call('GET', `/api/executions/${(await execOf('GG-T2')).id}`)).body.dataset, null);
  });

  it('G1: Durchläufe je Datenzeile mit Werten, Ergebnis und Schrittergebnissen; ungültige werden abgelehnt', async () => {
    const e = (await env.call('GET', `/api/executions/${(await execOf('GG-T1')).id}`)).body;
    const step = e.steps[0].id;
    const r = await env.call('POST', `/api/executions/${e.id}/result`, {
      status: 'FAIL', durationSeconds: 300,
      iterations: [{ index: 0, status: 'PASS', stepResults: [{ stepId: step, status: 'PASS' }] }, { index: 2, status: 'FAIL', comment: 'Gast sieht Admin-Menü' }, { index: 1, status: 'PASS' }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.iterations.map((i: any) => [i.index, i.values.rolle, i.status]), [[0, 'Admin', 'PASS'], [1, 'Leser', 'PASS'], [2, 'Gast', 'FAIL']]);
    assert.equal((await env.call('POST', `/api/executions/${e.id}/result`, { status: 'PASS', iterations: [{ index: 3, status: 'PASS' }] })).status, 400);
    assert.equal((await env.call('POST', `/api/executions/${(await execOf('GG-T2')).id}/result`, { status: 'PASS', iterations: [{ index: 0, status: 'PASS' }] })).status, 400);
  });

  it('G4: Dauer wird aufsummiert, Beginn gesetzt, Summe je Zyklus, Verteilen nach Erfahrungswert', async () => {
    const id = (await execOf('GG-T1')).id;
    await env.call('POST', `/api/executions/${id}/result`, { status: 'FAIL', durationSeconds: 120 });
    const e = (await env.call('GET', `/api/executions/${id}`)).body;
    assert.equal(e.durationSeconds, 420);
    assert.ok(e.startedAt);
    const page = (await env.call('GET', `/api/cycles/${cycleId}/executions`)).body;
    assert.equal(page.durationSeconds, 420);
    const c2 = (await env.call('POST', '/api/projects/GG/cycles', { name: 'Lauf 2', planId })).body.id;
    await env.call('POST', `/api/cycles/${c2}/executions`, { testCaseIds: ['GG-T1', 'GG-T2', 'GG-T3'] });
    const d = (await env.call('POST', `/api/cycles/${c2}/distribute`, { assignees: ['ina', 'olaf'], weight: 'duration' })).body;
    // G-T1 (420 s Erfahrung) allein, die beiden anderen (je 120 s Schätzung) zusammen
    assert.deepEqual(Object.values(d.assigned).sort(), [1, 2]);
  });

  it('G4: Testsets statisch und dynamisch, nur Testfälle des Projekts', async () => {
    const s1 = (await env.call('POST', '/api/projects/GG/test-sets', { name: 'Kern', kind: 'static', testCaseIds: [ids.a, ids.b] })).body;
    const s2 = (await env.call('POST', '/api/projects/GG/test-sets', { name: 'Smoke', kind: 'dynamic', query: 'label=smoke' })).body;
    assert.deepEqual((await env.call('GET', `/api/test-sets/${s1.id}/test-cases`)).body.map((t: any) => t.key), ['GG-T1', 'GG-T2']);
    assert.deepEqual((await env.call('GET', `/api/test-sets/${s2.id}/test-cases`)).body.map((t: any) => t.key).sort(), ['GG-T2', 'GG-T3']);
    const list = (await env.call('GET', '/api/projects/GG/test-sets')).body;
    assert.deepEqual(list.map((s: any) => [s.name, s.count]), [['Kern', 2], ['Smoke', 2]]);
    const hId = (await env.call('POST', '/api/projects/HH/test-cases', { content: { title: 'fremd' } })).body.id;
    assert.equal((await env.call('POST', '/api/projects/GG/test-sets', { name: 'Fremd', kind: 'static', testCaseIds: [hId] })).status, 404);
    assert.equal((await env.call('POST', '/api/projects/GG/test-sets', { name: 'Kern', kind: 'static', testCaseIds: [] })).status, 409);
    assert.equal((await env.call('DELETE', `/api/test-sets/${s1.id}`)).status, 204);
  });

  it('G3: Rückverfolgbarkeit je Release: OK, Fehler, nicht getestet, ohne Testfall', async () => {
    const ref = (ownerType: string, ownerId: string, key: string) => env.call('POST', '/api/references', { ownerType, ownerId, provider: 'jira', externalKey: key, relation: 'REQUIREMENT', title: `Anforderung ${key}` });
    await ref('TEST_CASE', ids.a!, 'REQ-1');      // G-T1 FAIL → NOK
    await ref('TEST_CASE', ids.b!, 'REQ-2');      // G-T2 PASS → OK
    await ref('TEST_CASE', ids.c!, 'REQ-3');      // G-T3 offen → NOT_RUN
    await ref('TEST_PLAN', planId, 'REQ-4');     // kein Testfall → UNCOVERED
    await env.call('POST', `/api/executions/${(await execOf('GG-T2')).id}/result`, { status: 'PASS' });
    const t = (await env.call('GET', `/api/reports/traceability/${planId}?format=json`)).body;
    assert.deepEqual(Object.fromEntries(t.requirements.map((r: any) => [r.key, r.state])), { 'REQ-1': 'NOK', 'REQ-2': 'OK', 'REQ-3': 'NOT_RUN', 'REQ-4': 'UNCOVERED' });
    assert.deepEqual(t.totals, { OK: 1, NOK: 1, NOT_RUN: 1, UNCOVERED: 1 });
    assert.deepEqual(t.testsWithoutRequirement.map((x: any) => x.key), ['GG-T4']);
    const html = await env.app.request(`/api/reports/traceability/${planId}`, { headers: { 'x-anemo-user': 't' } });
    assert.match(await html.text(), /Rückverfolgbarkeit[\s\S]*REQ-4[\s\S]*ohne Testfall/);
    const k = (await env.call('GET', `/api/plans/${planId}/cockpit`)).body;
    assert.deepEqual(k.coverage.totals, { OK: 1, NOK: 1, NOT_RUN: 1, UNCOVERED: 1 });
    assert.ok(k.effort.seconds >= 420);
    // bekannter Fehler ist nicht in Ordnung – nicht „nicht getestet“ (Review K6)
    const known = await env.call('POST', `/api/executions/${(await execOf('GG-T3')).id}/result`, { status: 'FAIL_KNOWN', comment: 'bekannt: Druck bricht ab' });
    assert.equal(known.status, 200, JSON.stringify(known.body));
    const t2 = (await env.call('GET', `/api/reports/traceability/${planId}?format=json`)).body;
    assert.equal(t2.requirements.find((r: any) => r.key === 'REQ-3').state, 'NOK');
    // nicht anwendbar: Anforderung erfüllt, zählt nicht im Durchführungsgrad (Review F8)
    const na = await env.call('POST', `/api/executions/${(await execOf('GG-T3')).id}/result`, { status: 'NA', comment: 'trifft in diesem Release nicht zu' });
    assert.equal(na.status, 200, JSON.stringify(na.body));
    const t3 = (await env.call('GET', `/api/reports/traceability/${planId}?format=json`)).body;
    assert.equal(t3.requirements.find((r: any) => r.key === 'REQ-3').state, 'OK');
    const c = (await env.call('GET', `/api/reports/completion/${planId}?format=json`)).body;
    assert.equal(c.current.notApplicable, 1);
    assert.ok(c.current.total - c.current.notApplicable - c.current.invalid > 0);
  });

  it('G2: Explorative Sitzung: Zeitnahme, Funde, Screenshots, Bericht, Löschregel', async () => {
    const s = (await env.call('POST', `/api/cycles/${cycleId}/sessions`, { charter: 'Druckfunktionen unter Last erkunden', timeboxMinutes: 30 })).body;
    assert.equal(s.status, 'planned');
    assert.equal((await env.call('POST', `/api/sessions/${s.id}/timer`, { action: 'start' })).body.status, 'running');
    assert.equal((await env.call('POST', `/api/sessions/${s.id}/timer`, { action: 'pause' })).body.status, 'paused');
    await env.call('PUT', `/api/sessions/${s.id}`, { notes: 'Druckdialog langsam bei 50 Seiten' });
    // Beobachtungen werden einzeln und atomar angehängt (parallel ohne Verlust)
    await Promise.all([
      env.call('POST', `/api/sessions/${s.id}/findings`, { kind: 'bug', text: 'Druck bricht bei 100 Seiten ab' }),
      env.call('POST', `/api/sessions/${s.id}/findings`, { kind: 'idea', text: 'Fortschrittsanzeige' }),
    ]);
    let u = (await env.call('GET', `/api/sessions/${s.id}`)).body;
    assert.equal(u.findings.length, 2);
    const bug = u.findings.find((f: any) => f.kind === 'bug');
    assert.ok(bug.id && bug.by && bug.at);
    u = (await env.call('PATCH', `/api/sessions/${s.id}/findings/${bug.id}`, { defectKey: 'BUG-7' })).body;
    assert.equal(u.findings.find((f: any) => f.id === bug.id).by, bug.by, 'Urheber bleibt');
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    assert.equal((await env.call('POST', '/api/attachments/base64', { ownerType: 'EXPLORATORY_SESSION', ownerId: s.id, fileName: 'druck.png', contentType: 'image/png', contentBase64: png })).status, 201);
    assert.equal((await env.call('POST', `/api/sessions/${s.id}/timer`, { action: 'stop' })).status, 400, 'Zusammenfassung Pflicht');
    const done = (await env.call('POST', `/api/sessions/${s.id}/timer`, { action: 'stop', summary: 'Druck großer Akten instabil' })).body;
    assert.equal(done.status, 'done');
    assert.ok(done.endedAt);
    const again = (await env.call('POST', `/api/sessions/${s.id}/timer`, { action: 'stop' })).body;
    assert.equal(new Date(again.endedAt).getTime(), new Date(done.endedAt).getTime(), 'Stoppen ist idempotent');
    assert.equal((await env.call('PUT', `/api/sessions/${s.id}`, { notes: 'nachträglich' })).status, 409, 'nach Abschluss schreibgeschützt');
    assert.equal((await env.call('POST', `/api/sessions/${s.id}/timer`, { action: 'start' })).status, 409);
    assert.equal((await env.call('POST', `/api/sessions/${s.id}/debrief`, { note: 'besprochen', tbs: { test: 60, bug: 30, setup: 20 } })).status, 400, 'Summe 100 %');
    const deb = (await env.call('POST', `/api/sessions/${s.id}/debrief`, { note: 'Mit Testleitung besprochen, Lasttest einplanen', tbs: { test: 60, bug: 30, setup: 10 } })).body;
    assert.equal(deb.status, 'debriefed');
    assert.equal((await env.call('DELETE', `/api/sessions/${s.id}`)).status, 400);
    const log = (await env.call('GET', `/api/reports/test-log/${cycleId}?format=json`)).body;
    assert.equal(log.sessions[0].charter, 'Druckfunktionen unter Last erkunden');
    assert.equal(log.sessions[0].findings.find((f: any) => f.kind === 'bug').defectKey, 'BUG-7');
    assert.equal(log.executions.find((e: any) => e.testCaseKey === 'GG-T1').iterations.length, 3);
    const planned = (await env.call('POST', `/api/cycles/${cycleId}/sessions`, { charter: 'nur geplant' })).body;
    assert.equal((await env.call('DELETE', `/api/sessions/${planned.id}`)).status, 204);
  });

  it('G5: Skills prüfen, Fehlermeldung und Fazit; Projektkontext, Profile, Datenschutz, Kennzeichnung', async () => {
    const calls: { url: string; system: string; model: string }[] = [];
    let reply = '';
    setLlmFetch((async (url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      calls.push({ url, system: b.messages?.[0]?.content ?? b.system, model: b.model });
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 });
    }) as typeof fetch);
    await env.call('PUT', '/api/admin/settings', { changes: { AI_BASE_URL: 'http://lokal:8000/v1', AI_MODEL: 'lokal-1', AI_ON_PREM: 'true', AI_STRONG_BASE_URL: 'https://extern.example/v1', AI_STRONG_MODEL: 'stark-1' } });
    await env.call('PUT', '/api/projects/GG/ai-context', { aiContext: 'Akte = elektronische Verfahrensakte (eAkte)' });

    reply = '{"findings":[{"severity":"hoch","step":1,"problem":"Erwartung unscharf","suggestion":"Konkrete Elemente nennen"}]}';
    const rv = await env.call('POST', '/api/projects/GG/assist/review', { title: 'Akte öffnen', steps: [{ action: 'öffnen', expected: 'geht' }] });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    assert.equal(rv.body.findings[0].step, 1);
    assert.match(calls.at(-1)!.system, /Projektkontext[\s\S]*eAkte/);
    assert.equal(calls.at(-1)!.model, 'lokal-1');

    reply = '{"title":"Gast sieht Admin-Menü","steps":["Als Gast anmelden"],"expected":"kein Admin-Menü","actual":"Admin-Menü sichtbar","environment":"Lauf 1","severity":"major","notes":""}';
    const df = await env.call('POST', `/api/executions/${(await execOf('GG-T1')).id}/assist/defect`);
    assert.equal(df.status, 200, JSON.stringify(df.body));
    assert.match(df.body.body, /h3\. Schritte zur Reproduktion/);

    // Fazit nutzt Profil „stark“ (extern) – im freigegebenen Projekt erlaubt …
    reply = '{"assessment":"Teststand weitgehend gut.","risks":[{"risk":"Rollen","reason":"REQ-1 fehlgeschlagen"}],"recommendation":"mit Auflagen","conditions":["REQ-1 beheben"]}';
    const fa = await env.call('POST', `/api/plans/${planId}/assist/assessment`);
    assert.equal(fa.status, 200, JSON.stringify(fa.body));
    assert.equal(calls.at(-1)!.model, 'stark-1');
    assert.match(fa.body.text, /Empfehlung: mit Auflagen/);
    // … bei gesperrten externen Diensten fällt es auf das on-prem-Modell zurück
    await env.call('PUT', '/api/projects/GG/external-services', { externalServices: 'blocked' });
    await env.call('POST', `/api/plans/${planId}/assist/assessment`);
    assert.equal(calls.at(-1)!.model, 'lokal-1');
    await env.call('PUT', '/api/projects/GG/external-services', { externalServices: 'allowed' });

    // Fazit speichern → im Abschlussbericht
    await env.call('PUT', `/api/plans/${planId}/assessment`, { assessment: fa.body.text });
    const cr = await env.app.request(`/api/reports/completion/${planId}`, { headers: { 'x-anemo-user': 't' } });
    assert.match(await cr.text(), /Fazit des Testmanagements[\s\S]*mit Auflagen/);

    // Kennzeichnung „mit KI erstellt“ an der Version
    const tc = (await env.call('POST', '/api/projects/GG/test-cases', { content: { title: 'Aus KI-Entwurf' }, aiAssisted: 'testcase-draft · lokal-1' })).body;
    assert.equal(tc.version.aiAssisted, 'testcase-draft · lokal-1');
    // Profil je Skill umstellbar
    await env.call('PUT', '/api/admin/ai/prompts/testcase-review', { system: null, profile: 'strong' });
    reply = '{"findings":[]}';
    await env.call('POST', '/api/projects/GG/assist/review', { title: 'x' });
    assert.equal(calls.at(-1)!.model, 'stark-1');
    const prompts = (await env.call('GET', '/api/admin/ai/prompts')).body;
    assert.equal(prompts.find((p: any) => p.key === 'testcase-review').profile, 'strong');
  });
});
