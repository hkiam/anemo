import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { askConfirm, fmtMinutes, parseEstimate, toast, useUnsavedGuard } from '../ux.tsx';
import { plural } from '../text.ts';
import { ErrorNote, Modal } from './common.tsx';
import { PriorityBadge, usePriorities } from './Fields.tsx';
import { QueryInput } from './QueryInput.tsx';

interface Factor { key: string; label: string; points: number; detail?: string }
interface Item {
  id: string; key: string; title: string; priority: string | null; components: string[]; score: number; factors: Factor[];
  lastStatus: string | null; minutes: number; estimated: boolean; selected: boolean; inCycle: boolean;
}
interface Result {
  items: Item[];
  /** Kandidaten über der Obergrenze abgeschnitten (älterer Server: Anzeige gekürzt) */
  truncated: boolean; candidatesTruncated?: boolean; candidateLimit?: number;
  /** Hinweis des Servers, z. B. „Mehr als 2000 Testfälle – bitte mit einer Abfrage eingrenzen“ */
  hint?: string | null;
  summary: { candidates: number; selected: number; selectedMinutes: number; totalMinutes: number; riskCovered: number; withoutEstimate: number };
  ai: { summary: string | null; applied: number; model: string } | null;
}
const splitList = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

/**
 * Risikobasierte Auswahl für einen Zyklus: Umfang (Abfrage), Budget (Zeit oder Anzahl) und Änderungsumfang angeben,
 * Vorschlag prüfen, anpassen und aufnehmen. Jeder Risikowert ist über seine Faktoren nachvollziehbar.
 */
export function RiskSelectionDialog({ projectKey, cycleId, onClose, onAdded }: { projectKey: string; cycleId: string; onClose: () => void; onAdded: () => void }) {
  const priorities = usePriorities();
  const assist = useApi<{ llm: { model: string } | null }>('/api/assist/status');
  const [aql, setAql] = useState('');
  const [mode, setMode] = useState<'time' | 'count'>('time');
  const [budget, setBudget] = useState('1d');
  const [count, setCount] = useState('30');
  const [changeText, setChangeText] = useState('');
  const [components, setComponents] = useState('');
  const [requirements, setRequirements] = useState('');
  const [ai, setAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [r, setR] = useState<Result | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  // Schutz der Eingaben (Änderungsbeschreibung, berechneter und angepasster Vorschlag)
  const dirty = !!(changeText.trim() || components.trim() || requirements.trim() || aql.trim() || r);
  useUnsavedGuard(dirty, `risk-${cycleId}`);
  const close = async () => {
    if (dirty && !(await askConfirm({ title: 'Risikoauswahl verwerfen?', message: 'Änderungsumfang und Vorschlag gehen beim Schließen verloren; aufgenommen wird nichts.', confirmLabel: 'Verwerfen', danger: true }))) return;
    onClose();
  };

  const minutes = parseEstimate(budget);
  const budgetOk = mode === 'count' ? Number(count) >= 1 : minutes !== null && !Number.isNaN(minutes) && minutes > 0;
  const run = async () => {
    setBusy(true); setError(null);
    try {
      const res = await api<Result>('POST', `/api/projects/${projectKey}/risk-selection`, {
        aql: aql || undefined, cycleId, ai: ai || undefined,
        ...(mode === 'time' ? { budgetMinutes: minutes } : { maxTests: Math.min(1000, Number(count)) }),
        change: { text: changeText || undefined, components: splitList(components), requirements: splitList(requirements) },
      });
      setR(res);
      setSel(new Set(res.items.filter((i) => i.selected).map((i) => i.id)));
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const add = async () => {
    const ids = [...sel];
    setBusy(true);
    try {
      let added = 0;
      for (let i = 0; i < ids.length; i += 1000) added += (await api<{ added: number }>('POST', `/api/cycles/${cycleId}/executions`, { testCaseIds: ids.slice(i, i + 1000) })).added;
      toast(`${plural(added, 'Test', 'Tests')} risikobasiert aufgenommen`);
      onAdded();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const chosen = r?.items.filter((i) => sel.has(i.id)) ?? [];
  const chosenMin = chosen.reduce((a, i) => a + i.minutes, 0);
  const totalScore = r?.items.reduce((a, i) => a + i.score, 0) ?? 0;
  const covered = totalScore ? Math.round((1000 * chosen.reduce((a, i) => a + i.score, 0)) / totalScore) / 10 : 0;
  const max = Math.max(1, ...(r?.items.map((i) => i.score) ?? [1]));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <Modal title="Risikobasierte Testauswahl" help="risk" size="large" onClose={() => void close()}
      footer={<>{r && <span className="small muted">{chosen.length} ausgewählt · {fmtMinutes(chosenMin)} · deckt {covered.toLocaleString('de-DE')} % des Risikos</span>}
        <span className="spacer" />
        <button onClick={() => void close()}>Abbrechen</button>
        <button className="primary" disabled={!sel.size || busy} title={!r ? 'Erst einen Vorschlag berechnen' : !sel.size ? 'Keine Testfälle ausgewählt' : undefined} onClick={add}>Auswahl aufnehmen ({sel.size})</button></>}>
      <ErrorNote error={error} />
      <div className="risk-form">
        <label className="stack" style={{ gap: 4 }}><span className="small muted">Umfang (Abfrage, leer = alle gültigen Testfälle)</span>
          <QueryInput scope="testcase" value={aql} onSubmit={setAql} onChange={setAql} placeholder="z. B. komponente = Anmeldung oder priorität >= Schwer" /></label>
        <div className="row wrap">
          <span className="small muted">Budget</span>
          <select aria-label="Budgetart" value={mode} onChange={(e) => setMode(e.target.value as 'time' | 'count')} style={{ width: 'auto' }}>
            <option value="time">Zeit</option><option value="count">Anzahl Tests</option>
          </select>
          {mode === 'time'
            ? <input aria-label="Zeitbudget" value={budget} onChange={(e) => setBudget(e.target.value)} style={{ width: 110 }} placeholder="z. B. 2d, 6h" title="Minuten oder z. B. 6h, 2d (Arbeitstag = 8 h)" />
            : <input aria-label="Anzahl Tests" type="number" min={1} max={1000} value={count} onChange={(e) => setCount(e.target.value)} style={{ width: 90 }} />}
          {mode === 'time' && minutes !== null && !Number.isNaN(minutes) && <span className="small muted">= {fmtMinutes(minutes)}</span>}
        </div>
        <details open={!!(changeText || components || requirements)}>
          <summary>Änderungsumfang des Release (optional)</summary>
          <div className="stack" style={{ marginTop: 6 }}>
            <textarea aria-label="Änderungsbeschreibung" rows={3} value={changeText} onChange={(e) => setChangeText(e.target.value)}
              placeholder="Release Notes, Ticket-Titel oder Commit-Texte einfügen – passende Testfälle steigen im Risiko" />
            <div className="row wrap">
              <input aria-label="Geänderte Komponenten" value={components} onChange={(e) => setComponents(e.target.value)} placeholder="Geänderte Komponenten/Schlagworte, kommagetrennt" style={{ flex: 1, minWidth: 220 }} />
              <input aria-label="Geänderte Anforderungen" value={requirements} onChange={(e) => setRequirements(e.target.value)} placeholder="Geänderte Anforderungen, z. B. DEMO-120, DEMO-133" style={{ flex: 1, minWidth: 220 }} />
            </div>
          </div>
        </details>
        <div className="row wrap">
          {assist.data?.llm && <label className="row small" title="Das Sprachmodell justiert die vorderen 80 Kandidaten anhand der Änderungsbeschreibung, jede Anpassung mit Begründung">
            <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} style={{ width: 'auto' }} /> <span aria-hidden="true">✨ </span>mit KI verfeinern</label>}
          <span className="spacer" />
          <button disabled={!budgetOk || busy} title={budgetOk ? undefined : 'Budget angeben: Zeit (z. B. 6h, 2d) oder Anzahl Tests'} onClick={run}>{busy ? 'Berechnet …' : r ? 'Neu berechnen' : 'Vorschlag berechnen'}</button>
        </div>
      </div>

      {r && <>
        <div className="notice info small">
          {r.summary.candidates} Kandidaten, Gesamtaufwand {fmtMinutes(r.summary.totalMinutes)}. Vorschlag: <b>{r.summary.selected} Tests</b> in {fmtMinutes(r.summary.selectedMinutes)},
          deckt <b>{r.summary.riskCovered.toLocaleString('de-DE')} %</b> des Gesamtrisikos.
          {r.summary.withoutEstimate > 0 && <> {r.summary.withoutEstimate} davon ohne Schätzung (Dauer aus Erfahrungswerten).</>}
          {r.truncated && !r.hint && <> Angezeigt werden die vorderen {r.items.length}.</>}
        </div>
        {r.hint && <div className="notice warn small" role="status">{r.hint}</div>}
        {r.ai && <div className="notice small"><span aria-hidden="true">✨ </span><b>KI-Einschätzung</b> ({r.ai.model}, {r.ai.applied} Anpassungen){r.ai.summary ? `: ${r.ai.summary}` : ''}</div>}
        <div className="table-wrap" style={{ maxHeight: 420 }}><table>
          <thead><tr><th style={{ width: 28 }} /><th>Testfall</th><th className="fit">Priorität</th><th style={{ width: 150 }}>Risiko</th><th>wichtigste Gründe</th><th className="fit">Dauer</th></tr></thead>
          <tbody>{r.items.map((i) => (
            <tr key={i.id} className={i.inCycle ? 'muted' : 'clickable'} onClick={() => !i.inCycle && toggle(i.id)}>
              <td><input type="checkbox" aria-label={`${i.key} auswählen`} disabled={i.inCycle} checked={sel.has(i.id)} style={{ width: 'auto' }}
                onClick={(e) => e.stopPropagation()} onChange={() => toggle(i.id)} /></td>
              <td><span className="mono small">{i.key}</span> {i.title}{i.inCycle && <div className="small">bereits im Zyklus</div>}</td>
              <td className="fit">{i.priority ? <PriorityBadge value={i.priority} priorities={priorities} /> : '–'}</td>
              <td><div className="risk-bar" title={`Risikowert ${i.score}`}><span style={{ width: `${(100 * i.score) / max}%` }} /></div><div className="small muted">{i.score}</div></td>
              <td className="small">
                <button className="link small" onClick={(e) => { e.stopPropagation(); setOpen(open === i.id ? null : i.id); }} aria-expanded={open === i.id}
                  title="Alle Faktoren anzeigen">{i.factors.slice(0, 3).map((f) => f.label).join(' · ') || 'kein erhöhtes Risiko'}</button>
                {open === i.id && <ul className="risk-factors">{i.factors.map((f) => (
                  <li key={f.key}><b className={f.points < 0 ? 'rate-ok' : ''}>{f.points > 0 ? '+' : ''}{f.points}</b> {f.label}{f.detail ? ` – ${f.detail}` : ''}</li>
                ))}</ul>}
              </td>
              <td className="fit small">{fmtMinutes(i.minutes)}{!i.estimated && <span className="muted" title="ohne Schätzung: aus erfassten Zeiten bzw. Projektdurchschnitt"> ~</span>}</td>
            </tr>
          ))}</tbody>
        </table>{!r.items.length && <div className="empty">Keine Testfälle im Umfang.</div>}</div>
      </>}
    </Modal>
  );
}
