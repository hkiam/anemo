import { useState } from 'react';
import { api, fmtDate, useApi } from '../../api.ts';
import { ErrorNote, Modal } from '../../components/common.tsx';
import { type FieldDef, type FieldScope, type FieldType, invalidateFields, type Priority } from '../../components/Fields.tsx';
import { askConfirm, toast } from '../../ux.tsx';

const SCOPES: { id: FieldScope; label: string; hint: string }[] = [
  { id: 'test_case', label: 'Testfälle', hint: 'versioniert mit dem Testfall; in Editor, Ansicht, Abfrage, Export' },
  { id: 'cycle', label: 'Testzyklen', hint: 'z. B. Testumgebung, Abnahmestufe' },
  { id: 'execution', label: 'Ausführungen', hint: 'z. B. Datenstand, Testsystem-Version; in der Durchführung' },
];
const TYPES: { id: FieldType; label: string }[] = [
  { id: 'text', label: 'Text' }, { id: 'textarea', label: 'Text (mehrzeilig)' }, { id: 'select', label: 'Auswahl' },
  { id: 'multiselect', label: 'Mehrfachauswahl' }, { id: 'number', label: 'Zahl' }, { id: 'date', label: 'Datum' },
  { id: 'checkbox', label: 'Ja/Nein' }, { id: 'user', label: 'Person' },
];
const KIND_LABEL: Record<string, string> = {
  versions: 'Versionen', components: 'Komponenten', priorities: 'Prioritäten', customfield: 'Auswahlfeld (ID)',
  categories: 'Kategorien', types: 'Typen', statuses: 'Status',
};
interface Candidate { scope: FieldScope; key: string; count: number; distinct: number; suggestedType: FieldType; options: string[] }

/** Administration: eigene Felder (Testfall, Zyklus, Ausführung) und Prioritäten (Stufe H5). */
export function FieldsAdmin() {
  const fields = useApi<FieldDef[]>('/api/fields?all=true');
  const prios = useApi<Priority[]>('/api/priorities?all=true');
  const candidates = useApi<Candidate[]>('/api/admin/field-candidates');
  const sources = useApi<{ jira: string[]; openproject: string[] }>('/api/admin/fields/option-sources');
  const projects = useApi<{ key: string; name: string }[]>('/api/projects');
  const [editing, setEditing] = useState<Partial<FieldDef> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = () => { invalidateFields(); fields.reload(); candidates.reload(); prios.reload(); };

  const sync = async (f: FieldDef) => {
    try {
      const r = await api<{ options: string[]; error: string | null }>('POST', `/api/admin/fields/${f.id}/sync-options`);
      if (r.error) toast(`Abgleich fehlgeschlagen: ${r.error}`, 'bad'); else toast(`${r.options.length} Werte übernommen`);
      reload();
    } catch (e) {
      setError(e);
    }
  };
  const remove = async (f: FieldDef) => {
    if (!(await askConfirm({ title: 'Feld löschen', message: `„${f.name}“ löschen? Gespeicherte Werte bleiben in den Daten erhalten und erscheinen dann als übernommene Werte.`, confirmLabel: 'Löschen', danger: true }))) return;
    try { await api('DELETE', `/api/admin/fields/${f.id}`); reload(); } catch (e) { setError(e); }
  };

  return (
    <div className="stack">
      <h2>Felder &amp; Prioritäten</h2>
      <p className="small muted">Eigene Felder ergänzen Testfälle, Zyklen und Ausführungen um projektspezifische Angaben. Sie erscheinen in Editor
        und Ansicht, sind in der Abfragesprache als <span className="mono">feld.Name</span> nutzbar und werden exportiert bzw. importiert.
        Auswahllisten lassen sich aus Jira oder OpenProject abgleichen.</p>
      <ErrorNote error={error ?? fields.error} />
      {SCOPES.map((s) => {
        const list = (fields.data ?? []).filter((f) => f.scope === s.id);
        return (
          <div key={s.id} className="card"><div className="card-body stack">
            <div className="row"><h3 style={{ flex: 1 }}>{s.label}</h3><span className="small muted">{s.hint}</span>
              <button className="small" onClick={() => setEditing({ scope: s.id, type: 'text', options: [], required: false, active: true, sortOrder: (list.length + 1) * 10 })}>+ Feld</button></div>
            {list.length === 0 ? <div className="small muted">Noch keine Felder.</div> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Name</th><th className="fit">Schlüssel</th><th className="fit">Typ</th><th>Werte</th><th className="fit">Projekt</th><th className="fit" /></tr></thead>
                <tbody>{list.map((f) => (
                  <tr key={f.id} className={f.active ? '' : 'muted'}>
                    <td><strong>{f.name}</strong>{f.required && <span className="badge warn" title="Pflichtfeld"> Pflicht</span>}{!f.active && <span className="badge neutral"> inaktiv</span>}
                      {f.description && <div className="small muted">{f.description}</div>}</td>
                    <td className="fit mono small">{f.key}</td>
                    <td className="fit small">{TYPES.find((t) => t.id === f.type)?.label}</td>
                    <td className="small">{f.options.length ? <span title={f.options.join(', ')}>{f.options.slice(0, 6).join(', ')}{f.options.length > 6 ? ` … (${f.options.length})` : ''}</span> : '–'}
                      {f.optionsSource && <div className={f.optionsSyncError ? 'err' : 'muted'}>
                        ⟳ {f.optionsSource.provider === 'jira' ? 'Jira' : 'OpenProject'} {f.optionsSource.project ?? ''} · {KIND_LABEL[f.optionsSource.kind]}{f.optionsSource.fieldId ? ` ${f.optionsSource.fieldId}` : ''}
                        {f.optionsSyncedAt ? ` · ${fmtDate(f.optionsSyncedAt)}` : ' · noch nicht abgeglichen'}{f.optionsSyncError ? ` · Fehler: ${f.optionsSyncError}` : ''}</div>}</td>
                    <td className="fit small">{f.projectKey ?? 'alle'}</td>
                    <td className="fit" style={{ whiteSpace: 'nowrap' }}>
                      {f.optionsSource && <button className="small" onClick={() => sync(f)} title="Auswahlwerte jetzt abgleichen">⟳</button>}
                      <button className="small" onClick={() => setEditing(f)}>✎</button>
                      <button className="small ghost danger" aria-label={`Feld ${f.name} löschen`} onClick={() => remove(f)}>✕</button>
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </div></div>
        );
      })}

      {(candidates.data?.length ?? 0) > 0 && (
        <div className="card"><div className="card-body stack">
          <h3>Übernommene Werte ohne Felddefinition</h3>
          <p className="small muted">Diese Angaben stammen aus der Migration (Jira/Zephyr). Mit „Als Feld anlegen“ werden sie mit demselben Schlüssel
            sofort als Feld angezeigt, sind bearbeitbar und abfragbar – die Werte selbst bleiben unverändert.</p>
          <div className="table-wrap"><table>
            <thead><tr><th>Schlüssel</th><th className="fit">Bereich</th><th className="fit">Vorkommen</th><th>Beispielwerte</th><th className="fit" /></tr></thead>
            <tbody>{candidates.data!.map((c) => (
              <tr key={`${c.scope}:${c.key}`}>
                <td className="mono small">{c.key}</td>
                <td className="fit small">{SCOPES.find((s) => s.id === c.scope)?.label}</td>
                <td className="fit small">{c.count} · {c.distinct} versch.</td>
                <td className="small muted">{c.options.slice(0, 5).join(', ')}{c.options.length > 5 ? ' …' : ''}</td>
                <td className="fit"><button className="small" onClick={() => setEditing({ scope: c.scope, key: c.key, name: c.key, type: c.suggestedType, options: c.options, required: false, active: true, sortOrder: 100 })}>Als Feld anlegen …</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        </div></div>
      )}

      <Priorities list={prios.data ?? []} onChanged={reload} onError={setError} />

      {editing && <FieldDialog initial={editing} projects={projects.data ?? []} sources={sources.data ?? { jira: [], openproject: [] }}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function FieldDialog({ initial, projects, sources, onClose, onSaved }: {
  initial: Partial<FieldDef>; projects: { key: string; name: string }[]; sources: { jira: string[]; openproject: string[] }; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState({
    scope: initial.scope ?? 'test_case', key: initial.key ?? '', name: initial.name ?? '', type: initial.type ?? 'text',
    options: (initial.options ?? []).join('\n'), required: initial.required ?? false, projectKey: initial.projectKey ?? '',
    description: initial.description ?? '', sortOrder: initial.sortOrder ?? 0, active: initial.active ?? true,
    source: initial.optionsSource ?? null as FieldDef['optionsSource'],
  });
  const [error, setError] = useState<unknown>(null);
  const isSelect = f.type === 'select' || f.type === 'multiselect';
  const kinds = f.source ? sources[f.source.provider] : [];
  const save = async (thenSync = false) => {
    const body = {
      scope: f.scope, key: f.key.trim() || f.name.trim(), name: f.name.trim(), type: f.type,
      options: isSelect ? f.options.split('\n').map((x) => x.trim()).filter(Boolean) : [],
      required: f.required, projectKey: f.projectKey || null, description: f.description.trim() || null, sortOrder: f.sortOrder, active: f.active,
      optionsSource: isSelect && f.source ? f.source : null,
    };
    try {
      const r = initial.id ? await api<{ id: string }>('PUT', `/api/admin/fields/${initial.id}`, body) : await api<{ id: string }>('POST', '/api/admin/fields', body);
      if (thenSync && body.optionsSource) {
        const s = await api<{ options: string[]; error: string | null }>('POST', `/api/admin/fields/${r.id}/sync-options`);
        if (s.error) toast(`Gespeichert, Abgleich fehlgeschlagen: ${s.error}`, 'bad'); else toast(`Gespeichert, ${s.options.length} Werte übernommen`);
      } else toast(`Feld „${body.name}“ gespeichert`);
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal title={initial.id ? `Feld „${initial.name}“ bearbeiten` : 'Neues Feld'} help="admin-fields" onClose={onClose}
      footer={<><span className="spacer" /><button onClick={onClose}>Abbrechen</button>
        {isSelect && f.source && <button onClick={() => save(true)} disabled={!f.name.trim()}>Speichern &amp; Werte abgleichen</button>}
        <button className="primary" onClick={() => save()} disabled={!f.name.trim()}>Speichern</button></>}>
      <ErrorNote error={error} />
      <div className="grid2">
        <label className="field">Name<input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Team, Zielversion" /></label>
        <label className="field">Schlüssel<input value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} placeholder={f.name || 'wie Name'} disabled={!!initial.id && !!initial.key}
          title="Speicherort der Werte; übernommene Werte mit gleichem Schlüssel werden zugeordnet" /></label>
        <label className="field">Bereich<select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as FieldScope })}>{SCOPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
        <label className="field">Typ<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as FieldType })}>{TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
        <label className="field">Gilt für<select value={f.projectKey} onChange={(e) => setF({ ...f, projectKey: e.target.value })}>
          <option value="">alle Projekte</option>{projects.map((p) => <option key={p.key} value={p.key}>{p.key} – {p.name}</option>)}</select></label>
        <label className="field">Reihenfolge<input type="number" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: Number(e.target.value) })} /></label>
      </div>
      {isSelect && <div className="stack">
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={!!f.source}
          onChange={(e) => setF({ ...f, source: e.target.checked ? { provider: sources.openproject.length ? 'openproject' : 'jira', kind: 'versions', project: '' } : null })} />
          Auswahlwerte aus Jira bzw. OpenProject abgleichen (regelmäßig im eingestellten Takt, Standard alle 6 Stunden, und auf Knopfdruck)</label>
        {f.source ? <div className="grid3">
          <label className="field">System<select value={f.source.provider} onChange={(e) => setF({ ...f, source: { ...f.source!, provider: e.target.value as 'jira' | 'openproject', kind: 'versions' } })}>
            <option value="openproject" disabled={!sources.openproject.length}>OpenProject{sources.openproject.length ? '' : ' (nicht eingerichtet)'}</option>
            <option value="jira" disabled={!sources.jira.length}>Jira{sources.jira.length ? '' : ' (nicht eingerichtet)'}</option></select></label>
          <label className="field">Werte<select value={f.source.kind} onChange={(e) => setF({ ...f, source: { ...f.source!, kind: e.target.value } })}>
            {(kinds.length ? kinds : ['versions']).map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}</select></label>
          {!['priorities', 'statuses'].includes(f.source.kind) && <label className="field">Projekt ({f.source.provider === 'jira' ? 'Schlüssel' : 'Kennung'})
            <input value={f.source.project ?? ''} onChange={(e) => setF({ ...f, source: { ...f.source!, project: e.target.value } })} placeholder={f.source.provider === 'jira' ? 'PROJ' : 'qa-projekt'} /></label>}
          {f.source.kind === 'customfield' && <label className="field">Feld-ID<input value={f.source.fieldId ?? ''} onChange={(e) => setF({ ...f, source: { ...f.source!, fieldId: e.target.value } })}
            placeholder={f.source.provider === 'jira' ? 'customfield_10100' : 'customField7'} /></label>}
        </div> : <label className="field">Werte (je Zeile einer)<textarea rows={6} value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} placeholder={'Alpha\nBeta'} /></label>}
      </div>}
      <label className="field">Beschreibung / Hilfetext<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      <div className="row">
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={f.required} onChange={(e) => setF({ ...f, required: e.target.checked })} /> Pflichtfeld (beim Anlegen und Bearbeiten in der Oberfläche)</label>
        <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> aktiv</label>
      </div>
    </Modal>
  );
}

function Priorities({ list, onChanged, onError }: { list: Priority[]; onChanged: () => void; onError: (e: unknown) => void }) {
  const [adding, setAdding] = useState('');
  const save = async (code: string, p: Partial<Priority>) => {
    const cur = list.find((x) => x.code === code);
    try {
      await api('PUT', `/api/admin/priorities/${encodeURIComponent(code)}`, {
        color: p.color ?? cur?.color ?? '#888888', sortOrder: p.sortOrder ?? cur?.sortOrder ?? (list.length + 1) * 10,
        isDefault: p.isDefault ?? cur?.isDefault ?? false, active: p.active ?? cur?.active ?? true, description: p.description ?? cur?.description ?? null,
      });
      onChanged();
      return true;
    } catch (e) {
      onError(e);
      return false;
    }
  };
  const remove = async (code: string) => {
    if (!(await askConfirm({ title: `Priorität „${code}“ löschen`, message: 'Löschen geht nur, solange kein Testfall diese Priorität nutzt – sonst bitte deaktivieren. Abfragen und Ansichten mit dieser Priorität finden danach nichts mehr.', confirmLabel: 'Löschen', danger: true }))) return;
    try { await api('DELETE', `/api/admin/priorities/${encodeURIComponent(code)}`); toast(`Priorität „${code}“ gelöscht`); onChanged(); } catch (e) { onError(e); }
  };
  return (
    <div className="card"><div className="card-body stack">
      <h3>Prioritäten</h3>
      <p className="small muted">Werteliste für die Priorität von Testfällen. Kleinere Reihenfolge = wichtiger (gilt auch für „priorität &gt; Schwer“ in der Abfrage).
        Übernommene Werte, die nicht in der Liste stehen, bleiben an den Testfällen erhalten.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Bezeichnung</th><th className="fit">Farbe</th><th className="fit">Reihenfolge</th><th className="fit">Standard</th><th className="fit">aktiv</th><th className="fit" /></tr></thead>
        <tbody>{list.map((p) => <PriorityRow key={`${p.code}-${p.color}-${p.sortOrder}`} p={p} save={save} remove={remove} />)}</tbody>
      </table></div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (adding.trim()) { void save(adding.trim(), {}); setAdding(''); } }}>
        <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Neue Priorität, z. B. Hoch" style={{ maxWidth: 260 }} aria-label="Neue Priorität" />
        <button className="small" disabled={!adding.trim()}>+ Priorität</button>
      </form>
    </div></div>
  );
}

/** Eine Priorität: Farbe und Reihenfolge erst mit „Speichern“ bzw. Enter übernehmen (kein Speichern je Tastendruck). */
function PriorityRow({ p, save, remove }: { p: Priority; save: (code: string, v: Partial<Priority>) => Promise<boolean>; remove: (code: string) => Promise<void> }) {
  const [color, setColor] = useState(p.color);
  const [order, setOrder] = useState(String(p.sortOrder));
  const dirty = color !== p.color || Number(order) !== p.sortOrder;
  const valid = order.trim() !== '' && Number.isFinite(Number(order));
  const apply = async () => {
    if (!dirty || !valid) return;
    if (await save(p.code, { color, sortOrder: Number(order) })) toast(`Priorität „${p.code}“ gespeichert`);
  };
  return (
    <tr className={p.active ? '' : 'muted'}>
      <td><span className="prio"><span className="prio-dot" style={{ background: color }} />{p.code}</span></td>
      <td className="fit"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label={`Farbe ${p.code}`} style={{ width: 44, padding: 0 }} /></td>
      <td className="fit"><input type="number" value={order} style={{ width: 80 }} onChange={(e) => setOrder(e.target.value)} aria-label={`Reihenfolge ${p.code}`}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void apply(); } }} /></td>
      <td className="fit"><input type="radio" name="prio-default" checked={p.isDefault} onChange={() => void save(p.code, { isDefault: true }).then((ok) => ok && toast(`„${p.code}“ ist jetzt Standard`))} aria-label={`${p.code} als Standard`} /></td>
      <td className="fit"><input type="checkbox" style={{ width: 'auto' }} checked={p.active} onChange={(e) => void save(p.code, { active: e.target.checked, isDefault: e.target.checked ? p.isDefault : false })} aria-label={`${p.code} aktiv`} /></td>
      <td className="fit" style={{ whiteSpace: 'nowrap' }}>
        {dirty && <><button className="small" onClick={() => { setColor(p.color); setOrder(String(p.sortOrder)); }}>Verwerfen</button>{' '}
          <button className="small primary" disabled={!valid} title={valid ? undefined : 'Reihenfolge muss eine Zahl sein'} onClick={() => void apply()} aria-label={`Priorität ${p.code} speichern`}>Speichern</button>{' '}</>}
        <button className="small ghost danger" onClick={() => void remove(p.code)} title="Nur unbenutzte Prioritäten; sonst deaktivieren" aria-label={`Priorität ${p.code} löschen`}>✕</button></td>
    </tr>
  );
}
