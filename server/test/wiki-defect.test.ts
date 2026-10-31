import assert from 'node:assert/strict';
import { it } from 'node:test';
import { wikiToHtml } from '../../shared/wiki/html.ts';
import { wikiSummary, wikiToText } from '../../shared/wiki/text.ts';
import { wikiToMarkdown } from '../src/modules/integrations/index.ts';
import { testEnv } from './helpers.ts';

it('Strichfolgen bleiben Text, Durchstreichen funktioniert weiter', () => {
  assert.equal(wikiToHtml('{color:#b3c3d3}------>{color}'), '<p><span style="color:#b3c3d3">------&gt;</span></p>');
  assert.equal(wikiToHtml('{color:#b3c3d3}<------{color}'), '<p><span style="color:#b3c3d3">&lt;------</span></p>');
  assert.equal(wikiToHtml('x -nicht mehr gültig- y'), '<p>x <s>nicht mehr gültig</s> y</p>');
  assert.equal(wikiToMarkdown('a ------> b'), 'a ------&gt; b');
});

it('Reintext und Kurztext ohne Markup; reine Zeichenfolgen zählen nicht', () => {
  assert.equal(wikiToText('h6. Verfügbarkeit\n\n{color:#1f2764}  {color}'), 'Verfügbarkeit');
  assert.equal(wikiSummary('{color:#b3c3d3}------>{color}'), '');
  assert.equal(wikiSummary('*Dienst* {color:red}aufrufen{color}'), 'Dienst aufrufen');
});

it('Markdown für OpenProject: Panels, Code, Tabellen, Farben entfallen, Strukturzeichen maskiert', () => {
  const md = wikiToMarkdown('{panel:title=Hinweis}Text{panel}\n{noformat}a*b{noformat}\n||A||B||\n|1|2|\n{color:red}rot{color}\n- kein Spiegelstrich am Satzanfang?');
  assert.match(md, /^> \*\*Hinweis\*\*$/m);
  assert.match(md, /```\na\*b\n```/);
  assert.match(md, /^\| A \| B \|$/m);
  assert.match(md, /^rot$/m);
});

it('Fehlerentwurf: Titel als reiner Text, Pfeil-Schritt → Testfall-Titel, Schrittliste ohne Blockmarken', async () => {
  const env = await testEnv();
  await env.call('POST', '/api/projects', { key: 'FD', name: 'f' });
  await env.call('POST', '/api/projects/FD/test-cases', { content: { title: 'Verfügbarkeit des Dienstes prüfen', steps: [
    { action: '{color:#b3c3d3}-------------------------------------->{color}', data: 'h6. Verfügbarkeit\n\n{color:#1f2764}  {color}', expected: '{color:#b3c3d3}<--------------------------------------{color}' },
    { action: '*Dienst* aufrufen', expected: 'Antwort {color:red}200{color}' }] } });
  const c = (await env.call('POST', '/api/projects/FD/cycles', { name: 'Z' })).body;
  await env.call('POST', `/api/cycles/${c.id}/executions`, { testCaseIds: ['FD-T1'] });
  const ex = (await env.call('GET', `/api/cycles/${c.id}/executions`)).body.items[0];
  const steps = (await env.call('GET', `/api/executions/${ex.id}`)).body.steps;
  await env.call('POST', `/api/executions/${ex.id}/result`, { status: 'FAIL', comment: 'Dienst nicht erreichbar',
    stepResults: [{ stepId: steps[0].id, status: 'FAIL', comment: '{color:red}*Timeout*{color} nach 30 s' }, { stepId: steps[1].id, status: 'NOT_EXECUTED' }] });
  const d = (await env.call('POST', `/api/executions/${ex.id}/defect-draft`, {})).body;
  assert.equal(d.title, '[FD-T1] Verfügbarkeit des Dienstes prüfen – Timeout nach 30 s');
  assert.doesNotMatch(d.body, /h6\./);
  assert.match(d.body, /\\\\_Erwartet:_/, 'Jira-Zeilenumbruch vor „Erwartet“');
  const md = wikiToMarkdown(d.body);
  assert.doesNotMatch(md, /color|\{|~~/);
  await env.close();
});
