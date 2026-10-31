import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setLlmFetch } from '../src/modules/assist/index.ts';
import { settingsEnv } from '../src/platform/settings.ts';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Einstellungen in der Oberfläche und KI-Administration', () => {
  let env: TestEnv;
  before(async () => {
    process.env.GITLAB_URL = 'https://gitlab.aus-der-umgebung.test';
    process.env.SMTP_PASSWORD = 'umgebungs-geheimnis';
    env = await testEnv();
  });
  after(async () => {
    delete process.env.GITLAB_URL;
    delete process.env.SMTP_PASSWORD;
    setLlmFetch(null);
    await env.close();
  });

  it('zeigt Herkunft (Umgebung/Standard) und verrät keine Geheimnisse', async () => {
    const r = (await env.call('GET', '/api/admin/settings')).body;
    const by = Object.fromEntries(r.settings.map((s: any) => [s.key, s]));
    assert.equal(by.GITLAB_URL.source, 'env');
    assert.equal(by.GITLAB_URL.value, 'https://gitlab.aus-der-umgebung.test');
    assert.equal(by.SMTP_PASSWORD.value, '••••••');
    assert.ok(!JSON.stringify(r).includes('umgebungs-geheimnis'));
    assert.equal(by.OIDC_SCOPES.source, 'default');
    assert.ok(r.groups.some((g: any) => g.id === 'ai'));
  });

  it('Oberfläche überschreibt die Umgebung, Zurücksetzen stellt sie wieder her, leer schaltet ab', async () => {
    await env.call('PUT', '/api/admin/settings', { changes: { GITLAB_URL: 'https://gitlab.ui.test', GITLAB_TOKEN: 'glpat-geheim' } });
    assert.equal(settingsEnv().GITLAB_URL, 'https://gitlab.ui.test');
    assert.equal(settingsEnv().GITLAB_TOKEN, 'glpat-geheim');
    const [row] = await env.db<{ value: string; secret: boolean }[]>`select value, secret from app_setting where key = 'GITLAB_TOKEN'`;
    assert.equal(row!.secret, true);
    assert.ok(!row!.value.includes('glpat'), 'Geheimnis verschlüsselt gespeichert');
    await env.call('PUT', '/api/admin/settings', { changes: { GITLAB_URL: null } });
    assert.equal(settingsEnv().GITLAB_URL, 'https://gitlab.aus-der-umgebung.test');
    await env.call('PUT', '/api/admin/settings', { changes: { GITLAB_URL: '' } });
    assert.equal(settingsEnv().GITLAB_URL, undefined);
    const log = (await env.call('GET', '/api/admin/settings')).body.log;
    assert.deepEqual(log.slice(0, 2).map((l: any) => [l.key, l.action]), [['GITLAB_URL', 'set'], ['GITLAB_URL', 'reset']]);
    await env.call('PUT', '/api/admin/settings', { changes: { GITLAB_URL: null, GITLAB_TOKEN: null } });
  });

  it('prüft Eingaben', async () => {
    assert.equal((await env.call('PUT', '/api/admin/settings', { changes: { DATABASE_URL: 'x' } })).status, 400);
    assert.equal((await env.call('PUT', '/api/admin/settings', { changes: { SMTP_PORT: 'abc' } })).status, 400);
    assert.equal((await env.call('PUT', '/api/admin/settings', { changes: { AI_BASE_URL: 'javascript:alert(1)' } })).status, 400);
  });

  it('KI: Hauptschalter, Verbindungstest, Nutzungsprotokoll, Kontingent, Prompts', async () => {
    let seenSystem = '';
    setLlmFetch((async (_url: string, init: RequestInit) => {
      seenSystem = JSON.parse(String(init.body)).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
    }) as typeof fetch);
    await env.call('PUT', '/api/admin/settings', { changes: { AI_BASE_URL: 'http://llm.intern:8000/v1', AI_MODEL: 'qwen-test', AI_ON_PREM: 'true' } });
    assert.deepEqual((await env.call('GET', '/api/assist/status')).body, { enabled: true, llm: { provider: 'openai', model: 'qwen-test', onPrem: true } });
    const t = (await env.call('POST', '/api/admin/ai/test')).body;
    assert.equal(t.ok, true, t.message);
    const admin = (await env.call('GET', '/api/admin/ai')).body;
    assert.equal(admin.usage[0].feature, 'admin-test');
    assert.ok(admin.features.some((f: any) => f.key === 'testcase-draft' && f.status === 'aktiv'));

    // Prompt anpassen wirkt auf die Funktion, Standard wiederherstellbar
    await env.call('POST', '/api/projects', { key: 'KI', name: 'KI' });
    await env.call('PUT', '/api/admin/ai/prompts/testcase-draft', { system: 'Eigener Prompt: erzeuge einen Testfall als JSON mit title und steps.' });
    setLlmFetch((async (_u: string, init: RequestInit) => {
      seenSystem = JSON.parse(String(init.body)).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"T","steps":[{"action":"a","expected":"e"}]}' } }] }), { status: 200 });
    }) as typeof fetch);
    const d = await env.call('POST', '/api/projects/KI/assist/draft', { requirement: 'Der Benutzer kann eine Akte als PDF exportieren.' });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.match(seenSystem, /^Eigener Prompt/);
    await env.call('PUT', '/api/admin/ai/prompts/testcase-draft', { system: null });
    assert.equal((await env.call('GET', '/api/admin/ai/prompts')).body.find((p: any) => p.key === 'testcase-draft').customized, false);

    // Kontingent
    await env.call('PUT', '/api/admin/settings', { changes: { AI_MAX_REQUESTS_PER_HOUR: '2' } });
    assert.equal((await env.call('POST', '/api/projects/KI/assist/draft', { requirement: 'Der Benutzer kann eine Akte als PDF exportieren.' })).status, 429);

    // Hauptschalter aus: keine Anfragen, Status meldet aus
    await env.call('PUT', '/api/admin/settings', { changes: { AI_ENABLED: 'false', AI_MAX_REQUESTS_PER_HOUR: null } });
    assert.deepEqual((await env.call('GET', '/api/assist/status')).body, { enabled: false, llm: null });
    const off = await env.call('POST', '/api/projects/KI/assist/draft', { requirement: 'Der Benutzer kann eine Akte als PDF exportieren.' });
    assert.equal(off.status, 409);
    assert.match(off.body.detail, /ausgeschaltet/);
  });

  it('KI: Reasoning-Modell on-prem (Qwen3 auf vLLM) – Zusatzparameter, Denkphase entfernt', async () => {
    assert.equal((await env.call('PUT', '/api/admin/settings', { changes: { AI_EXTRA_BODY: '{kaputt' } })).status, 400);
    assert.equal((await env.call('PUT', '/api/admin/settings', { changes: { AI_EXTRA_BODY: '[1]' } })).status, 400);
    // Modell, Nachrichten und Längengrenze legt Anemo fest – sonst liefe das Protokoll unter falschem Modellnamen (Review S8)
    assert.equal((await env.call('PUT', '/api/admin/settings', { changes: { AI_EXTRA_BODY: '{"model": "anderes"}' } })).status, 400);
    assert.equal((await env.call('PUT', '/api/admin/settings', { changes: { AI_EXTRA_BODY: '{"max_tokens": 99999}' } })).status, 400);
    const bodies: any[] = [];
    let answer = '<think>\nDer Nutzer will {"title": "falsch"} … ich antworte mit JSON.\n</think>\n\n{"title":"Akte exportieren","steps":[{"action":"Export wählen","expected":"PDF entsteht"}]}';
    setLlmFetch((async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), { status: 200 });
    }) as typeof fetch);
    await env.call('PUT', '/api/admin/settings', { changes: {
      AI_ENABLED: null, AI_BASE_URL: 'http://vllm.intern:8000/v1', AI_MODEL: 'Qwen/Qwen3-8B', AI_ON_PREM: 'true',
      AI_EXTRA_BODY: '{"chat_template_kwargs": {"enable_thinking": false}, "top_k": 20}',
    } });
    const d = await env.call('POST', '/api/projects/KI/assist/draft', { requirement: 'Der Benutzer kann eine Akte als PDF exportieren.' });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.title, 'Akte exportieren');
    assert.deepEqual(bodies.at(-1).chat_template_kwargs, { enable_thinking: false });
    assert.equal(bodies.at(-1).top_k, 20);
    assert.equal(bodies.at(-1).model, 'Qwen/Qwen3-8B');

    // Verbindungstest: Antwort nach der Denkphase; nur Denkphase (abgeschnitten) → verständlicher Hinweis
    answer = '<think>kurz</think>OK';
    assert.match((await env.call('POST', '/api/admin/ai/test')).body.message, /Antwort „OK“/);
    // Chat-Vorlage setzt <think> schon in den Prompt: Antwort beginnt mitten in der Denkphase (Review K9)
    answer = 'erst überlegen {"x": 1} …</think>OK';
    assert.match((await env.call('POST', '/api/admin/ai/test')).body.message, /Antwort „OK“/);
    answer = '<think>Ich überlege noch sehr lange';
    const t = (await env.call('POST', '/api/admin/ai/test')).body;
    assert.equal(t.ok, false);
    assert.match(t.message, /Denkphase/);

    // fehlerhafte Umgebung legt die Administration nicht lahm, Funktionen melden den Fehler
    await env.call('PUT', '/api/admin/settings', { changes: { AI_EXTRA_BODY: null } });
    process.env.AI_EXTRA_BODY = 'kein json';
    try {
      assert.match((await env.call('GET', '/api/admin/ai')).body.configError, /kein gültiges JSON/);
      const bad = await env.call('POST', '/api/projects/KI/assist/draft', { requirement: 'Der Benutzer kann eine Akte als PDF exportieren.' });
      assert.equal(bad.status, 409);
      assert.match(bad.body.detail, /KI-Einstellungen fehlerhaft/);
    } finally {
      delete process.env.AI_EXTRA_BODY;
    }
  });

  it('KI-Agenten lassen sich ausschalten', async () => {
    await env.call('PUT', '/api/admin/settings', { changes: { AGENTS_ENABLED: 'false' } });
    const r = await env.app.request('/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-anemo-user': 'robo' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(r.status, 403);
    await env.call('PUT', '/api/admin/settings', { changes: { AGENTS_ENABLED: null } });
  });
});
