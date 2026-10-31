import { useState } from 'react';
import { useCan } from '../session.tsx';
import { api, fmtDate, uploadAttachment, useApi } from '../api.ts';
import { uniqueFileName } from '../wiki/WikiEditor.tsx';
import { href } from '../router.ts';
import type { Attachment, HistoryItem, Step, TestCaseDetail, Version } from '../types.ts';
import { Chips, ErrorNote, GherkinView, nextStatuses, StatusBadge, TestCaseStatusBadge, useStatuses, useWorkflow, Wiki, WikiAttachments } from './common.tsx';
import { searchHref } from './Search.tsx';
import { TestCaseEditor } from './TestCaseEditor.tsx';
import { References } from './References.tsx';
import { documentedChanges } from '../../../shared/wiki/changelog.ts';
import { ActionMenu, askConfirm, askText, fmtMinutes, FocusLink, openFocus, parseEstimate, toast, useSync } from '../ux.tsx';
import { FieldValues, PriorityBadge, useFieldDefs, usePriorities } from './Fields.tsx';
import { PreconditionList } from './Preconditions.tsx';
import { Discussion } from './Discussion.tsx';
import { DatasetView } from './DatasetEditor.tsx';
import { WatchButton } from './Watch.tsx';
import { plural } from '../text.ts';
import { GroupRow, GroupToggleAll, useStepGroups } from './StepGroups.tsx';
import { CellHistoryDialog, CellMeta, FIELD_LABEL, useCellHistory, type CellField, type CellHistoryState } from './CellHistory.tsx';


function StepsTable({ steps, resolved, attachments, history }: { steps: Step[]; resolved?: Step[]; attachments?: Attachment[]; history?: CellHistoryState }) {
  const groups = useStepGroups(steps);
  // Stufe J3: letzte Änderung je Zelle, Hervorhebung „seit vN“
  const cell = (s: Step, f: CellField, no: number | null) => {
    const info = s.id ? history?.summary?.cells[s.id]?.[f] : undefined;
    const label = `${FIELD_LABEL[f]} Schritt ${no ?? ''}`.trim();
    return {
      className: info && history?.since && info.versionNo > history.since ? 'cell-changed' : undefined,
      meta: history && <CellMeta info={info} label={label} onOpen={() => history.setOpen({ stepId: s.id!, field: f, title: `Verlauf: ${label}` })} />,
    };
  };
  if (!steps.length) return <p className="muted">Keine Schritte.</p>;
  const stepAtts = (id?: string) => (attachments ?? []).filter((a) => id && (a as { stepId?: string | null }).stepId === id);
  return (
    <div className="table-wrap">
      <div className="row small steps-tools">
        {history?.summary && (history.versionNo ?? 0) > 1 && <label className="row" style={{ gap: 4 }}>Änderungen zeigen
          <select value={history.since ?? ''} onChange={(e) => history.setSince(e.target.value ? Number(e.target.value) : null)} aria-label="Geänderte Zellen hervorheben seit Version" style={{ width: 'auto' }}>
            <option value="">aus</option>
            {Array.from({ length: (history.versionNo ?? 1) - 1 }, (_, k) => (history.versionNo ?? 1) - 1 - k).map((n) => <option key={n} value={n}>seit v{n}</option>)}
          </select></label>}
        <span className="spacer" />
        <GroupToggleAll groups={groups} />
      </div>
      {history?.open && history.testCaseId && <CellHistoryDialog testCaseId={history.testCaseId} stepId={history.open.stepId} field={history.open.field}
        upTo={history.versionNo} title={history.open.title} onClose={() => history.setOpen(null)} />}
      <table className="steps">
        <thead><tr><th>#</th><th>Aktion</th><th>Testdaten</th><th>Erwartetes Ergebnis</th></tr></thead>
        <tbody>{steps.map((s, i) => {
          if (s.kind === 'group') return <GroupRow key={s.id ?? i} step={s} index={i} groups={groups} cols={4} />;
          if (groups.hidden(i)) return null;
          const no = groups.numbers[i];
          if (s.call) {
            const inner = (resolved ?? []).filter((x) => x.id?.startsWith(`${s.id}>`));
            return (
              <tr key={s.id ?? i} className="call-step"><td className="n">{no}</td>
                <td colSpan={3}>
                  <details><summary>↪ <Wiki text={s.action} compact /> <span className="small muted">({plural(inner.length, 'Schritt', 'Schritte')}{s.call.versionNo ? `, v${s.call.versionNo}` : ''})</span></summary>
                    <ol className="call-inner">{inner.map((x) => <li key={x.id}><Wiki text={x.action} compact />{x.expected && <span className="small muted"> → <Wiki text={x.expected} compact /></span>}</li>)}</ol>
                  </details>
                </td></tr>
            );
          }
          const atts = stepAtts(s.id);
          const [ca, cd, ce] = (['action', 'data', 'expected'] as const).map((f) => cell(s, f, no ?? null));
          return (
            <tr key={s.id ?? i} className={s.blockId ? 'from-block' : undefined}><td className="n">{no}{s.blockId && <span className="block-mark" title="Aus der Schrittbibliothek eingefügt (Kopie)" aria-label="aus Bibliothek">📚</span>}</td>
              <td className={ca!.className}><Wiki text={s.action} />{atts.length > 0 && <div className="step-atts">{atts.map((a) => <a key={a.id} href={`/api/attachments/${a.id}/content`} target="_blank" rel="noreferrer noopener" className="chip">📎 {a.fileName}</a>)}</div>}{ca!.meta}</td>
              <td className={cd!.className}><Wiki text={s.data} />{cd!.meta}</td><td className={ce!.className}><Wiki text={s.expected} />{ce!.meta}</td></tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

/** Feldweiser Vergleich zweier Versionen. */
function VersionDiff({ a, b }: { a: Version; b: Version }) {
  const fields: [string, (v: Version) => string][] = [
    ['Titel', (v) => v.title], ['Format', (v) => v.format], ['Ziel', (v) => v.objective ?? ''], ['Vorbedingungen', (v) => v.preconditions ?? ''],
    ['Testdaten', (v) => v.testData ?? ''], ['Priorität', (v) => v.priority ?? ''], ['Labels', (v) => v.labels.join(', ')],
    ['Komponenten', (v) => v.components.join(', ')], ['Gherkin', (v) => v.gherkin ?? ''], ['Testanweisung', (v) => v.plainText ?? ''],
  ];
  const changed = fields.filter(([, f]) => f(a) !== f(b));
  const maxSteps = Math.max(a.steps.length, b.steps.length);
  const stepChanges = Array.from({ length: maxSteps }, (_, i) => [a.steps[i], b.steps[i]] as const)
    .map(([x, y], i) => ({ i, x, y }))
    .filter(({ x, y }) => JSON.stringify([x?.action, x?.data, x?.expected, x?.kind, x?.title]) !== JSON.stringify([y?.action, y?.data, y?.expected, y?.kind, y?.title]));
  if (!changed.length && !stepChanges.length) return <p className="muted small">Keine inhaltlichen Unterschiede in den Kernfeldern.</p>;
  const cell = (s: Step | undefined) => (!s ? '—' : s.kind === 'group' ? `Abschnitt: ${s.title || '(ohne Namen)'}` : `${s.action} | ${s.data} | ${s.expected}`);
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Feld</th><th>v{a.versionNo}</th><th>v{b.versionNo}</th></tr></thead>
        <tbody>
          {changed.map(([name, f]) => <tr key={name}><td>{name}</td><td className="diff-old prose">{f(a)}</td><td className="diff-new prose">{f(b)}</td></tr>)}
          {stepChanges.map(({ i, x, y }) => <tr key={`s${i}`}><td>Schritt {i + 1}</td><td className="diff-old prose">{cell(x)}</td><td className="diff-new prose">{cell(y)}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

export function TestCaseView({ idOrKey, projectKey, onChanged, onClose, initialVersion }: {
  idOrKey: string; projectKey: string; onChanged: (key?: string) => void; onClose?: () => void;
  /** zuerst gezeigte Version (z. B. die Fassung einer Ausführung); ohne Angabe die aktuelle */
  initialVersion?: number;
}) {
  const canEdit = useCan(projectKey, 'edit');
  const canManage = useCan(projectKey, 'manage');
  const canExecute = useCan(projectKey, 'execute');
  const fieldDefs = useFieldDefs('test_case', projectKey);
  const priorities = usePriorities();
  const tc = useApi<TestCaseDetail>(`/api/test-cases/${encodeURIComponent(idOrKey)}`);
  const [versionNo, setVersionNo] = useState<number | null>(initialVersion ?? null);
  const versions = useApi<{ versionNo: number; changeNote: string | null; createdAt: string; createdBy: string }[]>(tc.data ? `/api/test-cases/${tc.data.id}/versions` : null);
  const shownNo = versionNo ?? tc.data?.currentVersion ?? null;
  const cellHist = useCellHistory(tc.data?.id, shownNo);
  const shown = useApi<Version & { executionSteps: Step[] }>(tc.data && shownNo && shownNo !== tc.data.currentVersion ? `/api/test-cases/${tc.data.id}/versions/${shownNo}` : null);
  const prev = useApi<Version>(tc.data && shownNo && shownNo > 1 ? `/api/test-cases/${tc.data.id}/versions/${shownNo - 1}` : null);
  const atts = useApi<Attachment[]>(tc.data ? `/api/attachments?ownerType=TEST_CASE&ownerId=${tc.data.id}` : null);
  const history = useApi<HistoryItem[]>(tc.data ? `/api/test-cases/${tc.data.id}/executions` : null);
  const statuses = useStatuses();
  const workflow = useWorkflow();
  const [editing, setEditing] = useState(false);
  useSync(['testcase'], (_k, key) => { if (!key || key === tc.data?.key) { tc.reload(); versions.reload(); } });
  const [error, setError] = useState<unknown>(null);
  const [provenance, setProvenance] = useState<unknown[] | null>(null);
  const [openComments, setOpenComments] = useState(0);
  const [nextStatus, setNextStatus] = useState('');

  if (tc.error) return <div className="pane"><ErrorNote error={tc.error} /></div>;
  if (!tc.data) return <div className="pane muted">Lädt …</div>;
  const t = tc.data;
  const v: Version = shown.data ?? t.version;
  const documented = documentedChanges(v.objective, v.preconditions);
  const execSteps = shown.data?.executionSteps ?? t.executionSteps;
  const isOld = v.versionNo !== t.currentVersion;

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api('PATCH', `/api/test-cases/${t.id}`, body);
      tc.reload();
      onChanged();
    } catch (e) {
      setError(e);
    }
  };
  const clone = async () => {
    try {
      const r = await api<TestCaseDetail>('POST', `/api/test-cases/${t.id}/clone`);
      onChanged(r.key);
    } catch (e) {
      setError(e);
    }
  };
  const runNow = async () => {
    try {
      const r = await api<{ executionId: string; cycleId: string }>('POST', `/api/test-cases/${t.id}/run-adhoc`, {});
      toast(`${t.key}: Ad-hoc-Ausführung angelegt`);
      openFocus(`/f/${projectKey}/run/${r.executionId}`, 'anemo-run');
    } catch (e) {
      setError(e);
    }
  };
  const editEstimate = async () => {
    const v = await askText({ title: `Schätzung für ${t.key}`, label: 'Geplanter Aufwand', initial: t.estimateMinutes ? String(t.estimateMinutes) : '',
      placeholder: 'z. B. 30, 1h 30m, 1,5 h', hint: 'Minuten oder mit Einheit (h, m, d = 8 h). Leer = ohne Schätzung.', required: false, confirmLabel: 'Speichern' });
    if (v === null) return;
    const m = parseEstimate(v);
    if (Number.isNaN(m)) { toast('Schätzung nicht lesbar – z. B. 90 oder 1h 30m', 'bad'); return; }
    await patch({ estimateMinutes: m });
  };
  const applyStatus = async () => {
    if (!nextStatus) return;
    await patch({ status: nextStatus });
    toast(`${t.key}: Status „${workflow?.statuses.find((s) => s.code === nextStatus)?.name ?? nextStatus}“`);
    setNextStatus('');
  };
  const setArchived = async (archived: boolean) => {
    try {
      await api('POST', '/api/test-cases/archive', { ids: [t.id], archived });
      toast(archived ? `${t.key} archiviert – in Listen und Auswahl ausgeblendet` : `${t.key} wiederhergestellt`);
      tc.reload();
      onChanged();
    } catch (e) {
      setError(e);
    }
  };
  const remove = async () => {
    const typed = await askText({
      title: `${t.key} endgültig löschen`, label: 'Zur Bestätigung den Schlüssel eingeben', placeholder: t.key, confirmLabel: 'Endgültig löschen',
      hint: 'Löscht alle Versionen, Verweise und Anhänge. Nur möglich, wenn der Testfall nie in einem Zyklus war – sonst archivieren.',
    });
    if (typed === null) return;
    if (typed.trim() !== t.key) { toast('Schlüssel stimmt nicht überein – nichts gelöscht', 'bad'); return; }
    try {
      await api('DELETE', `/api/test-cases/${t.id}`);
      toast(`${t.key} gelöscht`);
      onClose?.();
      onChanged();
    } catch (e) {
      setError(e);
    }
  };
  const loadProvenance = async () => {
    try {
      setProvenance(await api<unknown[]>('GET', `/api/migration/provenance/${t.id}`));
    } catch {
      setProvenance([]);
    }
  };

  const custom = Object.entries(v.customFields ?? {});

  return (
    <WikiAttachments attachments={atts.data}>
    <div className="pane">
      <div className="detail-head">
        <div className="row">
          <span className="badge accent mono">{t.key}</span>
          {t.legacyKey && <span className="badge neutral mono" title="Schlüssel im Altsystem">Jira {t.legacyKey}</span>}
          <span className={`badge ${v.format === 'GHERKIN' ? 'ok' : v.format === 'PLAIN' ? 'accent' : 'neutral'}`}
            title={v.format === 'PLAIN' ? 'Unstrukturierter Test: Testanweisung als Freitext, Ergebnis nur als Ganzes' : undefined}>{v.format === 'GHERKIN' ? 'Gherkin' : v.format === 'PLAIN' ? 'Freitext' : 'Klassisch'}</span>
          {openComments > 0 && <a className="badge warn" href="#diskussion" onClick={(e) => { e.preventDefault(); document.getElementById('diskussion')?.scrollIntoView({ behavior: 'smooth' }); }} title="Offene Anmerkungen" aria-label={`${openComments} offene Anmerkungen`}><span aria-hidden="true">💬 </span>{openComments}</a>}
          <span className="spacer" />
          <WatchButton type="TEST_CASE" id={t.id} />
          {canEdit && <button className="small" onClick={() => setEditing(true)} disabled={isOld}>Bearbeiten</button>}
          {canExecute && !isOld && !t.archivedAt && <button className="small" onClick={runNow} title="Ohne geplanten Zyklus sofort ausführen – landet im Ad-hoc-Zyklus des Projekts">▶ Jetzt ausführen</button>}
          {canEdit && !isOld && t && <FocusLink to={`/f/${projectKey}/testcase/${t.key}`} name="anemo-testfall" className="btn small" title="Im eigenen Fenster bearbeiten – volle Fläche (Strg/Cmd-Klick: neuer Tab)"><span aria-hidden="true">⧉</span><span className="sr-only">{t.key} im eigenen Fenster bearbeiten</span></FocusLink>}
          {canEdit && <ActionMenu label="⋯ Mehr" ariaLabel={`Weitere Aktionen zu ${t.key}`} items={[
            { label: '⎘ Kopieren', title: 'Neuer Testfall mit gleichem Inhalt (Entwurf)', onClick: clone },
            { label: t.archivedAt ? '↺ Wiederherstellen' : '🗄 Archivieren', title: t.archivedAt ? 'Wieder in Listen und Auswahl zeigen' : 'Ausblenden, Inhalte und Ergebnisse bleiben erhalten', onClick: () => void setArchived(!t.archivedAt) },
            { label: '🗑 Endgültig löschen …', title: 'Nur für nie eingeplante Testfälle (Projektadmin)', onClick: () => void remove(), hidden: !canManage },
          ]} />}
          {onClose && <button className="ghost small" onClick={onClose} title="Schließen" aria-label="Testfall schließen">✕</button>}
        </div>
        <div className="detail-title">{v.title}</div>
        <div className="row small">
          <span className="row">Status <TestCaseStatusBadge code={t.status} workflow={workflow} />
            {/* Wechsel erst mit „Übernehmen“ – Pfeiltasten im geschlossenen Auswahlfeld lösen sonst sofort Änderungen aus */}
            {canEdit && workflow && nextStatuses(workflow, t.status).length > 0 && <>
              <select value={nextStatus} onChange={(e) => setNextStatus(e.target.value)} style={{ width: 'auto' }} aria-label="Status ändern"
                title="Nur im Workflow vorgesehene Wechsel">
                <option value="">ändern …</option>
                {nextStatuses(workflow, t.status).map((s) => <option key={s.code} value={s.code}>→ {s.name}</option>)}
              </select>
              {nextStatus && <button className="small" onClick={() => void applyStatus()} aria-label="Statuswechsel übernehmen">Übernehmen</button>}
            </>}
          </span>
          <label className="row">Version
            <select aria-label="Angezeigte Version" value={shownNo ?? ''} onChange={(e) => setVersionNo(Number(e.target.value))} style={{ width: 'auto' }}>
              {(versions.data ?? []).map((x) => (
                <option key={x.versionNo} value={x.versionNo}>
                  v{x.versionNo}{x.versionNo === t.currentVersion ? ' (aktuell)' : ''} · {fmtDate(x.createdAt)} · {x.createdBy}
                </option>
              ))}
            </select>
          </label>
          {t.approvedVersion != null && <span className={t.approvedVersion === t.currentVersion ? 'rate-ok' : 'muted'} title="Testfall-Freigabe (Vier-Augen-Prüfung der Testspezifikation)">
            ✓ freigegeben v{t.approvedVersion} von {t.approvedBy}{t.approvedAt ? `, ${fmtDate(t.approvedAt)}` : ''}</span>}
          <span className="muted">Verantwortlich: {t.owner ?? '–'} · erstellt {fmtDate(t.createdAt)} von {t.createdBy}</span>
          <span className="row" title="Geplanter Aufwand je Ausführung">⏱ {fmtMinutes(t.estimateMinutes)}{canEdit && <button className="small link" onClick={editEstimate}>{t.estimateMinutes ? 'ändern' : 'schätzen'}</button>}</span>
        </div>
        {v.aiAssisted && <div className="small"><span className="badge accent" title={`Diese Version entstand mit KI-Unterstützung: ${v.aiAssisted}`}><span aria-hidden="true">✨ </span>mit KI erstellt</span> <span className="muted">{v.aiAssisted}</span></div>}
        {t.archivedAt && <div className="notice warn row"><span aria-hidden="true">🗄 </span>Archiviert {fmtDate(t.archivedAt)} von {t.archivedBy} – ausgeblendet in Listen, Testsets und Zyklusauswahl.
          {canEdit && <><span className="spacer" /><button className="small" onClick={() => setArchived(false)}>Wiederherstellen</button></>}</div>}
        {isOld && <div className="notice info">Sie sehen die historische Version v{v.versionNo}. Ausführungen, die auf diese Version zeigen, bleiben unverändert.</div>}
        <ErrorNote error={error} />
      </div>

      <div className="section"><h4>Ziel / Beschreibung</h4><Wiki text={v.objective} /></div>
      <div className="section"><h4>Vorbedingungen</h4>
        <PreconditionList projectKey={projectKey} ids={v.preconditionIds ?? []} />
        {(v.preconditions || !(v.preconditionIds ?? []).length) && <Wiki text={v.preconditions} />}</div>
      {v.testData && <div className="section"><h4>Testdaten</h4><Wiki text={v.testData} /></div>}

      {v.format === 'PLAIN' ? (
        <div className="section plain-text"><h4>Testanweisung</h4>
          {v.plainText ? <Wiki text={v.plainText} /> : <span className="muted">Keine Testanweisung.</span>}
          <p className="small muted">Unstrukturierter Test – keine Schritte, in der Durchführung wird das Gesamtergebnis erfasst.</p>
        </div>
      ) : (
        <div className="section">
          <h4>{v.format === 'GHERKIN' ? 'Szenario' : 'Schritte'}</h4>
          {v.format === 'GHERKIN' && v.gherkin ? <GherkinView text={v.gherkin} /> : <StepsTable steps={v.steps} resolved={execSteps} attachments={atts.data} history={cellHist} />}
          {v.format === 'GHERKIN' && <details><summary>Ausführbare Schritte ({execSteps.length})</summary><StepsTable steps={execSteps} /></details>}
        </div>
      )}
      {v.dataset && v.dataset.rows.length > 0 && <div className="section"><h4>Datensatz – {v.dataset.rows.length} Durchläufe</h4><DatasetView value={v.dataset} /></div>}

      <div className="section grid2">
        <div><h4>Labels</h4><Chips items={v.labels} /></div>
        <div><h4>Komponenten</h4><Chips items={v.components} /></div>
      </div>
      {(v.priority || fieldDefs.length > 0 || custom.length > 0) && <div className="section">
        <h4>Priorität und Felder</h4>
        <dl className="field-values"><div><dt>Priorität</dt><dd><PriorityBadge value={v.priority} priorities={priorities} /></dd></div></dl>
        <FieldValues defs={fieldDefs} values={v.customFields} />
      </div>}

      {v.sections.map((s) => (
        <details key={s.title} className="section"><summary>{s.title}</summary><Wiki text={s.content} /></details>
      ))}

      <div className="section">
        <References ownerType="TEST_CASE" ownerId={t.id} projectKey={projectKey} canEdit={canEdit} />
      </div>
      <div className="section" id="diskussion">
        <Discussion projectKey={projectKey} ownerType="TEST_CASE" ownerId={t.id} versionNo={v.versionNo} onCount={setOpenComments} />
      </div>

      <div className="section">
        <div className="row"><h4>Anhänge ({atts.data?.length ?? 0})</h4>
          {canEdit && tc.data && <label className="btn small" style={{ cursor: 'pointer' }} title="Datei am Testfall speichern (einbetten im Editor per Strg+V/Ablegen)">+ Datei
            <input type="file" multiple hidden onChange={async (ev) => {
              const files = [...(ev.target.files ?? [])];
              ev.target.value = '';
              for (const f of files) {
                await uploadAttachment('TEST_CASE', tc.data!.id, new File([f], uniqueFileName(f, (atts.data ?? []).map((x) => x.fileName)), { type: f.type })).catch(setError);
              }
              atts.reload();
            }} /></label>}
        </div>
        {atts.data?.map((a) => (
          <div key={a.id} className="small">
            <a href={`/api/attachments/${a.id}/content`} target="_blank" rel="noreferrer noopener">{a.fileName}</a>
            <span className="muted"> {a.storage === 'SOURCE' ? '(nur Verweis auf Quellsystem)' : a.sizeBytes ? `(${Math.round(a.sizeBytes / 1024)} KB)` : ''}</span>
          </div>
        ))}
      </div>

      <div className="section">
        <h4>Ausführungshistorie ({history.data?.length ?? 0})</h4>
        {history.data && history.data.length > 0 && <div className="small muted">{Object.entries(history.data.reduce<Record<string, number>>((a, h) => ((a[h.status] = (a[h.status] ?? 0) + 1), a), {})).map(([k, n]) => `${statuses.find((s) => s.code === k)?.name ?? k}: ${n}`).join(' · ')}</div>}
        {history.data && history.data.length > 0 ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Zyklus</th><th>Release</th><th>Version</th><th>Status</th><th>Ausgeführt</th></tr></thead>
            <tbody>{history.data.map((h) => (
              <tr key={h.id}>
                <td><a href={href(['p', projectKey, 'cycles', h.cycleId], { exec: h.id })}>{h.cycleName}</a></td>
                <td>{h.release ?? '–'}</td><td>v{h.versionNo}</td>
                <td><StatusBadge code={h.status} statuses={statuses} /></td>
                <td className="small">{fmtDate(h.executedAt)} {h.executedBy && `· ${h.executedBy}`}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <span className="muted">Noch nicht ausgeführt.</span>}
      </div>

      {(versions.data?.length ?? 0) > 1 && (
        <details className="section"><summary>Versionshistorie ({versions.data!.length})</summary>
          <div className="table-wrap" style={{ maxHeight: 320 }}><table><tbody>
            {versions.data!.map((x) => (
              <tr key={x.versionNo} className={`clickable ${x.versionNo === v.versionNo ? 'selected' : ''}`} onClick={() => setVersionNo(x.versionNo)}>
                <td className="mono small"><button type="button" className="link" aria-pressed={x.versionNo === v.versionNo} onClick={(e) => { e.stopPropagation(); setVersionNo(x.versionNo); }}>v{x.versionNo}</button></td><td className="small">{fmtDate(x.createdAt)}</td>
                <td className="small">{x.createdBy}</td><td className="small">{x.changeNote ?? ''}</td>
              </tr>
            ))}
          </tbody></table></div>
          {versions.data!.some((x) => x.changeNote?.startsWith('Rekonstruiert')) && (
            <p className="small muted">Versionen mit „Rekonstruiert“ stammen aus der Zephyr-/Jira-Historie. Zeitpunkte hinzugefügter Schritte sind geschätzt; gelöschte Schritte ohne überlieferten Inhalt sind als „[Inhalt nicht überliefert]“ gekennzeichnet.</p>
          )}
        </details>
      )}

      {documented.length > 0 && (
        <details className="section"><summary>Dokumentierte Änderungen aus der Beschreibung ({documented.length})</summary>
          <p className="small muted">Aus einer Änderungstabelle im Text erkannt (Bearbeiter/Datum/Grund) – der Text selbst bleibt unverändert.</p>
          <div className="table-wrap" style={{ maxHeight: 280 }}><table><tbody>
            {documented.map((d, i) => (
              <tr key={i}><td className="fit small">{d.date ? new Date(d.date).toLocaleDateString('de-DE') : '–'}</td><td className="fit small">{d.author ?? '–'}</td><td className="small">{d.note}</td></tr>
            ))}
          </tbody></table></div>
        </details>
      )}

      {(versions.data?.length ?? 0) > 1 && v.versionNo > 1 && prev.data && (
        <details className="section"><summary>Änderungen v{v.versionNo - 1} → v{v.versionNo}{v.changeNote ? `: ${v.changeNote}` : ''}</summary><VersionDiff a={prev.data} b={v} /></details>
      )}

      {custom.length > 0 && (
        <details className="section"><summary>Alle Feldwerte (technisch, {custom.length})</summary>
          <pre className="code">{JSON.stringify(v.customFields, null, 2)}</pre>
        </details>
      )}

      {t.legacyKey && (
        <details className="section" onToggle={(e) => (e.target as HTMLDetailsElement).open && !provenance && loadProvenance()}>
          <summary>Herkunft (Migration, Rohdaten)</summary>
          {provenance ? <pre className="code">{JSON.stringify(provenance, null, 2)}</pre> : <span className="muted">Lädt …</span>}
        </details>
      )}

      {editing && (
        <TestCaseEditor projectKey={projectKey} existing={t} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); setVersionNo(null); tc.reload(); versions.reload(); onChanged(); }} />
      )}
    </div>
    </WikiAttachments>
  );
}
