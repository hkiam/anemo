import { useState } from 'react';
import { api, useApi } from '../../api.ts';
import { ErrorNote, Modal } from '../../components/common.tsx';
import type { Directory } from './ProjectMembers.tsx';
import { askConfirm } from '../../ux.tsx';
import { grantsOf, PERMISSION_LABEL, usePermissionGrants, useTransferPermission } from './Permissions.tsx';

interface Group { id: string; name: string; description: string | null; members: { id: string; username: string; displayName: string }[] }

export function Groups() {
  const groups = useApi<Group[]>('/api/admin/groups');
  const [editing, setEditing] = useState<Group | 'new' | null>(null);
  const grants = usePermissionGrants();
  return (
    <div className="stack">
      <div className="row">
        <h2>Gruppen</h2><span className="muted small">Rollen in Projekten können ganzen Gruppen zugewiesen werden.</span><span className="spacer" />
        <button className="primary" onClick={() => setEditing('new')}>+ Gruppe</button>
      </div>
      <ErrorNote error={groups.error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Gruppe</th><th>Beschreibung</th><th>Mitglieder</th><th>Rechte</th><th className="fit" /></tr></thead>
          <tbody>
            {groups.data?.length === 0 && <tr><td colSpan={5} className="empty">Noch keine Gruppen.</td></tr>}
            {groups.data?.map((g) => (
              <tr key={g.id}>
                <td><strong>{g.name}</strong></td>
                <td className="small">{g.description ?? '–'}</td>
                <td className="small">{g.members.map((m) => m.displayName).join(', ') || '–'}</td>
                <td className="small">{grantsOf(grants.data, 'group', g.id).map((x) => PERMISSION_LABEL[x] ?? x).join(', ') || '–'}</td>
                <td className="fit"><button className="small" onClick={() => setEditing(g)}>Bearbeiten</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <GroupEditor group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); groups.reload(); grants.reload(); }} />}
    </div>
  );
}

function GroupEditor({ group, onClose, onSaved }: { group: Group | null; onClose: () => void; onSaved: () => void }) {
  const dir = useApi<Directory>('/api/directory');
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [members, setMembers] = useState<Set<string>>(new Set(group?.members.map((m) => m.id)));
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<unknown>(null);
  const transfer = useTransferPermission('group', group?.id);

  async function save() {
    try {
      const id = group?.id ?? (await api<{ id: string }>('POST', '/api/admin/groups', { name, description: description || null })).id;
      await api('PUT', `/api/admin/groups/${id}`, { name, description: description || null, memberIds: [...members] });
      await transfer.commit(id);
      onSaved();
    } catch (e) {
      setError(e);
    }
  }
  async function remove() {
    if (!group || !(await askConfirm({ title: 'Gruppe löschen', message: `Gruppe „${group.name}“ löschen? Projektrollen der Gruppe entfallen.`, confirmLabel: 'Löschen', danger: true }))) return;
    try {
      await api('DELETE', `/api/admin/groups/${group.id}`);
      onSaved();
    } catch (e) {
      setError(e);
    }
  }
  const users = (dir.data?.users ?? []).filter((u) => `${u.username} ${u.displayName}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Modal title={group ? `Gruppe ${group.name}` : 'Neue Gruppe'} help="admin-groups" onClose={onClose}
      footer={<>{group && <button className="danger" onClick={remove}>Löschen</button>}<span className="spacer" />
        <button onClick={onClose}>Abbrechen</button><button className="primary" onClick={save} disabled={!name.trim()}>Speichern</button></>}>
      <ErrorNote error={error} />
      <div className="grid2">
        <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <label className="field">Beschreibung<input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      </div>
      {transfer.checkbox}
      <div className="row"><strong>Mitglieder</strong><span className="muted small">{members.size} ausgewählt</span><span className="spacer" />
        <input placeholder="Benutzer filtern …" aria-label="Benutzer filtern" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 200 }} /></div>
      <div className="table-wrap" style={{ maxHeight: 320 }}>
        <table>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="fit"><input type="checkbox" style={{ width: 'auto' }} checked={members.has(u.id)} aria-label={u.username}
                  onChange={(e) => setMembers((m) => { const n = new Set(m); if (e.target.checked) n.add(u.id); else n.delete(u.id); return n; })} /></td>
                <td>{u.displayName}</td><td className="small muted">{u.username}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
