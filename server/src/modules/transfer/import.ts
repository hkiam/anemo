/**
 * Import eines Projektpakets (ADR-0027): als neues Projekt (Stufe K2) oder in ein bestehendes (Stufe K4).
 *
 * Ablauf: Paket prüfen (Prüfsummen, Formatversion, Zeilen gegen die Formatbeschreibung) → Vorlauf (je Objekt: neu
 * oder im Ziel schon vorhanden; IDs, Schlüssel, Versionsnummern) → Personen und globale Kataloge abgleichen → alles
 * in einer Transaktion einfügen bzw. aktualisieren. Der Probelauf ist derselbe Lauf, der am Ende zurückgenommen wird;
 * er schreibt keine Anhänge. Es entstehen keine Ereignisse je Objekt (keine Webhooks, Benachrichtigungen, E-Mails),
 * nur ein ProjectImported.
 *
 * Bestehendes Projekt: Ein Objekt gilt als vorhanden, wenn (1) die Herkunft aus einem früheren Import bekannt ist
 * (package_identity), (2) das Paket aus dieser Instanz stammt und das Objekt im Zielprojekt dieselbe ID hat, oder
 * (3) ein natürlicher Schlüssel passt (Ordner im selben Elternordner mit gleichem Namen, Feld, Feldvorlage, Testset,
 * Ausführung desselben Testfalls im selben Zyklus, Datensatz, Verweis). Je Objektart gilt eine Regel: aktualisieren
 * (neuere Fassung gewinnt; Testfälle und Vorbedingungen bekommen neue Versionen), überspringen oder als Kopie neu
 * anlegen. Ausführungen und Zyklen, die im Ziel abgeschlossen sind, werden nie verändert.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import type { Db } from '../../platform/db.ts';
import { HttpError } from '../../platform/http.ts';
import { openZip, type ZipReader } from '../../platform/zip.ts';
import { EventTypes, recordEvent } from '../events/index.ts';
import { fileOf, FORMAT, FORMAT_VERSION, type Manifest, type Ref, SHARED_IDS, type TypeName, type TypeSpec, TYPES, typeSpec } from './format.ts';

export type ConflictPolicy = 'update' | 'skip' | 'new';

export interface ImportOptions {
  /** neues Projekt (Schlüssel, Name) oder bestehendes (Schlüssel, optional Zielordner) */
  target: { mode?: 'new' | 'existing'; key: string; name?: string; folderId?: string | null };
  /** Login im Paket → Login in dieser Instanz; null = als Text übernehmen */
  persons?: Record<string, string | null>;
  /** fehlende Katalogeinträge auf vorhandene abbilden: Code im Paket → Code in dieser Instanz */
  executionStatuses?: Record<string, string>;
  testCaseStatuses?: Record<string, string>;
  priorities?: Record<string, string>;
  /** bestehendes Projekt: Regel je Objektart für Objekte, die es im Ziel schon gibt */
  conflicts?: Partial<Record<TypeName, ConflictPolicy>>;
}

export interface ImportReport {
  dryRun: boolean;
  mode: 'new' | 'existing';
  source: { key: string; name: string; instance: string; exportedAt: string; exportedBy: string; formatVersion: string; anemo: string };
  target: { key: string; name: string; projectId: string | null };
  /** neu angelegt je Objektart (dazu files: übernommene Anhangsdateien) */
  counts: Partial<Record<TypeName, number>> & { files: number };
  /** je Objektart: neu, aktualisiert, unverändert/übersprungen */
  changes: Partial<Record<TypeName, { created: number; updated: number; skipped: number }>>;
  /** Schlüssel des Pakets → Schlüssel im Ziel (bei neuem Projekt nur das Präfix) */
  keys: { from: string; to: string };
  keyMap: Record<string, string>;
  persons: { login: string; displayName: string | null; target: string; how: 'gleich' | 'E-Mail' | 'zugeordnet' | 'als Text' }[];
  catalog: { kind: string; code: string; action: 'vorhanden' | 'angelegt' | 'zugeordnet' | 'als Projektfeld' | 'fehlt'; target?: string }[];
  /** Objekte, die bewusst nicht verändert wurden (z. B. abgeschlossene Zyklen im Ziel) */
  conflicts: string[];
  warnings: string[];
  /** verhindern das Einspielen */
  problems: string[];
}

/** Regeln für vorhandene Objekte, wenn nichts anderes gewählt ist */
export const DEFAULT_POLICY: Record<TypeName, ConflictPolicy> = {
  'project': 'skip', 'folders': 'skip', 'field-definitions': 'skip', 'field-templates': 'skip', 'defect-templates': 'skip',
  'preconditions': 'update', 'precondition-versions': 'skip', 'step-blocks': 'update', 'test-sets': 'update', 'test-cases': 'update',
  'test-case-versions': 'skip', 'plans': 'update', 'cycles': 'update', 'executions': 'update', 'execution-results': 'skip', 'sessions': 'update',
  'dataset-overrides': 'update', 'comments': 'update', 'references': 'update', 'attachments': 'skip', 'views': 'skip', 'members': 'skip',
  'integrations': 'skip', 'webhooks': 'skip', 'foreign-test-cases': 'skip', 'foreign-test-case-versions': 'skip',
};
/** Objektarten, die beim Import in ein bestehendes Projekt nicht übernommen werden (Einstellungen des Ziels bleiben) */
const TARGET_SETTINGS = new Set<TypeName>(['members', 'integrations', 'webhooks']);
/**
 * unveränderliche Objektarten: vorhanden heißt gleich. Testfälle anderer Projekte (fremde Bezüge aus Zyklen) werden nie
 * verändert – sie gehören nicht zum Zielprojekt.
 */
const IMMUTABLE = new Set<TypeName>(['test-case-versions', 'precondition-versions', 'attachments', 'foreign-test-cases', 'foreign-test-case-versions']);
/** Objektarten, für die beim Import eine Regel gewählt werden kann */
export const POLICY_TYPES = (Object.keys(DEFAULT_POLICY) as TypeName[]).filter((t) => !IMMUTABLE.has(t) && t !== 'project');
/** Anbindungen an Fremdsysteme und Webhooks lenken Servicekonten bzw. senden nach außen: nur die Systemadministration übernimmt sie */
const ADMIN_ONLY = new Set<TypeName>(['integrations', 'webhooks']);
/** nur über natürliche Schlüssel zusammengeführt – eine Kopie würde die Eindeutigkeit verletzen */
const MERGE_ONLY = new Set<TypeName>(['folders', 'field-definitions', 'field-templates', 'test-sets', 'executions', 'dataset-overrides', 'references']);
/** beim Aktualisieren nie überschrieben */
const KEEP_ON_UPDATE = new Set(['id', 'key', 'legacy_key', 'project_id', 'created_at', 'created_by', 'current_version', 'approved_version', 'approved_by', 'approved_at',
  'next_number', 'version_no', 'test_case_id', 'precondition_id', 'cycle_id', 'execution_id', 'owner_type', 'owner_id', 'scope', 'scope_id']);
const VERSIONED: Partial<Record<TypeName, { parent: TypeName; fk: string; table: string }>> = {
  'test-case-versions': { parent: 'test-cases', fk: 'test_case_id', table: 'test_case_version' },
  'precondition-versions': { parent: 'preconditions', fk: 'precondition_id', table: 'precondition_version' },
};

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,19}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
/** zusätzliche Angaben, die der Export je Objektart ergänzt */
const DERIVED: Partial<Record<TypeName, string[]>> = { attachments: ['sha256'], members: ['principal'] };
/** Zeichenketten, in denen Schlüssel nicht umgeschrieben werden (Bezüge auf Fremdsysteme, Herkunft) */
const KEEP_TEXT = new Set(['legacyKey', 'externalKey', 'url', 'sourceKey', 'location', 'sha256', 'id']);

// UUIDv7 wie in der Datenbank (Zeit + Zähler + Zufall), streng aufsteigend: Reihenfolgen nach (created_at, id) bleiben
let lastMs = 0, counter = 0;
export function uuidv7(): string {
  let ms = Date.now();
  if (ms <= lastMs) {
    if (++counter > 0xfff) { lastMs++; counter = 0; }
    ms = lastMs;
  } else { lastMs = ms; counter = 0; }
  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | (counter >> 8); b[7] = counter & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

class DryRun extends Error {
  readonly report: ImportReport;
  constructor(report: ImportReport) { super('Probelauf'); this.report = report; }
}

async function* lines(z: ZipReader, name: string): AsyncGenerator<Record<string, unknown>> {
  if (!z.entries.has(name)) return;
  let n = 0;
  for await (const line of createInterface({ input: z.stream(name), crlfDelay: Infinity })) {
    n++;
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { throw new HttpError(400, `${name}, Zeile ${n}: kein gültiges JSON`); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new HttpError(400, `${name}, Zeile ${n}: kein Objekt`);
    yield row as Record<string, unknown>;
  }
}

/**
 * Paket prüfen: Manifest und seine Prüfsumme, Format und Formatversion, Prüfsumme und Größe jeder Datei, keine
 * unbekannten Dateien. Liefert das Manifest.
 */
export async function inspectPackage(path: string): Promise<Manifest> {
  const z = await openZip(path);
  try {
    if (!z.entries.has('manifest.json')) throw new HttpError(400, 'Kein Projektpaket: manifest.json fehlt');
    if (z.entries.get('manifest.json')!.size > 64 * 1024 * 1024) throw new HttpError(400, 'Manifest zu groß');
    const raw = await z.read('manifest.json');
    const sumLine = z.entries.has('manifest.sha256') ? (await z.read('manifest.sha256')).toString('utf8').trim().split(/\s+/)[0] : null;
    if (!sumLine || sumLine !== createHash('sha256').update(raw).digest('hex')) throw new HttpError(400, 'Prüfsumme des Manifests stimmt nicht (Paket beschädigt oder verändert)');
    let m: Manifest;
    try { m = JSON.parse(raw.toString('utf8')) as Manifest; } catch { throw new HttpError(400, 'Manifest ist kein gültiges JSON'); }
    if (m.format !== FORMAT) throw new HttpError(400, `Kein Projektpaket (Format ${String(m.format)})`);
    const [major] = String(m.formatVersion).split('.');
    if (major !== FORMAT_VERSION.split('.')[0]) {
      throw new HttpError(400, `Formatversion ${m.formatVersion} wird nicht unterstützt (diese Anemo-Version liest ${FORMAT_VERSION.split('.')[0]}.x)`);
    }
    const listed = new Map((m.files ?? []).map((f) => [f.path, f]));
    for (const name of z.entries.keys()) {
      if (name === 'manifest.json' || name === 'manifest.sha256') continue;
      if (!listed.has(name)) throw new HttpError(400, `Datei ${name} steht nicht im Manifest`);
    }
    for (const f of listed.values()) {
      if (!z.entries.has(f.path)) throw new HttpError(400, `Datei ${f.path} fehlt im Paket`);
      const h = createHash('sha256');
      let size = 0;
      for await (const chunk of z.stream(f.path)) { h.update(chunk as Buffer); size += (chunk as Buffer).length; }
      if (h.digest('hex') !== f.sha256 || size !== f.size) throw new HttpError(400, `Prüfsumme stimmt nicht: ${f.path} (Paket beschädigt oder verändert)`);
    }
    for (const t of TYPES) if (!t.optional && !z.entries.has(fileOf(t))) throw new HttpError(400, `Datei ${fileOf(t)} fehlt im Paket`);
    if (!z.entries.has('catalog.json')) throw new HttpError(400, 'Datei catalog.json fehlt im Paket');
    // Pakete 1.0 (vor K3) hatten keine Optionen: komplett mit allem
    m.options ??= { versions: 'all', executions: true, attachments: true, comments: true, pseudonymize: false };
    return m;
  } finally {
    await z.close();
  }
}

interface Resolved { id: string; existing: boolean; natural?: boolean; skipped?: boolean }

export async function importPackage(db: Db, o: {
  path: string; options: ImportOptions; actor: string; userId: string | null; isSystemAdmin: boolean; attachmentDir: string; dryRun: boolean; transferId: string;
  /** Projekte, die die importierende Person lesen darf (null = alle): nur auf deren Testfälle darf ein Paket verweisen */
  readableProjects: string[] | null;
  onProgress?: (p: { phase: string; type?: string; done?: number }) => void;
}): Promise<ImportReport> {
  const manifest = await inspectPackage(o.path);
  const z = await openZip(o.path);
  // Anhänge zuerst in ein Zwischenverzeichnis, nach dem Commit an ihren Platz: ein Abbruch hinterlässt sonst Dateien
  // ohne Datensatz (beim Start räumt cleanupImportStaging liegengebliebene Zwischenverzeichnisse weg)
  const staging = join(o.attachmentDir, `${STAGING_PREFIX}${o.transferId}`);
  const written: string[] = [];
  const progress = o.onProgress ?? (() => {});
  try {
    const result = await db.begin(async (sql) => {
      const tx = sql as unknown as Db;
      await tx`set local statement_timeout = 0`;
      const mode = o.options.target.mode ?? 'new';
      const existingMode = mode === 'existing';
      const src = manifest.project.key;
      const dst = o.options.target.key;
      const report: ImportReport = {
        dryRun: o.dryRun, mode,
        source: { key: src, name: manifest.project.name, instance: manifest.sourceInstance, exportedAt: manifest.exportedAt, exportedBy: manifest.exportedBy,
          formatVersion: manifest.formatVersion, anemo: `${manifest.anemo.version}${manifest.anemo.commit ? ` (${manifest.anemo.commit})` : ''}` },
        target: { key: dst, name: o.options.target.name?.trim() ?? '', projectId: null },
        counts: { files: 0 }, changes: {}, keys: { from: `${src}-`, to: `${dst}-` }, keyMap: {}, persons: [], catalog: [], conflicts: [],
        warnings: [...(manifest.warnings ?? [])], problems: [],
      };
      const grouped = new Map<string, Map<string, number>>();
      const warn = (group: string, msg: string) => {
        const g = grouped.get(group) ?? grouped.set(group, new Map()).get(group)!;
        g.set(msg, (g.get(msg) ?? 0) + 1);
      };
      const change = (t: TypeName, what: 'created' | 'updated' | 'skipped') => {
        const c = report.changes[t] ?? (report.changes[t] = { created: 0, updated: 0, skipped: 0 });
        c[what]++;
      };
      const policyOf = (t: TypeName): ConflictPolicy => o.options.conflicts?.[t] ?? DEFAULT_POLICY[t];
      const [self] = await tx<{ instanceId: string }[]>`select instance_id from instance_info`;
      const sameInstance = self!.instanceId === manifest.sourceInstance;

      // ---- Ziel ----
      let projectId: string;
      let rootFolder: string | null = null;
      if (existingMode) {
        const [p] = o.dryRun
          ? await tx<{ id: string; name: string }[]>`select id, name from project where key = ${dst}`
          : await tx<{ id: string; name: string }[]>`select id, name from project where key = ${dst} for update`;
        if (!p) throw new HttpError(404, `Projekt ${dst} nicht gefunden`);
        projectId = p.id;
        report.target.name = p.name;
        report.target.projectId = p.id;
        if (o.options.target.folderId) {
          const [f] = await tx`select id from folder where id = ${o.options.target.folderId} and project_id = ${projectId}`;
          if (!f) report.problems.push('Zielordner gehört nicht zum Projekt');
          else rootFolder = o.options.target.folderId;
        }
      } else {
        projectId = uuidv7();
        if (!PROJECT_KEY.test(dst)) report.problems.push('Projektschlüssel: Großbuchstaben/Ziffern, 2–20 Zeichen, beginnt mit einem Buchstaben');
        else if ((await tx`select 1 from project where key = ${dst}`).length) report.problems.push(`Projekt ${dst} gibt es bereits – anderen Schlüssel wählen oder in das bestehende Projekt importieren`);
        if (!report.target.name) report.problems.push('Projektname fehlt');
      }

      // ---- Vorlauf: je Objekt neu oder vorhanden; IDs, Schlüssel, Versionsnummern ----
      progress({ phase: 'Vorlauf' });
      const known = new Map<string, string>(); // `${type}:${sourceId}` → Ziel-ID aus früheren Importen
      if (existingMode) {
        for (const r of await tx<{ sourceType: string; sourceId: string; targetId: string }[]>`
          select source_type, source_id, target_id from package_identity where source_instance = ${manifest.sourceInstance} and project_id = ${projectId}`) {
          known.set(`${r.sourceType}:${r.sourceId}`, r.targetId);
        }
      }
      /** IDs aller Objekte einer Art im Zielprojekt */
      const targetIds = new Map<TypeName, Set<string>>();
      const targetIdsOf = async (t: TypeSpec) => {
        if (!targetIds.has(t.name)) {
          targetIds.set(t.name, existingMode && t.columns.includes('id')
            ? new Set((await tx<{ id: string }[]>`select id from ${tx(t.table)} where ${t.where(tx, projectId)}`).map((r) => r.id))
            : new Set());
        }
        return targetIds.get(t.name)!;
      };
      /** natürliche Schlüssel im Zielprojekt: Schlüssel → ID */
      const naturalIn = async (t: TypeName): Promise<Map<string, string>> => {
        const m = new Map<string, string>();
        if (!existingMode) return m;
        const spec = typeSpec(t);
        // mehrdeutige Schlüssel (z. B. Wiederholungen desselben Testfalls im selben Zyklus) ordnen nichts zu
        const ambiguous = new Set<string>();
        const add = (rows: { k: string; id: string }[]) => rows.forEach((r) => { if (m.has(r.k)) ambiguous.add(r.k); else m.set(r.k, r.id); });
        try { await addNatural(t, spec, add); } finally { for (const k of ambiguous) m.delete(k); }
        return m;
      };
      const addNatural = async (t: TypeName, spec: TypeSpec, add: (rows: { k: string; id: string }[]) => void) => {
        switch (t) {
          case 'field-definitions': add(await tx`select scope || ':' || lower(key) as k, id from field_definition where project_id = ${projectId}` as never); break;
          case 'field-templates': add(await tx`select lower(name) as k, id from field_template where project_id = ${projectId}` as never); break;
          case 'test-sets': add(await tx`select name as k, id from test_set where project_id = ${projectId}` as never); break;
          case 'executions': add(await tx`select cycle_id || ':' || test_case_id as k, id from test_execution where ${spec.where(tx, projectId)}` as never); break;
          case 'dataset-overrides': add(await tx`select scope || ':' || scope_id || ':' || test_case_id as k, id from dataset_override where ${spec.where(tx, projectId)}` as never); break;
          case 'references': add(await tx`select owner_type || ':' || owner_id || ':' || provider || ':' || external_key || ':' || relation || ':' || coalesce(step_id, '') as k, id
            from external_reference where ${spec.where(tx, projectId)}` as never); break;
          default: break;
        }
      };
      const ids = new Map<TypeName, Map<string, string>>();
      const state = new Map<TypeName, Map<string, Resolved>>();
      const mapId = (t: TypeName, v: unknown) => (typeof v === 'string' ? ids.get(t)?.get(v) : undefined);
      /** fremde Testfälle: als Kopie neu angelegt (Ziel-ID → aktuelle Version wird danach auf die höchste gesetzt) */
      const foreignCopies = new Set<string>();
      let extraNumbers = 0; // neues Projekt: zusätzliche Nummern für kopierte fremde Testfälle
      const naturalKey = (t: TypeName, row: Record<string, unknown>): string | null => {
        switch (t) {
          case 'field-definitions': return `${String(row.scope)}:${String(row.key).toLowerCase()}`;
          case 'field-templates': return String(row.name).toLowerCase();
          case 'test-sets': return String(row.name);
          case 'executions': { const c = mapId('cycles', row.cycleId), tc = mapId('test-cases', row.testCaseId); return c && tc ? `${c}:${tc}` : null; }
          case 'dataset-overrides': {
            const s = mapId(row.scope === 'plan' ? 'plans' : 'cycles', row.scopeId), tc = mapId('test-cases', row.testCaseId);
            return s && tc ? `${String(row.scope)}:${s}:${tc}` : null;
          }
          case 'references': {
            const ownerType = { TEST_CASE: 'test-cases', TEST_EXECUTION: 'executions', TEST_CYCLE: 'cycles', TEST_PLAN: 'plans', EXPLORATORY_SESSION: 'sessions', PRECONDITION: 'preconditions' }[String(row.ownerType)] as TypeName | undefined;
            const owner = ownerType ? mapId(ownerType, row.ownerId) : undefined;
            return owner ? `${String(row.ownerType)}:${owner}:${String(row.provider)}:${String(row.externalKey)}:${String(row.relation)}:${String(row.stepId ?? '')}` : null;
          }
          default: return null;
        }
      };

      const keys = new Map<string, string>(); // Schlüssel im Paket → im Ziel
      const packageFields = new Set<string>();
      const newKeys: { type: 'test-cases' | 'preconditions'; src: string; id: string }[] = [];
      const parentMax = new Map<string, number>(); // vorhandener Testfall/Vorbedingung → höchste Versionsnummer im Ziel
      const vno = new Map<string, number>(); // `${Ziel-Eltern-ID}:${Versionsnummer im Paket}` → Versionsnummer im Ziel
      const appended = new Map<string, { type: TypeName; srcCurrent: number | null }>(); // vorhandene Eltern mit neuen Versionen
      const srcCurrent = new Map<string, number>(); // Ziel-Eltern-ID → aktuelle Version laut Paket

      /**
       * Fremder Testfall bzw. seine ausgeführte Version: in dieser Instanz vorhanden (gleiche Instanz oder früher übertragen)
       * → weiter darauf verweisen; sonst den Testfall als Kopie im Zielprojekt anlegen (neuer Schlüssel).
       */
      // Ein Verweis auf einen vorhandenen fremden Testfall ist nur zulässig, wenn die importierende Person dessen Projekt
      // lesen darf – sonst könnte ein selbst gebautes Paket Testfälle eingeschränkter Projekte in das eigene einbinden.
      const readable = (pid: string) => pid === projectId || o.readableProjects === null || o.readableProjects.includes(pid);
      const existsIn = async (table: 'test_case' | 'test_case_version', id: string) => {
        const [r] = table === 'test_case'
          ? await tx<{ projectId: string }[]>`select project_id from test_case where id = ${id}`
          : await tx<{ projectId: string }[]>`select t.project_id from test_case_version v join test_case t on t.id = v.test_case_id where v.id = ${id}`;
        return !!r && readable(r.projectId);
      };
      const knownAnywhere = async (type: string, sid: string) => {
        const [k] = await tx<{ targetId: string }[]>`select target_id from package_identity
          where source_instance = ${manifest.sourceInstance} and source_type = ${type} and source_id = ${sid} limit 1`;
        return k?.targetId;
      };
      const resolveForeign = async (type: TypeName, row: Record<string, unknown>): Promise<Resolved> => {
        const sid = row.id as string;
        if (type === 'foreign-test-cases') {
          if (sameInstance && await existsIn('test_case', sid)) return { id: sid, existing: true };
          const known = await knownAnywhere('test-cases', sid) ?? await knownAnywhere('foreign-test-cases', sid);
          if (known && await existsIn('test_case', known)) return { id: known, existing: true };
          const id = uuidv7();
          foreignCopies.add(id);
          const k = String(row.key);
          if (existingMode) newKeys.push({ type: 'test-cases', src: k, id });
          else keys.set(k, `${dst}-T${Number(project.nextNumber ?? 1) + extraNumbers++}`);
          warn('Fremde Testfälle', 'Testfall eines anderen Projekts als Kopie angelegt (in dieser Instanz nicht vorhanden)');
          return { id, existing: false };
        }
        const parent = mapId('test-cases', row.testCaseId);
        if (parent && foreignCopies.has(parent)) { vno.set(`${parent}:${Number(row.versionNo)}`, Number(row.versionNo)); return { id: uuidv7(), existing: false }; }
        if (sameInstance && await existsIn('test_case_version', sid)) return { id: sid, existing: true };
        const known = await knownAnywhere('test-case-versions', sid) ?? await knownAnywhere('foreign-test-case-versions', sid);
        if (known && await existsIn('test_case_version', known)) return { id: known, existing: true };
        // vorhandener Testfall ohne bekannte Fassung: gleiche Versionsnummer, sonst die aktuelle
        const [v] = parent ? await tx<{ id: string }[]>`select id from test_case_version where test_case_id = ${parent}
          order by (version_no = ${Number(row.versionNo)}) desc, version_no = (select current_version from test_case where id = ${parent}) desc limit 1` : [];
        if (!v) throw new HttpError(400, 'foreign-test-case-versions: Version ohne Testfall');
        warn('Fremde Testfälle', 'ausgeführte Fassung eines fremden Testfalls nicht eindeutig – gleiche Versionsnummer bzw. aktuelle Version verwendet');
        return { id: v.id, existing: true };
      };
      const project = JSON.parse((await z.read('project.json')).toString('utf8')) as Record<string, unknown>;

      for (const t of TYPES) {
        if (t.single) continue;
        const allowed = new Set([...t.columns.map(camel), ...(DERIVED[t.name] ?? [])]);
        const m = new Map<string, string>();
        const st = new Map<string, Resolved>();
        ids.set(t.name, m);
        state.set(t.name, st);
        const hasId = t.columns.includes('id');
        const inTarget = await targetIdsOf(t);
        const natural = await naturalIn(t.name);
        // Ziele, die schon einem Objekt des Pakets gehören (Herkunft oder frühere Zeile), nie ein zweites Mal zuordnen
        const claimed = new Set<string>();
        for (const [k, v] of known) if (k.startsWith(`${t.name}:`)) claimed.add(v);
        const versioned = VERSIONED[t.name];
        const rows: Record<string, unknown>[] = [];
        for await (const row of lines(z, fileOf(t))) {
          const extra = Object.keys(row).filter((k) => !allowed.has(k));
          if (extra.length) throw new HttpError(400, `${fileOf(t)}: unbekannte Angaben ${extra.join(', ')} – Paket passt nicht zur Formatversion ${manifest.formatVersion}`);
          if (hasId) {
            if (typeof row.id !== 'string' || !UUID_RE.test(row.id)) throw new HttpError(400, `${fileOf(t)}: ungültige ID`);
            if (st.has(row.id)) throw new HttpError(400, `${fileOf(t)}: doppelte ID ${row.id}`);
          }
          if (t.name === 'field-definitions') packageFields.add(`${String(row.scope)}:${String(row.key).toLowerCase()}`);
          if (t.name === 'folders') { rows.push(row); continue; } // Baum: nach dem Einlesen von oben nach unten
          if (!hasId) continue;
          const sid = row.id as string;
          if (t.name === 'foreign-test-cases' || t.name === 'foreign-test-case-versions') {
            const r = await resolveForeign(t.name, row);
            st.set(sid, r);
            m.set(sid, r.id);
            ids.get(SHARED_IDS[t.name]!)!.set(sid, r.id);
            continue;
          }
          let found: string | undefined = existingMode ? known.get(`${t.name}:${sid}`) : undefined;
          if (found && !inTarget.has(found)) found = undefined; // im Ziel inzwischen gelöscht
          if (!found && existingMode && sameInstance && inTarget.has(sid)) found = sid;
          let isNatural = false;
          if (!found) {
            const k = naturalKey(t.name, row);
            const hit = k ? natural.get(k) : undefined;
            if (hit && !claimed.has(hit)) { found = hit; isNatural = true; }
          }
          if (found) claimed.add(found);
          if (found && !isNatural && !MERGE_ONLY.has(t.name) && !IMMUTABLE.has(t.name) && policyOf(t.name) === 'new') found = undefined;
          const r: Resolved = found ? { id: found, existing: true, natural: isNatural } : { id: uuidv7(), existing: false };
          st.set(sid, r);
          m.set(sid, r.id);
          if (t.name === 'test-cases' || t.name === 'preconditions') {
            const k = String(row.key);
            if (r.existing) {
              const [cur] = t.name === 'test-cases'
                ? await tx<{ key: string; n: number }[]>`select key, (select coalesce(max(version_no), 0) from test_case_version where test_case_id = ${r.id})::int as n from test_case where id = ${r.id}`
                : await tx<{ key: string; n: number }[]>`select key, (select coalesce(max(version_no), 0) from precondition_version where precondition_id = ${r.id})::int as n from precondition where id = ${r.id}`;
              keys.set(k, cur!.key);
              parentMax.set(r.id, cur!.n);
            } else if (existingMode) {
              newKeys.push({ type: t.name, src: k, id: r.id });
            } else {
              keys.set(k, k.startsWith(`${src}-`) ? `${dst}-${k.slice(src.length + 1)}` : k);
            }
            srcCurrent.set(r.id, Number(row.currentVersion));
          }
          if (versioned) {
            const parent = mapId(versioned.parent, row[camel(versioned.fk)]);
            const no = Number(row.versionNo);
            if (parent && parentMax.has(parent) && policyOf(versioned.parent) === 'skip' && !r.existing) {
              // vorhandener Testfall bzw. Vorbedingung mit Regel „überspringen“: keine neuen Versionen anhängen
              r.skipped = true;
            } else if (parent && parentMax.has(parent)) {
              // vorhandener Testfall bzw. Vorbedingung: bekannte Versionen bleiben, neue werden angehängt
              if (r.existing) {
                const [v] = await tx<{ n: number }[]>`select version_no as n from ${tx(versioned.table)} where id = ${r.id}`;
                vno.set(`${parent}:${no}`, v!.n);
              } else {
                const next = parentMax.get(parent)! + 1;
                parentMax.set(parent, next);
                vno.set(`${parent}:${no}`, next);
                if (!appended.has(parent)) appended.set(parent, { type: versioned.parent, srcCurrent: srcCurrent.get(parent) ?? null });
              }
            } else if (parent) {
              vno.set(`${parent}:${no}`, no);
            }
          }
        }
        if (t.name === 'folders') {
          // Ordner von oben nach unten: gleicher Name im selben Elternordner ist derselbe Ordner
          const bySrc = new Map(rows.map((r) => [r.id as string, r]));
          const targetFolders = existingMode ? await tx<{ id: string; parentId: string | null; name: string }[]>`select id, parent_id, name from folder where project_id = ${projectId}` : [];
          const byName = new Map(targetFolders.map((f) => [`${f.parentId ?? ''}:${f.name}`, f.id]));
          const resolve = (sid: string, depth = 0): Resolved => {
            if (st.has(sid)) return st.get(sid)!;
            if (depth > 200) throw new HttpError(400, 'folders.ndjson: Ordnerbaum enthält einen Zyklus');
            const row = bySrc.get(sid)!;
            const parentSrc = row.parentId as string | null;
            const parent = parentSrc && bySrc.has(parentSrc) ? resolve(parentSrc, depth + 1).id : rootFolder;
            let found: string | undefined = existingMode ? known.get(`folders:${sid}`) : undefined;
            if (found && !inTarget.has(found)) found = undefined;
            if (!found && existingMode && sameInstance && inTarget.has(sid)) found = sid;
            if (!found) found = byName.get(`${parent ?? ''}:${String(row.name)}`);
            const r: Resolved = found ? { id: found, existing: true } : { id: uuidv7(), existing: false };
            if (!found) byName.set(`${parent ?? ''}:${String(row.name)}`, r.id);
            st.set(sid, r);
            m.set(sid, r.id);
            return r;
          };
          for (const sid of bySrc.keys()) resolve(sid);
        }
      }
      // neue Schlüssel im bestehenden Projekt: fortlaufend aus dem Nummernkreis des Ziels
      if (newKeys.length) {
        const nT = newKeys.filter((k) => k.type === 'test-cases').length, nP = newKeys.length - nT;
        const [r] = await tx<{ t: number; p: number }[]>`update project set next_number = next_number + ${nT}, next_precondition = next_precondition + ${nP}
          where id = ${projectId} returning next_number - ${nT} as t, next_precondition - ${nP} as p`;
        let t = r!.t, p = r!.p;
        for (const k of newKeys) keys.set(k.src, k.type === 'test-cases' ? `${dst}-T${t++}` : `${dst}-P${p++}`);
      }
      const keyRe = new RegExp(`\\b${src.replace(/[^A-Z0-9_]/g, '')}-[TP]\\d+\\b`, 'g');
      const rewriteKeys = (s: string) => (s.includes(`${src}-`) ? s.replace(keyRe, (all) => keys.get(all) ?? all) : s);
      report.keyMap = existingMode ? Object.fromEntries(keys) : {};

      // ---- Personen ----
      const users = await tx<{ id: string; username: string; email: string | null }[]>`select id, username, email from app_user`;
      const byName = new Set(users.map((u) => u.username));
      const personMap = new Map<string, string>();
      for (const p of manifest.persons ?? []) {
        const wanted = o.options.persons?.[p.login];
        let target = p.login, how: ImportReport['persons'][number]['how'] = 'als Text';
        if (wanted !== undefined && wanted !== null) {
          if (!byName.has(wanted)) report.problems.push(`Zuordnung ${p.login} → ${wanted}: Benutzer ${wanted} gibt es nicht`);
          target = wanted; how = 'zugeordnet';
        } else if (wanted === null) {
          how = 'als Text';
        } else if (byName.has(p.login)) {
          how = 'gleich';
        } else if (p.email) {
          const hits = users.filter((u) => u.email && u.email.toLowerCase() === p.email!.toLowerCase());
          if (hits.length === 1) { target = hits[0]!.username; how = 'E-Mail'; }
        }
        personMap.set(p.login, target);
        report.persons.push({ login: p.login, displayName: p.displayName, target, how });
      }
      const person = (v: unknown) => (typeof v === 'string' ? personMap.get(v) ?? v : v);

      // ---- Globale Kataloge ----
      progress({ phase: 'Kataloge' });
      const catalog = JSON.parse((await z.read('catalog.json')).toString('utf8')) as Record<string, Record<string, unknown>[]>;
      const codeMaps = { execution: new Map<string, string>(), testCase: new Map<string, string>(), priority: new Map<string, string>() };
      const insertRow = async (table: string, row: Record<string, unknown>) => {
        const cols = Object.keys(row);
        const values = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? tx.json(v as never) : v]));
        await tx`insert into ${tx(table)} ${tx(values as never, cols)} on conflict do nothing`;
      };
      const syncCodes = async (kind: string, table: string, rows: Record<string, unknown>[], mapping: Record<string, string> | undefined, target: Map<string, string>, blocking: boolean) => {
        const existing = new Set((await tx<{ code: string }[]>`select code from ${tx(table)}`).map((r) => r.code));
        for (const r of rows ?? []) {
          const code = String(r.code);
          const mapped = mapping?.[code];
          if (existing.has(code) && !mapped) { report.catalog.push({ kind, code, action: 'vorhanden' }); continue; }
          if (mapped) {
            if (!existing.has(mapped)) report.problems.push(`${kind} ${mapped} (Zuordnung für ${code}) gibt es nicht`);
            target.set(code, mapped);
            report.catalog.push({ kind, code, action: 'zugeordnet', target: mapped });
          } else if (o.isSystemAdmin) {
            await insertRow(table, r);
            report.catalog.push({ kind, code, action: 'angelegt' });
          } else {
            report.catalog.push({ kind, code, action: 'fehlt' });
            const msg = `${kind} „${code}“ gibt es hier nicht: einem vorhandenen zuordnen oder von der Systemadministration importieren lassen`;
            if (blocking) report.problems.push(msg); else report.warnings.push(`${msg} (wird als Text übernommen)`);
          }
        }
      };
      await syncCodes('Ergebnisstatus', 'execution_status', catalog.executionStatuses ?? [], o.options.executionStatuses, codeMaps.execution, true);
      await syncCodes('Testfallstatus', 'test_case_status', catalog.testCaseStatuses ?? [], o.options.testCaseStatuses, codeMaps.testCase, false);
      await syncCodes('Priorität', 'priority', catalog.priorities ?? [], o.options.priorities, codeMaps.priority, false);
      if (o.isSystemAdmin) {
        for (const tr of catalog.testCaseTransitions ?? []) await tx`insert into test_case_transition(from_code, to_code)
          select ${String(tr.fromCode)}, ${String(tr.toCode)} where exists (select 1 from test_case_status where code = ${String(tr.fromCode)})
            and exists (select 1 from test_case_status where code = ${String(tr.toCode)}) on conflict do nothing`;
      }
      for (const d of catalog.configDimensions ?? []) {
        const there = (await tx`select 1 from config_dimension where key = ${String(d.key)}`).length > 0;
        if (there) report.catalog.push({ kind: 'Konfigurationsachse', code: String(d.key), action: 'vorhanden' });
        else if (o.isSystemAdmin) { await insertRow('config_dimension', d); report.catalog.push({ kind: 'Konfigurationsachse', code: String(d.key), action: 'angelegt' }); }
        else report.warnings.push(`Konfigurationsachse „${String(d.key)}“ gibt es hier nicht (Werte bleiben an den Zyklen erhalten)`);
      }
      for (const v of catalog.configValues ?? []) {
        if (!(await tx`select 1 from config_dimension where key = ${String(v.dimensionKey)}`).length) continue;
        if ((await tx`select 1 from config_value where dimension_key = ${String(v.dimensionKey)} and value = ${String(v.value)}`).length) continue;
        if (o.isSystemAdmin) await insertRow('config_value', { ...v, id: uuidv7() });
      }

      // ---- Projekt ----
      if (report.problems.length) throw new DryRun(report);
      if (!existingMode) {
        await tx`insert into project(id, key, name, description, next_number, next_precondition, created_at, visibility, external_services, ai_context,
            require_failure_evidence, execute_only_assignee)
          values (${projectId}, ${dst}, ${report.target.name}, ${(project.description as string | null) ?? null}, ${Number(project.nextNumber ?? 1) + extraNumbers},
            ${Number(project.nextPrecondition ?? 1)}, ${String(project.createdAt)}, ${String(project.visibility ?? 'internal')}, ${String(project.externalServices ?? 'allowed')},
            ${(project.aiContext as string | null) ?? null}, ${project.requireFailureEvidence !== false}, ${project.executeOnlyAssignee === true})`;
        report.target.projectId = projectId;
      } else {
        const [pr] = await tx<{ visibility: string; externalServices: string }[]>`select visibility, external_services from project where id = ${projectId}`;
        const srcSensitive = project.visibility === 'restricted' || project.externalServices === 'blocked';
        if (srcSensitive && pr!.visibility !== 'restricted' && pr!.externalServices !== 'blocked') {
          report.warnings.push('Das Quellprojekt war eingeschränkt bzw. für externe Dienste gesperrt, das Zielprojekt ist es nicht – Einstellungen prüfen');
        }
      }

      // globale Felder: vorhanden → verwenden; sonst global (Systemadministration) bzw. als Projektfeld anlegen
      for (const f of catalog.globalFields ?? []) {
        const there = (await tx`select 1 from field_definition where scope = ${String(f.scope)} and lower(key) = lower(${String(f.key)})
          and (project_id is null or project_id = ${projectId})`).length > 0;
        const code = `${String(f.scope)}:${String(f.key)}`;
        if (there) { report.catalog.push({ kind: 'Feld', code, action: 'vorhanden' }); continue; }
        // ohne Systemadministration als Projektfeld – es sei denn, das Paket bringt ein gleichnamiges Projektfeld mit
        if (!o.isSystemAdmin && packageFields.has(`${String(f.scope)}:${String(f.key).toLowerCase()}`)) {
          report.catalog.push({ kind: 'Feld', code, action: 'vorhanden', target: 'Projektfeld aus dem Paket' });
          continue;
        }
        await insertRow('field_definition', { ...f, id: uuidv7(), projectId: o.isSystemAdmin ? null : projectId });
        report.catalog.push({ kind: 'Feld', code, action: o.isSystemAdmin ? 'angelegt' : 'als Projektfeld' });
      }
      const userFields = new Set((await tx<{ key: string }[]>`
        select key from field_definition where type = 'user' and (project_id is null or project_id = ${projectId})`).map((r) => r.key));

      // Spaltentypen (jsonb einpacken, Datumswerte ohne Zeitzone) und Pflichtspalten
      const tables = TYPES.map((t) => t.table);
      const colInfo = await tx<{ tableName: string; columnName: string; dataType: string; isNullable: string }[]>`
        select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' and table_name = any(${tables})`;
      const info = (table: string, col: string) => colInfo.find((c) => c.tableName === table && c.columnName === col);
      const principals = {
        user: new Map(users.map((u) => [u.username, u.id])),
        group: new Map((await tx<{ id: string; name: string }[]>`select id, name from user_group`).map((g) => [g.name, g.id])),
      };
      const [cursor] = await tx<{ seq: string }[]>`select coalesce(max(seq), 0)::text as seq from domain_event`;
      const seq = cursor!.seq;
      const selfRefs: { table: string; column: string; id: string; target: string }[] = [];
      const pinned: { id: string; refs: unknown }[] = [];
      const memberSeen = new Set<string>();
      const identities: [string, string, string][] = []; // Objektart, Quell-ID, Ziel-ID
      /** vorhandene Ausführungen, die unverändert bleiben (abgeschlossen bzw. Regel „überspringen“) */
      const untouched = new Set<string>();
      /** vorhandene Objekte, die aus dem Paket aktualisiert wurden */
      const updatedIds = new Set<string>();
      const closedCycles = new Set(existingMode
        ? (await tx<{ id: string }[]>`select id from test_cycle where project_id = ${projectId} and state = 'closed'`).map((r) => r.id) : []);

      /** Bezüge übersetzen; false, wenn ein Pflichtbezug fehlt (Objekt wird übersprungen) */
      const translateRefs = (t: TypeSpec, row: Record<string, unknown>, nullable: Set<string>): boolean => {
        for (const r of t.refs as Ref[]) {
          const key = camel(r.column);
          const v = row[key];
          if (v === null || v === undefined) continue;
          if ('principal' in r) continue; // Mitglieder: eigene Zuordnung
          if ('json' in r) {
            if (r.json === '[].call.testCaseId' && Array.isArray(v)) {
              row[key] = v.map((s: Record<string, unknown>) => {
                const call = s?.call as { testCaseId?: string; versionNo?: number | null } | null | undefined;
                if (!call?.testCaseId) return s;
                const target = mapId(r.to, call.testCaseId);
                if (!target) { warn('Aufrufe', 'Aufruf eines Testfalls außerhalb des Pakets – Schritt bleibt als Text'); return { ...s, call: null }; }
                const no = call.versionNo ? vno.get(`${target}:${call.versionNo}`) ?? call.versionNo : call.versionNo;
                return { ...s, call: { ...call, testCaseId: target, ...(call.versionNo ? { versionNo: no } : {}) } };
              });
            } else if (r.json === 'preconditions.{}' && typeof v === 'object') {
              const pins = (v as { preconditions?: Record<string, number> }).preconditions ?? {};
              row[key] = { ...(v as object), preconditions: Object.fromEntries(Object.entries(pins).flatMap(([id, no]) => {
                const target = mapId(r.to, id);
                return target ? [[target, vno.get(`${target}:${no}`) ?? no]] : [];
              })) };
            }
            continue;
          }
          if ('array' in r) {
            const list = (v as string[]).map((x) => mapId(r.to, x)).filter(Boolean);
            if (list.length < (v as string[]).length) warn('Bezüge', `${t.name}: Bezüge auf Objekte außerhalb des Pakets entfernt`);
            row[key] = list;
            continue;
          }
          const to = 'by' in r ? r.to[String(row[camel(r.by)])] : r.to;
          const target = to ? mapId(to, v) : undefined;
          if (target) { row[key] = target; continue; }
          if (nullable.has(r.column)) { row[key] = null; warn('Bezüge', `${t.name}: Bezug auf ein Objekt außerhalb des Pakets entfernt`); continue; }
          warn('Übersprungen', `${t.name}: Objekt ohne zugehöriges Objekt im Paket übersprungen`);
          return false;
        }
        return true;
      };
      const rewriteDeep = (v: unknown, field?: string): unknown => {
        if (typeof v === 'string') return field && KEEP_TEXT.has(field) ? v : rewriteKeys(v);
        if (Array.isArray(v)) return v.map((x) => rewriteDeep(x));
        if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, rewriteDeep(x, k)]));
        return v;
      };

      for (const t of TYPES) {
        if (t.single) continue;
        progress({ phase: 'Einspielen', type: t.name, done: 0 });
        if ((existingMode && TARGET_SETTINGS.has(t.name)) || (!o.isSystemAdmin && ADMIN_ONLY.has(t.name))) {
          let n = 0;
          for await (const _ of lines(z, fileOf(t))) n++;
          if (n) report.warnings.push(existingMode && TARGET_SETTINGS.has(t.name)
            ? `${t.name}: ${n} nicht übernommen – Einstellungen des Zielprojekts bleiben`
            : `${t.name}: ${n} nicht übernommen – Anbindungen und Webhooks richtet die Systemadministration ein`);
          continue;
        }
        const implicit = 'project_id' in t.omitted;
        const nullable = new Set(t.columns.filter((c) => info(t.table, c)?.isNullable === 'YES'));
        const selfRef = t.refs.find((r) => 'to' in r && r.to === t.name && !('array' in r) && !('json' in r) && !('by' in r));
        let cols = [...t.columns];
        if (implicit) cols = [...cols, 'project_id'];
        if (t.name === 'views') cols = [...cols, 'user_id'];
        if (t.name === 'webhooks') cols = [...cols, 'secret', 'cursor_seq'];
        const jsonCols = new Set(cols.filter((c) => info(t.table, c)?.dataType === 'jsonb'));
        const dateCols = new Set(cols.filter((c) => info(t.table, c)?.dataType === 'date'));
        const value = (c: string, v: unknown) => {
          if (v === undefined) v = null;
          if (jsonCols.has(c) && v !== null) return tx.json(v as never);
          if (dateCols.has(c) && typeof v === 'string') return v.slice(0, 10);
          return v;
        };
        const updatable = cols.filter((c) => !KEEP_ON_UPDATE.has(c) && !(selfRef && c === selfRef.column) && c !== 'secret' && c !== 'cursor_seq');
        const hasUpdatedAt = cols.includes('updated_at');
        const st = state.get(t.name)!;
        let batch: Record<string, unknown>[] = [];
        let n = 0;
        const flush = async () => {
          if (!batch.length) return;
          const rows = batch.map((r) => Object.fromEntries(cols.map((c) => [camel(c), value(c, r[camel(c)])])));
          await tx`insert into ${tx(t.table)} ${tx(rows as never, cols.map(camel))}`;
          n += batch.length;
          batch = [];
          progress({ phase: 'Einspielen', type: t.name, done: n });
        };
        /** vorhandenes Objekt aktualisieren (neuere Fassung gewinnt); liefert, ob geändert wurde */
        const update = async (row: Record<string, unknown>): Promise<boolean> => {
          if (!updatable.length) return false;
          const set = Object.fromEntries(updatable.map((c) => [camel(c), value(c, row[camel(c)])]));
          const newer = hasUpdatedAt && row.updatedAt ? tx`and (updated_at is null or updated_at < ${String(row.updatedAt)})` : tx``;
          // nur Objekte des Zielprojekts – auch wenn die Zuordnung oben einmal versagen sollte
          const r = await tx`update ${tx(t.table)} set ${tx(set as never, updatable.map(camel))} where id = ${row.id as string} and ${t.where(tx, projectId)} ${newer}`;
          return r.count > 0;
        };

        for await (const raw of lines(z, fileOf(t))) {
          const srcId = raw.id as string | undefined;
          const resolved = srcId !== undefined ? st.get(srcId) : undefined;
          const row = rewriteDeep(raw) as Record<string, unknown>;
          if (resolved) row.id = resolved.id;
          // fremde Testfälle: ihr Ordner gehört zum anderen Projekt (Kopien landen im Zielordner bzw. oben)
          if (t.name === 'foreign-test-cases') row.folderId = null;
          if (!translateRefs(t, row, nullable)) continue;
          for (const c of t.persons) row[camel(c)] = person(row[camel(c)]);
          if (row.customFields && typeof row.customFields === 'object') {
            row.customFields = Object.fromEntries(Object.entries(row.customFields as Record<string, unknown>).map(([k, v]) =>
              [k, userFields.has(k) ? (Array.isArray(v) ? v.map(person) : person(v)) : v]));
          }
          if (implicit) row.projectId = projectId;
          // Schlüssel und Versionsnummern im Ziel
          if ((t.name === 'test-cases' || t.name === 'preconditions' || t.name === 'foreign-test-cases') && typeof raw.key === 'string') row.key = keys.get(raw.key) ?? row.key;
          const versioned = VERSIONED[t.name];
          if (versioned) {
            const parent = row[camel(versioned.fk)] as string;
            row.versionNo = vno.get(`${parent}:${Number(raw.versionNo)}`) ?? raw.versionNo;
          }
          if (t.name === 'test-cases' || t.name === 'preconditions') {
            for (const c of ['currentVersion', 'approvedVersion']) if (row[c]) row[c] = vno.get(`${row.id as string}:${Number(row[c])}`) ?? row[c];
          }
          if (t.name === 'folders' && !row.parentId && rootFolder) row.parentId = rootFolder;
          if (t.name === 'test-cases' && !row.folderId && rootFolder && !resolved?.existing) row.folderId = rootFolder;
          if (t.name === 'foreign-test-cases') { row.folderId = rootFolder; row.approvedVersion = null; row.approvedBy = null; row.approvedAt = null; }
          // Freigaben und Prüfvermerke (Vier-Augen-Prinzip) übernimmt nur die Systemadministration – sonst ließen sie sich im
          // Namen anderer Personen in ein Paket schreiben
          if (!o.isSystemAdmin && t.name === 'test-cases' && row.approvedBy) {
            row.approvedVersion = null; row.approvedBy = null; row.approvedAt = null;
            warn('Freigaben', 'Freigabe eines Testfalls nicht übernommen (nur bei Import durch die Systemadministration)');
          }
          if (!o.isSystemAdmin && t.name === 'executions' && (row.reviewState === 'approved' || row.reviewState === 'rejected')) {
            row.reviewState = 'pending'; row.reviewedBy = null; row.reviewedAt = null;
            warn('Freigaben', 'geprüftes Agentenergebnis wieder zur Prüfung gestellt (Prüfvermerk nur bei Import durch die Systemadministration)');
          }
          switch (t.name) {
            case 'test-cases': case 'foreign-test-cases': if (codeMaps.testCase.has(String(row.status))) row.status = codeMaps.testCase.get(String(row.status)); break;
            case 'test-case-versions': if (codeMaps.priority.has(String(row.priority))) row.priority = codeMaps.priority.get(String(row.priority)); break;
            case 'executions': if (codeMaps.execution.has(String(row.status))) row.status = codeMaps.execution.get(String(row.status)); break;
            case 'execution-results': if (codeMaps.execution.has(String(row.status))) row.status = codeMaps.execution.get(String(row.status)); break;
            case 'sessions':
              if (Array.isArray(row.findings)) row.findings = (row.findings as Record<string, unknown>[]).map((f) => ({ ...f, ...(f.by ? { by: person(f.by) } : {}) }));
              break;
            case 'references':
              // nur http(s)-Adressen ohne Zugangsdaten (ein Paket kann beliebige Texte enthalten, z. B. javascript:)
              if (typeof row.url === 'string' && !/^https?:\/\/[^\s@/]+(\/|$)/i.test(row.url)) { row.url = null; warn('Verweise', 'Adresse ohne http(s) bzw. mit Zugangsdaten entfernt'); }
              break;
            case 'views': row.userId = principals.user.get(String(row.ownerName)) ?? null; break;
            case 'webhooks': row.secret = randomBytes(24).toString('base64url'); row.active = false; row.cursorSeq = seq; break;
            default: break;
          }

          // ---- vorhandenes Objekt ----
          if (resolved?.existing) {
            if (resolved.natural || !(sameInstance && resolved.id === srcId)) identities.push([t.name, srcId!, resolved.id]);
            const policy = policyOf(t.name);
            const closed = (t.name === 'executions' && closedCycles.has(row.cycleId as string)) || (t.name === 'cycles' && closedCycles.has(resolved.id));
            if (closed) {
              if (t.name === 'executions') untouched.add(resolved.id);
              report.conflicts.push(`${t.name === 'cycles' ? 'Zyklus' : 'Ausführung'} ${t.name === 'cycles' ? `„${String(row.name)}“` : `in abgeschlossenem Zyklus`} ist im Ziel abgeschlossen – nicht verändert`);
              change(t.name, 'skipped');
              continue;
            }
            if (IMMUTABLE.has(t.name) || policy === 'skip' || t.name === 'folders') {
              if (t.name === 'executions') untouched.add(resolved.id);
              change(t.name, 'skipped');
              continue;
            }
            const changed = await update(row);
            if (changed) updatedIds.add(resolved.id);
            // festgehaltene Fassungen nur, wenn die Ausführung wirklich aus dem Paket kommt (sonst passen sie nicht zur Version)
            if (t.name === 'executions' && changed) pinned.push({ id: resolved.id, refs: row.pinnedRefs });
            change(t.name, changed ? 'updated' : 'skipped');
            continue;
          }
          // neue Versionen vorhandener Testfälle/Vorbedingungen mit Regel „überspringen“
          if (resolved?.skipped) { change(t.name, 'skipped'); continue; }
          // abgeschlossene Zyklen im Ziel bekommen auch keine neuen Ausführungen (samt Verlauf)
          if (t.name === 'executions' && closedCycles.has(row.cycleId as string)) {
            untouched.add(row.id as string);
            // abhängige Objekte (Verlauf, Verweise, Kommentare, Anhänge) finden kein Ziel mehr und entfallen ebenso
            if (srcId) ids.get('executions')!.delete(srcId);
            report.conflicts.push('Neue Ausführung in einem im Ziel abgeschlossenen Zyklus – nicht angelegt');
            change(t.name, 'skipped');
            continue;
          }

          // ---- neues Objekt ----
          if (t.name === 'execution-results') {
            // abgeschlossene oder übersprungene Ausführungen bleiben samt Verlauf unverändert
            if (untouched.has(row.executionId as string)) { change(t.name, 'skipped'); continue; }
          }
          if (t.name === 'execution-results' && existingMode) {
            // Ergebnisverlauf vorhandener Ausführungen: gleiche Erfassung nicht doppelt
            const dup = await tx`select 1 from execution_result where execution_id = ${row.executionId as string} and recorded_at = ${String(row.recordedAt)} and status = ${String(row.status)}`;
            if (dup.length) { change(t.name, 'skipped'); continue; }
          }
          if (t.name === 'members') {
            const id = row.principalType === 'user' ? principals.user.get(String(person(raw.principal))) : principals.group.get(String(raw.principal));
            if (!id) { warn('Mitglieder', `${row.principalType === 'user' ? 'Benutzer' : 'Gruppe'} „${String(raw.principal)}“ gibt es hier nicht – Rolle nicht übernommen`); continue; }
            // mehrere Personen auf dieselbe abgebildet: eine Mitgliedschaft genügt
            if (memberSeen.has(`${String(row.principalType)}:${id}`)) { warn('Mitglieder', 'doppelte Mitgliedschaft nach Personenzuordnung zusammengefasst'); continue; }
            memberSeen.add(`${String(row.principalType)}:${id}`);
            row.principalId = id;
          }
          if (t.name === 'attachments' && row.storage === 'LOCAL') {
            const sha = raw.sha256 as string | null;
            if (!sha || !/^[0-9a-f]{64}$/.test(sha) || !z.entries.has(`files/${sha}`)) { warn('Anhänge', 'Anhang ohne Datei im Paket übersprungen'); continue; }
            row.location = row.id;
            if (!o.dryRun) {
              if (!written.length) await mkdir(staging, { recursive: true });
              written.push(row.id as string);
              await pipeline(z.stream(`files/${sha}`), createWriteStream(join(staging, row.id as string), { flags: 'wx' }));
            }
            report.counts.files++;
          }
          if (selfRef && row[camel(selfRef.column)]) {
            selfRefs.push({ table: t.table, column: selfRef.column, id: row.id as string, target: row[camel(selfRef.column)] as string });
            row[camel(selfRef.column)] = null;
          }
          if (t.name === 'executions') pinned.push({ id: row.id as string, refs: row.pinnedRefs });
          if (srcId) identities.push([t.name, srcId, row.id as string]);
          change(t.name, 'created');
          batch.push(row);
          if (batch.length >= 500) await flush();
        }
        await flush();
        report.counts[t.name] = n;
      }
      if (!existingMode && (report.counts.webhooks ?? 0) > 0) report.warnings.push('Webhooks sind abgeschaltet und haben ein neues Geheimnis; übertragen wurde nur der Host der Adresse – vollständige Adresse in der Administration eintragen, dann einschalten');

      // ---- Abschluss ----
      progress({ phase: 'Abschluss' });
      // Bezüge auf Objekte derselben Art (Ordnerbaum, Antworten auf Kommentare) – Ziel ist schon übersetzt
      for (const r of selfRefs) await tx`update ${tx(r.table)} set ${tx(camel(r.column))} = ${r.target} where id = ${r.id}`;
      // festgehaltene Fassungen der Vorbedingungen (der Trigger setzt sie beim Einfügen neu)
      for (let i = 0; i < pinned.length; i += 500) {
        const chunk = pinned.slice(i, i + 500).filter((x) => x.refs);
        if (!chunk.length) continue;
        await tx`update test_execution e set pinned_refs = v.refs::jsonb from (values ${tx(chunk.map((x) => [x.id, JSON.stringify(x.refs)]) as never)}) as v(id, refs)
          where e.id = v.id::uuid`;
      }
      // vorhandene Testfälle/Vorbedingungen mit angehängten Versionen: aktuelle Version laut Paket
      for (const [id, a] of appended) {
        const no = a.srcCurrent !== null ? vno.get(`${id}:${a.srcCurrent}`) : undefined;
        if (!no) continue;
        const table = a.type === 'test-cases' ? 'test_case' : 'precondition';
        const [prev] = await tx<{ n: number; key: string }[]>`select current_version as n, key from ${tx(table)} where id = ${id}`;
        if (!updatedIds.has(id)) {
          // Ziel ist neuer: Paketfassung nur in der Historie, aktuelle Version bleibt
          report.conflicts.push(`${prev!.key}: im Ziel neuer – Version ${no} aus dem Paket nur in der Historie, aktuell bleibt Version ${prev!.n}`);
          continue;
        }
        await tx`update ${tx(table)} set current_version = ${no}, updated_at = now() where id = ${id}`;
        report.conflicts.push(`${prev!.key}: neue Version ${no} aus dem Paket; bisher aktuelle Version ${prev!.n} bleibt in der Historie`);
      }
      // kopierte fremde Testfälle: nur die ausgeführten Fassungen sind im Paket – aktuelle Version ist die höchste davon
      if (foreignCopies.size) {
        await tx`update test_case t set current_version = (select max(version_no) from test_case_version v where v.test_case_id = t.id) where t.id = any(${[...foreignCopies]}::uuid[])`;
      }
      // Herkunft festhalten (auch beim neuen Projekt: spätere Pakete derselben Quelle aktualisieren dann)
      for (let i = 0; i < identities.length; i += 1000) {
        const chunk = identities.slice(i, i + 1000).map(([type, s, target]) => [manifest.sourceInstance, type, s, projectId, target]);
        await tx`insert into package_identity(source_instance, source_type, source_id, project_id, target_id)
          select v.si::uuid, v.st, v.sid::uuid, v.pid::uuid, v.tid::uuid from (values ${tx(chunk as never)}) as v(si, st, sid, pid, tid)
          on conflict (source_instance, source_type, source_id, project_id) do update set target_id = excluded.target_id`;
      }
      // Wer in ein neues Projekt importiert, verwaltet es
      if (!existingMode && o.userId) {
        await tx`insert into project_member(project_id, principal_type, principal_id, role) values (${projectId}, 'user', ${o.userId}, 'PROJECT_ADMIN')
          on conflict (project_id, principal_type, principal_id) do update set role = 'PROJECT_ADMIN'`;
      }
      for (const [group, msgs] of grouped) for (const [msg, count] of msgs) report.warnings.push(`${group}: ${msg}${count > 1 ? ` (${count}×)` : ''}`);

      if (o.dryRun) throw new DryRun(report);
      await recordEvent(tx, { type: EventTypes.ProjectImported, aggregateType: 'Project', aggregateId: projectId, actor: o.actor,
        payload: { key: dst, mode, from: { key: src, instance: manifest.sourceInstance, transferId: manifest.transferId }, transferId: o.transferId, counts: report.counts } });
      return report;
    }) as ImportReport;
    for (const id of written) await rename(join(staging, id), join(o.attachmentDir, id));
    return result;
  } catch (e) {
    if (e instanceof DryRun) return e.report;
    throw e;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await z.close();
  }
}

const STAGING_PREFIX = '.import-';
/** Nach einem Neustart: Zwischenverzeichnisse abgebrochener Importe entfernen (ihre Transaktion ist zurückgerollt) */
export async function cleanupImportStaging(attachmentDir: string): Promise<void> {
  for (const name of await readdir(attachmentDir).catch(() => [] as string[])) {
    if (name.startsWith(STAGING_PREFIX)) await rm(join(attachmentDir, name), { recursive: true, force: true });
  }
}
