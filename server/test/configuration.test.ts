import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { classify, compileRules, type ConfigDimension } from '../src/modules/execution/index.ts';
import { type TestEnv, testEnv } from './helpers.ts';

const dims: ConfigDimension[] = [
  { key: 'database', name: 'DB', description: null, sortOrder: 1, extractPattern: null, values: [
    { id: '1', dimensionKey: 'database', value: 'Oracle', description: null, sortOrder: 1, patterns: ['(^|[^a-z])(ora|oracle)([^a-z]|$)', 'oradb'] },
    { id: '2', dimensionKey: 'database', value: 'SQL Server', description: null, sortOrder: 2, patterns: ['sqlfs', '(^|[^a-z])sql([^a-z]|$)'] },
  ] },
  { key: 'client', name: 'Client', description: null, sortOrder: 2, extractPattern: null, values: [
    { id: '3', dimensionKey: 'client', value: 'Desktop', description: null, sortOrder: 1, patterns: ['desktop', '(^|[^a-z])dt([^a-z]|$)'] },
  ] },
  { key: 'system', name: 'System', description: null, sortOrder: 3, extractPattern: '(?:^|[^A-Za-z0-9])(SYS[_A-Z][A-Z0-9_]{2,})(?![a-z])', values: [] },
];

describe('Konfigurationserkennung (rein)', () => {
  const rules = compileRules(dims);
  it('erkennt mehrere Werte je Merkmal und belegt sie', () => {
    const r = classify(rules, 'DT - SQL+ORA | | 7.4.1');
    assert.deepEqual(r.configuration, { database: ['Oracle', 'SQL Server'], client: ['Desktop'] });
    assert.deepEqual(r.evidence.client, [{ value: 'Desktop', match: 'DT' }]);
  });
  it('extrahiert offene Werte (Testsystem) und erkennt Datenbank im Systemnamen', () => {
    const r = classify(rules, 'Regression | SYSORADBPS12005 | ');
    assert.deepEqual(r.configuration.system, ['SYSORADBPS12005']);
    assert.deepEqual(r.configuration.database, ['Oracle']);
  });
  it('keine Treffer in Wörtern (Sachbearbeiter, Oranienburg, Scanner)', () => {
    assert.deepEqual(classify(rules, 'Sachbearbeiter in Oranienburg nutzt Scanner').configuration, {});
  });
});

describe('Testkonfigurationen (API)', () => {
  let env: TestEnv;
  before(async () => {
    env = await testEnv();
    await env.call('POST', '/api/projects', { key: 'CF', name: 'Konfig' });
  });
  after(() => env.close());

  it('erkennt die Konfiguration beim Anlegen und filtert danach', async () => {
    const a = (await env.call('POST', '/api/projects/CF/cycles', { name: 'Regression Mobile', environment: 'SQLFS', build: '7.4' })).body;
    await env.call('POST', '/api/projects/CF/cycles', { name: 'Regression Administration', environment: 'ORADB' });
    const c = (await env.call('GET', `/api/cycles/${a.id}`)).body;
    assert.deepEqual(c.configuration.database, ['SQL Server']);
    assert.deepEqual(c.configuration.client, ['Mobil/App']);
    assert.equal(c.configurationSource, 'auto');
    const sql = (await env.call('GET', '/api/projects/CF/cycles?config=database:SQL%20Server')).body;
    assert.deepEqual(sql.items.map((x: any) => x.name), ['Regression Mobile']);
    const both = (await env.call('GET', '/api/projects/CF/cycles?config=database:Oracle,client:Administration')).body;
    assert.deepEqual(both.items.map((x: any) => x.name), ['Regression Administration']);
  });

  it('manuelle Konfiguration hat Vorrang und übersteht die Neuklassifizierung', async () => {
    const c = (await env.call('GET', '/api/projects/CF/cycles?q=Regression%20Mobile')).body.items[0];
    const set = await env.call('PUT', `/api/cycles/${c.id}/configuration`, { configuration: { database: ['Oracle'], os: ['Windows 11'] } });
    assert.equal(set.body.configurationSource, 'manual');
    await env.call('POST', '/api/configuration/reclassify', {});
    const after_ = (await env.call('GET', `/api/cycles/${c.id}`)).body;
    assert.deepEqual(after_.configuration, { database: ['Oracle'], os: ['Windows 11'] });
    // zurück auf automatisch
    const auto = (await env.call('PUT', `/api/cycles/${c.id}/configuration`, { configuration: null })).body;
    assert.equal(auto.configurationSource, 'auto');
    assert.deepEqual(auto.configuration.database, ['SQL Server']);
    assert.equal((await env.call('PUT', `/api/cycles/${c.id}/configuration`, { configuration: { gibtsnicht: ['x'] } })).status, 400);
  });

  it('Regeln bearbeiten, Neuklassifizierung, Auswertung je Wert, nicht erkannte Texte', async () => {
    const bad = await env.call('PUT', '/api/configuration/dimensions/database/values', { value: 'X', patterns: ['(unclosed'] });
    assert.equal(bad.status, 400);
    await env.call('PUT', '/api/configuration/dimensions/database/values', { value: 'PostgreSQL', patterns: ['postgres', 'pgdb'] });
    const pg = (await env.call('POST', '/api/projects/CF/cycles', { name: 'Smoke', environment: 'PGDB' })).body;
    assert.deepEqual((await env.call('GET', `/api/cycles/${pg.id}`)).body.configuration.database, ['PostgreSQL']);
    await env.call('POST', '/api/projects/CF/test-cases', { content: { title: 'T', steps: [{ action: 'a', expected: 'b' }] } });
    await env.call('POST', `/api/cycles/${pg.id}/executions`, { testCaseIds: ['CF-T1'] });
    const stats = (await env.call('GET', '/api/projects/CF/configuration-stats')).body;
    const pgStat = stats.find((s: any) => s.dimension === 'database' && s.value === 'PostgreSQL');
    assert.deepEqual([pgStat.cycles, pgStat.byStatus], [1, { NOT_EXECUTED: 1 }]);
    const un = (await env.call('GET', '/api/configuration/unclassified?dimension=client&project=CF')).body;
    assert.ok(un.some((u: any) => u.text === 'PGDB'));
    const dimsApi = (await env.call('GET', '/api/configuration/dimensions')).body;
    assert.ok(dimsApi.find((d: any) => d.key === 'system').extractPattern);
  });
});
