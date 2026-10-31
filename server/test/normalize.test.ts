import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { normalizeCycle, normalizeExecution, normalizeStatus, normalizeTestIssue, parseZapiDate } from '../src/modules/migration/normalize.ts';
import { parseDescription } from '../src/modules/migration/wiki.ts';
import { FIXTURE } from './helpers.ts';

const load = async (p: string) => JSON.parse(await readFile(`${FIXTURE}/${p}`, 'utf8'));

describe('Wiki-Panels', () => {
  it('ordnet bekannte Panels zu und bewahrt den Rest als Abschnitte', () => {
    const d = parseDescription(
      '{panel:title=!x.png! *Allgemein* }\nZiel\n{panel}\n{panel:title=*Vorbedingungen*}\n- A\n{panel}\n' +
      '{panel:title=Technisches}\n \n{panel}\n{panel:title=*Automation*}\n|a|b|\n{panel}\nFreitext');
    assert.equal(d.objective, 'Ziel');
    assert.equal(d.preconditions, '- A');
    assert.deepEqual(d.emptyPanels, ['Technisches']);
    assert.deepEqual(d.sections, [{ title: 'Automation', content: '|a|b|' }, { title: 'Weitere Angaben', content: 'Freitext' }]);
  });

  it('vereinheitlicht Titelvarianten und führt gleichnamige Abschnitte zusammen', () => {
    const d = parseDescription('{panel:title=*Testfokus/ Testabgrenzung*}\nA\n{panel}{panel:title=Automation: Octarine}\nB\n{panel}{panel:title=Automation - Octarine}\nC\n{panel}');
    assert.deepEqual(d.sections, [{ title: 'Fokus / Abgrenzung', content: 'A' }, { title: 'Automation', content: 'B\n\nC' }]);
  });

  it('nutzt Beschreibung ohne Panels als Ziel', () => {
    assert.equal(parseDescription('Nur Text').objective, 'Nur Text');
  });
});

describe('Normalizer Jira-Test', () => {
  it('bildet DEMO-1 vollständig ab und meldet bewahrte Felder', async () => {
    const fields = new Map((await load('fields.json')).map((f: any) => [f.id, f]));
    const n = normalizeTestIssue(await load('issues/DEMO-1.json'), await load('teststeps/20001.json'), fields as any, 'http://jira');
    const v = n.value;
    assert.equal(v.legacyKey, 'DEMO-1');
    assert.equal(v.content.title, 'PDF in Akte ablegen');
    assert.match(v.content.preconditions!, /Schreibrechte/);
    assert.equal(v.content.steps!.length, 3);
    assert.equal(v.content.steps![0]!.id, 'zapi-301');
    assert.deepEqual(v.folderPath, ['Weboberfläche']);
    assert.ok(v.references.some((r) => r.externalKey === 'DEMO-100' && r.relation === 'DEFECT'));
    assert.ok(v.references.some((r) => r.externalKey === 'DEMO-50' && r.relation === 'STORY'));
    assert.ok(v.references.some((r) => r.externalKey === 'DEMO-10' && r.relation === 'EPIC'));
    assert.ok(v.references.some((r) => r.externalKey === 'DEMO-2001' && r.relation === 'SUBTASK'));
    const jira = v.content.customFields!.jira as any;
    assert.deepEqual(jira.sprints, [{ name: 'QS Sprint 7.3', state: 'CLOSED', id: '7' }]);
    assert.equal(v.content.customFields!.Testart, 'Regressionstest');
    assert.ok(n.preserved.includes('comment'));
    assert.ok(n.preserved.includes('customfield_10200 (Testart)'));
    assert.ok(n.ignored.includes('watches'));
    assert.ok(n.messages.some((m) => /Leere Vorlagen-Panels.*Technisches/.test(m)));
  });

  it('kein Feld verschwindet: jedes Feld ist abgebildet, bewahrt oder als inhaltslos gemeldet', async () => {
    const fields = new Map((await load('fields.json')).map((f: any) => [f.id, f]));
    for (const key of ['DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4', 'DEMO-5']) {
      const issue = await load(`issues/${key}.json`);
      const n = normalizeTestIssue(issue, [], fields as any, 'http://jira');
      const accounted = new Set([...n.preserved.map((p) => p.split(' ')[0]), ...n.ignored]);
      const structured = ['summary', 'description', 'status', 'priority', 'labels', 'components', 'assignee', 'reporter', 'creator',
        'created', 'issuetype', 'project', 'issuelinks', 'subtasks', 'attachment', 'versions', 'fixVersions', 'resolution',
        'resolutiondate', 'parent', 'comment', 'worklog', 'environment', 'duedate', 'security', 'customfield_10100', 'customfield_10101'];
      for (const f of Object.keys(issue.fields)) {
        assert.ok(structured.includes(f) || accounted.has(f), `${key}: Feld ${f} wurde weder abgebildet noch gemeldet`);
      }
    }
  });
});

describe('Normalizer ZAPI', () => {
  it('liest lokalisierte ZAPI-Daten', () => {
    assert.equal(parseZapiDate('05/Okt/26')?.getMonth(), 9);
    assert.equal(parseZapiDate('03/Sep/26 2:30 PM')?.getHours(), 14);
    assert.equal(parseZapiDate(1791100800000)?.getTime(), 1791100800000);
    assert.equal(parseZapiDate('Q4'), null);
  });

  it('ordnet eingedeutschte Systemstatus über die feste ID zu, nicht über den Namen', () => {
    assert.equal(normalizeStatus({ id: 1, name: 'BESTANDEN', type: 0 }).code, 'PASS');
    assert.equal(normalizeStatus({ id: -1, name: 'NICHT AUSGEFÜHRT', type: 0 }).code, 'NOT_EXECUTED');
    assert.equal(normalizeStatus({ id: 2, name: 'NICHT BESTANDEN', type: 0 }).custom, false);
    assert.deepEqual([normalizeStatus({ id: 5, name: 'BESTANDEN MIT MANGEL', type: 1 }).code, normalizeStatus({ id: 5, name: 'BESTANDEN MIT MANGEL', type: 1 }).custom], ['BESTANDEN_MIT_MANGEL', true]);
  });

  it('bildet Standard- und eigene Status ab', () => {
    assert.equal(normalizeStatus({ id: -1, name: 'UNEXECUTED' }).code, 'NOT_EXECUTED');
    const custom = normalizeStatus({ id: 5, name: 'PASS MIT EINSCHRÄNKUNG' });
    assert.deepEqual([custom.code, custom.custom], ['PASS_MIT_EINSCHRANKUNG', true]);
  });

  it('bewahrt unlesbare Zyklusdaten und benennt Ad-hoc-Zyklen', async () => {
    const c = normalizeCycle('201', (await load('cycles/DEMO/10011.json'))['201'], '10011', '7.4');
    assert.equal(c.value.startDate, '2026-10-05');
    assert.equal(c.value.endDate, null);
    assert.ok(c.preserved.includes('endDate'));
    assert.equal(normalizeCycle('-1', { name: 'Ad hoc' }, '10010', '7.3').value.name, 'Ad hoc (7.3)');
  });

  it('übernimmt Defects und Schrittergebnisse einer Ausführung', async () => {
    const statuses = new Map((await load('execution-statuses.json')).map((s: any) => [String(s.id), normalizeStatus(s)]));
    const raw = (await load('executions/10010_200.json')).executions[1];
    const e = normalizeExecution(raw, statuses as any, null).value;
    assert.equal(e.status, 'FAIL');
    assert.deepEqual(e.defects, [{ key: 'DEMO-101', title: 'Dashboard bleibt leer', status: 'Offen' }]);
    const withSteps = normalizeExecution((await load('executions/10010_200.json')).executions[0], statuses as any, await load('stepresults/9001.json')).value;
    assert.deepEqual(withSteps.stepResults.map((s) => s.stepId), ['zapi-301', 'zapi-302', 'zapi-303']);
  });
});
