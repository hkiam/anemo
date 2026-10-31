/**
 * Modul integrations: Anbindung von Fremdsystemen (OpenProject vorbereitet), Fehlervorlagen und Fehlermeldungen
 * aus Ausführungen (ADR-0015). Inhalte verlassen das System nur, wenn das Projekt externe Dienste erlaubt (ADR-0014).
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { type Db, inTx } from '../../platform/db.ts';
import { HttpError, notFound, route } from '../../platform/http.ts';
import { getProject } from '../projects/index.ts';
import { EventTypes, subscribe } from '../events/index.ts';
import { defectResolution, linkReference, SEVERITIES, setStepValidator, setTicketKeyResolver } from '../references/index.ts';
import { deleteTemplate, draftDefect, listTemplates, saveTemplate } from './defects.ts';
import { getExecution } from '../execution/index.ts';
import { pushCoverage, requirementCoverage } from './coverage.ts';
import { applyReferenceUpdates } from './refs.ts';
import { createJiraIssue, jiraConfig, jiraCreateEnabled, lastJiraRefresh, refreshJiraReferences } from './jira.ts';
import { forgetWorkPackageProjects, isWorkPackageKey, OpenProjectAdapter, openProjectConfig } from './openproject.ts';
import { applyFeatureImport, commitFeatures, compare, GitLabClient, gitlabConfig, type GitLabLink, markFeaturesSynced, planFeatureExport, readFeatureFiles } from './gitlab.ts';
import { settingsEnv } from '../../platform/settings.ts';

export { renderTemplate } from './template.ts';
export { wikiToMarkdown } from './markdown.ts';
export { jiraConfig, refreshJiraReferences } from './jira.ts';
export { syncAllFieldOptions } from './options.ts';
import { SOURCE_KINDS, syncFieldOptions } from './options.ts';
import { goLink, publicBase } from '../../platform/links.ts';
export const openProjectConfigured = () => !!openProjectConfig();

/** Ist das Ziel für ein Projekt nutzbar? Gründe werden der Oberfläche angezeigt. */
async function target(db: Db, projectId: string): Promise<{ available: boolean; reason: string | null; externalProject: string | null; adapter: OpenProjectAdapter | null }> {
  const cfg = openProjectConfig();
  const [p] = await db<{ externalServices: string }[]>`select external_services from project where id = ${projectId}`;
  const [link] = await db<{ externalProject: string }[]>`select external_project from project_integration where project_id = ${projectId} and provider = 'openproject'`;
  if (!cfg) return { available: false, reason: 'OpenProject ist noch nicht eingerichtet', externalProject: null, adapter: null };
  if (p?.externalServices !== 'allowed') return { available: false, reason: 'Für dieses Projekt sind externe Dienste gesperrt', externalProject: null, adapter: null };
  if (!link) return { available: false, reason: 'Projekt ist keinem OpenProject-Projekt zugeordnet', externalProject: null, adapter: null };
  return { available: true, reason: null, externalProject: link.externalProject, adapter: new OpenProjectAdapter(cfg) };
}

/**
 * Ziel für neue Fehler eines Projekts: OpenProject (Zielsystem), sonst – nur wenn ausdrücklich eingeschaltet – Jira
 * (Parallelbetrieb). Beide nur bei erlaubten externen Diensten.
 */
export interface DefectSink {
  provider: 'openproject' | 'jira'; available: boolean; reason: string | null; externalProject: string | null;
  /** origin: Herkunft in Anemo – füllt in OpenProject die eingestellten Rückverweis-Felder (Link, Testfall) */
  create: (input: { title: string; description: string; severity?: string | null | undefined; origin?: DefectOrigin | undefined }) => Promise<{ key: string; title: string; status: string; url: string }>;
}
export interface DefectOrigin { kind: 'ausfuehrung' | 'sitzung'; id: string }

/**
 * Rückverweise aktualisieren: je verknüpftem OpenProject-Arbeitspaket das Link-Feld auf den dauerhaften Link der Herkunft
 * (erste Verknüpfung) setzen. Überschrieben werden nur leere Felder und Anemo-Links (/go/… bzw. alte /#/p/…-Adressen).
 * Nur Projekte mit erlaubten externen Diensten und Arbeitspakete des zugeordneten OpenProject-Projekts.
 */
export async function updateBacklinks(db: Db, dryRun: boolean) {
  const cfg = openProjectConfig();
  const field = settingsEnv().OPENPROJECT_LINK_FIELD?.trim();
  if (!cfg) throw new HttpError(409, 'OpenProject ist noch nicht eingerichtet');
  if (!field || !/^customField\d+$/.test(field)) throw new HttpError(409, 'Kein Feld für den Rückverweis gewählt (Anbindungen → OpenProject → Rückverweis)');
  if (!publicBase()) throw new HttpError(409, 'Die öffentliche Adresse von Anemo ist nicht eingestellt (Einstellungen → Allgemein)');
  const adapter = new OpenProjectAdapter(cfg);
  const rows = await db<{ externalKey: string; ownerType: string; ownerId: string; tcKey: string | null; externalProject: string }[]>`
    select distinct on (r.external_key) r.external_key, r.owner_type, r.owner_id,
      (select key from test_case where id = r.owner_id) as tc_key, i.external_project
    from external_reference r
    join project p on p.id = reference_owner_project(r.owner_type, r.owner_id)
    join project_integration i on i.project_id = p.id and i.provider = 'openproject' and i.external_project is not null
    where r.provider = 'openproject' and p.external_services = 'allowed'
    order by r.external_key, r.created_at`;
  const out = { checked: 0, set: 0, unchanged: 0, foreign: 0, notInProject: 0, errors: [] as string[], dryRun };
  for (const r of rows) {
    const link = r.ownerType === 'TEST_EXECUTION' ? goLink('ausfuehrung', r.ownerId) : r.ownerType === 'EXPLORATORY_SESSION' ? goLink('sitzung', r.ownerId)
      : r.ownerType === 'TEST_CYCLE' ? goLink('zyklus', r.ownerId) : r.ownerType === 'TEST_PLAN' ? goLink('plan', r.ownerId)
        : r.tcKey ? goLink('testfall', r.tcKey) : null;
    if (!link) continue;
    out.checked++;
    try {
      if (!(await adapter.inProject(r.externalKey, r.externalProject))) { out.notInProject++; continue; }
      const cur = await adapter.fieldValue(r.externalKey, field);
      if (cur === link) { out.unchanged++; continue; }
      if (cur && !/\/go\/|\/#\/p\//.test(cur)) { out.foreign++; continue; }
      if (!dryRun) await adapter.setField(r.externalKey, field, link);
      out.set++;
    } catch (e) {
      if (out.errors.length < 20) out.errors.push(`${r.externalKey}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Rückverweis-Felder (OpenProject) für eine Herkunft: Link auf die Herkunft, Testfallschlüssel. */
async function originFields(db: Db, origin: DefectOrigin | undefined): Promise<Record<string, string>> {
  const env = settingsEnv();
  const out: Record<string, string> = {};
  if (!origin) return out;
  const linkField = env.OPENPROJECT_LINK_FIELD?.trim();
  const tcField = env.OPENPROJECT_TESTCASE_FIELD?.trim();
  const link = goLink(origin.kind, origin.id);
  if (linkField && link) out[linkField] = link;
  if (tcField && origin.kind === 'ausfuehrung') {
    const [t] = await db<{ key: string }[]>`select tc.key from test_execution e join test_case tc on tc.id = e.test_case_id where e.id = ${origin.id}`;
    if (t) out[tcField] = t.key;
  }
  return out;
}

export async function defectSink(db: Db, projectId: string): Promise<DefectSink> {
  const op = await target(db, projectId);
  const unavailable = (provider: DefectSink['provider'], reason: string | null): DefectSink => ({ provider, available: false, reason, externalProject: null, create: async () => { throw new HttpError(409, reason ?? 'Integration nicht verfügbar'); } });
  const severityLine = (s: string | null | undefined) => (s ? `*Schweregrad (Anemo):* ${s}\n\n` : '');
  if (op.available && op.adapter && op.externalProject) {
    const [link] = await db<{ settings: { typeId?: number } }[]>`select settings from project_integration where project_id = ${projectId} and provider = 'openproject'`;
    return {
      provider: 'openproject', available: true, reason: null, externalProject: op.externalProject,
      create: async (i) => {
        const wp = await op.adapter!.createDefect({ externalProject: op.externalProject!, title: i.title, description: severityLine(i.severity) + i.description,
          typeId: link?.settings?.typeId, fields: await originFields(db, i.origin) });
        createdByAnemo.add(wp.key);
        return wp;
      },
    };
  }
  const [jl] = await db<{ externalProject: string; settings: { issueType?: string; priorities?: Record<string, string> } }[]>`
    select external_project, settings from project_integration where project_id = ${projectId} and provider = 'jira'`;
  const jcfg = jiraConfig();
  if (jl && jcfg && jiraCreateEnabled()) {
    const [p] = await db<{ externalServices: string }[]>`select external_services from project where id = ${projectId}`;
    if (p?.externalServices !== 'allowed') return unavailable('jira', 'Für dieses Projekt sind externe Dienste gesperrt');
    return {
      provider: 'jira', available: true, reason: null, externalProject: jl.externalProject,
      create: (i) => createJiraIssue(jcfg, {
        project: jl.externalProject, issueType: jl.settings?.issueType || 'Bug', summary: i.title, description: severityLine(i.severity) + i.description,
        priority: i.severity ? jl.settings?.priorities?.[i.severity] : undefined,
      }),
    };
  }
  return unavailable('openproject', op.reason);
}

// ---- OpenProject: Statusabgleich (inkl. Nachtest bei erledigten Fehlern) ----

let lastOpRefresh: { at: Date; checked: number; updated: number; retests: number; coverageComments?: number; error: string | null } | null = null;
/**
 * Abgleich je zugeordnetem Projekt: Titel/Status nur für Arbeitspakete aus dem zugeordneten OpenProject-Projekt und nur
 * an Verweisen dieses Anemo-Projekts. Verweise aus Projekten ohne Zuordnung (Verknüpfen per Nummer) bleiben ohne
 * Titel/Status – sonst ließe sich über die Nummer alles lesen, was das Servicekonto sieht (Sicherheit 3).
 */
export async function refreshOpenProjectReferences(db: Db) {
  const cfg = openProjectConfig();
  if (!cfg) return null;
  const op = new OpenProjectAdapter(cfg);
  const mapped = await db<{ projectId: string; key: string; externalProject: string; externalServices: string; coverage: boolean }[]>`
    select i.project_id, p.key, i.external_project, p.external_services, coalesce((i.settings->>'coverageComments')::boolean, false) as coverage
    from project_integration i join project p on p.id = i.project_id where i.provider = 'openproject' order by p.key`;
  let checked = 0;
  let updated = 0;
  let retests = 0;
  let coverageComments = 0;
  const errors: string[] = [];
  for (const m of mapped) {
    try {
      const refs = (await db<{ id: string; externalKey: string }[]>`
        select r.id, r.external_key from external_reference r
        where r.provider = 'openproject' and reference_owner_project(r.owner_type, r.owner_id) = ${m.projectId}`).filter((r) => isWorkPackageKey(r.externalKey));
      const keys = [...new Set(refs.map((r) => r.externalKey))];
      checked += keys.length;
      for (let i = 0; i < keys.length; i += 100) {
        const items = await op.getWorkItems(keys.slice(i, i + 100), m.externalProject);
        const r = await applyReferenceUpdates(db, 'openproject', items.map((w) => ({ key: w.key, title: w.title, status: w.status, url: w.url })), refs.map((x) => x.id));
        updated += r.updated;
        retests += r.retests;
      }
      // Abdeckungsstatus in die Tickets der Projekte, die das wünschen
      if (m.coverage && m.externalServices === 'allowed') {
        const r = await pushCoverage(db, op, m.projectId, m.externalProject, publicBase(), m.key);
        coverageComments += r.comments;
        if (r.failed) errors.push(`${m.key}: ${r.failed} Abdeckungskommentar(e) fehlgeschlagen`);
      }
    } catch (e) {
      errors.push(`${m.key}: ${(e as Error).message}`);
    }
  }
  lastOpRefresh = { at: new Date(), checked, updated, retests, coverageComments, error: errors.length ? errors.join('; ').slice(0, 1000) : null };
  return lastOpRefresh;
}

// ---- GitLab: Ziel je Projekt und Statusabgleich verknüpfter Merge-Requests ----

async function gitlabTarget(db: Db, projectId: string): Promise<{ gl: GitLabClient; link: GitLabLink }> {
  const cfg = gitlabConfig();
  if (!cfg) throw new HttpError(409, 'GitLab ist noch nicht eingerichtet (GITLAB_URL, GITLAB_TOKEN)');
  const [p] = await db<{ externalServices: string }[]>`select external_services from project where id = ${projectId}`;
  if (p?.externalServices !== 'allowed') throw new HttpError(409, 'Für dieses Projekt sind externe Dienste gesperrt');
  const [l] = await db<{ externalProject: string; settings: { branch?: string; folder?: string } }[]>`
    select external_project, settings from project_integration where project_id = ${projectId} and provider = 'gitlab'`;
  if (!l) throw new HttpError(409, 'Projekt ist keinem GitLab-Repository zugeordnet');
  return { gl: new GitLabClient(cfg), link: { project: l.externalProject, branch: l.settings.branch || 'main', folder: (l.settings.folder || 'features').replace(/^\/+|\/+$/g, '') } };
}

let lastGitlabRefresh: { at: Date; checked: number; updated: number; error: string | null } | null = null;
/** Merge-Requests nur aus dem zugeordneten Repository und nur an Verweisen dieses Anemo-Projekts abgleichen. */
export async function refreshGitlabReferences(db: Db) {
  const cfg = gitlabConfig();
  if (!cfg) return null;
  const gl = new GitLabClient(cfg);
  const mapped = await db<{ projectId: string; externalProject: string }[]>`select project_id, external_project from project_integration where provider = 'gitlab'`;
  let checked = 0;
  let updated = 0;
  const errors: string[] = [];
  for (const m of mapped) {
    try {
      const prefix = `${m.externalProject}!`;
      const refs = (await db<{ id: string; externalKey: string }[]>`
        select r.id, r.external_key from external_reference r
        where r.provider = 'gitlab' and reference_owner_project(r.owner_type, r.owner_id) = ${m.projectId}`)
        .filter((r) => r.externalKey.startsWith(prefix) && /^\d+$/.test(r.externalKey.slice(prefix.length)));
      const keys = [...new Set(refs.map((r) => r.externalKey))];
      checked += keys.length;
      const updates = [];
      for (const k of keys) {
        const mr = await gl.mergeRequest(m.externalProject, k.slice(prefix.length)).catch(() => null);
        if (mr) updates.push({ key: k, title: mr.title, status: mr.state, url: mr.web_url });
      }
      updated += (await applyReferenceUpdates(db, 'gitlab', updates, refs.map((r) => r.id))).updated;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  lastGitlabRefresh = { at: new Date(), checked, updated, error: errors.length ? errors.join('; ').slice(0, 1000) : null };
  return lastGitlabRefresh;
}

// ---- Rückverweis: beim Verknüpfen Kommentar mit Link auf Anemo am Arbeitspaket ----

/** Von Anemo selbst angelegte Arbeitspakete tragen den Rückverweis bereits in der Beschreibung. */
const createdByAnemo = new Set<string>();
const OWNER_LABEL: Record<string, string> = { TEST_CASE: 'Testfall', TEST_CYCLE: 'Testzyklus', TEST_PLAN: 'Testplan', TEST_EXECUTION: 'Ausführung' };
const RELATION_LABEL: Record<string, string> = { REQUIREMENT: 'Anforderung', STORY: 'Story', EPIC: 'Epic', DEFECT: 'Fehler', RELATED: 'Bezug', SUBTASK: 'Unteraufgabe', AUTOMATION: 'Automatisierung', DOCUMENTATION: 'Dokumentation' };

export async function backlinkComment(db: Db, e: { aggregateType: string; aggregateId: string; actor: string; payload: Record<string, unknown> }): Promise<string | null> {
  if (e.payload.provider !== 'openproject') return null;
  const key = String(e.payload.externalKey);
  if (createdByAnemo.delete(key)) return null;
  if (!isWorkPackageKey(key)) return null; // nur Nummern bzw. Projektschlüssel (keine Pfadmanipulation im API-Aufruf)
  const cfg = openProjectConfig();
  if (!cfg) return null;
  const t = e.aggregateType;
  const [o] = t === 'TEST_CASE'
    ? await db<{ label: string; projectKey: string; projectId: string; path: string }[]>`select x.key || ' „' || v.title || '“' as label, p.key as project_key, p.id as project_id,
        '/repo?tc=' || x.key as path from test_case x join test_case_version v on v.test_case_id = x.id and v.version_no = x.current_version join project p on p.id = x.project_id where x.id = ${e.aggregateId}`
    : t === 'TEST_CYCLE'
      ? await db<{ label: string; projectKey: string; projectId: string; path: string }[]>`select '„' || x.name || '“' as label, p.key as project_key, p.id as project_id, '/cycles/' || x.id as path
          from test_cycle x join project p on p.id = x.project_id where x.id = ${e.aggregateId}`
      : t === 'TEST_PLAN'
        ? await db<{ label: string; projectKey: string; projectId: string; path: string }[]>`select '„' || x.name || '“' as label, p.key as project_key, p.id as project_id, '/cycles?plan=' || x.id as path
            from test_plan x join project p on p.id = x.project_id where x.id = ${e.aggregateId}`
        : await db<{ label: string; projectKey: string; projectId: string; path: string }[]>`select tc.key || ' in „' || c.name || '“' as label, p.key as project_key, p.id as project_id,
            '/cycles/' || c.id || '?exec=' || x.id as path from test_execution x join test_cycle c on c.id = x.cycle_id join test_case tc on tc.id = x.test_case_id
            join project p on p.id = c.project_id where x.id = ${e.aggregateId}`;
  if (!o) return null;
  const [p] = await db<{ externalServices: string }[]>`select external_services from project where id = ${o.projectId}`;
  if (p?.externalServices !== 'allowed') return null;
  // nur an Arbeitspakete des zugeordneten OpenProject-Projekts (nicht an alles, was das Servicekonto sieht)
  const [link] = await db<{ externalProject: string }[]>`select external_project from project_integration where project_id = ${o.projectId} and provider = 'openproject'`;
  if (!link) return null;
  const adapter = new OpenProjectAdapter(cfg);
  if (!(await adapter.inProject(key, link.externalProject))) return null;
  const target = t === 'TEST_CASE' ? goLink('testfall', o.label.split(' ')[0]!) : t === 'TEST_CYCLE' ? goLink('zyklus', e.aggregateId) : t === 'TEST_PLAN' ? goLink('plan', e.aggregateId) : goLink('ausfuehrung', e.aggregateId);
  const text = `🔗 Verknüpft in *Anemo* (${RELATION_LABEL[String(e.payload.relation)] ?? e.payload.relation}): ${OWNER_LABEL[t] ?? t} ${target ? `[${o.label}|${target}]` : o.label} (von ${e.actor})`;
  await adapter.comment(key, text);
  return text;
}

/**
 * Ergebnis eines Nachtests zurück an das Ticket des behobenen Fehlers (Review 30.10.2026, F4): bestanden bzw. weiter
 * fehlgeschlagen, mit Link. Gleiche Schranken wie beim Rückverweis (externe Dienste erlaubt, Projekt zugeordnet,
 * Arbeitspaket im zugeordneten OpenProject-Projekt). Nur abschließende Ergebnisse, nur OpenProject.
 */
export async function retestComment(db: Db, e: { aggregateId: string; actor: string }): Promise<string | null> {
  const [x] = await db<{ marker: string | null; status: string; statusName: string; category: string; key: string; cycle: string; projectId: string; externalServices: string }[]>`
    select ex.custom_fields->>'retestDefect' as marker, ex.status, s.name as status_name, s.category, tc.key, c.name as cycle, p.id as project_id, p.external_services
    from test_execution ex join execution_status s on s.code = ex.status join test_case tc on tc.id = ex.test_case_id
      join test_cycle c on c.id = ex.cycle_id join project p on p.id = c.project_id where ex.id = ${e.aggregateId}`;
  if (!x?.marker || x.externalServices !== 'allowed' || ['OPEN', 'IN_PROGRESS'].includes(x.category)) return null;
  const [provider, key] = [x.marker.slice(0, x.marker.indexOf(':')), x.marker.slice(x.marker.indexOf(':') + 1)];
  if (provider !== 'openproject' || !isWorkPackageKey(key)) return null;
  const cfg = openProjectConfig();
  if (!cfg) return null;
  const [link] = await db<{ externalProject: string }[]>`select external_project from project_integration where project_id = ${x.projectId} and provider = 'openproject'`;
  if (!link) return null;
  const adapter = new OpenProjectAdapter(cfg);
  if (!(await adapter.inProject(key, link.externalProject))) return null;
  const ok = x.category === 'PASSED' || x.category === 'PASSED_WITH_ISSUES';
  const target = goLink('ausfuehrung', e.aggregateId);
  const text = `${ok ? '✅ Nachtest bestanden' : '❌ Nachtest nicht bestanden'} in *Anemo*: ${target ? `[${x.key} in „${x.cycle}“|${target}]` : `${x.key} in „${x.cycle}“`} – ${x.statusName} (von ${e.actor})`;
  await adapter.comment(key, text);
  return text;
}

/**
 * Öffentliche Adresse für Links nach außen – nur aus ANEMO_PUBLIC_URL, nie aus dem Host-Kopf der Anfrage (sonst ließen
 * sich Links bzw. das CI-Token auf einen fremden Rechner umleiten). Leer = Links ohne Adresse.
 */


/** Eigene CI-Variablen: nur mit Präfix TEST_ oder aus der Erlaubnisliste der GitLab-Zuordnung; Steuervariablen nie. */
const FORBIDDEN_CI_VAR = /^(CI_|GITLAB_|ANEMO_|DOCKER_|FF_|RUNNER_|TRIGGER_|SECURE_|ARTIFACT_|CACHE_|GIT_)|(^|_)DEBUG(_|$)/i;
export function ciVariableProblem(name: string, allowed: string[]): string | null {
  if (FORBIDDEN_CI_VAR.test(name)) return `Variable ${name} ist nicht erlaubt (Steuer- bzw. Anemo-Variable)`;
  if (!name.startsWith('TEST_') && !allowed.includes(name)) return `Variable ${name} ist nicht erlaubt – nur mit Präfix TEST_ oder freigegeben in der GitLab-Zuordnung (ciVariables)`;
  return null;
}
const execAccess = (level: 'read' | 'execute') => ({ level, project: ({ params }: { params: Record<string, string> }) => ({ kind: 'execution' as const, id: params.id! }) });

/** Ist für das Projekt das automatische Anlegen von Fehlern möglich (OpenProject eingerichtet, zugeordnet, erlaubt)? */
export async function defectTargetAvailable(db: Db, projectId: string): Promise<{ available: boolean; reason: string | null; provider: string }> {
  const t = await defectSink(db, projectId);
  return { available: t.available, reason: t.reason, provider: t.provider };
}

/**
 * Fehler für eine fehlgeschlagene (automatisierte) Ausführung: Ist für den Testfall schon ein offener Fehler
 * verknüpft, wird dieser wiederverwendet (keine Flut gleicher Tickets); sonst wird er aus der Standardvorlage in
 * OpenProject angelegt und verknüpft.
 */
export async function autoDefect(db: Db, executionId: string, actor: string): Promise<{ key: string; created: boolean } | null> {
  const [e] = await db<{ projectId: string; testCaseId: string }[]>`select c.project_id, e.test_case_id from test_execution e join test_cycle c on c.id = e.cycle_id where e.id = ${executionId}`;
  if (!e) return null;
  const known = await db<{ provider: string; externalKey: string; status: string | null; url: string | null; title: string | null }[]>`
    select distinct on (r.provider, r.external_key) r.provider, r.external_key, r.status, r.url, r.title from external_reference r join test_execution x on x.id = r.owner_id
    where r.owner_type = 'TEST_EXECUTION' and r.relation = 'DEFECT' and x.test_case_id = ${e.testCaseId} order by r.provider, r.external_key, r.created_at desc`;
  const open = known.find((d) => defectResolution(d.status) === 'open');
  if (open) {
    await linkReference(db, { ownerType: 'TEST_EXECUTION', ownerId: executionId, provider: open.provider, externalKey: open.externalKey, relation: 'DEFECT', url: open.url, title: open.title, status: open.status }, actor);
    return { key: open.externalKey, created: false };
  }
  const sink = await defectSink(db, e.projectId);
  if (!sink.available) return null;
  const draft = await draftDefect(db, executionId, { baseUrl: publicBase() });
  const wp = await sink.create({ title: draft.title, description: draft.body, origin: { kind: 'ausfuehrung', id: executionId } });
  await linkReference(db, { ownerType: 'TEST_EXECUTION', ownerId: executionId, provider: sink.provider, externalKey: wp.key, relation: 'DEFECT', url: wp.url, title: wp.title, status: wp.status }, actor);
  return { key: wp.key, created: true };
}

/**
 * Wem gehört ein Schlüssel wie PROJ-315? Nur OpenProject angebunden → OpenProject; beide angebunden → OpenProject, wenn es
 * das Arbeitspaket kennt (Projektschlüssel ab OpenProject 17), sonst Jira; nichts angebunden → keine Entscheidung.
 */
async function resolveTicketKey(key: string): Promise<'openproject' | 'jira' | null> {
  const op = openProjectConfig();
  if (!op || !isWorkPackageKey(key)) return null;
  if (!jiraConfig()) return 'openproject';
  return (await new OpenProjectAdapter(op).getWorkItem(key)) ? 'openproject' : 'jira';
}

export function integrationRoutes(app: Hono, db: Db): void {
  setTicketKeyResolver(resolveTicketKey);
  const tag = 'Integrationen';
  // Schrittbezug von Verweisen prüfen (references kennt execution nicht)
  setStepValidator(async (d, executionId, stepId) => (await getExecution(d, executionId)).steps.some((s) => s.id === stepId));
  subscribe(async (e) => {
    if (e.type === EventTypes.ReferenceLinked) await backlinkComment(db, e).catch((err) => console.error('OpenProject-Rückverweis', err));
    if (e.type === EventTypes.TestExecuted) await retestComment(db, e).catch((err) => console.error('OpenProject-Nachtest', err));
  });
  route(app, {
    method: 'get', path: '/api/projects/:key/integrations/openproject/status', tag, summary: 'Ist OpenProject für dieses Projekt nutzbar?',
    access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
  }, async ({ params }) => {
    const p = await getProject(db, params.key!);
    const t = await target(db, p.id);
    // configured/allowed getrennt: Verknüpfen per Nummer geht auch ohne Projektzuordnung (Suche nicht – sie bleibt aufs Projekt begrenzt)
    return { available: t.available, reason: t.reason, externalProject: t.externalProject, configured: !!openProjectConfig(), allowed: p.externalServices === 'allowed' };
  });
  route(app, { method: 'post', path: '/api/admin/fields/:id/sync-options', tag, summary: 'Auswahlwerte eines Felds jetzt aus Jira/OpenProject abgleichen', access: 'admin' },
    ({ params }) => syncFieldOptions(db, params.id!));
  route(app, { method: 'get', path: '/api/admin/fields/option-sources', tag, summary: 'Mögliche Quellen für Auswahlwerte (je nach eingerichteter Integration)', access: 'admin' },
    async () => ({ jira: jiraConfig() ? SOURCE_KINDS.jira : [], openproject: openProjectConfig() ? SOURCE_KINDS.openproject : [] }));
  route(app, { method: 'post', path: '/api/admin/integrations/openproject/refresh', tag, summary: 'Titel/Status verknüpfter Arbeitspakete jetzt abgleichen', access: 'admin' }, async () => {
    const r = await refreshOpenProjectReferences(db);
    if (!r) throw new HttpError(409, 'OpenProject ist nicht eingerichtet');
    return r;
  });
  route(app, { method: 'get', path: '/api/admin/integrations', tag, summary: 'Eingerichtete Integrationen (ohne Zugangsdaten)', access: 'admin' }, async () => {
    const op = openProjectConfig();
    const jira = jiraConfig();
    return [
      { provider: 'openproject', name: 'OpenProject', configured: !!op, url: op?.url ?? null, env: ['OPENPROJECT_URL', 'OPENPROJECT_API_KEY'], lastRefresh: lastOpRefresh },
      { provider: 'gitlab', name: 'GitLab', configured: !!gitlabConfig(), url: gitlabConfig()?.url ?? null, env: ['GITLAB_URL', 'GITLAB_TOKEN'], lastRefresh: lastGitlabRefresh },
      { provider: 'jira', name: jiraCreateEnabled() ? 'Jira (Parallelbetrieb, Fehler anlegen eingeschaltet)' : 'Jira (Parallelbetrieb, nur lesend)', configured: !!jira, url: jira?.baseUrl ?? null, env: ['JIRA_BASE_URL', 'JIRA_TOKEN bzw. JIRA_USER/JIRA_PASSWORD'], lastRefresh: lastJiraRefresh() },
    ];
  });
  route(app, { method: 'post', path: '/api/admin/integrations/openproject/test', tag, summary: 'Verbindung zu OpenProject prüfen', access: 'admin' }, async () => {
    const cfg = openProjectConfig();
    if (!cfg) return { ok: false, error: 'OPENPROJECT_URL und OPENPROJECT_API_KEY sind nicht gesetzt' };
    try {
      return { ok: true, user: await new OpenProjectAdapter(cfg).whoAmI() };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  route(app, { method: 'post', path: '/api/admin/integrations/jira/refresh', tag, summary: 'Titel/Status verknüpfter Jira-Tickets jetzt aktualisieren', access: 'admin' }, async () => {
    const cfg = jiraConfig();
    if (!cfg) throw new HttpError(409, 'Jira ist nicht eingerichtet (Adresse und Token bzw. Benutzer/Kennwort)');
    return refreshJiraReferences(db, cfg);
  });

  route(app, { method: 'post', path: '/api/admin/integrations/gitlab/test', tag, summary: 'Verbindung zu GitLab prüfen', access: 'admin' }, async () => {
    const cfg = gitlabConfig();
    if (!cfg) return { ok: false, error: 'GITLAB_URL und GITLAB_TOKEN sind nicht gesetzt' };
    try {
      return { ok: true, user: (await new GitLabClient(cfg).whoAmI()).username };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // ---- CI-Läufe je Zyklus (GitLab-Pipeline); die Pipeline meldet Ergebnisse über automation-results zurück ----
  const FINAL = new Set(['success', 'failed', 'canceled', 'skipped']);
  const cycleAccess = (level: 'read' | 'edit') => ({ level, project: ({ params }: { params: Record<string, string> }) => ({ kind: 'cycle' as const, id: params.id! }) });
  route(app, { method: 'get', path: '/api/cycles/:id/ci-runs', tag, summary: 'Angestoßene CI-Läufe des Zyklus (Status laufender Läufe wird abgefragt)', access: cycleAccess('read') }, async ({ params }) => {
    const runs = await db<{ id: string; externalId: string; ref: string; url: string | null; status: string; triggeredBy: string; createdAt: Date; updatedAt: Date; projectId: string }[]>`
      select r.*, c.project_id from ci_run r join test_cycle c on c.id = r.cycle_id where r.cycle_id = ${params.id!} order by r.created_at desc limit 20`;
    const open = runs.filter((r) => !FINAL.has(r.status)).slice(0, 5);
    if (open.length) {
      try {
        const { gl, link } = await gitlabTarget(db, open[0]!.projectId);
        for (const r of open) {
          const p = await gl.pipeline(link.project, r.externalId);
          if (p.status !== r.status) {
            await db`update ci_run set status = ${p.status}, updated_at = now() where id = ${r.id}`;
            r.status = p.status;
          }
        }
      } catch { /* Status bleibt beim letzten Stand; Anzeige zeigt ihn als „unbekannt aktuell“ */ }
    }
    return runs.map(({ projectId: _p, ...r }) => r);
  });
  route(app, {
    method: 'post', path: '/api/cycles/:id/ci-runs', tag, status: 201, access: cycleAccess('edit'),
    summary: 'GitLab-Pipeline für den Zyklus starten (Variablen ANEMO_URL, ANEMO_PROJECT, ANEMO_CYCLE_ID, ANEMO_CYCLE_NAME, ANEMO_BUILD)',
    body: z.object({
      ref: z.string().trim().min(1).max(200).regex(/^[\w./-]+$/, 'Ungültiger Branch/Tag').optional(),
      variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'Variablenname: Buchstaben, Ziffern, _'), z.string().max(1000)).optional()
        .refine((v) => !v || Object.keys(v).length <= 20, 'Höchstens 20 Variablen'),
    }),
  }, async ({ params, body, actor }) => {
    const [cy] = await db<{ projectId: string; projectKey: string; name: string; build: string | null; state: string; archivedAt: Date | null }[]>`
      select c.project_id, p.key as project_key, c.name, c.build, c.state, c.archived_at from test_cycle c join project p on p.id = c.project_id where c.id = ${params.id!}`;
    if (!cy) throw notFound('Zyklus', params.id);
    if (cy.state === 'closed' || cy.archivedAt) throw new HttpError(409, 'Der Zyklus ist abgeschlossen bzw. archiviert');
    const { gl, link } = await gitlabTarget(db, cy.projectId);
    // Die Pipeline meldet mit dem CI-Token an ANEMO_URL zurück – die Adresse nie aus der Anfrage ableiten
    const anemoUrl = publicBase();
    if (!anemoUrl) throw new HttpError(409, 'Die öffentliche Adresse von Anemo ist nicht eingestellt (Administration → Einstellungen → Allgemein: ANEMO_PUBLIC_URL) – ohne sie startet Anemo keine Pipeline');
    const [l] = await db<{ settings: { ciRef?: unknown; ciRefs?: unknown; ciVariables?: unknown } }[]>`select settings from project_integration where project_id = ${cy.projectId} and provider = 'gitlab'`;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []);
    const defaultRef = typeof l?.settings?.ciRef === 'string' && l.settings.ciRef.trim() ? l.settings.ciRef.trim() : link.branch;
    // Nur der zugeordnete CI-Zweig bzw. die in der Zuordnung freigegebenen Zweige (keine geschützten Branches/Tags nach Wahl)
    const allowedRefs = new Set([defaultRef, ...strings(l?.settings?.ciRefs)]);
    const ref = body.ref ?? defaultRef;
    if (!allowedRefs.has(ref)) throw new HttpError(400, `Zweig „${ref}“ ist für CI-Läufe nicht freigegeben (erlaubt: ${[...allowedRefs].join(', ')})`);
    const allowedVars = strings(l?.settings?.ciVariables);
    for (const k of Object.keys(body.variables ?? {})) {
      const problem = ciVariableProblem(k, allowedVars);
      if (problem) throw new HttpError(400, problem);
    }
    const p = await gl.triggerPipeline(link.project, ref, {
      ...body.variables, ANEMO_URL: anemoUrl, ANEMO_PROJECT: cy.projectKey, ANEMO_CYCLE_ID: params.id!, ANEMO_CYCLE_NAME: cy.name, ...(cy.build ? { ANEMO_BUILD: cy.build } : {}),
    });
    const [run] = await db`insert into ci_run(cycle_id, provider, external_id, ref, url, status, triggered_by)
      values (${params.id!}, 'gitlab', ${String(p.id)}, ${p.ref ?? ref}, ${/^https?:\/\//.test(p.web_url) ? p.web_url : null}, ${p.status}, ${actor}) returning *`;
    await linkReference(db, { ownerType: 'TEST_CYCLE', ownerId: params.id!, provider: 'gitlab', externalKey: `${link.project}#pipeline-${p.id}`, relation: 'AUTOMATION', url: /^https?:\/\//.test(p.web_url) ? p.web_url : null, title: `Pipeline ${p.id} (${ref})`, status: p.status }, actor);
    return run;
  });

  // ---- GitLab je Projekt: Gherkin ↔ .feature, Merge-Requests/Commits ----
  const projAccess = (level: 'read' | 'edit') => ({ level, project: ({ params }: { params: Record<string, string> }) => ({ kind: 'project' as const, key: params.key! }) });
  route(app, { method: 'get', path: '/api/projects/:key/gitlab/status', tag, summary: 'GitLab-Anbindung des Projekts', access: projAccess('read') }, async ({ params }) => {
    const p = await getProject(db, params.key!);
    try {
      const { link } = await gitlabTarget(db, p.id);
      // erlaubte CI-Zweige für die Auswahl im Zyklus (CI-Zweig bzw. Gherkin-Zweig plus Freigaben)
      const [l] = await db<{ settings: { ciRef?: string; ciRefs?: string[] } }[]>`select settings from project_integration where project_id = ${p.id} and provider = 'gitlab'`;
      const ciRef = l?.settings?.ciRef || link.branch;
      return { available: true, reason: null, ...link, ciRef, ciRefs: [...new Set([ciRef, ...(l?.settings?.ciRefs ?? [])])] };
    } catch (e) {
      return { available: false, reason: (e as Error).message };
    }
  });
  route(app, { method: 'get', path: '/api/projects/:key/gitlab/compare', tag, summary: 'Gherkin-Testfälle mit .feature-Dateien im Repository vergleichen', access: projAccess('read') }, async ({ params }) => {
    const p = await getProject(db, params.key!);
    const { gl, link } = await gitlabTarget(db, p.id);
    return { link, entries: await compare(db, gl, link, p.id) };
  });
  route(app, { method: 'post', path: '/api/projects/:key/gitlab/export', tag, summary: 'Geänderte Gherkin-Testfälle als .feature-Dateien committen', access: projAccess('edit') }, async ({ params, actor }) => {
    const p = await getProject(db, params.key!);
    const { gl, link } = await gitlabTarget(db, p.id);
    // externe Aufrufe außerhalb einer Transaktion: erst vergleichen und committen, dann den Stand kurz speichern
    const plan = await planFeatureExport(db, gl, link, p.id);
    const commit = await commitFeatures(gl, link, plan, actor);
    await inTx(db, (tx) => markFeaturesSynced(tx, plan, actor));
    return { commit, created: plan.actions.filter((a) => a.action === 'create').length, updated: plan.actions.filter((a) => a.action === 'update').length, skippedChangedInGit: plan.skipped };
  });
  route(app, {
    method: 'post', path: '/api/projects/:key/gitlab/import', tag, summary: 'Änderungen aus .feature-Dateien als neue Versionen bzw. Testfälle übernehmen', access: projAccess('edit'),
    body: z.object({ paths: z.array(z.string().min(1)).min(1).max(500) }),
  }, async ({ params, body, actor }) => {
    const p = await getProject(db, params.key!);
    const { gl, link } = await gitlabTarget(db, p.id);
    // Dateien vor der Transaktion lesen (keine HTTP-Wartezeit bei offener Transaktion)
    const files = await readFeatureFiles(gl, link, body.paths);
    return inTx(db, (tx) => applyFeatureImport(tx, link, p.id, files, actor));
  });
  route(app, {
    method: 'get', path: '/api/projects/:key/gitlab/search', tag, summary: 'Merge-Requests suchen bzw. Commit per SHA finden (zum Verknüpfen)', access: projAccess('read'),
    query: z.object({ q: z.string().min(1) }),
  }, async ({ params, query }) => {
    const p = await getProject(db, params.key!);
    const { gl, link } = await gitlabTarget(db, p.id);
    const out: { key: string; title: string; status: string; type: string; url: string }[] = [];
    if (/^[0-9a-f]{7,40}$/i.test(query.q)) {
      const c = await gl.getCommit(link.project, query.q).catch(() => null);
      if (c) out.push({ key: `${link.project}@${c.short_id}`, title: c.title, status: 'Commit', type: 'Commit', url: c.web_url });
    }
    for (const mr of await gl.searchMergeRequests(link.project, query.q.replace(/^!/, ''))) {
      out.push({ key: `${link.project}!${mr.iid}`, title: mr.title, status: mr.state, type: 'Merge-Request', url: mr.web_url });
    }
    return out;
  });

  // ---- Projektzuordnung ----
  const manage = { level: 'manage' as const, project: ({ params }: { params: Record<string, string> }) => ({ kind: 'project' as const, key: params.key! }) };
  route(app, { method: 'get', path: '/api/projects/:key/integrations', tag, summary: 'Zuordnungen des Projekts zu Fremdsystemen', access: manage }, async ({ params }) => {
    const p = await getProject(db, params.key!);
    return db`select provider, external_project, settings from project_integration where project_id = ${p.id}`;
  });
  route(app, {
    // Nur Systemadministration: die Zuordnung lenkt das globale Servicekonto (Token) auf ein Ziel-Repository/-Projekt
    method: 'put', path: '/api/projects/:key/integrations/:provider', tag, summary: 'Zuordnung setzen (externalProject null = entfernen)', access: 'admin', status: 204,
    body: z.object({ externalProject: z.string().trim().min(1).max(200).nullable(), settings: z.record(z.string(), z.unknown()).optional() }),
  }, async ({ params, body }) => {
    const p = await getProject(db, params.key!);
    if (!['openproject', 'gitlab', 'jira'].includes(params.provider!)) throw notFound('Integration', params.provider);
    if (body.externalProject !== null && params.provider === 'openproject') {
      const cfg = openProjectConfig();
      if (cfg) {
        const known = await new OpenProjectAdapter(cfg).projects().catch(() => null);
        if (known && !known.some((x) => x.identifier === body.externalProject)) throw new HttpError(400, `OpenProject-Projekt „${body.externalProject}“ nicht gefunden (Kennung des Projekts in OpenProject)`);
      }
    }
    if (body.externalProject !== null && params.provider === 'gitlab') {
      // CI: freigegebene Zweige und Variablennamen (Steuervariablen wie CI_*, GITLAB_*, *_DEBUG_* bleiben verboten)
      const st = body.settings ?? {};
      for (const [k, re] of [['ciRefs', /^[\w./-]{1,200}$/], ['ciVariables', /^[A-Za-z_][A-Za-z0-9_]{0,63}$/]] as const) {
        const v = st[k];
        if (v === undefined) continue;
        if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === 'string' && re.test(x))) throw new HttpError(400, `${k}: Liste gültiger Namen erwartet`);
      }
      for (const name of (st.ciVariables as string[] | undefined) ?? []) {
        const problem = ciVariableProblem(name, [name]);
        if (problem) throw new HttpError(400, problem);
      }
    }
    forgetWorkPackageProjects();
    if (body.externalProject === null) await db`delete from project_integration where project_id = ${p.id} and provider = ${params.provider!}`;
    else await db`insert into project_integration(project_id, provider, external_project, settings)
      values (${p.id}, ${params.provider!}, ${body.externalProject}, ${db.json((body.settings ?? {}) as never)})
      on conflict (project_id, provider) do update set external_project = excluded.external_project, settings = excluded.settings`;
  });

  // ---- Fehlervorlagen ----
  const TemplateBody = z.object({
    projectKey: z.string().nullable(), name: z.string().min(1).max(120), titleTemplate: z.string().min(1).max(500),
    bodyTemplate: z.string().min(1).max(20_000), isDefault: z.boolean(),
  });
  const toTemplate = async (b: z.infer<typeof TemplateBody>) => ({
    projectId: b.projectKey ? (await getProject(db, b.projectKey)).id : null, name: b.name, titleTemplate: b.titleTemplate, bodyTemplate: b.bodyTemplate, isDefault: b.isDefault,
  });
  route(app, {
    method: 'get', path: '/api/defect-templates', tag, summary: 'Fehlervorlagen (global und je Projekt)',
    access: ({ query }) => { const p = (query as { project?: string }).project; return p ? { level: 'read', project: () => ({ kind: 'project', key: p }) } : 'authenticated'; },
    query: z.object({ project: z.string().optional() }),
  }, async ({ query }) => listTemplates(db, query.project ? (await getProject(db, query.project)).id : null));
  route(app, { method: 'post', path: '/api/admin/defect-templates', tag, summary: 'Fehlervorlage anlegen', access: 'admin', body: TemplateBody, status: 201 },
    async ({ body }) => inTx(db, async (tx) => saveTemplate(tx, null, await toTemplate(body))));
  route(app, { method: 'put', path: '/api/admin/defect-templates/:id', tag, summary: 'Fehlervorlage ändern', access: 'admin', body: TemplateBody },
    async ({ params, body }) => inTx(db, async (tx) => saveTemplate(tx, params.id!, await toTemplate(body))));
  route(app, { method: 'delete', path: '/api/admin/defect-templates/:id', tag, summary: 'Fehlervorlage löschen', access: 'admin', status: 204 },
    ({ params }) => deleteTemplate(db, params.id!));

  // ---- Fehler melden ----
  route(app, {
    method: 'post', path: '/api/executions/:id/defect-draft', tag, summary: 'Fehlermeldung aus Vorlage vorbereiten (speichert nichts)', access: execAccess('execute'),
    body: z.object({ templateId: z.uuid().optional(), stepId: z.string().optional() }),
  }, async ({ params, body }) => {
    const d = await draftDefect(db, params.id!, { ...body, baseUrl: publicBase() });
    const t = await defectSink(db, d.projectId);
    return { ...d, target: { provider: t.provider, available: t.available, reason: t.reason, externalProject: t.externalProject } };
  });
  route(app, {
    method: 'post', path: '/api/executions/:id/defects', tag, summary: 'Fehler im Fremdsystem anlegen und mit der Ausführung verknüpfen', access: execAccess('execute'), status: 201,
    body: z.object({
      title: z.string().min(1).max(255), body: z.string().max(50_000),
      stepId: z.string().max(200).nullish(), severity: z.enum(SEVERITIES).nullish(),
    }),
  }, async ({ params, body, actor }) => {
    const [e] = await db<{ projectId: string }[]>`select c.project_id from test_execution e join test_cycle c on c.id = e.cycle_id where e.id = ${params.id!}`;
    if (!e) throw notFound('Ausführung', params.id);
    if (body.stepId && !(await getExecution(db, params.id!)).steps.some((s) => s.id === body.stepId)) throw new HttpError(400, 'Schritt gehört nicht zu dieser Ausführung');
    const sink = await defectSink(db, e.projectId);
    if (!sink.available) throw new HttpError(409, sink.reason ?? 'Integration nicht verfügbar');
    const wp = await sink.create({ title: body.title, description: body.body, severity: body.severity, origin: { kind: 'ausfuehrung', id: params.id! } });
    return inTx(db, (tx) => linkReference(tx, {
      ownerType: 'TEST_EXECUTION', ownerId: params.id!, provider: sink.provider, externalKey: wp.key, relation: 'DEFECT', url: wp.url, title: wp.title, status: wp.status,
      stepId: body.stepId ?? null, severity: body.severity ?? null,
    }, actor));
  });
  route(app, {
    method: 'post', path: '/api/sessions/:id/findings/:fid/defect', tag, status: 201,
    summary: 'Fehler-Beobachtung einer explorativen Sitzung als Fehler anlegen (OpenProject bzw. Jira) und verknüpfen – auch nach Abschluss der Sitzung',
    access: { level: 'execute', project: ({ params }) => ({ kind: 'session', id: params.id! }) },
    body: z.object({ title: z.string().trim().min(1).max(255).optional(), body: z.string().max(50_000).optional(), severity: z.enum(SEVERITIES).nullish() }),
  }, async ({ params, body, actor }) => {
    type Finding = { id: string; kind: string; text: string; defectKey?: string | null; defectPending?: string | null };
    const [s] = await db<{ id: string; cycleId: string; charter: string; tester: string | null; findings: Finding[]; projectId: string; projectKey: string; cycleName: string; build: string | null; environment: string | null }[]>`
      select s.id, s.cycle_id, s.charter, s.tester, s.findings, c.project_id, p.key as project_key, c.name as cycle_name, c.build, c.environment
      from exploratory_session s join test_cycle c on c.id = s.cycle_id join project p on p.id = c.project_id where s.id = ${params.id!}`;
    if (!s) throw notFound('Sitzung', params.id);
    const f = s.findings.find((x) => x.id === params.fid);
    if (!f) throw notFound('Beobachtung', params.fid);
    if (f.defectKey) throw new HttpError(409, `Bereits als Fehler ${f.defectKey} übernommen`);
    const sink = await defectSink(db, s.projectId);
    if (!sink.available) throw new HttpError(409, sink.reason ?? 'Integration nicht verfügbar');
    // Doppelanlage verhindern: Fund unter Zeilensperre als „wird angelegt“ markieren, bevor das Ticket entsteht
    // (Doppelklick, zwei Personen gleichzeitig). Eine Markierung älter als 10 Minuten gilt als verwaist.
    const setFinding = (tx: Db, patch: Partial<Finding>) => tx`
      update exploratory_session set findings = (select coalesce(jsonb_agg(case when e->>'id' = ${f.id} then e || ${tx.json(patch as never)} else e end order by n), '[]'::jsonb)
        from jsonb_array_elements(findings) with ordinality as t(e, n)), updated_at = now() where id = ${s.id}`;
    const marker = new Date().toISOString();
    await inTx(db, async (tx) => {
      const [cur] = await tx<{ findings: Finding[] }[]>`select findings from exploratory_session where id = ${s.id} for update`;
      const now = cur!.findings.find((x) => x.id === f.id);
      if (!now) throw notFound('Beobachtung', params.fid);
      if (now.defectKey) throw new HttpError(409, `Bereits als Fehler ${now.defectKey} übernommen`);
      if (now.defectPending && Date.now() - new Date(now.defectPending).getTime() < 10 * 60_000) throw new HttpError(409, 'Der Fehler wird gerade angelegt – bitte einen Moment warten');
      await setFinding(tx, { defectPending: marker });
    });
    const link = goLink('sitzung', s.id);
    const description = body.body ?? [
      'h3. Beobachtung', f.text, '', 'h3. Explorative Sitzung',
      `* Auftrag (Charter): ${s.charter}`, `* Tester: ${s.tester ?? '–'}`, `* Zyklus: ${s.cycleName}${s.build ? `, Build ${s.build}` : ''}${s.environment ? `, Umgebung ${s.environment}` : ''}`,
      ...(link ? [`* In Anemo: ${link}`] : []),
    ].join('\n');
    let wp: Awaited<ReturnType<DefectSink['create']>>;
    try {
      wp = await sink.create({ title: body.title ?? f.text.split('\n')[0]!.slice(0, 200), description, severity: body.severity, origin: { kind: 'sitzung', id: s.id } });
    } catch (e) {
      await setFinding(db, { defectPending: null }); // Markierung zurücknehmen, erneuter Versuch möglich
      throw e;
    }
    return inTx(db, async (tx) => {
      // Funde atomar aktualisieren (parallel hinzugefügte Beobachtungen bleiben erhalten)
      await tx`select 1 from exploratory_session where id = ${s.id} for update`;
      await setFinding(tx, { defectKey: wp.key, defectPending: null });
      return linkReference(tx, { ownerType: 'EXPLORATORY_SESSION', ownerId: s.id, provider: sink.provider, externalKey: wp.key, relation: 'DEFECT', url: wp.url, title: wp.title, status: wp.status, severity: body.severity ?? null }, actor);
    });
  });
  route(app, {
    method: 'get', path: '/api/projects/:key/integrations/openproject/coverage', tag, summary: 'Teststand je OpenProject-Anforderung (was ins Ticket gemeldet wird)',
    access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
  }, async ({ params }) => {
    const p = await getProject(db, params.key!);
    const [l] = await db<{ settings: { coverageComments?: boolean } }[]>`select settings from project_integration where project_id = ${p.id} and provider = 'openproject'`;
    return { enabled: !!l?.settings?.coverageComments, requirements: await requirementCoverage(db, p.id) };
  });
  route(app, {
    method: 'post', path: '/api/projects/:key/integrations/openproject/coverage', tag, summary: 'Geänderte Abdeckungsstände jetzt in die Tickets melden',
    access: { level: 'manage', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
  }, async ({ params }) => {
    const p = await getProject(db, params.key!);
    const t = await target(db, p.id);
    if (!t.available || !t.adapter || !t.externalProject) throw new HttpError(409, t.reason ?? 'Integration nicht verfügbar');
    return pushCoverage(db, t.adapter, p.id, t.externalProject, publicBase() || null, p.key);
  });
  route(app, {
    method: 'get', path: '/api/projects/:key/integrations/openproject/work-items/:id', tag,
    summary: 'Arbeitspaket per Nummer nachschlagen (zum Verknüpfen). Mit Zuordnung nur Arbeitspakete des zugeordneten Projekts; ohne Zuordnung nur Nummer und Link (title/status null – sie kommen nicht aus OpenProject)',
    access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) },
  }, async ({ params }) => {
    const p = await getProject(db, params.key!);
    const cfg = openProjectConfig();
    if (!cfg) throw new HttpError(409, 'OpenProject ist noch nicht eingerichtet');
    if (p.externalServices !== 'allowed') throw new HttpError(409, 'Für dieses Projekt sind externe Dienste gesperrt');
    const key = params.id!.replace(/^#/, '').trim().toUpperCase();
    if (!isWorkPackageKey(key)) throw new HttpError(400, 'Bitte die Nummer (z. B. 4711) oder den Schlüssel (z. B. PROJ-315) des Arbeitspakets angeben');
    const t = await target(db, p.id);
    // ohne Zuordnung keine Inhalte über das Servicekonto (sonst wäre jedes für das Konto sichtbare Arbeitspaket lesbar)
    if (!t.externalProject) return { key, title: null, status: null, type: null, url: `${cfg.url}/work_packages/${key}`, resolved: false, verified: false };
    const [w] = await new OpenProjectAdapter(cfg).getWorkItems([key], t.externalProject);
    if (!w) throw notFound('Arbeitspaket im zugeordneten OpenProject-Projekt', key);
    return { ...w, verified: true };
  });
  route(app, { method: 'get', path: '/api/admin/integrations/openproject/projects', tag, summary: 'OpenProject-Projekte und vorhandene Zuordnungen', access: 'admin' }, async () => {
    const cfg = openProjectConfig();
    if (!cfg) throw new HttpError(409, 'OpenProject ist noch nicht eingerichtet');
    const links = await db<{ key: string; name: string; externalServices: string; externalProject: string | null; settings: Record<string, unknown> | null }[]>`
      select p.key, p.name, p.external_services, i.external_project, i.settings from project p
      left join project_integration i on i.project_id = p.id and i.provider = 'openproject' order by p.key`;
    return { openProject: await new OpenProjectAdapter(cfg).projects(), links };
  });
  // ---- Rückverweis in OpenProject (Felder statt Text) ----
  route(app, { method: 'get', path: '/api/admin/integrations/openproject/fields', tag, summary: 'Benutzerdefinierte Felder der zugeordneten OpenProject-Projekte (Typ neuer Fehler) – zur Auswahl der Rückverweis-Felder', access: 'admin' }, async () => {
    const cfg = openProjectConfig();
    if (!cfg) throw new HttpError(409, 'OpenProject ist noch nicht eingerichtet');
    const adapter = new OpenProjectAdapter(cfg);
    const maps = await db<{ key: string; externalProject: string; settings: { typeId?: number } | null }[]>`
      select p.key, i.external_project, i.settings from project_integration i join project p on p.id = i.project_id where i.provider = 'openproject' and i.external_project is not null order by p.key`;
    const fields = new Map<string, { id: string; name: string; type: string; projects: string[] }>();
    const problems: string[] = [];
    for (const m of maps) {
      try {
        for (const [id, f] of await adapter.fieldsOf(m.externalProject, m.settings?.typeId ?? null)) {
          const e = fields.get(id) ?? { id, name: f.name, type: f.type, projects: [] };
          e.projects.push(m.key);
          fields.set(id, e);
        }
      } catch (e) { problems.push(`${m.key}: ${(e as Error).message}`); }
    }
    const env = settingsEnv();
    return { fields: [...fields.values()].sort((a, b) => a.name.localeCompare(b.name, 'de')), projects: maps.map((m) => m.key), problems,
      linkField: env.OPENPROJECT_LINK_FIELD ?? null, testCaseField: env.OPENPROJECT_TESTCASE_FIELD ?? null, publicUrl: publicBase() || null };
  });
  route(app, {
    method: 'post', path: '/api/admin/integrations/openproject/backlinks', tag, access: 'admin', body: z.object({ dryRun: z.boolean().default(true) }),
    summary: 'Rückverweis-Feld in allen verknüpften Arbeitspaketen auf den dauerhaften Anemo-Link setzen (z. B. nach einem Umzug); fremde Werte bleiben',
  }, async ({ body }) => updateBacklinks(db, body.dryRun));
  route(app, { method: 'get', path: '/api/admin/integrations/openproject/projects/:id/types', tag, summary: 'Typen eines OpenProject-Projekts', access: 'admin' }, async ({ params }) => {
    const cfg = openProjectConfig();
    if (!cfg) throw new HttpError(409, 'OpenProject ist noch nicht eingerichtet');
    return new OpenProjectAdapter(cfg).types(params.id!);
  });
  route(app, {
    method: 'get', path: '/api/projects/:key/integrations/openproject/search', tag, summary: 'Arbeitspakete in OpenProject suchen (zum Verknüpfen)',
    access: { level: 'read', project: ({ params }) => ({ kind: 'project', key: params.key! }) }, query: z.object({ q: z.string().min(1) }),
  }, async ({ params, query }) => {
    const p = await getProject(db, params.key!);
    const t = await target(db, p.id);
    if (!t.available || !t.adapter) throw new HttpError(409, t.reason ?? 'Integration nicht verfügbar');
    return t.adapter.searchWorkItems(query.q, 20, t.externalProject);
  });
}
