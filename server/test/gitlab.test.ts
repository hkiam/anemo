import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { fromFeatureFile, toFeatureFile } from '../src/modules/integrations/gitlab.ts';
import { refreshGitlabReferences } from '../src/modules/integrations/index.ts';
import { type TestEnv, testEnv } from './helpers.ts';

const GHERKIN = '# language: de\nFunktionalität: Akte archivieren\n  Szenario: Archivieren\n    Angenommen eine offene Akte\n    Wenn ich archiviere\n    Dann ist sie archiviert';

describe('Feature-Dateien', () => {
  it('setzt das Testfall-Tag vor die Funktionalität und entfernt es beim Lesen', () => {
    const f = toFeatureFile('GL-T1', 3, GHERKIN);
    assert.match(f, /# language: de\n@GL-T1\nFunktionalität: Akte archivieren/);
    assert.deepEqual(fromFeatureFile(f), { key: 'GL-T1', gherkin: GHERKIN });
    const tagged = toFeatureFile('GL-T2', 1, '@smoke\nFeature: X\n  Scenario: Y\n    Given a');
    assert.match(tagged, /^@smoke @GL-T2\nFeature: X/);
    assert.equal(fromFeatureFile(tagged).gherkin, '@smoke\nFeature: X\n  Scenario: Y\n    Given a');
  });
});

describe('GitLab-Abgleich (B4)', () => {
  let env: TestEnv;
  let mock: ReturnType<typeof serve>;
  const repo = new Map<string, string>();
  const commits: { message: string; actions: number }[] = [];
  let mrState = 'opened';
  before(async () => {
    env = await testEnv();
    const gl = new Hono();
    const P = '/api/v4/projects/:p';
    gl.get('/api/v4/user', (c) => c.json({ username: 'anemo-bot' }));
    gl.get(`${P}/repository/tree`, (c) => {
      const path = c.req.query('path')!;
      const items = [...repo.keys()].filter((k) => k.startsWith(`${path}/`)).map((k) => ({ path: k, type: 'blob' }));
      return items.length ? c.json(items) : c.json({ message: '404 Tree Not Found' }, 404);
    });
    gl.get(`${P}/repository/files/:file/raw`, (c) => {
      const f = decodeURIComponent(c.req.param('file'));
      return repo.has(f) ? c.text(repo.get(f)!) : c.json({ message: 'nf' }, 404);
    });
    gl.post(`${P}/repository/commits`, async (c) => {
      assert.equal(decodeURIComponent(c.req.param('p')), 'qa/akte');
      const b = await c.req.json();
      for (const a of b.actions) repo.set(a.file_path, a.content);
      commits.push({ message: b.commit_message, actions: b.actions.length });
      return c.json({ id: `sha${commits.length}`, short_id: `sha${commits.length}`, web_url: 'https://gitlab.test/c' }, 201);
    });
    gl.get(`${P}/repository/commits`, (c) => c.json([{ id: `abcdef${commits.length}` }]));
    gl.get(`${P}/repository/commits/:sha`, (c) => c.json({ id: c.req.param('sha'), short_id: c.req.param('sha').slice(0, 8), title: 'Fix Archivierung', web_url: 'https://gitlab.test/commit' }));
    gl.get(`${P}/merge_requests`, (c) => c.json([{ iid: 42, title: `Archivierung ${c.req.query('search')}`, state: mrState, web_url: 'https://gitlab.test/mr/42', source_branch: 'f' }]));
    gl.get(`${P}/merge_requests/:iid`, (c) => c.json({ iid: 42, title: 'Archivierung reparieren', state: mrState, web_url: 'https://gitlab.test/mr/42' }));
    await new Promise<void>((r) => { mock = serve({ fetch: gl.fetch, port: 0 }, (i) => { process.env.GITLAB_URL = `http://127.0.0.1:${i.port}`; r(); }); });
    process.env.GITLAB_TOKEN = 'glpat-test';
    await env.call('POST', '/api/projects', { key: 'GL', name: 'GitLab' });
    await env.call('POST', '/api/projects/GL/test-cases', { content: { title: 'Akte archivieren', format: 'GHERKIN', gherkin: GHERKIN } });
    await env.call('POST', '/api/projects/GL/test-cases', { content: { title: 'Klassisch', steps: [{ action: 'a', expected: 'b' }] } });
    await env.call('PUT', '/api/projects/GL/integrations/gitlab', { externalProject: 'qa/akte', settings: { branch: 'main', folder: 'features' } });
  });
  after(async () => {
    mock.close();
    delete process.env.GITLAB_URL;
    delete process.env.GITLAB_TOKEN;
    await env.close();
  });

  it('exportiert Gherkin-Testfälle als ein Commit, dann ist alles gleich', async () => {
    assert.equal((await env.call('GET', '/api/projects/GL/gitlab/compare')).body.entries[0].status, 'onlyInAnemo');
    const r = await env.call('POST', '/api/projects/GL/gitlab/export');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.created, r.body.updated], [1, 0]);
    assert.deepEqual([...repo.keys()], ['features/GL-T1-akte-archivieren.feature']);
    assert.match(commits[0]!.message, /^Anemo: 1 Gherkin/);
    const cmp = (await env.call('GET', '/api/projects/GL/gitlab/compare')).body.entries;
    assert.deepEqual(cmp.map((e: any) => [e.key, e.status]), [['GL-T1', 'same']]);
    assert.equal((await env.call('POST', '/api/projects/GL/gitlab/export')).body.created, 0, 'nichts zu tun');
  });

  it('erkennt Änderungen in Git und übernimmt sie als neue Version; Export überschreibt sie nicht', async () => {
    const path = 'features/GL-T1-akte-archivieren.feature';
    repo.set(path, repo.get(path)!.replace('Dann ist sie archiviert', 'Dann ist sie archiviert\n    Und das Archiv enthält sie'));
    repo.set('features/neu.feature', 'Feature: Neue Funktion\n  Scenario: S\n    Given x');
    let cmp = (await env.call('GET', '/api/projects/GL/gitlab/compare')).body.entries;
    assert.deepEqual(cmp.map((e: any) => e.status).sort(), ['changedInGit', 'onlyInGit']);
    const exp = (await env.call('POST', '/api/projects/GL/gitlab/export')).body;
    assert.deepEqual(exp.skippedChangedInGit, ['GL-T1'], 'Git-Änderung wird nicht überschrieben');
    const imp = await env.call('POST', '/api/projects/GL/gitlab/import', { paths: [path, 'features/neu.feature'] });
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    assert.deepEqual(imp.body.results.map((r: any) => r.action), ['version', 'created']);
    const tc = (await env.call('GET', '/api/test-cases/GL-T1')).body;
    assert.equal(tc.currentVersion, 2);
    assert.match(tc.version.gherkin, /Und das Archiv enthält sie/);
    const versions = (await env.call('GET', '/api/test-cases/GL-T1/versions')).body;
    assert.match(versions.at(-1).changeNote ?? versions[0].changeNote, /Aus Git übernommen/);
    cmp = (await env.call('GET', '/api/projects/GL/gitlab/compare')).body.entries;
    assert.ok(cmp.filter((e: any) => e.key === 'GL-T1').every((e: any) => e.status === 'same'));
    // Änderung in Anemo → wird beim Export geschrieben
    await env.call('PUT', '/api/test-cases/GL-T1/content', { content: { ...tc.version, gherkin: `${tc.version.gherkin}\n    Und eine Notiz entsteht` } });
    cmp = (await env.call('GET', '/api/projects/GL/gitlab/compare')).body.entries;
    assert.equal(cmp.find((e: any) => e.key === 'GL-T1').status, 'changedInAnemo');
    const exp2 = (await env.call('POST', '/api/projects/GL/gitlab/export')).body;
    assert.ok(exp2.updated >= 1);
    assert.match(repo.get(path)!, /Und eine Notiz entsteht/);
    assert.equal((await env.call('POST', '/api/projects/GL/gitlab/import', { paths: ['../geheim.feature'] })).status, 400);
  });

  it('stellt klassische Testfälle beim Import nicht stillschweigend auf Gherkin um', async () => {
    repo.set('features/GL-T2-klassisch.feature', '@GL-T2\nFeature: Klassisch\n  Scenario: S\n    Given x');
    const imp = await env.call('POST', '/api/projects/GL/gitlab/import', { paths: ['features/GL-T2-klassisch.feature'] });
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    assert.equal(imp.body.results[0].action, 'skipped');
    assert.match(imp.body.results[0].reason, /kein Gherkin-Testfall/);
    const tc = (await env.call('GET', '/api/test-cases/GL-T2')).body;
    assert.deepEqual([tc.currentVersion, tc.version.format], [1, 'CLASSIC']);
  });

  it('sucht Merge-Requests/Commits und gleicht den MR-Status ab', async () => {
    const found = (await env.call('GET', '/api/projects/GL/gitlab/search?q=abcdef12')).body;
    assert.deepEqual(found.map((f: any) => f.type), ['Commit', 'Merge-Request']);
    const tc = (await env.call('GET', '/api/test-cases/GL-T1')).body;
    await env.call('POST', '/api/references', { ownerType: 'TEST_CASE', ownerId: tc.id, provider: 'gitlab', externalKey: 'qa/akte!42', relation: 'RELATED', status: 'opened' });
    mrState = 'merged';
    const r = await refreshGitlabReferences(env.db);
    assert.equal(r!.updated, 1);
    const ref = (await env.call('GET', `/api/references/by-key/gitlab/${encodeURIComponent('qa/akte!42')}`)).body[0];
    assert.deepEqual([ref.status, ref.title], ['merged', 'Archivierung reparieren']);
  });
});
