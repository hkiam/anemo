import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, verify } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { type TestEnv, testEnv } from './helpers.ts';

/** Minimaler ZIP-Leser für den Test (Zentralverzeichnis → Einträge). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen;
  }
  return out;
}

describe('Testberichte und Lieferpaket (C1/C2)', () => {
  let env: TestEnv;
  let planId: string;
  let cycleId: string;
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

  const upload = async (ownerType: string, ownerId: string, name: string) => {
    const form = new FormData();
    form.set('ownerType', ownerType);
    form.set('ownerId', ownerId);
    form.set('file', new File([PNG], name, { type: 'image/png' }));
    const res = await env.app.request('/api/attachments', { method: 'POST', body: form, headers: { 'x-anemo-user': 'tina' } });
    assert.equal(res.status, 201);
  };
  const raw = (path: string) => env.app.request(path, { headers: { 'x-anemo-user': 'tina' } });

  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'RP', name: 'Reports' });
    const tc = (await env.call('POST', '/api/projects/RP/test-cases', { content: { title: 'Akte drucken', objective: 'Druck *prüfen*', steps: [
      { action: 'Druckdialog öffnen !dialog.png!', expected: 'Dialog erscheint' }, { action: 'Drucken', expected: 'PDF entsteht' },
    ] } })).body;
    await upload('TEST_CASE', tc.id, 'dialog.png');
    await env.call('POST', '/api/projects/RP/test-cases', { content: { title: 'Akte schließen', steps: [{ action: 'Schließen', expected: 'zu' }] } });
    planId = (await env.call('POST', '/api/projects/RP/plans', { name: 'Release 8.0', release: '8.0' })).body.id;
    cycleId = (await env.call('POST', '/api/projects/RP/cycles', { name: 'Regression ORA', planId, release: '8.0', build: '8.0.1' })).body.id;
    await env.call('POST', `/api/cycles/${cycleId}/executions`, { testCaseIds: ['RP-T1', 'RP-T2'] });
    const execs = (await env.call('GET', `/api/cycles/${cycleId}/executions`)).body.items;
    const e1 = execs.find((e: any) => e.testCaseKey === 'RP-T1');
    const steps = (await env.call('GET', `/api/executions/${e1.id}`)).body.steps;
    await env.call('POST', `/api/executions/${e1.id}/result`, {
      status: 'FAIL', comment: 'Druck bricht ab <script>alert(1)</script> !screenshot.png!',
      stepResults: [{ stepId: steps[0].id, status: 'PASS' }, { stepId: steps[1].id, status: 'FAIL', comment: 'kein PDF' }],
      defects: [{ provider: 'jira', key: 'RP-99' }],
    }, 'tina');
    await upload('TEST_EXECUTION', e1.id, 'screenshot.png');
  });
  after(() => env.close());

  it('Testprotokoll als HTML: Zusammenfassung, Befund mit Bild, maskierter Inhalt', async () => {
    const res = await raw(`/api/reports/test-log/${cycleId}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /text\/html/);
    const html = await res.text();
    assert.match(html, /<h1>Testprotokoll<\/h1>/);
    assert.match(html, /ISO\/IEC\/IEEE 29119-3 \(Test Log\)/);
    assert.match(html, /RP-T1/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'Inhalte werden maskiert');
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /<img src="\/api\/attachments\/[0-9a-f-]+\/content" alt="screenshot\.png"/, 'Bild im Befund aufgelöst');
    assert.match(html, /RP-99/);
  });

  it('Markdown und JSON', async () => {
    const md = await (await raw(`/api/reports/test-log/${cycleId}?format=md`)).text();
    assert.match(md, /^# Testprotokoll – RP Reports/m);
    const json = await (await raw(`/api/reports/test-log/${cycleId}?format=json`)).json();
    assert.equal(json.kind, 'test-log');
    assert.equal(json.summary.total, 2);
    assert.equal(json.summary.failed, 1);
  });

  it('Abschlussbericht bewertet regelbasiert; Profil mit Schritten zeigt Schritte', async () => {
    const json = await (await raw(`/api/reports/completion/${planId}?format=json`)).json();
    assert.equal(json.assessment.recommendation, 'not-recommended');
    assert.equal(json.current.testCases, 2);
    assert.deepEqual(json.defects.map((d: any) => d.key), ['RP-99']);
    const profiles = (await env.call('GET', '/api/report-profiles')).body;
    const detailed = profiles.find((p: any) => p.options.sections.steps);
    const html = await (await raw(`/api/reports/test-log/${cycleId}?profile=${detailed.id}`)).text();
    assert.match(html, /Druckdialog öffnen <img src="\/api\/attachments\/[0-9a-f-]+\/content" alt="dialog\.png"/, 'Bild aus Testfallanhang im Schritt');
    assert.match(html, /kein PDF/);
  });

  it('Release-Cockpit zeigt Verlauf, Probleme und geänderte, nicht erneut getestete Testfälle', async () => {
    const tc = (await env.call('GET', '/api/test-cases/RP-T1')).body;
    await env.call('PUT', '/api/test-cases/RP-T1/content', { content: { ...tc.version, title: 'Akte drucken (neu)' }, changeNote: 'Druckdialog geändert' });
    const c = (await env.call('GET', `/api/plans/${planId}/cockpit`)).body;
    assert.equal(c.assessment.recommendation, 'not-recommended');
    assert.equal(c.burn.length, 1);
    assert.equal(c.burn[0].failed, 1);
    assert.deepEqual(c.changedNotTested.map((x: any) => [x.key, x.testedVersion, x.currentVersion, x.changeNote]), [['RP-T1', 1, 2, 'Druckdialog geändert']]);
    assert.equal(c.problems[0].key, 'RP-T1');
    assert.equal(c.openDefects.length, 1);
  });

  it('Testfallspezifikation', async () => {
    const html = await (await raw('/api/reports/specification/RP')).text();
    assert.match(html, /<h1>Testfallspezifikation<\/h1>/);
    assert.match(html, /Druck <strong>prüfen<\/strong>/);
    assert.match(html, /Akte schließen/);
  });

  it('Lieferpaket: vollständig, Prüfsummen stimmen, Signatur gültig', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyFile = join(await mkdtemp(join(tmpdir(), 'anemo-key-')), 'key.pem');
    await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    process.env.ANEMO_SIGNING_KEY_FILE = keyFile;
    try {
      const res = await raw(`/api/reports/package/${planId}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition')!, /Lieferpaket-RP-8\.0-/);
      const files = unzip(Buffer.from(await res.arrayBuffer()));
      const names = [...files.keys()];
      for (const n of ['Testabschlussbericht.html', 'Testabschlussbericht.md', 'ergebnisse.json', 'manifest.json', 'SHA256SUMS', 'SHA256SUMS.sig', 'LIESMICH.txt']) {
        assert.ok(names.includes(n), `${n} fehlt`);
      }
      assert.ok(names.some((n) => n.startsWith('Testprotokolle/01-Regression-ORA')));
      assert.equal(names.filter((n) => n.startsWith('evidenzen/')).length, 1, 'genau die verwendete Evidenz');
      const sums = files.get('SHA256SUMS')!.toString();
      for (const line of sums.trim().split('\n')) {
        const [hash, path] = line.split('  ');
        assert.equal(createHash('sha256').update(files.get(path!)!).digest('hex'), hash, `Prüfsumme ${path}`);
      }
      assert.ok(verify(null, files.get('SHA256SUMS')!, publicKey, files.get('SHA256SUMS.sig')!), 'Signatur gültig');
      const log = files.get(names.find((n) => n.startsWith('Testprotokolle/'))!)!.toString();
      assert.match(log, /src="\.\.\/evidenzen\//, 'relative Bildpfade im Paket');
    } finally {
      delete process.env.ANEMO_SIGNING_KEY_FILE;
    }
  });
});
