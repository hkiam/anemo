import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setLlmFetch } from '../src/modules/assist/index.ts';
import { type TestEnv, testEnv } from './helpers.ts';

/** Reasoning-Modelle (z. B. Qwen3, DeepSeek-R1): die Denkphase zählt zur Längengrenze, die Antwort kann abgeschnitten sein. */
describe('KI-Antworten: abgeschnitten, kaputt, Zeitüberschreitung', () => {
  let env: TestEnv;
  let reply: (body: any) => Response | Promise<Response>;
  const seen: number[] = [];
  const review = () => env.call('POST', '/api/projects/TR/assist/review', { title: 'Anmeldung', steps: [{ action: 'Anmelden', expected: 'funktioniert' }] });
  const ok = JSON.stringify({ findings: [{ severity: 'hoch', step: 1, problem: 'Erwartung nicht prüfbar', suggestion: 'konkret formulieren' }] });
  const answer = (content: string, finish = 'stop') => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), { status: 200 });

  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'TR', name: 'Abgeschnitten' });
    Object.assign(process.env, { AI_MODEL: 'reasoner', AI_BASE_URL: 'http://llm.example.org/v1' });
    setLlmFetch(async (_url, init) => { const body = JSON.parse(String(init!.body)); seen.push(body.max_tokens); return reply(body); });
  });
  after(async () => {
    setLlmFetch(null);
    for (const k of ['AI_MODEL', 'AI_BASE_URL']) delete process.env[k];
    await env.close();
  });

  it('an der Längengrenze abgeschnitten → einmal mit mehr Spielraum wiederholen', async () => {
    seen.length = 0;
    reply = (b) => (b.max_tokens < 4000 ? answer(ok.slice(0, 40), 'length') : answer(ok));
    const r = await review();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.findings.length, 1);
    assert.deepEqual(seen, [1500, 4500]);
  });

  it('auch beim zweiten Versuch abgeschnitten → 502 mit Erklärung statt „Interner Fehler“', async () => {
    reply = () => answer(ok.slice(0, 40), 'length');
    const r = await review();
    assert.equal(r.status, 502);
    assert.match(r.body.detail, /abgeschnitten/);
  });

  it('kein gültiges JSON bzw. leere Antwort → 502 mit Erklärung', async () => {
    reply = () => answer('Ich habe folgende Anmerkungen: {"findings": [');
    assert.match((await review()).body.detail, /nicht das erwartete Format/);
    reply = () => answer('');
    const r = await review();
    assert.equal(r.status, 502);
    assert.match(r.body.detail, /leere Antwort/);
  });

  it('gerade Anführungszeichen und Zeilenumbrüche in Texten → repariert statt Fehler; Prompt bittet um „…“', async () => {
    let system = '';
    reply = (b) => { system = b.messages[0].content; return answer('{"findings": [{"severity": "hoch", "step": 2, "problem": "Das Feld "Name" ist\nnicht "eindeutig"", "suggestion": "Erwartung "Seite wird angezeigt" konkretisieren",},]}'); };
    const r = await review();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.findings[0].problem, 'Das Feld "Name" ist\nnicht "eindeutig"');
    assert.equal(r.body.findings[0].suggestion, 'Erwartung "Seite wird angezeigt" konkretisieren');
    assert.match(system, /keine geraden Anführungszeichen/);
  });

  it('Zeitgrenze ist einstellbar (AI_TIMEOUT_SECONDS) und gilt für jede Anfrage', async () => {
    process.env.AI_TIMEOUT_SECONDS = '300';
    let signal: AbortSignal | undefined;
    setLlmFetch(async (_url, init) => { signal = init!.signal as AbortSignal; return answer(ok); });
    assert.equal((await review()).status, 200);
    assert.ok(signal && !signal.aborted);
    reply = () => { throw new DOMException('timeout', 'TimeoutError'); };
    setLlmFetch(async (_url, init) => reply(JSON.parse(String(init!.body))));
    assert.match((await review()).body.detail, /nicht innerhalb von 300 s/);
    delete process.env.AI_TIMEOUT_SECONDS;
  });

  it('Modell antwortet nicht bzw. mit Fehler → 502 mit Erklärung', async () => {
    reply = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
    const r = await review();
    assert.equal(r.status, 502);
    assert.match(r.body.detail, /nicht innerhalb von 120 s/);
    reply = () => new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 });
    assert.match((await review()).body.detail, /KI-Modell nicht nutzbar: KI-Modell: model not found/);
  });
});

describe('JSON-Reparatur', async () => {
  const { parseJson, repairJson, timeoutMs } = await import('../src/modules/assist/llm.ts');
  it('lässt gültiges JSON unverändert und repariert typische Fehler', () => {
    const ok = '{"a": "x \\"y\\"", "b": [1, 2], "c": {"d": null}}';
    assert.equal(repairJson(ok), ok);
    assert.deepEqual(parseJson('{"t": "Knopf "OK" klicken", "n": 1}'), { t: 'Knopf "OK" klicken', n: 1 });
    assert.deepEqual(parseJson('```json\n{"t": "Meldung "Gespeichert, fertig" erscheint"}\n```'), { t: 'Meldung "Gespeichert, fertig" erscheint' });
    assert.deepEqual(parseJson('{"l": ["a", "b",], "t": "Zeile 1\nZeile 2"}'), { l: ['a', 'b'], t: 'Zeile 1\nZeile 2' });
    assert.deepEqual(parseJson('{"t": "endet mit "Zitat""}'), { t: 'endet mit "Zitat"' });
  });
  it('Zeitgrenze: Standard 120 s, begrenzt auf 10–900 s', () => {
    assert.deepEqual([timeoutMs(undefined), timeoutMs('abc'), timeoutMs('5'), timeoutMs('90'), timeoutMs('5000')], [120_000, 120_000, 10_000, 90_000, 900_000]);
  });
});
