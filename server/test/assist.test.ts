import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { normalizeFinding, setLlmFetch } from '../src/modules/assist/index.ts';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Assistenz (D4)', () => {
  let env: TestEnv;
  const prompts: { url: string; body: any }[] = [];
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'AS', name: 'Assist' });
    const mk = (title: string, steps: [string, string][]) => env.call('POST', '/api/projects/AS/test-cases', { content: { title, steps: steps.map(([action, expected]) => ({ action, expected })) } });
    await mk('Akte anlegen über Dialog', [['Neue Akte über das Menü Datei anlegen', 'Dialog Akte anlegen erscheint'], ['Pflichtfelder ausfüllen und speichern', 'Akte ist angelegt']]);
    await mk('Akte anlegen über den Dialog', [['Neue Akte über das Menü Datei anlegen', 'Dialog Akte anlegen erscheint'], ['Pflichtfelder ausfüllen und speichern', 'Akte ist angelegt und sichtbar']]);
    await mk('Drucken eines Dokuments', [['Dokument öffnen', 'Dokument sichtbar'], ['Drucken wählen', 'PDF entsteht']]);
    // fehlgeschlagene Ausführungen mit ähnlichen Befunden (Umgebungsangaben variieren)
    const c = (await env.call('POST', '/api/projects/AS/cycles', { name: 'Regression' })).body.id;
    await env.call('POST', `/api/cycles/${c}/executions`, { testCaseIds: ['AS-T1', 'AS-T2', 'AS-T3'] });
    const items = (await env.call('GET', `/api/cycles/${c}/executions`)).body.items;
    const findings = ['Getestet auf SRV-01 Windows 11: OCR-Erkennung Transym liefert leere Seite bei Scan 123', 'SRV-02 Windows 10: OCR-Erkennung Transym liefert leere Seite (Scan 987)', 'Drucker meldet Papierstau am Gerät 4711'];
    for (const [i, e] of items.entries()) await env.call('POST', `/api/executions/${e.id}/result`, { status: 'FAIL', comment: findings[i] });
    await env.call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: items[0].testCaseId ?? (await env.call('GET', '/api/test-cases/AS-T1')).body.id, provider: 'jira', externalKey: 'REQ-1', relation: 'REQUIREMENT', title: 'Akten anlegen' });
    setLlmFetch(async (url, init) => {
      prompts.push({ url: String(url), body: JSON.parse(String(init!.body)) });
      const draft = { title: 'Akte archivieren', objective: 'Archivierung prüfen', preconditions: 'Annahme: Akte ist abgeschlossen', steps: [{ action: 'Akte öffnen', data: '', expected: 'Akte sichtbar' }, { action: 'Archivieren wählen', data: '', expected: 'Status „archiviert“' }], gherkin: '# language: de\nFunktionalität: Archiv' };
      return new Response(JSON.stringify({ choices: [{ message: { content: `Hier der Entwurf:\n\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`` } }] }), { status: 200 });
    });
  });
  after(async () => {
    setLlmFetch(null);
    for (const k of ['AI_MODEL', 'AI_BASE_URL', 'AI_ON_PREM']) delete process.env[k];
    await env.close();
  });

  it('normalisiert Befunde (Zahlen, Kennungen, Pfade)', () => {
    assert.equal(normalizeFinding('Fehler 4711 in C:\\temp\\a.log am 3.2.2024 (DEMO-123)'), 'fehler # in <pfad> am <datum> ( <ticket> )');
  });

  it('findet ähnliche Testfälle', async () => {
    const r = (await env.call('GET', '/api/projects/AS/assist/similar?min=0.6')).body;
    assert.deepEqual(r.map((p: any) => [p.a, p.b]), [['AS-T1', 'AS-T2']]);
    assert.ok(r[0].score >= 0.8);
  });

  it('gruppiert ähnliche Befunde trotz unterschiedlicher Umgebung', async () => {
    const r = (await env.call('GET', '/api/projects/AS/assist/clusters?days=30')).body;
    assert.equal(r.length, 1);
    assert.deepEqual(r[0].testCases.sort(), ['AS-T1', 'AS-T2']);
    assert.match(r[0].label, /transym|erkennung|leere/);
  });

  it('Anforderungsabdeckung mit letztem Ergebnis', async () => {
    const r = (await env.call('GET', '/api/projects/AS/assist/coverage')).body;
    assert.deepEqual(r.map((x: any) => [x.key, x.state, x.tests]), [['REQ-1', 'failing', ['AS-T1']]]);
  });

  it('Entwurf aus Anforderung nur mit eingerichtetem Modell; Sperre externer Dienste beachtet', async () => {
    const req = { requirement: 'Abgeschlossene Akten müssen archiviert werden können; archivierte Akten sind schreibgeschützt.' };
    assert.equal((await env.call('POST', '/api/projects/AS/assist/draft', req)).status, 409);
    Object.assign(process.env, { AI_MODEL: 'qwen2.5:14b', AI_BASE_URL: 'http://ollama.test/v1' });
    const d = await env.call('POST', '/api/projects/AS/assist/draft', req);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.title, 'Akte archivieren');
    assert.equal(d.body.steps.length, 2);
    assert.equal(prompts[0]!.url, 'http://ollama.test/v1/chat/completions');
    assert.match(prompts[0]!.body.messages[1].content, /archiviert werden können/);
    await env.call('PUT', '/api/projects/AS/external-services', { externalServices: 'blocked' });
    assert.equal((await env.call('POST', '/api/projects/AS/assist/draft', req)).status, 409, 'externes Modell gesperrt');
    process.env.AI_ON_PREM = 'true';
    assert.equal((await env.call('POST', '/api/projects/AS/assist/draft', req)).status, 200, 'on-prem-Modell erlaubt');
  });
});
