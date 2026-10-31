/**
 * Modul references: Verweise auf Arbeitspakete in Issue-Trackern (ADR-0005).
 * Das QA-Modell kennt nur {@link ExternalReference}; Live-Zugriffe laufen über {@link IssueTrackerAdapter}.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { type Db, inTx } from '../../platform/db.ts';
import { badRequest, notFound, requireAccess, route, visibleProjectIdsOf } from '../../platform/http.ts';
import { EventTypes, recordEvent } from '../events/index.ts';
import { settingsEnv } from '../../platform/settings.ts';

export const OwnerType = z.enum(['TEST_CASE', 'TEST_CYCLE', 'TEST_EXECUTION', 'TEST_PLAN', 'EXPLORATORY_SESSION']);
export type OwnerType = z.infer<typeof OwnerType>;

export const Relation = z.enum(['REQUIREMENT', 'STORY', 'EPIC', 'DEFECT', 'SUBTASK', 'RELATED', 'AUTOMATION', 'DOCUMENTATION']);
export type Relation = z.infer<typeof Relation>;

/** Nur http(s)-Links – kein javascript:, data: o. Ä. (auch im Lieferpaket, das ohne CSP geöffnet wird). */
export const HttpUrl = z.string().trim().max(2000).regex(/^https?:\/\//i, 'Nur Links mit http:// oder https://');

/**
 * Schweregrad eines Fehlers aus Anemo-Sicht – bewusst andere Begriffe als die Testfallpriorität (Blocker, Kritisch …),
 * damit beides nicht verwechselt wird. Die Zuordnung zur Jira-Priorität legt die Administration je Projekt fest.
 */
export const SEVERITIES = ['Gravierend', 'Hoch', 'Mittel', 'Gering', 'Kosmetisch'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ReferenceInput = z.object({
  ownerType: OwnerType,
  ownerId: z.uuid(),
  /** z. B. "jira", "openproject", "gitlab", "jenkins" */
  provider: z.string().min(1),
  externalKey: z.string().min(1),
  relation: Relation,
  url: HttpUrl.nullish(),
  title: z.string().nullish(),
  status: z.string().nullish(),
  /** Fehler je Schritt: ID des Schritts der Ausführung (bei aufgerufenen Tests „aufrufId>schrittId“) */
  stepId: z.string().max(200).nullish(),
  /** Schweregrad eines Fehlers (aus Anemo-Sicht, unabhängig von der Priorität im Ticket) */
  severity: z.enum(SEVERITIES).nullish(),
});
/** Anlegen über die API: Anbieter optional (wird aus dem Schlüssel abgeleitet) */
export const ReferenceCreate = ReferenceInput.extend({ provider: z.string().min(1).optional() });
export type ReferenceInput = z.infer<typeof ReferenceInput>;

export interface ExternalReference extends ReferenceInput {
  id: string;
  createdAt: Date;
}

/** Konzeptionelle Schnittstelle je Issue-Tracker (Implementierungen ab Wave 4: Jira, OpenProject). */
export interface IssueTrackerAdapter {
  readonly provider: string;
  getWorkItem(key: string): Promise<{ key: string; title: string; status: string; url: string; type: string } | null>;
  searchWorkItems(query: string, limit?: number, project?: string | null): Promise<{ key: string; title: string; status: string; url: string }[]>;
  createDefect(input: { projectKey: string; title: string; description: string }): Promise<{ key: string; url: string }>;
}

/**
 * Bewertung eines Fehlerstatus aus Jira/OpenProject (Status-Snapshots der Verweise):
 * - rejected: abgelehnt, wird nicht behoben, kein Fehler, Duplikat → bekannter Fehler bzw. Restrisiko, kein Nachtest
 * - fixed: behoben/erledigt/geschlossen → Nachtest
 * - open: alles andere
 */
export type { DefectResolution } from '../../../../shared/status/resolution.ts';
export { defectResolution, isResolvedStatus } from '../../../../shared/status/resolution.ts';

/**
 * Adresse eines Tickets aus der Konfiguration (Jira: …/browse/KEY, OpenProject: …/work_packages/NR) – auch für von Hand
 * verknüpfte Schlüssel, die (noch) nicht abgeglichen sind. Ohne eingerichtete Anbindung: null.
 */
export function ticketUrl(provider: string, key: string, env: NodeJS.ProcessEnv = settingsEnv()): string | null {
  if (provider === 'jira' && /^[A-Z][A-Z0-9_]+-\d+$/i.test(key)) {
    const base = env.JIRA_BASE_URL ?? (env.JIRA_HOST ? `http://${env.JIRA_HOST.replace(/^https?:\/\//, '')}` : undefined);
    return base ? `${base.replace(/\/+$/, '')}/browse/${key.toUpperCase()}` : null;
  }
  if (provider === 'openproject' && /^(\d+|[A-Z][A-Z0-9_]*-\d+)$/.test(key) && env.OPENPROJECT_URL) return `${env.OPENPROJECT_URL.replace(/\/+$/, '')}/work_packages/${key}`;
  return null;
}
const withUrl = (rs: ExternalReference[]) => {
  const env = settingsEnv();
  return rs.map((r) => (r.url ? r : { ...r, url: ticketUrl(r.provider, r.externalKey, env) }));
};

/**
 * Anbieter eines eingegebenen Fehlerschlüssels: Adresse → freier Link, Nummer (#4711) → OpenProject, Schlüssel wie
 * PROJ-315 → über die Anbindungen entschieden (OpenProject 17 kennt Projektschlüssel, z. B. nach einer Jira-Migration);
 * ohne Entscheidung Jira. Die Anbindungen registrieren den Entscheider (keine Modulabhängigkeit references → integrations).
 */
type KeyResolver = (key: string) => Promise<'openproject' | 'jira' | null>;
let keyResolver: KeyResolver | null = null;
export function setTicketKeyResolver(fn: KeyResolver | null): void { keyResolver = fn; }
export async function providerForKey(key: string): Promise<'openproject' | 'jira' | 'url'> {
  const k = key.trim();
  if (/^https?:\/\//i.test(k)) return 'url';
  if (/^#?\d+$/.test(k)) return 'openproject';
  return (keyResolver ? await keyResolver(k.toUpperCase()).catch(() => null) : null) ?? 'jira';
}

/**
 * Legt einen Verweis an oder aktualisiert Titel/Status/URL eines bestehenden (idempotent). Fehler an Ausführungen können
 * an mehreren Schritten hängen (ein Eintrag je Schritt): Ohne Schritt wird ein vorhandener Eintrag desselben Tickets
 * aktualisiert statt ein zweiter angelegt; mit Schritt wird ein schrittloser Eintrag diesem Schritt zugeordnet.
 */
export async function linkReference(db: Db, input: ReferenceInput, actor: string): Promise<ExternalReference> {
  const url = input.url ?? ticketUrl(input.provider, input.externalKey);
  const step = input.stepId ?? null;
  // vorhandene Einträge desselben Tickets am selben Objekt
  const siblings = await db<ExternalReference[]>`
    select * from external_reference where owner_type = ${input.ownerType} and owner_id = ${input.ownerId} and provider = ${input.provider}
      and external_key = ${input.externalKey} and relation = ${input.relation} order by created_at`;
  // ohne Schritt: alle vorhandenen aktualisieren; mit Schritt: den dieses Schritts bzw. einen schrittlosen (wird zugeordnet)
  const target = step ? siblings.find((x) => x.stepId === step) ?? siblings.find((x) => !x.stepId) : siblings[0];
  if (target || (!step && siblings.length)) {
    const ids = step ? [target!.id] : siblings.map((x) => x.id);
    const rows = await db<ExternalReference[]>`
      update external_reference set url = coalesce(${url}, url), title = coalesce(${input.title ?? null}, title),
        status = coalesce(${input.status ?? null}, status), severity = coalesce(${input.severity ?? null}, severity),
        step_id = coalesce(${step}, step_id)
      where id = any(${ids}::uuid[]) returning *`;
    return rows.find((x) => x.id === target?.id) ?? rows[0]!;
  }
  const [r] = await db<(ExternalReference & { inserted: boolean })[]>`
    insert into external_reference(owner_type, owner_id, provider, external_key, relation, url, title, status, step_id, severity, created_by)
    values (${input.ownerType}, ${input.ownerId}, ${input.provider}, ${input.externalKey}, ${input.relation},
            ${url}, ${input.title ?? null}, ${input.status ?? null}, ${step}, ${input.severity ?? null}, ${actor})
    on conflict (owner_type, owner_id, provider, external_key, relation, (coalesce(step_id, ''))) do update
      set url = coalesce(excluded.url, external_reference.url),
          title = coalesce(excluded.title, external_reference.title),
          status = coalesce(excluded.status, external_reference.status),
          severity = coalesce(excluded.severity, external_reference.severity)
    returning *, (xmax = 0) as inserted`;
  const { inserted, ...ref } = r!;
  if (inserted) {
    await recordEvent(db, {
      type: EventTypes.ReferenceLinked, aggregateType: input.ownerType, aggregateId: input.ownerId, actor,
      payload: { provider: input.provider, externalKey: input.externalKey, relation: input.relation },
    });
  }
  return ref;
}

export async function listReferences(db: Db, ownerType: OwnerType, ownerId: string): Promise<ExternalReference[]> {
  return withUrl(await db<ExternalReference[]>`
    select * from external_reference where owner_type = ${ownerType} and owner_id = ${ownerId}
    order by relation, external_key`);
}

export async function listReferencesForOwners(db: Db, ownerType: OwnerType, ownerIds: string[]): Promise<ExternalReference[]> {
  if (ownerIds.length === 0) return [];
  return withUrl(await db<ExternalReference[]>`
    select * from external_reference where owner_type = ${ownerType} and owner_id = any(${ownerIds}::uuid[])
    order by relation, external_key`);
}

/** Rückwärtssuche: Welche QA-Objekte verweisen auf ein externes Arbeitspaket (z. B. Anforderung OP-4711)? */
export async function findByExternalKey(db: Db, provider: string, externalKey: string, visible: string[] | null = null): Promise<ExternalReference[]> {
  // Besitzer-IDs sind tabellenübergreifend eindeutig (uuidv7), daher genügt coalesce über alle Besitzertypen
  return db<ExternalReference[]>`
    select r.* from external_reference r where provider = ${provider} and external_key = ${externalKey}
    ${visible ? db`and coalesce(
        (select project_id from test_case where id = r.owner_id),
        (select c.project_id from test_execution e join test_cycle c on c.id = e.cycle_id where e.id = r.owner_id),
        (select project_id from test_cycle where id = r.owner_id),
        (select project_id from test_plan where id = r.owner_id),
        (select c.project_id from exploratory_session s join test_cycle c on c.id = s.cycle_id where s.id = r.owner_id)) = any(${visible}::uuid[])` : db``}
    order by owner_type`;
}

export async function removeReference(db: Db, id: string, actor: string): Promise<void> {
  const [r] = await db<ExternalReference[]>`delete from external_reference where id = ${id} returning *`;
  if (!r) throw notFound('Verweis', id);
  await recordEvent(db, {
    type: EventTypes.ReferenceRemoved, aggregateType: r.ownerType, aggregateId: r.ownerId, actor,
    payload: { provider: r.provider, externalKey: r.externalKey, relation: r.relation },
  });
}

/**
 * Prüft, ob ein Schritt (auch „aufrufId>schrittId“) zu einer Ausführung gehört. Das Modul execution hängt von
 * references ab; die Prüfung wird deshalb beim Start von einem Modul eingetragen, das beide kennt (integrations).
 */
type StepValidator = (db: Db, executionId: string, stepId: string) => Promise<boolean>;
let stepValidator: StepValidator | null = null;
export function setStepValidator(v: StepValidator): void {
  stepValidator = v;
}

/** Rechtestufe zum Anlegen/Ändern/Löschen von Verweisen je Besitzer */
export const levelFor = (ownerType: string): 'execute' | 'edit' => (['TEST_EXECUTION', 'EXPLORATORY_SESSION'].includes(ownerType) ? 'execute' : 'edit');

/**
 * Schlüsselformat je Anbieter (beim Verknüpfen von Hand): OpenProject nur Nummern (der Schlüssel landet im API-Pfad),
 * Jira PROJ-123, GitLab Repository!MR, Repository@Commit bzw. Repository#pipeline-ID. Andere Anbieter frei.
 */
export function keyProblem(provider: string, key: string): string | null {
  if (provider === 'openproject' && !/^(\d{1,12}|[A-Z][A-Z0-9_]{0,30}-\d{1,9})$/.test(key)) return 'OpenProject: Nummer (z. B. 1234) oder Schlüssel (z. B. PROJ-315) des Arbeitspakets';
  if (provider === 'jira' && !/^[A-Za-z][A-Za-z0-9_]*-\d{1,12}$/.test(key)) return 'Jira: Schlüssel im Format PROJ-123';
  if (provider === 'gitlab' && !/^[\w.-]+(?:\/[\w.-]+)*(?:![0-9]{1,12}|@[0-9a-fA-F]{7,40}|#pipeline-\d{1,15})$/.test(key)) return 'GitLab: gruppe/repo!123 (Merge-Request) bzw. gruppe/repo@SHA (Commit)';
  return null;
}

// ---- Freie Links (URL mit Kurznamen) ----

/** Einstellungen für freie Links: eingeschaltet? Welche Domains? */
export function urlLinkSettings(env: NodeJS.ProcessEnv = settingsEnv()): { enabled: boolean; domains: string[] } {
  return {
    enabled: env.ANEMO_URL_LINKS === 'true',
    domains: (env.ANEMO_URL_LINK_DOMAINS ?? '').split(/[,;\s]+/).map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean),
  };
}
export const URL_LINK_STATUSES = ['offen', 'behoben', 'abgelehnt'] as const;

/** Prüft einen freien Link; liefert die normalisierte Adresse oder wirft 400. */
export function checkUrlLink(url: string, title: string | null | undefined): string {
  const s = urlLinkSettings();
  if (!s.enabled) throw badRequest('Freie Links sind ausgeschaltet (Administration → Anbindungen → Übersicht → Freie Links).');
  let u: URL;
  try { u = new URL(url.trim()); } catch { throw badRequest('Ungültige Adresse – vollständig mit https:// angeben.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest('Nur Adressen mit http:// oder https://');
  if (u.username || u.password) throw badRequest('Adressen mit Zugangsdaten sind nicht erlaubt.');
  const host = u.hostname.toLowerCase();
  if (s.domains.length && !s.domains.some((d) => (d.startsWith('*.') ? host.endsWith(d.slice(1)) || host === d.slice(2) : host === d))) {
    throw badRequest(`Domain „${host}“ ist nicht freigegeben (erlaubt: ${s.domains.join(', ')}).`);
  }
  if (!title?.trim()) throw badRequest('Kurzname fehlt – er wird anstelle der Adresse angezeigt.');
  if (title.trim().length > 80) throw badRequest('Kurzname: höchstens 80 Zeichen.');
  const norm = u.toString();
  if (norm.length > 2000) throw badRequest('Adresse zu lang (höchstens 2000 Zeichen).');
  return norm;
}

/**
 * Verweis aus einer Eingabe von außen (Oberfläche, API, Agent): freie Links nach den Regeln für freie Links; bei Jira und
 * OpenProject wird die Adresse aus dem Schlüssel abgeleitet (eine mitgeschickte zählt nicht); bei anderen Anbietern
 * (GitLab, Jenkins …) nur http(s) ohne Zugangsdaten und – falls festgelegt – aus den freigegebenen Domains.
 */
export function clientReference<T extends { provider: string; externalKey: string; title?: string | null | undefined; relation: string; status?: string | null | undefined; url?: string | null | undefined }>(input: T): T {
  if (input.provider === 'url') return urlReference(input);
  if (input.provider === 'jira' || input.provider === 'openproject' || !input.url) return { ...input, url: null };
  let u: URL;
  try { u = new URL(input.url.trim()); } catch { throw badRequest('Ungültige Adresse – vollständig mit https:// angeben.'); }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) throw badRequest('Nur Adressen mit http:// oder https:// ohne Zugangsdaten');
  const { domains } = urlLinkSettings();
  const host = u.hostname.toLowerCase();
  if (domains.length && !domains.some((d) => (d.startsWith('*.') ? host.endsWith(d.slice(1)) || host === d.slice(2) : host === d))) {
    throw badRequest(`Domain „${host}“ ist nicht freigegeben (erlaubt: ${domains.join(', ')}).`);
  }
  return { ...input, url: u.toString() };
}

/** Freien Link als Verweis aufbereiten (Schlüssel = Adresse, Titel = Kurzname, Fehler starten „offen“). */
export function urlReference<T extends { externalKey: string; title?: string | null | undefined; relation: string; status?: string | null | undefined; url?: string | null | undefined }>(input: T): T {
  const url = checkUrlLink(input.externalKey, input.title);
  return { ...input, externalKey: url, url, title: input.title!.trim(), status: input.status ?? (input.relation === 'DEFECT' ? 'offen' : null) };
}

export function referenceRoutes(app: Hono, db: Db): void {
  const tag = 'Verweise';
  route(app, {
    method: 'get', path: '/api/references', access: { level: 'read', project: ({ query }) => ({ kind: 'owner', ...(query as { ownerType: string; ownerId: string }) }) }, tag, summary: 'Verweise eines QA-Objekts',
    query: z.object({ ownerType: OwnerType, ownerId: z.uuid() }),
  }, ({ query }) => listReferences(db, query.ownerType, query.ownerId));
  route(app, {
    method: 'get', path: '/api/references/by-key/:provider/:externalKey', tag,
    summary: 'Rückwärtssuche: QA-Objekte zu einem externen Arbeitspaket',
  }, ({ params, c }) => findByExternalKey(db, params.provider!, params.externalKey!, visibleProjectIdsOf(c)));
  route(app, { method: 'post', path: '/api/references', access: ({ body }) => { const b = body as { ownerType: string; ownerId: string }; return { level: levelFor(b.ownerType), project: () => ({ kind: 'owner', ownerType: b.ownerType, ownerId: b.ownerId }) }; }, tag, summary: 'Verweis anlegen (ohne provider: Nummer → OpenProject, Schlüssel wie PROJ-315 nach Anbindungen, sonst Jira)', body: ReferenceCreate, status: 201 },
    async ({ body: input, actor }) => {
      // ohne Anbieter: wie bei Ergebnissen (Nummer/Schlüssel nach Anbindungen, z. B. PROJ-315 → OpenProject 17)
      const provider = input.provider ?? await providerForKey(input.externalKey);
      const raw = input.externalKey.trim();
      const externalKey = provider === 'openproject' ? raw.replace(/^#/, '').toUpperCase() : input.provider ? input.externalKey : raw.replace(/^#(?=\d)/, '');
      let body = { ...input, provider, externalKey };
      body = clientReference(body);
      const problem = keyProblem(body.provider, body.externalKey);
      if (problem) throw badRequest(problem);
      if (body.stepId) {
        if (body.ownerType !== 'TEST_EXECUTION') throw badRequest('Ein Schrittbezug ist nur bei Verweisen an Ausführungen möglich');
        if (!stepValidator || !(await stepValidator(db, body.ownerId, body.stepId))) throw badRequest('Schritt gehört nicht zu dieser Ausführung');
      }
      return inTx(db, (tx) => linkReference(tx, body, actor));
    });
  /** Ändern/Löschen mit derselben Stufe wie das Anlegen (Testfall/Testplan/Zyklus: Pflegen; Ausführung/Sitzung: Ausführen). */
  const sameLevelAsCreate = async (c: Parameters<typeof requireAccess>[0], id: string) => {
    const [r] = await db<{ ownerType: string; ownerId: string }[]>`select owner_type, owner_id from external_reference where id = ${id}`;
    if (!r) throw notFound('Verweis', id);
    if (levelFor(r.ownerType) !== 'execute') await requireAccess(c, { level: levelFor(r.ownerType), project: () => ({ kind: 'owner', ownerType: r.ownerType, ownerId: r.ownerId }) });
    return r;
  };
  route(app, {
    method: 'patch', path: '/api/references/:id', access: { level: 'execute', project: ({ params }) => ({ kind: 'reference', id: params.id! }) }, tag,
    summary: 'Schweregrad bzw. Schrittbezug ändern; bei freien Links auch Kurzname und Status (offen/behoben/abgelehnt) – Rechtestufe wie beim Anlegen', status: 204,
    body: z.object({
      severity: z.enum(SEVERITIES).nullable().optional(), stepId: z.string().max(200).nullable().optional(),
      title: z.string().trim().min(1).max(80).optional(), status: z.enum(URL_LINK_STATUSES).optional(),
    }),
  }, async ({ params, body, c }) => {
    const r = await sameLevelAsCreate(c, params.id!);
    if (body.title !== undefined || body.status !== undefined) {
      // Titel/Status gehören dem Fremdsystem – von Hand nur bei freien Links (ohne Abgleich)
      const [p] = await db<{ provider: string }[]>`select provider from external_reference where id = ${params.id!}`;
      if (p?.provider !== 'url') throw badRequest('Kurzname und Status lassen sich nur bei freien Links ändern – Tickets werden mit ihrem System abgeglichen.');
      await db`update external_reference set title = ${body.title === undefined ? db`title` : body.title}, status = ${body.status === undefined ? db`status` : body.status} where id = ${params.id!}`;
    }
    if (body.stepId) {
      if (r.ownerType !== 'TEST_EXECUTION') throw badRequest('Ein Schrittbezug ist nur bei Verweisen an Ausführungen möglich');
      if (!stepValidator || !(await stepValidator(db, r.ownerId, body.stepId))) throw badRequest('Schritt gehört nicht zu dieser Ausführung');
    }
    try {
      await db`update external_reference set step_id = ${body.stepId === undefined ? db`step_id` : body.stepId} where id = ${params.id!}`;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw badRequest('Dieses Ticket ist an diesem Schritt schon verknüpft');
      throw e;
    }
    // Schweregrad gehört zum Ticket: für alle Einträge desselben Tickets am selben Objekt (z. B. mehrere Schritte)
    if (body.severity !== undefined) {
      await db`update external_reference x set severity = ${body.severity} from external_reference r
        where r.id = ${params.id!} and x.owner_type = r.owner_type and x.owner_id = r.owner_id and x.provider = r.provider
          and x.external_key = r.external_key and x.relation = r.relation`;
    }
  });
  route(app, { method: 'get', path: '/api/link-settings', tag, summary: 'Sind freie Links (URL mit Kurznamen) erlaubt, für welche Domains?', access: 'authenticated' },
    async () => urlLinkSettings());
  route(app, { method: 'delete', path: '/api/references/:id', access: { level: 'execute', project: ({ params }) => ({ kind: 'reference', id: params.id! }) }, tag, summary: 'Verweis entfernen (Rechtestufe wie beim Anlegen)', status: 204 },
    async ({ params, actor, c }) => {
      await sameLevelAsCreate(c, params.id!);
      await inTx(db, (tx) => removeReference(tx, params.id!, actor));
    });
}
