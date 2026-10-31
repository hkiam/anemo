/**
 * Berichte als eigenständiges, druckfertiges HTML (A4, „Drucken → Als PDF speichern“) und als Markdown.
 * Inhalte aus Testfällen sind Jira-Markup und werden über den gemeinsamen Parser sicher gerendert.
 */
import { esc, wikiToHtml } from '../../../../shared/wiki/html.ts';
import { wikiToMarkdown } from '../integrations/index.ts';
import type { AttachmentRef, CompletionReport, ExecutionRow, Report, Specification, StatusCount, Summary, TestLog } from './data.ts';
import type { Burndown, StatusReport } from './status.ts';

export interface ProfileOptions {
  organization: string;
  accentColor: string;
  footer: string;
  standardNote: boolean;
  signoffRoles: string[];
  sections: {
    summary: boolean; environment: boolean; executions: boolean; steps: boolean; comments: boolean;
    defects: boolean; openItems: boolean; evidence: boolean; signoff: boolean;
  };
}

export const KIND_TITLE: Record<Report['kind'], string> = {
  'test-log': 'Testprotokoll', status: 'Teststatusbericht', completion: 'Testabschlussbericht', specification: 'Testfallspezifikation', traceability: 'Rückverfolgbarkeit',
};
const KIND_STANDARD: Record<Report['kind'], string> = {
  'test-log': 'Test Log', status: 'Test Status Report', completion: 'Test Completion Report', specification: 'Test Case Specification', traceability: 'Traceability Matrix',
};
const FINDING: Record<string, string> = { bug: '🐞 Fehler', question: '❓ Frage', idea: '💡 Idee', note: '📝 Notiz' };
const DECISION: Record<string, string> = { released: 'Freigegeben', conditional: 'Mit Auflagen freigegeben', rejected: 'Nicht freigegeben' };
const COVERAGE: Record<string, [string, string]> = {
  OK: ['abgedeckt, bestanden', '#1f845a'], NOK: ['Fehler', '#c9372c'], NOT_RUN: ['nicht (vollständig) getestet', '#b65c02'], UNCOVERED: ['ohne Testfall', '#626f86'],
};
const RECOMMENDATION = {
  release: ['Freigabe empfohlen', '#1f845a'],
  conditional: ['Freigabe unter Vorbehalt', '#b65c02'],
  'not-recommended': ['Freigabe nicht empfohlen', '#c9372c'],
  insufficient: ['Keine Aussage möglich', '#626f86'],
} as const;

const fmt = (d: Date | string | null | undefined, withTime = true) =>
  d ? new Date(d).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', ...(withTime ? { timeStyle: 'short' } : {}) }) : '–';
const v = (s: string | null | undefined) => (s && s.trim() ? esc(s) : '–');
const period = (a: Date | null, b: Date | null) => (a || b ? `${fmt(a, false)} – ${fmt(b, false)}` : '–');

/** Bildauflösung gegen Anhänge; verwendete Anhänge werden gesammelt (für das Lieferpaket). */
export type AttachmentUrl = (a: AttachmentRef) => string;
function resolver(list: AttachmentRef[], url: AttachmentUrl, used: Map<string, AttachmentRef>) {
  return (src: string) => {
    const jira = /\/secure\/(?:attachment|thumbnail)\/(\d+)\//.exec(src);
    const name = src.split('/').pop()!.trim().toLowerCase();
    const hit = jira ? list.find((a) => a.sourceKey === `jira-${jira[1]}`) : list.find((a) => a.fileName.toLowerCase() === name);
    if (!hit) return null;
    used.set(hit.id, hit);
    return url(hit);
  };
}

const isImage = (a: AttachmentRef) => /^image\/(png|jpe?g|gif|webp)$/.test(a.contentType ?? '') || /\.(png|jpe?g|gif|webp)$/i.test(a.fileName);

function badge(code: string, statuses: StatusCount[]): string {
  const s = statuses.find((x) => x.code === code);
  const c = /^#[0-9a-f]{3,8}$/i.test(s?.color ?? '') ? s!.color : '#888888';
  return `<span class="badge" style="background:${c}1f;color:${c};border-color:${c}66">${esc(s?.name ?? code)}</span>`;
}

function summaryHtml(s: Summary, statuses: StatusCount[], label = 'Testfälle'): string {
  const bar = s.byStatus.map((b) => `<span style="flex:${b.count};background:${/^#[0-9a-f]{3,8}$/i.test(b.color) ? b.color : '#888'}" title="${esc(b.name)}: ${b.count}"></span>`).join('');
  return `
    <div class="kpis">
      <div><b>${s.total}</b><span>${label}</span></div>
      <div><b>${s.executed}</b><span>ausgeführt</span></div>
      <div><b>${s.passRate === null ? '–' : `${s.passRate.toLocaleString('de-DE')} %`}</b><span>Bestehensquote</span></div>
      <div><b>${s.failed}</b><span>fehlgeschlagen/blockiert</span></div>
      <div><b>${s.open}</b><span>offen</span></div>
    </div>
    <div class="bar">${bar}</div>
    <table class="compact"><tr>${s.byStatus.map((b) => `<td>${badge(b.code, statuses)} ${b.count}</td>`).join('')}</tr></table>`;
}

function defectsHtml(d: { provider: string; key: string; title: string | null; status: string | null; url: string | null }[]): string {
  // freie Links: Kurzname statt Adresse
  const label = (x: { provider: string; key: string; title: string | null }) => (x.provider === 'url' && x.title ? x.title : x.key);
  return d.map((x) => `${x.url && /^https?:\/\//i.test(x.url) ? `<a href="${esc(x.url)}">${esc(label(x))}</a>` : esc(label(x))}${x.status ? ` <span class="muted">(${esc(x.status)})</span>` : ''}`).join(', ') || '–';
}

function executionsHtml(rows: ExecutionRow[], r: Report, o: ProfileOptions, url: AttachmentUrl, used: Map<string, AttachmentRef>, showCycle = false): string {
  return `<table class="grid">
    <thead><tr><th>Testfall</th>${showCycle ? '<th>Zyklus</th>' : ''}<th>Titel</th><th>Ver.</th><th>Status</th><th>Ausgeführt</th><th>Fehler</th></tr></thead>
    <tbody>${rows.map((e) => {
      const img = resolver([...e.attachments, ...e.testCaseAttachments], url, used);
      const detail: string[] = [];
      if (o.sections.comments && e.comment?.trim()) detail.push(`<div class="comment"><b>Befund:</b> ${wikiToHtml(e.comment, img)}</div>`);
      if (e.iterations.length) {
        const cols = Object.keys(e.iterations[0]!.values);
        detail.push(`<table class="steps"><thead><tr><th>#</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}<th>Ergebnis</th></tr></thead><tbody>${e.iterations.map((i) =>
          `<tr><td>${i.index + 1}</td>${cols.map((c) => `<td>${esc(i.values[c] ?? '')}</td>`).join('')}<td>${badge(i.status, r.statuses)}${i.comment ? `<div>${wikiToHtml(i.comment, img)}</div>` : ''}
            ${i.stepResults.filter((x) => x.status !== 'NOT_EXECUTED' && (x.comment || !['PASS'].includes(x.status))).map((x) => {
              const found = e.steps.find((st) => st.stepId === x.stepId)?.no ?? 0;
              // ohne Schrittdetails im Profil bzw. Schritt eines aufgerufenen Testfalls („aufrufId>schrittId“)
              const [outer] = x.stepId.split('>');
              const no = found ? String(found) : e.stepNos?.[x.stepId] ?? (e.stepNos?.[outer!] ? `${e.stepNos[outer!]} (Aufruf)` : '');
              return `<div class="muted">${no ? `Schritt ${no}` : 'Schritt'}: ${badge(x.status, r.statuses)}${x.comment ? ` ${wikiToHtml(x.comment, img)}` : ''}</div>`;
            }).join('')}</td></tr>`).join('')}</tbody></table>`);
      }
      if (o.sections.steps && e.steps.length) {
        detail.push(`<table class="steps"><thead><tr><th>#</th><th>Aktion</th><th>Erwartet</th><th>Ergebnis</th></tr></thead><tbody>${e.steps.map((s) => s.group != null ? groupRowHtml(s.group, 4) : `
          <tr><td>${s.no}</td><td>${wikiToHtml(s.action, img)}${s.data ? `<div class="muted">${wikiToHtml(s.data, img)}</div>` : ''}</td>
          <td>${wikiToHtml(s.expected, img)}</td><td>${badge(s.status, r.statuses)}${s.comment ? `<div>${wikiToHtml(s.comment, img)}</div>` : ''}</td></tr>`).join('')}</tbody></table>`);
      }
      if (o.sections.evidence && e.attachments.length) {
        detail.push(`<div class="evidence">${e.attachments.map((a) => {
          used.set(a.id, a);
          return isImage(a) ? `<figure><img src="${esc(url(a))}" alt="${esc(a.fileName)}"><figcaption>${esc(a.fileName)}</figcaption></figure>`
            : `<span>📎 <a href="${esc(url(a))}">${esc(a.fileName)}</a></span>`;
        }).join('')}</div>`);
      }
      return `<tr class="${detail.length ? 'has-detail' : ''}"><td class="nowrap"><b>${esc(e.testCaseKey)}</b>${e.legacyKey ? `<div class="muted">${esc(e.legacyKey)}</div>` : ''}</td>
        ${showCycle ? `<td>${esc(e.cycleName)}</td>` : ''}<td>${esc(e.title)}</td><td>v${e.version}</td><td>${badge(e.status, r.statuses)}</td>
        <td class="nowrap">${e.executedBy ? `${esc(e.executedBy)}<div class="muted">${fmt(e.executedAt)}${e.durationSeconds ? ` · ${duration(e.durationSeconds)}` : ''}</div>` : '–'}</td><td>${defectsHtml(e.defects)}</td></tr>
        ${detail.length ? `<tr class="detail"><td colspan="${showCycle ? 7 : 6}">${detail.join('')}</td></tr>` : ''}`;
    }).join('')}</tbody></table>`;
}

/** Dauer lesbar: 45 s, 12 min, 1 h 05 min */
export function duration(s: number): string {
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function signoffHtml(o: ProfileOptions): string {
  return `<section class="signoff"><h2>Freigabe</h2><table class="grid"><thead><tr><th>Rolle</th><th>Name</th><th>Datum</th><th>Unterschrift</th></tr></thead>
    <tbody>${o.signoffRoles.map((r) => `<tr><td>${esc(r)}</td><td></td><td></td><td class="sign"></td></tr>`).join('')}</tbody></table></section>`;
}

function cycleEnv(c: TestLog['cycle']): string {
  return `<table class="meta">
    <tr><th>Testplan / Release</th><td>${v(c.planName)} / ${v(c.release)}</td></tr>
    <tr><th>Build</th><td>${v(c.build)}</td></tr>
    <tr><th>Umgebung</th><td>${v(c.environment)}</td></tr>
    <tr><th>Konfiguration</th><td>${v(c.configuration)}</td></tr>
    <tr><th>Zeitraum</th><td>${period(c.startDate, c.endDate)}</td></tr>
  </table>${c.description ? `<div class="desc">${wikiToHtml(c.description)}</div>` : ''}`;
}

function body(r: Report, o: ProfileOptions, url: AttachmentUrl, used: Map<string, AttachmentRef>): { subject: string; html: string } {
  const S = o.sections;
  if (r.kind === 'test-log') {
    const problems = r.executions.filter((e) => ['FAILED', 'BLOCKED'].includes(r.statuses.find((s) => s.code === e.status)?.category ?? ''));
    const open = r.executions.filter((e) => ['OPEN', 'IN_PROGRESS'].includes(r.statuses.find((s) => s.code === e.status)?.category ?? 'OPEN'));
    return {
      subject: `Testzyklus „${r.cycle.name}“`,
      html: [
        S.summary && `<section><h2>Zusammenfassung</h2>${summaryHtml(r.summary, r.statuses)}</section>`,
        S.environment && `<section><h2>Testgegenstand und Umgebung</h2>${cycleEnv(r.cycle)}</section>`,
        S.executions && `<section><h2>Protokoll der Ausführungen</h2>${executionsHtml(r.executions, r, o, url, used)}</section>`,
        r.sessions.length > 0 && `<section><h2>Explorative Sitzungen</h2>${r.sessions.map((s) => `<div class="tc"><h3>${esc(s.charter)}</h3>
          <table class="meta"><tr><th>Tester / Dauer</th><td>${v(s.tester)} · ${duration(s.durationSeconds)} von ${s.timeboxMinutes} min · ${s.status === 'done' ? 'abgeschlossen' : 'offen'}</td></tr>
          ${s.areas ? `<tr><th>Bereiche</th><td>${esc(s.areas)}</td></tr>` : ''}</table>
          ${s.summary ? `<div class="comment"><b>Zusammenfassung:</b> ${wikiToHtml(s.summary)}</div>` : ''}
          ${s.findings.length ? `<table class="steps"><thead><tr><th>Art</th><th>Fund</th><th>Übernommen</th></tr></thead><tbody>${s.findings.map((f) =>
            `<tr><td>${FINDING[f.kind] ?? esc(f.kind)}</td><td>${esc(f.text)}</td><td>${[f.defectKey, f.testCaseKey].filter(Boolean).map((x) => esc(x!)).join(', ') || '–'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Keine Funde.</p>'}</div>`).join('')}</section>`,
        S.defects && `<section><h2>Fehlerwirkungen</h2>${problems.length ? executionsHtml(problems, r, { ...o, sections: { ...S, steps: false, evidence: false } }, url, used) : '<p>Keine fehlgeschlagenen oder blockierten Tests.</p>'}</section>`,
        S.openItems && `<section><h2>Offene Punkte</h2>${open.length ? `<p>${open.length} Tests nicht abschließend ausgeführt: ${open.map((e) => esc(e.testCaseKey)).join(', ')}</p>` : '<p>Keine.</p>'}</section>`,
        S.signoff && signoffHtml(o),
      ].filter(Boolean).join(''),
    };
  }
  if (r.kind === 'status') return statusHtml(r, o, url, used);
  if (r.kind === 'completion') {
    const [label, color] = RECOMMENDATION[r.assessment.recommendation];
    return {
      subject: `Testplan „${r.plan.name}“${r.plan.release ? ` – Release ${r.plan.release}` : ''}`,
      html: [
        `<section><h2>Bewertung</h2><div class="assessment" style="border-color:${color}"><b style="color:${color}">${label}</b>
          <ul>${r.assessment.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          <p class="muted">Regelbasierte Empfehlung aus aktuellem Stand und verknüpften Fehlern – die Entscheidung trifft die Freigabe.</p></div>
          ${r.plan.assessment ? `<h3>Fazit des Testmanagements</h3><div class="desc">${wikiToHtml(r.plan.assessment)}</div><p class="muted">${esc(assessmentMeta(r))}</p>` : ''}
          ${r.releaseDecision ? `<h3>Freigabeentscheidung</h3><p><b>${esc(DECISION[r.releaseDecision.decision] ?? r.releaseDecision.decision)}</b> – ${v(r.releaseDecision.by)}, ${fmt(r.releaseDecision.at)}</p>${r.releaseDecision.note ? `<div class="desc">${wikiToHtml(r.releaseDecision.note)}</div>` : ''}${decisionMeta(r) ? `<p class="muted"><b>${esc(decisionMeta(r)!)}</b></p>` : ''}` : ''}</section>`,
        `<section><h2>Testbasis</h2><table class="meta">
          <tr><th>Testplan / Release</th><td>${esc(r.plan.name)}${r.plan.release ? ` / ${esc(r.plan.release)}` : ''}</td></tr>
          <tr><th>Anforderungen</th><td>${r.coverage.requirements} verknüpft (${r.coverage.totals.OK} bestanden, ${r.coverage.totals.NOK} mit Fehlern, ${r.coverage.totals.NOT_RUN} nicht vollständig getestet, ${r.coverage.totals.UNCOVERED} ohne Testfall)${r.coverage.deferred ? `; ${r.coverage.deferred} abgelehnt/zurückgestellt` : ''}</td></tr>
          <tr><th>Testfälle</th><td>${r.current.testCases}${r.coverage.withoutRequirement ? ` (${r.coverage.withoutRequirement} ohne Anforderung)` : ''}</td></tr>
          <tr><th>Aufwand (gemessen)</th><td>${r.effortSeconds ? duration(r.effortSeconds) : '–'}</td></tr>${r.archivedCycles ? `
          <tr><th>Nicht berücksichtigt</th><td>${r.archivedCycles} archivierte Zyklen (nicht Teil der Testbasis)</td></tr>` : ''}</table></section>`,
        r.criteria.length > 0 && `<section><h2>Ausstiegskriterien</h2><table class="grid"><thead><tr><th>Kriterium</th><th>Ziel</th><th>Ist</th><th>Erfüllt</th></tr></thead>
          <tbody>${r.criteria.map((c) => `<tr><td>${esc(c.label)}</td><td>${esc(c.target)}</td><td>${esc(c.actual)}</td><td style="color:${c.met ? '#1f845a' : '#c9372c'}"><b>${c.met ? 'ja' : 'nein'}</b></td></tr>`).join('')}</tbody></table></section>`,
        `<section><h2>Restrisiken</h2>${r.risks.length ? `<ul>${r.risks.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>Keine bekannten Restrisiken.</p>'}
          ${r.knownDefects.length ? `<h3>Bekannte, nicht behobene Fehler</h3><table class="grid"><thead><tr><th>Fehler</th><th>Titel</th><th>Status</th></tr></thead><tbody>${r.knownDefects.map((d) => `<tr><td>${defectsHtml([d])}</td><td>${v(d.title)}</td><td>${v(d.status)}</td></tr>`).join('')}</tbody></table>` : ''}</section>`,
        `<section><h2>Abweichungen vom Testplan</h2>${r.openItems.length || r.unreviewedSpec.length || r.changedNotTested.length ? `<ul>
          ${r.openItems.length ? `<li>${r.openItems.length} Testfälle nicht abschließend ausgeführt (siehe offene Punkte)</li>` : ''}
          ${r.unreviewedSpec.length ? `<li>${r.unreviewedSpec.length} Testfälle mit ungeprüfter Spezifikation ausgeführt: ${r.unreviewedSpec.slice(0, 20).map((x) => esc(x.key)).join(', ')}</li>` : ''}
          ${r.changedNotTested.length ? `<li>${r.changedNotTested.length} Testfälle nach dem Test geändert: ${r.changedNotTested.slice(0, 20).map((x) => `${esc(x.key)} (v${x.testedVersion} → v${x.currentVersion})`).join(', ')}</li>` : ''}
          </ul>` : '<p>Keine.</p>'}</section>`,
        S.summary && `<section><h2>Aktueller Stand je Testfall</h2>${summaryHtml(r.current, r.statuses)}
          <p class="muted">Je Testfall das letzte Ergebnis je Konfiguration, über Konfigurationen das schlechteste. Bestehensquote = bestanden / (bestanden + fehlgeschlagen);
          Durchführungsgrad ${r.current.executionRate === null ? '–' : `${r.current.executionRate.toLocaleString('de-DE')} %`}; blockiert ${r.current.blocked}, ungültig ${r.current.invalid}${r.current.passedWithIssues ? `, bestanden mit Einschränkung ${r.current.passedWithIssues}` : ''}.</p></section>`,
        S.environment && `<section><h2>Testumfang</h2>${r.plan.description ? `<div class="desc">${wikiToHtml(r.plan.description)}</div>` : ''}
          <table class="grid"><thead><tr><th>Zyklus</th><th>Release / Build</th><th>Konfiguration</th><th>Zeitraum</th><th>Tests</th><th>Bestanden</th><th>Fehlg./blockiert</th><th>Offen</th></tr></thead>
          <tbody>${r.cycles.map((c) => `<tr><td>${esc(c.name)}</td><td>${v(c.release)} / ${v(c.build)}</td><td>${v(c.configuration)}</td>
            <td class="nowrap">${period(c.startDate, c.endDate)}</td><td>${c.summary.total}</td>
            <td>${c.summary.passRate === null ? '–' : `${c.summary.passRate.toLocaleString('de-DE')} %`}</td><td>${c.summary.failed}</td><td>${c.summary.open}</td></tr>`).join('')}</tbody></table></section>`,
        S.defects && `<section><h2>Fehlerwirkungen (fehlgeschlagene/blockierte Tests, aktueller Stand)</h2>${r.problems.length ? executionsHtml(r.problems, r, o, url, used, true) : '<p>Keine.</p>'}</section>`,
        S.defects && r.retestPending?.length && `<section><h2>Behoben, aber nicht nachgetestet</h2><table><thead><tr><th>Testfall</th><th>Titel</th><th>Zyklus</th><th>Behobene Fehler</th></tr></thead><tbody>${r.retestPending.map((x) => `<tr><td>${esc(x.key)}</td><td>${esc(x.title)}</td><td>${esc(x.cycleName)}</td><td>${esc(x.defects.join(', '))}</td></tr>`).join('')}</tbody></table></section>`,
        S.defects && r.knownFailures?.length && `<section><h2>Bekannte Fehler (dokumentiert, blockieren die Freigabe nicht)</h2>${executionsHtml(r.knownFailures, r, { ...o, sections: { ...S, steps: false, evidence: false } }, url, used, true)}</section>`,
        S.defects && `<section><h2>Verknüpfte Fehler</h2>${r.defects.length ? `<table class="grid"><thead><tr><th>Fehler</th><th>Titel</th><th>Status</th><th>Ausführungen</th></tr></thead><tbody>${r.defects.map((d) => `<tr><td>${defectsHtml([d])}</td><td>${v(d.title)}</td><td>${v(d.status)}</td><td>${d.executions}${d.sessions ? ` (+ Sitzungsfund)` : ''}</td></tr>`).join('')}</tbody></table>` : '<p>Keine.</p>'}</section>`,
        S.openItems && `<section><h2>Offene Punkte</h2>${r.openItems.length ? executionsHtml(r.openItems, r, { ...o, sections: { ...S, steps: false, evidence: false, comments: false } }, url, used, true) : '<p>Keine.</p>'}</section>`,
        S.executions && S.steps && `<p class="muted">Einzelprotokolle je Zyklus: siehe Testprotokolle.</p>`,
        S.signoff && signoffHtml(o),
      ].filter(Boolean).join(''),
    };
  }
  if (r.kind === 'traceability') {
    const t = r.totals;
    return {
      subject: `Testplan „${r.plan.name}“${r.plan.release ? ` – Release ${r.plan.release}` : ''}${r.asOf ? ` – Stand ${fmt(r.asOf, false)}` : ''}`,
      html: `${r.asOf ? `<p class="muted">Historische Abdeckung zum Stichtag ${fmt(r.asOf, false)}: Ergebnisse laut Ergebnisverlauf bis zu diesem Tag; Verknüpfungen von Anforderungen mit heutigem Stand.</p>` : ''}<section><h2>Abdeckung der Anforderungen</h2><div class="kpis">${(['OK', 'NOK', 'NOT_RUN', 'UNCOVERED'] as const).map((k) =>
        `<div><b style="color:${COVERAGE[k]![1]}">${t[k]}</b><span>${COVERAGE[k]![0]}</span></div>`).join('')}</div>
        <p class="muted">Anforderungen am Testplan, an seinen Zyklen und an den eingeplanten Testfällen; Ergebnis = letzte Ausführung im Testplan.</p></section>
        <section><h2>Matrix</h2>${r.requirements.length ? `<table class="grid"><thead><tr><th>Anforderung</th><th>Titel</th><th>Ticket-Status</th><th>Abdeckung</th><th>Testfälle (Ergebnis)</th></tr></thead><tbody>
        ${r.requirements.map((q) => `<tr><td class="nowrap">${q.url && /^https?:\/\//i.test(q.url) ? `<a href="${esc(q.url)}">${esc(q.key)}</a>` : esc(q.key)}</td><td>${v(q.title)}</td><td>${v(q.status)}</td>
          <td><span class="badge" style="color:${COVERAGE[q.state]![1]};border-color:${COVERAGE[q.state]![1]}">${COVERAGE[q.state]![0]}</span></td>
          <td>${q.tests.map((x) => `${esc(x.key)} ${x.inPlan ? (x.status ? badge(x.status, r.statuses) : '') : '<span class="muted">(nicht eingeplant)</span>'}`).join('<br>') || '–'}</td></tr>`).join('')}
        </tbody></table>` : '<p>Keine Anforderungen verknüpft – Anforderungen am Testplan oder an Testfällen verknüpfen.</p>'}</section>
        <section><h2>Testfälle ohne Anforderung</h2>${r.testsWithoutRequirement.length ? `<p>${r.testsWithoutRequirement.map((x) => `${esc(x.key)} ${esc(x.title)}`).join(' · ')}</p>` : '<p>Keine.</p>'}</section>
        ${o.sections.signoff ? signoffHtml(o) : ''}`,
    };
  }
  return { subject: r.scope.folder ? `Ordner „${r.scope.folder}“` : 'Alle Testfälle', html: specHtml(r, url, used) };
}

/** Burn-down als eingebettete Grafik: Rest offener Ausführungen, Ideallinie bis zum geplanten Ende, Prognose. */
export function burndownSvg(b: Burndown, accent = '#3451b2'): string {
  if (!b.points.length) return '<p class="muted">Noch keine Ausführungen eingeplant.</p>';
  const W = 720, H = 200, L = 34, B = 22, T = 8;
  const max = Math.max(1, ...b.points.map((p) => Math.max(p.total, p.ideal ?? 0)));
  const x = (i: number) => L + (i * (W - L - 8)) / Math.max(1, b.points.length - 1);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const line = (vals: (number | null)[]) => vals.map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
  const endIdx = b.end ? b.points.findIndex((p) => p.day === b.end) : -1;
  const labels = b.points.map((p, i) => (i % Math.ceil(b.points.length / 8) === 0 ? `<text x="${x(i)}" y="${H - 6}" font-size="10" text-anchor="middle" fill="#626f86">${p.day.slice(8, 10)}.${p.day.slice(5, 7)}.</text>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Burn-down" style="max-width:${W}px">
    <line x1="${L}" y1="${y(0)}" x2="${W - 8}" y2="${y(0)}" stroke="#dfe1e6"/><text x="${L - 4}" y="${y(max) + 4}" font-size="10" text-anchor="end" fill="#626f86">${max}</text>
    <text x="${L - 4}" y="${y(0) + 4}" font-size="10" text-anchor="end" fill="#626f86">0</text>
    ${endIdx >= 0 ? `<line x1="${x(endIdx)}" y1="${T}" x2="${x(endIdx)}" y2="${y(0)}" stroke="#c9372c" stroke-dasharray="3 3"/><text x="${x(endIdx) - 3}" y="${T + 10}" font-size="10" text-anchor="end" fill="#c9372c">geplantes Ende</text>` : ''}
    <polyline fill="none" stroke="#8590a2" stroke-dasharray="5 4" stroke-width="1.5" points="${line(b.points.map((p) => p.ideal))}"/>
    <polyline fill="none" stroke="${accent}" stroke-width="2.5" points="${line(b.points.map((p) => p.remaining))}"/>
    ${labels}</svg>
    <p class="muted">Durchgezogen: offene Ausführungen; gestrichelt: Ideallinie bis zum geplanten Ende.</p>`;
}

export function burndownText(b: Burndown): string {
  if (!b.points.length) return 'Noch keine Ausführungen eingeplant.';
  const f = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('de-DE') : '–');
  return [
    `Stand ${f(b.asOf)}: ${b.remaining} Ausführungen offen, Tempo ${b.velocity.toLocaleString('de-DE')} erledigte je Arbeitstag (Mittel der letzten 10 Arbeitstage).`,
    b.end ? `Geplantes Ende ${f(b.end)}.` : 'Kein geplantes Ende (Zyklen ohne Enddatum).',
    b.forecast ? `Prognose: fertig am ${f(b.forecast)}${b.onTrack === false ? ` – ${b.daysLate} Arbeitstage nach Plan` : b.onTrack ? ' – im Plan' : ''}.` : b.remaining ? 'Keine Prognose möglich (noch kein Fortschritt).' : '',
  ].filter(Boolean).join(' ');
}

function statusHtml(r: StatusReport, o: ProfileOptions, url: AttachmentUrl, used: Map<string, AttachmentRef>): { subject: string; html: string } {
  const S = o.sections;
  const [label, color] = RECOMMENDATION[r.assessment.recommendation];
  const p = r.inPeriod;
  return {
    subject: `Testplan „${r.plan.name}“${r.plan.release ? ` – Release ${r.plan.release}` : ''} · Berichtszeitraum ${fmt(r.period.from, false)} – ${fmt(r.period.to, false)}`,
    html: [
      `<section><h2>Lage</h2><div class="assessment" style="border-color:${color}"><b style="color:${color}">${label}</b> (aus heutiger Sicht)
        <p>${esc(burndownText(r.burndown))}</p></div>
        ${r.statusNote ? `<h3>Lagebild des Testmanagements</h3><div class="desc">${wikiToHtml(r.statusNote.text)}</div><p class="muted">${v(r.statusNote.by)}, ${fmt(r.statusNote.at)}</p>` : '<p class="muted">Kein Lagebild hinterlegt (Hindernisse, nächste Schritte – im Release-Cockpit pflegbar).</p>'}</section>`,
      `<section><h2>Fortschritt gegen Plan</h2>${burndownSvg(r.burndown, /^#[0-9a-f]{6}$/i.test(o.accentColor) ? o.accentColor : undefined)}</section>`,
      `<section><h2>Im Berichtszeitraum</h2><div class="kpis">
        <div><b>${p.executed}</b><span>Ausführungen abgeschlossen</span></div><div><b>${p.passed}</b><span>bestanden</span></div>
        <div><b>${p.failed}</b><span>fehlgeschlagen/blockiert</span></div><div><b>${p.newDefects.length}</b><span>neue Fehler</span></div></div>
        ${p.byTester.length ? `<p>Je Person: ${p.byTester.map((t) => `${esc(t.tester)} ${t.executed}`).join(' · ')}</p>` : ''}
        ${p.newFailures.length ? `<h3>Neue Fehlschläge</h3><table class="grid"><thead><tr><th>Testfall</th><th>Titel</th><th>Zyklus</th><th>Status</th></tr></thead><tbody>${p.newFailures.map((f) => `<tr><td>${esc(f.key)}</td><td>${esc(f.title)}</td><td>${esc(f.cycleName)}</td><td>${badge(f.status, r.statuses)}</td></tr>`).join('')}</tbody></table>` : ''}
        ${p.newDefects.length ? `<h3>Neue Fehler</h3><table class="grid"><thead><tr><th>Fehler</th><th>Titel</th><th>Status</th></tr></thead><tbody>${p.newDefects.map((d) => `<tr><td>${defectsHtml([d])}</td><td>${v(d.title)}</td><td>${v(d.status)}</td></tr>`).join('')}</tbody></table>` : ''}</section>`,
      S.summary && `<section><h2>Gesamtstand je Testfall</h2>${summaryHtml(r.current, r.statuses)}</section>`,
      r.criteria.length > 0 && `<section><h2>Ausstiegskriterien (Zwischenstand)</h2><table class="grid"><thead><tr><th>Kriterium</th><th>Ziel</th><th>Ist</th><th>Erfüllt</th></tr></thead>
        <tbody>${r.criteria.map((c) => `<tr><td>${esc(c.label)}</td><td>${esc(c.target)}</td><td>${esc(c.actual)}</td><td style="color:${c.met ? '#1f845a' : '#c9372c'}"><b>${c.met ? 'ja' : 'nein'}</b></td></tr>`).join('')}</tbody></table></section>`,
      `<section><h2>Risiken und Hindernisse</h2>${r.risks.length || r.assessment.reasons.length ? `<ul>${[...new Set([...r.assessment.reasons, ...r.risks])].map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>Keine.</p>'}</section>`,
      S.defects && `<section><h2>Aktuell fehlgeschlagen/blockiert</h2>${r.problems.length ? executionsHtml(r.problems.slice(0, 50), r, { ...o, sections: { ...S, steps: false, evidence: false } }, url, used, true) : '<p>Keine.</p>'}</section>`,
    ].filter(Boolean).join(''),
  };
}

function specHtml(r: Specification, url: AttachmentUrl, used: Map<string, AttachmentRef>): string {
  return `${r.scope.truncated ? `<p class="muted">Gekürzt: ${r.testCases.length} von ${r.scope.count} Testfällen.</p>` : ''}
    <section><h2>Übersicht</h2><table class="grid"><thead><tr><th>Testfall</th><th>Titel</th><th>Ver.</th><th>Status</th><th>Ordner</th></tr></thead>
    <tbody>${r.testCases.map((t) => `<tr><td class="nowrap"><a href="#${esc(t.key)}">${esc(t.key)}</a></td><td>${esc(t.title)}</td><td>v${t.version}</td><td>${esc(t.status)}</td><td>${v(t.folder)}</td></tr>`).join('')}</tbody></table></section>
    ${r.testCases.map((t) => {
      const img = resolver(t.attachments, url, used);
      return `<section class="tc" id="${esc(t.key)}"><h2>${esc(t.key)} – ${esc(t.title)}</h2>
        <table class="meta"><tr><th>Version / Status</th><td>v${t.version} / ${esc(t.status)}</td></tr>
        ${t.legacyKey ? `<tr><th>Altschlüssel</th><td>${esc(t.legacyKey)}</td></tr>` : ''}
        <tr><th>Priorität</th><td>${v(t.priority)}</td></tr><tr><th>Labels / Komponenten</th><td>${v([...t.labels, ...t.components].join(', '))}</td></tr></table>
        ${t.objective ? `<h3>Ziel / Beschreibung</h3>${wikiToHtml(t.objective, img)}` : ''}
        ${t.preconditions ? `<h3>Vorbedingungen</h3>${wikiToHtml(t.preconditions, img)}` : ''}
        ${t.testData ? `<h3>Testdaten</h3>${wikiToHtml(t.testData, img)}` : ''}
        ${t.format === 'GHERKIN' ? `<h3>Szenario (Gherkin)</h3><pre>${esc(t.gherkin ?? '')}</pre>` : t.format === 'PLAIN' ? `<h3>Testanweisung</h3>${wikiToHtml(t.plainText ?? '', img)}` : `<h3>Schritte</h3>
          <table class="steps"><thead><tr><th>#</th><th>Aktion</th><th>Testdaten</th><th>Erwartetes Ergebnis</th></tr></thead><tbody>
          ${t.steps.map((s) => s.group != null ? groupRowHtml(s.group, 4) : `<tr><td>${s.no}</td><td>${wikiToHtml(s.action, img)}</td><td>${wikiToHtml(s.data, img)}</td><td>${wikiToHtml(s.expected, img)}</td></tr>`).join('')}</tbody></table>`}
      </section>`;
    }).join('')}`;
}

const CSS = (accent: string) => `
  @page { size: A4; margin: 16mm 14mm 18mm; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #172b4d; margin: 0 auto; max-width: 1100px; padding: 24px; }
  header.cover { border-bottom: 3px solid ${accent}; padding-bottom: 12px; margin-bottom: 18px; }
  .org { font-weight: 700; color: ${accent}; letter-spacing: .02em; }
  h1 { font-size: 22pt; margin: 4px 0; } h2 { font-size: 14pt; color: ${accent}; border-bottom: 1px solid #dfe1e6; padding-bottom: 3px; margin: 22px 0 8px; }
  h3 { font-size: 11pt; margin: 12px 0 4px; } h4, h5, h6 { font-size: 10.5pt; margin: 8px 0 3px; }
  .subject { font-size: 12pt; } .muted { color: #626f86; font-size: 9pt; } .nowrap { white-space: nowrap; }
  table { border-collapse: collapse; width: 100%; } th, td { text-align: left; vertical-align: top; padding: 4px 6px; }
  table.meta th { width: 190px; color: #626f86; font-weight: 600; } table.meta td, table.meta th { border-bottom: 1px solid #f1f2f4; }
  table.grid th { background: #f4f5f7; border-bottom: 2px solid #dfe1e6; font-size: 9pt; } table.grid td { border-bottom: 1px solid #ebecf0; }
  table.grid tr.has-detail td { border-bottom: 0; } tr.detail td { padding: 0 6px 8px 18px; border-bottom: 1px solid #ebecf0; }
  table.steps tr.group td { background: #f4f5f7; font-weight: 600; }
  table.steps { margin: 4px 0; font-size: 9.5pt; } table.steps th, table.steps td { border: 1px solid #dfe1e6; }
  table.compact td { padding: 2px 8px 2px 0; width: auto; } table.compact { width: auto; }
  .badge { display: inline-block; border: 1px solid; border-radius: 10px; padding: 0 7px; font-size: 8.5pt; font-weight: 600; white-space: nowrap; }
  .kpis { display: flex; gap: 10px; margin: 6px 0; } .kpis div { flex: 1; border: 1px solid #dfe1e6; border-radius: 6px; padding: 6px 10px; }
  .kpis b { display: block; font-size: 16pt; } .kpis span { color: #626f86; font-size: 9pt; }
  .bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin: 6px 0; background: #f1f2f4; }
  .assessment { border-left: 5px solid; padding: 6px 12px; background: #fafbfc; }
  .comment { margin: 4px 0; } .evidence { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0; }
  figure { margin: 0; width: 220px; } figure img { max-width: 100%; max-height: 160px; border: 1px solid #dfe1e6; } figcaption { font-size: 8pt; color: #626f86; }
  img.wiki-img { max-width: 100%; max-height: 260px; } .missing { color: #626f86; font-size: 9pt; }
  pre { background: #f4f5f7; padding: 6px 8px; white-space: pre-wrap; font-size: 9pt; } blockquote { border-left: 3px solid #dfe1e6; margin: 4px 0; padding-left: 8px; }
  .panel { border: 1px solid #dfe1e6; border-radius: 4px; padding: 4px 8px; margin: 4px 0; } .panel-title { font-weight: 600; }
  table.wiki-table td, table.wiki-table th { border: 1px solid #dfe1e6; }
  .signoff td.sign { height: 34px; } footer { margin-top: 28px; border-top: 1px solid #dfe1e6; padding-top: 6px; color: #626f86; font-size: 8.5pt; display: flex; justify-content: space-between; }
  section.tc { break-inside: auto; } tr, figure { break-inside: avoid; } h2 { break-after: avoid; }
  @media print { body { padding: 0; max-width: none; } a { color: inherit; text-decoration: none; } .noprint { display: none; } }
`;

/** Eigenständiges HTML-Dokument; `used` enthält danach die eingebundenen Anhänge. */
/** Verfasser, Zeitpunkt und KI-Vermerk des Fazits (Review 30.10.2026, F6) */
function assessmentMeta(r: CompletionReport): string {
  const p = r.plan;
  const by = p.assessmentBy ?? 'unbekannt';
  return `Verfasst von ${by}${p.assessmentAt ? `, ${fmt(p.assessmentAt)}` : ''}${p.assessmentAi ? ` – mit KI erstellt (Entwurf von ${p.assessmentAi}, geprüft und gespeichert von ${by})` : ''}`;
}

/** Freigabestand und Änderungen nach der Entscheidung (Review 30.10.2026, F1) */
function decisionMeta(r: CompletionReport): string | null {
  const d = r.releaseDecision;
  if (!d) return null;
  const parts: string[] = [];
  if (d.baseline?.sha256) parts.push(`Stand der Entscheidung als Lieferpaket abgelegt (SHA-256 ${d.baseline.sha256})`);
  if (d.changesSince) parts.push(`Achtung: Nach der Entscheidung wurden ${d.changesSince} Änderungen erfasst – maßgeblich für die Entscheidung ist der abgelegte Stand`);
  return parts.length ? parts.join('. ') : null;
}

export function renderHtml(r: Report, profile: { name: string; options: ProfileOptions }, url: AttachmentUrl): { html: string; used: AttachmentRef[] } {
  const o = profile.options;
  const used = new Map<string, AttachmentRef>();
  const accent = /^#[0-9a-f]{6}$/i.test(o.accentColor) ? o.accentColor : '#3451b2';
  const b = body(r, o, url, used);
  const title = `${KIND_TITLE[r.kind]} – ${r.project.key}`;
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS(accent)}</style></head><body>
<header class="cover">
  ${o.organization ? `<div class="org">${esc(o.organization)}</div>` : ''}
  <h1>${KIND_TITLE[r.kind]}</h1>
  <div class="subject">${esc(r.project.key)} – ${esc(r.project.name)} · ${esc(b.subject)}</div>
  <table class="meta" style="margin-top:10px">
    <tr><th>Erstellt</th><td>${fmt(r.generatedAt)} von ${esc(r.generatedBy)}</td></tr>
    <tr><th>Berichtsprofil</th><td>${esc(profile.name)}</td></tr>
    ${o.standardNote ? `<tr><th>Grundlage</th><td>Aufbau in Anlehnung an ISO/IEC/IEEE 29119-3 (${KIND_STANDARD[r.kind]})</td></tr>` : ''}
  </table>
</header>
${b.html}
<footer><span>${esc(o.footer)}</span><span>Erstellt mit Anemo · ${fmt(r.generatedAt)}</span></footer>
</body></html>`;
  return { html, used: [...used.values()] };
}

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

const md = (s: string | null | undefined) => (s?.trim() ? wikiToMarkdown(s) : '–');
const cell = (s: string | null | undefined) => (s ?? '–').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const statusName = (r: Report, code: string) => r.statuses.find((s) => s.code === code)?.name ?? code;
const summaryMd = (s: Summary) => `| Gesamt | ausgeführt | Bestehensquote | fehlgeschlagen/blockiert | offen |\n|---|---|---|---|---|\n| ${s.total} | ${s.executed} | ${s.passRate ?? '–'} % | ${s.failed} | ${s.open} |\n\n${s.byStatus.map((b) => `- ${b.name}: ${b.count}`).join('\n')}`;
/** Abschnittszeile (J1) in Schritttabellen */
const groupRowHtml = (title: string, cols: number) => `<tr class="group"><td colspan="${cols}">${esc(title)}</td></tr>`;

const execMd = (r: Report, rows: ExecutionRow[], o: ProfileOptions) => rows.map((e) => [
  `### ${e.testCaseKey} – ${e.title} (v${e.version}): ${statusName(r, e.status)}`,
  `Ausgeführt: ${e.executedBy ?? '–'}, ${fmt(e.executedAt)} · Fehler: ${e.defects.map((d) => d.key).join(', ') || '–'}`,
  o.sections.comments && e.comment ? `\n**Befund:**\n\n${md(e.comment)}` : '',
  o.sections.steps && e.steps.length ? `\n| # | Aktion | Erwartet | Ergebnis |\n|---|---|---|---|\n${e.steps.map((s) => s.group != null ? `| | **${cell(s.group)}** | | |` : `| ${s.no} | ${cell(s.action)} | ${cell(s.expected)} | ${cell(statusName(r, s.status))}${s.comment ? ` – ${cell(s.comment)}` : ''} |`).join('\n')}` : '',
  o.sections.evidence && e.attachments.length ? `\nEvidenzen: ${e.attachments.map((a) => a.fileName).join(', ')}` : '',
].filter(Boolean).join('\n')).join('\n\n');

export function renderMarkdown(r: Report, profile: { name: string; options: ProfileOptions }): string {
  const o = profile.options;
  const head = [
    o.organization ? `**${o.organization}**\n` : '',
    `# ${KIND_TITLE[r.kind]} – ${r.project.key} ${r.project.name}`,
    `Erstellt ${fmt(r.generatedAt)} von ${r.generatedBy} · Profil „${profile.name}“${o.standardNote ? ` · in Anlehnung an ISO/IEC/IEEE 29119-3 (${KIND_STANDARD[r.kind]})` : ''}`,
  ].filter(Boolean).join('\n');
  let content = '';
  if (r.kind === 'test-log') {
    const c = r.cycle;
    content = [
      `## Testzyklus „${c.name}“`,
      o.sections.summary && `## Zusammenfassung\n\n${summaryMd(r.summary)}`,
      o.sections.environment && `## Umgebung\n\n- Release: ${c.release ?? '–'}\n- Build: ${c.build ?? '–'}\n- Umgebung: ${c.environment ?? '–'}\n- Konfiguration: ${c.configuration || '–'}\n- Zeitraum: ${fmt(c.startDate, false)} – ${fmt(c.endDate, false)}`,
      o.sections.executions && `## Protokoll\n\n${execMd(r, r.executions, o)}`,
    ].filter(Boolean).join('\n\n');
  } else if (r.kind === 'status') {
    const p = r.inPeriod;
    content = [
      `## Testplan „${r.plan.name}“${r.plan.release ? ` – Release ${r.plan.release}` : ''}`,
      `Berichtszeitraum ${fmt(r.period.from, false)} – ${fmt(r.period.to, false)}`,
      `## Lage: ${RECOMMENDATION[r.assessment.recommendation][0]} (aus heutiger Sicht)\n\n${burndownText(r.burndown)}${r.statusNote ? `\n\n### Lagebild des Testmanagements\n\n${md(r.statusNote.text)}` : ''}`,
      `## Im Berichtszeitraum\n\n| Ausführungen abgeschlossen | bestanden | fehlgeschlagen/blockiert | neue Fehler |\n|---|---|---|---|\n| ${p.executed} | ${p.passed} | ${p.failed} | ${p.newDefects.length} |${p.byTester.length ? `\n\nJe Person: ${p.byTester.map((t) => `${t.tester} ${t.executed}`).join(', ')}` : ''}${p.newFailures.length ? `\n\n### Neue Fehlschläge\n\n${p.newFailures.map((f) => `- ${f.key} – ${f.title} (${f.cycleName}): ${statusName(r, f.status)}`).join('\n')}` : ''}${p.newDefects.length ? `\n\n### Neue Fehler\n\n${p.newDefects.map((d) => `- ${d.key}${d.title ? ` – ${d.title}` : ''} (${d.status ?? 'Status unbekannt'})`).join('\n')}` : ''}`,
      o.sections.summary && `## Gesamtstand je Testfall\n\n${summaryMd(r.current)}`,
      r.criteria.length > 0 && `## Ausstiegskriterien (Zwischenstand)\n\n| Kriterium | Ziel | Ist | Erfüllt |\n|---|---|---|---|\n${r.criteria.map((c) => `| ${cell(c.label)} | ${cell(c.target)} | ${cell(c.actual)} | ${c.met ? 'ja' : 'nein'} |`).join('\n')}`,
      `## Risiken und Hindernisse\n\n${[...new Set([...r.assessment.reasons, ...r.risks])].map((x) => `- ${x}`).join('\n') || 'Keine.'}`,
      o.sections.defects && `## Aktuell fehlgeschlagen/blockiert\n\n${r.problems.slice(0, 50).map((e) => `- ${e.testCaseKey} – ${e.title} (${e.cycleName}): ${statusName(r, e.status)}`).join('\n') || 'Keine.'}`,
    ].filter(Boolean).join('\n\n');
  } else if (r.kind === 'completion') {
    content = [
      `## Testplan „${r.plan.name}“${r.plan.release ? ` – Release ${r.plan.release}` : ''}`,
      `## Bewertung: ${RECOMMENDATION[r.assessment.recommendation][0]}\n\n${r.assessment.reasons.map((x) => `- ${x}`).join('\n')}${r.plan.assessment ? `\n\n### Fazit des Testmanagements\n\n${md(r.plan.assessment)}\n\n_${assessmentMeta(r)}_` : ''}${r.releaseDecision ? `\n\n### Freigabeentscheidung\n\n**${DECISION[r.releaseDecision.decision] ?? r.releaseDecision.decision}** – ${r.releaseDecision.by ?? '–'}, ${fmt(r.releaseDecision.at)}${r.releaseDecision.note ? `\n\n${md(r.releaseDecision.note)}` : ''}${decisionMeta(r) ? `\n\n**${decisionMeta(r)}**` : ''}` : ''}`,
      `## Testbasis\n\n| Angabe | Wert |\n|---|---|\n| Testplan / Release | ${cell(r.plan.name)}${r.plan.release ? ` / ${cell(r.plan.release)}` : ''} |\n| Anforderungen | ${r.coverage.requirements} verknüpft (${r.coverage.totals.OK} bestanden, ${r.coverage.totals.NOK} mit Fehlern, ${r.coverage.totals.NOT_RUN} nicht vollständig getestet, ${r.coverage.totals.UNCOVERED} ohne Testfall) |\n| Testfälle | ${r.current.testCases}${r.coverage.withoutRequirement ? ` (${r.coverage.withoutRequirement} ohne Anforderung)` : ''} |\n| Aufwand (gemessen) | ${r.effortSeconds ? duration(r.effortSeconds) : '–'} |${r.archivedCycles ? `\n| Nicht berücksichtigt | ${r.archivedCycles} archivierte Zyklen (nicht Teil der Testbasis) |` : ''}`,
      r.criteria.length > 0 && `## Ausstiegskriterien\n\n| Kriterium | Ziel | Ist | Erfüllt |\n|---|---|---|---|\n${r.criteria.map((c) => `| ${cell(c.label)} | ${cell(c.target)} | ${cell(c.actual)} | ${c.met ? 'ja' : 'nein'} |`).join('\n')}`,
      `## Restrisiken\n\n${r.risks.length ? r.risks.map((x) => `- ${x}`).join('\n') : 'Keine bekannten Restrisiken.'}${r.knownDefects.length ? `\n\n### Bekannte, nicht behobene Fehler\n\n${r.knownDefects.map((d) => `- ${d.key}${d.title ? ` – ${d.title}` : ''} (${d.status ?? 'Status unbekannt'})`).join('\n')}` : ''}`,
      `## Abweichungen vom Testplan\n\n${[
        r.openItems.length ? `- ${r.openItems.length} Testfälle nicht abschließend ausgeführt (siehe offene Punkte)` : '',
        r.unreviewedSpec.length ? `- ${r.unreviewedSpec.length} Testfälle mit ungeprüfter Spezifikation ausgeführt: ${r.unreviewedSpec.slice(0, 20).map((x) => x.key).join(', ')}` : '',
        r.changedNotTested.length ? `- ${r.changedNotTested.length} Testfälle nach dem Test geändert: ${r.changedNotTested.slice(0, 20).map((x) => `${x.key} (v${x.testedVersion} → v${x.currentVersion})`).join(', ')}` : '',
      ].filter(Boolean).join('\n') || 'Keine.'}`,
      o.sections.summary && `## Aktueller Stand je Testfall\n\n${summaryMd(r.current)}\n\nJe Testfall das letzte Ergebnis je Konfiguration, über Konfigurationen das schlechteste. Bestehensquote = bestanden / (bestanden + fehlgeschlagen).`,
      o.sections.environment && `## Testumfang\n\n| Zyklus | Release/Build | Konfiguration | Tests | Bestanden | Fehlg. | Offen |\n|---|---|---|---|---|---|---|\n${r.cycles.map((c) => `| ${cell(c.name)} | ${cell(c.release)} / ${cell(c.build)} | ${cell(c.configuration)} | ${c.summary.total} | ${c.summary.passRate ?? '–'} % | ${c.summary.failed} | ${c.summary.open} |`).join('\n')}`,
      o.sections.defects && `## Fehlerwirkungen\n\n${execMd(r, r.problems, o) || 'Keine.'}`,
      o.sections.defects && r.retestPending?.length && `## Behoben, aber nicht nachgetestet\n\n| Testfall | Titel | Zyklus | Behobene Fehler |\n|---|---|---|---|\n${r.retestPending.map((x) => `| ${x.key} | ${x.title.replace(/\|/g, '/')} | ${x.cycleName.replace(/\|/g, '/')} | ${x.defects.join(', ')} |`).join('\n')}`,
      o.sections.defects && r.knownFailures?.length && `## Bekannte Fehler (dokumentiert)\n\n${execMd(r, r.knownFailures, { ...o, sections: { ...o.sections, steps: false, evidence: false } })}`,
      o.sections.defects && `## Verknüpfte Fehler\n\n${r.defects.map((d) => `- ${d.key}${d.title ? ` – ${d.title}` : ''} (${d.status ?? 'Status unbekannt'})`).join('\n') || 'Keine.'}`,
      o.sections.openItems && `## Offene Punkte\n\n${r.openItems.map((e) => `- ${e.testCaseKey} – ${e.title} (${e.cycleName})`).join('\n') || 'Keine.'}`,
    ].filter(Boolean).join('\n\n');
  } else if (r.kind === 'traceability') {
    content = [
      `## Testplan „${r.plan.name}“${r.plan.release ? ` – Release ${r.plan.release}` : ''}${r.asOf ? ` – Stand ${fmt(r.asOf, false)}` : ''}`,
      `## Abdeckung\n\n${(['OK', 'NOK', 'NOT_RUN', 'UNCOVERED'] as const).map((k) => `- ${COVERAGE[k]![0]}: ${r.totals[k]}`).join('\n')}`,
      `## Matrix\n\n| Anforderung | Titel | Abdeckung | Testfälle |\n|---|---|---|---|\n${r.requirements.map((q) => `| ${cell(q.key)} | ${cell(q.title)} | ${COVERAGE[q.state]![0]} | ${q.tests.map((x) => `${x.key} ${x.inPlan ? x.status ?? '' : '(nicht eingeplant)'}`).join(', ') || '–'} |`).join('\n')}`,
      `## Testfälle ohne Anforderung\n\n${r.testsWithoutRequirement.map((x) => `- ${x.key} – ${x.title}`).join('\n') || 'Keine.'}`,
    ].join('\n\n');
  } else {
    content = r.testCases.map((t) => [
      `## ${t.key} – ${t.title} (v${t.version}, ${t.status})`,
      t.objective && `**Ziel:**\n\n${md(t.objective)}`,
      t.preconditions && `**Vorbedingungen:**\n\n${md(t.preconditions)}`,
      t.format === 'GHERKIN' ? `\`\`\`gherkin\n${t.gherkin ?? ''}\n\`\`\`` : t.format === 'PLAIN' ? `**Testanweisung:**\n\n${md(t.plainText)}` : `| # | Aktion | Testdaten | Erwartet |\n|---|---|---|---|\n${t.steps.map((s) => s.group != null ? `| | **${cell(s.group)}** | | |` : `| ${s.no} | ${cell(s.action)} | ${cell(s.data)} | ${cell(s.expected)} |`).join('\n')}`,
    ].filter(Boolean).join('\n\n')).join('\n\n');
  }
  return `${head}\n\n${content}\n\n---\n${o.footer}\n`;
}
