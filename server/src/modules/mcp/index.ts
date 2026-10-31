/**
 * Modul mcp: Model-Context-Protocol-Server (Streamable HTTP, JSON-Antworten) für KI-Agenten (Roadmap D2, ADR-0018).
 * Jedes Werkzeug ruft die reguläre, rechtegeprüfte API mit der Identität des Aufrufers auf – ein Agent sieht und
 * darf nie mehr als der Benutzer hinter seinem Token. Projekte mit gesperrten externen Diensten sind unsichtbar.
 */
import { checkSteps } from '../../../../shared/steps/groups.ts';
import type { Context, Hono } from 'hono';
import { apiOperations, type ApiOperation, HttpError, route } from '../../platform/http.ts';
import { settingsEnv } from '../../platform/settings.ts';
import { versionInfo } from '../../platform/version.ts';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TEXT = 60_000;

type Json = Record<string, unknown>;
interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  readOnly: boolean;
  run: (args: Json, call: ApiCall) => Promise<unknown>;
}
type RawResult = { status: number; type: string; text: string };
type ApiCall = ((method: string, path: string, body?: unknown) => Promise<unknown>) & { raw: (method: string, path: string, body?: unknown) => Promise<RawResult> };

const str = (description: string) => ({ type: 'string', description });
const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const q = (params: Record<string, unknown>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};
const enc = encodeURIComponent;

/** Schritte für Werkzeuge: { action, data, expected } bzw. { section } für einen Abschnitt; vorhandene id bleibt. */
const STEPS_SCHEMA = {
  type: 'array', description: 'Schritte: {action, data?, expected?, id?} oder Abschnitt {section, note?}',
  items: { type: 'object', properties: { id: { type: 'string' }, action: { type: 'string' }, data: { type: 'string' }, expected: { type: 'string' }, section: { type: 'string' }, note: { type: 'string' } } },
};
const TOOLS: Tool[] = [
  {
    name: 'search', readOnly: true,
    description: 'Übergreifende Suche über Testfälle, Zyklen, Testpläne, Ausführungskommentare, Verweise (z. B. Jira-/OpenProject-Schlüssel) und Anhänge.',
    inputSchema: obj({ query: str('Suchtext, Testfallschlüssel (DEMO-T12) oder Ticketschlüssel'), project: str('optional: Projektschlüssel'),
      types: str('optional, Komma-getrennt: testcase,cycle,plan,execution,reference,attachment') }, ['query']),
    run: (a, api) => api('GET', `/api/search${q({ q: a.query, project: a.project, types: a.types, limit: 15 })}`),
  },
  { name: 'list_projects', readOnly: true, description: 'Projekte, auf die der Benutzer Zugriff hat.', inputSchema: obj({}),
    run: async (_a, api) => ((await api('GET', '/api/projects')) as Json[]).map((p) => ({ key: p.key, name: p.name })) },
  {
    name: 'list_test_cases', readOnly: true, description: 'Testfälle eines Projekts suchen (Volltext, Status, Label).',
    inputSchema: obj({ project: str('Projektschlüssel'), query: str('optional: Suchtext'), status: str('optional: Status-Code'), label: str('optional: Label'),
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }, ['project']),
    run: (a, api) => api('GET', `/api/projects/${enc(String(a.project))}/test-cases${q({ q: a.query, status: a.status, label: a.label, limit: a.limit ?? 50 })}`),
  },
  {
    name: 'get_test_case', readOnly: true, description: 'Testfall mit aktueller (oder angegebener) Version: Ziel, Vorbedingungen, Schritte bzw. Gherkin. Texte sind Jira-Wiki-Markup.',
    inputSchema: obj({ key: str('Testfallschlüssel (DEMO-T12) oder Jira-Altschlüssel'), version: { type: 'integer', description: 'optional: Versionsnummer' } }, ['key']),
    run: async (a, api) => {
      const tc = (await api('GET', `/api/test-cases/${enc(String(a.key))}`)) as Json;
      return a.version ? { ...tc, version: await api('GET', `/api/test-cases/${enc(String(a.key))}/versions/${a.version}`) } : tc;
    },
  },
  {
    name: 'list_plans', readOnly: true, description: 'Testpläne/Releases eines Projekts mit Fortschritt.',
    inputSchema: obj({ project: str('Projektschlüssel') }, ['project']),
    run: (a, api) => api('GET', `/api/projects/${enc(String(a.project))}/plans`),
  },
  {
    name: 'list_cycles', readOnly: true, description: 'Testzyklen eines Projekts filtern (Text, Status offen/fehlgeschlagen/fertig, Testplan).',
    inputSchema: obj({ project: str('Projektschlüssel'), query: str('optional: Text (Name, Build, Umgebung)'),
      state: { type: 'string', enum: ['open', 'failed', 'done'] }, planId: str('optional: Testplan-ID') }, ['project']),
    run: (a, api) => api('GET', `/api/projects/${enc(String(a.project))}/cycles${q({ q: a.query, state: a.state, planId: a.planId, limit: 50 })}`),
  },
  {
    name: 'get_cycle_results', readOnly: true, description: 'Ausführungen eines Zyklus mit Status, Zuständigen und Kennzahlen.',
    inputSchema: obj({ cycleId: str('Zyklus-ID'), status: str('optional, Komma-getrennt: z. B. FAIL,BLOCKED') }, ['cycleId']),
    run: (a, api) => api('GET', `/api/cycles/${enc(String(a.cycleId))}/executions${q({ status: a.status, limit: 500 })}`),
  },
  {
    name: 'get_execution', readOnly: true, description: 'Eine Ausführung mit Testfallversion, Schritten (mit IDs und Nummern), Schrittergebnissen, Kommentar und Fehlern.',
    inputSchema: obj({ executionId: str('Ausführungs-ID') }, ['executionId']),
    run: (a, api) => api('GET', `/api/executions/${enc(String(a.executionId))}`),
  },
  {
    name: 'find_tests_for_issue', readOnly: true, description: 'Welche Testfälle, Zyklen und Ausführungen verweisen auf ein Ticket (Anforderung, Fehler)?',
    inputSchema: obj({ provider: { type: 'string', enum: ['jira', 'openproject', 'automation'] }, key: str('Ticketschlüssel, z. B. DEMO-1234') }, ['provider', 'key']),
    run: (a, api) => api('GET', `/api/references/by-key/${enc(String(a.provider))}/${enc(String(a.key))}`),
  },
  {
    name: 'release_cockpit', readOnly: true, description: 'Release-Cockpit eines Testplans: Freigabeempfehlung mit Begründung, Stand, offene Fehler, geänderte aber ungetestete Testfälle.',
    inputSchema: obj({ planId: str('Testplan-ID') }, ['planId']),
    run: (a, api) => api('GET', `/api/plans/${enc(String(a.planId))}/cockpit`),
  },
  {
    name: 'test_health', readOnly: true, description: 'Test-Health eines Projekts: nie ausgeführt, wackelnd, immer bestanden, ohne erwartetes Ergebnis, Duplikate …',
    inputSchema: obj({ project: str('Projektschlüssel') }, ['project']),
    run: (a, api) => api('GET', `/api/projects/${enc(String(a.project))}/health`),
  },
  {
    name: 'create_cycle', readOnly: false, description: 'Testzyklus anlegen und optional Testfälle (aktuelle Version) aufnehmen.',
    inputSchema: obj({ project: str('Projektschlüssel'), name: str('Name des Zyklus'), build: str('optional'), release: str('optional'),
      environment: str('optional'), planId: str('optional: Testplan-ID'), testCaseKeys: { type: 'array', items: { type: 'string' }, description: 'optional: Testfallschlüssel' } }, ['project', 'name']),
    run: async (a, api) => {
      const c = (await api('POST', `/api/projects/${enc(String(a.project))}/cycles`, {
        name: a.name, build: a.build ?? null, release: a.release ?? null, environment: a.environment ?? null, planId: a.planId ?? null,
      })) as Json;
      const keys = (a.testCaseKeys as string[] | undefined) ?? [];
      const added = keys.length ? await api('POST', `/api/cycles/${c.id}/executions`, { testCaseIds: keys }) : { added: 0 };
      return { cycle: { id: c.id, name: c.name }, ...(added as Json) };
    },
  },
  {
    name: 'record_result', readOnly: false,
    description: 'Ergebnis einer Ausführung erfassen. Status-Codes siehe Ausführungsstatus (z. B. PASS, FAIL, BLOCKED, WIP, NOT_EXECUTED). Schritte über ihre Nummer (1-basiert). '
      + 'Der Gesamtstatus muss zu den Schrittergebnissen passen (schlechtestes zählt); eine bewusste Abweichung nur mit overrideReason.',
    inputSchema: obj({ executionId: str('Ausführungs-ID'), status: str('Gesamtstatus, z. B. PASS'), comment: str('optional: Befund (Jira-Wiki-Markup)'),
      stepResults: { type: 'array', items: obj({ step: { type: 'integer', minimum: 1 }, status: { type: 'string' }, comment: { type: 'string' } }, ['step', 'status']) },
      defectKeys: { type: 'array', items: { type: 'string' }, description: 'optional: Fehlerschlüssel verknüpfen (Jira-Schlüssel wie DEMO-123 oder OpenProject-Nummer wie 4711)' },
      overrideReason: str('optional: Begründung, wenn der Gesamtstatus bewusst von der Ableitung aus den Schritten abweicht') }, ['executionId', 'status']),
    run: async (a, api) => {
      const e = (await api('GET', `/api/executions/${enc(String(a.executionId))}`)) as { steps: { id: string; kind?: string | null }[]; stepResults: { stepId: string }[] };
      const steps = (a.stepResults as { step: number; status: string; comment?: string }[] | undefined) ?? [];
      // Schrittnummern zählen nur Prüfschritte (Abschnitte haben kein Ergebnis)
      const checks = checkSteps(e.steps);
      const mapped = steps.map((s) => {
        const st = checks[s.step - 1];
        if (!st) throw new Error(`Schritt ${s.step} gibt es nicht (Testfall hat ${checks.length} Schritte)`);
        return { stepId: st.id, status: s.status, comment: s.comment };
      });
      const keep = e.stepResults.filter((r) => !mapped.some((m) => m.stepId === r.stepId));
      const r = (await api('POST', `/api/executions/${enc(String(a.executionId))}/result`, {
        status: a.status, comment: a.comment ?? null, stepResults: [...keep, ...mapped],
        // Anbieter leitet die Ergebnis-API aus dem Schlüssel ab (wie Excel-Rundlauf) – nicht mehr fest „jira“
        defects: ((a.defectKeys as string[] | undefined) ?? []).map((k) => ({ key: k })),
        overrideReason: a.overrideReason ?? null,
      })) as Json;
      return { id: r.id, status: r.status, executedBy: r.executedBy, executedAt: r.executedAt };
    },
  },
  {
    name: 'my_assignments', readOnly: true, description: 'Mir (dem Token-Benutzer) zugewiesene offene Ausführungen eines Projekts – die Arbeitsliste eines Agenten.',
    inputSchema: obj({ project: str('Projektschlüssel') }, ['project']),
    run: (a, api) => api('GET', `/api/projects/${enc(String(a.project))}/executions${q({ assignee: 'me', status: 'NOT_EXECUTED,WIP', limit: 100 })}`),
  },
  {
    name: 'claim_next', readOnly: false, description: 'Nächste offene, nicht zugewiesene Ausführung(en) eines Zyklus übernehmen; liefert die IDs.',
    inputSchema: obj({ cycleId: str('Zyklus-ID'), count: { type: 'integer', minimum: 1, maximum: 10, default: 1 } }, ['cycleId']),
    run: (a, api) => api('POST', `/api/cycles/${enc(String(a.cycleId))}/claim`, { count: a.count ?? 1 }),
  },
  {
    name: 'attach_evidence', readOnly: false, description: 'Evidenz (z. B. Screenshot als Base64-PNG, Log-Datei) an eine Ausführung hängen. Im Kommentar mit !dateiname! einbetten.',
    inputSchema: obj({ executionId: str('Ausführungs-ID'), fileName: str('Dateiname, z. B. schritt-2.png'), contentBase64: str('Dateiinhalt Base64'),
      contentType: str('z. B. image/png, text/plain') }, ['executionId', 'fileName', 'contentBase64']),
    run: (a, api) => api('POST', '/api/attachments/base64', { ownerType: 'TEST_EXECUTION', ownerId: a.executionId, fileName: a.fileName, contentBase64: a.contentBase64, contentType: a.contentType ?? null }),
  },
  {
    name: 'escalate', readOnly: false, description: 'An einen Menschen übergeben, wenn das Ergebnis nicht sicher beurteilbar ist (z. B. fehlende Voraussetzung, mehrdeutige Erwartung).',
    inputSchema: obj({ executionId: str('Ausführungs-ID'), reason: str('Begründung') }, ['executionId', 'reason']),
    run: (a, api) => api('POST', `/api/executions/${enc(String(a.executionId))}/escalate`, { reason: a.reason }),
  },
  {
    name: 'prepare_defect', readOnly: true, description: 'Fehlermeldung zu einer Ausführung aus der Vorlage vorbereiten (Titel/Beschreibung mit Schritten, Umgebung, Ist/Soll, Rückverweis). Speichert nichts.',
    inputSchema: obj({ executionId: str('Ausführungs-ID'), step: { type: 'integer', minimum: 1, description: 'optional: betroffener Schritt' } }, ['executionId']),
    run: async (a, api) => {
      let stepId: string | undefined;
      if (a.step) stepId = checkSteps(((await api('GET', `/api/executions/${enc(String(a.executionId))}`)) as { steps: { id: string; kind?: string | null }[] }).steps)[Number(a.step) - 1]?.id;
      return api('POST', `/api/executions/${enc(String(a.executionId))}/defect-draft`, stepId ? { stepId } : {});
    },
  },

  // ---- Projekte, Testfälle, Planung (Fachwerkzeuge für das Häufige) ----
  {
    name: 'create_project', readOnly: false, description: 'Projekt anlegen (nur Systemadministration).',
    inputSchema: obj({ key: str('Projektschlüssel: Großbuchstaben/Ziffern, 2–20 Zeichen, z. B. SHOP'), name: str('Name'), description: str('optional: Beschreibung') }, ['key', 'name']),
    run: (a, api) => api('POST', '/api/projects', { key: a.key, name: a.name, description: a.description ?? null }),
  },
  {
    name: 'create_test_case', readOnly: false,
    description: 'Testfall anlegen. Schritte als Liste; ein Eintrag mit „section“ statt „action“ ist ein Abschnitt (Gliederung, ohne Ergebnis). Texte im Jira-Wiki-Markup.',
    inputSchema: obj({
      project: str('Projektschlüssel'), title: str('Titel'), objective: str('optional: Ziel/Beschreibung'), preconditions: str('optional: Vorbedingungen'),
      testData: str('optional: Testdaten'), priority: str('optional: Priorität'), labels: { type: 'array', items: { type: 'string' } },
      components: { type: 'array', items: { type: 'string' } }, folderId: str('optional: Ordner-ID'),
      format: { type: 'string', enum: ['CLASSIC', 'GHERKIN', 'PLAIN'], description: 'Standard CLASSIC' }, gherkin: str('bei GHERKIN: Szenario-Text'), plainText: str('bei PLAIN: Testanweisung'),
      steps: STEPS_SCHEMA, changeNote: str('optional: Änderungsnotiz'),
    }, ['project', 'title']),
    run: async (a, api) => {
      const content = { title: a.title, format: a.format ?? 'CLASSIC', objective: a.objective ?? null, preconditions: a.preconditions ?? null, testData: a.testData ?? null,
        priority: a.priority ?? null, labels: a.labels ?? [], components: a.components ?? [], gherkin: a.gherkin ?? null, plainText: a.plainText ?? null,
        steps: toSteps(a.steps), sections: [], customFields: {} };
      const r = (await api('POST', `/api/projects/${enc(String(a.project))}/test-cases`, { content, folderId: a.folderId ?? null, changeNote: a.changeNote ?? null })) as Json;
      return { key: r.key, id: r.id, version: (r.version as Json | undefined)?.versionNo ?? 1 };
    },
  },
  {
    name: 'update_test_case', readOnly: false,
    description: 'Inhalt eines Testfalls ändern (neue Version). Nur die angegebenen Felder ändern sich; „steps“ ersetzt alle Schritte (vorhandene Schritte mit ihrer id übernehmen, damit Ergebnisse zuordenbar bleiben).',
    inputSchema: obj({
      key: str('Testfallschlüssel'), title: str('optional'), objective: str('optional'), preconditions: str('optional'), testData: str('optional'), priority: str('optional'),
      labels: { type: 'array', items: { type: 'string' } }, components: { type: 'array', items: { type: 'string' } }, gherkin: str('optional'), plainText: str('optional'),
      steps: STEPS_SCHEMA, changeNote: str('optional: Änderungsnotiz'),
    }, ['key']),
    run: async (a, api) => {
      const tc = (await api('GET', `/api/test-cases/${enc(String(a.key))}`)) as Json & { id: string; currentVersion: number; version: Json };
      const content: Json = Object.fromEntries(CONTENT_KEYS.map((k) => [k, tc.version[k]]));
      for (const k of ['title', 'objective', 'preconditions', 'testData', 'priority', 'labels', 'components', 'gherkin', 'plainText']) if (a[k] !== undefined) content[k] = a[k];
      if (a.steps !== undefined) content.steps = toSteps(a.steps);
      await api('PUT', `/api/test-cases/${tc.id}/content`, { content, expectedVersion: tc.currentVersion, changeNote: a.changeNote ?? null });
      return { key: a.key, version: tc.currentVersion + 1 };
    },
  },
  {
    name: 'set_test_case_status', readOnly: false, description: 'Status (Workflow), Ordner, Verantwortliche bzw. Schätzung eines Testfalls setzen – ohne neue Version.',
    inputSchema: obj({ key: str('Testfallschlüssel'), status: str('optional: Status-Code, z. B. READY'), owner: str('optional'), folderId: str('optional'),
      estimateMinutes: { type: 'integer', minimum: 0, description: 'optional: geplanter Aufwand je Ausführung' } }, ['key']),
    run: async (a, api) => {
      const tc = (await api('GET', `/api/test-cases/${enc(String(a.key))}`)) as { id: string };
      const body: Json = {};
      for (const k of ['status', 'owner', 'folderId', 'estimateMinutes']) if (a[k] !== undefined) body[k] = a[k];
      return api('PATCH', `/api/test-cases/${tc.id}`, body);
    },
  },
  {
    name: 'create_plan', readOnly: false, description: 'Testplan (Release) anlegen.',
    inputSchema: obj({ project: str('Projektschlüssel'), name: str('Name'), release: str('optional: Release/Version'), description: str('optional') }, ['project', 'name']),
    run: (a, api) => api('POST', `/api/projects/${enc(String(a.project))}/plans`, { name: a.name, release: a.release ?? null, description: a.description ?? null }),
  },
  {
    name: 'add_tests_to_cycle', readOnly: false, description: 'Testfälle (aktuelle Version) in einen bestehenden Zyklus aufnehmen.',
    inputSchema: obj({ cycleId: str('Zyklus-ID'), testCases: { type: 'array', items: { type: 'string' }, description: 'Testfallschlüssel' } }, ['cycleId', 'testCases']),
    run: (a, api) => api('POST', `/api/cycles/${enc(String(a.cycleId))}/executions`, { testCaseIds: a.testCases }),
  },
  {
    name: 'assign_executions', readOnly: false, description: 'Ausführungen einer Person zuweisen (oder Zuweisung entfernen mit assignee null).',
    inputSchema: obj({ executionIds: { type: 'array', items: { type: 'string' } }, assignee: { type: ['string', 'null'], description: 'Benutzername oder null' } }, ['executionIds']),
    run: (a, api) => api('POST', '/api/executions/bulk', { ids: a.executionIds, assignee: a.assignee ?? null }),
  },

  // ---- Projekte übertragen (ADR-0027; Recht „Projekte übertragen“) ----
  {
    name: 'project_export', readOnly: false,
    description: 'Export eines Projekts als Projektpaket anfordern (komplett oder Auswahl). Sensible Projekte brauchen die Freigabe der Systemadministration. '
      + 'Das Paket (ZIP) ist danach 24 Stunden unter downloadPath abrufbar – per HTTP mit demselben Token, nicht über MCP.',
    inputSchema: obj({
      project: str('Projektschlüssel'), note: str('optional: Anlass (für die Freigabe)'),
      testCases: { type: 'array', items: { type: 'string' }, description: 'optional: Auswahl – Testfallschlüssel' },
      query: str('optional: Auswahl – Abfrage wie in der Testfallliste'),
      folders: { type: 'array', items: { type: 'string' }, description: 'optional: Auswahl – Ordner-IDs (mit Unterordnern)' },
      cycles: { type: 'array', items: { type: 'string' }, description: 'optional: Auswahl – Zyklus-IDs mit Ausführungen' },
      versions: { type: 'string', enum: ['all', 'current'], description: 'Standard all' },
      executions: { type: 'boolean', description: 'Pläne, Zyklen, Ausführungen mitnehmen (Standard true)' },
      attachments: { type: 'boolean', description: 'Standard true' }, comments: { type: 'boolean', description: 'Standard true' },
      pseudonymize: { type: 'boolean', description: 'Personen durch „Person 1…n“ ersetzen (Standard false)' },
    }, ['project']),
    run: async (a, api) => {
      const selection = ['testCases', 'query', 'folders', 'cycles'].some((k) => a[k] !== undefined && a[k] !== '');
      const scope = selection ? { kind: 'selection', testCases: a.testCases, query: a.query, folders: a.folders, cycles: a.cycles } : { kind: 'complete' };
      const options: Json = {};
      for (const k of ['versions', 'executions', 'attachments', 'comments', 'pseudonymize']) if (a[k] !== undefined) options[k] = a[k];
      const t = (await api('POST', `/api/projects/${enc(String(a.project))}/exports`, { scope, options, ...(a.note ? { note: a.note } : {}) })) as Json;
      return { id: t.id, status: t.status, sensitive: t.sensitive, summary: (t.options as Json | undefined)?.summary ?? null,
        downloadPath: `/api/project-transfers/${String(t.id)}/download`,
        hint: t.status === 'pending' ? 'wartet auf Freigabe durch die Systemadministration' : 'wird erstellt; mit project_transfers den Stand abfragen' };
    },
  },
  {
    name: 'project_transfers', readOnly: true,
    description: 'Eigene Exporte und Importe mit Stand (wartet auf Freigabe, wird erstellt, bereit, eingespielt …); für Systemadministration mit pendingApprovals die offenen Freigaben.',
    inputSchema: obj({ pendingApprovals: { type: 'boolean', description: 'nur Systemadministration: offene Freigaben aller Personen' } }),
    run: async (a, api) => {
      const rows = (await api('GET', a.pendingApprovals ? '/api/admin/project-transfers?status=pending' : '/api/project-transfers')) as Json[];
      return rows.map((t) => ({ id: t.id, direction: t.direction, project: t.projectKey, status: t.status, requestedBy: t.requestedBy, requestedAt: t.requestedAt,
        expiresAt: t.expiresAt, progress: t.progress, counts: t.counts, error: t.error,
        ...(t.direction === 'export' && ['ready', 'done', 'approved', 'running'].includes(String(t.status)) ? { downloadPath: `/api/project-transfers/${String(t.id)}/download` } : {}) }));
    },
  },
  {
    name: 'project_import_preview', readOnly: true,
    description: 'Probelauf für ein hochgeladenes Projektpaket (Hochladen über die Oberfläche oder tools/project-package.ts): zeigt, was neu angelegt, '
      + 'aktualisiert oder übersprungen würde, Personen- und Katalogabgleich, Warnungen und Hinderungsgründe. Schreibt nichts.',
    inputSchema: obj({
      importId: str('ID des hochgeladenen Pakets'), mode: { type: 'string', enum: ['new', 'existing'], description: 'neues oder bestehendes Projekt' },
      key: str('Projektschlüssel des Ziels'), name: str('bei neuem Projekt: Name'), folderId: str('optional bei bestehendem Projekt: Zielordner'),
      persons: { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: 'optional: Login im Paket → Login hier (null = als Text)' },
      executionStatuses: { type: 'object', additionalProperties: { type: 'string' }, description: 'optional: fehlende Ergebnisstatus zuordnen' },
      conflicts: { type: 'object', additionalProperties: { type: 'string', enum: ['update', 'skip', 'new'] }, description: 'optional: Regel je Objektart für Vorhandenes' },
    }, ['importId', 'mode', 'key']),
    run: (a, api) => api('POST', `/api/package-imports/${enc(String(a.importId))}/preview`, importBody(a)),
  },
  {
    name: 'project_import_apply', readOnly: false,
    description: 'Projektpaket einspielen (wie project_import_preview, aber dauerhaft). Braucht confirm: true; vorher den Probelauf ansehen.',
    inputSchema: obj({
      importId: str('ID des hochgeladenen Pakets'), mode: { type: 'string', enum: ['new', 'existing'] }, key: str('Projektschlüssel des Ziels'), name: str('bei neuem Projekt: Name'),
      folderId: str('optional'), persons: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
      executionStatuses: { type: 'object', additionalProperties: { type: 'string' } },
      conflicts: { type: 'object', additionalProperties: { type: 'string', enum: ['update', 'skip', 'new'] } },
      confirm: { type: 'boolean', description: 'ausdrücklich bestätigen' },
    }, ['importId', 'mode', 'key', 'confirm']),
    run: (a, api) => {
      if (a.confirm !== true) throw new ToolError('Einspielen verändert Daten dauerhaft – zum Ausführen confirm: true angeben (vorher project_import_preview)');
      return api('POST', `/api/package-imports/${enc(String(a.importId))}/apply`, importBody(a));
    },
  },

  // ---- Vollzugriff: jede Funktion der Anwendung (wie in der Oberfläche), mit den Rechten des Token-Benutzers ----
  {
    name: 'api_operations', readOnly: true,
    description: 'Alle Funktionen von Anemo finden, die über api_call nutzbar sind – auch Administration (Benutzer, Rechte, Felder, Workflow, Anbindungen, Einstellungen …). '
      + 'Ohne „operation“ eine kompakte Liste (gefiltert nach Text/Bereich); mit „operation“ (z. B. „POST /api/projects/:key/plans“) Parameter und Eingabeschema. '
      + 'Administrationsfunktionen erscheinen nur für Systemadministratoren.',
    inputSchema: obj({ query: str('optional: Suchtext (Pfad, Bereich, Beschreibung)'), tag: str('optional: Bereich, z. B. „Planung & Ausführung“'),
      operation: str('optional: „METHODE /pfad“ für Details'), limit: { type: 'integer', minimum: 1, maximum: 300, default: 60 } }),
    run: async (a, api) => {
      const ops = await visibleOperations(api);
      if (a.operation) {
        const [m, p] = String(a.operation).trim().split(/\s+/);
        const op = ops.find((o) => o.method === m?.toUpperCase() && o.path === p);
        if (!op) throw new ToolError(`Unbekannte Funktion: ${a.operation}`);
        return { ...op, needsConfirm: needsConfirm(op) };
      }
      const needle = String(a.query ?? '').toLowerCase();
      const hits = ops.filter((o) => (!a.tag || o.tag === a.tag) && (!needle || `${o.method} ${o.path} ${o.tag} ${o.summary}`.toLowerCase().includes(needle)));
      return { total: hits.length, tags: [...new Set(ops.map((o) => o.tag))].sort(),
        operations: hits.slice(0, Number(a.limit ?? 60)).map((o) => ({ op: `${o.method} ${o.path}`, tag: o.tag, summary: o.summary, access: o.access })) };
    },
  },
  {
    name: 'api_call', readOnly: false,
    description: 'Beliebige Funktion von Anemo aufrufen (siehe api_operations) – geprüft mit den Rechten des Token-Benutzers wie in der Oberfläche. '
      + 'Pfadparameter direkt einsetzen (/api/projects/DEMO/plans). Löschende Funktionen brauchen confirm: true. Antwort: JSON bzw. Text (Berichte), Dateien nur als Größe.',
    inputSchema: obj({ method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: str('Pfad mit eingesetzten Parametern, beginnt mit /api/'),
      query: { type: 'object', description: 'optional: Abfrageparameter', additionalProperties: true }, body: { description: 'optional: JSON-Eingabe' },
      confirm: { type: 'boolean', description: 'bei löschenden Funktionen: ausdrücklich bestätigen' } }, ['method', 'path']),
    run: async (a, api) => {
      const method = String(a.method).toUpperCase();
      const path = String(a.path);
      const op = matchOperation(await visibleOperations(api), method, path);
      if (!op) throw new ToolError(`Keine Funktion ${method} ${path} – mit api_operations nachsehen`);
      if (BLOCKED.some((b) => b.test(op.path))) throw new ToolError(`${op.method} ${op.path} ist über MCP nicht verfügbar (Anmeldung, Kennwörter, API-Tokens bzw. MCP selbst)`);
      if (needsConfirm(op) && a.confirm !== true) throw new ToolError(`${op.method} ${op.path} („${op.summary}“) löscht Daten oder ändert Rechte, Einstellungen bzw. Freigaben – zum Ausführen confirm: true angeben`);
      const r = await api.raw(method, `${path}${q((a.query ?? {}) as Json)}`, method === 'GET' || method === 'DELETE' ? undefined : (a.body ?? {}));
      if (r.status >= 400) {
        let detail = r.text;
        try { const j = JSON.parse(r.text) as Json; detail = String(j.detail ?? r.text) + (j.issues ? ` ${JSON.stringify(j.issues).slice(0, 2000)}` : ''); } catch { /* Text */ }
        throw new ToolError(`${r.status}: ${detail}`);
      }
      if (/json/.test(r.type)) return r.text ? JSON.parse(r.text) : { status: r.status };
      if (/^text\/|markdown|csv|xml/.test(r.type)) return { status: r.status, contentType: r.type, text: r.text };
      return { status: r.status, contentType: r.type, bytes: r.text.length, hint: 'Datei – über die Oberfläche bzw. direkt per HTTP abrufen' };
    },
  },
];

class ToolError extends Error {}

const importBody = (a: Json) => ({
  target: { mode: a.mode, key: a.key, ...(a.name ? { name: a.name } : {}), ...(a.folderId ? { folderId: a.folderId } : {}) },
  ...(a.persons ? { persons: a.persons } : {}), ...(a.executionStatuses ? { executionStatuses: a.executionStatuses } : {}), ...(a.conflicts ? { conflicts: a.conflicts } : {}),
});

const CONTENT_KEYS = ['title', 'format', 'gherkin', 'plainText', 'objective', 'preconditions', 'testData', 'priority', 'labels', 'components', 'steps', 'sections', 'customFields', 'dataset', 'preconditionIds'];
function toSteps(steps: unknown): Json[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((x) => {
    const s = (x ?? {}) as Json;
    return typeof s.section === 'string'
      ? { ...(s.id ? { id: s.id } : {}), kind: 'group', title: s.section, note: s.note ?? null, action: '', data: '', expected: '' }
      : { ...(s.id ? { id: s.id } : {}), action: String(s.action ?? ''), data: String(s.data ?? ''), expected: String(s.expected ?? '') };
  });
}

/**
 * Über api_call nicht erreichbar: Anmeldung, eigene Kennwörter/Sitzungen, Rücksetz-Links, API-Tokens (ein Agent soll sich
 * keine Zugänge außerhalb des MCP-Kanals mit seinen Einschränkungen verschaffen), Kennwörter anderer Konten setzen
 * (Einmal-Kennwort ginge an den Agenten) und der MCP-Endpunkt selbst.
 */
const BLOCKED = [/^\/api\/mcp$/, /^\/api\/auth\/(login|logout|password|password-reset|oidc|ldap|sessions|tokens)/, /^\/api\/admin\/users\/:id\/password$/];
/** Ändernde Funktionen, die ein Agent nur mit ausdrücklicher Bestätigung ausführt (zusätzlich zu allem, was löscht) */
const CONFIRM = [/^\/api\/admin\//, /^\/api\/package-imports\/:id\/apply$/, /\/members$/, /\/release-decision$/, /^\/api\/projects\/:key\/integrations\//];
const needsConfirm = (op: ApiOperation) => op.method === 'DELETE' || /endgültig|löschen/i.test(op.summary)
  || (op.method !== 'GET' && CONFIRM.some((r) => r.test(op.path)));

/** Funktionen, die der Benutzer sehen soll: ohne Öffentliches/Anmeldung; Administration nur für Systemadministratoren. */
async function visibleOperations(api: ApiCall): Promise<ApiOperation[]> {
  const me = (await api('GET', '/api/auth/me').catch(() => null)) as { isSystemAdmin?: boolean } | null;
  return apiOperations().filter((o) => o.access !== 'public' && !BLOCKED.some((b) => b.test(o.path)) && (me?.isSystemAdmin || o.access !== 'admin'));
}

/** Konkreten Pfad (/api/projects/DEMO/plans) einer beschriebenen Funktion (/api/projects/:key/plans) zuordnen. */
function matchOperation(ops: ApiOperation[], method: string, path: string): ApiOperation | undefined {
  if (!path.startsWith('/api/') || /\.\.|[?#]/.test(path)) return undefined;
  const candidates = ops.filter((o) => o.method === method && new RegExp(`^${o.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+')}$`).test(path));
  // genaue Pfade vor Mustern (z. B. /api/executions/bulk vor /api/executions/:id)
  return candidates.sort((x, y) => (y.path.split(':').length === 1 ? 1 : 0) - (x.path.split(':').length === 1 ? 1 : 0) || x.path.split(':').length - y.path.split(':').length)[0];
}

function internalCaller(app: Hono, c: Context): ApiCall {
  const forward: Record<string, string> = { 'x-anemo-channel': 'mcp', host: c.req.header('host') ?? 'localhost' };
  for (const h of ['authorization', 'cookie', 'x-anemo-user']) {
    const v = c.req.header(h);
    if (v) forward[h] = v;
  }
  const raw = async (method: string, path: string, body?: unknown): Promise<RawResult> => {
    const res = await app.request(path, {
      method, headers: { ...forward, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await raw(method, path, body);
    let data: { detail?: string } | null = null;
    try { data = r.text ? JSON.parse(r.text) : null; } catch { /* keine JSON-Antwort */ }
    if (r.status >= 400) throw new ToolError(`${r.status}: ${data?.detail ?? r.text.slice(0, 300)}`);
    return data;
  };
  return Object.assign(call, { raw });
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handle(msg: Json, api: ApiCall): Promise<Json | null> {
  const id = msg.id;
  const params = (msg.params ?? {}) as Json;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(id, -32600, 'Ungültige JSON-RPC-Anfrage');
  if (id === undefined) return null; // Benachrichtigung (z. B. notifications/initialized)
  switch (msg.method) {
    case 'initialize': {
      const requested = String(params.protocolVersion ?? '');
      return {
        jsonrpc: '2.0', id, result: {
          protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'anemo', title: 'Anemo Testmanagement', version: versionInfo().version },
          instructions: 'Anemo ist ein Testmanagement-System. Texte von Testfällen sind Jira-Wiki-Markup. Arbeitsweise für Agenten: '
            + 'claim_next bzw. my_assignments → get_execution lesen → Schritte ausführen → Evidenzen mit attach_evidence anhängen → record_result. '
            + 'Bei Unsicherheit nicht raten, sondern escalate verwenden. Ergebnisse von Agentenkonten brauchen eine QA-Freigabe. '
            + 'Für alles Weitere (Projekte, Testfälle, Planung, Administration …): api_operations zum Finden, api_call zum Ausführen. '
            + 'Alle Zugriffe laufen mit den Rechten des Token-Benutzers; löschende Funktionen brauchen confirm: true.',
        },
      };
    }
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': return {
      jsonrpc: '2.0', id, result: {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: OUTPUT_SCHEMA, annotations: { readOnlyHint: t.readOnly, openWorldHint: false } })),
      },
    };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `Unbekanntes Werkzeug: ${String(params.name)}`);
      const args = normalizeArgs(tool.inputSchema, (params.arguments ?? {}) as Json);
      const missing = ((tool.inputSchema.required as string[]) ?? []).filter((k) => args[k] === undefined || args[k] === '');
      if (missing.length) return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `Fehlende Parameter: ${missing.join(', ')}` }] } };
      try {
        const data = await tool.run(args, api);
        let text = JSON.stringify(data, null, 1);
        if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… (gekürzt – Abfrage eingrenzen)`;
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], structuredContent: Array.isArray(data) ? { items: data } : data !== null && typeof data === 'object' ? data : { value: data ?? null } } };
      } catch (e) {
        const message = e instanceof ToolError || e instanceof Error ? e.message : String(e);
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: message }] } };
      }
    }
    default: return rpcError(id, -32601, `Methode nicht unterstützt: ${msg.method}`);
  }
}

/**
 * Einheitliche Parameternamen (Rückmeldung aus der Nutzung): Agenten verwechseln leicht `plan`/`planId`,
 * `project`/`projectKey` usw. Gängige Varianten werden auf den Namen im Schema des Werkzeugs abgebildet – nur, wenn
 * der eigentliche Parameter fehlt und der Wert ein Text ist.
 */
const ALIASES: Record<string, string[]> = {
  project: ['projectKey', 'projectId'], projectKey: ['project'],
  planId: ['plan', 'testPlanId'], cycleId: ['cycle', 'testCycleId'], executionId: ['execution', 'testExecutionId'],
  key: ['testCase', 'testCaseKey', 'testCaseId'], folderId: ['folder'],
};
export function normalizeArgs(schema: Json, args: Json): Json {
  const props = (schema.properties ?? {}) as Json;
  const out = { ...args };
  for (const name of Object.keys(props)) {
    if (out[name] !== undefined && out[name] !== '') continue;
    const alias = (ALIASES[name] ?? []).find((a) => !(a in props) && typeof out[a] === 'string' && out[a] !== '');
    if (alias) { out[name] = out[alias]; delete out[alias]; }
  }
  return out;
}
/** Alle Werkzeuge liefern ein JSON-Objekt (Listen als { items }) in structuredContent. */
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true };

export function mcpRoutes(app: Hono): void {
  route(app, { method: 'post', path: '/api/mcp', tag: 'Agenten (MCP)', summary: 'MCP-Endpunkt (JSON-RPC 2.0, Streamable HTTP mit JSON-Antworten)' }, async ({ c }) => {
    if (settingsEnv().AGENTS_ENABLED === 'false') throw new HttpError(403, 'KI-Agenten sind in der Administration ausgeschaltet.');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, 'JSON nicht lesbar'), 400);
    }
    const api = internalCaller(app, c);
    if (Array.isArray(body)) {
      // Stapel begrenzt und nacheinander – ein Agent kann den Server so nicht mit Parallelaufrufen fluten
      if (body.length > 50) return c.json(rpcError(null, -32600, 'Höchstens 50 Aufrufe je Stapel'), 400);
      const out: unknown[] = [];
      for (const m of body) { const r = await handle(m as Json, api); if (r) out.push(r); }
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const r = await handle(body as Json, api);
    return r ? c.json(r) : c.body(null, 202);
  });
  // Kein Server-Push-Strom: GET ist laut Spezifikation dann mit 405 zu beantworten
  app.get('/api/mcp', (c) => c.body(null, 405));
}
