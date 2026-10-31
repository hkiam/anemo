/**
 * Normalizer: reine Funktionen, die Rohdaten aus Jira (REST v2) und Zephyr for Jira (ZAPI) in das
 * kanonische QA-Modell überführen. Jede Funktion meldet, welche Felder strukturiert übernommen,
 * nur bewahrt (customFields + Raw Store) oder bewusst ignoriert wurden (ADR-0006).
 */
import { convertStep } from '../../../../shared/steps/groups.ts';
import type { TestCaseContentInput } from '../testcases/index.ts';
import type { Relation } from '../references/index.ts';
import { parseDescription } from './wiki.ts';

type Json = Record<string, any>;

export interface FieldInfo { id: string; name: string; custom: boolean; schema?: { type?: string; custom?: string } }

export interface Normalized<T> {
  value: T;
  /** Felder, deren Information nur in customFields bzw. im Raw Store liegt. */
  preserved: string[];
  /** Felder ohne fachlichen Informationsgehalt (Zähler, Ansichtsdaten, leere Werte). Bleiben im Raw Store. */
  ignored: string[];
  messages: string[];
}

/** Systemfelder ohne fachlichen Wert für das QA-Modell. */
const NOISE_FIELDS = new Set([
  'updated', 'lastViewed', 'watches', 'votes', 'workratio', 'progress', 'aggregateprogress',
  'aggregatetimeestimate', 'aggregatetimeoriginalestimate', 'aggregatetimespent', 'timeestimate',
  'timeoriginalestimate', 'timespent', 'timetracking', 'thumbnail', 'statuscategorychangedate',
]);

/** Felder, die der Normalizer strukturiert verarbeitet. */
const MAPPED_FIELDS = new Set([
  'summary', 'description', 'status', 'priority', 'labels', 'components', 'assignee', 'reporter', 'creator',
  'created', 'issuetype', 'project', 'issuelinks', 'subtasks', 'attachment', 'versions', 'fixVersions',
  'resolution', 'resolutiondate', 'parent', 'comment', 'worklog', 'environment', 'duedate', 'security',
]);

const isEmpty = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Komplexe Jira-Werte auf ihre fachliche Aussage reduzieren (Optionen, Benutzer, Versionen …). */
export function simplify(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(simplify);
  if (v && typeof v === 'object') {
    const o = v as Json;
    if ('value' in o && typeof o.value !== 'object') return o.child ? `${o.value} / ${simplify(o.child)}` : o.value;
    if ('displayName' in o) return o.displayName;
    if ('name' in o && typeof o.name === 'string') return o.name;
    if ('key' in o && typeof o.key === 'string') return o.key;
    return o;
  }
  if (typeof v === 'string') {
    const sprint = /com\.atlassian\.greenhopper\.service\.sprint\.Sprint@\w+\[(.*)\]/.exec(v);
    if (sprint) {
      const attrs = Object.fromEntries(sprint[1]!.split(',').map((kv) => kv.split('=') as [string, string]));
      return { name: attrs.name, state: attrs.state, id: attrs.id };
    }
  }
  return v;
}

const userName = (u: Json | null | undefined): string | null => u?.displayName ?? u?.name ?? null;

export interface TestIssueDraft {
  legacyKey: string;
  issueId: string;
  projectKey: string;
  status: string;
  owner: string | null;
  createdBy: string;
  createdAt: Date | undefined;
  folderPath: string[];
  content: TestCaseContentInput;
  references: { provider: string; externalKey: string; relation: Relation; url: string | null; title: string | null; status: string | null }[];
  attachments: { sourceId: string; fileName: string; contentType: string | null; sizeBytes: number | null; url: string; author: string | null; createdAt: Date | undefined }[];
}

function relationFor(issueType: string | undefined, linkType: string | undefined): Relation {
  const t = (issueType ?? '').toLowerCase();
  if (/bug|fehler|defect/.test(t)) return 'DEFECT';
  if (/epic/.test(t)) return 'EPIC';
  if (/story/.test(t)) return 'STORY';
  if (/anforderung|requirement/.test(t)) return 'REQUIREMENT';
  if (/^tests?$/i.test(linkType ?? '') || /is tested by|testet/i.test(linkType ?? '')) return 'REQUIREMENT';
  return 'RELATED';
}

export function normalizeTestIssue(
  issue: Json, teststeps: Json[] | null, fieldsById: Map<string, FieldInfo>, baseUrl: string,
): Normalized<TestIssueDraft> {
  const f: Json = issue.fields ?? {};
  const preserved: string[] = [];
  const ignored: string[] = [];
  const messages: string[] = [];
  const customFields: Record<string, unknown> = {};
  const browse = (key: string) => `${baseUrl}/browse/${key}`;

  const desc = parseDescription(f.description);
  if (desc.emptyPanels.length) messages.push(`Leere Vorlagen-Panels übersprungen: ${desc.emptyPanels.join(', ')}`);

  const references: TestIssueDraft['references'] = [];
  for (const link of f.issuelinks ?? []) {
    const other = link.outwardIssue ?? link.inwardIssue;
    if (!other) continue;
    const linkType = link.outwardIssue ? link.type?.outward : link.type?.inward;
    references.push({
      provider: 'jira', externalKey: other.key, relation: relationFor(other.fields?.issuetype?.name, linkType),
      url: browse(other.key), title: other.fields?.summary ?? null, status: other.fields?.status?.name ?? null,
    });
  }
  for (const sub of f.subtasks ?? []) {
    references.push({
      provider: 'jira', externalKey: sub.key, relation: 'SUBTASK', url: browse(sub.key),
      title: sub.fields?.summary ?? null, status: sub.fields?.status?.name ?? null,
    });
  }
  if (f.parent?.key) {
    references.push({ provider: 'jira', externalKey: f.parent.key, relation: 'RELATED', url: browse(f.parent.key), title: f.parent.fields?.summary ?? null, status: null });
  }

  const jira: Record<string, unknown> = {
    issueType: f.issuetype?.name ?? null,
    status: f.status?.name ?? null,
  };
  if (!isEmpty(f.versions)) jira.affectsVersions = simplify(f.versions);
  if (!isEmpty(f.fixVersions)) jira.fixVersions = simplify(f.fixVersions);
  if (f.resolution) jira.resolution = f.resolution.name;
  if (f.resolutiondate) jira.resolutionDate = f.resolutiondate;

  // Kommentare, Arbeitsprotokolle, Umgebung, Fälligkeit: bislang ohne eigenes Zielmodell → bewahren.
  const comments = f.comment?.comments ?? [];
  if (comments.length) {
    customFields.comments = comments.map((c: Json) => ({ author: userName(c.author), created: c.created, body: c.body }));
    preserved.push('comment');
  }
  for (const [field, label] of [['worklog', 'worklog'], ['environment', 'environment'], ['duedate', 'dueDate'], ['security', 'securityLevel']] as const) {
    const value = field === 'worklog' ? f.worklog?.worklogs : f[field];
    if (!isEmpty(value)) {
      customFields[label] = simplify(value);
      preserved.push(field);
    }
  }

  // Alle übrigen Felder: Custom Fields mit bekanntem Sinn strukturiert, sonst bewahren.
  for (const [id, value] of Object.entries(f)) {
    if (MAPPED_FIELDS.has(id)) continue;
    if (NOISE_FIELDS.has(id)) {
      ignored.push(id);
      continue;
    }
    if (isEmpty(value)) {
      ignored.push(id);
      continue;
    }
    const name = fieldsById.get(id)?.name ?? id;
    if (/^epic link$/i.test(name) && typeof value === 'string') {
      references.push({ provider: 'jira', externalKey: value, relation: 'EPIC', url: browse(value), title: null, status: null });
      continue;
    }
    if (/^sprint$/i.test(name)) {
      jira.sprints = simplify(value);
      continue;
    }
    if (/^rank\b/i.test(name)) {
      ignored.push(`${id} (${name})`); // Sortierschlüssel der Jira-Boards, kein Fachinhalt
      continue;
    }
    if (/^test ?types?$|^testarten?$/i.test(name)) {
      customFields.testTypes = simplify(value);
      continue;
    }
    customFields[name] = simplify(value);
    preserved.push(id === name ? id : `${id} (${name})`);
  }
  customFields.jira = jira;

  const steps = (teststeps ?? [])
    .slice()
    .sort((a, b) => (a.orderId ?? 0) - (b.orderId ?? 0))
    .map((s) => ({ id: `zapi-${s.id}`, action: s.step ?? '', data: s.data ?? '', expected: s.result ?? '' }))
    // Pfeil-Trennschritte aus Zephyr werden Abschnitte (Stufe J1); Original bleibt in `legacy`
    .map((s) => convertStep(s));
  if (teststeps === null) messages.push('Keine ZAPI-Testschritte im Snapshot (Datei fehlt)');
  const stepExtras = (teststeps ?? []).flatMap((s) => Object.keys(s).filter((k) => !STEP_KNOWN.has(k) && !isEmpty(s[k])));
  if (stepExtras.length) {
    customFields.stepAttributes = (teststeps ?? []).map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !STEP_KNOWN.has(k))));
    preserved.push(...new Set(stepExtras.map((k) => `teststep.${k}`)));
  }

  const components: string[] = (f.components ?? []).map((c: Json) => c.name);
  const attachments = (f.attachment ?? []).map((a: Json) => ({
    sourceId: `jira-${a.id}`,
    fileName: a.filename, contentType: a.mimeType ?? null, sizeBytes: a.size ?? null, url: a.content,
    author: userName(a.author), createdAt: a.created ? new Date(a.created) : undefined,
  }));
  if (issue.changelog?.histories?.length) {
    messages.push(`Änderungshistorie (${issue.changelog.histories.length} Einträge) liegt im Raw Store; Rekonstruktion früherer Versionen folgt`);
  }

  return {
    value: {
      legacyKey: issue.key,
      issueId: String(issue.id),
      projectKey: f.project?.key ?? String(issue.key).split('-')[0],
      status: f.status?.name ?? 'UNKNOWN',
      owner: userName(f.assignee),
      createdBy: userName(f.reporter) ?? userName(f.creator) ?? 'migration',
      createdAt: f.created ? new Date(f.created) : undefined,
      folderPath: [components[0] ?? '(ohne Komponente)'],
      content: {
        title: (f.summary ?? '').trim() || `(ohne Titel) ${issue.key}`,
        format: 'CLASSIC',
        objective: desc.objective,
        preconditions: desc.preconditions,
        testData: desc.testData,
        priority: f.priority?.name ?? null,
        labels: [...(f.labels ?? [])].sort(),
        components,
        steps,
        sections: desc.sections,
        customFields,
      },
      references,
      attachments,
    },
    preserved,
    ignored,
    messages,
  };
}

const STEP_KNOWN = new Set(['id', 'orderId', 'step', 'data', 'result', 'htmlStep', 'htmlData', 'htmlResult', 'createdBy', 'modifiedBy', 'createdOn', 'modifiedOn', 'issueId']);

// ---- ZAPI: Zyklen, Status, Ausführungen ----

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, mär: 2, mrz: 2, apr: 3, may: 4, mai: 4, jun: 5, jul: 6, aug: 7, sep: 8,
  oct: 9, okt: 9, nov: 10, dec: 11, dez: 11,
};

/** ZAPI liefert Datumswerte lokalisiert ("11/Okt/26", "11/Oct/26 10:15 AM") oder als Epoch-Millisekunden. */
export function parseZapiDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return new Date(v);
  const s = String(v).trim();
  if (/^\d{10,13}$/.test(s)) return new Date(Number(s.length === 10 ? Number(s) * 1000 : s));
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return new Date(s);
  let m = /^(\d{1,2})\/([A-Za-zäÄ]{3})\w*\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?$/i.exec(s);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    if (month === undefined) return null;
    const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    let hour = m[4] ? Number(m[4]) : 0;
    if (m[6]?.toUpperCase() === 'PM' && hour < 12) hour += 12;
    if (m[6]?.toUpperCase() === 'AM' && hour === 12) hour = 0;
    return new Date(year, month, Number(m[1]), hour, m[5] ? Number(m[5]) : 0);
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(s);
  if (m) return new Date(m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return null;
}

const toIsoDate = (d: Date | null) =>
  d ? `${String(d.getFullYear()).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;

/** Tippfehler in Altdaten (z. B. Jahr 21 statt 2021) nicht als echtes Datum übernehmen. */
export const isPlausibleDate = (d: Date | null): d is Date =>
  !!d && !Number.isNaN(d.getTime()) && d.getFullYear() >= 1990 && d.getFullYear() <= 2100;

const STANDARD_STATUS: Record<string, string> = {
  PASS: 'PASS', PASSED: 'PASS', FAIL: 'FAIL', FAILED: 'FAIL', WIP: 'WIP', 'IN PROGRESS': 'WIP',
  BLOCKED: 'BLOCKED', UNEXECUTED: 'NOT_EXECUTED', 'NOT EXECUTED': 'NOT_EXECUTED',
};

export interface StatusMapping { sourceId: string; code: string; name: string; color: string | null; custom: boolean }

/** Zephyr-Systemstatus haben feste IDs; ihre Namen sind frei übersetzbar (z. B. "BESTANDEN"). */
const SYSTEM_STATUS_BY_ID: Record<string, string> = { '-1': 'NOT_EXECUTED', '1': 'PASS', '2': 'FAIL', '3': 'WIP', '4': 'BLOCKED' };

export function normalizeStatus(s: Json): StatusMapping {
  const name = String(s.name ?? s.id);
  const isSystem = s.type === undefined || Number(s.type) === 0;
  const std = (isSystem ? SYSTEM_STATUS_BY_ID[String(s.id)] : undefined) ?? STANDARD_STATUS[name.toUpperCase()];
  const code = std ?? name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return { sourceId: String(s.id), code: code || `ZEPHYR_${s.id}`, name, color: s.color ?? null, custom: !std };
}

export interface CycleDraft {
  sourceId: string;
  cycleId: string;
  versionId: string;
  versionName: string;
  name: string;
  description: string | null;
  build: string | null;
  environment: string | null;
  startDate: string | null;
  endDate: string | null;
  createdBy: string | null;
  customFields: Record<string, unknown>;
}

const CYCLE_KNOWN = new Set([
  'name', 'description', 'build', 'environment', 'startDate', 'endDate', 'versionName', 'versionId', 'projectId',
  'createdBy', 'createdByDisplay', 'modifiedBy', 'projectKey', 'id', 'cycleId',
]);
const CYCLE_NOISE = new Set(['totalExecutions', 'totalExecuted', 'executionSummaries', 'started', 'expand', 'totalCycleExecutions', 'totalDefects', 'isExecutionWorkflowEnabledForProject', 'isTimeTrackingEnabled', 'sprintId', 'totalFolders', 'createdDate', 'ended']);

export function normalizeCycle(cycleId: string, raw: Json, versionId: string, versionName: string | null): Normalized<CycleDraft> {
  const preserved: string[] = [];
  const ignored: string[] = [];
  const messages: string[] = [];
  const customFields: Record<string, unknown> = { zephyr: { cycleId, versionId, modifiedBy: raw.modifiedBy ?? null } };
  const dates: Record<'startDate' | 'endDate', Date | null> = { startDate: null, endDate: null };
  for (const k of ['startDate', 'endDate'] as const) {
    const value = raw[k];
    if (value === null || value === undefined || value === '') continue;
    const d = parseZapiDate(value);
    if (isPlausibleDate(d)) {
      dates[k] = d;
    } else {
      customFields[k] = value;
      preserved.push(k);
      messages.push(d ? `Datum unplausibel: ${k} = ${toIsoDate(d)} (Originalwert ${value} bewahrt)` : `Datum nicht lesbar: ${k}="${value}"`);
    }
  }
  const start = dates.startDate;
  const end = dates.endDate;
  for (const [k, v] of Object.entries(raw)) {
    if (CYCLE_KNOWN.has(k)) continue;
    if (CYCLE_NOISE.has(k) || isEmpty(v)) {
      ignored.push(k);
      continue;
    }
    customFields[k] = v;
    preserved.push(k);
  }
  const vName = raw.versionName ?? versionName ?? (versionId === '-1' ? 'Nicht eingeplant' : `Version ${versionId}`);
  return {
    value: {
      sourceId: `${versionId}:${cycleId}`,
      cycleId,
      versionId,
      versionName: vName,
      name: cycleId === '-1' ? `Ad hoc (${vName})` : String(raw.name ?? `Zyklus ${cycleId}`),
      description: raw.description || null,
      build: raw.build || null,
      environment: raw.environment || null,
      startDate: toIsoDate(start),
      endDate: toIsoDate(end),
      createdBy: raw.createdByDisplay ?? raw.createdBy ?? null,
      customFields,
    },
    preserved, ignored, messages,
  };
}

export interface ExecutionDraft {
  sourceId: string;
  issueId: string;
  issueKey: string | null;
  orderNo: number;
  status: string;
  assignee: string | null;
  executedBy: string | null;
  executedAt: Date | null;
  comment: string | null;
  defects: { key: string; title: string | null; status: string | null }[];
  stepResults: { stepId: string; status: string; comment?: string; executedBy?: string; executedAt?: string; defects?: string[] }[];
  customFields: Record<string, unknown>;
}

const EXEC_KNOWN = new Set([
  'id', 'orderId', 'executionStatus', 'executedOn', 'executedOnVal', 'executedBy', 'executedByDisplay', 'executedByUserName',
  'assignedTo', 'assignedToDisplay', 'assignedToUserName', 'comment', 'htmlComment', 'cycleId', 'cycleName', 'issueId', 'issueKey',
  'summary', 'label', 'component', 'versionId', 'versionName', 'projectId', 'projectKey', 'defects', 'executionDefectCount',
  'stepDefectCount', 'totalDefectCount', 'creationDate', 'createdBy', 'createdByDisplay', 'modifiedBy', 'issueSummary',
  'issueDescription', 'priority', 'project', 'canViewIssue', 'isIssueEstimateNil', 'isExecutionWorkflowEnabled',
  'isTimeTrackingEnabled', 'issueKey', 'folderId', 'folderName', 'stepDefects', 'executionWorkflowStatus', 'estimatedTime',
  'loggedTime', 'timeSpentToBeLogged', 'testDefectsUnMasked', 'stepDefectsUnMasked', 'customFields', 'customFieldsValueMap',
]);

export function normalizeExecution(
  raw: Json, statusById: Map<string, StatusMapping>, stepResults: Json[] | null,
  stepStatusById: Map<string, StatusMapping> = statusById,
): Normalized<ExecutionDraft> {
  const preserved: string[] = [];
  const ignored: string[] = [];
  const messages: string[] = [];
  const statusId = String(raw.executionStatus ?? '-1');
  const status = statusById.get(statusId);
  if (!status) messages.push(`Unbekannter Ausführungsstatus ${statusId} → NOT_EXECUTED`);
  const customFields: Record<string, unknown> = {
    zephyr: { executionId: raw.id, cycleId: raw.cycleId, versionId: raw.versionId, statusId, statusName: status?.name ?? null },
  };
  if (raw.createdBy || raw.creationDate) {
    customFields.created = { by: raw.createdByDisplay ?? raw.createdBy ?? null, on: raw.creationDate ?? null };
  }
  if (raw.folderName) customFields.zephyrFolder = raw.folderName;
  // Schritt-Defects: im DB-Format ({stepId, defect: {key}}) strukturiert übernehmen, sonst bewahren.
  const stepDefectList = (raw.stepDefects ?? []) as Json[];
  const structuredStepDefects = stepDefectList.length > 0 && stepDefectList.every((d) => d?.defect?.key && d.stepId !== undefined);
  if (stepDefectList.length && !structuredStepDefects) {
    customFields.stepDefects = raw.stepDefects;
    preserved.push('stepDefects');
  }
  if (!isEmpty(raw.customFields) || !isEmpty(raw.customFieldsValueMap)) {
    customFields.zephyrCustomFields = raw.customFields ?? raw.customFieldsValueMap;
    preserved.push('customFields');
  }
  for (const [k, v] of Object.entries(raw)) {
    if (EXEC_KNOWN.has(k)) continue;
    if (isEmpty(v)) {
      ignored.push(k);
      continue;
    }
    customFields[k] = v;
    preserved.push(k);
  }
  const executedRaw = raw.executedOnVal ?? raw.executedOn;
  const parsedExecuted = parseZapiDate(executedRaw);
  const executedAt = isPlausibleDate(parsedExecuted) ? parsedExecuted : null;
  if (executedRaw && !executedAt) {
    customFields.executedOnRaw = executedRaw;
    preserved.push('executedOn');
    messages.push(`Ausführungsdatum ${parsedExecuted ? 'unplausibel' : 'nicht lesbar'}: "${executedRaw}" (Originalwert bewahrt)`);
  }
  const results = (stepResults ?? []).map((r) => {
    const st = stepStatusById.get(String(r.status));
    const parsedAt = parseZapiDate(r.executedOn);
    const at = isPlausibleDate(parsedAt) ? parsedAt : null;
    const defects = structuredStepDefects
      ? stepDefectList.filter((d) => String(d.stepId) === String(r.stepId)).map((d) => String(d.defect.key))
      : [];
    return {
      stepId: `zapi-${r.stepId}`,
      status: st?.code ?? 'NOT_EXECUTED',
      ...(r.comment ? { comment: String(r.comment) } : {}),
      ...(r.executedBy ? { executedBy: String(r.executedBy) } : {}),
      ...(at ? { executedAt: at.toISOString() } : {}),
      ...(defects.length ? { defects } : {}),
    };
  });
  const allDefects = new Map<string, { key: string; title: string | null; status: string | null }>();
  for (const d of (raw.defects ?? []) as Json[]) allDefects.set(d.key, { key: d.key, title: d.summary ?? null, status: d.status ?? null });
  if (structuredStepDefects) {
    for (const d of stepDefectList) {
      if (!allDefects.has(d.defect.key)) allDefects.set(d.defect.key, { key: d.defect.key, title: d.defect.summary ?? null, status: d.defect.status ?? null });
    }
  }
  for (const k of allDefects.keys()) if (k.startsWith('jira-id:')) messages.push(`Defect ${k.slice(8)} in Jira nicht auflösbar – als Jira-ID übernommen`);
  return {
    value: {
      sourceId: String(raw.id),
      issueId: String(raw.issueId),
      issueKey: raw.issueKey ?? null,
      orderNo: Number(raw.orderId ?? 0),
      status: status?.code ?? 'NOT_EXECUTED',
      assignee: raw.assignedToDisplay ?? raw.assignedTo ?? null,
      executedBy: raw.executedByDisplay ?? raw.executedBy ?? null,
      executedAt,
      comment: raw.comment || null,
      defects: [...allDefects.values()],
      stepResults: results,
      customFields,
    },
    preserved, ignored, messages,
  };
}

/** Entfernt NUL-Zeichen (U+0000) aus allen Zeichenketten; PostgreSQL kann sie nicht speichern. */
export function stripNul<T>(value: T): { value: T; removed: number } {
  let removed = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (!v.includes('\u0000')) return v;
      removed += v.split('\u0000').length - 1;
      return v.replaceAll('\u0000', '');
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value) as T;
  return { value: out, removed };
}
