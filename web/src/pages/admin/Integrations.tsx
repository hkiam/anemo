import { useEffect, useState } from 'react';
import { api, useApi } from '../../api.ts';
import { ErrorNote, Modal } from '../../components/common.tsx';
import { type Project, SEVERITIES } from '../../types.ts';
import { Webhooks } from './Webhooks.tsx';
import { askConfirm, toast } from '../../ux.tsx';
import { href, navigate } from '../../router.ts';
import { SettingsGroup, useSettings } from './Settings.tsx';

interface Integration { provider: string; name: string; configured: boolean; url: string | null; env: string[]; lastRefresh?: { at: string; checked: number; updated: number; missing?: number; retests?: number; error: string | null } | null }
interface Template { id: string; projectId: string | null; name: string; titleTemplate: string; bodyTemplate: string; isDefault: boolean }

const PLACEHOLDERS: [string, string][] = [
  ['testCase.key / .title / .version', 'Testfall'], ['preconditions', 'Vorbedingungen'],
  ['cycle.name / .release / .build / .environment', 'Testzyklus'], ['configuration', 'erkannte Konfiguration (DB, Client …)'],
  ['step.no / .action / .expected / .actual', 'fehlgeschlagener bzw. gewählter Schritt'], ['steps', 'alle Schritte als nummerierte Liste'],
  ['fehler', 'Ist-Ergebnis des Schritts bzw. Ausführungskommentar'], ['evidence', 'Anhänge der Ausführung'],
  ['executedBy', 'Tester'], ['link', 'Rückverweis auf die Ausführung in Anemo'],
];

/** Einstellungsgruppe einer Anbindung oben auf ihrer Seite (Zugangsdaten mit Herkunft, Verbindungstest). */
function Config({ group, title, onSaved }: { group: string; title: string; onSaved?: () => void }) {
  const { data, merge } = useSettings();
  if (!data) return null;
  return <SettingsGroup group={group} title={title} settings={data.settings} onSaved={(d) => { merge(d); onSaved?.(); }} />;
}

function Status({ i }: { i: Integration | undefined }) {
  return <span className={`badge ${i?.configured ? 'ok' : 'neutral'}`}>{i?.configured ? 'eingerichtet' : 'nicht eingerichtet'}</span>;
}

/** Anbindungen – Übersicht: was ist eingerichtet, wo geht es weiter. */
export function Integrations() {
  const list = useApi<Integration[]>('/api/admin/integrations');
  const mail = useApi<{ configured: boolean }>('/api/admin/mail');
  const rows: [string, string, string, Integration | { configured: boolean } | undefined][] = [
    ['OpenProject', 'Fehler und Anforderungen verknüpfen und anlegen, Nachtests bei erledigten Fehlern', 'openproject', list.data?.find((x) => x.provider === 'openproject')],
    ['GitLab', 'Gherkin-Testfälle mit .feature-Dateien abgleichen, Merge-Requests verknüpfen', 'gitlab', list.data?.find((x) => x.provider === 'gitlab')],
    ['Jira (Parallelbetrieb)', 'Titel und Status verknüpfter Jira-Tickets lesend aktuell halten', 'jira', list.data?.find((x) => x.provider === 'jira')],
    ['CI & KI-Agenten', 'Ergebnisse aus Pipelines übernehmen, Agenten über MCP', 'automation', { configured: true }],
    ['E-Mail', 'Benachrichtigungen per Mail', 'mail', mail.data],
    ['Webhooks & Chat', 'Ereignisse an Teams, Mattermost, Slack oder eigene Dienste', 'webhooks', { configured: true }],
  ];
  return (
    <div className="stack">
      <h2>Anbindungen</h2>
      <ErrorNote error={list.error} />
      <p className="small muted">Jede Anbindung hat eine eigene Seite mit Zugangsdaten, Verbindungstest, Status und Projektzuordnung. Projekte mit gesperrten externen
        Diensten senden an keine Anbindung Inhalte.</p>
      <div className="table-wrap"><table>
        <tbody>{rows.map(([name, desc, path, st]) => (
          <tr key={path} className="clickable" onClick={() => navigate(['admin', path])}>
            <td><a href={href(['admin', path])}><b>{name}</b></a><div className="small muted">{desc}</div></td>
            <td className="fit"><span className={`badge ${st?.configured ? 'ok' : 'neutral'}`}>{st?.configured ? (path === 'automation' || path === 'webhooks' ? 'bereit' : 'eingerichtet') : 'nicht eingerichtet'}</span></td>
          </tr>
        ))}</tbody>
      </table></div>
      <Config group="links" title="Freie Links (URL mit Kurznamen)" />
    </div>
  );
}

export function OpenProjectAdmin() {
  const list = useApi<Integration[]>('/api/admin/integrations');
  const op = list.data?.find((i) => i.provider === 'openproject');
  return (
    <div className="stack">
      <div className="row"><h2>OpenProject</h2><Status i={op} />{op?.url && <span className="small muted">{op.url}</span>}</div>
      <p className="small muted">Fehler werden aus der Durchführung über „Fehler melden …“ mit Vorlage angelegt und mit der Ausführung verknüpft; Status und Titel
        verknüpfter Arbeitspakete werden regelmäßig abgeglichen, erledigte Fehler lösen Nachtests aus. Auswahlwerte eigener Felder lassen sich aus OpenProject übernehmen.</p>
      <Config group="openproject" title="Zugang und Abgleich" onSaved={list.reload} />
      <div className="card"><div className="card-body stack">
        <h3>Status</h3>
        {op?.configured ? <div className="row small">
          <button className="small" onClick={async () => { await api('POST', '/api/admin/integrations/openproject/refresh'); list.reload(); }}>Status jetzt abgleichen</button>
          {op.lastRefresh && <span className="muted">zuletzt {new Date(op.lastRefresh.at).toLocaleString('de-DE')}: {op.lastRefresh.checked} Arbeitspakete, {op.lastRefresh.updated} aktualisiert,
            {' '}{op.lastRefresh.retests} Nachtests angelegt{op.lastRefresh.error ? ` – Fehler: ${op.lastRefresh.error}` : ''}</span>}
        </div> : <div className="small muted">Erst Zugang einrichten.</div>}
        <ProjectLinks enabled={!!op?.configured} />
      </div></div>
      <BacklinkCard enabled={!!op?.configured} />
      <div className="small muted">Vorlagen für Fehlermeldungen: <a href={href(['admin', 'templates'])}>Testmanagement → Fehlervorlagen</a></div>
    </div>
  );
}

export function GitLabAdmin() {
  const list = useApi<Integration[]>('/api/admin/integrations');
  const gl = list.data?.find((i) => i.provider === 'gitlab');
  return (
    <div className="stack">
      <div className="row"><h2>GitLab</h2><Status i={gl} />{gl?.url && <span className="small muted">{gl.url}</span>}</div>
      <Config group="gitlab" title="Zugang" onSaved={list.reload} />
      <GitLabCard gl={gl} />
    </div>
  );
}

export function JiraAdmin() {
  const list = useApi<Integration[]>('/api/admin/integrations');
  const jira = list.data?.find((i) => i.provider === 'jira');
  return (
    <div className="stack">
      <div className="row"><h2>Jira (Parallelbetrieb)</h2><Status i={jira} /></div>
      <Config group="jira" title="Zugang und Abgleich" onSaved={list.reload} />
      <JiraCard jira={jira} onDone={list.reload} />
      <JiraProjectLinks />
      <div className="small muted">Die Übernahme des Altbestands (Jira/Zephyr) steht unter <a href={href(['migration'])}>System → Migration</a>.</div>
    </div>
  );
}

export function AutomationAdmin() {
  return (
    <div className="stack">
      <h2>CI &amp; KI-Agenten</h2>
      <div className="card"><div className="card-body stack">
        <div className="row"><h3>CI-Pipelines (Testautomatisierung)</h3><span className="badge ok">bereit</span></div>
        <p className="small muted">Formate (automatisch erkannt): JUnit, Cucumber, Behave, TestNG, NUnit, xUnit.net, MSTest (TRX), Robot Framework, Playwright, Jest.
          Ergebnisse werden als Ausführungen übernommen und Testfällen über Schlüssel, Tag/Kategorie oder Automatisierungsverweis zugeordnet – per API aus der
          Pipeline oder als Datei im Zyklus (⋯ Mehr → Automatisierte Ergebnisse). Mit <span className="mono">createDefects=true</span> legt Anemo für Fehlschläge
          Fehler in OpenProject an (offene Fehler des Testfalls werden wiederverwendet). Token: Menü oben rechts → API-Tokens.</p>
        <pre className="code small">{`curl --fail -X POST -H "Authorization: Bearer $ANEMO_TOKEN" -H "Content-Type: application/xml" \\
  --data-binary @report.xml \\
  "${window.location.origin}/api/projects/<PROJEKT>/automation-results?cycle=Nightly&build=$CI_PIPELINE_IID"`}</pre>
        <p className="small muted">Ausführlich: docs/automation.md im Repository.</p>
      </div></div>
      <div className="card"><div className="card-body stack">
        <div className="row"><h3>KI-Agenten (MCP)</h3><span className="badge ok">bereit</span></div>
        <p className="small muted">Claude und andere Agenten arbeiten über das Model Context Protocol mit Anemo – mit den Rechten des Token-Benutzers;
          Projekte mit gesperrten externen Diensten sind für Agenten unsichtbar. Ergebnisse von Agenten brauchen eine QA-Prüfung; der Schalter dafür liegt unter
          {' '}<a href={href(['admin', 'ai'])}>KI</a>.</p>
        <pre className="code small">{`claude mcp add --transport http anemo ${window.location.origin}/api/mcp --header "Authorization: Bearer <API-Token>"`}</pre>
      </div></div>
    </div>
  );
}

export function MailAdmin() {
  return (
    <div className="stack">
      <h2>E-Mail</h2>
      <Config group="smtp" title="Versand (SMTP)" />
      <MailCard />
    </div>
  );
}

export function WebhooksAdmin() {
  return <div className="stack"><h2>Webhooks &amp; Chat</h2><Webhooks /></div>;
}

export function TemplatesAdmin() {
  return <div className="stack"><h2>Fehlervorlagen</h2>
    <p className="small muted">Vorlagen für „Fehler melden …“ in der Durchführung – global oder je Projekt. Platzhalter werden beim Melden gefüllt.</p>
    <Templates /></div>;
}

/** Anmeldung: SSO (OIDC) und LDAP/Active Directory an einer Stelle. */
export function AuthAdmin() {
  return (
    <div className="stack">
      <h2>Anmeldung</h2>
      <p className="small muted">Lokale Konten funktionieren immer. Zusätzlich lassen sich ein Firmen-SSO (OpenID Connect, z. B. Keycloak oder Microsoft Entra ID) und
        LDAP/Active Directory einrichten; Gruppen werden dabei übernommen und können Projekten mit Rollen zugeordnet werden
        (<a href={href(['admin', 'groups'])}>Gruppen</a>).</p>
      <Config group="oidc" title="SSO (OpenID Connect)" />
      <Config group="ldap" title="LDAP / Active Directory" />
    </div>
  );
}

export function GitLabCard({ gl }: { gl: Integration | undefined }) {
  const projects = useApi<Project[]>('/api/projects');
  const [key, setKey] = useState('');
  type GlSettings = { branch?: string; folder?: string; ciRef?: string; ciRefs?: string[]; ciVariables?: string[] };
  const links = useApi<{ provider: string; externalProject: string; settings: GlSettings }[]>(key ? `/api/projects/${key}/integrations` : null);
  const cur = links.data?.find((l) => l.provider === 'gitlab');
  const [f, setF] = useState({ project: '', branch: 'main', folder: 'features', ciRef: '', ciRefs: '', ciVariables: '' });
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  // vorhandene Zuordnung in die Felder übernehmen
  useEffect(() => {
    if (!cur) return;
    setF({ project: cur.externalProject, branch: cur.settings.branch ?? 'main', folder: cur.settings.folder ?? 'features', ciRef: cur.settings.ciRef ?? '',
      ciRefs: (cur.settings.ciRefs ?? []).join(', '), ciVariables: (cur.settings.ciVariables ?? []).join(', ') });
  }, [cur?.externalProject, key]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save(remove = false) {
    if (remove && !(await askConfirm({ title: `GitLab-Zuordnung von ${key} entfernen`, message: `Danach lassen sich in ${key} keine .feature-Dateien mehr abgleichen, keine Merge-Requests suchen und keine CI-Pipelines starten. Bestehende Verknüpfungen bleiben erhalten.`, confirmLabel: 'Zuordnung entfernen', danger: true }))) return;
    setError(null);
    try {
      await api('PUT', `/api/projects/${key}/integrations/gitlab`, remove ? { externalProject: null } : {
        externalProject: f.project.trim(), settings: {
          branch: f.branch.trim() || 'main', folder: f.folder.trim() || 'features', ...(f.ciRef.trim() ? { ciRef: f.ciRef.trim() } : {}),
          ...(list(f.ciRefs).length ? { ciRefs: list(f.ciRefs) } : {}), ...(list(f.ciVariables).length ? { ciVariables: list(f.ciVariables) } : {}),
        },
      });
      links.reload();
      setSaved(remove ? 'entfernt' : 'gespeichert');
      toast(remove ? `GitLab-Zuordnung von ${key} entfernt` : `${key} ist ${f.project.trim()} zugeordnet`);
    } catch (e) { setError(e); }
  }
  return (
    <div className="card"><div className="card-body stack">
      <h3>Repository je Projekt</h3>
      <p className="small muted">Zugangsdaten oben oder per Umgebung <code>GITLAB_URL</code>/<code>GITLAB_TOKEN</code> (Projekt-/Gruppen-Token, Bereich „api“). Je Anemo-Projekt ein
        Repository zuordnen: Gherkin-Testfälle werden als <code>.feature</code>-Dateien abgeglichen (Testfälle → Austausch → Git-Abgleich), Merge-Requests/Commits lassen sich verknüpfen
        und im Zyklus lässt sich eine CI-Pipeline starten (Zweig „CI“, sonst der Gherkin-Zweig; das Token braucht dafür mindestens die Rolle Developer).
        CI-Starts erlauben nur diese Zweige sowie Variablen mit Präfix <code>TEST_</code> oder aus der Liste „Erlaubte Variablen“; Voraussetzung ist <code>ANEMO_PUBLIC_URL</code>.</p>
      <ErrorNote error={error} />
      <div className="row wrap">
        <select value={key} onChange={(e) => { setKey(e.target.value); setSaved(null); setError(null); setF({ project: '', branch: 'main', folder: 'features', ciRef: '', ciRefs: '', ciVariables: '' }); }} style={{ width: 'auto' }} aria-label="Anemo-Projekt">
          <option value="">Anemo-Projekt wählen …</option>{projects.data?.map((p) => <option key={p.key} value={p.key}>{p.key} – {p.name}</option>)}
        </select>
        {key && <>
          <input placeholder="Repository, z. B. qa/akte" aria-label="GitLab-Repository" value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} style={{ width: 220 }} />
          <input placeholder="Zweig" aria-label="Zweig für .feature-Dateien" value={f.branch} onChange={(e) => setF({ ...f, branch: e.target.value })} style={{ width: 110 }} />
          <input placeholder="Ordner" aria-label="Ordner für .feature-Dateien" value={f.folder} onChange={(e) => setF({ ...f, folder: e.target.value })} style={{ width: 130 }} />
          <input placeholder="Zweig für CI (optional)" value={f.ciRef} onChange={(e) => setF({ ...f, ciRef: e.target.value })} style={{ width: 170 }} aria-label="Zweig für CI-Pipelines" />
          <input placeholder="Weitere erlaubte Zweige, kommagetrennt" value={f.ciRefs} onChange={(e) => setF({ ...f, ciRefs: e.target.value })} style={{ width: 240 }} aria-label="Weitere erlaubte Zweige (kommagetrennt)" />
          <input placeholder="Erlaubte Variablen, kommagetrennt" value={f.ciVariables} onChange={(e) => setF({ ...f, ciVariables: e.target.value })} style={{ width: 240 }} aria-label="Erlaubte Variablen (kommagetrennt)" />
          {cur && <button className="danger" onClick={() => save(true)}>Zuordnung entfernen …</button>}
          <button className="primary" disabled={!f.project.trim()} title={f.project.trim() ? undefined : 'Erst das Repository angeben'} onClick={() => save()}>Zuordnen</button>
        </>}
      </div>
      {key && <div className="small muted">{cur ? `Aktuell: ${cur.externalProject} · ${cur.settings.branch ?? 'main'} · ${cur.settings.folder ?? 'features'}/${cur.settings.ciRef ? ` · CI: ${cur.settings.ciRef}` : ''}${cur.settings.ciRefs?.length ? ` · weitere Zweige: ${cur.settings.ciRefs.join(', ')}` : ''}${cur.settings.ciVariables?.length ? ` · Variablen: ${cur.settings.ciVariables.join(', ')}` : ''}` : 'Noch nicht zugeordnet.'}{saved ? ` – ${saved} ✓` : ''}</div>}
    </div></div>
  );
}

export function MailCard() {
  const st = useApi<{ configured: boolean; host: string | null; from: string | null; failures: number; lastError: string | null; lastSentAt: string | null }>('/api/admin/mail');
  const d = st.data;
  return (
    <div className="card"><div className="card-body stack">
      <div className="row"><h3>Versand und Benachrichtigungen</h3><span className={`badge ${d?.configured ? 'ok' : 'neutral'}`}>{d?.configured ? 'eingerichtet' : 'nicht eingerichtet'}</span>
        {d?.host && <span className="small muted">{d.host} · Absender {d.from}</span>}</div>
      <p className="small muted">Zugangsdaten oben oder per Umgebung (<code>SMTP_*</code>). Jede Person wählt ihre Benachrichtigungen selbst (Menü oben rechts → Benachrichtigungen):
        zugewiesene Tests, fällige Nachtests, Fehlschläge in eigenen Zyklen, Erwähnungen in Diskussionen und beobachtete Testfälle, Zyklen und Testpläne. Geschützte Projekte erhalten nur einen Hinweis ohne Inhalt.</p>
      {d?.configured && <div className="small muted">Testmail: „Verbindung prüfen“ oben.</div>}
      {d?.lastError && <div className="notice bad small">Letzter Fehler: {d.lastError}{d.failures ? ` (${d.failures} Fehlversuche, wird wiederholt)` : ''}</div>}
      {d?.lastSentAt && <div className="small muted">Zuletzt versendet: {new Date(d.lastSentAt).toLocaleString('de-DE')}</div>}
    </div></div>
  );
}

export function JiraCard({ jira, onDone }: { jira: Integration | undefined; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const r = jira?.lastRefresh;
  async function refresh() {
    setBusy(true);
    try {
      await api('POST', '/api/admin/integrations/jira/refresh');
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card"><div className="card-body stack">
      <div className="row"><h3>Status</h3>
        {jira?.url && <span className="small muted">{jira.url}</span>}<span className="spacer" />
        {jira?.configured && <button className="small" onClick={refresh} disabled={busy}>{busy ? 'Aktualisiert … (dauert bei vielen Tickets Minuten)' : 'Jetzt aktualisieren'}</button>}
      </div>
      <ErrorNote error={error} />
      <p className="small muted">Hält Titel und Status der verknüpften Jira-Tickets (Anforderungen, Fehler) aktuell – automatisch im eingestellten Takt (Standard alle 6 Stunden). Cockpit und Berichte zeigen damit den echten Fehlerstand.
        In Jira geschrieben wird nur mit eingeschaltetem „Fehler in Jira anlegen“ (unten je Projekt zuordnen).</p>
      {r && <div className={`notice ${r.error ? 'bad' : 'ok'} small`}>Zuletzt {new Date(r.at).toLocaleString('de-DE')}: {r.checked.toLocaleString('de-DE')} Tickets geprüft,
        {' '}{r.updated.toLocaleString('de-DE')} aktualisiert, {r.missing} nicht (mehr) gefunden{r.error ? ` – Fehler: ${r.error}` : ''}</div>}
    </div></div>
  );
}

interface OpLinks { openProject: { identifier: string; name: string }[]; links: { key: string; name: string; externalServices: string; externalProject: string | null; settings: { typeId?: number; coverageComments?: boolean } | null }[] }

/** Zuordnung Anemo-Projekt ↔ OpenProject-Projekt: Übersicht aller Projekte, Auswahl aus den Projekten in OpenProject. */
export function ProjectLinks({ enabled }: { enabled: boolean }) {
  const data = useApi<OpLinks>(enabled ? '/api/admin/integrations/openproject/projects' : null);
  const [filter, setFilter] = useState('');
  const [onlyLinked, setOnlyLinked] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  if (!enabled) return <div className="stack"><h4>Projektzuordnung</h4><div className="small muted">Erst Zugang einrichten – dann lassen sich Anemo-Projekte OpenProject-Projekten zuordnen.</div></div>;
  const rows = (data.data?.links ?? []).filter((l) => (!onlyLinked || l.externalProject) && (!filter || `${l.key} ${l.name} ${l.externalProject ?? ''}`.toLowerCase().includes(filter.toLowerCase())));
  const linked = data.data?.links.filter((l) => l.externalProject).length ?? 0;
  return (
    <div className="stack">
      <h4>Projektzuordnung ({linked} von {data.data?.links.length ?? 0} Projekten zugeordnet)</h4>
      <p className="small muted">Nur zugeordnete Projekte können Arbeitspakete suchen und Fehler in OpenProject anlegen. Ohne Zuordnung lassen sich Arbeitspakete nur über ihre Nummer verknüpfen.</p>
      <ErrorNote error={data.error} />
      <div className="row">
        <input type="search" placeholder="Projekt filtern …" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} aria-label="Projekte filtern" />
        <label className="row small"><input type="checkbox" checked={onlyLinked} onChange={(e) => setOnlyLinked(e.target.checked)} style={{ width: 'auto' }} /> nur zugeordnete</label>
      </div>
      <div className="table-wrap" style={{ maxHeight: 420 }}><table>
        <thead><tr><th>Anemo-Projekt</th><th>OpenProject-Projekt</th><th className="fit">Typ neuer Fehler</th><th className="fit">Abdeckung ins Ticket</th><th className="fit" /></tr></thead>
        <tbody>{rows.map((l) => editing === l.key
          ? <LinkEditor key={l.key} row={l} projects={data.data!.openProject} onDone={() => { setEditing(null); data.reload(); }} />
          : (
            <tr key={l.key}>
              <td><b>{l.key}</b> {l.name}{l.externalServices !== 'allowed' && <span className="badge warn" title="Externe Dienste sind für dieses Projekt gesperrt"> gesperrt</span>}</td>
              <td>{l.externalProject ? <>{data.data!.openProject.find((p) => p.identifier === l.externalProject)?.name ?? <span className="rate-bad" title="In OpenProject nicht (mehr) gefunden">⚠ </span>} <span className="mono small muted">{l.externalProject}</span></> : <span className="muted">–</span>}</td>
              <td className="fit small">{l.settings?.typeId ? `Typ-ID ${l.settings.typeId}` : 'Standardtyp'}</td>
              <td className="fit small">{l.externalProject ? (l.settings?.coverageComments ? 'ja' : 'nein') : '–'}</td>
              <td className="fit"><button className="small" onClick={() => setEditing(l.key)}>{l.externalProject ? 'Ändern' : 'Zuordnen'}</button></td>
            </tr>
          ))}</tbody>
      </table></div>
    </div>
  );
}

function LinkEditor({ row, projects, onDone }: { row: OpLinks['links'][number]; projects: OpLinks['openProject']; onDone: () => void }) {
  const [ext, setExt] = useState(row.externalProject ?? '');
  const types = useApi<{ id: number; name: string }[]>(ext ? `/api/admin/integrations/openproject/projects/${encodeURIComponent(ext)}/types` : null);
  const [typeId, setTypeId] = useState(row.settings?.typeId ? String(row.settings.typeId) : '');
  const [coverage, setCoverage] = useState(!!row.settings?.coverageComments);
  const [error, setError] = useState<unknown>(null);
  async function save(remove = false) {
    if (remove && !(await askConfirm({ title: `OpenProject-Zuordnung von ${row.key} entfernen`,
      message: `Fehler aus ${row.key} werden danach nicht mehr in OpenProject (${row.externalProject}) angelegt, und Arbeitspakete lassen sich nur noch über ihre Nummer verknüpfen. Bestehende Verknüpfungen bleiben erhalten.`,
      confirmLabel: 'Zuordnung entfernen', danger: true }))) return;
    try {
      await api('PUT', `/api/projects/${row.key}/integrations/openproject`, remove ? { externalProject: null }
        : { externalProject: ext, settings: { ...(typeId ? { typeId: Number(typeId) } : {}), coverageComments: coverage } });
      toast(remove ? `Zuordnung von ${row.key} entfernt` : `${row.key} ist ${ext} zugeordnet`);
      onDone();
    } catch (e) { setError(e); }
  }
  return (
    <tr>
      <td><b>{row.key}</b> {row.name}<ErrorNote error={error} /></td>
      <td><select value={ext} onChange={(e) => { setExt(e.target.value); setTypeId(''); }} aria-label={`OpenProject-Projekt für ${row.key}`}>
        <option value="">OpenProject-Projekt wählen …</option>
        {projects.map((p) => <option key={p.identifier} value={p.identifier}>{p.name} ({p.identifier})</option>)}
      </select></td>
      <td className="fit"><select value={typeId} onChange={(e) => setTypeId(e.target.value)} disabled={!ext} aria-label="Typ neuer Fehler" style={{ width: 'auto' }}>
        <option value="">Standardtyp</option>
        {types.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select></td>
      <td className="fit"><label className="row small" title="Ändert sich der Teststand einer verknüpften Anforderung, kommentiert Anemo das Arbeitspaket">
        <input type="checkbox" checked={coverage} onChange={(e) => setCoverage(e.target.checked)} style={{ width: 'auto' }} /> Teststand als Kommentar ins Arbeitspaket schreiben</label></td>
      <td className="fit"><div className="row" style={{ gap: 4 }}>
        {row.externalProject && <button className="danger small" onClick={() => save(true)}>Zuordnung entfernen …</button>}
        <button className="small" onClick={onDone}>Abbrechen</button>
        <button className="primary small" disabled={!ext} title={ext ? undefined : 'Erst ein OpenProject-Projekt wählen'} onClick={() => save()}>Speichern</button></div></td>
    </tr>
  );
}

interface JiraLink { provider: string; externalProject: string; settings: { issueType?: string; priorities?: Record<string, string> } }

/** Jira-Projekt je Anemo-Projekt – Ziel für neue Fehler, wenn „Fehler in Jira anlegen“ eingeschaltet ist und kein OpenProject-Projekt zugeordnet ist. */
function JiraProjectLinks() {
  const projects = useApi<Project[]>('/api/projects');
  const [key, setKey] = useState('');
  const links = useApi<JiraLink[]>(key ? `/api/projects/${key}/integrations` : null);
  const cur = links.data?.find((l) => l.provider === 'jira');
  const op = links.data?.find((l) => l.provider === 'openproject');
  const [f, setF] = useState<{ project: string; issueType: string; priorities: Record<string, string> }>({ project: '', issueType: 'Bug', priorities: {} });
  const [error, setError] = useState<unknown>(null);
  const load = (k: string) => { setKey(k); setF({ project: '', issueType: 'Bug', priorities: {} }); setError(null); };
  async function save(remove = false) {
    if (remove && !(await askConfirm({ title: `Jira-Zuordnung von ${key} entfernen`,
      message: `Fehler aus ${key} werden danach nicht mehr in Jira (${cur?.externalProject ?? ''}) angelegt. Bestehende Verknüpfungen bleiben erhalten.`,
      confirmLabel: 'Zuordnung entfernen', danger: true }))) return;
    try {
      const priorities = Object.fromEntries(Object.entries(f.priorities).filter(([, v]) => v.trim()));
      await api('PUT', `/api/projects/${key}/integrations/jira`, remove ? { externalProject: null }
        : { externalProject: (f.project || cur?.externalProject || '').trim().toUpperCase(), settings: { issueType: f.issueType.trim() || 'Bug', ...(Object.keys(priorities).length ? { priorities } : {}) } });
      toast(remove ? `Jira-Zuordnung von ${key} entfernt` : `${key}: Fehler gehen nach Jira ${(f.project || cur?.externalProject || '').toUpperCase()}`);
      links.reload();
    } catch (e) { setError(e); }
  }
  return (
    <div className="card"><div className="card-body stack">
      <h3>Fehler in Jira anlegen – Projektzuordnung</h3>
      <p className="small muted">Wirksam nur mit eingeschaltetem „Fehler in Jira anlegen“ (oben) und nur für Projekte ohne OpenProject-Zuordnung – OpenProject hat Vorrang.
        Jira-Schlüssel des Projekts, Vorgangstyp und optional, welche Jira-Priorität ein Fehler je Anemo-Schweregrad erhält.</p>
      <ErrorNote error={error} />
      <div className="row wrap">
        <select value={key} onChange={(e) => load(e.target.value)} style={{ width: 'auto' }} aria-label="Anemo-Projekt für Jira">
          <option value="">Anemo-Projekt wählen …</option>{projects.data?.map((p) => <option key={p.key} value={p.key}>{p.key} – {p.name}</option>)}
        </select>
        {key && <>
          <input placeholder={cur?.externalProject ?? 'Jira-Projekt, z. B. PROJ'} value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} style={{ width: 170 }} aria-label="Jira-Projektschlüssel" />
          <input placeholder={cur?.settings.issueType ?? 'Vorgangstyp, z. B. Bug'} value={f.issueType} onChange={(e) => setF({ ...f, issueType: e.target.value })} style={{ width: 150 }} aria-label="Vorgangstyp" />
        </>}
      </div>
      {key && <>
        <div className="row wrap small">{SEVERITIES.map((s) => (
          <label key={s} className="row" style={{ gap: 4 }}>Schweregrad {s} →
            <input placeholder={cur?.settings.priorities?.[s] ?? 'Priorität'} value={f.priorities[s] ?? ''} onChange={(e) => setF({ ...f, priorities: { ...f.priorities, [s]: e.target.value } })} style={{ width: 110 }} aria-label={`Jira-Priorität für ${s}`} /></label>
        ))}</div>
        <div className="row">
          {cur && <button className="danger" onClick={() => save(true)}>Zuordnung entfernen …</button>}
          <button className="primary" disabled={!(f.project.trim() || cur)} title={f.project.trim() || cur ? undefined : 'Erst den Jira-Projektschlüssel eingeben'} onClick={() => save()}>Speichern</button>
          <span className="small muted">{cur ? `Aktuell: ${cur.externalProject}, Typ ${cur.settings.issueType ?? 'Bug'}` : 'Noch nicht zugeordnet.'}{op ? ` – Achtung: ${key} ist OpenProject (${op.externalProject}) zugeordnet; Fehler gehen dorthin.` : ''}</span>
        </div>
      </>}
    </div></div>
  );
}

export function Templates() {
  const list = useApi<Template[]>('/api/defect-templates');
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  return (
    <div className="stack">
      <div className="row"><h3>Fehlervorlagen</h3><span className="spacer" /><button className="primary" onClick={() => setEditing('new')}>+ Vorlage</button></div>
      <ErrorNote error={list.error} />
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Titel</th><th className="fit" /></tr></thead>
        <tbody>{list.data?.map((t) => (
          <tr key={t.id}><td>{t.name}{t.isDefault && <span className="badge accent" style={{ marginLeft: 6 }}>Standard</span>}</td>
            <td className="small mono">{t.titleTemplate}</td>
            <td className="fit"><button className="small" onClick={() => setEditing(t)}>Bearbeiten</button></td></tr>
        ))}</tbody>
      </table></div>
      {editing && <TemplateEditor template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload(); }} />}
    </div>
  );
}

function TemplateEditor({ template, onClose, onSaved }: { template: Template | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: template?.name ?? '', titleTemplate: template?.titleTemplate ?? '[{{testCase.key}}] {{fehler|kurz}}',
    bodyTemplate: template?.bodyTemplate ?? '', isDefault: template?.isDefault ?? false });
  const [error, setError] = useState<unknown>(null);
  async function save() {
    try {
      const body = { ...f, projectKey: null };
      if (template) await api('PUT', `/api/admin/defect-templates/${template.id}`, body);
      else await api('POST', '/api/admin/defect-templates', body);
      onSaved();
    } catch (e) {
      setError(e);
    }
  }
  async function remove() {
    if (!template || !(await askConfirm({ title: 'Vorlage löschen', message: `Vorlage „${template.name}“ löschen?`, confirmLabel: 'Löschen', danger: true }))) return;
    try {
      await api('DELETE', `/api/admin/defect-templates/${template.id}`);
      onSaved();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Modal size="large" title={template ? `Vorlage „${template.name}“` : 'Neue Fehlervorlage'} onClose={onClose}
      footer={<>{template && <button className="danger" onClick={remove}>Löschen</button>}<span className="spacer" />
        <button onClick={onClose}>Abbrechen</button><button className="primary" onClick={save} disabled={!f.name || !f.titleTemplate || !f.bodyTemplate}
          title={!f.name || !f.titleTemplate || !f.bodyTemplate ? 'Name, Titel und Beschreibung sind Pflicht' : undefined}>Speichern</button></>}>
      <ErrorNote error={error} />
      <div className="grid2">
        <label className="field">Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="row" style={{ alignSelf: 'end' }}><input type="checkbox" style={{ width: 'auto' }} checked={f.isDefault} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} />Standardvorlage</label>
      </div>
      <label className="field">Titel<input className="mono" value={f.titleTemplate} onChange={(e) => setF({ ...f, titleTemplate: e.target.value })} /></label>
      <label className="field">Beschreibung (Jira-Markup mit Platzhaltern)
        <textarea className="mono" rows={18} value={f.bodyTemplate} onChange={(e) => setF({ ...f, bodyTemplate: e.target.value })} spellCheck={false} />
      </label>
      <details open><summary className="small">Platzhalter</summary>
        <div className="small muted">
          <p><code>{'{{name}}'}</code> setzt einen Wert ein, <code>{'{{name|kurz}}'}</code> nur dessen erste Zeile (für Titel),
            <code>{' {{#name}}…{{/name}}'}</code> nur wenn vorhanden, <code>{'{{^name}}…{{/name}}'}</code> nur wenn leer.</p>
          <dl className="role-legend">{PLACEHOLDERS.map(([k, v]) => <div key={k}><dt className="mono" style={{ fontWeight: 400 }}>{k}</dt><dd>{v}</dd></div>)}</dl>
        </div>
      </details>
    </Modal>
  );
}

interface OpFields { fields: { id: string; name: string; type: string; projects: string[] }[]; projects: string[]; problems: string[]; linkField: string | null; testCaseField: string | null; publicUrl: string | null }

/**
 * Rückverweis in OpenProject: Beim Anlegen eines Fehlers füllt Anemo ein Link-Feld („Anemo“) mit dem dauerhaften Link
 * (/go/…) und optional ein Textfeld mit dem Testfallschlüssel – statt die Adresse in den Beschreibungstext zu schreiben.
 * „Rückverweise aktualisieren“ setzt das Link-Feld nach einem Umzug in allen verknüpften Arbeitspaketen neu.
 */
function BacklinkCard({ enabled }: { enabled: boolean }) {
  const data = useApi<OpFields>(enabled ? '/api/admin/integrations/openproject/fields' : null);
  const [linkField, setLinkField] = useState('');
  const [tcField, setTcField] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data.data) { setLinkField(data.data.linkField ?? ''); setTcField(data.data.testCaseField ?? ''); } }, [data.data]);
  const links = (data.data?.fields ?? []).filter((f) => f.type === 'Link');
  const texts = (data.data?.fields ?? []).filter((f) => ['String', 'Text', 'Formattable'].includes(f.type));
  const label = (f: OpFields['fields'][number]) => `${f.name} (${f.id})${data.data && f.projects.length < data.data.projects.length ? ` – nur ${f.projects.join(', ')}` : ''}`;
  const save = async () => {
    try {
      await api('PUT', '/api/admin/settings', { changes: { OPENPROJECT_LINK_FIELD: linkField || '', OPENPROJECT_TESTCASE_FIELD: tcField || '' } });
      toast('Rückverweis-Felder gespeichert');
      data.reload();
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const update = async () => {
    setBusy(true);
    try {
      const dry = await api<{ checked: number; set: number; unchanged: number; foreign: number; notInProject: number; errors: string[] }>('POST', '/api/admin/integrations/openproject/backlinks', { dryRun: true });
      if (!dry.set) { toast(`Nichts zu aktualisieren (${dry.unchanged} aktuell, ${dry.foreign} mit fremdem Wert)${dry.errors.length ? ` – ${dry.errors.length} Fehler` : ''}`); return; }
      const ok = await askConfirm({ title: 'Rückverweise in OpenProject aktualisieren',
        message: `${dry.set} Arbeitspakete erhalten den aktuellen Anemo-Link (${data.data?.publicUrl ?? ''}/go/…). ${dry.unchanged} sind schon aktuell, ${dry.foreign} haben im Feld einen fremden Wert und bleiben unverändert.${dry.errors.length ? ` ${dry.errors.length} ließen sich nicht prüfen.` : ''}`,
        confirmLabel: 'Aktualisieren' });
      if (!ok) return;
      const r = await api<{ set: number; errors: string[] }>('POST', '/api/admin/integrations/openproject/backlinks', { dryRun: false });
      toast(`${r.set} Rückverweise aktualisiert${r.errors.length ? ` – ${r.errors.length} Fehler: ${r.errors[0]}` : ''}`, r.errors.length ? 'bad' : undefined);
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };
  if (!enabled) return null;
  return (
    <div className="card"><div className="card-body stack">
      <h3>Rückverweis in OpenProject</h3>
      <p className="small muted">Statt die Adresse in den Beschreibungstext zu schreiben, füllt Anemo beim Anlegen ein <b>Link-Feld</b> mit einem dauerhaften
        Link (<span className="mono">…/go/ausfuehrung/…</span>) und optional ein Textfeld mit dem Testfallschlüssel. In OpenProject erscheint der Bezug dann in den
        Attributen, ist klickbar und filterbar. Das Feld legen Sie in OpenProject unter <i>Administration → Benutzerdefinierte Felder → Arbeitspakete</i> an
        (Format <b>Link</b>, z. B. „Anemo“), ordnen es dem Typ neuer Fehler zu und aktivieren es in den Projekten.</p>
      {!data.data?.publicUrl && data.data && <div className="notice warn small">Die öffentliche Adresse von Anemo fehlt (Einstellungen → Allgemein) – ohne sie gibt es keine Links.</div>}
      <ErrorNote error={data.error} />
      {(data.data?.problems ?? []).map((p) => <div key={p} className="notice warn small">{p}</div>)}
      <div className="grid2">
        <label className="field">Link-Feld (Rückverweis)
          <select value={linkField} onChange={(e) => setLinkField(e.target.value)}>
            <option value="">– keines (Link nur im Text) –</option>
            {links.map((f) => <option key={f.id} value={f.id}>{label(f)}</option>)}
            {linkField && !links.some((f) => f.id === linkField) && <option value={linkField}>{linkField} (nicht gefunden)</option>}
          </select>
          {data.data && !links.length && <span className="small muted">In den zugeordneten Projekten ist noch kein Feld vom Format Link aktiv.</span>}
        </label>
        <label className="field">Textfeld für den Testfall (optional)
          <select value={tcField} onChange={(e) => setTcField(e.target.value)}>
            <option value="">– keines –</option>
            {texts.map((f) => <option key={f.id} value={f.id}>{label(f)}</option>)}
            {tcField && !texts.some((f) => f.id === tcField) && <option value={tcField}>{tcField} (nicht gefunden)</option>}
          </select>
        </label>
      </div>
      <div className="row">
        <button className="primary" onClick={() => void save()} disabled={!data.data}>Speichern</button>
        <span className="spacer" />
        <button onClick={() => void update()} disabled={busy || !data.data?.linkField} title="Nach einem Umzug oder einer neuen öffentlichen Adresse: Link-Feld in allen verknüpften Arbeitspaketen neu setzen (mit Probelauf)">
          {busy ? 'Prüft …' : 'Rückverweise aktualisieren …'}</button>
      </div>
    </div></div>
  );
}
