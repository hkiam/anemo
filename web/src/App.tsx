import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, UNAUTHORIZED_EVENT, useApi } from './api.ts';
import { Cycles } from './pages/Cycles.tsx';
import { Events } from './pages/Events.tsx';
import { Login } from './pages/Login.tsx';
import { ForcedPasswordChange, PasswordResetPage } from './pages/PasswordPages.tsx';
import { Migration } from './pages/Migration.tsx';
import { Health } from './pages/Health.tsx';
import { Help } from './pages/Help.tsx';
import { Repository } from './pages/Repository.tsx';
import { SearchPage } from './pages/SearchPage.tsx';
import { Start } from './pages/Start.tsx';
import { Portfolio } from './pages/Portfolio.tsx';
import { ConfigAdmin } from './pages/ConfigAdmin.tsx';
import { AdminLayout } from './pages/admin/Admin.tsx';
import { AccessLog } from './pages/admin/AccessLog.tsx';
import { Groups } from './pages/admin/Groups.tsx';
import { AuthAdmin, AutomationAdmin, GitLabAdmin, Integrations, JiraAdmin, MailAdmin, OpenProjectAdmin, TemplatesAdmin, WebhooksAdmin } from './pages/admin/Integrations.tsx';
import { ProjectMembers } from './pages/admin/ProjectMembers.tsx';
import { Projects } from './pages/admin/Projects.tsx';
import { ReportProfiles } from './pages/admin/ReportProfiles.tsx';
import { StatusWorkflow } from './pages/admin/StatusWorkflow.tsx';
import { Users } from './pages/admin/Users.tsx';
import { Ai } from './pages/admin/Ai.tsx';
import { Settings } from './pages/admin/Settings.tsx';
import { FieldsAdmin } from './pages/admin/FieldsAdmin.tsx';
import { AccountMenu } from './components/Account.tsx';
import { QuickSearch } from './components/Search.tsx';
import { AiContextDialog } from './components/AiContext.tsx';
import { href, navigate, type Route, useRoute } from './router.ts';
import { FocusApp } from './pages/Focus.tsx';
import { DialogHost, ShortcutHelp, Toasts, usePageTitle, useSync } from './ux.tsx';
import { type Me, ROLE_LABEL, SessionContext, setCurrentSession, useCan } from './session.tsx';
import type { Project } from './types.ts';
import { BrandMark } from './components/Brand.tsx';
import { HelpPanel, HelpToggle } from './components/HelpPanel.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { GoTo } from './pages/GoTo.tsx';
import { FieldTemplatesAdmin } from './pages/admin/FieldTemplates.tsx';
import { TransfersAdmin } from './pages/admin/Transfers.tsx';
import { TransferPage } from './pages/Transfer.tsx';

/** Lädt die Sitzung; ohne Anmeldung erscheint die Anmeldeseite. */
export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => {
    api<Me>('GET', '/api/auth/me').then(
      (m) => { setCurrentSession(m); setMe(m); },
      (e) => { if (e instanceof ApiError && e.status === 401) setMe(null); else setError(e); },
    );
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const on = () => { setCurrentSession(null); setMe(null); };
    window.addEventListener(UNAUTHORIZED_EVENT, on);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, on);
  }, []);

  // Link aus der E-Mail zum Zurücksetzen: unabhängig von einer Anmeldung
  if (window.location.hash.startsWith('#/kennwort-zuruecksetzen')) return <PasswordResetPage />;
  if (error) return <div className="empty">Anemo ist nicht erreichbar: {String((error as Error).message ?? error)}</div>;
  if (me === undefined) return <div className="empty" role="status">Lädt …</div>;
  if (me === null) return <Login onLoggedIn={load} />;
  if (me.mustChangePassword) {
    return <ForcedPasswordChange username={me.username} minLength={me.minPasswordLength ?? 12} onDone={load}
      onLogout={() => api('POST', '/api/auth/logout').finally(() => { setCurrentSession(null); setMe(null); })} />;
  }
  return (
    <SessionContext.Provider value={me}>
      <Toasts />
      <DialogHost />
      <ShortcutHelp />
      <Shell me={me} onLogout={() => api<{ logoutUrl: string | null }>('POST', '/api/auth/logout').then((r) => {
        setCurrentSession(null);
        // SSO-Konten auch beim Identitätsanbieter abmelden (Keycloak/Entra ID)
        if (r?.logoutUrl) window.location.href = r.logoutUrl; else setMe(null);
      }, () => { setCurrentSession(null); setMe(null); })} onReload={load} />
    </SessionContext.Provider>
  );
}

function Shell({ me, onLogout, onReload }: { me: Me; onLogout: () => void; onReload: () => void }) {
  const route = useRoute();
  // Fokusfenster (#/f/…): ohne Hauptnavigation, maximale Fläche für eine Aufgabe
  if (route.path[0] === 'f') return <FocusApp route={route} />;
  return <MainShell me={me} route={route} onLogout={onLogout} onReload={onReload} />;
}

const PAGE_TITLE: Record<string, string> = { start: 'Start', repo: 'Testfälle', cycles: 'Planung & Ausführung', health: 'Test-Health', members: 'Mitglieder' };

function MainShell({ me, route, onLogout, onReload }: { me: Me; route: Route; onLogout: () => void; onReload: () => void }) {
  const projects = useApi<Project[]>('/api/projects');
  useSync(['project'], () => projects.reload());
  const [section, projectKey, page] = route.path;
  const stored = localStorage.getItem('anemo.project');
  const visibleKeys = projects.data?.map((p) => p.key) ?? [];
  const activeProject = section === 'p' ? projectKey : (stored && visibleKeys.includes(stored) ? stored : projects.data?.[0]?.key);
  const canManage = useCan(activeProject, 'manage');
  usePageTitle(section === 'p' ? `${PAGE_TITLE[page ?? 'repo'] ?? 'Testfälle'} · ${projectKey}` : section === 'hilfe' ? 'Hilfe' : section === 'search' ? 'Suche' : section === 'portfolio' ? 'Portfolio' : section === 'transfer' ? 'Projekte übertragen' : section ? 'Administration' : null);

  // Seitenwechsel: Titel ansagen und den Fokus auf die Hauptüberschrift setzen (nicht beim ersten Laden und nicht bei
  // Wechseln innerhalb einer Seite wie Testfall- oder Zyklusauswahl)
  const mainRef = useRef<HTMLElement>(null);
  const [announce, setAnnounce] = useState('');
  const pageKey = [section, projectKey, page].join('/');
  const firstPage = useRef(true);
  useEffect(() => {
    if (firstPage.current) { firstPage.current = false; return; }
    // auf die Überschrift der neuen Seite warten (Daten laden), höchstens etwa 1,5 s
    let tries = 0;
    let t = setTimeout(function step() {
      const main = mainRef.current;
      if (++tries < 8 && main && !main.querySelector('h1, h2')) { t = setTimeout(step, 200); return; }
      setAnnounce(document.title.replace(/ – Anemo$/, ''));
      focusMain(main, false);
    }, 150);
    return () => clearTimeout(t);
  }, [pageKey]);
  useEffect(() => {
    if (section === 'p' && projectKey) localStorage.setItem('anemo.project', projectKey);
  }, [section, projectKey]);
  useEffect(() => {
    // Startseite: Überblick und eigene Aufgaben (Inhalt richtet sich nach der Rolle)
    if (!section && projects.data?.length) navigate(['p', activeProject ?? projects.data[0]!.key, 'start']);
  }, [section, projects.data, activeProject]);

  const isAdminSection = section === 'admin' || section === 'migration' || section === 'events' || section === 'configurations';
  let content;
  if (section === 'portfolio') content = <Portfolio />;
  else if (section === 'p' && projectKey && page === 'start') content = <Start projectKey={projectKey} />;
  else if (section === 'p' && projectKey && page === 'cycles') content = <Cycles projectKey={projectKey} route={route} />;
  else if (section === 'p' && projectKey && page === 'health') content = <Health projectKey={projectKey} route={route} />;
  else if (section === 'p' && projectKey && page === 'members') content = (
    <div className="page"><div className="page-narrow stack">
      <h2>Mitglieder {projectKey}</h2>
      {canManage ? <ProjectMembers projectKey={projectKey} /> : <div className="notice warn">Nur für Projektadministration.</div>}
      {canManage && <ProjectAiContext projectKey={projectKey} />}
      {canManage && <FieldTemplatesAdmin projectKey={projectKey} />}
      {canManage && projects.data?.find((p) => p.key === projectKey)?.visibility === 'restricted' && <><h3>Zugriffsprotokoll</h3><AccessLog projectKey={projectKey} /></>}
    </div></div>
  );
  else if (section === 'p' && projectKey) content = <Repository projectKey={projectKey} route={route} />;
  else if (section === 'transfer') content = <TransferPage />;
  else if (section === 'hilfe') content = <Help route={route} />;
  else if (section === 'go') content = <GoTo route={route} />;
  else if (section === 'search') content = <SearchPage route={route} currentProject={activeProject} />;
  else if (isAdminSection) content = me.isSystemAdmin ? <AdminContent route={route} /> : <div className="empty">Nur für Systemadministration.</div>;
  else content = (
    <div className="page"><div className="page-narrow empty">
      {projects.data?.length === 0
        ? me.isSystemAdmin
          ? <>Noch keine Projekte. Starten Sie mit einem <a href={href(['migration'])}>Migrationsimport</a>.</>
          : 'Sie sind noch keinem Projekt zugeordnet. Bitte wenden Sie sich an die Administration.'
        : 'Lädt …'}
    </div></div>
  );

  return (
    <div className="app">
      <a className="skip-link" href="#inhalt" onClick={(e) => { e.preventDefault(); focusMain(mainRef.current, true); }}>Zum Inhalt</a>
      <header className="topbar">
        <a className="brand" href="#/" title="Zur Startseite" aria-label="Anemo – zur Startseite"><BrandMark />Anemo</a>
        <select aria-label="Projekt" value={activeProject ?? ''} onChange={(e) => navigate(['p', e.target.value, page === 'cycles' || page === 'health' || page === 'start' ? page : 'repo'])} style={{ width: 'auto', maxWidth: 260 }}>
          {projects.data?.map((p) => <option key={p.key} value={p.key}>{p.key} – {p.name}</option>)}
        </select>
        <nav className="nav" aria-label="Hauptnavigation">
          {navLink(page === 'start', href(['p', activeProject ?? '', 'start']), 'Start')}
          {navLink(section === 'p' && (!page || page === 'repo'), href(['p', activeProject ?? '', 'repo']), 'Testfälle')}
          {navLink(page === 'cycles', href(['p', activeProject ?? '', 'cycles']), 'Planung & Ausführung')}
          {navLink(page === 'health', href(['p', activeProject ?? '', 'health']), 'Test-Health')}
          {(projects.data?.length ?? 0) > 1 && navLink(section === 'portfolio', href(['portfolio']), 'Portfolio', 'Alle Projekte im Überblick')}
          {canManage && !me.isSystemAdmin && navLink(page === 'members', href(['p', activeProject ?? '', 'members']), 'Mitglieder')}
          {/* Systemadministration: über Administration → Projektübertragungen (die Kopfzeile bleibt schmal genug) */}
          {me.permissions?.includes('PROJECT_TRANSFER') && !me.isSystemAdmin && navLink(section === 'transfer', href(['transfer']), 'Übertragen', 'Projekte exportieren und importieren')}
          {me.isSystemAdmin && navLink(isAdminSection, href(['admin', 'users']), 'Administration')}
        </nav>
        <span className="spacer" />
        <QuickSearch />
        <HelpToggle />
        <AccountMenu me={me} roleLabel={activeProject && !me.isSystemAdmin && me.projectRoles[activeProject] ? ROLE_LABEL[me.projectRoles[activeProject]!] : null}
          onLogout={onLogout} onChanged={onReload} />
      </header>
      <div className="app-row"><main className="main" id="inhalt" ref={mainRef} tabIndex={-1}><ErrorBoundary resetKey={pageKey} area={pageKey}>{content}</ErrorBoundary></main><HelpPanel /></div>
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
    </div>
  );
}

function navLink(active: boolean, to: string, label: string, title?: string) {
  return <a className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} href={to} title={title}>{label}</a>;
}

/** Fokus auf die erste Überschrift des Inhalts (sonst den Inhalt selbst); nicht, wenn dort schon etwas fokussiert ist. */
function focusMain(main: HTMLElement | null, force: boolean) {
  if (!main) return;
  const active = document.activeElement;
  // nur übernehmen, wenn der Fokus auf dem Seitenkörper oder einem Navigationslink steht – nie aus einem Eingabefeld
  if (!force && active && active !== document.body && !(active instanceof HTMLAnchorElement && !main.contains(active))) return;
  if (!force && document.querySelector('.modal-backdrop')) return;
  const h = main.querySelector<HTMLElement>('h1, h2');
  const target = h && h.getClientRects().length ? h : main;
  if (target !== main && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: !force });
}

function AdminContent({ route }: { route: Route }) {
  const [section, sub] = route.path;
  const narrow = (n: React.ReactNode) => <div className="page"><div className="page-narrow">{n}</div></div>;
  const wide = (n: React.ReactNode) => <div className="page"><div className="page-wide">{n}</div></div>;
  let active = section === 'admin' ? `admin/${sub ?? 'users'}` : section!;
  let body;
  if (section === 'migration') body = <Migration route={route} />;
  else if (section === 'events') body = <Events />;
  else if (section === 'configurations') body = <ConfigAdmin />;
  else if (sub === 'groups') body = wide(<Groups />);
  else if (sub === 'projects') body = wide(<Projects />);
  else if (sub === 'workflow') body = narrow(<StatusWorkflow tab={route.path[2] === 'testcase' ? 'testcase' : 'execution'} />);
  else if (sub === 'integrations') body = narrow(<Integrations />);
  else if (sub === 'openproject') body = narrow(<OpenProjectAdmin />);
  else if (sub === 'gitlab') body = narrow(<GitLabAdmin />);
  else if (sub === 'jira') body = narrow(<JiraAdmin />);
  else if (sub === 'automation') body = narrow(<AutomationAdmin />);
  else if (sub === 'mail') body = narrow(<MailAdmin />);
  else if (sub === 'webhooks') body = wide(<WebhooksAdmin />);
  else if (sub === 'templates') body = wide(<TemplatesAdmin />);
  else if (sub === 'field-templates') body = wide(<FieldTemplatesAdmin />);
  else if (sub === 'auth') body = narrow(<AuthAdmin />);
  else if (sub === 'settings') body = narrow(<Settings />);
  else if (sub === 'ai') body = wide(<Ai />);
  else if (sub === 'reports') body = wide(<ReportProfiles />);
  else if (sub === 'fields') body = wide(<FieldsAdmin />);
  else if (sub === 'transfers') body = wide(<TransfersAdmin />);
  else {
    active = 'admin/users';
    body = wide(<Users />);
  }
  return <AdminLayout active={active}>{body}</AdminLayout>;
}

function ProjectAiContext({ projectKey }: { projectKey: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="row"><h3 style={{ flex: 1 }}>KI-Kontext</h3>
      <span className="small muted">Glossar und Stilregeln für KI-Vorschläge in diesem Projekt</span>
      <button className="small" onClick={() => setOpen(true)} aria-label="KI-Kontext bearbeiten">Bearbeiten …</button>
      {open && <AiContextDialog projectKey={projectKey} onClose={() => setOpen(false)} />}
    </div>
  );
}
