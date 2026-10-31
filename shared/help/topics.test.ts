import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HELP_TOPICS, helpSection, helpSlug, topicForRoute, topicOf } from './topics.ts';

const doc = (page: string) => readFileSync(new URL(`../../docs/handbuch/${page}.md`, import.meta.url), 'utf8');

test('jedes Hilfethema zeigt auf eine vorhandene Handbuchseite und Überschrift', () => {
  for (const [id, t] of Object.entries(HELP_TOPICS)) {
    const text = doc(t.page);
    if ('heading' in t && t.heading) assert.ok(helpSection(text, t.heading), `${id}: Überschrift „${t.heading}“ fehlt in ${t.page}.md`);
    for (const r of ('related' in t ? t.related : []) ?? []) assert.ok(topicOf(r), `${id}: verwandtes Thema ${r} unbekannt`);
  }
});

test('Abschnitt endet vor der nächsten Überschrift gleicher Ebene, Unterabschnitte gehören dazu', () => {
  const md = '# T\n\n## A\neins\n### A1\nzwei\n## B\ndrei';
  assert.equal(helpSection(md, 'A'), '## A\neins\n### A1\nzwei');
  assert.equal(helpSection(md, 'B'), '## B\ndrei');
  assert.equal(helpSection(md, 'X'), null);
  assert.equal(helpSection('## A\n```\n## kein Titel\n```\nweiter', 'A'), '## A\n```\n## kein Titel\n```\nweiter');
  assert.equal(helpSlug('Kennwörter, Sperre und Sitzungen'), 'kennworter-sperre-und-sitzungen');
});

test('Thema zur Ansicht', () => {
  const q = (s = '') => new URLSearchParams(s);
  assert.equal(topicForRoute(['p', 'DEMO', 'repo'], q()), 'testcases');
  assert.equal(topicForRoute(['transfer'], q()), 'transfer');
  assert.equal(topicForRoute(['admin', 'transfers'], q()), 'transfer');
  assert.equal(topicForRoute(['p', 'DEMO', 'repo'], q('tc=DEMO-T1')), 'tc-edit');
  assert.equal(topicForRoute(['p', 'DEMO', 'cycles', 'c1'], q('exec=e1')), 'execute');
  assert.equal(topicForRoute(['p', 'DEMO', 'cycles', 'c1'], q()), 'cycles');
  assert.equal(topicForRoute(['p', 'DEMO', 'cycles'], q('plan=p&tab=cockpit')), 'cockpit');
  assert.equal(topicForRoute(['p', 'DEMO', 'cycles'], q('view=search')), 'exec-search');
  assert.equal(topicForRoute(['admin', 'users'], q()), 'admin-users');
  assert.equal(topicForRoute(['f', 'DEMO', 'run', 'x'], q()), 'execute');
  assert.equal(topicForRoute(['hilfe'], q()), 'overview');
});
