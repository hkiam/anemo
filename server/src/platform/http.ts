import { versionInfo } from './version.ts';
import type { Context, Hono } from 'hono';
import { z } from 'zod';

export class HttpError extends Error {
  readonly status: number;
  /** Zusätzliche, maschinenlesbare Angaben für die Oberfläche (z. B. Position eines Abfragefehlers) */
  readonly extra: Record<string, unknown> | undefined;

  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const notFound = (what: string, id: unknown) => new HttpError(404, `${what} nicht gefunden: ${String(id)}`);
export const conflict = (message: string) => new HttpError(409, message);
export const badRequest = (message: string) => new HttpError(400, message);

/** Angemeldeter Benutzer (vom Auth-Modul gesetzt); im Modus ohne Anmeldung (Tests) aus dem Header. */
export function actorOf(c: Context): string {
  return (c.get('actor' as never) as string | undefined) ?? (c.req.header('x-anemo-user')?.trim() || 'anonymous');
}

/**
 * Zugriffsstufe einer Route. Ohne Angabe gilt 'authenticated'. Projektbezogene Stufen nennen über
 * {@code project} das Objekt, zu dem die Route gehört; das Auth-Modul ordnet es einem Projekt zu und prüft.
 */
export type Access =
  | 'public'
  | 'authenticated'
  | 'admin'
  | { level: 'read' | 'execute' | 'edit' | 'manage'; project: (input: RouteInput<any, any>) => unknown };

/** IDs der Projekte, die der aktuelle Benutzer sehen darf; null = alle (Systemadmin bzw. ohne Anmeldung). */
export function visibleProjectIdsOf(c: Context): string[] | null {
  return (c.get('visibleProjectIds' as never) as string[] | null | undefined) ?? null;
}

/** Prüffunktion; das Auth-Modul legt sie je Anfrage im Kontext ab (ohne sie: keine Prüfung). */
export type AccessControl = (c: Context, access: Access, input: RouteInput<any, any>) => Promise<void>;
const accessControlOf = (c: Context) => c.get('accessControl' as never) as AccessControl | undefined;

/** Für Routen außerhalb von {@link route} (z. B. Datei-Downloads). */
export async function requireAccess(c: Context, access: Access, input?: Partial<RouteInput<any, any>>): Promise<void> {
  const check = accessControlOf(c);
  if (check) await check(c, access, { body: undefined, query: undefined, params: c.req.param() as Record<string, string>, actor: actorOf(c), c, ...input });
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteSpec<B extends z.ZodType, Q extends z.ZodType> {
  method: Method;
  /** Hono-Pfad, z. B. /api/test-cases/:id */
  path: string;
  tag: string;
  summary: string;
  body?: B;
  query?: Q;
  status?: 200 | 201 | 204;
  /** Zugriffsstufe; als Funktion, wenn sie von der Anfrage abhängt */
  access?: Access | ((input: RouteInput<any, any>) => Access);
}

export interface RouteInput<B, Q> {
  body: B;
  query: Q;
  params: Record<string, string>;
  actor: string;
  c: Context;
}

/** Marker: Die Zugriffsregel braucht den Body (siehe {@link route}). */
const NEEDS_BODY = Symbol('needsBody');

const docs: { spec: RouteSpec<z.ZodType, z.ZodType> }[] = [];

/**
 * Registriert eine JSON-Route: validiert Body/Query mit zod, liefert das Ergebnis als JSON
 * und nimmt die Route in die OpenAPI-Beschreibung auf.
 */
export function route<B extends z.ZodType = z.ZodUnknown, Q extends z.ZodType = z.ZodUnknown>(
  app: Hono,
  spec: RouteSpec<B, Q>,
  handler: (input: RouteInput<z.infer<B>, z.infer<Q>>) => Promise<unknown>,
): void {
  docs.push({ spec: spec as RouteSpec<z.ZodType, z.ZodType> });
  app.on(spec.method.toUpperCase(), spec.path, async (c) => {
    // Reihenfolge (Sicherheitsreview Teil 2, Befund 7): zuerst Anmeldung und – soweit sie nicht vom Body
    // abhängt – Zugriffsstufe prüfen, erst dann den Body lesen und validieren. Ohne Anmeldung gibt es so 401
    // statt einer Schemabeschreibung, und große Bodies werden nicht für Unbekannte gelesen.
    const check = accessControlOf(c);
    const base = { params: c.req.param() as Record<string, string>, actor: actorOf(c), c };
    if (check && spec.access !== 'public') await check(c, 'authenticated', { ...base, body: undefined, query: undefined });
    const query = spec.query ? spec.query.parse(c.req.query()) : undefined;
    let bodyRead = false, body: unknown;
    const readBody = async () => {
      if (!bodyRead) { body = spec.body ? spec.body.parse(await c.req.json().catch(() => ({}))) : undefined; bodyRead = true; }
    };
    const accessCheck = async (input: RouteInput<any, any>) => {
      if (!check) return;
      const access = typeof spec.access === 'function' ? spec.access(input) : spec.access;
      await check(c, access ?? 'authenticated', input);
    };
    if (check && spec.body) {
      // Probelauf ohne Body: Greift die Zugriffsregel auf den Body zu, wird er zuerst gelesen und dann geprüft.
      const probe = { ...base, query, get body(): never { throw NEEDS_BODY; } } as RouteInput<any, any>;
      let needsBody = false;
      try { await accessCheck(probe); } catch (e) { if (e === NEEDS_BODY) needsBody = true; else throw e; }
      await readBody();
      if (needsBody) await accessCheck({ ...base, query, body });
    } else {
      await readBody();
      await accessCheck({ ...base, query, body });
    }
    const input = {
      body: body as z.infer<B>,
      query: query as z.infer<Q>,
      ...base,
    };
    const result = await handler(input);
    if (result instanceof Response) return result;
    if (spec.status === 204) return c.body(null, 204);
    return c.json(result ?? null, spec.status ?? 200);
  });
}

export function installErrorHandler(app: Hono): void {
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ status: err.status, detail: err.message, ...(err.extra ?? {}) }, err.status as 400);
    }
    if (err instanceof z.ZodError) {
      return c.json({ status: 400, detail: 'Ungültige Eingabe', issues: err.issues }, 400);
    }
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      return c.json({ status: 409, detail: (err as Error).message }, 409);
    }
    if (code === '57014') {
      // statement_timeout (siehe db.ts): verständlich melden statt „Interner Fehler“
      return c.json({ status: 503, detail: 'Die Abfrage hat zu lange gedauert und wurde abgebrochen. Bitte die Auswahl eingrenzen (z. B. weniger Bedingungen oder ein Projekt).' }, 503);
    }
    if (code === '22P02') {
      return c.json({ status: 400, detail: (err as Error).message }, 400);
    }
    console.error(err);
    return c.json({ status: 500, detail: 'Interner Fehler' }, 500);
  });
}

/** Ein Endpunkt der API mit Rechtestufe (für den MCP-Zugang zu allen Funktionen, siehe modules/mcp). */
export interface ApiOperation {
  method: string; path: string; tag: string; summary: string;
  /** public | authenticated | admin | read | execute | edit | manage | dynamic (Stufe hängt von der Anfrage ab) */
  access: string;
  query?: unknown; body?: unknown;
}

export function apiOperations(): ApiOperation[] {
  return docs.map(({ spec }) => ({
    method: spec.method.toUpperCase(), path: spec.path, tag: spec.tag, summary: spec.summary,
    access: typeof spec.access === 'function' ? 'dynamic' : typeof spec.access === 'object' ? spec.access.level : spec.access ?? 'authenticated',
    ...(spec.query ? { query: z.toJSONSchema(spec.query, { io: 'input', unrepresentable: 'any' }) } : {}),
    ...(spec.body ? { body: z.toJSONSchema(spec.body, { io: 'input', unrepresentable: 'any' }) } : {}),
  }));
}

export function openApiDocument(): unknown {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const { spec } of docs) {
    const path = spec.path.replace(/:(\w+)/g, '{$1}');
    const params = [...spec.path.matchAll(/:(\w+)/g)].map((m) => ({
      name: m[1], in: 'path', required: true, schema: { type: 'string' },
    }));
    if (spec.query) {
      const schema = z.toJSONSchema(spec.query, { io: 'input', unrepresentable: 'any' }) as {
        properties?: Record<string, unknown>; required?: string[];
      };
      for (const [name, s] of Object.entries(schema.properties ?? {})) {
        params.push({ name, in: 'query', required: schema.required?.includes(name) ?? false, schema: s as { type: string } });
      }
    }
    (paths[path] ??= {})[spec.method] = {
      tags: [spec.tag],
      summary: spec.summary,
      parameters: params,
      ...(spec.body && {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: z.toJSONSchema(spec.body, { io: 'input', unrepresentable: 'any' }) } },
        },
      }),
      responses: { [String(spec.status ?? 200)]: { description: 'OK' } },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Anemo API', version: versionInfo().version, description: 'Agentic QA Platform – REST API' },
    paths,
  };
}
