import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Audit-Trail (Review 30.10.2026: F2/F3)', () => {
  let env: TestEnv;
  let plan: string;
  let cycle: string;
  const events = async (query = '') => (await env.call('GET', `/api/projects/AU/events${query}`)).body;
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'AU', name: 'Audit' });
    plan = (await env.call('POST', '/api/projects/AU/plans', { name: 'Release 1' })).body.id;
    cycle = (await env.call('POST', '/api/projects/AU/cycles', { name: 'Lauf', planId: plan })).body.id;
  });
  after(() => env.close());

  it('Ausstiegskriterien, Plan, Zyklus, Zyklusstatus und Projektregeln: alter und neuer Wert im Protokoll', async () => {
    await env.call('PUT', `/api/plans/${plan}/exit-criteria`, { minPassRate: 95 });
    await env.call('PUT', `/api/plans/${plan}/exit-criteria`, { minPassRate: 80 });
    await env.call('PUT', `/api/plans/${plan}`, { name: 'Release 1.0', release: '1.0' });
    const plan2 = (await env.call('POST', '/api/projects/AU/plans', { name: 'Release 2' })).body.id;
    await env.call('PUT', `/api/cycles/${cycle}`, { name: 'Lauf', planId: plan2 });
    await env.call('POST', `/api/cycles/${cycle}/state`, { state: 'closed' });
    await env.call('POST', `/api/cycles/${cycle}/state`, { state: 'active' });
    await env.call('PUT', '/api/projects/AU/settings', { requireFailureEvidence: false });
    await env.call('PUT', '/api/projects/AU/settings', { requireFailureEvidence: false }); // ohne Änderung: kein Ereignis

    const all = (await events()).items as { type: string; label: string; payload: { changes?: Record<string, { from: unknown; to: unknown }> } }[];
    const of = (t: string) => all.filter((e) => e.type === t);
    const criteria = of('ExitCriteriaChanged');
    assert.equal(criteria.length, 2);
    assert.deepEqual(criteria[0]!.payload.changes, { minPassRate: { from: 95, to: 80 } });
    assert.equal(criteria[0]!.label, 'Ausstiegskriterien geändert');
    assert.deepEqual(of('PlanChanged')[0]!.payload.changes, { name: { from: 'Release 1', to: 'Release 1.0' }, release: { from: null, to: '1.0' } });
    assert.deepEqual(of('CycleChanged')[0]!.payload.changes!.planId, { from: plan, to: plan2 }, 'Verschieben in einen anderen Plan');
    const states = of('CycleStateChanged');
    assert.equal(states.length, 2);
    assert.equal(states[0]!.payload.changes!.closedBy!.from, 'tester', 'wer abgeschlossen hatte, bleibt nach dem Wiederöffnen erhalten');
    assert.deepEqual(of('ProjectRulesChanged').map((e) => e.payload.changes), [{ requireFailureEvidence: { from: true, to: false } }]);
  });

  it('Statuskatalog: Änderung der Kategorie wird protokolliert (instanzweit)', async () => {
    await env.call('PUT', '/api/admin/execution-statuses/PRUEF', { name: 'Prüfung', color: '#123456', category: 'PASSED', appliesTo: 'both', active: true, sortOrder: 20, description: null });
    await env.call('PUT', '/api/admin/execution-statuses/PRUEF', { name: 'Prüfung', color: '#123456', category: 'FAILED', appliesTo: 'both', active: true, sortOrder: 20, description: null });
    const all = (await env.call('GET', '/api/admin/events?type=StatusCatalogChanged')).body.items;
    assert.deepEqual(all[0].payload.changes.category, { from: 'PASSED', to: 'FAILED' });
    assert.equal(all[0].payload.code, 'PRUEF');
  });

  it('Filter, neueste zuerst, Weiterblättern und CSV-Export', async () => {
    const page = await events('?limit=2');
    assert.equal(page.items.length, 2);
    assert.equal(page.more, true);
    assert.ok(page.items[0].seq > page.items[1].seq, 'neueste zuerst');
    const next = await events(`?limit=2&beforeSeq=${page.items[1].seq}`);
    assert.ok(next.items[0].seq < page.items[1].seq);
    assert.ok((await events('?type=ExitCriteriaChanged')).items.every((e: { type: string }) => e.type === 'ExitCriteriaChanged'));
    assert.equal((await events('?actor=niemand')).items.length, 0);
    assert.equal((await events('?from=2099-01-01')).items.length, 0);
    const res = await env.app.request('/api/projects/AU/events?format=csv', { headers: { 'x-anemo-user': 'tester' } });
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(await res.text(), /Ausstiegskriterien geändert/);
  });

  it('Ereignisse sind unveränderlich; das Löschen eines Projekts entfernt nur Kommentarauszüge', async () => {
    await assert.rejects(env.db`update domain_event set actor = 'jemand' where seq = (select max(seq) from domain_event)`, /unveränderlich/);
    await assert.rejects(env.db`delete from domain_event where seq = (select max(seq) from domain_event)`, /unveränderlich/);
    await env.call('POST', '/api/projects', { key: 'WEG', name: 'Weg' });
    const tc = (await env.call('POST', '/api/projects/WEG/test-cases', { content: { title: 'x' } })).body.id;
    await env.call('POST', '/api/comments', { ownerType: 'TEST_CASE', ownerId: tc, body: 'vertraulicher Hinweis' });
    const del = await env.call('DELETE', '/api/projects/WEG', { confirmKey: 'WEG' });
    assert.ok(del.status < 300, JSON.stringify(del.body));
    const [c] = await env.db`select payload from domain_event where type = 'CommentAdded' and aggregate_id = ${tc}`;
    assert.equal(c!.payload.excerpt, undefined, 'Auszug entfernt, Ereignis bleibt');
  });

  it('Freigabestand: Lieferpaket zur Entscheidung abgelegt, Prüfsumme im Protokoll, spätere Änderungen sichtbar (F1)', async () => {
    const tc = (await env.call('POST', '/api/projects/AU/test-cases', { content: { title: 'Freigabe prüfen', steps: [{ action: 'a', expected: 'b' }] } })).body.id;
    await env.call('POST', `/api/cycles/${cycle}/executions`, { testCaseIds: [tc] });
    const ex = (await env.call('GET', `/api/cycles/${cycle}/executions`)).body.items[0].id;
    await env.call('POST', `/api/executions/${ex}/result`, { status: 'PASS' });
    const plan2 = (await env.db`select plan_id from test_cycle where id = ${cycle}`)[0]!.planId as string;
    assert.equal((await env.call('PUT', `/api/plans/${plan2}/release-decision`, { decision: 'released', note: 'Alles bestanden' })).status, 200);
    const list = (await env.call('GET', `/api/plans/${plan2}/baselines`)).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'ready', JSON.stringify(list[0]));
    const res = await env.app.request(`/api/plans/${plan2}/baselines/${list[0].id}/download`, { headers: { 'x-anemo-user': 'tester' } });
    const zip = Buffer.from(await res.arrayBuffer());
    assert.equal(createHash('sha256').update(zip).digest('hex'), list[0].packageSha256, 'Datei unverändert seit der Entscheidung');
    const ev = (await events('?type=ReleaseBaselineCreated')).items[0];
    assert.equal(ev.payload.sha256, list[0].packageSha256);
    // erneuter Abruf legt nichts doppelt an
    assert.equal((await env.call('GET', `/api/plans/${plan2}/baselines`)).body.length, 1);
    let cp = (await env.call('GET', `/api/plans/${plan2}/cockpit`)).body;
    assert.deepEqual([cp.releaseDecision.changesSince, cp.releaseDecision.baseline.sha256], [0, list[0].packageSha256]);
    // nach der Entscheidung ändert jemand das Ergebnis und die Kriterien
    await env.call('POST', `/api/executions/${ex}/result`, { status: 'FAIL', comment: 'doch kaputt' });
    await env.call('PUT', `/api/plans/${plan2}/exit-criteria`, { minPassRate: 50 });
    cp = (await env.call('GET', `/api/plans/${plan2}/cockpit`)).body;
    assert.ok(cp.releaseDecision.changesSince >= 2, String(cp.releaseDecision.changesSince));
    const md = await (await env.app.request(`/api/reports/completion/${plan2}?format=md`, { headers: { 'x-anemo-user': 'tester' } })).text();
    assert.match(md, new RegExp(`SHA-256 ${list[0].packageSha256}`));
    assert.match(md, /Nach der Entscheidung wurden \d+ Änderungen erfasst/);
  });

  it('Fazit: Verfasser, Zeitpunkt und KI-Vermerk; jede Fassung vollständig im Protokoll (F6)', async () => {
    await env.call('PUT', `/api/plans/${plan}/assessment`, { assessment: 'Erste Fassung', aiModel: 'Qwen/Qwen3-8B' });
    await env.call('PUT', `/api/plans/${plan}/assessment`, { assessment: 'Zweite Fassung, überarbeitet', aiModel: 'Qwen/Qwen3-8B' });
    const p = (await env.call('GET', `/api/plans/${plan}`)).body;
    assert.deepEqual([p.assessmentBy, p.assessmentAi, !!p.assessmentAt], ['tester', 'Qwen/Qwen3-8B', true]);
    const ev = (await events('?type=AssessmentChanged')).items[0];
    assert.deepEqual(ev.payload.changes.assessment, { from: 'Erste Fassung', to: 'Zweite Fassung, überarbeitet' });
    const md = await (await env.app.request(`/api/reports/completion/${plan}?format=md`, { headers: { 'x-anemo-user': 'tester' } })).text();
    assert.match(md, /Verfasst von tester.*mit KI erstellt \(Entwurf von Qwen\/Qwen3-8B/);
  });

  it('Testplan archivieren und wiederherstellen, protokolliert; Berichte bleiben erreichbar (F11)', async () => {
    const r = await env.call('POST', `/api/plans/${plan}/archive`, { archived: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.archivedAt);
    const list = (await env.call('GET', '/api/projects/AU/plans')).body;
    assert.ok(list.find((p: { id: string; archivedAt: string | null }) => p.id === plan).archivedAt, 'Liste liefert den Archivstand für die Oberfläche');
    assert.equal((await env.call('GET', `/api/reports/completion/${plan}?format=json`)).status, 200);
    await env.call('POST', `/api/plans/${plan}/archive`, { archived: false });
    const types = (await events('?type=PlanArchived,PlanRestored')).items.map((e: { type: string }) => e.type);
    assert.deepEqual(types, ['PlanRestored', 'PlanArchived']);
  });
});
