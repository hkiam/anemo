import { createHash } from 'node:crypto';
import { type Db, inTx } from '../../platform/db.ts';
import { EventTypes, recordEvent } from '../events/index.ts';
import { createPlan, createCycle, ensureStatus, getCycle, remapExecutionVersions, updateCycle, upsertExecution } from '../execution/index.ts';
import { addSourceAttachment, importLocalAttachment } from '../attachments/index.ts';
import { upsertProject } from '../projects/index.ts';
import { linkReference } from '../references/index.ts';
import { commitVersionHistory, createTestCase, ensureFolderPath, getTestCase, reviseTestCase, stageVersionHistory, updateTestCaseMeta } from '../testcases/index.ts';
import { reconstructHistory, type JiraChange, type StepState, type ZephyrStepChange } from './history.ts';
import {
  type FieldInfo, type Normalized, type StatusMapping,
  normalizeCycle, normalizeExecution, normalizeStatus, normalizeTestIssue, stripNul,
} from './normalize.ts';

/** Normalisiertes Ergebnis von NUL-Zeichen bereinigen und dies im Mapping vermerken. */
function clean<T>(n: Normalized<T>): Normalized<T> {
  const { value, removed } = stripNul(n.value);
  return removed ? { ...n, value, messages: [...n.messages, `${removed} NUL-Zeichen aus Texten entfernt (Original im Raw Store)`] } : n;
}
import { type Manifest, SnapshotReader } from './snapshot.ts';

type Json = Record<string, any>;
const ACTOR = 'migration';

export type Outcome = 'MAPPED' | 'PARTIAL' | 'SKIPPED' | 'FAILED';
export type Action = 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'METADATA' | 'MERGED' | 'NONE';

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Ein Lauf der Import-Pipeline. Jedes Quellobjekt landet im Raw Store und erhält genau eine Mapping-Zeile. */
class ImportRun {
  readonly db: Db;
  readonly runId: string;
  readonly manifest: Manifest;
  readonly stats: Record<string, Record<string, number>> = {};

  constructor(db: Db, runId: string, manifest: Manifest) {
    this.db = db;
    this.runId = runId;
    this.manifest = manifest;
  }

  get system() {
    return this.manifest.sourceSystem;
  }

  async storeRaw(db: Db, type: string, id: string, payload: unknown): Promise<string> {
    // NUL-Zeichen: exaktes Original als Text, durchsuchbare Fassung als jsonb (siehe Migration 003).
    const json = JSON.stringify(payload);
    const hasNul = json.includes('\\u0000');
    const searchable = hasNul ? JSON.parse(json.replaceAll('\\u0000', '\\ufffd')) : payload;
    const [r] = await db<{ id: string }[]>`
      insert into source_record(source_system, source_type, source_id, payload, payload_text, payload_hash, first_run_id, last_run_id)
      values (${this.system}, ${type}, ${id}, ${db.json(searchable as never)}, ${hasNul ? json : null}, ${hash(payload)}, ${this.runId}, ${this.runId})
      on conflict (source_system, source_type, source_id) do update
        set payload = excluded.payload, payload_text = excluded.payload_text, payload_hash = excluded.payload_hash,
            last_run_id = excluded.last_run_id, updated_at = now()
      returning id`;
    return r!.id;
  }

  async identity(db: Db, type: string, id: string, targetType: string): Promise<string | null> {
    const [r] = await db<{ targetId: string }[]>`
      select target_id from migration_identity
      where source_system = ${this.system} and source_type = ${type} and source_id = ${id} and target_type = ${targetType}`;
    return r?.targetId ?? null;
  }

  async remember(db: Db, type: string, id: string, targetType: string, targetId: string): Promise<void> {
    await db`
      insert into migration_identity(source_system, source_type, source_id, target_type, target_id)
      values (${this.system}, ${type}, ${id}, ${targetType}, ${targetId})
      on conflict (source_system, source_type, source_id, target_type) do update set target_id = excluded.target_id`;
  }

  async map(db: Db, recordId: string, m: {
    targetType?: string | null; targetId?: string | null; outcome: Outcome; action: Action;
    preserved?: string[]; ignored?: string[]; messages?: string[];
  }): Promise<void> {
    const messages = [...(m.messages ?? [])];
    if (m.ignored?.length) messages.push(`Ohne Fachinhalt (nur Raw Store): ${m.ignored.join(', ')}`);
    await db`
      insert into migration_mapping(run_id, source_record_id, target_type, target_id, outcome, action, preserved_fields, messages)
      values (${this.runId}, ${recordId}, ${m.targetType ?? null}, ${m.targetId ?? null}, ${m.outcome}, ${m.action},
              ${m.preserved ?? []}::text[], ${db.json(messages)})
      on conflict (run_id, source_record_id) do update set target_type = excluded.target_type, target_id = excluded.target_id,
        outcome = excluded.outcome, action = excluded.action, preserved_fields = excluded.preserved_fields, messages = excluded.messages`;
  }

  count(type: string, key: string) {
    const t = (this.stats[type] ??= {});
    t[key] = (t[key] ?? 0) + 1;
  }

  /**
   * Verarbeitet ein Quellobjekt in eigener Transaktion. Schlägt die Abbildung fehl, bleibt das Rohobjekt
   * erhalten und bekommt eine FAILED-Zeile – der Lauf bricht nicht ab.
   */
  async process(type: string, id: string, payload: unknown, fn: (tx: Db, recordId: string) => Promise<{ outcome: Outcome; action: Action }>): Promise<void> {
    try {
      const r = await inTx(this.db, async (tx) => fn(tx, await this.storeRaw(tx, type, id, payload)));
      this.count(type, r.outcome);
      this.count(type, `action:${r.action}`);
    } catch (err) {
      await inTx(this.db, async (tx) => {
        const recordId = await this.storeRaw(tx, type, id, payload);
        await this.map(tx, recordId, { outcome: 'FAILED', action: 'NONE', messages: [String((err as Error).stack ?? err)] });
      });
      this.count(type, 'FAILED');
    }
  }
}

const outcomeOf = (n: Normalized<unknown>): Outcome => (n.preserved.length ? 'PARTIAL' : 'MAPPED');

export interface ImportResult {
  runId: string;
  stats: Record<string, Record<string, number>>;
}

export interface ImportOptions {
  log?: (m: string) => void;
  /** Zielverzeichnis für Binäranhänge. Ohne Angabe bleiben Anhänge Verweise auf das Quellsystem. */
  attachmentDir?: string | undefined;
}

export async function runImport(db: Db, snapshotDir: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const log = opts.log ?? (() => {});
  const reader = new SnapshotReader(snapshotDir);
  const manifest = await reader.manifest();
  const [run] = await db<{ id: string }[]>`
    insert into migration_run(source, status) values (${`${manifest.sourceSystem} ${manifest.baseUrl} @ ${manifest.extractedAt}`}, 'RUNNING')
    returning id`;
  const r = new ImportRun(db, run!.id, manifest);
  log(`Import-Lauf ${r.runId} aus ${snapshotDir} (anonymisiert: ${manifest.anonymized})`);

  try {
    // 1) Metadaten: Feldkatalog
    const fields = (await reader.json<FieldInfo[]>('fields.json')) ?? [];
    const fieldsById = new Map(fields.map((f) => [f.id, f]));
    await r.process('field-catalog', 'fields', fields, async (tx, recordId) => {
      await r.map(tx, recordId, { outcome: 'SKIPPED', action: 'METADATA', messages: [`${fields.length} Felddefinitionen für Feldnamen verwendet`] });
      return { outcome: 'SKIPPED', action: 'METADATA' };
    });

    // 2) Ausführungsstatus
    const statusById = new Map<string, StatusMapping>();
    for (const raw of (await reader.json<Json[]>('execution-statuses.json')) ?? []) {
      const s = normalizeStatus(raw);
      statusById.set(s.sourceId, s);
      await r.process('execution-status', s.sourceId, raw, async (tx, recordId) => {
        if (s.custom) await ensureStatus(tx, { code: s.code, name: s.name, color: s.color ?? undefined });
        await r.map(tx, recordId, {
          targetType: 'ExecutionStatus', outcome: 'MAPPED', action: s.custom ? 'CREATED' : 'MERGED',
          messages: [`${s.name} → ${s.code}${s.custom ? ' (eigener Status angelegt)' : ''}`],
        });
        return { outcome: 'MAPPED', action: s.custom ? 'CREATED' : 'MERGED' };
      });
    }

    for (const projectKey of manifest.projects) {
      // 2b) Schrittstatus (eigene Liste in Zephyr; fehlt sie, gilt die Ausführungsliste)
    const stepStatusById = new Map<string, StatusMapping>(statusById);
    for (const raw of (await reader.json<Json[]>('step-statuses.json')) ?? []) {
      const s = normalizeStatus(raw);
      stepStatusById.set(s.sourceId, s);
      await r.process('step-status', s.sourceId, raw, async (tx, recordId) => {
        if (s.custom) await ensureStatus(tx, { code: s.code, name: s.name, color: s.color ?? undefined });
        await r.map(tx, recordId, {
          targetType: 'ExecutionStatus', outcome: 'MAPPED', action: s.custom ? 'CREATED' : 'MERGED',
          messages: [`Schrittstatus ${s.name} → ${s.code}`],
        });
        return { outcome: 'MAPPED', action: s.custom ? 'CREATED' : 'MERGED' };
      });
    }

    // 3) Projekt
      const rawProject = await reader.json('projects', `${projectKey}.json`);
      if (!rawProject) throw new Error(`projects/${projectKey}.json fehlt im Snapshot`);
      let projectId = '';
      await r.process('project', String(rawProject.id), rawProject, async (tx, recordId) => {
        const p = await upsertProject(tx, { key: rawProject.key, name: rawProject.name, description: rawProject.description || null });
        projectId = p.id;
        await r.remember(tx, 'project', String(rawProject.id), 'Project', p.id);
        await r.map(tx, recordId, {
          targetType: 'Project', targetId: p.id, outcome: 'MAPPED', action: 'MERGED',
          messages: [`${(rawProject.versions ?? []).length} Versionen, ${(rawProject.components ?? []).length} Komponenten (als Release/Komponente an Zyklen bzw. Testfällen)`],
        });
        return { outcome: 'MAPPED', action: 'MERGED' };
      });
      if (!projectId) throw new Error(`Projekt ${projectKey} konnte nicht angelegt werden`);
      const versionNames = new Map<string, string>((rawProject.versions ?? []).map((v: Json) => [String(v.id), v.name]));

      // 4) Testfälle (Issue + ZAPI-Schritte)
      const testCaseByIssueId = new Map<string, { id: string; versionId: string }>();
      const issueFiles = (await reader.list('issues')).filter((f) => f.startsWith(`${projectKey}-`));
      log(`${projectKey}: ${issueFiles.length} Tests`);
      for (const file of issueFiles) {
        const issue = (await reader.json('issues', file))!;
        const steps = await reader.json<Json[] | { stepBeanCollection: Json[] }>('teststeps', `${issue.id}.json`);
        const stepList = steps === null ? null : Array.isArray(steps) ? steps : steps.stepBeanCollection ?? [];
        const n = clean(normalizeTestIssue(issue, stepList, fieldsById, manifest.baseUrl));
        const d = n.value;

        await r.process('issue', String(issue.id), issue, async (tx, recordId) => {
          const existingId = await r.identity(tx, 'issue', d.issueId, 'TestCase');
          let action: Action;
          let tcId: string;
          if (existingId) {
            const res = await reviseTestCase(tx, existingId, d.content, 'Re-Import: Quelle oder Mapping geändert', ACTOR, undefined, null, { keepApproval: true });
            await updateTestCaseMeta(tx, existingId, { status: d.status, owner: d.owner }, ACTOR);
            tcId = existingId;
            action = res.changed ? 'UPDATED' : 'UNCHANGED';
          } else {
            const folderId = await ensureFolderPath(tx, projectId, d.folderPath);
            const tc = await createTestCase(tx, {
              projectId, folderId, status: d.status, owner: d.owner, legacyKey: d.legacyKey, content: d.content,
              changeNote: `Migriert aus ${manifest.sourceSystem} ${d.legacyKey}`, createdAt: d.createdAt,
            }, d.createdBy);
            tcId = tc.id;
            action = 'CREATED';
            await r.remember(tx, 'issue', d.issueId, 'TestCase', tc.id);
          }
          for (const ref of d.references) await linkReference(tx, { ownerType: 'TEST_CASE', ownerId: tcId, ...ref }, ACTOR);
          for (const a of d.attachments) {
            if (opts.attachmentDir && (await reader.exists('attachments', a.sourceId))) {
              await importLocalAttachment(tx, opts.attachmentDir, {
                ownerType: 'TEST_CASE', ownerId: tcId, fileName: a.fileName, contentType: a.contentType,
                filePath: reader.path('attachments', a.sourceId), sourceKey: a.sourceId, author: a.author, ...(a.createdAt && { createdAt: a.createdAt }),
              });
            } else {
              await addSourceAttachment(tx, { ownerType: 'TEST_CASE', ownerId: tcId, ...a, sourceKey: a.sourceId });
              if (!manifest.attachmentsRemoved) n.messages.push(`Anhang ${a.fileName}: Binärdaten nicht im Snapshot – nur Verweis auf Quelle`);
            }
          }
          const tc = await getTestCase(tx, tcId);
          testCaseByIssueId.set(d.issueId, { id: tc.id, versionId: tc.version.id });
          const linkOnly = n.messages.some((m) => m.includes('nur Verweis auf Quelle'));
          const outcome: Outcome = linkOnly ? 'PARTIAL' : outcomeOf(n);
          await r.map(tx, recordId, { targetType: 'TestCase', targetId: tcId, outcome, action, preserved: n.preserved, ignored: n.ignored, messages: n.messages });
          return { outcome, action };
        });

        if (stepList !== null) {
          await r.process('teststeps', String(issue.id), steps, async (tx, recordId) => {
            const target = testCaseByIssueId.get(String(issue.id));
            const outcome: Outcome = target ? 'MAPPED' : 'FAILED';
            await r.map(tx, recordId, {
              // Ziel ist der Testfall (stabil); die konkrete Version kann durch die Rekonstruktion ersetzt werden.
              targetType: 'TestCase', targetId: target?.id ?? null, outcome, action: target ? 'MERGED' : 'NONE',
              messages: [target ? `${stepList.length} Schritte in die aktuelle Testfallversion übernommen` : 'Zugehöriger Testfall fehlt'],
            });
            return { outcome, action: target ? 'MERGED' : 'NONE' };
          });
        }
      }

      // 5) Zyklen je Version; Zephyr-Versionen werden zu Testplänen (Release)
      // Zyklen dieses Projekts (für die Zuordnung der Ausführungsdateien). Zielobjekte werden immer
      // transaktional über migration_identity nachgeschlagen – kein Zwischenspeicher, der ein Rollback überlebt.
      const projectCycles = new Set<string>();
      for (const file of await reader.list('cycles', projectKey)) {
        const versionId = file.replace(/\.json$/, '');
        const resp = (await reader.json('cycles', projectKey, file)) ?? {};
        for (const [cycleId, raw] of Object.entries(resp)) {
          if (cycleId === 'recordsCount') continue;
          if (typeof raw !== 'object' || raw === null) {
            // Unerwartetes Format: nicht stillschweigend überspringen, sondern als FAILED dokumentieren.
            projectCycles.add(`${versionId}:${cycleId}`);
            await r.process('cycle', `${versionId}:${cycleId}`, raw, async (tx, recordId) => {
              await r.map(tx, recordId, { outcome: 'FAILED', action: 'NONE', messages: [`Unerwartetes Zyklusformat (${typeof raw}) in cycles/${projectKey}/${file}`] });
              return { outcome: 'FAILED', action: 'NONE' };
            });
            continue;
          }
          const n = clean(normalizeCycle(cycleId, raw as Json, versionId, versionNames.get(versionId) ?? null));
          const c = n.value;
          projectCycles.add(c.sourceId);
          await r.process('cycle', c.sourceId, raw, async (tx, recordId) => {
            let planId = await r.identity(tx, 'version', `${projectKey}:${versionId}`, 'TestPlan');
            if (!planId) {
              const plan = await createPlan(tx, projectId, { name: c.versionName, release: c.versionName, description: `Aus Zephyr-Version ${c.versionName} migriert` }, ACTOR);
              planId = plan.id;
              await r.remember(tx, 'version', `${projectKey}:${versionId}`, 'TestPlan', plan.id);
            }
            const input = {
              name: c.name, planId, description: c.description, release: c.versionName, build: c.build,
              environment: c.environment, startDate: c.startDate, endDate: c.endDate, customFields: c.customFields,
              createdBy: c.createdBy ?? ACTOR,
            };
            const existing = await r.identity(tx, 'cycle', c.sourceId, 'TestCycle');
            let action: Action = 'CREATED';
            let cycleTargetId: string;
            if (existing) {
              await getCycle(tx, existing);
              await updateCycle(tx, existing, input);
              cycleTargetId = existing;
              action = 'UPDATED';
            } else {
              cycleTargetId = (await createCycle(tx, projectId, input, ACTOR)).id;
              await r.remember(tx, 'cycle', c.sourceId, 'TestCycle', cycleTargetId);
            }
            const outcome = outcomeOf(n);
            await r.map(tx, recordId, { targetType: 'TestCycle', targetId: cycleTargetId, outcome, action, preserved: n.preserved, ignored: n.ignored, messages: n.messages });
            return { outcome, action };
          });
        }
      }

      // 6) Ausführungen
      for (const file of await reader.list('executions')) {
        const m = /^(-?\d+)_(-?\d+)\.json$/.exec(file);
        if (!m) continue;
        const cycleKey = `${m[1]}:${m[2]}`;
        if (!projectCycles.has(cycleKey)) continue; // gehört zu einem anderen Projekt
        const resp = (await reader.json('executions', file)) ?? {};
        for (const raw of (resp.executions ?? []) as Json[]) {
          const stepResults = await reader.json<Json[]>('stepresults', `${raw.id}.json`);
          const n = clean(normalizeExecution(raw, statusById, stepResults, stepStatusById));
          const e = n.value;
          await r.process('execution', e.sourceId, raw, async (tx, recordId) => {
            const cycleTarget = await r.identity(tx, 'cycle', cycleKey, 'TestCycle');
            if (!cycleTarget) {
              await r.map(tx, recordId, { outcome: 'FAILED', action: 'NONE', messages: [`Zyklus ${cycleKey} konnte nicht übernommen werden – Ausführung ohne Ziel`] });
              return { outcome: 'FAILED', action: 'NONE' };
            }
            const tcId = testCaseByIssueId.get(e.issueId)?.id ?? (await r.identity(tx, 'issue', e.issueId, 'TestCase'));
            if (!tcId) {
              await r.map(tx, recordId, {
                outcome: 'FAILED', action: 'NONE',
                messages: [`Test ${e.issueKey ?? e.issueId} ist nicht im Snapshot – Ausführung kann nicht zugeordnet werden`],
              });
              return { outcome: 'FAILED', action: 'NONE' };
            }
            // Eigener Datensatz je Zephyr-Ausführung. Zeigt die gespeicherte Identität auf einen Datensatz, der einer
            // anderen Zephyr-Ausführung gehört (frühere Zusammenlegung), wird ein neuer angelegt.
            let existing = await r.identity(tx, 'execution', e.sourceId, 'TestExecution');
            const [prev] = existing
              ? await tx<{ testCaseVersionId: string; owner: string | null }[]>`
                  select test_case_version_id, custom_fields->'zephyr'->>'executionId' as owner from test_execution where id = ${existing}`
              : [];
            if (prev && prev.owner !== null && prev.owner !== String(e.sourceId)) existing = null;
            const versionId = (existing && prev?.testCaseVersionId) || (await getTestCase(tx, tcId)).version.id;
            const execId = await upsertExecution(tx, {
              id: existing,
              cycleId: cycleTarget, testCaseId: tcId, testCaseVersionId: versionId, orderNo: e.orderNo, status: e.status,
              assignee: e.assignee, executedBy: e.executedBy, executedAt: e.executedAt, comment: e.comment,
              stepResults: e.stepResults, customFields: e.customFields,
            });
            await r.remember(tx, 'execution', e.sourceId, 'TestExecution', execId);
            for (const def of e.defects) {
              await linkReference(tx, {
                ownerType: 'TEST_EXECUTION', ownerId: execId, provider: 'jira', externalKey: def.key, relation: 'DEFECT',
                url: `${manifest.baseUrl}/browse/${def.key}`, title: def.title, status: def.status,
              }, ACTOR);
            }
            const outcome = outcomeOf(n);
            const action: Action = existing ? 'UPDATED' : 'CREATED';
            await r.map(tx, recordId, { targetType: 'TestExecution', targetId: execId, outcome, action, preserved: n.preserved, ignored: n.ignored, messages: n.messages });
            return { outcome, action };
          });
          const execAttachments = await reader.json<Json[]>('execution-attachments', `${e.sourceId}.json`);
          if (execAttachments) {
            await r.process('execution-attachments', e.sourceId, execAttachments, async (tx, recordId) => {
              const execId = await r.identity(tx, 'execution', e.sourceId, 'TestExecution');
              if (!execId) {
                await r.map(tx, recordId, { outcome: 'FAILED', action: 'NONE', messages: ['Zugehörige Ausführung fehlt'] });
                return { outcome: 'FAILED', action: 'NONE' };
              }
              const messages: string[] = [];
              for (const a of execAttachments) {
                const key = `zapi-${a.fileId}`;
                if (opts.attachmentDir && (await reader.exists('attachments', key))) {
                  await importLocalAttachment(tx, opts.attachmentDir, {
                    ownerType: 'TEST_EXECUTION', ownerId: execId, fileName: String(a.fileName), filePath: reader.path('attachments', key),
                    sourceKey: key, author: a.author ?? null, contentType: a.mimeType ?? null,
                  });
                } else {
                  await addSourceAttachment(tx, {
                    ownerType: 'TEST_EXECUTION', ownerId: execId, fileName: String(a.fileName), sourceKey: key,
                    url: `${manifest.baseUrl}/rest/zapi/latest/attachment/${a.fileId}/file`, author: a.author ?? null,
                  });
                  messages.push(`Anhang ${a.fileName}: Binärdaten nicht im Snapshot – nur Verweis auf Quelle`);
                }
              }
              const outcome: Outcome = messages.length && !manifest.attachmentsRemoved ? 'PARTIAL' : 'MAPPED';
              await r.map(tx, recordId, { targetType: 'TestExecution', targetId: execId, outcome, action: 'MERGED', messages: [`${execAttachments.length} Anhänge`, ...messages] });
              return { outcome, action: 'MERGED' };
            });
          }
          if (stepResults) {
            await r.process('stepresults', e.sourceId, stepResults, async (tx, recordId) => {
              const execId = await r.identity(tx, 'execution', e.sourceId, 'TestExecution');
              const outcome: Outcome = execId ? 'MAPPED' : 'FAILED';
              await r.map(tx, recordId, {
                targetType: 'TestExecution', targetId: execId, outcome, action: execId ? 'MERGED' : 'NONE',
                messages: [execId ? `${stepResults.length} Schrittergebnisse übernommen` : 'Zugehörige Ausführung fehlt'],
              });
              return { outcome, action: execId ? 'MERGED' : 'NONE' };
            });
          }
        }
      }
    }

    // 7) Versionsrekonstruktion aus Zephyr-Schritthistorie und Jira-Änderungshistorie (nach den Ausführungen,
    //    damit diese auf die zum Ausführungszeitpunkt gültige Version umgehängt werden können)
    for (const projectKey of manifest.projects) {
      for (const file of (await reader.list('issues')).filter((f) => f.startsWith(`${projectKey}-`))) {
        const issue = (await reader.json('issues', file))!;
        const zephyr = await reader.json<{ changes: ZephyrStepChange[]; stepCreated: Record<string, number> }>('teststep-history', `${issue.id}.json`);
        const jiraChanges: JiraChange[] = (issue.changelog?.histories ?? []).flatMap((h: Json) => (h.items ?? [])
          .filter((it: Json) => ['summary', 'description', 'priority', 'labels'].includes(it.field))
          .map((it: Json) => ({ t: Date.parse(h.created), author: h.author?.displayName ?? h.author?.name ?? null, field: it.field, from: it.fromString ?? null, to: it.toString ?? null })));
        if (!zephyr?.changes.length && jiraChanges.length === 0) continue;
        await r.process('version-history', String(issue.id), { zephyr, jiraChanges: jiraChanges.length }, async (tx, recordId) => {
          const tcId = await r.identity(tx, 'issue', String(issue.id), 'TestCase');
          if (!tcId) {
            await r.map(tx, recordId, { outcome: 'FAILED', action: 'NONE', messages: ['Testfall fehlt – Historie nicht anwendbar'] });
            return { outcome: 'FAILED', action: 'NONE' };
          }
          const rawSteps = await reader.json<Json[] | { stepBeanCollection: Json[] }>('teststeps', `${issue.id}.json`);
          const stepList = rawSteps === null ? [] : Array.isArray(rawSteps) ? rawSteps : rawSteps.stepBeanCollection ?? [];
          const f = issue.fields ?? {};
          const current = {
            fields: { summary: f.summary ?? '', description: f.description ?? null, priority: f.priority?.name ?? null, labels: [...(f.labels ?? [])].sort() },
            steps: stepList.map((st): StepState => ({ id: String(st.id), order: Number(st.orderId ?? 0), step: st.step ?? '', data: st.data ?? '', result: st.result ?? '' })),
          };
          const { versions, diagnostics: d } = reconstructHistory({
            createdAt: Date.parse(f.created ?? '') || 0, current, jira: jiraChanges,
            zephyr: (zephyr?.changes ?? []).map((c) => ({ ...c, t: Number(c.t) })), stepCreated: zephyr?.stepCreated ?? {},
          });
          const summary = `${versions.length} Versionen (Zephyr ${d.zephyrChanges}, Jira ${d.jiraChanges} Änderungen; ${d.estimatedStepCreations} Anlegezeitpunkte geschätzt; `
            + `${d.unknownStepContent} gelöschte Schritte ohne überlieferten Inhalt; ${d.deletionsWithoutEvent} Löschungen ohne Eintrag; ${d.inconsistent} Inkonsistenzen)`;
          if (versions.length <= 1) {
            await r.map(tx, recordId, { targetType: 'TestCase', targetId: tcId, outcome: 'MAPPED', action: 'UNCHANGED', messages: [`Keine inhaltlichen Änderungen in der Historie: ${summary}`] });
            return { outcome: 'MAPPED', action: 'UNCHANGED' };
          }
          const historic = versions.map((v) => {
            const copy = structuredClone(issue);
            copy.fields = { ...copy.fields, summary: v.fields.summary, description: v.fields.description, labels: v.fields.labels,
              priority: v.fields.priority ? { name: v.fields.priority } : null };
            const content = stripNul(normalizeTestIssue(copy, v.steps.map((st) => ({ id: st.id, orderId: st.order, step: st.step, data: st.data, result: st.result })),
              fieldsById, manifest.baseUrl).value.content).value;
            return { content, createdAt: new Date(v.validFrom), createdBy: v.author ?? 'Historie (Autor unbekannt)', changeNote: v.changeNote };
          });
          const staged = await stageVersionHistory(tx, tcId, historic);
          if (staged.status === 'manual') {
            await r.map(tx, recordId, { targetType: 'TestCase', targetId: tcId, outcome: 'PARTIAL', action: 'NONE',
              messages: [`Testfall hat in Anemo gepflegte Versionen – Historie nicht eingespielt: ${summary}`] });
            return { outcome: 'PARTIAL', action: 'NONE' };
          }
          if (staged.status === 'staged') {
            await remapExecutionVersions(tx, tcId, staged.staged);
            await commitVersionHistory(tx, tcId, ACTOR);
          }
          const outcome: Outcome = d.unknownStepContent || d.inconsistent ? 'PARTIAL' : 'MAPPED';
          await r.map(tx, recordId, { targetType: 'TestCase', targetId: tcId, outcome, action: staged.status === 'staged' ? 'UPDATED' : 'UNCHANGED', messages: [`Rekonstruiert: ${summary}`] });
          return { outcome, action: staged.status === 'staged' ? 'UPDATED' : 'UNCHANGED' };
        });
      }
    }

    await inTx(db, async (tx) => {
      const stats = { ...r.stats, snapshot: { counts: manifest.counts ?? null, warnings: manifest.warnings ?? [], anonymized: manifest.anonymized, attachmentsRemoved: manifest.attachmentsRemoved ?? false } };
      await tx`update migration_run set status = 'COMPLETED', finished_at = now(), stats = ${tx.json(stats as never)} where id = ${r.runId}`;
      await recordEvent(tx, { type: EventTypes.MigrationCompleted, aggregateType: 'MigrationRun', aggregateId: r.runId, actor: ACTOR, payload: { stats: r.stats } });
    });
    log(`Import abgeschlossen: ${JSON.stringify(r.stats)}`);
  } catch (err) {
    await db`update migration_run set status = 'ABORTED', finished_at = now(), stats = ${db.json({ ...r.stats, error: String(err) } as never)} where id = ${r.runId}`;
    throw err;
  }
  return { runId: r.runId, stats: r.stats };
}
