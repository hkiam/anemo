import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { Db } from './platform/db.ts';
import { installErrorHandler, openApiDocument } from './platform/http.ts';
import { assistRoutes } from './modules/assist/index.ts';
import { attachmentRoutes } from './modules/attachments/index.ts';
import { automationRoutes } from './modules/automation/index.ts';
import { authMiddleware, type AuthMode, authRoutes } from './modules/auth/index.ts';
import { eventRoutes } from './modules/events/index.ts';
import { executionRoutes, sessionRoutes } from './modules/execution/index.ts';
import { helpRoutes } from './modules/help/index.ts';
import { integrationRoutes } from './modules/integrations/index.ts';
import { mcpRoutes } from './modules/mcp/index.ts';
import { migrationRoutes } from './modules/migration/index.ts';
import { notificationRoutes } from './modules/notifications/index.ts';
import { projectRoutes } from './modules/projects/index.ts';
import { qualityRoutes } from './modules/quality/index.ts';
import { referenceRoutes } from './modules/references/index.ts';
import { reportRoutes } from './modules/reports/index.ts';
import { searchRoutes } from './modules/search/index.ts';
import { settingsRoutes } from './modules/settings/index.ts';
import { testCaseRoutes, testSetRoutes } from './modules/testcases/index.ts';
import { startRoutes } from './modules/start/index.ts';
import { fieldRoutes } from './modules/fields/index.ts';
import { preconditionRoutes } from './modules/preconditions/index.ts';
import { stepLibraryRoutes } from './modules/steplib/index.ts';
import { commentRoutes } from './modules/comments/index.ts';
import { viewRoutes } from './modules/views/index.ts';
import { transferMaxBytes, transferRoutes } from './modules/transfer/index.ts';

export interface AppOptions {
  db: Db;
  attachmentDir: string;
  snapshotRoot: string;
  webDist?: string | undefined;
  /** 'on' = Anmeldung erforderlich (Standard); 'off' nur für Tests/Entwicklung ohne Login */
  authMode?: AuthMode;
}

export function createApp(o: AppOptions): Hono {
  const app = new Hono();
  app.use('*', secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:'], styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"],
    },
  }));
  installErrorHandler(app);
  // Größe der Anfragen begrenzen, bevor der Body gelesen wird (auch bei chunked encoding):
  // Anhänge 50 MB (Base64 entsprechend mehr), CI-Ergebnisse 20 MB, alles andere 4 MB
  const MB = 1024 * 1024;
  const limits: [RegExp, number][] = [[/^\/api\/attachments\/base64$/, 70 * MB], [/^\/api\/mcp$/, 70 * MB], [/^\/api\/attachments$/, 51 * MB], [/^\/api\/projects\/[^/]+\/automation-results$/, 20 * MB],
    // Import von Testfällen und Ergebnissen (Excel/CSV/XML als Base64)
    [/^\/api\/projects\/[^/]+\/(test-cases\/import|automation-import)/, 30 * MB], [/^\/api\/cycles\/[^/]+\/offline$/, 30 * MB],
    // Projektpakete (ADR-0027): Rohdaten, gestreamt auf die Platte
    [/^\/api\/package-imports$/, transferMaxBytes()]];
  const limiters = new Map<number, ReturnType<typeof bodyLimit>>();
  const limiter = (max: number) => limiters.get(max) ?? limiters.set(max, bodyLimit({
    maxSize: max, onError: (c) => c.json({ status: 413, detail: `Anfrage zu groß (max. ${Math.round(max / MB)} MB)` }, 413),
  })).get(max)!;
  const anonymousLimiter = bodyLimit({
    maxSize: 64 * 1024, onError: (c) => c.json({ status: 413, detail: 'Anfrage zu groß (ohne Anmeldung max. 64 KB)' }, 413),
  });
  const authMode = o.authMode ?? 'on';
  // Anmeldung zuerst (liest nur Kopfzeilen und Cookie, nie den Body), damit das Limit davon abhängen kann:
  // Ohne Anmeldung (Login, öffentliche Routen, Unbekannte) höchstens 64 KB (Sicherheitsreview Teil 2, Befund 7).
  app.use('/api/*', authMiddleware(o.db, authMode));
  app.use('/api/*', (c, next) => {
    const anonymous = !c.get('principal' as never);
    return (anonymous ? anonymousLimiter : limiter(limits.find(([re]) => re.test(c.req.path))?.[1] ?? 4 * MB))(c, next);
  });

  app.get('/health', async (c) => {
    await o.db`select 1`;
    return c.json({ status: 'UP' });
  });

  authRoutes(app, o.db, authMode);
  projectRoutes(app, o.db);
  testCaseRoutes(app, o.db);
  testSetRoutes(app, o.db);
  referenceRoutes(app, o.db);
  attachmentRoutes(app, o.db, o.attachmentDir);
  executionRoutes(app, o.db);
  sessionRoutes(app, o.db);
  migrationRoutes(app, o.db, o.snapshotRoot, o.attachmentDir);
  searchRoutes(app, o.db);
  settingsRoutes(app, o.db);
  eventRoutes(app, o.db);
  integrationRoutes(app, o.db);
  reportRoutes(app, o.db, o.attachmentDir);
  qualityRoutes(app, o.db);
  automationRoutes(app, o.db);
  mcpRoutes(app);
  notificationRoutes(app, o.db);
  viewRoutes(app, o.db);
  startRoutes(app, o.db);
  fieldRoutes(app, o.db);
  preconditionRoutes(app, o.db);
  stepLibraryRoutes(app, o.db);
  commentRoutes(app, o.db);
  assistRoutes(app, o.db);
  transferRoutes(app, o.db, o.attachmentDir);
  helpRoutes(app);

  app.get('/api/openapi.json', (c) => c.json(openApiDocument())); // Schnittstellenbeschreibung ist öffentlich (keine Daten)
  app.all('/api/*', (c) => c.json({ status: 404, detail: 'Unbekannter Endpunkt' }, 404));
  // Kein OAuth: Discovery-Anfragen (/.well-known/oauth-…) von MCP-Clients wie mcp-remote sauber mit 404 beantworten,
  // statt index.html auszuliefern – sonst scheitern sie bei falschem Token an „Unexpected token '<'“ statt an 401
  app.all('/.well-known/*', (c) => c.json({ status: 404, detail: 'Unbekannter Endpunkt' }, 404));
  // Dauerhafte Links (/go/…): relativ in die Oberfläche weiterleiten – sie löst das Ziel nach der Anmeldung auf
  app.get('/go/*', (c) => c.redirect(`/#${c.req.path}`, 302));

  if (o.webDist) {
    app.use('/*', serveStatic({ root: o.webDist }));
    // SPA-Fallback: unbekannte Pfade liefern index.html
    app.get('/*', serveStatic({ root: o.webDist, path: 'index.html' }));
  }
  return app;
}
