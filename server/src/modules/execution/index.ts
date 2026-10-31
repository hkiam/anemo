/**
 * Modul execution: Testpläne, Testzyklen und Ausführungen.
 * Eine Ausführung zeigt immer auf eine konkrete Testfallversion (TC@vN) – spätere Änderungen am
 * Testfall verändern historische Ergebnisse nicht (ADR-0004).
 */
export * from './service.ts';
export * from './configuration.ts';
export { compareCycles, createRetest, distribute, repeatCycle } from './planning.ts';
export { claimNext, escalate, reviewQueue, reviewResult } from './review.ts';
export { executionRoutes, isLead } from './routes.ts';
export { listSessions, sessionRoutes } from './sessions.ts';
