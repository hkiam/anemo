/** Modul help: Handbuch (docs/handbuch und ausgewählte Anleitungen) in der Anwendung lesbar machen. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import { notFound, route } from '../../platform/http.ts';

const DOCS = process.env.ANEMO_DOCS_DIR ?? new URL('../../../../docs', import.meta.url).pathname;
// Nur diese Anleitungen außerhalb des Handbuchs; ADRs und interne Planung bleiben im Repository
const EXTRA = ['anmeldung-sso', 'openproject', 'automation', 'mcp', 'agenten', 'ki-assistenz', 'ki-konzept', 'bdd-e2e-beispiel'];

async function pages() {
  const hb = (await readdir(join(DOCS, 'handbuch')).catch(() => [])).filter((f) => /^[0-9a-z-]+\.md$/.test(f)).map((f) => f.replace(/\.md$/, ''));
  return { handbuch: hb.sort(), anleitungen: EXTRA };
}

// Fehlerberichte der Oberfläche (Fehlergrenze): ins Server-Log, je Person höchstens 20 je Minute
const reported = new Map<string, number[]>();

export function helpRoutes(app: Hono): void {
  route(app, {
    method: 'post', path: '/api/client-errors', tag: 'Hilfe', summary: 'Absturz der Oberfläche melden (landet im Server-Log)', status: 204,
    body: z.object({ message: z.string().max(2000), stack: z.string().max(8000).optional(), component: z.string().max(4000).optional(), url: z.string().max(500).optional() }),
  }, async ({ body, actor }) => {
    const now = Date.now();
    const recent = (reported.get(actor) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= 20) return;
    reported.set(actor, [...recent, now]);
    console.error(`[Oberfläche] ${actor} ${body.url ?? ''}: ${body.message}\n${body.stack ?? ''}\n${body.component ?? ''}`.trim());
  });
  route(app, { method: 'get', path: '/api/help', tag: 'Hilfe', summary: 'Verfügbare Handbuchseiten' }, () => pages());
  route(app, { method: 'get', path: '/api/help/:page', tag: 'Hilfe', summary: 'Handbuchseite (Markdown)' }, async ({ params, c }) => {
    const page = params.page!;
    if (page !== 'README' && !/^[0-9a-z-]+$/.test(page)) throw notFound('Seite', page);
    const file = page === 'README' || /^\d\d-/.test(page) ? join(DOCS, 'handbuch', `${page}.md`) : EXTRA.includes(page) ? join(DOCS, `${page}.md`) : null;
    if (!file) throw notFound('Seite', page);
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) throw notFound('Seite', page);
    return c.text(text, 200, { 'content-type': 'text/markdown; charset=utf-8' });
  });
}
