/**
 * Modul assist: Assistenzfunktionen für den Testbestand (Roadmap D4, ADR-0023). Regelbasiert und nachvollziehbar;
 * ein Sprachmodell ist optional und nur für Entwürfe/Zusammenfassungen, die ein Mensch prüft.
 */
import { groupTitle, isGroup, stepNumbers } from '../../../../shared/steps/groups.ts';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../../platform/db.ts';
import { HttpError, route } from '../../platform/http.ts';
import { getProject } from '../projects/index.ts';
import { isResolvedStatus } from '../references/index.ts';
import { isNotOk, isPassed } from '../../../../shared/status/status.ts';
import { listAttachments } from '../attachments/index.ts';
import { getCycle, getExecution } from '../execution/index.ts';
import { cockpit } from '../reports/index.ts';
import { aiState, ask, type LlmConfig, llmConfig, parseJson, type Profile } from './llm.ts';
import { listPrompts, promptFor, savePrompt } from './prompts.ts';
import { type RiskItem, riskRanking, select } from './risk.ts';

export { aiState, setLlmFetch } from './llm.ts';

// ---------------------------------------------------------------------------------------------
// Ähnliche Testfälle (Duplikatkandidaten)
// ---------------------------------------------------------------------------------------------

function trigrams(s: string): Set<string> {
  const t = ` ${s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}
const sim = (a: Set<string>, b: Set<string>) => {
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const g of small) if (big.has(g)) inter++;
  return inter / (a.size + b.size - inter || 1);
};

/**
 * Ergebnisse der rechenintensiven Ähnlichkeitsanalyse je Projekt zwischenspeichern: gültig, solange sich kein
 * Testfall des Projekts ändert (Stand = Anzahl + letzte Änderung). Sonst blockiert jeder Aufruf ~0,4 s den Server.
 */
const similarCache = new Map<string, { stamp: string; result: Awaited<ReturnType<typeof computeSimilar>> }>();

/** Ähnliche Testfälle: Trigramm-Ähnlichkeit von Titel (40 %) und Inhalt (60 %), Kandidaten über einen invertierten Index. */
export async function similarTestCases(db: Db, projectId: string, min: number, limit = 200) {
  const [s] = await db<{ stamp: string }[]>`select count(*) || ':' || coalesce(max(updated_at)::text, '') as stamp from test_case where project_id = ${projectId}`;
  const key = `${projectId}|${min}|${limit}`;
  const hit = similarCache.get(key);
  if (hit && hit.stamp === s!.stamp) return hit.result;
  const result = await computeSimilar(db, projectId, min, limit);
  if (similarCache.size > 200) similarCache.clear();
  similarCache.set(key, { stamp: s!.stamp, result });
  return result;
}

async function computeSimilar(db: Db, projectId: string, min: number, limit: number) {
  const rows = await db<{ key: string; title: string; body: string }[]>`
    select tc.key, v.title, coalesce(v.objective, '') || ' ' || coalesce((select string_agg(coalesce(s->>'action','') || ' ' || coalesce(s->>'expected',''), ' ')
           from jsonb_array_elements(v.steps) s), '') || ' ' || coalesce(v.gherkin, '') as body
    from test_case tc join test_case_version v on v.test_case_id = tc.id and v.version_no = tc.current_version
    left join test_case_status st on st.code = tc.status
    where tc.project_id = ${projectId} and coalesce(st.category, '') <> 'DEPRECATED' and tc.archived_at is null`;
  const docs = rows.map((r) => ({ ...r, t: trigrams(r.title), b: trigrams(r.body.slice(0, 3000)) }));
  // Kandidaten: gemeinsame seltene Trigramme in Titel oder Inhalt
  const index = new Map<string, number[]>();
  docs.forEach((d, i) => { for (const g of new Set([...d.t, ...d.b])) (index.get(g) ?? index.set(g, []).get(g)!).push(i); });
  const maxPosting = Math.max(20, docs.length * 0.05);
  const out: { a: string; aTitle: string; b: string; bTitle: string; title: number; content: number; score: number }[] = [];
  docs.forEach((d, i) => {
    const shared = new Map<number, number>();
    for (const g of new Set([...d.t, ...d.b])) {
      const post = index.get(g)!;
      if (post.length > maxPosting) continue; // zu häufig, keine Aussagekraft
      for (const j of post) if (j > i) shared.set(j, (shared.get(j) ?? 0) + 1);
    }
    for (const [j, n] of shared) {
      if (n < 5) continue;
      const e = docs[j]!;
      const title = sim(d.t, e.t);
      const content = d.b.size > 3 && e.b.size > 3 ? sim(d.b, e.b) : title;
      const score = Math.round((0.4 * title + 0.6 * content) * 100) / 100;
      if (score >= min) out.push({ a: d.key, aTitle: d.title, b: e.key, bTitle: e.title, title: Math.round(title * 100) / 100, content: Math.round(content * 100) / 100, score });
    }
  });
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Fehlerursachen-Cluster
// ---------------------------------------------------------------------------------------------

/** Text für den Vergleich: Zahlen, Kennungen, Pfade und Daten neutralisieren. */
export function normalizeFinding(s: string): string {
  return s.toLowerCase()
    .replace(/\{[^}]*\}/g, ' ').replace(/[*_+^~|[\]!]/g, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, ' <id> ').replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{6,}\b/g, ' <hex> ').replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g, ' <datum> ')
    .replace(/[a-z]:\\[^\s]+|\/[\w./-]{3,}/g, ' <pfad> ').replace(/\b[a-z]+-\d+\b/g, ' <ticket> ').replace(/\d+/g, '#')
    .replace(/\s+/g, ' ').trim();
}
const STOP = new Set('und oder der die das den dem des ein eine einer eines nicht ist sind wird werden wurde wurden mit bei auf nach noch sich kein keine im in an am zu zum zur von vom für fuer aus als auch es er sie wir ich man dass daß wie was wenn dann aber nur schon nicht mehr beim über ueber unter vor hier da so the and for with not was are'.split(' '));
/** Nur Wörter aus Buchstaben (keine Kennungen/Hex-Reste), ohne Füllwörter */
const tokens = (s: string) => new Set(s.split(/[^\p{L}]+/u).filter((t) => t.length > 2 && !STOP.has(t)));
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

export interface Cluster { label: string; size: number; testCases: string[]; cycles: string[]; defects: string[]; samples: string[]; executionIds: string[]; summary?: string | null }

export async function failureClusters(db: Db, projectId: string, opts: { planId?: string | undefined; days: number }): Promise<Cluster[]> {
  const rows = await db<{ id: string; key: string; cycle: string; comment: string | null; stepComments: string | null; defects: string[] }[]>`
    select e.id, tc.key, c.name as cycle, e.comment,
      (select string_agg(r->>'comment', ' ') from jsonb_array_elements(e.step_results) r where r->>'comment' is not null) as step_comments,
      coalesce((select array_agg(distinct x.external_key) from external_reference x where x.owner_type = 'TEST_EXECUTION' and x.owner_id = e.id and x.relation = 'DEFECT'), '{}') as defects
    from test_execution e join test_cycle c on c.id = e.cycle_id join test_case tc on tc.id = e.test_case_id
    join execution_status s on s.code = e.status
    where c.project_id = ${projectId} and s.category in ('FAILED', 'BLOCKED')
      and e.executed_at > now() - make_interval(days => ${opts.days}) ${opts.planId ? db`and c.plan_id = ${opts.planId}` : db``}
    order by e.executed_at desc limit 3000`;
  const prepared = rows.map((r) => {
    const text = [r.comment, r.stepComments].filter(Boolean).join(' ');
    return { ...r, text, tok: tokens(normalizeFinding(text)) };
  });
  // Wörter, die in vielen Befunden stehen (Umgebungsangaben wie Server, Mandant, Betriebssystem), tragen nichts zur Ursache bei
  const df = new Map<string, number>();
  for (const it of prepared) for (const t of it.tok) df.set(t, (df.get(t) ?? 0) + 1);
  const common = new Set([...df].filter(([, n]) => n > Math.max(5, prepared.length * 0.08)).map(([t]) => t));
  const items = prepared.map((it) => ({ ...it, tok: new Set([...it.tok].filter((t) => !common.has(t))) })).filter((it) => it.tok.size >= 2 || it.defects.length);
  // Leader-Clustering: Vergleich mit dem ersten Befund des Clusters (kein Ausfransen); gleicher Fehler verbindet
  const clusters: { members: typeof items; tok: Set<string>; defects: Set<string> }[] = [];
  for (const it of items) {
    // gleicher Fehler wie der erste Befund des Clusters, sonst Wortähnlichkeit – beides gegen den Anführer, ohne Verkettung
    const c = clusters.find((cl) => it.defects.some((d) => cl.defects.has(d))) ?? clusters.find((cl) => it.tok.size >= 2 && jaccard(cl.tok, it.tok) >= 0.4);
    if (c) c.members.push(it);
    else clusters.push({ members: [it], tok: it.tok, defects: new Set(it.defects) });
  }
  return clusters.filter((c) => c.members.length >= 2).sort((a, b) => b.members.length - a.members.length).slice(0, 30).map((c) => {
    const freq = new Map<string, number>();
    for (const m of c.members) for (const t of m.tok) freq.set(t, (freq.get(t) ?? 0) + 1);
    return {
      label: [...freq].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t).join(' · '),
      size: c.members.length, testCases: [...new Set(c.members.map((m) => m.key))], cycles: [...new Set(c.members.map((m) => m.cycle))].slice(0, 10),
      defects: [...new Set(c.members.flatMap((m) => m.defects))], samples: c.members.slice(0, 3).map((m) => m.text.slice(0, 300)),
      executionIds: c.members.map((m) => m.id).slice(0, 50),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Anforderungsabdeckung
// ---------------------------------------------------------------------------------------------

export async function coverage(db: Db, projectId: string) {
  const rows = await db<{ provider: string; key: string; title: string | null; status: string | null; url: string | null; tests: string[]; lastResults: string[] }[]>`
    with req as (
      select r.provider, r.external_key, max(r.title) as title, max(r.status) as status, max(r.url) as url, array_agg(distinct tc.id) as tc_ids
      from external_reference r join test_case tc on tc.id = r.owner_id
      where r.owner_type = 'TEST_CASE' and r.relation in ('REQUIREMENT', 'STORY', 'EPIC') and tc.project_id = ${projectId}
      group by 1, 2)
    select req.provider, req.external_key as key, req.title, req.status, req.url,
      (select array_agg(tc.key order by tc.key) from test_case tc where tc.id = any(req.tc_ids)) as tests,
      (select array_agg(coalesce(s.category, 'OPEN')) from unnest(req.tc_ids) t(id)
         left join lateral (select e.status from test_execution e where e.test_case_id = t.id and e.executed_at is not null order by e.executed_at desc limit 1) last on true
         left join execution_status s on s.code = last.status) as last_results
    from req order by req.external_key`;
  return rows.map((r) => {
    const res = r.lastResults ?? [];
    const state = res.some(isNotOk) ? 'failing' : res.length && res.every(isPassed) ? 'passed' : res.some(isPassed) ? 'partial' : 'untested';
    return { ...r, state, resolved: isResolvedStatus(r.status) };
  });
}

// ---------------------------------------------------------------------------------------------
// Sprachmodell: Entwürfe
// ---------------------------------------------------------------------------------------------

/**
 * Modell für einen Skill: Profil laut Skill (Standard bzw. „stark“), Rückfall auf das Standardmodell. Projekte mit
 * gesperrten externen Diensten erhalten nur ein on-prem-Modell.
 */
async function llmFor(db: Db, projectId: string, skill: string): Promise<{ cfg: LlmConfig; system: string }> {
  const { system, profile } = await promptFor(db, skill, projectId);
  const [p] = await db<{ externalServices: string }[]>`select external_services from project where id = ${projectId}`;
  const blocked = p?.externalServices !== 'allowed';
  // ein fehlerhaft eingerichtetes Profil fällt auf das andere zurück; erst wenn keines brauchbar ist, gibt es den Fehler
  let configError: string | null = null;
  const conf = (pr: Profile) => { try { return llmConfig(undefined, pr); } catch (e) { configError = (e as Error).message; return null; } };
  const candidates = [conf(profile), conf('default')].filter((c): c is LlmConfig => !!c);
  if (!candidates.length && configError) throw new HttpError(409, `KI-Einstellungen fehlerhaft: ${configError}`);
  if (!candidates.length) throw new HttpError(409, aiState().enabled ? 'Kein KI-Modell eingerichtet (Administration → KI)' : 'KI-Funktionen sind ausgeschaltet (Administration → KI)');
  const cfg = candidates.find((c) => !blocked || c.onPrem);
  if (!cfg) throw new HttpError(409, 'Für dieses Projekt sind externe Dienste gesperrt (nur ein als on-prem gekennzeichnetes Modell ist erlaubt)');
  return { cfg, system };
}

export async function draftFromRequirement(db: Db, projectId: string, requirement: string, actor = 'system') {
  const { cfg, system } = await llmFor(db, projectId, 'testcase-draft');
  const d = parseJson<{ title: string; objective?: string; preconditions?: string; steps?: { action: string; data?: string; expected: string }[]; gherkin?: string }>(
    await ask(db, cfg, { feature: 'testcase-draft', actor, projectId }, system, asData(`Anforderung:\n${requirement.slice(0, 12_000)}`)));
  if (!d.title || !Array.isArray(d.steps)) throw new HttpError(502, 'KI-Antwort unvollständig – bitte erneut versuchen');
  return {
    title: d.title.slice(0, 200), objective: d.objective ?? null, preconditions: d.preconditions ?? null, gherkin: d.gherkin ?? null,
    steps: d.steps.slice(0, 30).map((s) => ({ action: String(s.action ?? ''), data: String(s.data ?? ''), expected: String(s.expected ?? '') })),
    model: cfg.model, aiAssisted: `testcase-draft · ${cfg.model}`,
  };
}

export async function summarizeCluster(db: Db, projectId: string, c: Cluster, actor = 'system'): Promise<string> {
  const { cfg, system } = await llmFor(db, projectId, 'failure-cluster');
  return (await ask(db, cfg, { feature: 'failure-cluster', actor, projectId }, system,
    asData(`Befunde fehlgeschlagener Tests (${c.size} ähnlich):\n${c.samples.map((s, i) => `${i + 1}. ${s}`).join('\n')}\nBetroffene Testfälle: ${c.testCases.slice(0, 20).join(', ')}`), 300)).trim();
}

const clip = (s: string | null | undefined, n = 3000) => (s ?? '').slice(0, n);

/**
 * Eingaben für das Sprachmodell als Daten abgrenzen (Sicherheits-Review Teil 2, Befund 15): Testfalltexte, Befunde,
 * Ticket- und Änderungstexte stehen in <daten>…</daten>; der Systemprompt (`promptFor`) erklärt sie zu Daten. Abgrenzer
 * im Text selbst werden unschädlich gemacht, damit kein Inhalt den Datenblock vorzeitig schließt.
 */
export function asData(text: string): string {
  return `<daten>\n${text.replace(/<\s*\/?\s*daten\b[^>]*>/giu, (m) => m.replace(/</g, '‹').replace(/>/g, '›'))}\n</daten>`;
}

/** Skill „Testfall prüfen“: Befunde zum (ungespeicherten) Inhalt aus dem Editor. */
export async function reviewTestCase(db: Db, projectId: string, c: {
  title: string; objective?: string | null; preconditions?: string | null; testData?: string | null; format?: string; gherkin?: string | null;
  steps?: { action?: string; data?: string; expected?: string }[]; dataset?: { columns: string[]; rows: string[][] } | null;
  /** Testanweisung eines Freitext-Testfalls (Format PLAIN) */
  plainText?: string | null;
}, actor: string) {
  const { cfg, system } = await llmFor(db, projectId, 'testcase-review');
  const text = [
    `Titel: ${c.title}`, c.objective && `Ziel: ${clip(c.objective)}`, c.preconditions && `Vorbedingungen: ${clip(c.preconditions)}`,
    c.testData && `Testdaten: ${clip(c.testData)}`,
    c.format === 'GHERKIN' ? `Gherkin:\n${clip(c.gherkin, 8000)}`
      // Freitext: Testanweisung statt (leerer) Schritte – sonst bemängelt die KI fehlende Schritte (Review Teil 3, Befund 19)
      : c.format === 'PLAIN' ? `Format: Freitext (bewusst ohne Einzelschritte)\nTestanweisung:\n${clip(c.plainText, 8000)}`
      : `Schritte:\n${stepLines(c.steps ?? [], (s, no) => `${no}. Aktion: ${clip(s.action, 800)} | Testdaten: ${clip(s.data, 400)} | Erwartet: ${clip(s.expected, 800)}`)}`,
    c.dataset?.columns.length && `Datensatz-Spalten: ${c.dataset.columns.join(', ')} (${c.dataset.rows.length} Zeilen)`,
  ].filter(Boolean).join('\n');
  const d = parseJson<{ findings?: { severity?: string; step?: number | null; problem?: string; suggestion?: string }[] }>(
    await ask(db, cfg, { feature: 'testcase-review', actor, projectId }, system, asData(text), 1500));
  const findings = (d.findings ?? []).filter((f) => f.problem).slice(0, 12).map((f) => ({
    severity: ['hoch', 'mittel', 'niedrig'].includes(String(f.severity)) ? String(f.severity) : 'mittel',
    step: typeof f.step === 'number' && f.step > 0 ? f.step : null, problem: String(f.problem), suggestion: String(f.suggestion ?? ''),
  }));
  return { findings, model: cfg.model };
}

/** Skill „Fehlermeldung formulieren“ aus einer Ausführung (fehlgeschlagener Schritt, Befunde, Konfiguration, Evidenzen). */
export async function writeDefect(db: Db, executionId: string, actor: string) {
  const e = await getExecution(db, executionId);
  const c = await getCycle(db, e.cycleId);
  const { cfg, system } = await llmFor(db, c.projectId, 'defect-write');
  const results = new Map(e.stepResults.map((r) => [r.stepId, r]));
  const atts = await listAttachments(db, 'TEST_EXECUTION', executionId);
  const text = [
    `Testfall: ${e.testCase.key} ${e.version.title} (v${e.version.versionNo})`,
    e.version.preconditions && `Vorbedingungen: ${clip(e.version.preconditions)}`,
    e.version.format === 'PLAIN' && `Testanweisung (Freitext):\n${clip(e.version.plainText, 4000)}`,
    `Schritte und Ergebnisse:\n${stepLines(e.steps, (s, no) => {
      const r = results.get(s.id!);
      return `${no}. ${clip(s.action, 600)} → erwartet: ${clip(s.expected, 600)} → Status: ${r?.status ?? 'NOT_EXECUTED'}${r?.comment ? `, Befund: ${clip(r.comment, 800)}` : ''}`;
    })}`,
    e.iterations?.length && `Durchläufe:\n${e.iterations.map((i) => {
      const steps = i.stepResults.filter((r) => r.status !== 'NOT_EXECUTED').map((r) => {
        const no = stepNumbers(e.steps)[e.steps.findIndex((s) => s.id === r.stepId)] ?? '–';
        return `Schritt ${no}: ${r.status}${r.comment ? ` – ${clip(r.comment, 400)}` : ''}`;
      });
      return `- Durchlauf ${i.index + 1} (${Object.entries(i.values).map(([k, v]) => `${k}=${v}`).join(', ')}): ${i.status}${i.comment ? ` – ${clip(i.comment, 300)}` : ''}${steps.length ? `\n  ${steps.join('\n  ')}` : ''}`;
    }).join('\n')}`,
    `Gesamtstatus: ${e.status}`, e.comment && `Kommentar des Testers: ${clip(e.comment)}`,
    `Umgebung: Zyklus ${c.name}; Release ${c.release ?? 'unbekannt'}; Build ${c.build ?? 'unbekannt'}; Umgebung ${c.environment ?? 'unbekannt'}; Konfiguration ${JSON.stringify((c as { configuration?: unknown }).configuration ?? {})}`,
    atts.length && `Angehängte Dateien: ${atts.map((a) => a.fileName).join(', ')}`,
  ].filter(Boolean).join('\n');
  const d = parseJson<{ title?: string; steps?: string[]; expected?: string; actual?: string; environment?: string; severity?: string; notes?: string }>(
    await ask(db, cfg, { feature: 'defect-write', actor, projectId: c.projectId }, system, asData(text), 1500));
  if (!d.title) throw new HttpError(502, 'KI-Antwort unvollständig – bitte erneut versuchen');
  const body = [
    `h3. Schritte zur Reproduktion`, ...(d.steps ?? []).map((s) => `# ${s}`),
    `h3. Erwartetes Ergebnis`, d.expected ?? 'unbekannt', `h3. Tatsächliches Ergebnis`, d.actual ?? 'unbekannt',
    `h3. Umgebung`, d.environment ?? 'unbekannt', d.notes ? `h3. Hinweise\n${d.notes}` : '',
  ].filter(Boolean).join('\n');
  return { title: d.title.slice(0, 200), body, severity: d.severity ?? null, model: cfg.model };
}

/** Skill „Fazit für den Abschlussbericht“ aus Cockpit-Daten des Testplans. */
export async function draftAssessment(db: Db, planId: string, actor: string) {
  const k = await cockpit(db, planId, actor);
  const [plan] = await db<{ projectId: string; description: string | null }[]>`select project_id, description from test_plan where id = ${planId}`;
  const { cfg, system } = await llmFor(db, plan!.projectId, 'completion-assessment');
  const text = [
    `Testplan: ${k.plan.name}${k.plan.release ? ` (Release ${k.plan.release})` : ''}`,
    plan!.description && `Ziele und Kriterien: ${clip(plan!.description, 4000)}`,
    `Stand je Testfall: ${k.current.byStatus.map((s) => `${s.name} ${s.count}`).join(', ')} (gesamt ${k.current.total}, Bestehensquote ${k.current.passRate ?? '–'} %)`,
    `Abdeckung der Anforderungen: OK ${k.coverage.totals.OK}, Fehler ${k.coverage.totals.NOK}, nicht (vollständig) getestet ${k.coverage.totals.NOT_RUN}, ohne Testfall ${k.coverage.totals.UNCOVERED}`,
    `Offene Fehler (${k.openDefects.length}): ${k.openDefects.slice(0, 30).map((d) => `${d.key} ${d.title ?? ''} [${d.status ?? '?'}]`).join('; ')}`,
    `Fehlgeschlagen/blockiert (${k.problems.length}): ${k.problems.slice(0, 30).map((p) => `${p.key} ${p.title}`).join('; ')}`,
    `Geändert, aber nicht erneut getestet: ${k.changedNotTested.length}`,
    k.criteria.length && `Ausstiegskriterien: ${k.criteria.map((c) => `${c.label} Ziel ${c.target}, Ist ${c.actual} → ${c.met ? 'erfüllt' : 'NICHT erfüllt'}`).join('; ')}`,
    k.risks.length && `Bekannte Restrisiken: ${k.risks.join('; ')}`,
    `Regelbasierte Empfehlung: ${k.assessment.recommendation} – ${k.assessment.reasons.join('; ')}`,
  ].filter(Boolean).join('\n');
  const d = parseJson<{ assessment?: string; risks?: { risk: string; reason: string }[]; recommendation?: string; conditions?: string[] }>(
    await ask(db, cfg, { feature: 'completion-assessment', actor, projectId: plan!.projectId }, system, asData(text), 1500));
  if (!d.assessment) throw new HttpError(502, 'KI-Antwort unvollständig – bitte erneut versuchen');
  const wiki = [
    `*Empfehlung: ${d.recommendation ?? 'unbekannt'}*`, '', d.assessment,
    d.risks?.length ? `\nh4. Restrisiken\n${d.risks.map((r) => `* *${r.risk}* – ${r.reason}`).join('\n')}` : '',
    d.conditions?.length ? `\nh4. Bedingungen\n${d.conditions.map((c) => `* ${c}`).join('\n')}` : '',
  ].filter((x) => x !== '').join('\n');
  return { text: wiki, recommendation: d.recommendation ?? null, model: cfg.model };
}

/**
 * Skill „Risikobasierte Testauswahl“: Das Modell justiert den regelbasierten Risikowert der vorderen Kandidaten anhand der
 * Änderungsbeschreibung; jede Anpassung bleibt als Faktor „KI-Einschätzung“ mit Begründung sichtbar.
 */
export async function refineRisk(db: Db, projectId: string, items: RiskItem[], change: string, actor: string) {
  const { cfg, system } = await llmFor(db, projectId, 'test-prioritization');
  const top = items.filter((i) => !i.inCycle).slice(0, 80);
  const text = [
    `Änderungen im Release:\n${clip(change || '(keine Beschreibung – nur nach Risikofaktoren beurteilen)', 6000)}`,
    `Testfälle (Schlüssel | Titel | Komponenten | Risikowert | Faktoren):`,
    ...top.map((i) => `${i.key} | ${clip(i.title, 140)} | ${i.components.join(', ') || '–'} | ${i.score} | ${i.factors.map((f) => `${f.label} ${f.points}`).join(', ') || '–'}`),
  ].join('\n');
  const d = parseJson<{ summary?: string; adjustments?: { key: string; delta: number; reason?: string }[] }>(
    await ask(db, cfg, { feature: 'test-prioritization', actor, projectId }, system, asData(text), 2500));
  const byKey = new Map(top.map((i) => [i.key, i]));
  let applied = 0;
  for (const a of (d.adjustments ?? []).slice(0, 25)) {
    const it = byKey.get(String(a.key));
    const delta = Math.max(-30, Math.min(30, Math.round(Number(a.delta) || 0)));
    if (!it || !delta) continue;
    it.factors.push({ key: 'ai', label: 'KI-Einschätzung', points: delta, detail: clip(String(a.reason ?? ''), 300) });
    it.score = Math.max(0, it.score + delta);
    applied++;
  }
  return { summary: d.summary ?? null, applied, model: cfg.model };
}

export function assistRoutes(app: Hono, db: Db): void {
  const tag = 'Assistenz';
  const read = { level: 'read' as const, project: ({ params }: { params: Record<string, string> }) => ({ kind: 'project' as const, key: params.key! }) };
  const pid = async (key: string) => (await getProject(db, key)).id;
  route(app, { method: 'get', path: '/api/assist/status', tag, summary: 'Ist ein KI-Modell eingerichtet und eingeschaltet?' }, async () => {
    const s = aiState();
    return { enabled: s.enabled, llm: s.llm };
  });
  route(app, { method: 'get', path: '/api/projects/:key/assist/similar', tag, summary: 'Ähnliche Testfälle (Duplikatkandidaten)', access: read, query: z.object({ min: z.coerce.number().min(0.3).max(1).default(0.6) }) },
    async ({ params, query }) => similarTestCases(db, await pid(params.key!), query.min));
  route(app, {
    method: 'get', path: '/api/projects/:key/assist/clusters', tag, summary: 'Fehlerursachen-Cluster (ähnliche Befunde/gleiche Fehler); KI-Zusammenfassung ab Recht „Pflegen“',
    access: ({ query, params }) => ({ level: (query as { summarize?: boolean }).summarize ? 'edit' : 'read', project: () => ({ kind: 'project', key: (params as Record<string, string>).key! }) }),
    query: z.object({ planId: z.uuid().optional(), days: z.coerce.number().int().min(1).max(3650).default(180), summarize: z.stringbool().optional() }),
  }, async ({ params, query, actor }) => {
    const id = await pid(params.key!);
    const clusters = await failureClusters(db, id, query);
    if (query.summarize) {
      await Promise.all(clusters.slice(0, 5).map(async (c) => { c.summary = await summarizeCluster(db, id, c, actor).catch((e) => `(${(e as Error).message})`); }));
    }
    return clusters;
  });
  route(app, { method: 'get', path: '/api/projects/:key/assist/coverage', tag, summary: 'Anforderungsabdeckung (verknüpfte Anforderungen × letzte Ergebnisse)', access: read },
    async ({ params }) => coverage(db, await pid(params.key!)));
  route(app, {
    method: 'post', path: '/api/projects/:key/assist/draft', tag, summary: 'Testfall-Entwurf aus Anforderungstext (KI, speichert nichts)',
    access: { level: 'edit', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
    body: z.object({ requirement: z.string().min(20).max(20_000) }),
  }, async ({ params, body, actor }) => draftFromRequirement(db, await pid(params.key!), body.requirement, actor));
  route(app, {
    method: 'post', path: '/api/projects/:key/assist/review', tag, summary: 'Testfall prüfen (KI): Befunde zum Inhalt aus dem Editor, speichert nichts',
    access: { level: 'edit', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
    body: z.object({
      title: z.string().max(500), objective: z.string().max(20_000).nullish(), preconditions: z.string().max(20_000).nullish(), testData: z.string().max(20_000).nullish(),
      format: z.string().optional(), gherkin: z.string().max(50_000).nullish(),
      steps: z.array(z.object({ action: z.string().max(10_000).optional(), data: z.string().max(5000).optional(), expected: z.string().max(10_000).optional() })).max(200).optional(),
      dataset: z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.string())) }).nullish(),
      plainText: z.string().max(50_000).nullish(),
    }),
  }, async ({ params, body, actor }) => reviewTestCase(db, await pid(params.key!), body, actor));
  route(app, {
    method: 'post', path: '/api/executions/:id/assist/defect', tag, summary: 'Fehlermeldung formulieren (KI) aus Ausführung, Befunden und Konfiguration',
    access: { level: 'execute', project: ({ params }) => ({ kind: 'execution', id: params.id! }) },
  }, ({ params, actor }) => writeDefect(db, params.id!, actor));
  route(app, {
    method: 'post', path: '/api/plans/:id/assist/assessment', tag, summary: 'Fazit für den Abschlussbericht entwerfen (KI), speichert nichts',
    access: { level: 'edit', project: ({ params }) => ({ kind: 'plan', id: params.id! }) },
  }, ({ params, actor }) => draftAssessment(db, params.id!, actor));

  route(app, {
    method: 'post', path: '/api/projects/:key/risk-selection', tag,
    summary: 'Risikobasierte Testauswahl: Risikowert je Testfall mit Faktoren und Vorschlag im Zeit-/Mengenbudget; optional KI-Verfeinerung',
    access: { level: 'edit', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
    body: z.object({
      aql: z.string().max(4000).optional(), cycleId: z.uuid().optional(),
      budgetMinutes: z.number().int().min(1).max(100_000).optional(), maxTests: z.number().int().min(1).max(1000).optional(), minScore: z.number().min(0).max(200).optional(),
      change: z.object({ text: z.string().max(20_000).optional(), components: z.array(z.string().max(200)).max(100).optional(), requirements: z.array(z.string().max(100)).max(200).optional() }).optional(),
      ai: z.boolean().optional(),
    }),
  }, async ({ params, body, actor }) => {
    const p = await getProject(db, params.key!);
    const o = { ...body, maxTests: body.maxTests ?? (body.budgetMinutes ? undefined : 30), actor };
    const ranked = await riskRanking(db, p.id, o);
    let r = { items: ranked.items, summary: ranked.summary, weights: ranked.weights };
    let ai: Awaited<ReturnType<typeof refineRisk>> | null = null;
    if (body.ai && r.items.length) {
      ai = await refineRisk(db, p.id, r.items, body.change?.text ?? '', actor);
      r = select(r.items, o);
    }
    const shown = Math.max(300, r.summary.selected);
    // truncated: Liste gekürzt oder (candidatesTruncated) mehr Kandidaten als bewertet – mit Hinweis (Review Teil 3, Befund 17)
    return { ...r, items: r.items.slice(0, shown), truncated: r.items.length > shown || ranked.truncated,
      candidatesTruncated: ranked.truncated, candidateLimit: ranked.candidateLimit, hint: ranked.hint, ai };
  });

  // ---- Administration: Zustand, Funktionen, Nutzung, Prompts, Verbindungstest ----
  const atag = 'Administration: KI';
  route(app, { method: 'get', path: '/api/admin/ai', tag: atag, summary: 'KI: Zustand, Funktionen und ihre Verfügbarkeit, Nutzung der letzten 30 Tage', access: 'admin' }, async () => {
    const s = aiState();
    const usage = await db<{ feature: string; calls: number; errors: number; avgMs: number; lastAt: Date }[]>`
      select feature, count(*)::int as calls, count(*) filter (where not ok)::int as errors, avg(duration_ms)::int as avg_ms, max(at) as last_at
      from ai_call_log where at > now() - interval '30 days' group by feature order by calls desc`;
    const [h] = await db<{ n: number }[]>`select count(*)::int as n from ai_call_log where at > now() - interval '1 hour'`;
    const recentErrors = await db<{ at: Date; feature: string; error: string }[]>`select at, feature, error from ai_call_log where not ok order by id desc limit 5`;
    const [blocked] = await db<{ n: number }[]>`select count(*)::int as n from project where external_services <> 'allowed'`;
    const llm = s.llm ? 'aktiv' : s.enabled ? 'ohne Modell' : 'aus';
    const features = [
      { key: 'testcase-draft', title: 'Testfall-Entwurf aus Anforderung', where: 'Testfälle → ✨ Aus Anforderung', kind: 'Sprachmodell', status: llm },
      { key: 'testcase-review', title: 'Testfall prüfen', where: 'Testfall-Editor → ✨ Prüfen', kind: 'Sprachmodell', status: llm },
      { key: 'defect-write', title: 'Fehlermeldung formulieren', where: 'Durchführung → 🐞 Fehler melden → ✨ Formulieren', kind: 'Sprachmodell', status: llm },
      { key: 'completion-assessment', title: 'Fazit für den Abschlussbericht', where: 'Release-Cockpit → ✨ Fazit entwerfen', kind: 'Sprachmodell (Profil „stark“, sonst Standard)', status: llm },
      { key: 'failure-cluster', title: 'Fehlerursachen zusammenfassen', where: 'Test-Health → Analysen → Fehlerursachen', kind: 'Sprachmodell (Cluster selbst regelbasiert)', status: llm === 'aktiv' ? 'aktiv' : 'regelbasiert' },
      { key: 'test-prioritization', title: 'Risikobasierte Testauswahl', where: 'Zyklus → + Tests aufnehmen → ⚖ Risikobasiert (✨ mit KI verfeinern)', kind: 'regelbasiert, optional verfeinert durch Sprachmodell', status: llm === 'aktiv' ? 'aktiv' : 'regelbasiert' },
      { key: 'similar', title: 'Ähnliche Testfälle / Duplikate', where: 'Test-Health → Analysen', kind: 'regelbasiert (Textähnlichkeit)', status: 'aktiv' },
      { key: 'coverage', title: 'Anforderungsabdeckung', where: 'Test-Health → Analysen', kind: 'regelbasiert', status: 'aktiv' },
      { key: 'agents', title: 'KI-Agenten führen Tests aus (MCP)', where: 'Planung → 🤖 Freigaben; externe Agenten über /api/mcp', kind: 'externer Agent, Ergebnisse mit QA-Freigabe', status: s.agentsEnabled ? 'aktiv' : 'aus' },
    ];
    return { ...s, features, usage, lastHour: h?.n ?? 0, recentErrors, blockedProjects: blocked?.n ?? 0 };
  });
  route(app, {
    method: 'post', path: '/api/admin/ai/test', tag: atag, summary: 'Verbindung zum Sprachmodell prüfen (kurze Testanfrage, je Profil)', access: 'admin',
    body: z.object({ profile: z.enum(['default', 'strong']).default('default') }).optional(),
  }, async ({ actor, body }) => {
    let cfg: LlmConfig | null;
    try { cfg = llmConfig(undefined, body?.profile ?? 'default'); } catch (e) { return { ok: false, message: (e as Error).message }; }
    if (!cfg) return { ok: false, message: aiState().enabled ? `Kein Modell im Profil ${body?.profile === 'strong' ? '„stark“' : 'Standard'} eingerichtet` : 'KI ist ausgeschaltet' };
    const t0 = Date.now();
    try {
      // großzügig bemessen: Reasoning-Modelle (z. B. Qwen3) denken vor der Antwort
      const out = await ask(db, cfg, { feature: 'admin-test', actor, projectId: null }, 'Antworte ausschließlich mit dem Wort OK.', 'Verbindungstest', 1000);
      if (!out.trim()) return { ok: false, message: `${cfg.model} antwortet, aber ohne Text – vermutlich verbraucht die Denkphase alle Token. Denkphase abschalten (Zusätzliche Anfrageparameter, z. B. {"chat_template_kwargs": {"enable_thinking": false}}).` };
      return { ok: true, message: `Antwort „${out.trim().slice(0, 40)}“ in ${Date.now() - t0} ms von ${cfg.model}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });
  route(app, { method: 'get', path: '/api/admin/ai/prompts', tag: atag, summary: 'Prompts der KI-Funktionen (Standard und Anpassung)', access: 'admin' }, () => listPrompts(db));
  route(app, {
    method: 'put', path: '/api/admin/ai/prompts/:key', tag: atag, summary: 'Prompt anpassen (system null = Standard wiederherstellen)', access: 'admin', status: 204,
    body: z.object({ system: z.string().min(20).max(20_000).nullable(), profile: z.enum(['default', 'strong']).optional() }),
  }, async ({ params, body, actor }) => {
    if (!(await savePrompt(db, params.key!, body.system, actor, body.profile))) throw new HttpError(404, `Unbekannter Prompt: ${params.key}`);
  });
}

/** Schrittliste für KI-Kontexte: höchstens 40 Prüfschritte, Abschnitte (J1) als „== Titel ==“-Zeile. */
function stepLines<S extends object>(steps: readonly S[], line: (s: S, no: number) => string): string {
  const nos = stepNumbers(steps);
  const out: string[] = [];
  for (let i = 0; i < steps.length && (nos[i] ?? 0) <= 40; i++) {
    const s = steps[i]!;
    out.push(isGroup(s) ? `== Abschnitt: ${groupTitle(s)} ==` : line(s, nos[i]!));
  }
  return out.join('\n');
}
