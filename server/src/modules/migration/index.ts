/**
 * Modul migration: Jira/Zephyr → Snapshot → (Anonymisierung) → Raw Store → Normalizer →
 * kanonisches Modell → Verification (ADR-0006).
 */
export { runImport } from './importer.ts';
export type { ImportResult } from './importer.ts';
export { buildReport } from './verify.ts';
export type { MigrationReport } from './verify.ts';
export { extractSnapshot } from './extract.ts';
export { anonymizeSnapshot, Anonymizer } from './anonymize.ts';
export { migrationRoutes } from './routes.ts';
