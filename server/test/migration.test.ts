import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { anonymizeSnapshot, buildReport, extractSnapshot, runImport } from '../src/modules/migration/index.ts';
import { FIXTURE, type TestEnv, testEnv } from './helpers.ts';

const ATT = await mkdtemp(join(tmpdir(), 'anemo-att-'));

describe('Migration Jira/Zephyr → Anemo', () => {
  let env: TestEnv;
  let firstRun: string;
  before(async () => {
    env = await testEnv();
  });
  after(() => env.close());

  it('importiert den Snapshot vollständig und die Verifikation besteht', async () => {
    const r = await env.call('POST', '/api/migration/runs', { snapshot: 'zephyr-demo' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    firstRun = r.body.runId;
    const report = r.body.report;
    assert.equal(report.verdict, 'PASSED', JSON.stringify(report.checks, null, 1));
    const issue = report.byType.find((t: any) => t.sourceType === 'issue');
    assert.equal(issue.total, 5);
    assert.ok(report.preservedFields.some((f: any) => f.field === 'customfield_10200 (Testart)'));
  });

  it('bildet Testfälle mit Altschlüssel, Ordnern, Verweisen und Anhängen ab', async () => {
    const tc = (await env.call('GET', '/api/test-cases/DEMO-1')).body;
    assert.equal(tc.legacyKey, 'DEMO-1');
    assert.match(tc.key, /^DEMO-T\d+$/);
    assert.equal(tc.status, 'Fertig');
    assert.equal(tc.owner, 'Erika Musterfrau');
    assert.equal(tc.createdBy, 'Max Mustermann');
    assert.equal(tc.version.steps.length, 3);
    const refs = (await env.call('GET', `/api/references?ownerType=TEST_CASE&ownerId=${tc.id}`)).body;
    assert.deepEqual(refs.map((r: any) => `${r.relation}:${r.externalKey}`).sort(),
      ['DEFECT:DEMO-100', 'EPIC:DEMO-10', 'STORY:DEMO-50', 'SUBTASK:DEMO-2001']);
    const att = (await env.call('GET', `/api/attachments?ownerType=TEST_CASE&ownerId=${tc.id}`)).body;
    assert.deepEqual(att.map((a: any) => [a.fileName, a.storage]), [['screenshot-1.png', 'LOCAL']]);
    const folders = (await env.call('GET', '/api/projects/DEMO/folders')).body.map((f: any) => f.name).sort();
    assert.deepEqual(folders, ['(ohne Komponente)', 'Suche', 'Weboberfläche']);
  });

  it('bildet Versionen als Pläne, Zyklen und Ausführungen ab', async () => {
    const cycles = (await env.call('GET', '/api/projects/DEMO/cycles')).body.items;
    assert.deepEqual(cycles.map((c: any) => c.name).sort(), ['Ad hoc (7.3)', 'Freigabetest 7.4', 'Regression 7.3']);
    const reg = cycles.find((c: any) => c.name === 'Regression 7.3');
    assert.deepEqual(reg.byStatus, { FAIL: 1, PASS: 1, PASS_MIT_EINSCHRANKUNG: 1 });
    assert.equal(reg.build, '7.3.0.117');
    const plans = (await env.call('GET', '/api/projects/DEMO/plans')).body.map((p: any) => p.name).sort();
    assert.deepEqual(plans, ['7.3', '7.4']);
    const execs = (await env.call('GET', `/api/cycles/${reg.id}/executions`)).body.items;
    const failed = execs.find((e: any) => e.status === 'FAIL');
    assert.equal(failed.defects[0].externalKey, 'DEMO-101');
    assert.equal(failed.executedBy, 'Max Mustermann');
    const passed = execs.find((e: any) => e.status === 'PASS');
    assert.equal(passed.stepResults.length, 3);
    const statuses = (await env.call('GET', '/api/execution-statuses')).body.map((s: any) => s.code);
    assert.ok(statuses.includes('PASS_MIT_EINSCHRANKUNG'));
  });

  it('Herkunft: Rohdaten sind zum Zielobjekt abrufbar', async () => {
    const tc = (await env.call('GET', '/api/test-cases/DEMO-1')).body;
    const prov = (await env.call('GET', `/api/migration/provenance/${tc.id}`)).body;
    assert.equal(prov[0].sourceType, 'issue');
    assert.equal(prov[0].payload.key, 'DEMO-1');
    assert.equal(prov[0].outcome, 'PARTIAL');
  });

  it('Re-Import ist idempotent: keine Duplikate, keine neuen Versionen', async () => {
    const before = await env.db`select (select count(*) from test_case)::int as tc, (select count(*) from test_case_version)::int as v, (select count(*) from test_execution)::int as e`;
    const r = await runImport(env.db, FIXTURE, { attachmentDir: ATT });
    const after_ = await env.db`select (select count(*) from test_case)::int as tc, (select count(*) from test_case_version)::int as v, (select count(*) from test_execution)::int as e`;
    assert.deepEqual(after_, before);
    assert.equal(r.stats.issue!['action:UNCHANGED'], 5);
    assert.equal((await buildReport(env.db, r.runId)).verdict, 'PASSED');
    assert.notEqual(r.runId, firstRun);
  });

  it('geänderte Quelle erzeugt beim Re-Import eine neue Version, alte Ausführungen bleiben an v1', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anemo-snap-'));
    await cp(FIXTURE, dir, { recursive: true });
    const stepsFile = join(dir, 'teststeps', '20002.json');
    const steps = JSON.parse(await readFile(stepsFile, 'utf8'));
    steps[1].result = 'Akte wird mit Dokumentenliste angezeigt';
    await writeFile(stepsFile, JSON.stringify(steps));
    const r = await runImport(env.db, dir, { attachmentDir: ATT });
    assert.equal(r.stats.issue!['action:UPDATED'], 1);
    const tc = (await env.call('GET', '/api/test-cases/DEMO-2')).body;
    assert.equal(tc.currentVersion, 2);
    assert.equal(tc.version.changeNote, 'Re-Import: Quelle oder Mapping geändert');
    const hist = (await env.call('GET', `/api/test-cases/${tc.id}/executions`)).body;
    assert.ok(hist.every((h: any) => h.versionNo === 1));
  });

  it('defekte Quellobjekte brechen den Lauf nicht ab und werden als FAILED berichtet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anemo-snap-'));
    await cp(FIXTURE, dir, { recursive: true });
    const f = join(dir, 'executions', '10011_201.json');
    const data = JSON.parse(await readFile(f, 'utf8'));
    data.executions.push({ ...data.executions[0], id: 9999, issueId: 77777, issueKey: 'DEMO-404' });
    await writeFile(f, JSON.stringify(data));
    const r = await runImport(env.db, dir, { attachmentDir: ATT });
    const report = await buildReport(env.db, r.runId);
    assert.equal(report.verdict, 'FAILED');
    assert.deepEqual(report.failures.map((x) => x.sourceId), ['9999']);
    assert.match(report.failures[0]!.messages[0]!, /DEMO-404/);
    assert.ok(report.checks.find((c) => c.name.startsWith('Jedes Quellobjekt'))!.passed);
  });

  it('gescheiterter Zyklus: seine Ausführungen werden einzeln als FAILED berichtet, nicht übersprungen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anemo-snap-'));
    await cp(FIXTURE, dir, { recursive: true });
    const cycFile = join(dir, 'cycles', 'DEMO', '10010.json');
    const cycles = JSON.parse(await readFile(cycFile, 'utf8'));
    cycles['200'] = 'kein Objekt';                              // unerwartetes Format → Zyklus scheitert
    cycles['-1'].startDate = -61500646800000;                  // Tippfehler im Altsystem: Jahr 21 statt 2021
    cycles['-1'].description = 'mit NUL\u0000-Zeichen';       // PostgreSQL kann NUL nicht speichern
    await writeFile(cycFile, JSON.stringify(cycles));
    const manifestFile = join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    await writeFile(manifestFile, JSON.stringify({ ...manifest, counts: { issues: 5, cycles: 3, executions: 7 } }));

    const db2 = await testEnv();
    try {
      const r = await runImport(db2.db, dir, { attachmentDir: ATT });
      const report = await buildReport(db2.db, r.runId);
      assert.equal(report.verdict, 'FAILED');
      const failed = report.failures.map((f) => `${f.sourceType}:${f.sourceId}`).sort();
      assert.deepEqual(failed, ['cycle:10010:200', 'execution:9001', 'execution:9002', 'execution:9003', 'stepresults:9001']);
      const execFailure = report.failures.find((f) => f.sourceId === '9001')!;
      assert.match(execFailure.messages[0]!, /Zyklus 10010:200 konnte nicht übernommen werden/);
      const counts = report.checks.find((c) => c.name === 'Alle Objekte des Snapshots verarbeitet')!;
      assert.ok(counts.passed, counts.details.join('; '));
      // Ad-hoc-Zyklus mit unplausiblem Datum wird übernommen (PARTIAL), Datum als Originalwert bewahrt
      const [adhoc] = await db2.db`select start_date, custom_fields from test_cycle where name = 'Ad hoc (7.3)'`;
      assert.equal(adhoc!.startDate, null);
      assert.equal((adhoc!.customFields as any).startDate, -61500646800000);
      const [nulCycle] = await db2.db`select description from test_cycle where name = 'Ad hoc (7.3)'`;
      assert.equal(nulCycle!.description, 'mit NUL-Zeichen', 'NUL entfernt');
      const [rawNul] = await db2.db`select payload_text from source_record where source_type = 'cycle' and source_id = '10010:-1'`;
      assert.ok(String(rawNul!.payloadText).includes('NUL\\u0000-Zeichen'), 'Original exakt im Raw Store');
      // Plan aus einer zurückgerollten Transaktion darf nicht weiterverwendet werden
      const plans = await db2.db`select count(*)::int as n from test_plan`;
      assert.equal(plans[0]!.n, 2);
    } finally {
      await db2.close();
    }
  });

  it('Anzahlprüfung erkennt Objekte, die der Importer nicht verarbeitet hat', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anemo-snap-'));
    await cp(FIXTURE, dir, { recursive: true });
    const manifestFile = join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    await writeFile(manifestFile, JSON.stringify({ ...manifest, counts: { issues: 5, cycles: 3, executions: 8 } }));
    const r = await runImport(env.db, dir, { attachmentDir: ATT });
    const check = (await buildReport(env.db, r.runId)).checks.find((c) => c.name === 'Alle Objekte des Snapshots verarbeitet')!;
    assert.equal(check.passed, false);
    assert.ok(check.details.includes('execution: Snapshot 8, verarbeitet 7'));
  });

  it('rekonstruiert Versionen aus der Historie und hängt Ausführungen zeitrichtig um', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anemo-snap-'));
    await cp(FIXTURE, dir, { recursive: true });
    const t = (iso: string) => Date.parse(iso);
    // DEMO-2 (Issue 20002): Schritte 311, 312. Vor dem 20.09.2026 gab es zusätzlich Schritt 313 ("Drucken"),
    // und Schritt 312 hatte eine andere Erwartung.
    await mkdir(join(dir, 'teststep-history'), { recursive: true });
    await writeFile(join(dir, 'teststep-history', '20002.json'), JSON.stringify({
      changes: [
        { t: t('2026-01-05T10:00:00Z'), author: 'anna', event: 'TESTSTEP_UPDATED', stepId: '313', items: [{ field: 'STEP', old: 'Drukken', new: 'Drucken' }] },
        { t: t('2026-09-20T09:00:00Z'), author: 'anna', event: 'TESTSTEP_UPDATED', stepId: '312', items: [{ field: 'RESULT', old: 'Akte erscheint', new: 'Akte wird angezeigt' }] },
        { t: t('2026-09-20T09:05:00Z'), author: 'anna', event: 'TESTSTEP_DELETED', stepId: '313', items: [{ field: null, old: '3', new: null }] },
      ],
      stepCreated: { '311': t('2023-11-20T14:00:00Z'), '312': t('2023-11-20T14:00:00Z'), '313': t('2023-11-20T14:00:00Z') },
    }));
    const db2 = await testEnv();
    try {
      const r = await runImport(db2.db, dir, { attachmentDir: ATT });
      const report = await buildReport(db2.db, r.runId);
      assert.equal(report.verdict, 'PASSED', JSON.stringify(report.checks.filter((c) => !c.passed)));
      const tc = (await db2.call('GET', '/api/test-cases/DEMO-2')).body;
      const versions = (await db2.call('GET', `/api/test-cases/${tc.id}/versions`)).body;
      assert.ok(versions.length >= 2, JSON.stringify(versions));
      const v1 = (await db2.call('GET', `/api/test-cases/${tc.id}/versions/1`)).body;
      assert.deepEqual(v1.steps.map((s: any) => s.action), ['Benutzer anmelden', 'Akte öffnen', 'Drukken']);
      assert.equal(v1.steps[1].expected, 'Akte erscheint');
      assert.equal(v1.changeNote, 'Rekonstruiert: Ursprungsfassung');
      // Ausführung vom 03.09.2026 → Fassung vor der Änderung; Ausführung vom 04.10.2026 → aktuelle Fassung
      const hist = (await db2.call('GET', `/api/test-cases/${tc.id}/executions`)).body;
      const sept = hist.find((h: any) => h.status === 'FAIL');
      const oct = hist.find((h: any) => h.status === 'PASS');
      assert.ok(sept.versionNo < tc.currentVersion, `September-Ausführung zeigt auf v${sept.versionNo}`);
      assert.equal(oct.versionNo, tc.currentVersion);
      assert.equal(tc.version.steps.length, 2);
      assert.ok(report.metrics.reconstructedTestCases >= 1);
      // Idempotent: erneuter Import ändert nichts
      const again = await runImport(db2.db, dir, { attachmentDir: ATT });
      const tc2 = (await db2.call('GET', '/api/test-cases/DEMO-2')).body;
      assert.equal(tc2.currentVersion, tc.currentVersion);
      assert.equal(again.stats['version-history']!['action:UNCHANGED'], (again.stats['version-history']!.MAPPED ?? 0) + (again.stats['version-history']!.PARTIAL ?? 0));
      // In Anemo gepflegte Versionen werden nie überschrieben
      await db2.call('PUT', '/api/test-cases/DEMO-2/content', { content: { ...tc2.version, title: 'Akte öffnen (gepflegt)' } });
      const third = await runImport(db2.db, dir, { attachmentDir: ATT });
      const rep3 = await buildReport(db2.db, third.runId);
      assert.ok((await db2.call('GET', '/api/test-cases/DEMO-2')).body.version.title.length > 0);
      assert.ok(rep3.byType.find((b) => b.sourceType === 'version-history')!.outcomes.PARTIAL! >= 1);
    } finally {
      await db2.close();
    }
  });

  it('Bericht eines Laufs bleibt gültig, auch wenn ein späterer Lauf gemeinsame Rohobjekte (Status) berührt', async () => {
    const first = await runImport(env.db, FIXTURE, { attachmentDir: ATT });
    await runImport(env.db, FIXTURE, { attachmentDir: ATT });
    const report = await buildReport(env.db, first.runId);
    const check = report.checks.find((c) => c.name === 'Ausführungsstatus korrekt abgebildet')!;
    assert.ok(check.passed, check.details.join('; '));
  });

  it('wiederholte Ad-hoc-Ausführungen desselben Tests bleiben getrennt (keine Zusammenlegung)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anemo-snap-'));
    await cp(FIXTURE, dir, { recursive: true });
    const f = join(dir, 'executions', '10010_-1.json');
    const data = JSON.parse(await readFile(f, 'utf8'));
    data.executions.push({ ...data.executions[0], id: 9010, executionStatus: '1', executedOn: '20/Sep/26 9:00 AM', comment: 'Wiederholung' });
    data.executions.push({ ...data.executions[0], id: 9011, executionStatus: '2', executedOn: '21/Sep/26 9:00 AM', comment: 'Wiederholung 2' });
    await writeFile(f, JSON.stringify(data));
    const db2 = await testEnv();
    try {
      const r = await runImport(db2.db, dir, { attachmentDir: ATT });
      const report = await buildReport(db2.db, r.runId);
      assert.equal(report.verdict, 'PASSED', JSON.stringify(report.checks.filter((c) => !c.passed)));
      const rows = await db2.db`select e.status, e.comment from test_execution e join test_case tc on tc.id = e.test_case_id
        where tc.legacy_key = 'DEMO-5' order by e.created_at`;
      assert.deepEqual(rows.map((x) => x.status).sort(), ['FAIL', 'PASS', 'WIP']);
      // erneuter Import: weiterhin drei getrennte Datensätze
      await runImport(db2.db, dir, { attachmentDir: ATT });
      assert.equal((await db2.db`select count(*)::int as n from test_execution e join test_case tc on tc.id = e.test_case_id where tc.legacy_key = 'DEMO-5'`)[0]!.n, 3);
    } finally {
      await db2.close();
    }
  });

  it('verhindert Pfad-Ausbruch beim Snapshot-Namen', async () => {
    assert.equal((await env.call('POST', '/api/migration/runs', { snapshot: '../etc' })).status, 400);
  });
});

describe('Extraktion gegen simulierten Jira-Server', () => {
  let env: TestEnv;
  before(async () => {
    env = await testEnv();
  });
  after(() => env.close());

  it('liest Jira REST v2 + ZAPI, schreibt einen importierbaren Snapshot', async () => {
    const read = async (p: string) => JSON.parse(await readFile(join(FIXTURE, p), 'utf8'));
    let base = '';
    const issues = () => Promise.all([1, 2, 3, 4, 5].map(async (n) =>
      JSON.parse(JSON.stringify(await read(`issues/DEMO-${n}.json`)).replaceAll('http://jira.example.invalid', base))));
    const seenAuth = new Set<string>();
    const server = createServer(async (req, res) => {
      seenAuth.add(req.headers.authorization ?? '');
      const url = new URL(req.url!, 'http://x');
      const q = url.searchParams;
      let body: unknown = null;
      if (url.pathname === '/rest/api/2/field') body = await read('fields.json');
      else if (url.pathname === '/rest/zapi/latest/util/testExecutionStatus') body = await read('execution-statuses.json');
      else if (url.pathname === '/rest/api/2/project/DEMO') body = await read('projects/DEMO.json');
      else if (url.pathname === '/rest/api/2/search') {
        const start = Number(q.get('startAt'));
        const all = await issues();
        body = { total: all.length, issues: all.slice(start, start + 2) }; // Seitengröße 2 erzwingt Paging
      } else if (url.pathname.startsWith('/rest/zapi/latest/teststep/')) body = await read(`teststeps/${url.pathname.split('/').pop()}.json`);
      else if (url.pathname === '/rest/zapi/latest/cycle') body = await read(`cycles/DEMO/${q.get('versionId')}.json`);
      else if (url.pathname === '/rest/zapi/latest/execution') {
        body = await read(`executions/${q.get('versionId')}_${q.get('cycleId')}.json`).catch(() => ({ status: {}, executions: [] }));
      } else if (url.pathname === '/rest/zapi/latest/stepResult') body = await read(`stepresults/${q.get('executionId')}.json`).catch(() => []);
      else if (url.pathname === '/rest/zapi/latest/attachment/attachmentsByEntity') {
        body = { data: q.get('entityId') === '9002' ? [{ fileId: '77', fileName: 'fehler.log', fileSize: 5, author: 'mmustermann' }] : [] };
      } else if (url.pathname === '/rest/zapi/latest/attachment/77/file' || url.pathname.startsWith('/secure/attachment/')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from('BINARY'));
        return;
      }
      res.writeHead(body === null ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? { error: 'not found' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    const out = await mkdtemp(join(tmpdir(), 'anemo-extract-'));
    try {
      const m = await extractSnapshot({
        baseUrl: `http://127.0.0.1:${port}`, auth: { user: 'svc', password: 'pw' }, projects: ['DEMO'], outDir: out, withStepResults: true,
      });
      assert.equal(m.anonymized, false);
      assert.deepEqual([...seenAuth], [`Basic ${Buffer.from('svc:pw').toString('base64')}`]);
      assert.deepEqual(m.warnings, []);
      assert.equal(m.counts!.attachmentFiles, 2);
      const attDir = await mkdtemp(join(tmpdir(), 'anemo-att-'));
      const r = await runImport(env.db, out, { attachmentDir: attDir });
      const report = await buildReport(env.db, r.runId);
      assert.equal(report.verdict, 'PASSED', JSON.stringify(report.checks));
      const files = await env.db`select storage, file_name, size_bytes::int as size from attachment order by file_name`;
      assert.deepEqual(files.map((f) => [f.fileName, f.storage, f.size]), [['fehler.log', 'LOCAL', 6], ['screenshot-1.png', 'LOCAL', 6]]);
      const again = await runImport(env.db, out, { attachmentDir: attDir });
      // Regression: ein früherer Import ohne Dateien (nur Verweise) darf die Übernahme der Dateien nicht verhindern
      const env3 = await testEnv();
      try {
        await runImport(env3.db, out); // ohne attachmentDir → nur Verweise
        assert.deepEqual((await env3.db`select storage from attachment`).map((x) => x.storage), ['SOURCE', 'SOURCE']);
        await runImport(env3.db, out, { attachmentDir: await mkdtemp(join(tmpdir(), 'anemo-att-')) });
        assert.deepEqual((await env3.db`select storage from attachment order by file_name`).map((x) => x.storage), ['LOCAL', 'LOCAL']);
      } finally {
        await env3.close();
      }
      assert.equal((await env.db`select count(*)::int as n from attachment`)[0]!.n, 2, 'Re-Import dupliziert keine Anhänge');
      assert.equal((await buildReport(env.db, again.runId)).verdict, 'PASSED');
      assert.equal(report.byType.find((t) => t.sourceType === 'issue')!.total, 5);
      assert.equal(report.byType.find((t) => t.sourceType === 'execution')!.total, 7);
    } finally {
      server.close();
    }
  });
});

describe('Nachladen fehlender Anhänge', () => {
  it('lädt fehlgeschlagene Downloads nach und entfernt die Lücke aus dem Manifest', async () => {
    const { repairAttachments } = await import('../src/modules/migration/orchestrate.ts');
    const { JiraClient } = await import('../src/modules/migration/extract.ts');
    const dir = await mkdtemp(join(tmpdir(), 'anemo-repair-'));
    await cp(FIXTURE, dir, { recursive: true });
    await rm(join(dir, 'attachments', 'jira-4711'));
    const mf = join(dir, 'manifest.json');
    const m = JSON.parse(await readFile(mf, 'utf8'));
    await writeFile(mf, JSON.stringify({ ...m, warnings: ['DEMO-1 Anhang screenshot-1.png: GET /secure/attachment/4711/screenshot-1.png → HTTP 500', 'andere Lücke'] }));
    let calls = 0;
    const fetchImpl = (async () => (++calls === 1 ? new Response('x', { status: 500 }) : new Response(new Uint8Array([1, 2, 3])))) as unknown as typeof fetch;
    const client = new JiraClient({ baseUrl: 'http://jira.example.invalid', auth: { token: 't' }, fetchImpl });
    const r = await repairAttachments(dir, client);
    assert.deepEqual(r, { fixed: 1, remaining: 0 });
    assert.equal(calls, 2, 'vorübergehender HTTP 500 wird wiederholt');
    assert.deepEqual(JSON.parse(await readFile(mf, 'utf8')).warnings, ['andere Lücke']);
    assert.deepEqual([...(await readFile(join(dir, 'attachments', 'jira-4711')))], [1, 2, 3]);
  });
});

describe('Extraktion: Fehlerantworten', () => {
  it('bricht ab, wenn die ZAPI einen Fehler mit HTTP 200 meldet (keine stillen Fehldaten)', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ errorDesc: 'Anmeldung erforderlich.', errorId: 'ERROR' }), { status: 200 })) as typeof fetch;
    const out = await mkdtemp(join(tmpdir(), 'anemo-extract-'));
    await assert.rejects(
      extractSnapshot({ baseUrl: 'http://jira', auth: { token: 't' }, projects: ['X'], outDir: out, fetchImpl: fakeFetch }),
      /Fehler trotz HTTP 200: Anmeldung erforderlich/,
    );
  });
});

describe('Anonymisierung', () => {
  let env: TestEnv;
  before(async () => {
    env = await testEnv();
  });
  after(() => env.close());

  it('entfernt Personen konsistent, Import funktioniert weiter', async () => {
    const out = await mkdtemp(join(tmpdir(), 'anemo-anon-'));
    const r = await anonymizeSnapshot(FIXTURE, out, { salt: 'test-salt-0123456789' });
    assert.equal(r.people, 2);
    const all = (await Promise.all(['issues/DEMO-1.json', 'executions/10010_200.json', 'projects/DEMO.json', 'teststeps/20001.json']
      .map((p) => readFile(join(out, p), 'utf8')))).join('\n');
    for (const secret of ['Musterfrau', 'Mustermann', 'emusterfrau', 'mmustermann', '@example.org']) {
      assert.ok(!all.includes(secret), `${secret} wurde nicht entfernt`);
    }
    const issue = JSON.parse(await readFile(join(out, 'issues/DEMO-1.json'), 'utf8'));
    const exec = JSON.parse(await readFile(join(out, 'executions/10010_200.json'), 'utf8'));
    assert.equal(issue.fields.assignee.displayName, exec.executions[0].executedByDisplay, 'gleiche Person → gleiches Pseudonym');
    assert.match(issue.fields.comment.comments[0].body, /\[~user-[0-9a-f]{6}\]/);
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.anonymized, true);

    const run = await runImport(env.db, out, { attachmentDir: ATT });
    assert.equal((await buildReport(env.db, run.runId)).verdict, 'PASSED');
  });

  it('Freitext-Verfremdung erhält die Panel-Struktur', async () => {
    const out = await mkdtemp(join(tmpdir(), 'anemo-anon-'));
    await anonymizeSnapshot(FIXTURE, out, { salt: 'test-salt-0123456789', scrubText: true });
    const issue = JSON.parse(await readFile(join(out, 'issues/DEMO-1.json'), 'utf8'));
    assert.ok(!issue.fields.description.includes('PDF-Dokument'));
    assert.match(issue.fields.description, /\{panel:titleBGColor=#fafafa\|title=/);
    const run = await runImport(env.db, out, { attachmentDir: ATT });
    const tc = (await env.call('GET', '/api/test-cases/DEMO-1')).body;
    assert.ok(tc.version.preconditions, 'Vorbedingungen-Panel wird weiterhin erkannt');
    assert.equal((await buildReport(env.db, run.runId)).verdict, 'PASSED');
  });
});
