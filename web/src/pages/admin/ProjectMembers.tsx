import { useState } from 'react';
import { api, useApi } from '../../api.ts';
import { ErrorNote } from '../../components/common.tsx';
import { type Role, ROLE_LABEL } from '../../session.tsx';
import { askConfirm } from '../../ux.tsx';

export interface Directory { users: { id: string; username: string; displayName: string }[]; groups: { id: string; name: string }[] }
interface Member { principalType: 'user' | 'group'; principalId: string; name: string; role: Role }

const ROLES: Role[] = ['VIEWER', 'TESTER', 'DESIGNER', 'PROJECT_ADMIN'];
const ROLE_HINT: Record<Role, string> = {
  VIEWER: 'Testfälle, Zyklen und Ergebnisse lesen',
  TESTER: 'zusätzlich ausführen, Ergebnisse und Evidenzen erfassen, zuweisen',
  DESIGNER: 'zusätzlich Testfälle, Ordner, Zyklen und Pläne pflegen',
  PROJECT_ADMIN: 'zusätzlich Mitglieder und Rollen des Projekts verwalten',
};

/** Mitglieder und Rollen eines Projekts – für Systemadmins und Projektadmins. */
export function ProjectMembers({ projectKey }: { projectKey: string }) {
  const members = useApi<Member[]>(`/api/projects/${projectKey}/members`);
  const dir = useApi<Directory>('/api/directory');
  const [principal, setPrincipal] = useState('');
  const [role, setRole] = useState<Role>('TESTER');
  const [error, setError] = useState<unknown>(null);

  async function set(principalType: 'user' | 'group', principalId: string, r: Role | null) {
    setError(null);
    try {
      await api('PUT', `/api/projects/${projectKey}/members`, { principalType, principalId, role: r });
      members.reload();
    } catch (e) {
      setError(e);
    }
  }
  const taken = new Set(members.data?.map((m) => `${m.principalType}:${m.principalId}`));

  return (
    <div className="stack">
      <ErrorNote error={error ?? members.error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Mitglied</th><th className="fit">Art</th><th className="fit">Rolle</th><th className="fit" /></tr></thead>
          <tbody>
            {members.data?.length === 0 && <tr><td colSpan={4} className="empty">Keine ausdrücklichen Mitglieder.</td></tr>}
            {members.data?.map((m) => (
              <tr key={`${m.principalType}:${m.principalId}`}>
                <td>{m.name}</td>
                <td className="fit small">{m.principalType === 'group' ? 'Gruppe' : 'Benutzer'}</td>
                <td className="fit">
                  <select value={m.role} onChange={(e) => set(m.principalType, m.principalId, e.target.value as Role)} aria-label={`Rolle ${m.name}`}>
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                </td>
                <td className="fit"><button className="ghost small danger" title="entfernen" aria-label={`${m.name} aus dem Projekt entfernen`} onClick={async () => {
                  if (!(await askConfirm({ title: `${m.name} entfernen`, message: `${m.principalType === 'group' ? 'Die Gruppe' : m.name} verliert die Rolle „${ROLE_LABEL[m.role]}“ in ${projectKey}. Zuweisungen und Ergebnisse bleiben erhalten; Zugriff besteht danach nur noch über andere Gruppen oder die Projektsichtbarkeit.`, confirmLabel: 'Entfernen', danger: true }))) return;
                  await set(m.principalType, m.principalId, null);
                }}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <select value={principal} onChange={(e) => setPrincipal(e.target.value)} aria-label="Benutzer oder Gruppe" style={{ maxWidth: 320 }}>
          <option value="">Benutzer oder Gruppe hinzufügen …</option>
          <optgroup label="Gruppen">
            {dir.data?.groups.filter((g) => !taken.has(`group:${g.id}`)).map((g) => <option key={g.id} value={`group:${g.id}`}>{g.name}</option>)}
          </optgroup>
          <optgroup label="Benutzer">
            {dir.data?.users.filter((u) => !taken.has(`user:${u.id}`)).map((u) => <option key={u.id} value={`user:${u.id}`}>{u.displayName} ({u.username})</option>)}
          </optgroup>
        </select>
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Rolle" style={{ width: 'auto' }}>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <button className="primary" disabled={!principal} title={principal ? undefined : 'Erst Benutzer oder Gruppe wählen'} onClick={async () => {
          const [t, id] = principal.split(':') as ['user' | 'group', string];
          await set(t, id, role);
          setPrincipal('');
        }}>Hinzufügen</button>
      </div>
      <dl className="small muted role-legend">
        {ROLES.map((r) => <div key={r}><dt>{ROLE_LABEL[r]}</dt><dd>{ROLE_HINT[r]}</dd></div>)}
      </dl>
    </div>
  );
}
