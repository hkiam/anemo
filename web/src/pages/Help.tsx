import { useEffect } from 'react';
import { useApi } from '../api.ts';
import { handbookLink } from '../components/HelpPanel.tsx';
import { ErrorNote } from '../components/common.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { href, type Route } from '../router.ts';

const TITLES: Record<string, string> = {
  README: 'Übersicht', '01-erste-schritte': 'Erste Schritte', '02-testfaelle': 'Testfälle', '03-planung-durchfuehrung': 'Planung & Durchführung',
  '04-auswertung-berichte': 'Auswertung & Berichte', '05-zusammenarbeit': 'Zusammenarbeit & Automatisierung', '10-administration': 'Administration',
  '20-betrieb': 'Betrieb', 'anmeldung-sso': 'SSO / LDAP', openproject: 'OpenProject', automation: 'CI-Ergebnisse', mcp: 'MCP-Server', agenten: 'KI-Agenten', 'ki-assistenz': 'KI-Assistenz', 'ki-konzept': 'KI-Konzept & Skills', 'bdd-e2e-beispiel': 'Beispiel: BDD + E2E + KI',
};

/** Handbuch in der Anwendung (#/hilfe/<seite>). */
export function Help({ route }: { route: Route }) {
  const page = route.path[1] ?? 'README';
  const list = useApi<{ handbuch: string[]; anleitungen: string[] }>('/api/help');
  const text = useApi<string>(`/api/help/${page}`);
  // Sprungmarke (#/hilfe/<seite>?a=<anker>, z. B. aus der Hilfe-Seitenleiste) nach dem Laden anspringen
  const anchor = route.query.get('a');
  useEffect(() => {
    if (!anchor || typeof text.data !== 'string') return;
    const el = document.getElementById(anchor);
    if (el) { el.scrollIntoView({ block: 'start' }); el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: true }); }
  }, [anchor, text.data]);
  return (
    <div className="planning">
      <div className="pane" style={{ borderRight: '1px solid var(--border)', overflow: 'auto' }}>
        <h3>Handbuch</h3>
        <div className="stack" style={{ gap: 2 }}>
          {['README', ...(list.data?.handbuch ?? [])].map((p) => (
            <a key={p} className={`plan-item ${p === page ? 'active' : ''}`} href={href(['hilfe', p])}>{TITLES[p] ?? p}</a>
          ))}
          <div className="small muted" style={{ margin: '10px 0 2px', textTransform: 'uppercase', letterSpacing: '.04em' }}>Anleitungen</div>
          {list.data?.anleitungen.map((p) => <a key={p} className={`plan-item ${p === page ? 'active' : ''}`} href={href(['hilfe', p])}>{TITLES[p] ?? p}</a>)}
        </div>
      </div>
      <div className="pane" style={{ overflow: 'auto', padding: '16px 28px' }}>
        <div className="page-narrow" style={{ maxWidth: 880, margin: 0 }}>
          <ErrorNote error={text.error} />
          {typeof text.data === 'string' && <Markdown text={text.data} link={(h) => handbookLink(h)} />}
        </div>
      </div>
    </div>
  );
}
