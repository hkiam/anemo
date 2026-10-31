/**
 * Ergebnisformate von Testautomatisierung ohne Zusatzbibliotheken, mit automatischer Erkennung:
 * JUnit-XML (Surefire, pytest, Jest-junit …), Cucumber-JSON, Behave-JSON, TestNG, NUnit 2/3, xUnit.net v2,
 * MSTest/VSTest (TRX), Robot Framework (output.xml), Playwright-JSON und Jest-JSON. Ergebnis ist eine einheitliche Liste.
 */
import { child, children, findAll, parseXml, textOf, type XmlNode } from '../../platform/xml.ts';
export type AutoStatus = 'passed' | 'failed' | 'skipped' | 'blocked';
export interface AutoResult {
  name: string;
  suite: string;
  /** Kennung für die dauerhafte Zuordnung (Suite + Name) */
  id: string;
  /** Fundstelle (Datei:Zeile), soweit das Format sie liefert – z. B. Cucumber; je Beispielzeile eines Grundrisses eigene */
  location?: string | undefined;
  tags: string[];
  status: AutoStatus;
  message: string | null;
  durationMs: number | null;
  steps: { text: string; status: AutoStatus; message: string | null }[];
}

const decode = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]!] = decode(m[3] ?? m[4] ?? '');
  return out;
}

const cdata = (s: string) => decode(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();

/**
 * JUnit-XML linear durchlaufen (indexOf statt rückverfolgender Regex): auch große oder absichtlich kaputte Dateien
 * (z. B. <testcase> ohne Ende) brauchen nur einen Durchgang.
 */
export function parseJUnit(xml: string): AutoResult[] {
  const out: AutoResult[] = [];
  // Suitenamen per Position zuordnen (testcase ohne classname)
  // linear per indexOf: die Regex über den Rohtext war bei vielen „<testsuite“ ohne „>“ quadratisch
  const suites: { at: number; name: string }[] = [];
  for (let p = xml.indexOf('<testsuite'); p >= 0; p = xml.indexOf('<testsuite', p + 10)) {
    const next = xml[p + 10];
    if (next !== undefined && !/[\s/>]/.test(next)) continue; // <testsuites>
    const end = xml.indexOf('>', p);
    if (end < 0) break; // kein schließendes „>“ mehr – weitere Suiten können nicht folgen
    suites.push({ at: p, name: attrs(xml.slice(p + 10, end)).name ?? '' });
  }
  let suiteIdx = -1;
  let pos = 0;
  let noMoreClose = false;
  for (;;) {
    const start = xml.indexOf('<testcase', pos);
    if (start < 0) break;
    const after = xml[start + 9];
    if (after !== undefined && !/[\s/>]/.test(after)) { pos = start + 9; continue; }
    const tagEnd = xml.indexOf('>', start);
    if (tagEnd < 0) break;
    let head = xml.slice(start + 9, tagEnd);
    let body = '';
    pos = tagEnd + 1;
    if (/\/\s*$/.test(head)) head = head.replace(/\/\s*$/, '');
    else if (!noMoreClose) {
      const close = xml.indexOf('</testcase>', tagEnd);
      if (close < 0) noMoreClose = true;
      else { body = xml.slice(tagEnd + 1, close); pos = close + 11; }
    }
    while (suiteIdx + 1 < suites.length && suites[suiteIdx + 1]!.at < start) suiteIdx++;
    const a = attrs(head);
    const suite = a.classname ?? suites[suiteIdx]?.name ?? '';
    const fail = /<(failure|error)\b([^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const skipped = /<skipped\b/.test(body);
    const message = fail ? [attrs(fail[2]!).message, fail[3] ? cdata(fail[3]) : ''].filter(Boolean).join('\n') : null;
    const name = a.name ?? '(ohne Namen)';
    out.push({
      name, suite, id: suite ? `${suite}.${name}` : name, tags: [],
      status: fail ? 'failed' : skipped ? 'skipped' : 'passed',
      message, durationMs: a.time ? Math.round(Number(a.time) * 1000) : null, steps: [],
    });
  }
  return out;
}

interface CucumberStep { keyword?: string; name?: string; hidden?: boolean; result?: { status?: string; error_message?: string; duration?: number } }
interface CucumberElement { name?: string; type?: string; keyword?: string; line?: number; tags?: { name: string }[]; steps?: CucumberStep[]; before?: CucumberStep[]; after?: CucumberStep[] }
interface CucumberFeature { name?: string; uri?: string; tags?: { name: string }[]; elements?: CucumberElement[] }

const stepStatus = (s?: string): AutoStatus => (s === 'passed' ? 'passed' : s === 'failed' ? 'failed' : s === 'skipped' ? 'skipped' : 'blocked');

export function parseCucumber(json: unknown): AutoResult[] {
  if (!Array.isArray(json)) throw new Error('Cucumber-JSON erwartet eine Liste von Features');
  const out: AutoResult[] = [];
  for (const f of json as CucumberFeature[]) {
    for (const e of f.elements ?? []) {
      if (e.type && e.type !== 'scenario') continue; // Background wird in Szenarien mitgeführt
      const steps = (e.steps ?? []).filter((s) => !s.hidden).map((s) => ({
        text: `${(s.keyword ?? '').trim()} ${s.name ?? ''}`.trim(), status: stepStatus(s.result?.status), message: s.result?.error_message ?? null,
      }));
      const hooks = [...(e.before ?? []), ...(e.after ?? [])];
      const all = [...steps.map((s) => s.status), ...hooks.map((h) => stepStatus(h.result?.status))];
      const status: AutoStatus = all.includes('failed') ? 'failed' : all.includes('blocked') ? 'blocked' : all.length && all.every((x) => x === 'skipped') ? 'skipped' : 'passed';
      const message = [...steps, ...hooks.map((h) => ({ message: h.result?.error_message ?? null }))].map((s) => s.message).filter(Boolean).join('\n') || null;
      const durationNs = [...(e.steps ?? []), ...hooks].reduce((a, s) => a + (s.result?.duration ?? 0), 0);
      const name = e.name ?? '(Szenario)';
      out.push({
        name, suite: f.name ?? f.uri ?? '', id: `${f.uri ?? f.name ?? ''}:${name}`, location: f.uri && e.line ? `${f.uri}:${e.line}` : undefined,
        tags: [...(f.tags ?? []), ...(e.tags ?? [])].map((t) => t.name.replace(/^@/, '')),
        status, message, durationMs: durationNs ? Math.round(durationNs / 1e6) : null, steps,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Weitere Formate
// ---------------------------------------------------------------------------------------------

const result = (r: Partial<AutoResult> & { name: string; status: AutoStatus }): AutoResult => ({
  suite: '', id: r.suite ? `${r.suite}.${r.name}` : r.name, tags: [], message: null, durationMs: null, steps: [], ...r,
});
const ms = (seconds: string | undefined) => (seconds && Number.isFinite(Number(seconds)) ? Math.round(Number(seconds) * 1000) : null);

/** TestNG (testng-results.xml); Konfigurationsmethoden (@Before…) werden übergangen, außer sie schlagen fehl. */
export function parseTestNG(root: XmlNode): AutoResult[] {
  const out: AutoResult[] = [];
  for (const cls of findAll(root, 'class')) {
    for (const m of children(cls, 'test-method')) {
      const st = (m.attrs.status ?? '').toUpperCase();
      if (m.attrs['is-config'] === 'true' && st !== 'FAIL') continue;
      const ex = child(m, 'exception');
      const params = findAll(m, 'value').map(textOf).filter(Boolean);
      const name = `${m.attrs.name ?? '(Methode)'}${params.length ? `(${params.join(', ')})` : ''}`;
      out.push(result({
        name, suite: cls.attrs.name ?? '', status: st === 'PASS' ? 'passed' : st === 'FAIL' ? 'failed' : 'skipped',
        message: ex ? [ex.attrs.class, textOf(child(ex, 'message')), textOf(child(ex, 'full-stacktrace')).split('\n').slice(0, 15).join('\n')].filter(Boolean).join('\n') : null,
        durationMs: m.attrs['duration-ms'] ? Number(m.attrs['duration-ms']) : null,
        tags: (m.attrs.description ? [m.attrs.description] : []),
      }));
    }
  }
  return out;
}

/** NUnit 3 (test-run) und NUnit 2.x (test-results). */
export function parseNUnit(root: XmlNode): AutoResult[] {
  return findAll(root, 'test-case').map((t) => {
    const r = (t.attrs.result ?? '').toLowerCase();
    const label = (t.attrs.label ?? '').toLowerCase();
    const executed = t.attrs.executed;
    const status: AutoStatus = /fail|error/.test(r) || label === 'error' ? 'failed' : /passed|success/.test(r) ? 'passed'
      : /inconclusive|notrunnable/.test(r) ? 'blocked' : executed === 'False' || /skip|ignor/.test(r) ? 'skipped' : 'passed';
    const full = t.attrs.fullname ?? t.attrs.name ?? '(Test)';
    const dot = full.lastIndexOf('.', full.indexOf('(') > 0 ? full.indexOf('(') : full.length);
    const cats = [...findAll(t, 'property').filter((p) => p.attrs.name === 'Category').map((p) => p.attrs.value ?? ''), ...findAll(t, 'category').map((c) => c.attrs.name ?? '')].filter(Boolean);
    const fail = child(t, 'failure') ?? child(t, 'reason');
    return result({
      name: dot > 0 ? full.slice(dot + 1) : full, suite: dot > 0 ? full.slice(0, dot) : '', id: full, tags: cats, status,
      message: fail ? [textOf(child(fail, 'message')), textOf(child(fail, 'stack-trace')).split('\n').slice(0, 15).join('\n')].filter(Boolean).join('\n') || null : null,
      durationMs: ms(t.attrs.duration ?? t.attrs.time),
    });
  });
}

/** xUnit.net v2 (assemblies/assembly/collection/test). */
export function parseXUnit(root: XmlNode): AutoResult[] {
  return findAll(root, 'test').map((t) => {
    const r = (t.attrs.result ?? '').toLowerCase();
    const fail = child(t, 'failure');
    const full = t.attrs.name ?? '(Test)';
    return result({
      name: t.attrs.method ?? full, suite: t.attrs.type ?? '', id: full,
      tags: findAll(t, 'trait').map((x) => (x.attrs.name === 'Category' ? x.attrs.value ?? '' : `${x.attrs.name}=${x.attrs.value}`)).filter(Boolean),
      status: r === 'pass' ? 'passed' : r === 'fail' ? 'failed' : 'skipped',
      message: fail ? [textOf(child(fail, 'message')), textOf(child(fail, 'stack-trace')).split('\n').slice(0, 15).join('\n')].filter(Boolean).join('\n') : textOf(child(t, 'reason')) || null,
      durationMs: ms(t.attrs.time),
    });
  });
}

/** MSTest/VSTest (.trx): Ergebnisse mit Testdefinitionen (Klasse, Kategorien) verbunden. */
export function parseTrx(root: XmlNode): AutoResult[] {
  const defs = new Map(findAll(root, 'UnitTest').map((u) => [u.attrs.id ?? '', {
    cls: child(u, 'TestMethod')?.attrs.className ?? '', method: child(u, 'TestMethod')?.attrs.name ?? u.attrs.name ?? '',
    cats: findAll(u, 'TestCategoryItem').map((c) => c.attrs.TestCategory ?? '').filter(Boolean),
  }]));
  const dur = (s?: string) => { const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(s ?? ''); return m ? Math.round(((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000) : null; };
  return findAll(root, 'UnitTestResult').map((r) => {
    const d = defs.get(r.attrs.testId ?? '');
    const o = (r.attrs.outcome ?? '').toLowerCase();
    const err = findAll(r, 'ErrorInfo')[0];
    const name = r.attrs.testName ?? d?.method ?? '(Test)';
    return result({
      name, suite: d?.cls.split(',')[0] ?? '', tags: d?.cats ?? [],
      status: o === 'passed' ? 'passed' : o === 'failed' || o === 'timeout' || o === 'aborted' || o === 'error' ? 'failed' : o === 'inconclusive' ? 'blocked' : 'skipped',
      message: err ? [textOf(child(err, 'Message')), textOf(child(err, 'StackTrace')).split('\n').slice(0, 15).join('\n')].filter(Boolean).join('\n') : null,
      durationMs: dur(r.attrs.duration),
    });
  });
}

/** Robot Framework (output.xml, Versionen 3–7): Tests mit Tags; Schlüsselwörter der obersten Ebene als Schritte. */
export function parseRobot(root: XmlNode): AutoResult[] {
  const out: AutoResult[] = [];
  const rstatus = (s?: string): AutoStatus => (s === 'PASS' ? 'passed' : s === 'FAIL' ? 'failed' : s === 'SKIP' || s === 'NOT RUN' || s === 'NOT_RUN' ? 'skipped' : 'blocked');
  const walk = (suite: XmlNode, path: string[]) => {
    const name = suite.attrs.name ?? '';
    const here = name ? [...path, name] : path;
    for (const t of children(suite, 'test')) {
      const st = children(t, 'status').at(-1);
      const kws = t.children.filter((c) => c.name === 'kw' || c.name === 'for' || c.name === 'if' || c.name === 'try' || c.name === 'while');
      const elapsed = st?.attrs.elapsed ? Number(st.attrs.elapsed) * 1000
        : st?.attrs.starttime && st.attrs.endtime ? Date.parse(st.attrs.endtime.replace(' ', 'T')) - Date.parse(st.attrs.starttime.replace(' ', 'T')) : null;
      out.push(result({
        name: t.attrs.name ?? '(Test)', suite: here.join('.'), id: `${here.join('.')}.${t.attrs.name ?? ''}`,
        tags: findAll(child(t, 'tags') ?? { name: '', attrs: {}, children: [], text: '' }, 'tag').map(textOf),
        status: rstatus(st?.attrs.status), message: st && st.attrs.status !== 'PASS' ? textOf(st) || null : null,
        durationMs: elapsed !== null && Number.isFinite(elapsed) ? Math.round(elapsed) : null,
        steps: kws.map((k) => {
          const ks = children(k, 'status').at(-1);
          return { text: [k.attrs.name ?? k.name.toUpperCase(), ...findAll(child(k, 'arguments') ?? { name: '', attrs: {}, children: [], text: '' }, 'arg').map(textOf)].join(' '),
            status: rstatus(ks?.attrs.status), message: ks && ks.attrs.status === 'FAIL' ? textOf(ks) || null : null };
        }),
      }));
    }
    for (const s of children(suite, 'suite')) walk(s, here);
  };
  for (const s of findAll(root, 'robot').flatMap((r) => children(r, 'suite'))) walk(s, []);
  return out;
}

interface PwResult { status?: string; duration?: number; error?: { message?: string }; errors?: { message?: string }[] }
interface PwSpec { title: string; tags?: string[]; tests?: { results?: PwResult[]; status?: string; annotations?: { type: string }[]; projectName?: string }[] }
interface PwSuite { title: string; file?: string; specs?: PwSpec[]; suites?: PwSuite[] }

/** Playwright JSON-Reporter: je Spec und Projekt (Browser) ein Ergebnis; letzter Versuch zählt. */
export function parsePlaywright(json: { suites?: PwSuite[] }): AutoResult[] {
  const out: AutoResult[] = [];
  const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
  const walk = (s: PwSuite, path: string[]) => {
    const here = s.title ? [...path, s.title] : path;
    for (const spec of s.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.at(-1);
        const st = last?.status ?? t.status;
        const name = `${spec.title}${t.projectName ? ` [${t.projectName}]` : ''}`;
        out.push(result({
          name, suite: here.join(' › '), id: `${here.join(' › ')} › ${spec.title}${t.projectName ? ` [${t.projectName}]` : ''}`,
          tags: (spec.tags ?? []).map((x) => x.replace(/^@/, '')),
          status: st === 'passed' || st === 'expected' || st === 'flaky' ? 'passed' : st === 'skipped' ? 'skipped' : st === 'interrupted' ? 'blocked' : 'failed',
          message: last?.error?.message ? strip(last.error.message).slice(0, 4000) : last?.errors?.map((e) => strip(e.message ?? '')).join('\n') || null,
          durationMs: last?.duration ?? null,
        }));
      }
    }
    for (const c of s.suites ?? []) walk(c, here);
  };
  for (const s of json.suites ?? []) walk(s, []);
  return out;
}

/** Jest JSON (--json). */
export function parseJest(json: { testResults?: { name?: string; assertionResults?: { fullName?: string; title?: string; ancestorTitles?: string[]; status?: string; duration?: number; failureMessages?: string[] }[] }[] }): AutoResult[] {
  return (json.testResults ?? []).flatMap((f) => (f.assertionResults ?? []).map((a) => result({
    name: a.title ?? a.fullName ?? '(Test)', suite: [f.name?.split('/').pop() ?? '', ...(a.ancestorTitles ?? [])].filter(Boolean).join(' › '),
    id: `${f.name ?? ''}:${a.fullName ?? a.title}`,
    status: a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped',
    message: a.failureMessages?.length ? a.failureMessages.join('\n').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 4000) : null,
    durationMs: a.duration ?? null,
  })));
}

/** Behave (behave -f json): wie Cucumber, Tags als Texte, Fehlertext als Zeilenliste, Dauer in Sekunden. */
export function parseBehave(json: unknown): AutoResult[] {
  if (!Array.isArray(json)) throw new Error('Behave-JSON erwartet eine Liste von Features');
  const conv = (json as Record<string, unknown>[]).map((f) => ({
    ...f, tags: ((f.tags as unknown[]) ?? []).map((t) => (typeof t === 'string' ? { name: t } : t)),
    elements: ((f.elements as Record<string, unknown>[]) ?? []).map((e) => ({
      ...e, tags: ((e.tags as unknown[]) ?? []).map((t) => (typeof t === 'string' ? { name: t } : t)),
      steps: ((e.steps as Record<string, unknown>[]) ?? []).map((s) => {
        const r = (s.result ?? {}) as { status?: string; duration?: number; error_message?: string | string[] };
        return { ...s, result: { status: r.status === 'undefined' ? 'blocked' : r.status ?? (e.status === 'skipped' ? 'skipped' : undefined), duration: (r.duration ?? 0) * 1e9,
          error_message: Array.isArray(r.error_message) ? r.error_message.join('\n') : r.error_message } };
      }),
    })),
  }));
  return parseCucumber(conv);
}

export const FORMATS = ['junit', 'cucumber', 'behave', 'testng', 'nunit', 'xunit', 'trx', 'robot', 'playwright', 'jest'] as const;
export type Format = (typeof FORMATS)[number];
export const FORMAT_LABEL: Record<Format, string> = {
  junit: 'JUnit', cucumber: 'Cucumber', behave: 'Behave', testng: 'TestNG', nunit: 'NUnit', xunit: 'xUnit.net', trx: 'MSTest/TRX',
  robot: 'Robot Framework', playwright: 'Playwright', jest: 'Jest',
};

/** Format erkennen (Wurzelelement bzw. JSON-Struktur) und einlesen. */
export function parseResults(text: string, format?: Format): { format: Format; results: AutoResult[] } {
  const t = text.replace(/^\uFEFF/, '').trimStart();
  if (t.startsWith('<')) {
    const root = parseXml(t);
    const top = root.children[0]?.name ?? '';
    const f: Format = format ?? (top === 'testng-results' ? 'testng' : top === 'test-run' || top === 'test-results' ? 'nunit'
      : top === 'assemblies' || top === 'assembly' ? 'xunit' : top === 'TestRun' ? 'trx' : top === 'robot' ? 'robot' : 'junit');
    const results = f === 'testng' ? parseTestNG(root) : f === 'nunit' ? parseNUnit(root) : f === 'xunit' ? parseXUnit(root)
      : f === 'trx' ? parseTrx(root) : f === 'robot' ? parseRobot(root) : parseJUnit(t);
    return { format: f, results };
  }
  const json = JSON.parse(t) as unknown;
  const looksBehave = Array.isArray(json) && (json as Record<string, unknown>[]).some((f) => typeof f.status === 'string' || ((f.tags as unknown[]) ?? []).some((x) => typeof x === 'string')
    || ((f.elements as Record<string, unknown>[]) ?? []).some((e) => ((e.steps as Record<string, { error_message?: unknown }>[]) ?? []).some((s) => Array.isArray((s.result as { error_message?: unknown } | undefined)?.error_message))));
  const f: Format = format ?? (Array.isArray(json) ? (looksBehave ? 'behave' : 'cucumber')
    : json && typeof json === 'object' && 'testResults' in json ? 'jest' : json && typeof json === 'object' && 'suites' in json ? 'playwright' : 'cucumber');
  const results = f === 'behave' ? parseBehave(json) : f === 'jest' ? parseJest(json as never) : f === 'playwright' ? parsePlaywright(json as never) : parseCucumber(json);
  return { format: f, results };
}
