import { useState } from 'react';
import { api, useApi } from '../../api.ts';
import { ErrorNote, Modal } from '../../components/common.tsx';
import { askConfirm } from '../../ux.tsx';

interface Options {
  organization: string; accentColor: string; footer: string; standardNote: boolean; signoffRoles: string[];
  sections: Record<'summary' | 'environment' | 'executions' | 'steps' | 'comments' | 'defects' | 'openItems' | 'evidence' | 'signoff', boolean>;
}
interface Profile { id: string; name: string; isDefault: boolean; options: Options }

const SECTIONS: [keyof Options['sections'], string][] = [
  ['summary', 'Zusammenfassung (Kennzahlen, Statusverteilung)'], ['environment', 'Testgegenstand, Umgebung, Konfiguration, Umfang'],
  ['executions', 'Protokoll der Ausführungen'], ['steps', 'Schrittergebnisse je Ausführung'], ['comments', 'Befunde/Kommentare'],
  ['defects', 'Fehlerwirkungen und verknüpfte Fehler'], ['openItems', 'Offene Punkte'], ['evidence', 'Evidenzen (Screenshots, Dateien)'],
  ['signoff', 'Freigabe-/Unterschriftenblock'],
];

/** Administration: Berichtsprofile für Testprotokoll, Abschlussbericht, Spezifikation und Lieferpaket (ADR-0016). */
export function ReportProfiles() {
  const list = useApi<Profile[]>('/api/report-profiles');
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);
  return (
    <div className="stack">
      <div className="row"><h2>Berichtsprofile</h2><span className="spacer" /><button className="primary" onClick={() => setEditing('new')}>+ Profil</button></div>
      <p className="small muted">Ein Profil legt Aufbau und Erscheinungsbild der Berichte fest (in Anlehnung an ISO/IEC/IEEE 29119-3).
        Berichte werden unter „📄 Berichte“ in Planung, Zyklus und Testfällen erzeugt; als PDF über „Drucken → Als PDF speichern“.</p>
      <ErrorNote error={list.error} />
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Organisation</th><th>Abschnitte</th><th className="fit" /></tr></thead>
        <tbody>{list.data?.map((p) => (
          <tr key={p.id}>
            <td><span className="status-dot" style={{ background: p.options.accentColor, marginRight: 6 }} />{p.name}{p.isDefault && <span className="badge accent" style={{ marginLeft: 6 }}>Standard</span>}</td>
            <td className="small">{p.options.organization || '–'}</td>
            <td className="small muted">{SECTIONS.filter(([k]) => p.options.sections[k]).length} von {SECTIONS.length}</td>
            <td className="fit"><button className="small" onClick={() => setEditing(p)}>Bearbeiten</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      {editing && <ProfileEditor profile={editing === 'new' ? null : editing} template={list.data?.[0]?.options}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
    </div>
  );
}

function ProfileEditor({ profile, template, onClose, onSaved }: { profile: Profile | null; template?: Options; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(profile?.name ?? '');
  const [isDefault, setDefault] = useState(profile?.isDefault ?? false);
  const [o, setO] = useState<Options>(() => structuredClone(profile?.options ?? template ?? {
    organization: '', accentColor: '#3451b2', footer: '', standardNote: true, signoffRoles: ['Testmanagement'],
    sections: Object.fromEntries(SECTIONS.map(([k]) => [k, true])) as Options['sections'],
  }));
  const [roles, setRoles] = useState(o.signoffRoles.join('\n'));
  const [error, setError] = useState<unknown>(null);
  async function save() {
    const body = { name, isDefault, options: { ...o, signoffRoles: roles.split('\n').map((r) => r.trim()).filter(Boolean) } };
    try {
      if (profile) await api('PUT', `/api/admin/report-profiles/${profile.id}`, body);
      else await api('POST', '/api/admin/report-profiles', body);
      onSaved();
    } catch (e) {
      setError(e);
    }
  }
  async function remove() {
    if (!profile || !(await askConfirm({ title: 'Profil löschen', message: `Profil „${profile.name}“ löschen?`, confirmLabel: 'Löschen', danger: true }))) return;
    try {
      await api('DELETE', `/api/admin/report-profiles/${profile.id}`);
      onSaved();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Modal title={profile ? `Berichtsprofil „${profile.name}“` : 'Neues Berichtsprofil'} help="admin-report-profiles" onClose={onClose}
      footer={<>{profile && !profile.isDefault && <button className="danger" onClick={remove}>Löschen</button>}<span className="spacer" />
        <button onClick={onClose}>Abbrechen</button><button className="primary" onClick={save} disabled={!name.trim()}>Speichern</button></>}>
      <ErrorNote error={error} />
      <div className="grid2">
        <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <label className="field">Organisation (Kopfzeile)<input value={o.organization} onChange={(e) => setO({ ...o, organization: e.target.value })} placeholder="z. B. Beispiel GmbH – Qualitätssicherung" /></label>
        <label className="field">Akzentfarbe<input type="color" value={o.accentColor} onChange={(e) => setO({ ...o, accentColor: e.target.value })} style={{ height: 34, padding: 2 }} /></label>
        <label className="field">Fußzeile<input value={o.footer} onChange={(e) => setO({ ...o, footer: e.target.value })} placeholder="z. B. Vertraulich" /></label>
      </div>
      <div className="grid2">
        <div className="field">Abschnitte
          {SECTIONS.map(([k, label]) => (
            <label key={k} className="row" style={{ color: 'var(--text)' }}><input type="checkbox" style={{ width: 'auto' }} checked={o.sections[k]}
              onChange={(e) => setO({ ...o, sections: { ...o.sections, [k]: e.target.checked } })} />{label}</label>
          ))}
        </div>
        <div className="stack">
          <label className="field">Rollen im Freigabeblock (je Zeile eine)<textarea rows={5} value={roles} onChange={(e) => setRoles(e.target.value)} /></label>
          <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={o.standardNote} onChange={(e) => setO({ ...o, standardNote: e.target.checked })} />Hinweis „in Anlehnung an ISO/IEC/IEEE 29119-3“</label>
          <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={isDefault} onChange={(e) => setDefault(e.target.checked)} />Standardprofil</label>
        </div>
      </div>
    </Modal>
  );
}
