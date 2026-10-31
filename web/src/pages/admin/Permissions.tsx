import { useState } from 'react';
import { api, useApi } from '../../api.ts';

/** Instanzweite Rechte neben den Projektrollen (ADR-0027); Vergabe an Benutzer oder Gruppen. */
export interface PermissionGrant { principalType: 'user' | 'group'; principalId: string; name: string; permission: string; grantedBy: string; grantedAt: string }
interface Grants { permissions: string[]; grants: PermissionGrant[] }

export const PERMISSION_LABEL: Record<string, string> = { PROJECT_TRANSFER: 'Projekte übertragen' };

export function usePermissionGrants() {
  return useApi<Grants>('/api/admin/permissions');
}

export const grantsOf = (data: Grants | undefined, type: 'user' | 'group', id: string | undefined) =>
  (data?.grants ?? []).filter((g) => g.principalType === type && g.principalId === id).map((g) => g.permission);

/** Schalter „Projekte übertragen“ im Bearbeitungsdialog; `commit` speichert eine Änderung nach dem Anlegen/Speichern. */
export function useTransferPermission(type: 'user' | 'group', id: string | undefined) {
  const grants = usePermissionGrants();
  const initial = grantsOf(grants.data, type, id).includes('PROJECT_TRANSFER');
  const [value, setValue] = useState<boolean | null>(null);
  const checked = value ?? initial;
  return {
    checkbox: (
      <label className="row"><input type="checkbox" checked={checked} disabled={!grants.data} onChange={(e) => setValue(e.target.checked)} style={{ width: 'auto' }} />
        {PERMISSION_LABEL.PROJECT_TRANSFER} (ganze Projekte exportieren und importieren; zusätzlich Projektadministration im Projekt nötig)</label>
    ),
    async commit(principalId: string) {
      if (value === null || value === initial) return;
      await api('PUT', '/api/admin/permissions', { principalType: type, principalId, permission: 'PROJECT_TRANSFER', granted: value });
    },
  };
}
