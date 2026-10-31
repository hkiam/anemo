/**
 * Snapshot-Format (ADR-0006): unveränderte API-Antworten als JSON-Dateien.
 *
 *   manifest.json                         { format, sourceSystem, baseUrl, extractedAt, anonymized, projects[] }
 *   fields.json                           GET /rest/api/2/field
 *   execution-statuses.json               GET /rest/zapi/latest/util/testExecutionStatus
 *   step-statuses.json                    Schrittstatus (optional; sonst gilt die Ausführungsliste)
 *   projects/<KEY>.json                   GET /rest/api/2/project/<KEY>
 *   issues/<KEY>-<n>.json                 Issue aus GET /rest/api/2/search (fields=*all, expand=changelog)
 *   teststeps/<issueId>.json              GET /rest/zapi/latest/teststep/<issueId>
 *   cycles/<KEY>/<versionId>.json         GET /rest/zapi/latest/cycle?projectId=&versionId=
 *   executions/<versionId>_<cycleId>.json GET /rest/zapi/latest/execution?cycleId=&versionId=&projectId= (alle Seiten)
 *   stepresults/<executionId>.json        GET /rest/zapi/latest/stepResult?executionId=
 *   teststep-history/<issueId>.json      Zephyr-Schritthistorie + geschätzter Anlegezeitpunkt je Schritt (nur DB-Quelle)
 *   execution-attachments/<execId>.json   GET /rest/zapi/latest/attachment/attachmentsByEntity?entityType=EXECUTION
 *   attachments/jira-<id>, zapi-<fileId>  Binärdaten der Anhänge
 */
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SNAPSHOT_FORMAT = 'anemo-zephyr-snapshot/1';

export interface Manifest {
  format: string;
  sourceSystem: string;
  baseUrl: string;
  extractedAt: string;
  anonymized: boolean;
  projects: string[];
  /** Anzahl extrahierter Objekte (zur Plausibilisierung). */
  counts?: Record<string, number>;
  /** Lücken bei der Extraktion. Nicht leer → Snapshot ist unvollständig, Verifikation schlägt fehl. */
  warnings?: string[];
  /** Bei anonymisierten Snapshots: Binäranhänge wurden entfernt (könnten Personenbezug enthalten). */
  attachmentsRemoved?: boolean;
}

type Json = Record<string, any>;

export class SnapshotReader {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async json<T = Json>(...path: string[]): Promise<T | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, ...path), 'utf8')) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Snapshot-Datei ${join(...path)} ist kein gültiges JSON: ${(e as Error).message}`);
    }
  }

  async list(...path: string[]): Promise<string[]> {
    try {
      return (await readdir(join(this.dir, ...path))).filter((f) => f.endsWith('.json')).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  async exists(...path: string[]): Promise<boolean> {
    try {
      await access(join(this.dir, ...path));
      return true;
    } catch {
      return false;
    }
  }

  path(...path: string[]): string {
    return join(this.dir, ...path);
  }

  async manifest(): Promise<Manifest> {
    const m = await this.json<Manifest>('manifest.json');
    if (!m) throw new Error(`Kein manifest.json in ${this.dir}`);
    if (m.format !== SNAPSHOT_FORMAT) throw new Error(`Unbekanntes Snapshot-Format: ${m.format}`);
    return m;
  }
}
