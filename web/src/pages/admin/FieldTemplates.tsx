import { useState } from 'react';
import { api, useApi } from '../../api.ts';
import { ErrorNote, Modal, Wiki } from '../../components/common.tsx';
import { HelpButton } from '../../components/HelpPanel.tsx';
import { WikiEditor } from '../../wiki/WikiEditor.tsx';
import { askConfirm, toast } from '../../ux.tsx';

interface FieldTemplate { id: string; projectKey: string | null; name: string; fields: string[]; content: string; isDefault: boolean; updatedAt: string; updatedBy: string }

const FIELDS: [string, string][] = [['action', 'Aktion'], ['data', 'Testdaten'], ['expected', 'Erwartetes Ergebnis'], ['objective', 'Ziel / Beschreibung'],
  ['preconditions', 'Vorbedingungen'], ['testData', 'Testdaten (Testfall)']];
const fieldName = (f: string) => FIELDS.find(([k]) => k === f)?.[1] ?? f;

/**
 * Feldvorlagen (Stufe J5): systemweit (ohne projectKey, Systemadministration) bzw. für ein Projekt (Projektadministration).
 * Projektvorlagen ergänzen im Editor die systemweiten.
 */
export function FieldTemplatesAdmin({ projectKey }: { projectKey?: string }) {
  const list = useApi<FieldTemplate[]>(`/api/field-templates?scope=${projectKey ? 'project' : 'system'}${projectKey ? `&project=${projectKey}` : ''}`);
  const [editing, setEditing] = useState<FieldTemplate | 'new' | null>(null);
  const remove = async (t: FieldTemplate) => {
    if (!(await askConfirm({ title: 'Vorlage löschen', message: `Vorlage „${t.name}“ löschen? Bereits eingefügte Inhalte bleiben unverändert.`, confirmLabel: 'Löschen', danger: true }))) return;
    try { await api('DELETE', `/api/field-templates/${t.id}`); toast(`Vorlage „${t.name}“ gelöscht`); list.reload(); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  return (
    <div className="stack">
      <div className="row">{projectKey ? <h3>Feldvorlagen {projectKey}</h3> : <h2>Feldvorlagen</h2>}<HelpButton topic="field-templates" /><span className="spacer" />
        <button className="primary" onClick={() => setEditing('new')}>+ Vorlage</button></div>
      <p className="small muted">Formatierter Standardaufbau, den man im Editor über <b>📋</b> in der Werkzeugleiste eines Feldes einfügt – z. B. „Vorbedingung /
        Vorgehen“ in der Aktion. {projectKey ? 'Projektvorlagen ergänzen die systemweiten.' : 'Systemweite Vorlagen gelten in allen Projekten; Projekte können eigene ergänzen.'}
        {' '}Eine <b>Standardvorlage</b> füllt neue Schritte vor.</p>
      <ErrorNote error={list.error} />
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Felder</th><th>Vorschau</th><th>Geändert</th><th /></tr></thead>
        <tbody>
          {(list.data ?? []).map((t) => (
            <tr key={t.id}>
              <td><b>{t.name}</b>{t.isDefault && <span className="badge accent" style={{ marginLeft: 6 }} title="füllt neue Schritte vor">Standard</span>}</td>
              <td className="small">{t.fields.map(fieldName).join(', ')}</td>
              <td className="small tpl-preview"><Wiki text={t.content} compact /></td>
              <td className="small muted">{new Date(t.updatedAt).toLocaleDateString('de-DE')} · {t.updatedBy}</td>
              <td style={{ whiteSpace: 'nowrap' }}><button className="small" onClick={() => setEditing(t)}>Bearbeiten</button>
                <button className="small ghost danger" onClick={() => void remove(t)} aria-label={`Vorlage ${t.name} löschen`}>✕</button></td>
            </tr>
          ))}
          {list.data?.length === 0 && <tr><td colSpan={5} className="empty">Noch keine Vorlagen.</td></tr>}
        </tbody>
      </table></div>
      {editing && <TemplateEditor template={editing === 'new' ? null : editing} projectKey={projectKey} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
    </div>
  );
}

function TemplateEditor({ template, projectKey, onClose, onSaved }: { template: FieldTemplate | null; projectKey?: string | undefined; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(template?.name ?? '');
  const [fields, setFields] = useState<string[]>(template?.fields ?? ['action']);
  const [content, setContent] = useState(template?.content ?? '');
  const [isDefault, setDefault] = useState(template?.isDefault ?? false);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    try {
      const body = { name, fields, content, isDefault };
      if (template) await api('PUT', `/api/field-templates/${template.id}`, body);
      else await api('POST', '/api/field-templates', { ...body, project: projectKey ?? null });
      toast(`Vorlage „${name}“ gespeichert`);
      onSaved();
    } catch (e) { setError(e); }
  };
  return (
    <Modal title={template ? `Vorlage „${template.name}“` : 'Neue Feldvorlage'} help="field-templates" size="large" onClose={onClose}
      footer={<><button onClick={onClose}>Abbrechen</button><button className="primary" disabled={!name.trim() || !fields.length || !content.trim()} onClick={() => void save()}>Speichern</button></>}>
      <div className="stack">
        <ErrorNote error={error} />
        <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus /></label>
        <fieldset className="field multi"><legend>Für Felder</legend>
          <div className="row">{FIELDS.map(([k, l]) => (
            <label key={k} className="chip-toggle"><input type="checkbox" checked={fields.includes(k)} onChange={(e) => setFields((f) => (e.target.checked ? [...f, k] : f.filter((x) => x !== k)))} /> {l}</label>
          ))}</div>
        </fieldset>
        <div className="field">Inhalt<WikiEditor value={content} onChange={setContent} minRows={8} label="Inhalt der Vorlage" /></div>
        <label className="row small"><input type="checkbox" checked={isDefault} onChange={(e) => setDefault(e.target.checked)} style={{ width: 'auto' }} />
          Standard für neue Schritte (je Feld höchstens eine Standardvorlage{projectKey ? ' im Projekt; sie hat Vorrang vor der systemweiten' : ''})</label>
      </div>
    </Modal>
  );
}
