import type { ReactNode } from 'react';
import { href } from '../../router.ts';

export const ADMIN_SECTIONS: { path: string[]; label: string; group: string }[] = [
  { path: ['admin', 'users'], label: 'Benutzer', group: 'Benutzer & Rechte' },
  { path: ['admin', 'groups'], label: 'Gruppen', group: 'Benutzer & Rechte' },
  { path: ['admin', 'projects'], label: 'Projekte & Rechte', group: 'Benutzer & Rechte' },
  { path: ['admin', 'auth'], label: 'Anmeldung (SSO/LDAP)', group: 'Benutzer & Rechte' },
  { path: ['admin', 'transfers'], label: 'Projektübertragungen', group: 'Benutzer & Rechte' },
  { path: ['admin', 'workflow'], label: 'Status & Workflow', group: 'Testmanagement' },
  { path: ['admin', 'fields'], label: 'Felder & Prioritäten', group: 'Testmanagement' },
  { path: ['configurations'], label: 'Testkonfigurationen', group: 'Testmanagement' },
  { path: ['admin', 'templates'], label: 'Fehlervorlagen', group: 'Testmanagement' },
  { path: ['admin', 'field-templates'], label: 'Feldvorlagen', group: 'Testmanagement' },
  { path: ['admin', 'reports'], label: 'Berichtsprofile', group: 'Testmanagement' },
  { path: ['admin', 'mail'], label: 'E-Mail', group: 'Benachrichtigungen' },
  { path: ['admin', 'webhooks'], label: 'Webhooks & Chat', group: 'Benachrichtigungen' },
  { path: ['admin', 'integrations'], label: 'Übersicht', group: 'Anbindungen' },
  { path: ['admin', 'openproject'], label: 'OpenProject', group: 'Anbindungen' },
  { path: ['admin', 'gitlab'], label: 'GitLab', group: 'Anbindungen' },
  { path: ['admin', 'jira'], label: 'Jira (Parallelbetrieb)', group: 'Anbindungen' },
  { path: ['admin', 'automation'], label: 'CI & KI-Agenten', group: 'Anbindungen' },
  { path: ['admin', 'ai'], label: 'Modelle & Skills', group: 'KI' },
  { path: ['admin', 'settings'], label: 'Allgemein', group: 'System' },
  { path: ['migration'], label: 'Migration', group: 'System' },
  { path: ['events'], label: 'Ereignisse', group: 'System' },
];

/** Administrationsbereich: Navigation links, Inhalt rechts. */
export function AdminLayout({ active, children }: { active: string; children: ReactNode }) {
  const groups = [...new Set(ADMIN_SECTIONS.map((s) => s.group))];
  return (
    <div className="admin">
      <nav className="admin-nav" aria-label="Administration">
        <div className="admin-title">Administration</div>
        {groups.map((g) => (
          <div key={g} className="admin-group">
            <div className="admin-group-title">{g}</div>
            {ADMIN_SECTIONS.filter((s) => s.group === g).map((s) => (
              <a key={s.label} href={href(s.path)} className={s.path.join('/') === active ? 'active' : ''} aria-current={s.path.join('/') === active ? 'page' : undefined}>{s.label}</a>
            ))}
          </div>
        ))}
      </nav>
      <div className="admin-content">{children}</div>
    </div>
  );
}

export function Planned({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="stack">
      <h2>{title}</h2>
      <div className="notice warn">In Vorbereitung – siehe Roadmap.</div>
      <div className="small">{children}</div>
    </div>
  );
}
