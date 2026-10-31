/**
 * Modul testcases: Ordnerbaum, Testfälle und ihre unveränderlichen Versionen (ADR-0004),
 * klassisch (Schritte) oder als Gherkin-Szenario.
 */
export * from './model.ts';
export {
  createTestCase, reviseTestCase, updateTestCaseMeta, findTestCase, getTestCase, getVersion, getVersionById,
  listVersions, searchTestCases, cloneTestCase, bulkUpdate, listFolders, createFolder, ensureFolderPath,
  executionSteps, effectiveDataset, stageVersionHistory, commitVersionHistory, resolveExecutionSteps, prepareCalls,
} from './service.ts';
export type { CreateTestCase, MetaChange, SearchQuery, BulkChange, HistoricVersion } from './service.ts';
export { parseGherkin, executableSteps, classicToGherkin, gherkinToClassic } from './gherkin.ts';
export type { GherkinDocument, GherkinScenario, GherkinStep } from './gherkin.ts';
export { testCaseRoutes } from './routes.ts';
export { getTestSet, resolveTestSet, testSetRoutes } from './testsets.ts';
export { listWorkflow } from './workflow.ts';
export type { TestCaseStatus, TestCaseStatusCategory, Transition } from './workflow.ts';
