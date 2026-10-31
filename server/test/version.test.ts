import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { type TestEnv, testEnv } from './helpers.ts';

describe('Versionsangabe', () => {
  let env: TestEnv;
  before(async () => { env = await testEnv(); });
  after(() => env.close());
  it('Version aus package.json, Commit und Build aus der Umgebung; Systemangaben für die Administration', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    const v = (await env.call('GET', '/api/version')).body;
    assert.equal(v.version, pkg.version);
    assert.match(v.label, new RegExp(`^${pkg.version.replace(/\./g, '\\.')}`));
    const s = (await env.call('GET', '/api/admin/system')).body;
    assert.equal(s.version, pkg.version);
    assert.match(s.node, /^v\d+/);
    assert.match(s.migration, /^\d{3}_.+\.sql$/);
    assert.ok(s.postgres);
    assert.equal((await env.call('GET', '/api/openapi.json')).body.info.version, pkg.version);
  });
});
