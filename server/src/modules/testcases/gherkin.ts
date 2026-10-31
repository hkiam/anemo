/**
 * Schlanker Gherkin-Parser (Deutsch und Englisch) ohne externe Abhängigkeiten, plus Umwandlung
 * zwischen klassischen Schritten und Gherkin. Ziel ist Validierung mit Zeilennummern und
 * eine ausführbare Schrittliste – kein vollständiger Cucumber-Ersatz.
 */
import { createHash } from 'node:crypto';

export type StepType = 'given' | 'when' | 'then';

export interface GherkinStep {
  keyword: string;
  type: StepType;
  text: string;
  line: number;
  docString?: string;
  table?: string[][];
}

export interface GherkinScenario {
  name: string;
  kind: 'scenario' | 'outline';
  tags: string[];
  rule: string | null;
  line: number;
  steps: GherkinStep[];
  examples: { name: string; header: string[]; rows: string[][] }[];
}

export interface GherkinDocument {
  language: 'de' | 'en';
  feature: { name: string; description: string; tags: string[] } | null;
  background: GherkinStep[];
  scenarios: GherkinScenario[];
  errors: { line: number; message: string }[];
  warnings: { line: number; message: string }[];
}

const KEYWORDS = {
  en: {
    feature: ['Feature', 'Business Need', 'Ability'],
    rule: ['Rule'],
    background: ['Background'],
    outline: ['Scenario Outline', 'Scenario Template'],
    scenario: ['Scenario', 'Example'],
    examples: ['Examples', 'Scenarios'],
    given: ['Given'], when: ['When'], then: ['Then'], and: ['And', '*'], but: ['But'],
  },
  de: {
    feature: ['Funktionalität', 'Funktion'],
    rule: ['Regel', 'Rule'],
    background: ['Grundlage', 'Hintergrund', 'Voraussetzungen', 'Vorbedingungen'],
    outline: ['Szenariogrundriss', 'Szenarien'],
    scenario: ['Szenario', 'Beispiel'],
    examples: ['Beispiele'],
    given: ['Angenommen', 'Gegeben seien', 'Gegeben sei'], when: ['Wenn'], then: ['Dann'], and: ['Und', '*'], but: ['Aber'],
  },
} as const;

type Lang = keyof typeof KEYWORDS;

function matchHeader(line: string, words: readonly string[]): string | null {
  for (const w of words) {
    if (line.startsWith(w + ':')) return line.slice(w.length + 1).trim();
  }
  return null;
}

function matchStep(line: string, lang: Lang): { keyword: string; kind: StepType | 'and'; text: string } | null {
  const k = KEYWORDS[lang];
  const groups: [readonly string[], StepType | 'and'][] = [
    [k.given, 'given'], [k.when, 'when'], [k.then, 'then'], [k.and, 'and'], [k.but, 'and'],
  ];
  for (const [words, kind] of groups) {
    for (const w of words) {
      if (line === w || line.startsWith(w + ' ')) return { keyword: w, kind, text: line.slice(w.length).trim() };
    }
  }
  return null;
}

const parseRow = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function detectLanguage(text: string): Lang {
  const m = /^\s*#\s*language:\s*(\w+)/m.exec(text);
  if (m) return m[1] === 'de' ? 'de' : 'en';
  return /^\s*(Funktionalität|Szenario|Angenommen|Wenn|Dann)\b/m.test(text) ? 'de' : 'en';
}

export function parseGherkin(text: string): GherkinDocument {
  const lang = detectLanguage(text);
  const k = KEYWORDS[lang];
  const doc: GherkinDocument = { language: lang, feature: null, background: [], scenarios: [], errors: [], warnings: [] };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  let tags: string[] = [];
  let rule: string | null = null;
  let target: GherkinStep[] | null = null; // aktuelle Schrittliste (Background oder Szenario)
  let scenario: GherkinScenario | null = null;
  let examples: GherkinScenario['examples'][number] | null = null;
  let lastType: StepType | null = null;
  let featureDescription: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i]!.trim();
    if (line === '' || line.startsWith('#')) continue;

    if (line.startsWith('"""') || line.startsWith('```')) {
      const fence = line.slice(0, 3);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim().startsWith(fence)) body.push(lines[j]!.trim()), j++;
      if (j >= lines.length) doc.errors.push({ line: lineNo, message: 'DocString wird nicht geschlossen' });
      const step = target?.at(-1);
      if (step) step.docString = body.join('\n');
      else doc.errors.push({ line: lineNo, message: 'DocString ohne vorangehenden Schritt' });
      i = j;
      continue;
    }

    if (line.startsWith('|')) {
      if (examples) {
        if (examples.header.length === 0) examples.header = parseRow(line);
        else {
          const row = parseRow(line);
          if (row.length !== examples.header.length) {
            doc.errors.push({ line: lineNo, message: `Beispielzeile hat ${row.length} statt ${examples.header.length} Spalten` });
          }
          examples.rows.push(row);
        }
      } else {
        const step = target?.at(-1);
        if (step) (step.table ??= []).push(parseRow(line));
        else doc.errors.push({ line: lineNo, message: 'Tabelle ohne vorangehenden Schritt' });
      }
      continue;
    }

    if (line.startsWith('@')) {
      tags.push(...line.split(/\s+/).filter((t) => t.startsWith('@')));
      continue;
    }

    let header: string | null;
    if ((header = matchHeader(line, k.feature)) !== null) {
      if (doc.feature) doc.errors.push({ line: lineNo, message: 'Nur eine Funktionalität/Feature je Dokument erlaubt' });
      doc.feature = { name: header, description: '', tags };
      featureDescription = [];
      tags = [];
      continue;
    }
    if ((header = matchHeader(line, k.rule)) !== null) {
      rule = header; featureDescription = null; target = null; scenario = null; examples = null;
      continue;
    }
    if ((header = matchHeader(line, k.background)) !== null) {
      featureDescription = null; scenario = null; examples = null; lastType = null;
      target = doc.background;
      continue;
    }
    const outlineName = matchHeader(line, k.outline);
    const scenarioName = outlineName === null ? matchHeader(line, k.scenario) : null;
    if (outlineName !== null || scenarioName !== null) {
      featureDescription = null; examples = null; lastType = null;
      scenario = {
        name: (outlineName ?? scenarioName)!, kind: outlineName !== null ? 'outline' : 'scenario',
        tags, rule, line: lineNo, steps: [], examples: [],
      };
      tags = [];
      doc.scenarios.push(scenario);
      target = scenario.steps;
      continue;
    }
    if ((header = matchHeader(line, k.examples)) !== null) {
      if (!scenario || scenario.kind !== 'outline') {
        doc.errors.push({ line: lineNo, message: 'Beispiele/Examples nur innerhalb eines Szenariogrundrisses erlaubt' });
      } else {
        examples = { name: header, header: [], rows: [] };
        scenario.examples.push(examples);
      }
      continue;
    }

    const step = matchStep(line, lang);
    if (step) {
      examples = null;
      if (!target) {
        doc.errors.push({ line: lineNo, message: 'Schritt außerhalb eines Szenarios' });
        continue;
      }
      let type: StepType;
      if (step.kind === 'and') {
        if (!lastType) {
          doc.errors.push({ line: lineNo, message: `"${step.keyword}" darf nicht der erste Schritt sein` });
          type = 'given';
        } else type = lastType;
      } else type = step.kind;
      if (!step.text) doc.errors.push({ line: lineNo, message: 'Schritt ohne Text' });
      if (lastType === 'then' && type === 'when') {
        doc.warnings.push({ line: lineNo, message: 'Weiteres "Wenn" nach "Dann" – ggf. in mehrere Szenarien aufteilen' });
      }
      if (target === doc.background && type !== 'given') {
        doc.warnings.push({ line: lineNo, message: 'Grundlage/Background sollte nur Vorbedingungen (Angenommen/Given) enthalten' });
      }
      target.push({ keyword: step.keyword, type, text: step.text, line: lineNo });
      lastType = type;
      continue;
    }

    if (featureDescription && !scenario) {
      featureDescription.push(line);
      doc.feature!.description = featureDescription.join('\n');
      continue;
    }
    doc.errors.push({ line: lineNo, message: `Unerwartete Zeile: "${line.slice(0, 60)}"` });
  }

  if (doc.scenarios.length === 0) doc.errors.push({ line: 1, message: 'Kein Szenario gefunden' });
  for (const s of doc.scenarios) {
    if (s.steps.length === 0) doc.errors.push({ line: s.line, message: `Szenario "${s.name}" hat keine Schritte` });
    if (s.kind === 'outline' && s.examples.every((e) => e.rows.length === 0)) {
      doc.errors.push({ line: s.line, message: `Szenariogrundriss "${s.name}" hat keine Beispiele` });
    }
    if (s.steps.length > 0 && !s.steps.some((st) => st.type === 'then')) {
      doc.warnings.push({ line: s.line, message: `Szenario "${s.name}" hat kein überprüfbares Ergebnis (Dann/Then)` });
    }
  }
  return doc;
}

function stepText(s: GherkinStep): string {
  let t = `${s.keyword} ${s.text}`;
  if (s.table) t += '\n' + s.table.map((r) => `| ${r.join(' | ')} |`).join('\n');
  if (s.docString) t += '\n"""\n' + s.docString + '\n"""';
  return t;
}

const stableId = (...parts: (string | number)[]) =>
  'g-' + createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 12);

/**
 * Ausführbare Schritte für die manuelle Ausführung eines Gherkin-Testfalls:
 * je Szenario dessen Background- und eigene Schritte. "Dann"-Schritte werden als Erwartung geführt.
 */
export function executableSteps(text: string): { id: string; action: string; data: string; expected: string }[] {
  const doc = parseGherkin(text);
  const out: { id: string; action: string; data: string; expected: string }[] = [];
  for (const s of doc.scenarios) {
    const steps = [...doc.background, ...s.steps];
    const examples = s.examples.flatMap((e) => e.rows.map((r) => e.header.map((h, i) => `${h}=${r[i] ?? ''}`).join(', ')));
    steps.forEach((st, idx) => {
      const prefix = doc.scenarios.length > 1 && idx === 0 ? `[${s.name}] ` : '';
      out.push({
        id: stableId(s.name, idx, st.keyword, st.text),
        action: st.type === 'then' ? '' : prefix + stepText(st),
        data: idx === 0 && examples.length ? `Beispiele: ${examples.join(' | ')}` : '',
        expected: st.type === 'then' ? prefix + stepText(st) : '',
      });
    });
  }
  return out;
}

const splitLines = (text: string | null | undefined) =>
  (text ?? '').split('\n').map((l) => l.replace(/^\s*([-*#]|\d+[.)])\s+/, '').trim()).filter(Boolean);

const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ').trim();

export interface ClassicLike {
  title: string;
  objective?: string | null;
  preconditions?: string | null;
  steps: { action?: string; data?: string; expected?: string }[];
}

/** Vorschlag: klassischen Testfall in Gherkin überführen. Ändert nichts, liefert Text + Hinweise. */
export function classicToGherkin(c: ClassicLike, lang: Lang = 'de'): { gherkin: string; hints: string[] } {
  const k = lang === 'de'
    ? { feature: 'Funktionalität', scenario: 'Szenario', given: 'Angenommen', when: 'Wenn', then: 'Dann', and: 'Und' }
    : { feature: 'Feature', scenario: 'Scenario', given: 'Given', when: 'When', then: 'Then', and: 'And' };
  const hints: string[] = [];
  const out: string[] = [`# language: ${lang}`, `${k.feature}: ${c.title}`];
  const objective = splitLines(c.objective);
  if (objective.length) out.push(...objective.slice(0, 3).map((l) => `  ${l}`));
  out.push('', `  ${k.scenario}: ${c.title}`);

  const pre = splitLines(c.preconditions);
  if (pre.length === 0) hints.push('Keine Vorbedingungen vorhanden – "Angenommen"-Schritt bitte fachlich ergänzen.');
  pre.forEach((p, i) => out.push(`    ${i === 0 ? k.given : k.and} ${p}`));

  let whenBlocks = 0;
  c.steps.forEach((s, i) => {
    // Abschnitt (J1) als Kommentarzeile
    if ((s as { kind?: string }).kind === 'group') { out.push(`    # ${oneLine((s as { title?: string }).title ?? 'Abschnitt')}`); return; }
    const action = oneLine(s.action ?? '');
    const data = oneLine(s.data ?? '');
    const expected = oneLine(s.expected ?? '');
    if (action) {
      out.push(`    ${k.when} ${action}${data ? ` (${lang === 'de' ? 'Testdaten' : 'test data'}: ${data})` : ''}`);
      whenBlocks++;
    }
    if (expected) out.push(`    ${action ? k.then : k.and} ${expected}`);
    else hints.push(`Schritt ${i + 1} hat kein erwartetes Ergebnis.`);
  });
  if (whenBlocks > 1) {
    hints.push(`${whenBlocks} Wenn/Dann-Blöcke in einem Szenario – gutes BDD hat je Szenario genau ein Verhalten; ggf. aufteilen.`);
  }
  if (c.steps.length === 0) hints.push('Keine Schritte vorhanden.');
  return { gherkin: out.join('\n') + '\n', hints };
}

/** Vorschlag: Gherkin in klassische Schritte überführen (Vorbedingungen + Aktion/Erwartung). */
export function gherkinToClassic(text: string): {
  preconditions: string | null;
  steps: { action: string; data: string; expected: string }[];
  hints: string[];
} {
  const doc = parseGherkin(text);
  const hints = doc.errors.map((e) => `Zeile ${e.line}: ${e.message}`);
  const pre = doc.background.map((s) => s.text);
  const steps: { action: string; data: string; expected: string }[] = [];
  for (const sc of doc.scenarios) {
    let current: { action: string; data: string; expected: string } | null = null;
    for (const st of sc.steps) {
      const data = [st.table?.map((r) => r.join(' | ')).join('\n'), st.docString].filter(Boolean).join('\n');
      if (st.type === 'given') {
        if (steps.length === 0 && !current) pre.push(st.text);
        else (current ??= { action: '', data: '', expected: '' }).action += (current.action ? '\n' : '') + st.text;
      } else if (st.type === 'when') {
        if (current && current.expected) {
          steps.push(current);
          current = null;
        }
        current ??= { action: '', data: '', expected: '' };
        current.action += (current.action ? '\n' : '') + st.text;
        if (data) current.data += (current.data ? '\n' : '') + data;
      } else {
        current ??= { action: '', data: '', expected: '' };
        current.expected += (current.expected ? '\n' : '') + st.text;
        if (data) current.data += (current.data ? '\n' : '') + data;
      }
    }
    if (current) steps.push(current);
    if (sc.kind === 'outline') hints.push(`Szenariogrundriss "${sc.name}": Beispiele werden nicht expandiert, Platzhalter bleiben stehen.`);
  }
  if (doc.scenarios.length > 1) hints.push(`${doc.scenarios.length} Szenarien wurden zu einer Schrittfolge zusammengeführt.`);
  return { preconditions: pre.length ? pre.join('\n') : null, steps, hints };
}
