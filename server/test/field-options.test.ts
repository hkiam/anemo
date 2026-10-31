import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { jiraValues, openProjectValues } from '../src/modules/integrations/options.ts';

/** Simulierte Quellsysteme – geprüft wird, welche Endpunkte gelesen und wie Werte übernommen werden. */
const fake = (routes: Record<string, unknown>) => (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  const hit = Object.entries(routes).find(([k]) => u.endsWith(k));
  if (!hit) return new Response('nicht gefunden', { status: 404 });
  return new Response(JSON.stringify(hit[1]), { status: 200, headers: { 'x-method': init?.method ?? 'GET' } });
}) as typeof fetch;

describe('Auswahlwerte aus Jira und OpenProject', () => {
  const jira = { baseUrl: 'https://jira.example', authorization: 'Basic eDp5' };
  const op = { url: 'https://op.example', apiKey: 'k' };
  it('Jira: Versionen ohne archivierte, Komponenten, Auswahlfeld über createmeta', async () => {
    const http = fake({
      '/rest/api/2/project/QA/versions': [{ name: '7.4' }, { name: '7.3', archived: true }, { name: '7.5' }],
      '/rest/api/2/project/QA/components': [{ name: 'Druck' }, { name: 'Export' }],
      'createmeta?projectKeys=QA&expand=projects.issuetypes.fields': { projects: [{ issuetypes: [
        { fields: { customfield_10100: { allowedValues: [{ value: 'Team A' }, { value: 'Team B', disabled: true }] } } },
        { fields: { customfield_10100: { allowedValues: [{ value: 'Team A' }, { value: 'Team C' }] } } },
      ] }] },
    });
    assert.deepEqual(await jiraValues(jira, { provider: 'jira', project: 'QA', kind: 'versions' }, http), ['7.4', '7.5']);
    assert.deepEqual(await jiraValues(jira, { provider: 'jira', project: 'QA', kind: 'components' }, http), ['Druck', 'Export']);
    assert.deepEqual(await jiraValues(jira, { provider: 'jira', project: 'QA', kind: 'customfield', fieldId: '10100' }, http), ['Team A', 'Team C']);
  });
  it('OpenProject: Versionen ohne geschlossene, Kategorien, benutzerdefiniertes Feld aus dem Formular-Schema', async () => {
    const http = fake({
      '/api/v3/projects/qa-projekt/versions': { _embedded: { elements: [{ name: 'R1', status: 'open' }, { name: 'R0', status: 'closed' }] } },
      '/api/v3/projects/qa-projekt/categories': { _embedded: { elements: [{ name: 'Backend' }, { name: 'Frontend' }] } },
      '/api/v3/projects/qa-projekt/work_packages/form': { _embedded: { schema: { customField7: { _embedded: { allowedValues: [{ value: 'hoch' }, { value: 'niedrig' }] } } } } },
    });
    assert.deepEqual(await openProjectValues(op, { provider: 'openproject', project: 'qa-projekt', kind: 'versions' }, http), ['R1']);
    assert.deepEqual(await openProjectValues(op, { provider: 'openproject', project: 'qa-projekt', kind: 'categories' }, http), ['Backend', 'Frontend']);
    assert.deepEqual(await openProjectValues(op, { provider: 'openproject', project: 'qa-projekt', kind: 'customfield', fieldId: '7' }, http), ['hoch', 'niedrig']);
    await assert.rejects(openProjectValues(op, { provider: 'openproject', project: 'gibtsnicht', kind: 'versions' }, http), /404/);
  });
});
