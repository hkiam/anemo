import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Auslieferung der Oberfläche nach einem Update', () => {
  let env: TestEnv;
  before(async () => {
    const dist = await mkdtemp(join(tmpdir(), 'anemo-web-'));
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>Anemo</title><script type="module" src="/assets/index-neu.js"></script>');
    await mkdir(join(dist, 'assets'));
    await writeFile(join(dist, 'assets', 'index-neu.js'), 'console.log(1)');
    env = await testEnv({ authMode: 'on', webDist: dist });
  });
  after(() => env.close());

  it('index.html wird immer neu geprüft, Bausteine mit Hash sind unveränderlich', async () => {
    for (const p of ['/', '/index.html', '/projekte/DEMO']) {
      const res = await env.app.request(p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get('cache-control'), 'no-cache', p);
    }
    const js = await env.app.request('/assets/index-neu.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('cache-control') ?? '', /immutable/);
  });

  it('ein nicht mehr vorhandener Baustein (alte index.html im Browser) liefert 404 statt index.html', async () => {
    const res = await env.app.request('/assets/index-alt.js');
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /<title>/);
    assert.equal(res.headers.get('cache-control'), null);
  });

  it('API-Antworten bekommen keine Zwischenspeicher-Angabe der Oberfläche', async () => {
    const res = await env.app.request('/api/auth/providers');
    assert.notEqual(res.headers.get('cache-control'), 'no-cache');
  });
});
