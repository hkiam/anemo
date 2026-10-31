/**
 * Kontextsensitive Hilfe: Themen → Abschnitt im Handbuch (docs/handbuch). Ein Thema verweist über die Überschrift
 * (Wortlaut) auf einen Abschnitt; ein Test prüft, dass es jede Überschrift gibt, damit die Hilfe nicht veraltet.
 */

export interface HelpTopic {
  /** Kurzer Titel in der Hilfe-Seitenleiste */
  title: string;
  /** Handbuchseite ohne .md (z. B. "03-planung-durchfuehrung") */
  page: string;
  /** Überschrift des Abschnitts (Wortlaut ohne #); ohne Angabe die ganze Seite */
  heading?: string;
  /** Verwandte Themen (IDs) */
  related?: string[];
}

export const HELP_TOPICS = {
  // Allgemein
  overview: { title: 'Übersicht', page: 'README', related: ['ui', 'start', 'roles'] },
  ui: { title: 'Die Oberfläche', page: '01-erste-schritte', heading: 'Die Oberfläche', related: ['search', 'roles'] },
  start: { title: 'Startseite', page: '01-erste-schritte', heading: 'Startseite', related: ['top-defects', 'mine'] },
  search: { title: 'Suchen', page: '01-erste-schritte', heading: 'Suchen', related: ['aql'] },
  roles: { title: 'Rollen', page: '01-erste-schritte', heading: 'Rollen', related: ['admin-projects'] },
  login: { title: 'Anmelden', page: '01-erste-schritte', heading: 'Anmelden' },
  'top-defects': { title: 'Top-Fehler und Team & Aufwand', page: '04-auswertung-berichte', heading: 'Startseite: Top-Fehler und Team & Aufwand' },

  // Testfälle
  testcases: { title: 'Testfälle finden und filtern', page: '02-testfaelle', heading: 'Finden und filtern', related: ['aql', 'folders', 'bulk-tc', 'tc-edit'] },
  aql: { title: 'Abfragesprache', page: '02-testfaelle', heading: 'Abfragesprache', related: ['testcases', 'exec-search'] },
  'bulk-tc': { title: 'Massenbearbeitung von Testfällen', page: '02-testfaelle', heading: 'Massenbearbeitung', related: ['testsets'] },
  folders: { title: 'Ordner', page: '02-testfaelle', heading: 'Ordner' },
  'tc-edit': { title: 'Testfälle anlegen und bearbeiten', page: '02-testfaelle', heading: 'Anlegen und bearbeiten', related: ['step-groups', 'preconditions', 'call-test', 'step-library', 'datasets', 'tc-ai'] },
  'step-groups': { title: 'Abschnitte', page: '02-testfaelle', heading: 'Abschnitte', related: ['tc-edit', 'execute'] },
  preconditions: { title: 'Wiederverwendbare Vorbedingungen', page: '02-testfaelle', heading: 'Wiederverwendbare Vorbedingungen' },
  'call-test': { title: 'Aufrufbare Tests', page: '02-testfaelle', heading: 'Aufrufbare Tests (Call Test)' },
  'step-library': { title: 'Schrittbibliothek', page: '02-testfaelle', heading: 'Schrittbibliothek' },
  estimate: { title: 'Schätzung', page: '02-testfaelle', heading: 'Schätzung (geplanter Aufwand)', related: ['planned-effort'] },
  'tc-archive': { title: 'Testfälle archivieren und löschen', page: '02-testfaelle', heading: 'Archivieren und löschen' },
  datasets: { title: 'Parametrisierte Tests', page: '02-testfaelle', heading: 'Parametrisierte Tests (Datensätze)' },
  testsets: { title: 'Testsets', page: '02-testfaelle', heading: 'Testsets' },
  'tc-ai': { title: 'KI-Unterstützung im Editor', page: '02-testfaelle', heading: 'KI-Unterstützung im Editor' },
  versions: { title: 'Versionen und Änderungen', page: '02-testfaelle', heading: 'Versionen und Änderungen' },
  'tc-workflow': { title: 'Status und Workflow', page: '02-testfaelle', heading: 'Status und Workflow', related: ['admin-workflow'] },
  attachments: { title: 'Anhänge', page: '02-testfaelle', heading: 'Anhänge' },
  watch: { title: 'Beobachten', page: '05-zusammenarbeit', heading: 'Beobachten', related: ['notifications'] },
  discussion: { title: 'Diskussion', page: '05-zusammenarbeit', heading: 'Diskussion am Testfall' },
  'tc-import': { title: 'Import aus Excel/CSV', page: '02-testfaelle', heading: 'Import aus Excel/CSV' },
  'tc-export': { title: 'Export', page: '02-testfaelle', heading: 'Export' },
  references: { title: 'Verweise auf Tickets', page: '02-testfaelle', heading: 'Verweise auf Tickets', related: ['openproject', 'free-links'] },
  gherkin: { title: 'Gherkin und Git', page: '02-testfaelle', heading: 'Gherkin und Git' },

  // Planung & Durchführung
  planning: { title: 'Aufbau der Planung', page: '03-planung-durchfuehrung', heading: 'Aufbau', related: ['plans', 'cycles'] },
  plans: { title: 'Testpläne pflegen', page: '03-planung-durchfuehrung', heading: 'Testpläne pflegen', related: ['cockpit'] },
  cycles: { title: 'Zyklen anlegen und finden', page: '03-planung-durchfuehrung', heading: 'Zyklen anlegen und finden', related: ['cycle-repeat', 'risk', 'cycle-close', 'execute'] },
  'cycle-repeat': { title: 'Wiederholen, verteilen, vergleichen', page: '03-planung-durchfuehrung', heading: 'Zyklen wiederholen, verteilen, vergleichen' },
  'planned-effort': { title: 'Geplanter Aufwand', page: '03-planung-durchfuehrung', heading: 'Geplanter Aufwand' },
  risk: { title: 'Risikobasierte Testauswahl', page: '03-planung-durchfuehrung', heading: 'Risikobasierte Testauswahl' },
  'exec-search': { title: 'Ausführungen suchen und gemeinsam bearbeiten', page: '03-planung-durchfuehrung', heading: 'Ausführungen suchen und gemeinsam bearbeiten', related: ['aql'] },
  'run-now': { title: 'Jetzt ausführen', page: '03-planung-durchfuehrung', heading: 'Jetzt ausführen (ohne Zyklus)' },
  execute: { title: 'Ausführen', page: '03-planung-durchfuehrung', heading: 'Ausführen', related: ['step-groups', 'defects', 'free-links', 'assignee-only', 'attachments'] },
  sessions: { title: 'Explorative Testsitzungen', page: '03-planung-durchfuehrung', heading: 'Explorative Testsitzungen' },
  'cycle-close': { title: 'Zyklus abschließen, archivieren, löschen', page: '03-planung-durchfuehrung', heading: 'Zyklus abschließen, archivieren, löschen' },
  'automated-results': { title: 'Ergebnisse automatisierter Tests', page: '03-planung-durchfuehrung', heading: 'Ergebnisse automatisierter Tests', related: ['ci'] },
  ci: { title: 'CI-Pipeline starten', page: '03-planung-durchfuehrung', heading: 'CI-Pipeline starten', related: ['automated-results'] },
  'excel-roundtrip': { title: 'Excel-Rundlauf', page: '03-planung-durchfuehrung', heading: 'Excel-Rundlauf (Durchführung ohne Anemo)' },
  defects: { title: 'Fehler melden und Nachtest', page: '03-planung-durchfuehrung', heading: 'Fehler melden und Nachtest', related: ['free-links', 'openproject', 'jira'] },
  'assignee-only': { title: 'Nur Zuständige erfassen Ergebnisse', page: '03-planung-durchfuehrung', heading: 'Nur Zuständige erfassen Ergebnisse' },
  mine: { title: 'Mir zugewiesen', page: '03-planung-durchfuehrung', heading: 'Mir zugewiesen' },
  'agent-results': { title: 'Ergebnisse von KI-Agenten', page: '03-planung-durchfuehrung', heading: 'Ergebnisse von KI-Agenten' },

  // Auswertung
  cockpit: { title: 'Release-Cockpit', page: '04-auswertung-berichte', heading: 'Release-Cockpit', related: ['status-report', 'reports'] },
  'status-report': { title: 'Teststatusbericht', page: '04-auswertung-berichte', heading: 'Teststatusbericht (Zwischenbericht)' },
  matrix: { title: 'Ergebnis-Matrix', page: '04-auswertung-berichte', heading: 'Ergebnis-Matrix' },
  portfolio: { title: 'Portfolio', page: '04-auswertung-berichte', heading: 'Portfolio' },
  health: { title: 'Test-Health', page: '04-auswertung-berichte', heading: 'Test-Health' },
  reports: { title: 'Testberichte', page: '04-auswertung-berichte', heading: 'Testberichte', related: ['delivery', 'admin-report-profiles'] },
  delivery: { title: 'Lieferpaket', page: '04-auswertung-berichte', heading: 'Lieferpaket' },

  // Zusammenarbeit
  openproject: { title: 'OpenProject', page: '05-zusammenarbeit', heading: 'OpenProject', related: ['admin-openproject'] },
  jira: { title: 'Jira (Parallelbetrieb)', page: '05-zusammenarbeit', heading: 'Jira (Parallelbetrieb)', related: ['admin-jira'] },
  gitlab: { title: 'GitLab', page: '05-zusammenarbeit', heading: 'GitLab' },
  notifications: { title: 'Benachrichtigungen', page: '05-zusammenarbeit', heading: 'Benachrichtigungen' },
  api: { title: 'API und Skripte', page: '05-zusammenarbeit', heading: 'API und Skripte' },
  mcp: { title: 'KI-Agenten (MCP)', page: '05-zusammenarbeit', heading: 'KI-Agenten (MCP)' },

  // Administration
  'admin-users': { title: 'Benutzer', page: '10-administration', heading: 'Benutzer', related: ['admin-passwords', 'admin-groups'] },
  'admin-passwords': { title: 'Kennwörter, Sperre und Sitzungen', page: '10-administration', heading: 'Kennwörter, Sperre und Sitzungen' },
  'admin-groups': { title: 'Gruppen', page: '10-administration', heading: 'Gruppen' },
  'transfer': { title: 'Projekte übertragen', page: '10-administration', heading: 'Projekte übertragen', related: ['admin-users'] },
  'admin-projects': { title: 'Projekte & Rechte', page: '10-administration', heading: 'Projekte & Rechte', related: ['roles'] },
  'admin-auth': { title: 'Anmeldung', page: '10-administration', heading: 'Anmeldung' },
  'admin-workflow': { title: 'Status & Workflow', page: '10-administration', heading: 'Status & Workflow' },
  'admin-fields': { title: 'Felder & Prioritäten', page: '10-administration', heading: 'Felder & Prioritäten' },
  'admin-configurations': { title: 'Testkonfigurationen', page: '10-administration', heading: 'Testkonfigurationen' },
  'field-templates': { title: 'Feldvorlagen', page: '10-administration', heading: 'Feldvorlagen', related: ['tc-edit', 'step-library'] },
  'admin-templates': { title: 'Fehlervorlagen', page: '10-administration', heading: 'Fehlervorlagen' },
  'admin-report-profiles': { title: 'Berichtsprofile', page: '10-administration', heading: 'Berichtsprofile' },
  'admin-mail': { title: 'E-Mail', page: '10-administration', heading: 'E-Mail' },
  'admin-webhooks': { title: 'Webhooks & Chat', page: '10-administration', heading: 'Webhooks & Chat' },
  'admin-integrations': { title: 'Anbindungen', page: '10-administration', heading: 'Anbindungen', related: ['admin-openproject', 'free-links', 'admin-gitlab', 'admin-jira'] },
  'admin-openproject': { title: 'OpenProject: Projektzuordnung', page: '10-administration', heading: 'OpenProject: Projektzuordnung' },
  'free-links': { title: 'Freie Links (URL mit Kurznamen)', page: '10-administration', heading: 'Freie Links (URL mit Kurznamen)' },
  'admin-gitlab': { title: 'GitLab: Zweig für CI', page: '10-administration', heading: 'GitLab: Zweig für CI' },
  'admin-jira': { title: 'Jira: Fehler in Jira anlegen', page: '10-administration', heading: 'Jira: Fehler in Jira anlegen' },
  'admin-ai': { title: 'KI', page: '10-administration', heading: 'KI' },
  'admin-settings': { title: 'Allgemein', page: '10-administration', heading: 'Allgemein' },
  'admin-migration': { title: 'Migration', page: '10-administration', heading: 'Migration' },
  'admin-events': { title: 'Ereignisse', page: '10-administration', heading: 'Ereignisse' },
} satisfies Record<string, HelpTopic>;

export type HelpTopicId = keyof typeof HELP_TOPICS;

export const topicOf = (id: string): HelpTopic | undefined => (HELP_TOPICS as Record<string, HelpTopic>)[id];

/** Anker einer Überschrift (wie der Markdown-Renderer ihn vergibt): Kleinbuchstaben, ohne Akzente, Bindestriche. */
export function helpSlug(heading: string): string {
  return heading.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Überschriften-Wortlaut ohne Markdown-Links („Anmeldung (siehe [x](y))“ → „Anmeldung (siehe x)“). */
const plainHeading = (h: string) => h.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();

/**
 * Abschnitt eines Handbuchtexts: von der Überschrift bis zur nächsten Überschrift gleicher oder höherer Ebene.
 * Ohne Überschrift bzw. wenn sie fehlt: null.
 */
export function helpSection(markdown: string, heading: string): string | null {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let inCode = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith('```')) inCode = !inCode;
    if (inCode) continue;
    const m = /^(#{1,6}) (.*)$/.exec(l);
    if (!m) continue;
    if (start < 0) {
      if (plainHeading(m[2]!) === heading) { start = i; level = m[1]!.length; }
    } else if (m[1]!.length <= level) {
      return lines.slice(start, i).join('\n').trim();
    }
  }
  return start < 0 ? null : lines.slice(start).join('\n').trim();
}

const ADMIN_TOPIC: Record<string, HelpTopicId> = {
  users: 'admin-users', groups: 'admin-groups', projects: 'admin-projects', auth: 'admin-auth', workflow: 'admin-workflow',
  fields: 'admin-fields', templates: 'admin-templates', 'field-templates': 'field-templates', reports: 'admin-report-profiles', mail: 'admin-mail', webhooks: 'admin-webhooks',
  integrations: 'admin-integrations', openproject: 'admin-openproject', gitlab: 'admin-gitlab', jira: 'admin-jira', automation: 'api',
  ai: 'admin-ai', settings: 'admin-settings', transfers: 'transfer',
};

const FOCUS_TOPIC: Record<string, HelpTopicId> = {
  run: 'execute', 'cycle-run': 'execute', session: 'sessions', testcase: 'tc-edit', plan: 'plans', cycle: 'cycles',
};

/** Passendes Thema zur aktuellen Ansicht (Pfad und Parameter der Adresse #/…). */
export function topicForRoute(path: string[], query: URLSearchParams): HelpTopicId {
  const [section, key, page, id] = path;
  if (section === 'f') return FOCUS_TOPIC[page ?? ''] ?? 'overview';
  if (section === 'admin') return ADMIN_TOPIC[key ?? 'users'] ?? 'admin-settings';
  if (section === 'migration') return 'admin-migration';
  if (section === 'events') return 'admin-events';
  if (section === 'configurations') return 'admin-configurations';
  if (section === 'portfolio') return 'portfolio';
  if (section === 'search') return 'search';
  if (section === 'transfer') return 'transfer';
  if (section !== 'p') return 'overview';
  switch (page ?? 'repo') {
    case 'start': return 'start';
    case 'health': return 'health';
    case 'members': return 'admin-projects';
    case 'cycles': {
      if (id) return query.get('exec') ? 'execute' : 'cycles';
      const view = query.get('view');
      if (view === 'mine') return 'mine';
      if (view === 'search') return 'exec-search';
      if (view === 'reviews') return 'agent-results';
      if (query.get('tab') === 'cockpit') return 'cockpit';
      return query.get('plan') ? 'plans' : 'planning';
    }
    default:
      return query.get('tc') ? 'tc-edit' : query.get('aql') ? 'aql' : 'testcases';
  }
}
