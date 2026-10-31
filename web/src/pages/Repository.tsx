import { type KeyboardEvent as ReactKeyboardEvent, useMemo, useState } from 'react';
import { useCan } from '../session.tsx';
import { api, useApi } from '../api.ts';
import { ErrorNote, Modal, TestCaseStatusBadge, useWorkflow } from '../components/common.tsx';
import { ReportMenu } from '../components/ReportMenu.tsx';
import { SavedViews } from '../components/SavedViews.tsx';
import { GitSyncDialog } from '../components/GitSync.tsx';
import { DraftDialog } from '../components/DraftDialog.tsx';
import { TestCaseEditor } from '../components/TestCaseEditor.tsx';
import { TestCaseView } from '../components/TestCaseView.tsx';
import { href, navigate, type Route } from '../router.ts';
import { plural } from '../text.ts';
import { SuggestDialog, usePeople } from '../components/People.tsx';
import type { Content, Folder, TestCaseListItem } from '../types.ts';
import { ActionMenu, askConfirm, askText, parseEstimate, toast, useSync } from '../ux.tsx';
import { QueryInput } from '../components/QueryInput.tsx';
import { ImportDialog } from '../components/ImportDialog.tsx';
import { PreconditionsDialog } from '../components/Preconditions.tsx';
import { StepLibraryDialog } from '../components/StepLibrary.tsx';
import { FieldInputs, PriorityBadge, useFieldDefs, usePriorities } from '../components/Fields.tsx';
import { createTestSet, TestSetsDialog } from '../components/TestSets.tsx';

function FolderTree({ folders, parentId, active, onSelect, level = 1 }: { folders: Folder[]; parentId: string | null; active: string | null; onSelect: (id: string) => void; level?: number }) {
  const children = folders.filter((f) => f.parentId === parentId);
  if (!children.length) return null;
  return (
    <ul className="tree" role="group">
      {children.map((f) => {
        const hasChildren = folders.some((x) => x.parentId === f.id);
        return (
          <li key={f.id} role="none">
            <div className={`tree-item ${active === f.id ? 'active' : ''}`} role="treeitem" aria-selected={active === f.id} aria-level={level}
              aria-expanded={hasChildren ? true : undefined} data-id={f.id} data-parent={f.parentId ?? ''} tabIndex={active === f.id ? 0 : -1}
              onClick={() => onSelect(f.id)} aria-label={`${f.name}${f.testCount ? `, ${plural(f.testCount, 'Testfall', 'Testfälle')}` : ''}`}>
              <span aria-hidden="true">📁</span>{f.name}<span className="count" aria-hidden="true">{f.testCount || ''}</span>
            </div>
            <FolderTree folders={folders} parentId={f.id} active={active} onSelect={onSelect} level={level + 1} />
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Tastaturbedienung des Ordnerbaums (WAI-ARIA Tree): ↑/↓ wechseln, Pos1/Ende springen, → zum ersten Unterordner,
 * ← zum übergeordneten Ordner, Enter/Leertaste öffnet den Ordner. Fokus wandert mit (roving tabindex).
 */
function onTreeKey(e: ReactKeyboardEvent<HTMLElement>, onSelect: (id: string | null) => void) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const cur = items.indexOf(document.activeElement as HTMLElement);
  if (cur < 0) return;
  const focus = (el: HTMLElement | undefined) => {
    if (!el) return;
    e.preventDefault();
    for (const i of items) i.tabIndex = -1;
    el.tabIndex = 0;
    el.focus();
  };
  const me = items[cur]!;
  if (e.key === 'ArrowDown') focus(items[cur + 1]);
  else if (e.key === 'ArrowUp') focus(items[cur - 1]);
  else if (e.key === 'Home') focus(items[0]);
  else if (e.key === 'End') focus(items.at(-1));
  else if (e.key === 'ArrowRight') focus(items.find((i) => i.dataset.parent === me.dataset.id));
  else if (e.key === 'ArrowLeft') focus(me.dataset.parent ? items.find((i) => i.dataset.id === me.dataset.parent) : items[0]);
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(me.dataset.id || null); }
}

export function Repository({ projectKey, route }: { projectKey: string; route: Route }) {
  const canEdit = useCan(projectKey, 'edit');
  const canManage = useCan(projectKey, 'manage');
  const workflow = useWorkflow();
  const [gitSync, setGitSync] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [initial, setInitial] = useState<Partial<Content> | undefined>();
  const [aiAssisted, setAiAssisted] = useState<string | null>(null);
  const assist = useApi<{ llm: { model: string } | null }>('/api/assist/status');
  const folderId = route.query.get('folder');
  const selected = route.query.get('tc');
  const q = route.query.get('q') ?? '';
  const [search, setSearch] = useState(q);
  // Filter stehen in der URL (teil- und als Ansicht speicherbar)
  const status = route.query.get('status') ?? '';
  const testType = route.query.get('type') ?? '';
  const label = route.query.get('label') ?? '';
  const prio = route.query.get('prio') ?? '';
  const aql = route.query.get('aql') ?? '';
  const archived = (route.query.get('arch') ?? '') as '' | 'all' | 'only';
  const [advanced, setAdvanced] = useState(!!aql);
  const facets = useApi<{ labels: { value: string; n: number }[]; components: { value: string; n: number }[]; testTypes: { value: string; n: number }[];
    priorities: { value: string; n: number }[]; archived: number }>(`/api/projects/${projectKey}/test-case-facets`);
  const priorities = usePriorities();
  const fieldDefs = useFieldDefs('test_case', projectKey);
  const [bulkFields, setBulkFields] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preconditions, setPreconditions] = useState(false);
  const [stepLibrary, setStepLibrary] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [setsOpen, setSetsOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [page, setPage] = useState(0);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkPrio, setBulkPrio] = useState('');
  const people = usePeople(projectKey);
  const [suggest, setSuggest] = useState<null | { title: string; label: string; suggestions: string[]; required?: boolean; hint?: string; unknownHint?: string; confirmLabel?: string; apply: (v: string) => void }>(null);
  const PAGE = 100;
  /** Aktueller Filter als Abfrage-Text (für dynamische Testsets) – dieselben Felder wie die Liste */
  const currentFilter = () => new URLSearchParams(Object.entries({ q, folder: folderId ?? '', status, type: testType, label, prio, aql }).filter(([, v]) => v)).toString();
  const hasFilter = !!(q || folderId || status || testType || label || prio || aql);

  const folders = useApi<Folder[]>(`/api/projects/${projectKey}/folders`);
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
  if (q) params.set('q', q);
  if (folderId) {
    params.set('folderId', folderId);
    params.set('recursive', 'true');
  }
  if (status) params.set('status', status);
  if (testType) params.set('testType', testType);
  if (label) params.set('label', label);
  if (prio) params.set('priority', prio);
  if (aql) params.set('aql', aql);
  if (archived) params.set('archived', archived);
  const list = useApi<{ total: number; items: TestCaseListItem[] }>(`/api/projects/${projectKey}/test-cases?${params}`);
  // Testfälle, die in einem Fokusfenster angelegt oder geändert wurden, erscheinen sofort
  useSync(['testcase'], () => { list.reload(); folders.reload(); facets.reload(); });
  const statusOptions = useMemo(() => [...new Set((list.data?.items ?? []).map((i) => i.status))].sort(), [list.data]);

  const go = (patch: Record<string, string | null>) => {
    // Nur Filterwechsel springen auf Seite 1 – Öffnen/Schließen eines Testfalls behält die Seite
    if (Object.keys(patch).some((k) => k !== 'tc')) setPage(0);
    navigate(['p', projectKey, 'repo'], { folder: folderId, tc: selected, q: q || null, status: status || null, type: testType || null, label: label || null,
      prio: prio || null, aql: aql || null, arch: archived || null, ...patch });
  };

  const rowHref = (key: string) => href(['p', projectKey, 'repo'], { folder: folderId, tc: key, q: q || null, status: status || null, type: testType || null, label: label || null,
    prio: prio || null, aql: aql || null, arch: archived || null });

  const bulk = async (body: Record<string, unknown>, what = 'geändert') => {
    try {
      const r = await api<{ updated: number; skipped: { key: string; reason: string }[] }>('POST', '/api/test-cases/bulk', { ids: [...checked], ...body });
      toast(`${plural(r.updated, 'Testfall', 'Testfälle')} ${what}${r.skipped.length ? `, ${r.skipped.length} übersprungen` : ''}`, r.skipped.length ? 'info' : 'ok');
      if (r.skipped.length) toast(r.skipped.slice(0, 3).map((s) => `${s.key}: ${s.reason}`).join(' · '), 'info');
      setChecked(new Set());
      list.reload();
      folders.reload();
      facets.reload();
    } catch (e) {
      setError(e);
    }
  };
  /** Massenänderung erst nach Rückfrage, sobald mehr als ein Testfall betroffen ist (jeder erhält eine neue Version). */
  // Massenfreigabe (Testmanagement): erst zählen (Probelauf), dann nach Rückfrage freigeben
  const approve = async () => {
    type R = { approved: number; status: string; skipped: { own: string[]; already: string[]; deprecated: string[]; archived: string[] } };
    try {
      const ids = [...checked];
      const dry = await api<R>('POST', `/api/projects/${projectKey}/test-cases/approve`, { ids, dryRun: true });
      const sk = dry.skipped;
      const notes = [
        sk.own.length ? `${plural(sk.own.length, 'eigene Version', 'eigene Versionen')} (Vier-Augen-Prinzip)` : '',
        sk.already.length ? `${sk.already.length} bereits freigegeben` : '',
        sk.archived.length ? `${sk.archived.length} archiviert` : '',
        sk.deprecated.length ? `${sk.deprecated.length} außer Kraft` : '',
      ].filter(Boolean);
      if (!dry.approved) { toast(`Nichts freizugeben${notes.length ? ` – übersprungen: ${notes.join(', ')}` : ''}`, 'info'); return; }
      const note = await askText({
        title: `${plural(dry.approved, 'Testfall', 'Testfälle')} freigeben`, label: 'Vermerk zur Freigabe (optional, steht im Verlauf)', required: false,
        hint: `Status „${dry.status}“, freigegeben wird jeweils die aktuelle Version.${notes.length ? ` Übersprungen: ${notes.join(', ')}.` : ''}`, confirmLabel: 'Freigeben',
      });
      if (note === null) return;
      const r = await api<R>('POST', `/api/projects/${projectKey}/test-cases/approve`, { ids, note: note.trim() || undefined });
      toast(`${plural(r.approved, 'Testfall', 'Testfälle')} freigegeben`);
      setChecked(new Set());
      list.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    }
  };
  const confirmBulk = async (what: string) => checked.size <= 1 || askConfirm({
    title: `${what} für ${plural(checked.size, 'Testfall', 'Testfälle')}`,
    message: `${plural(checked.size, 'Testfall erhält', 'Testfälle erhalten')} dadurch eine neue Version. Ein Rückgängig gibt es nicht.`,
    confirmLabel: 'Übernehmen',
  });
  const applyStatus = async () => {
    if (!bulkStatus) return;
    const name = workflow?.statuses.find((x) => x.code === bulkStatus)?.name ?? bulkStatus;
    if (!(await confirmBulk(`Status „${name}“ setzen`))) return;
    await bulk({ status: bulkStatus }, 'auf neuen Status gesetzt');
    setBulkStatus('');
  };
  const applyPrio = async () => {
    if (!bulkPrio) return;
    if (!(await confirmBulk(bulkPrio === '-' ? 'Priorität entfernen' : `Priorität „${bulkPrio}“ setzen`))) return;
    await bulk({ priority: bulkPrio === '-' ? null : bulkPrio }, 'mit neuer Priorität');
    setBulkPrio('');
  };
  const splitList = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const selectAllMatches = async () => {
    setSelectingAll(true);
    try {
      const p = new URLSearchParams(params);
      p.set('idsOnly', 'true'); p.set('limit', '5000'); p.set('offset', '0');
      const r = await api<{ total: number; ids: string[] }>('GET', `/api/projects/${projectKey}/test-cases?${p}`);
      setChecked(new Set(r.ids));
      if (r.total > r.ids.length) toast(`Es wurden die ersten ${r.ids.length} von ${r.total} Treffern ausgewählt`, 'info');
    } catch (e) {
      setError(e);
    } finally {
      setSelectingAll(false);
    }
  };
  const exportList = (format: 'xlsx' | 'csv') => {
    const p = new URLSearchParams(params);
    p.delete('limit'); p.delete('offset'); p.set('format', format);
    // kleine Auswahl gezielt, große Auswahl (z. B. „alle Treffer“) über den Filter – lange Adressen vermeiden
    if (checked.size && checked.size <= 300) { for (const k of [...p.keys()]) if (k !== 'format') p.delete(k); p.set('ids', [...checked].join(',')); }
    else if (checked.size) toast(`Export aller ${list.data?.total ?? ''} Treffer des aktuellen Filters`, 'info');
    window.location.href = `/api/projects/${projectKey}/test-cases/export?${p}`;
  };
  const activeFolder = folders.data?.find((f) => f.id === folderId);
  const folderPath = (id: string | null): string => {
    const f = folders.data?.find((x) => x.id === id);
    return f ? `${f.parentId ? `${folderPath(f.parentId)} / ` : ''}${f.name}` : '';
  };
  const renameFolder = async () => {
    if (!activeFolder) return;
    const name = await askText({ title: 'Ordner umbenennen', label: 'Name', initial: activeFolder.name, confirmLabel: 'Umbenennen' });
    if (!name?.trim()) return;
    try { await api('PATCH', `/api/folders/${activeFolder.id}`, { name }); folders.reload(); toast('Ordner umbenannt'); } catch (e) { setError(e); }
  };
  const [moving, setMoving] = useState(false);
  const deleteFolder = async () => {
    if (!activeFolder) return;
    const hasContent = activeFolder.testCount > 0 || (folders.data ?? []).some((f) => f.parentId === activeFolder.id);
    if (!(await askConfirm({
      title: `Ordner „${activeFolder.name}“ löschen`,
      message: hasContent ? `Der Ordner enthält Testfälle bzw. Unterordner. Diese wandern eine Ebene nach oben${activeFolder.parentId ? ` (nach „${folderPath(activeFolder.parentId)}“)` : ' (oberste Ebene)'} – es wird kein Testfall gelöscht.` : 'Der Ordner ist leer.',
      confirmLabel: 'Ordner löschen', danger: true,
    }))) return;
    try {
      await api('DELETE', `/api/folders/${activeFolder.id}?moveContents=true`);
      toast(`Ordner „${activeFolder.name}“ gelöscht`);
      go({ folder: activeFolder.parentId });
      folders.reload();
    } catch (e) { setError(e); }
  };

  const createFolder = async () => {
    if (!newFolder?.trim()) return;
    try {
      await api('POST', `/api/projects/${projectKey}/folders`, { name: newFolder, parentId: folderId });
      setNewFolder(null);
      folders.reload();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className={`split ${selected ? '' : 'no-detail'}`}>
      <div className={`pane folder-pane ${foldersOpen ? '' : 'collapsed'}`}>
        <div className="pane-head"><h3>Ordner</h3>
          <button className="small folder-toggle" onClick={() => setFoldersOpen((o) => !o)} aria-expanded={foldersOpen}>{activeFolder ? activeFolder.name : 'Alle'} {foldersOpen ? '▴' : '▾'}</button>
          <span className="spacer" />
          <ReportMenu items={[{ label: folderId ? 'Testfallspezifikation (Ordner)' : 'Testfallspezifikation (Projekt)',
            path: `/api/reports/specification/${projectKey}${folderId ? `?folderId=${folderId}` : ''}`,
            hint: 'Aktuelle Fassung aller Testfälle mit Schritten' }]} />{canEdit && <button className="small ghost" onClick={() => { setNewFolder(''); setFoldersOpen(true); }} title="Ordner anlegen (unter dem gewählten)" aria-label="Ordner anlegen">+</button>}
          {canEdit && activeFolder && <ActionMenu label="⋯ Ordner" ariaLabel={`Ordner „${activeFolder.name}“: weitere Aktionen`} items={[
            { label: '✎ Umbenennen …', onClick: () => void renameFolder() },
            { label: '↦ Verschieben …', title: 'In einen anderen Ordner oder auf die oberste Ebene', onClick: () => setMoving(true) },
            { label: '🗑 Löschen …', title: 'Inhalt wandert eine Ebene nach oben', onClick: () => void deleteFolder() },
          ]} />}</div>
        {moving && activeFolder && <FolderMoveDialog folders={folders.data ?? []} folder={activeFolder} path={folderPath} onClose={() => setMoving(false)}
          onMove={async (parentId) => {
            try { await api('POST', `/api/folders/${activeFolder.id}/move`, { parentId }); setMoving(false); folders.reload(); toast('Ordner verschoben'); } catch (e) { setError(e); }
          }} />}
        <div className="folder-body">
        {newFolder !== null && (
          <div className="row" style={{ marginBottom: 8 }}>
            <input autoFocus placeholder="Ordnername" aria-label={`Name des neuen Ordners${activeFolder ? ` unter „${activeFolder.name}“` : ''}`} value={newFolder} onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createFolder(); if (e.key === 'Escape') setNewFolder(null); }} />
            <button className="small" onClick={() => void createFolder()} disabled={!newFolder.trim()}>Anlegen</button>
            <button className="small ghost" onClick={() => setNewFolder(null)}>Abbrechen</button>
          </div>
        )}
        <div role="tree" aria-label="Ordner" onKeyDown={(e) => onTreeKey(e, (id) => { go({ folder: id }); setFoldersOpen(false); })}>
          <div className={`tree-item ${!folderId ? 'active' : ''}`} role="treeitem" aria-selected={!folderId} aria-level={1} data-id="" data-parent="" tabIndex={!folderId ? 0 : -1}
            onClick={() => { go({ folder: null }); setFoldersOpen(false); }}>Alle Testfälle</div>
          <FolderTree folders={folders.data ?? []} parentId={null} active={folderId} onSelect={(id) => { go({ folder: id }); setFoldersOpen(false); }} />
        </div>
        {!folders.data && !folders.error && <div className="small muted">Lädt …</div>}
        </div>
      </div>

      <div className="pane">
        {/* Kopf: Primäraktionen immer sichtbar rechts; Nebenaktionen im Menü; Suche in eigener Zeile */}
        <div className="pane-head repo-head">
          <SavedViews projectKey={projectKey} page="repo" base={`#/p/${projectKey}/repo`} />
          {/* Gruppiert statt eines langen „⋯ Mehr“: wiederverwendbare Bausteine und Datenaustausch */}
          <ActionMenu label="▤ Bausteine ▾" items={[
            { label: '▤ Testsets …', title: 'Feste oder dynamische Testumfänge für Zyklen', onClick: () => setSetsOpen(true) },
            { label: '☑ Vorbedingungen …', title: 'Wiederverwendbare Vorbedingungen pflegen', onClick: () => setPreconditions(true) },
            { label: '📚 Schrittbibliothek …', title: 'Wiederkehrende Schrittfolgen (Bausteine) pflegen, die in Testfälle eingefügt werden', onClick: () => setStepLibrary(true) },
          ]} />
          <ActionMenu label="⇅ Austausch ▾" items={[
            { label: '⇩ Export Excel', title: checked.size ? `${plural(checked.size, 'ausgewählter Testfall', 'ausgewählte Testfälle')}` : 'Alle Treffer der aktuellen Filter (je Schritt eine Zeile)', onClick: () => exportList('xlsx') },
            { label: '⇩ Export CSV', title: 'Semikolon-getrennt, für Excel und andere Werkzeuge', onClick: () => exportList('csv') },
            { label: '⇧ Import aus Excel/CSV …', title: 'Anlegen oder per Schlüssel aktualisieren – mit Vorschau und Probelauf', onClick: () => setImporting(true), hidden: !canEdit },
            { label: '⎇ Git-Abgleich …', title: 'Gherkin-Testfälle mit .feature-Dateien in GitLab abgleichen', onClick: () => setGitSync(true) },
          ]} />
          <span className="spacer" />
          {canEdit && assist.data?.llm && <button className="small keep" onClick={() => setDrafting(true)} title={`KI-Entwurf aus Anforderung (${assist.data.llm.model})`}><span aria-hidden="true">✨ </span>Aus Anforderung</button>}
          {canEdit && <button className="primary keep" onClick={() => { setInitial(undefined); setAiAssisted(null); setCreating(true); }}>+ Testfall</button>}
        </div>
        <form className="row" style={{ marginBottom: 8 }} onSubmit={(e) => { e.preventDefault(); go({ q: search || null }); }}>
          <input type="search" placeholder="Suche: Text, DEMO-T12 oder Jira-Schlüssel – Enter" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, width: 'auto' }} aria-label="Testfälle suchen" />
          <button type="button" className={`small ${advanced || aql ? 'on' : ''}`} aria-pressed={advanced || !!aql} onClick={async () => {
              if ((advanced || aql) && aql) {
                // nicht stillschweigend verwerfen: Abfrage bleibt aktiv, solange sie nicht ausdrücklich entfernt wird
                if (!(await askConfirm({ title: 'Abfrage entfernen?', message: <>Die Abfrage <code>{aql}</code> filtert die Liste. Beim Ausblenden wird sie entfernt – die übrigen Filter bleiben.</>, confirmLabel: 'Abfrage entfernen' }))) return;
                go({ aql: null }); setAdvanced(false); return;
              }
              setAdvanced(!advanced);
            }}
            title="Erweiterte Suche mit der Abfragesprache (Felder, UND/ODER, Datum, eigene Felder)"><span aria-hidden="true">⌕ </span>Abfrage</button>
        </form>
        {(advanced || aql) && <div style={{ marginBottom: 8 }}>
          <QueryInput scope="testcase" value={aql} onSubmit={(v) => go({ aql: v || null })} autoFocus={advanced && !aql} values={{
            status: workflow?.statuses.map((s) => s.name) ?? [], priorität: priorities.map((p) => p.code),
            label: facets.data?.labels.map((l) => l.value) ?? [], komponente: facets.data?.components.map((l) => l.value) ?? [],
            testart: facets.data?.testTypes.map((l) => l.value) ?? [], ordner: (folders.data ?? []).map((f) => f.name),
          }} />
        </div>}
        <div className="row small" style={{ marginBottom: 8 }}>
          <select value={status} onChange={(e) => go({ status: e.target.value || null })} style={{ width: 'auto' }} aria-label="Status">
            <option value="">Alle Status</option>
            {(status && !statusOptions.includes(status) ? [status, ...statusOptions] : statusOptions).map((s) => <option key={s} value={s}>{workflow?.statuses.find((x) => x.code === s)?.name ?? s}</option>)}
          </select>
          {(facets.data?.testTypes.length ?? 0) > 0 && <select value={testType} onChange={(e) => go({ type: e.target.value || null })} style={{ width: 'auto' }} aria-label="Testart">
            <option value="">Alle Testarten</option>
            {facets.data!.testTypes.map((t) => <option key={t.value} value={t.value}>{t.value} ({t.n})</option>)}
          </select>}
          {(facets.data?.labels.length ?? 0) > 0 && <select value={label} onChange={(e) => go({ label: e.target.value || null })} style={{ width: 'auto', maxWidth: 200 }} aria-label="Label">
            <option value="">Alle Labels</option>
            {facets.data!.labels.map((t) => <option key={t.value} value={t.value}>{t.value} ({t.n})</option>)}
          </select>}
          {priorities.length > 0 && <select value={prio} onChange={(e) => go({ prio: e.target.value || null })} style={{ width: 'auto' }} aria-label="Priorität">
            <option value="">Alle Prioritäten</option>
            {priorities.map((p) => <option key={p.code} value={p.code}>{p.code} ({facets.data?.priorities.find((x) => x.value === p.code)?.n ?? 0})</option>)}
          </select>}
          {(facets.data?.archived ?? 0) > 0 && <select value={archived} onChange={(e) => go({ arch: e.target.value || null })} style={{ width: 'auto' }} aria-label="Archiv">
            <option value="">ohne archivierte</option><option value="all">mit archivierten</option><option value="only">nur archivierte ({facets.data!.archived})</option>
          </select>}
          <span className="muted" title="Treffer erfüllen alle aktiven Bedingungen: Suchtext UND Abfrage UND Auswahlfilter UND Ordner">{list.data ? plural(list.data.total, 'Treffer', 'Treffer') : 'Lädt …'}</span>
          {canEdit && hasFilter && checked.size === 0 && <button className="small ghost" title="Diesen Filter (einschließlich Abfrage und Priorität) als dynamisches Testset speichern"
            onClick={async () => {
              try { await createTestSet(projectKey, 'dynamic', { query: currentFilter() }); } catch (e) { setError(e); }
            }}><span aria-hidden="true">▤ </span>Filter als Testset</button>}
        </div>
        {(hasFilter || archived) && (
          <div className="filter-chips small" style={{ marginBottom: 8 }} aria-label="Aktive Filter">
            <span className="muted" title="Alle Bedingungen gelten gleichzeitig (UND)">Aktiv (alle zugleich):</span>
            {activeFolder && <span className="chip">Ordner „{activeFolder.name}“ inkl. Unterordner <button type="button" className="ghost small chip-x" aria-label="Ordnerfilter entfernen" onClick={() => go({ folder: null })}>✕</button></span>}
            {q && <span className="chip">Text „{q}“ <button type="button" className="ghost small chip-x" aria-label="Suchtext entfernen" onClick={() => { setSearch(''); go({ q: null }); }}>✕</button></span>}
            {aql && <span className="chip">Abfrage <code>{aql.length > 40 ? `${aql.slice(0, 39)}…` : aql}</code> <button type="button" className="ghost small chip-x" aria-label="Abfrage entfernen" onClick={() => { go({ aql: null }); setAdvanced(false); }}>✕</button></span>}
            {status && <span className="chip">Status {workflow?.statuses.find((x) => x.code === status)?.name ?? status} <button type="button" className="ghost small chip-x" aria-label="Statusfilter entfernen" onClick={() => go({ status: null })}>✕</button></span>}
            {testType && <span className="chip">Testart {testType} <button type="button" className="ghost small chip-x" aria-label="Testartfilter entfernen" onClick={() => go({ type: null })}>✕</button></span>}
            {label && <span className="chip">Label {label} <button type="button" className="ghost small chip-x" aria-label="Labelfilter entfernen" onClick={() => go({ label: null })}>✕</button></span>}
            {prio && <span className="chip">Priorität {prio} <button type="button" className="ghost small chip-x" aria-label="Prioritätsfilter entfernen" onClick={() => go({ prio: null })}>✕</button></span>}
            {archived && <span className="chip">{archived === 'only' ? 'nur archivierte' : 'mit archivierten'} <button type="button" className="ghost small chip-x" aria-label="Archivfilter entfernen" onClick={() => go({ arch: null })}>✕</button></span>}
            <button type="button" className="small ghost" onClick={() => { setSearch(''); setAdvanced(false); go({ folder: null, q: null, aql: null, status: null, type: null, label: null, prio: null, arch: null }); }}>Alle Filter zurücksetzen</button>
          </div>
        )}
        {canEdit && checked.size > 0 && (
          <div className="bulk-bar row small" role="toolbar" aria-label="Massenbearbeitung">
            <strong>{checked.size} ausgewählt</strong>
            {(list.data?.total ?? 0) > checked.size && <button className="small link" onClick={selectAllMatches} disabled={selectingAll}>{selectingAll ? 'wählt aus …' : `alle ${list.data!.total.toLocaleString('de-DE')} Treffer auswählen`}</button>}
            <button className="small ghost" onClick={() => setChecked(new Set())}>Auswahl aufheben</button>
            <span className="spacer" />
            {/* Auswahl ändert noch nichts – erst „Übernehmen“ (mit Rückfrage bei mehreren Testfällen) */}
            <span className="bulk-pair">
              <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} style={{ width: 'auto' }} aria-label="Status setzen" className="small">
                <option value="">Status …</option>
                {workflow?.statuses.filter((x) => x.active).map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
              </select>
              <button className="small" disabled={!bulkStatus} title={bulkStatus ? undefined : 'Erst einen Status wählen'} onClick={() => void applyStatus()} aria-label="Status übernehmen">Übernehmen</button>
            </span>
            {canManage && <button className="small" onClick={() => void approve()} title="Ausgewählte Testfälle freigeben (Testmanagement) – eigene Versionen werden übersprungen (Vier-Augen-Prinzip)">✓ Freigeben …</button>}
            <span className="bulk-pair">
              <select value={bulkPrio} onChange={(e) => setBulkPrio(e.target.value)} style={{ width: 'auto' }} aria-label="Priorität setzen" className="small">
                <option value="">Priorität …</option>
                {priorities.map((p) => <option key={p.code} value={p.code}>{p.code}</option>)}<option value="-">– entfernen –</option>
              </select>
              <button className="small" disabled={!bulkPrio} title={bulkPrio ? undefined : 'Erst eine Priorität wählen'} onClick={() => void applyPrio()} aria-label="Priorität übernehmen">Übernehmen</button>
            </span>
            <ActionMenu label="⋯ Mehr" items={[
              { label: '+ Label …', onClick: () => setSuggest({ title: 'Label hinzufügen', label: 'Label (mehrere mit Komma)', suggestions: facets.data?.labels.map((l) => l.value) ?? [], unknownHint: 'neues Label – bitte Schreibweise prüfen', apply: (v) => void bulk({ addLabels: splitList(v) }) }) },
              { label: '− Label entfernen …', onClick: () => setSuggest({ title: 'Label entfernen', label: 'Label (mehrere mit Komma)', suggestions: facets.data?.labels.map((l) => l.value) ?? [], unknownHint: 'dieses Label kommt im Projekt nicht vor', confirmLabel: 'Entfernen', apply: (v) => void bulk({ removeLabels: splitList(v) }) }) },
              { label: '+ Komponente …', onClick: () => setSuggest({ title: 'Komponente hinzufügen', label: 'Komponente (mehrere mit Komma)', suggestions: facets.data?.components.map((l) => l.value) ?? [], unknownHint: 'neue Komponente – bitte Schreibweise prüfen', apply: (v) => void bulk({ addComponents: splitList(v) }) }) },
              { label: '− Komponente entfernen …', onClick: () => setSuggest({ title: 'Komponente entfernen', label: 'Komponente (mehrere mit Komma)', suggestions: facets.data?.components.map((l) => l.value) ?? [], unknownHint: 'diese Komponente kommt im Projekt nicht vor', confirmLabel: 'Entfernen', apply: (v) => void bulk({ removeComponents: splitList(v) }) }) },
              { label: '👤 Verantwortlich setzen …', title: 'Verantwortliche Person für die Testfälle (Owner)', onClick: () => setSuggest({ title: 'Verantwortlich setzen', label: 'Benutzername (leer = entfernen)', suggestions: people, required: false, unknownHint: 'unbekannter Benutzername – bitte prüfen', apply: (v) => void bulk({ owner: v.trim() || null }) }) },
              { label: '☰ Feld setzen …', title: 'Eigenes Feld für alle gewählten setzen', onClick: () => setBulkFields(true), hidden: !fieldDefs.length },
              { label: '⏱ Schätzung setzen …', title: 'Geplanter Aufwand je Ausführung', onClick: async () => {
                const v = await askText({ title: 'Schätzung setzen', label: 'Geplanter Aufwand', placeholder: 'z. B. 30, 1h 30m', required: false, hint: 'Leer = Schätzung entfernen' });
                if (v === null) return;
                const m = parseEstimate(v);
                if (Number.isNaN(m)) toast('Schätzung nicht lesbar', 'bad'); else void bulk({ estimateMinutes: m }, 'mit neuer Schätzung');
              } },
              { label: '⏱ Schätzung aus Erfahrungswerten', title: 'Median der gemessenen Bearbeitungszeit (ab zwei Messungen)', onClick: async () => {
                try {
                  const r = await api<{ updated: number; skipped: unknown[] }>('POST', '/api/test-cases/estimate-from-history', { ids: [...checked] });
                  toast(`${r.updated} Schätzungen übernommen${r.skipped.length ? `, ${r.skipped.length} ohne genügend Messwerte` : ''}`);
                  list.reload();
                } catch (e) { setError(e); }
              } },
              { label: folderId ? '↦ In diesen Ordner verschieben …' : '↦ Auf oberste Ebene verschieben …', title: folderId ? `Nach „${activeFolder ? folderPath(activeFolder.id) : ''}“` : 'Aus allen Ordnern heraus', onClick: async () => {
                if (!(await askConfirm({ title: `${plural(checked.size, 'Testfall', 'Testfälle')} verschieben`,
                  message: folderId ? `Die ausgewählten Testfälle werden nach „${activeFolder ? folderPath(activeFolder.id) : ''}“ verschoben.` : 'Die ausgewählten Testfälle werden aus ihren Ordnern auf die oberste Ebene verschoben. Die bisherige Ordnerzuordnung geht dabei verloren.',
                  confirmLabel: 'Verschieben' }))) return;
                void bulk({ folderId: folderId ?? null }, 'verschoben');
              } },
              { label: '▤ Als Testset speichern …', onClick: async () => { try { if (await createTestSet(projectKey, 'static', { testCaseIds: [...checked] })) setChecked(new Set()); } catch (e) { setError(e); } } },
              { label: archived === 'only' ? '↺ Wiederherstellen' : '🗄 Archivieren', title: 'Ausblenden – Inhalte und Ergebnisse bleiben erhalten', onClick: () => void bulk({ archive: archived !== 'only' }, archived === 'only' ? 'wiederhergestellt' : 'archiviert') },
            ]} />
          </div>
        )}
        <ErrorNote error={error ?? list.error} />
        <div className="table-wrap">
          <table>
            <thead><tr><th style={{ width: 28 }}><input type="checkbox" style={{ width: 'auto' }} aria-label="Alle auf dieser Seite auswählen"
              checked={!!list.data?.items.length && list.data.items.every((i) => checked.has(i.id))}
              onChange={(e) => setChecked((s) => { const n = new Set(s); for (const i of list.data?.items ?? []) e.target.checked ? n.add(i.id) : n.delete(i.id); return n; })} /></th>
              <th>Schlüssel</th><th>Titel</th><th>Status</th><th className="hide-narrow">Priorität</th><th><abbr title="Anzahl der Schritte">Schr.</abbr></th></tr></thead>
            <tbody>
              {list.data?.items.map((i) => (
                <tr key={i.id} className={`clickable ${selected === i.key ? 'selected' : ''}`} onClick={() => go({ tc: i.key })}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={checked.has(i.id)} aria-label={`${i.key} auswählen`} style={{ width: 'auto' }}
                      onChange={(e) => setChecked((s) => { const n = new Set(s); e.target.checked ? n.add(i.id) : n.delete(i.id); return n; })} />
                  </td>
                  <td className="mono small"><a href={rowHref(i.key)} onClick={(e) => { if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) { e.stopPropagation(); return; } e.preventDefault(); e.stopPropagation(); go({ tc: i.key }); }}
                    aria-current={selected === i.key ? 'true' : undefined}>{i.key}</a>{i.legacyKey && <div className="muted">{i.legacyKey}</div>}</td>
                  <td>{i.title}{i.format === 'GHERKIN' && <> <span className="badge ok">Gherkin</span></>}{i.format === 'PLAIN' && <> <span className="badge accent" title="Unstrukturierter Test (Testanweisung als Freitext)">Freitext</span></>}{i.archivedAt && <> <span className="badge neutral" title="archiviert"><span aria-hidden="true">🗄 </span>archiviert</span></>}</td>
                  <td className="small"><TestCaseStatusBadge code={i.status} workflow={workflow} /></td>
                  <td className="small hide-narrow"><PriorityBadge value={i.priority} priorities={priorities} /></td>
                  <td className="small muted">{i.format === 'CLASSIC' ? i.stepCount : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.data && !list.error && <div className="empty small">Lädt …</div>}
          {list.data?.items.length === 0 && <div className="empty">Keine Testfälle gefunden.{hasFilter && ' Es sind Filter aktiv – siehe „Aktiv“ oben.'}</div>}
        </div>
        {(list.data?.total ?? 0) > PAGE && (
          <div className="row" style={{ marginTop: 8 }}>
            <button className="small" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Zurück</button>
            <span className="small muted">Seite {page + 1} / {Math.ceil(list.data!.total / PAGE)}</span>
            <button className="small" disabled={(page + 1) * PAGE >= list.data!.total} onClick={() => setPage(page + 1)}>Weiter ›</button>
          </div>
        )}
      </div>

      {/* Ohne gewählten Testfall bekommt die Liste die volle Breite */}
      {selected && <div className="detail-pane">
        <TestCaseView key={selected} idOrKey={selected} projectKey={projectKey} onClose={() => go({ tc: null })}
          onChanged={(key) => { list.reload(); folders.reload(); facets.reload(); if (key) go({ tc: key }); }} />
      </div>}

      {creating && (
        <TestCaseEditor projectKey={projectKey} folderId={folderId} initial={initial} aiAssisted={aiAssisted} onClose={() => setCreating(false)}
          onSaved={(key) => { setCreating(false); list.reload(); folders.reload(); go({ tc: key }); }} />
      )}
      {drafting && <DraftDialog projectKey={projectKey} onClose={() => setDrafting(false)}
        onDraft={(c, model) => { setDrafting(false); setInitial(c); setAiAssisted(`testcase-draft · ${model}`); setCreating(true); }} />}
      {setsOpen && <TestSetsDialog projectKey={projectKey} canEdit={canEdit} onClose={() => setSetsOpen(false)} selection={[...checked]}
        filterQuery={hasFilter ? currentFilter() : null}
        onApply={(s, ids) => {
        setSetsOpen(false);
        if (s.kind === 'dynamic' && s.query) {
          const p = new URLSearchParams(s.query);
          setSearch(p.get('q') ?? '');
          setAdvanced(!!p.get('aql'));
          go({ q: p.get('q'), folder: p.get('folder'), status: p.get('status'), type: p.get('type'), label: p.get('label'), prio: p.get('prio'), aql: p.get('aql') });
        } else {
          setChecked(new Set(ids));
          toast(`${plural(ids.length, 'Testfall', 'Testfälle')} aus „${s.name}“ markiert`, 'info');
        }
      }} />}
      {preconditions && <PreconditionsDialog projectKey={projectKey} onClose={() => setPreconditions(false)} />}
      {stepLibrary && <StepLibraryDialog projectKey={projectKey} onClose={() => setStepLibrary(false)} />}
      {importing && <ImportDialog projectKey={projectKey} folderId={folderId} folderName={activeFolder ? folderPath(activeFolder.id) : null}
        onClose={() => setImporting(false)} onDone={() => { list.reload(); folders.reload(); facets.reload(); }} />}
      {bulkFields && <BulkFieldsDialog defs={fieldDefs} count={checked.size} onClose={() => setBulkFields(false)}
        onApply={(fields) => { setBulkFields(false); void bulk({ fields }, 'mit neuem Feldwert'); }} />}
      {suggest && <SuggestDialog title={`${suggest.title} (${plural(checked.size, 'Testfall', 'Testfälle')})`} label={suggest.label} suggestions={suggest.suggestions} required={suggest.required}
        hint={suggest.hint} unknownHint={suggest.unknownHint} confirmLabel={suggest.confirmLabel} onCancel={() => setSuggest(null)}
        onSubmit={(v) => { const a = suggest.apply; setSuggest(null); a(v); }} />}
      {gitSync && <GitSyncDialog projectKey={projectKey} canEdit={canEdit} onClose={() => { setGitSync(false); list.reload(); }} />}
    </div>
  );
}

function FolderMoveDialog({ folders, folder, path, onClose, onMove }: {
  folders: Folder[]; folder: Folder; path: (id: string | null) => string; onClose: () => void; onMove: (parentId: string | null) => void;
}) {
  // nicht in sich selbst oder einen eigenen Unterordner
  const below = new Set<string>([folder.id]);
  let grew = true;
  while (grew) { grew = false; for (const f of folders) if (f.parentId && below.has(f.parentId) && !below.has(f.id)) { below.add(f.id); grew = true; } }
  const targets = folders.filter((f) => !below.has(f.id)).map((f) => ({ id: f.id, label: path(f.id) })).sort((a, b) => a.label.localeCompare(b.label, 'de'));
  const [target, setTarget] = useState<string>(folder.parentId ?? '');
  return (
    <Modal title={`Ordner „${folder.name}“ verschieben`} onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Abbrechen</button><button className="primary" onClick={() => onMove(target || null)} disabled={(target || null) === folder.parentId}>Verschieben</button></>}>
      <label className="field">Ziel
        <select value={target} onChange={(e) => setTarget(e.target.value)} autoFocus>
          <option value="">– oberste Ebene –</option>
          {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>
    </Modal>
  );
}

function BulkFieldsDialog({ defs, count, onClose, onApply }: { defs: import('../components/Fields.tsx').FieldDef[]; count: number; onClose: () => void; onApply: (v: Record<string, unknown>) => void }) {
  const [key, setKey] = useState(defs[0]?.key ?? '');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const def = defs.find((d) => d.key === key);
  return (
    <Modal title={`Feld für ${count} Testfälle setzen`} help="bulk-tc" onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Abbrechen</button><button className="primary" onClick={() => onApply({ [key]: values[key] ?? null })}>Übernehmen</button></>}>
      <label className="field">Feld<select value={key} onChange={(e) => { setKey(e.target.value); setValues({}); }}>{defs.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}</select></label>
      {def && <FieldInputs defs={[{ ...def, required: false }]} values={values} onChange={setValues} />}
      <p className="small muted">Leerer Wert entfernt das Feld. Jeder geänderte Testfall erhält eine neue Version.</p>
    </Modal>
  );
}
