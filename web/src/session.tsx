import { createContext, useContext } from 'react';

export type Role = 'VIEWER' | 'TESTER' | 'DESIGNER' | 'PROJECT_ADMIN';
export type Level = 'read' | 'execute' | 'edit' | 'manage';

export interface Me {
  username: string;
  displayName: string;
  isSystemAdmin: boolean;
  authMode: 'on' | 'off';
  projectRoles: Record<string, Role>;
  /** instanzweite Rechte, z. B. PROJECT_TRANSFER („Projekte übertragen“) */
  permissions?: string[];
  /** Herkunft des Kontos (local, ldap, oidc); null ohne Anmeldung */
  source?: string | null;
  mustChangePassword?: boolean;
  passwordChangedAt?: string | null;
  minPasswordLength?: number;
}

const RANK: Record<Role, number> = { VIEWER: 1, TESTER: 2, DESIGNER: 3, PROJECT_ADMIN: 4 };
const NEEDS: Record<Level, Role> = { read: 'VIEWER', execute: 'TESTER', edit: 'DESIGNER', manage: 'PROJECT_ADMIN' };
export const ROLE_LABEL: Record<Role, string> = { VIEWER: 'Lesen', TESTER: 'Ausführen', DESIGNER: 'Pflegen', PROJECT_ADMIN: 'Projektadmin' };

export const SessionContext = createContext<Me | null>(null);

let current: Me | null = null;
export function setCurrentSession(me: Me | null): void {
  current = me;
}
/** Benutzername der Sitzung (für Texte außerhalb von React-Komponenten). */
export function currentUser(): string {
  return current?.username ?? '';
}

export function useSession(): Me {
  const me = useContext(SessionContext);
  if (!me) throw new Error('Keine Sitzung');
  return me;
}

/** Darf der Benutzer im Projekt die Stufe ausführen? (Die API prüft unabhängig davon.) */
export function useCan(projectKey: string | undefined, level: Level): boolean {
  const me = useContext(SessionContext);
  if (!me || !projectKey) return false;
  if (me.isSystemAdmin) return true;
  const role = me.projectRoles[projectKey];
  return !!role && RANK[role] >= RANK[NEEDS[level]];
}
