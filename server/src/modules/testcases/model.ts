import { z } from 'zod';
import { parseGherkin } from './gherkin.ts';

export const Step = z.object({
  /** Stabile Schritt-ID (bleibt über Versionen gleich, damit Schrittergebnisse zuordenbar sind). */
  id: z.string().optional(),
  action: z.string().default(''),
  data: z.string().default(''),
  expected: z.string().default(''),
  /** Aufruf eines anderen Testfalls (modularer Test): dessen Schritte werden bei der Ausführung eingesetzt */
  call: z.object({ testCaseId: z.uuid(), versionNo: z.number().int().positive().nullish() }).nullish(),
  /** Herkunft aus der Schrittbibliothek (Kopie; Schritt bleibt frei änderbar) */
  blockId: z.uuid().nullish(),
  /** nur in der aufgelösten Ausführungssicht: Herkunft eines eingesetzten Schritts */
  origin: z.object({ key: z.string(), title: z.string(), versionNo: z.number() }).optional(),
  /**
   * Abschnitt (Stufe J1): kein Prüfschritt, ohne Ergebnis; gruppiert die folgenden Schritte bis zum nächsten Abschnitt.
   * Felder siehe shared/steps/groups.ts.
   */
  kind: z.enum(['step', 'group']).nullish(),
  title: z.string().max(200).nullish(),
  subtitle: z.string().max(200).nullish(),
  marker: z.string().max(100).nullish(),
  note: z.string().max(20000).nullish(),
  legacy: z.object({ action: z.string(), data: z.string(), expected: z.string() }).nullish(),
}).transform((s) => {
  // Abschnitte tragen keine Prüffelder und keinen Aufruf; normale Schritte keine Abschnittsfelder
  if (s.kind === 'group') return { ...s, action: '', data: '', expected: '', call: null, title: s.title?.trim() ?? '' };
  const { kind: _k, title: _t, subtitle: _s, marker: _m, note: _n, ...rest } = s;
  return rest;
});
export type Step = z.infer<typeof Step>;

export const Section = z.object({ title: z.string(), content: z.string() });
export type Section = z.infer<typeof Section>;

/**
 * Datensatz für parametrisierte Tests (Stufe G1): Spalten = Parameter, Zeilen = Durchläufe. In Schritten wird
 * ${spalte} (klassisch) bzw. <spalte> (Gherkin) ersetzt.
 */
export const Dataset = z.object({
  columns: z.array(z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N}_ .-]+$/u, 'Spaltenname: Buchstaben, Ziffern, _ . -')).min(1).max(20),
  rows: z.array(z.array(z.string().max(2000))).max(200),
}).superRefine((d, ctx) => {
  if (new Set(d.columns).size !== d.columns.length) ctx.addIssue({ code: 'custom', path: ['columns'], message: 'Spaltennamen doppelt' });
  d.rows.forEach((r, i) => { if (r.length !== d.columns.length) ctx.addIssue({ code: 'custom', path: ['rows', i], message: `Datenzeile ${i + 1}: ${r.length} statt ${d.columns.length} Werte` }); });
});
export type Dataset = z.infer<typeof Dataset>;

/** Fachinhalt eines Testfalls – alles hiervon ist versioniert (ADR-0004). */
export const TestCaseFormat = z.enum(['CLASSIC', 'GHERKIN', 'PLAIN']);
export type TestCaseFormat = z.infer<typeof TestCaseFormat>;

export const TestCaseContent = z.object({
  title: z.string().trim().min(1, 'Titel fehlt'),
  /** CLASSIC: Schritte (Aktion/Testdaten/Erwartung). GHERKIN: Szenario-Text in {@link gherkin}. */
  format: TestCaseFormat.default('CLASSIC'),
  gherkin: z.string().nullish().transform((v) => v ?? null),
  /** PLAIN: unstrukturierter Test – Testanweisung als Freitext (Jira-Markup), Ergebnis nur als Ganzes */
  plainText: z.string().nullish().transform((v) => v ?? null),
  objective: z.string().nullish().transform((v) => v ?? null),
  preconditions: z.string().nullish().transform((v) => v ?? null),
  testData: z.string().nullish().transform((v) => v ?? null),
  priority: z.string().nullish().transform((v) => v ?? null),
  labels: z.array(z.string()).default([]),
  components: z.array(z.string()).default([]),
  steps: z.array(Step).default([]),
  sections: z.array(Section).default([]),
  customFields: z.record(z.string(), z.unknown()).default({}),
  dataset: Dataset.nullish().transform((v) => (v && v.rows.length ? v : null)),
  /** Wiederverwendbare Vorbedingungen (Stufe H), in Reihenfolge */
  preconditionIds: z.array(z.uuid()).max(30).default([]),
}).superRefine((c, ctx) => {
  if (c.format === 'PLAIN' && !c.plainText?.trim()) ctx.addIssue({ code: 'custom', path: ['plainText'], message: 'Testanweisung (Freitext) fehlt' });
  if (c.format !== 'GHERKIN') return;
  if (!c.gherkin?.trim()) {
    ctx.addIssue({ code: 'custom', path: ['gherkin'], message: 'Gherkin-Text fehlt' });
    return;
  }
  for (const e of parseGherkin(c.gherkin).errors) {
    ctx.addIssue({ code: 'custom', path: ['gherkin'], message: `Zeile ${e.line}: ${e.message}` });
  }
});
export type TestCaseContent = z.infer<typeof TestCaseContent>;
export type TestCaseContentInput = z.input<typeof TestCaseContent>;

export const TEST_CASE_STATUSES = ['DRAFT', 'READY', 'APPROVED', 'DEPRECATED'] as const;

export interface TestCaseVersion extends TestCaseContent {
  id: string;
  testCaseId: string;
  versionNo: number;
  changeNote: string | null;
  createdAt: Date;
  createdBy: string;
  /** Mit KI erstellt bzw. überarbeitet (z. B. „testcase-draft · qwen2.5“) – Kennzeichnung, kein Inhalt */
  aiAssisted?: string | null;
}

export interface TestCase {
  id: string;
  projectId: string;
  projectKey: string;
  key: string;
  legacyKey: string | null;
  folderId: string | null;
  /** Freier Workflow-Status; migrierte Testfälle behalten ihren Jira-Status. */
  status: string;
  owner: string | null;
  currentVersion: number;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  /** Freigabe gilt für diese Version (Vier-Augen-Prinzip) */
  approvedVersion?: number | null; approvedBy?: string | null; approvedAt?: Date | null;
  /** Archiviert (Stufe H4): ausgeblendet, aber erhalten */
  archivedAt?: Date | null; archivedBy?: string | null;
  /** geplanter Aufwand in Minuten (nicht versioniert) */
  estimateMinutes?: number | null;
}

export interface TestCaseDetail extends TestCase {
  version: TestCaseVersion;
}

export interface TestCaseListItem extends TestCase {
  title: string;
  format: TestCaseFormat;
  priority: string | null;
  labels: string[];
  components: string[];
  stepCount: number;
}

export interface Folder {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  testCount: number;
}
