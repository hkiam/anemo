/**
 * Rekonstruktion früherer Testfallversionen aus der Zephyr- und Jira-Änderungshistorie.
 *
 * Quelle und ihre Grenzen (Zephyr for JIRA 3.1.3):
 *  - TESTSTEP_UPDATED: Feldänderungen (STEP, DATA, RESULT) mit altem und neuem Wert – vollständig.
 *  - TESTSTEP_DELETED: nur Zeitpunkt und Position des gelöschten Schritts, NICHT sein Inhalt. Inhalt ergibt
 *    sich aus den letzten bekannten Werten früherer Änderungen; sonst wird er als "nicht überliefert" markiert.
 *  - Das Anlegen von Schritten und Umsortierungen sind nicht protokolliert. Der Zeitpunkt des Anlegens wird
 *    geschätzt (siehe {@link estimateStepCreation}); Reihenfolge = heutige Reihenfolge bzw. Löschposition.
 *  - Titel, Beschreibung, Priorität, Labels: aus der Jira-Änderungshistorie (changelog).
 *
 * Verfahren: Ausgehend vom heutigen Stand werden alle Änderungen rückwärts zurückgenommen. Änderungen derselben
 * Person innerhalb eines Arbeitstags bilden eine Version ("Sitzung").
 */

export const NOT_PRESERVED = '[Inhalt nicht überliefert]';
/** Änderungen derselben Person innerhalb dieses Abstands bilden eine Version (≈ ein Arbeitstag). */
const SESSION_GAP_MS = 8 * 60 * 60 * 1000;
/** Schritte, die innerhalb dieses Zeitraums nach dem Anlegen des Tests hinzukamen, gehören zur Ursprungsfassung. */
const INITIAL_AUTHORING_MS = 24 * 60 * 60 * 1000;

export interface StepState { id: string; order: number; step: string; data: string; result: string }

export interface ZephyrStepChange {
  /** Epoch-Millisekunden */
  t: number;
  author: string | null;
  event: 'TESTSTEP_UPDATED' | 'TESTSTEP_DELETED';
  stepId: string;
  items: { field: string | null; old: string | null; new: string | null }[];
}

export interface JiraChange { t: number; author: string | null; field: string; from: string | null; to: string | null }

export interface IssueFields { summary: string; description: string | null; priority: string | null; labels: string[] }

export interface HistoryInput {
  createdAt: number;
  current: { fields: IssueFields; steps: StepState[] };
  zephyr: ZephyrStepChange[];
  jira: JiraChange[];
  /** Geschätzter Zeitpunkt, ab dem ein Schritt existierte (je Schritt-ID). */
  stepCreated: Record<string, number>;
}

export interface ReconstructedVersion {
  validFrom: number;
  author: string | null;
  changeNote: string;
  fields: IssueFields;
  steps: StepState[];
}

export interface HistoryDiagnostics {
  sessions: number;
  zephyrChanges: number;
  jiraChanges: number;
  /** Änderungen, deren "neuer Wert" nicht zum Folgezustand passt (Lücke in der Quelle). */
  inconsistent: number;
  /** Rekonstruierte gelöschte Schritte ohne überlieferten Inhalt. */
  unknownStepContent: number;
  /** Schritte mit Änderungen, die heute fehlen, aber keinen Löscheintrag haben (Löschzeitpunkt angenommen). */
  deletionsWithoutEvent: number;
  estimatedStepCreations: number;
}

type Ev =
  | { kind: 'zupdate'; t: number; author: string | null; stepId: string; field: 'step' | 'data' | 'result'; old: string; new: string }
  | { kind: 'zdelete'; t: number; author: string | null; stepId: string; order: number }
  | { kind: 'create'; t: number; author: null; stepId: string }
  | { kind: 'jira'; t: number; author: string | null; field: keyof IssueFields; from: string | null; to: string | null };

const FIELD: Record<string, 'step' | 'data' | 'result'> = { STEP: 'step', DATA: 'data', RESULT: 'result' };
const JIRA_FIELD: Record<string, keyof IssueFields> = { summary: 'summary', description: 'description', priority: 'priority', labels: 'labels' };

const clone = (s: { fields: IssueFields; steps: Map<string, StepState> }) => ({
  fields: { ...s.fields, labels: [...s.fields.labels] },
  steps: new Map([...s.steps].map(([k, v]) => [k, { ...v }])),
});

const sameState = (a: ReconstructedVersion, b: ReconstructedVersion) =>
  JSON.stringify([a.fields, a.steps]) === JSON.stringify([b.fields, b.steps]);

export function reconstructHistory(input: HistoryInput): { versions: ReconstructedVersion[]; diagnostics: HistoryDiagnostics } {
  const diagnostics: HistoryDiagnostics = {
    sessions: 0, zephyrChanges: input.zephyr.length, jiraChanges: input.jira.length, inconsistent: 0, unknownStepContent: 0,
    deletionsWithoutEvent: 0, estimatedStepCreations: 0,
  };

  // Letzter bekannter Inhalt je Schritt (für gelöschte Schritte), aus den Änderungen in Zeitfolge
  const lastKnown = new Map<string, Partial<Record<'step' | 'data' | 'result', string>>>();
  for (const c of [...input.zephyr].sort((a, b) => a.t - b.t)) {
    if (c.event !== 'TESTSTEP_UPDATED') continue;
    for (const it of c.items) {
      const f = it.field ? FIELD[it.field] : undefined;
      if (f) (lastKnown.get(c.stepId) ?? lastKnown.set(c.stepId, {}).get(c.stepId)!)[f] = it.new ?? '';
    }
  }

  const events: Ev[] = [];
  for (const c of input.zephyr) {
    if (c.event === 'TESTSTEP_DELETED') {
      events.push({ kind: 'zdelete', t: c.t, author: c.author, stepId: c.stepId, order: Number(c.items[0]?.old ?? 0) || 0 });
    } else {
      for (const it of c.items) {
        const f = it.field ? FIELD[it.field] : undefined;
        if (f) events.push({ kind: 'zupdate', t: c.t, author: c.author, stepId: c.stepId, field: f, old: it.old ?? '', new: it.new ?? '' });
      }
    }
  }
  // Schritte mit Änderungen, die heute fehlen und keinen Löscheintrag haben: gelöscht direkt nach der letzten Änderung
  const currentIds = new Set(input.current.steps.map((s) => s.id));
  const deletedIds = new Set(input.zephyr.filter((c) => c.event === 'TESTSTEP_DELETED').map((c) => c.stepId));
  const lastChange = new Map<string, number>();
  for (const c of input.zephyr) lastChange.set(c.stepId, Math.max(lastChange.get(c.stepId) ?? 0, c.t));
  for (const [id, t] of lastChange) {
    if (!currentIds.has(id) && !deletedIds.has(id)) {
      events.push({ kind: 'zdelete', t: t + 1, author: null, stepId: id, order: Number.MAX_SAFE_INTEGER });
      diagnostics.deletionsWithoutEvent++;
    }
  }
  for (const j of input.jira) {
    const f = JIRA_FIELD[j.field];
    if (f) events.push({ kind: 'jira', t: j.t, author: j.author, field: f, from: j.from, to: j.to });
  }
  // Anlegen von Schritten (geschätzt) – nur wenn nach dem Anlegen des Testfalls
  const allStepIds = new Set([...input.current.steps.map((s) => s.id), ...input.zephyr.map((c) => c.stepId)]);
  for (const id of allStepIds) {
    const t = input.stepCreated[id];
    if (t !== undefined && t > input.createdAt + INITIAL_AUTHORING_MS) {
      events.push({ kind: 'create', t, author: null, stepId: id });
      diagnostics.estimatedStepCreations++;
    }
  }
  if (events.length === 0) return { versions: [], diagnostics };

  // Sitzungen bilden: Ereignisse in Zeitfolge, neue Sitzung bei Autorwechsel oder Pause > 30 min
  events.sort((a, b) => a.t - b.t || a.kind.localeCompare(b.kind));
  const sessions: Ev[][] = [];
  for (const e of events) {
    const cur = sessions.at(-1);
    const prev = cur?.at(-1);
    if (cur && prev && e.t - prev.t <= SESSION_GAP_MS && (e.author === prev.author || e.author === null || prev.author === null)) cur.push(e);
    else sessions.push([e]);
  }
  diagnostics.sessions = sessions.length;

  // Rückwärts: Zustand nach der letzten Sitzung = heute
  let state = {
    fields: { ...input.current.fields, labels: [...input.current.fields.labels] },
    steps: new Map(input.current.steps.map((s) => [s.id, { ...s }])),
  };
  const snapshots: { after: ReturnType<typeof clone>; session: Ev[] }[] = [];
  for (let i = sessions.length - 1; i >= 0; i--) {
    const session = sessions[i]!;
    snapshots.unshift({ after: clone(state), session });
    for (let k = session.length - 1; k >= 0; k--) {
      const e = session[k]!;
      if (e.kind === 'zupdate') {
        const s = state.steps.get(e.stepId);
        if (!s) continue; // Schritt existierte zu diesem Zeitpunkt (laut Schätzung) nicht – Änderung ignorieren
        if (s[e.field] !== e.new) diagnostics.inconsistent++;
        s[e.field] = e.old;
      } else if (e.kind === 'zdelete') {
        const known = lastKnown.get(e.stepId) ?? {};
        if (known.step === undefined && known.data === undefined && known.result === undefined) diagnostics.unknownStepContent++;
        state.steps.set(e.stepId, {
          id: e.stepId, order: e.order - 0.5, // vor dem Schritt einordnen, der heute an dieser Position steht
          step: known.step ?? NOT_PRESERVED, data: known.data ?? '', result: known.result ?? (known.step === undefined ? NOT_PRESERVED : ''),
        });
      } else if (e.kind === 'create') {
        state.steps.delete(e.stepId);
      } else {
        const before = e.field === 'labels' ? (e.from ?? '').split(/\s+/).filter(Boolean).sort() : e.from;
        const norm = (v: unknown) => String(v ?? '').replace(/\r\n?/g, '\n').trim();
        const now = e.field === 'labels' ? [...state.fields.labels].sort().join(' ') : state.fields[e.field];
        const expected = e.field === 'labels' ? (e.to ?? '').split(/\s+/).filter(Boolean).sort().join(' ') : e.to;
        if (norm(now) !== norm(expected)) diagnostics.inconsistent++;
        (state.fields as Record<string, unknown>)[e.field] = before ?? (e.field === 'summary' ? '' : null);
      }
    }
  }

  const toVersion = (s: ReturnType<typeof clone>, validFrom: number, author: string | null, note: string): ReconstructedVersion => ({
    validFrom, author, changeNote: note, fields: s.fields,
    steps: [...s.steps.values()].sort((a, b) => a.order - b.order || Number(a.id) - Number(b.id)),
  });
  const versions: ReconstructedVersion[] = [toVersion(state, input.createdAt, null, 'Rekonstruiert: Ursprungsfassung')];
  for (const { after, session } of snapshots) {
    const author = session.find((e) => e.author)?.author ?? null;
    const parts = new Set(session.map((e) => (e.kind === 'zupdate' ? 'Schritte geändert' : e.kind === 'zdelete' ? 'Schritt gelöscht'
      : e.kind === 'create' ? 'Schritt hinzugefügt (Zeitpunkt geschätzt)' : `${{ summary: 'Titel', description: 'Beschreibung', priority: 'Priorität', labels: 'Labels' }[e.field]} geändert`)));
    const v = toVersion(after, session[0]!.t, author, `Rekonstruiert: ${[...parts].join(', ')}`);
    if (!sameState(v, versions.at(-1)!)) versions.push(v);
  }
  return { versions, diagnostics };
}

/**
 * Schätzt, ab wann ein Schritt existierte. Schritt-IDs werden fortlaufend vergeben: Ein Schritt kann nicht
 * später angelegt worden sein als der früheste Nachweis irgendeines Schritts mit höherer ID
 * (Nachweis = Änderung oder Schrittergebnis). Ergebnis: obere Schranke je ID (Suffix-Minimum).
 */
export function estimateStepCreation(firstSeen: Map<string, number>, allIds: Iterable<string>): Map<string, number> {
  const ids = [...new Set([...allIds, ...firstSeen.keys()])].sort((a, b) => Number(a) - Number(b));
  const out = new Map<string, number>();
  let min = Number.POSITIVE_INFINITY;
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]!;
    const seen = firstSeen.get(id);
    if (seen !== undefined && seen < min) min = seen;
    if (Number.isFinite(min)) out.set(id, min);
  }
  return out;
}

/** Version, die zum Zeitpunkt t galt (letzte mit validFrom <= t; sonst die erste). */
export function versionAt<T extends { validFrom: number }>(versions: T[], t: number): T {
  let found = versions[0]!;
  for (const v of versions) if (v.validFrom <= t) found = v;
  return found;
}
