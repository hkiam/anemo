import { useEffect, useState } from 'react';
import { api, fmtDate, useApi } from '../../api.ts';
import { ErrorNote } from '../../components/common.tsx';
import { href } from '../../router.ts';
import { askConfirm, toast, useUnsavedGuard } from '../../ux.tsx';
import { SettingsGroup, useSettings } from './Settings.tsx';

interface AiAdmin {
  enabled: boolean; configured: boolean; agentsEnabled: boolean; maxPerHour: number; lastHour: number; blockedProjects: number;
  llm: { provider: string; model: string; onPrem: boolean } | null;
  strong: { provider: string; model: string; onPrem: boolean } | null;
  configError: string | null;
  features: { key: string; title: string; where: string; kind: string; status: string }[];
  usage: { feature: string; calls: number; errors: number; avgMs: number; lastAt: string }[];
  recentErrors: { at: string; feature: string; error: string }[];
}
interface Prompt { key: string; title: string; where: string; output: string; system: string; default: string; customized: boolean; profile: 'default' | 'strong'; defaultProfile: string; updatedBy: string | null; updatedAt: string | null }

const STATUS_CLS: Record<string, string> = { aktiv: 'ok', regelbasiert: 'neutral', 'ohne Modell': 'warn', aus: 'bad' };

/** Administration → KI: Hauptschalter, Modell, Funktionen und wo sie wirken, Nutzung, Prompts (Skills). */
export function Ai() {
  const ai = useApi<AiAdmin>('/api/admin/ai');
  const { data, error, merge } = useSettings();
  const prompts = useApi<Prompt[]>('/api/admin/ai/prompts');
  const toggle = async (key: 'AI_ENABLED' | 'AGENTS_ENABLED', on: boolean) => {
    if (!on && !(await askConfirm({
      title: key === 'AI_ENABLED' ? 'KI-Funktionen ausschalten' : 'KI-Agenten ausschalten',
      message: key === 'AI_ENABLED' ? 'Keine Anfragen mehr an ein Sprachmodell; KI-Schaltflächen verschwinden. Regelbasierte Analysen bleiben.' : 'Die MCP-Schnittstelle lehnt danach alle Anfragen von Agenten ab.',
      confirmLabel: 'Ausschalten', danger: true,
    }))) return;
    const r = await api<{ settings: never; log: never }>('PUT', '/api/admin/settings', { changes: { [key]: on ? 'true' : 'false' } });
    merge(r);
    ai.reload();
    toast(`${key === 'AI_ENABLED' ? 'KI-Funktionen' : 'KI-Agenten'} ${on ? 'eingeschaltet' : 'ausgeschaltet'}`);
  };
  const a = ai.data;
  return (
    <div className="stack">
      <h2>KI</h2>
      <ErrorNote error={ai.error ?? error} />
      {a && (
        <div className="ai-switches">
          <div className={`card ai-switch ${a.enabled ? 'on' : ''}`}><div className="card-body stack">
            <div className="row"><strong>KI-Funktionen</strong><span className="spacer" />
              <label className="switch"><input type="checkbox" checked={a.enabled} onChange={(e) => toggle('AI_ENABLED', e.target.checked)} aria-label="KI-Funktionen ein/aus" /><span /></label></div>
            <span className="small">{!a.enabled ? 'Ausgeschaltet – es geht nichts an ein Sprachmodell.' : a.llm
              ? <>Aktiv mit <strong>{a.llm.model}</strong> ({a.llm.provider === 'anthropic' ? 'Anthropic' : 'OpenAI-kompatibel'}, {a.llm.onPrem ? 'on-prem' : 'extern'})</>
              : 'Eingeschaltet, aber noch kein Modell eingerichtet (unten).'}</span>
            <ErrorNote error={a.configError} />
            <span className="small muted">{a.lastHour} Anfragen in der letzten Stunde{a.maxPerHour > 0 ? ` · Grenze ${a.maxPerHour}/h` : ''}</span>
          </div></div>
          <div className={`card ai-switch ${a.agentsEnabled ? 'on' : ''}`}><div className="card-body stack">
            <div className="row"><strong>KI-Agenten (MCP)</strong><span className="spacer" />
              <label className="switch"><input type="checkbox" checked={a.agentsEnabled} onChange={(e) => toggle('AGENTS_ENABLED', e.target.checked)} aria-label="KI-Agenten ein/aus" /><span /></label></div>
            <span className="small">Externe Agenten (z. B. Claude, Copilot, eigene Skripte) lesen Testfälle und führen Tests aus. Ergebnisse brauchen eine QA-Freigabe.</span>
            <span className="small muted">Konten: <a href={href(['admin', 'users'])}>Benutzer</a> mit „KI-Agent“ · Anleitung: <a href={href(['hilfe', 'agenten'])}>KI-Agenten</a></span>
          </div></div>
          <div className="card"><div className="card-body stack">
            <strong>Datenschutz</strong>
            <span className="small">{a.blockedProjects} Projekt(e) mit gesperrten externen Diensten: dort arbeitet nur ein als <em>on-prem</em> gekennzeichnetes Modell, Agenten sehen sie nicht.</span>
            <span className="small muted">Je Projekt: <a href={href(['admin', 'projects'])}>Projekte &amp; Rechte</a></span>
          </div></div>
        </div>
      )}

      {data && <SettingsGroup group="ai" title="Sprachmodell" settings={data.settings} exclude={['AI_ENABLED', 'AGENTS_ENABLED']} onSaved={(d) => { merge(d); ai.reload(); }}
        description="On-prem: vLLM, Ollama, LM Studio oder LocalAI stellen eine OpenAI-kompatible Schnittstelle bereit (Basis-URL bis /v1). Extern: OpenAI, Azure OpenAI (Basis-URL der Bereitstellung) oder Anthropic." />}
      {data && <SettingsGroup group="ai-strong" title="Profil „stark“ (optional)" settings={data.settings} onSaved={(d) => { merge(d); ai.reload(); }}
        description="Zweites Modell, z. B. extern und leistungsfähiger, für anspruchsvolle Skills wie das Abschlussbericht-Fazit. Ohne Eintrag nutzen alle Skills das Standardmodell. Projekte mit gesperrten externen Diensten fallen auf ein on-prem-Modell zurück." />}

      {a && (
        <section className="card"><div className="card-body stack">
          <h3>Wo KI in Anemo wirkt</h3>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Wo KI in Anemo wirkt"><table>
            <thead><tr><th>Funktion</th><th>Wo</th><th>Arbeitsweise</th><th className="fit">Status</th></tr></thead>
            <tbody>{a.features.map((f) => (
              <tr key={f.key}><td><strong>{f.title}</strong></td><td className="small">{f.where}</td><td className="small">{f.kind}</td>
                <td className="fit"><span className={`badge ${STATUS_CLS[f.status] ?? 'neutral'}`}>{f.status}</span></td></tr>
            ))}</tbody>
          </table></div>
          <p className="small muted" style={{ margin: 0 }}>Geplante Funktionen und Vorschläge für weitere Skills: <a href={href(['hilfe', 'ki-assistenz'])}>Hilfe → KI-Assistenz</a>.</p>
        </div></section>
      )}

      {a && (
        <section className="card"><div className="card-body stack">
          <h3>Nutzung (30 Tage)</h3>
          {a.usage.length === 0 ? <div className="muted small">Noch keine Anfragen.</div> : (
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Nutzung der KI (30 Tage)"><table>
              <thead><tr><th>Funktion</th><th className="fit">Anfragen</th><th className="fit">Fehler</th><th className="fit">Ø Dauer</th><th className="fit">zuletzt</th></tr></thead>
              <tbody>{a.usage.map((u) => <tr key={u.feature}><td>{prompts.data?.find((p) => p.key === u.feature)?.title ?? u.feature}</td><td className="fit">{u.calls}</td>
                <td className="fit">{u.errors ? <span className="err">{u.errors}</span> : 0}</td><td className="fit">{(u.avgMs / 1000).toFixed(1)} s</td><td className="fit small">{fmtDate(u.lastAt)}</td></tr>)}</tbody>
            </table></div>
          )}
          {a.recentErrors.length > 0 && <details className="small"><summary>Letzte Fehler</summary>
            <ul>{a.recentErrors.map((e, i) => <li key={i}>{fmtDate(e.at)} · {e.feature}: {e.error}</li>)}</ul></details>}
          <p className="small muted" style={{ margin: 0 }}>Protokolliert werden Zeitpunkt, Person, Projekt, Funktion, Modell, Textlängen und Dauer – keine Inhalte.</p>
        </div></section>
      )}

      <section className="card"><div className="card-body stack">
        <h3>Prompts (Skills)</h3>
        <p className="small muted" style={{ margin: 0 }}>Anweisungen an das Modell je Funktion. Anpassungen gelten sofort; „Standard“ stellt den mitgelieferten Text wieder her.</p>
        <ErrorNote error={prompts.error} />
        {prompts.data?.map((p) => <PromptEditor key={p.key} prompt={p} onSaved={prompts.reload} />)}
      </div></section>
    </div>
  );
}

function PromptEditor({ prompt, onSaved }: { prompt: Prompt; onSaved: () => void }) {
  const setProfile = async (profile: 'default' | 'strong') => {
    try {
      await api('PUT', `/api/admin/ai/prompts/${prompt.key}`, { system: prompt.customized ? prompt.system : null, profile });
      toast(`„${prompt.title}“ nutzt jetzt das Profil ${profile === 'strong' ? '„stark“' : 'Standard'}`);
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  const [text, setText] = useState(prompt.system);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => setText(prompt.system), [prompt.system]);
  const dirty = text !== prompt.system;
  useUnsavedGuard(dirty, `prompt-${prompt.key}`);
  const save = async (system: string | null) => {
    try {
      await api('PUT', `/api/admin/ai/prompts/${prompt.key}`, { system });
      toast(system === null ? `„${prompt.title}“: Standard wiederhergestellt` : `Prompt „${prompt.title}“ gespeichert`);
      onSaved();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <details className="prompt-editor" open={open || dirty} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary><strong>{prompt.title}</strong> <span className="small muted">· {prompt.where}</span>
        {prompt.customized && <span className="badge accent" style={{ marginLeft: 6 }} title={`angepasst von ${prompt.updatedBy}, ${fmtDate(prompt.updatedAt)}`}>angepasst</span>}</summary>
      <div className="stack" style={{ marginTop: 8 }}>
        <ErrorNote error={error} />
        <textarea className="mono" rows={Math.min(18, Math.max(5, text.split('\n').length + 1))} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <div className="row small"><label className="row">Modellprofil
          <select value={prompt.profile} onChange={(e) => setProfile(e.target.value as 'default' | 'strong')} style={{ width: 'auto' }} aria-label={`Modellprofil ${prompt.title}`}>
            <option value="default">Standard</option><option value="strong">stark</option>
          </select></label></div>
        <div className="row small"><span className="muted">Erwartete Ausgabe: {prompt.output}</span><span className="spacer" />
          {prompt.customized && <button className="small" onClick={() => save(null)}>Standard wiederherstellen</button>}
          {dirty && <button className="small ghost" onClick={() => setText(prompt.system)}>Verwerfen</button>}
          <button className="small primary" disabled={!dirty || text.trim().length < 20} onClick={() => save(text)}>Speichern</button></div>
      </div>
    </details>
  );
}
