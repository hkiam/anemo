import { useState } from 'react';
import { api, useApi } from '../api.ts';
import { href, navigate } from '../router.ts';
import type { ConfigDimension, Cycle, ExecutionStatus } from '../types.ts';
import { ErrorNote, Modal, StatusBadge } from './common.tsx';
import { allCombinations, type Parameter, pairwise } from '../../../shared/combinatorics/combinatorics.ts';

/**
 * Zyklus wiederholen: neuer Build, optional nur Nachtest, optional je Konfiguration ein Zyklus – bei mehreren Merkmalen
 * alle Kombinationen oder paarweise (jedes Wertepaar zweier Merkmale mindestens einmal).
 */
export function RepeatCycleDialog({ projectKey, cycle, onClose }: { projectKey: string; cycle: Cycle; onClose: () => void }) {
  const dims = useApi<ConfigDimension[]>('/api/configuration/dimensions');
  const [name, setName] = useState(`${cycle.name} (Wiederholung)`);
  const [build, setBuild] = useState(cycle.build ?? '');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [mode, setMode] = useState<'pairwise' | 'all'>('pairwise');
  const [error, setError] = useState<unknown>(null);
  const params: Parameter[] = (dims.data ?? []).filter((d) => (sel[d.key] ?? []).length).map((d) => ({ name: d.key, values: sel[d.key]! }));
  let configs: Record<string, string[]>[] = [];
  let comboError: string | null = null;
  try {
    const rows = params.length <= 1 ? (params[0]?.values.map((v) => [v]) ?? []) : mode === 'all' ? allCombinations(params, [], 20) : pairwise(params);
    configs = rows.map((r) => Object.fromEntries(r.map((v, i) => [params[i]!.name, [v]])));
  } catch (e) { comboError = (e as Error).message; }
  const total = params.reduce((n, p) => n * p.values.length, params.length ? 1 : 0);
  async function save() {
    try {
      const r = await api<{ cycles: { id: string; name: string; added: number }[] }>('POST', `/api/cycles/${cycle.id}/repeat`, {
        name, build: build || null, onlyProblems, configurations: configs.length ? configs : undefined,
      });
      navigate(['p', projectKey, 'cycles', r.cycles[0]!.id]);
      onClose();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Modal title={`Zyklus „${cycle.name}“ wiederholen`} help="cycle-repeat" onClose={onClose}
      footer={<><span className="small muted">{params.length > 1 && !comboError ? `${configs.length} Zyklen${mode === 'pairwise' ? ` statt ${total} (alle Kombinationen)` : ''}` : ''}</span><span className="spacer" />
        <button onClick={onClose}>Abbrechen</button><button className="primary" onClick={save} disabled={!name.trim() || !!comboError || configs.length > 20}>
        {configs.length > 1 ? `${configs.length} Zyklen anlegen` : 'Zyklus anlegen'}</button></>}>
      <ErrorNote error={error} />
      <div className="grid2">
        <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <label className="field">Build<input value={build} onChange={(e) => setBuild(e.target.value)} placeholder="z. B. 7.4.3" /></label>
      </div>
      <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
        Nur Nachtest: fehlgeschlagene, blockierte und offene Tests übernehmen</label>
      <div className="field">Je Konfiguration ein eigener Zyklus (optional, Werte ankreuzen)
        {(dims.data ?? []).map((d) => (
          <div key={d.key} className="row small" style={{ color: 'var(--text)', flexWrap: 'wrap' }}><b style={{ minWidth: 110 }}>{d.name}</b>
            {d.values.map((v) => (
              <label key={v.id} className="row"><input type="checkbox" style={{ width: 'auto' }} checked={(sel[d.key] ?? []).includes(v.value)}
                onChange={(e) => setSel((x) => ({ ...x, [d.key]: e.target.checked ? [...(x[d.key] ?? []), v.value] : (x[d.key] ?? []).filter((y) => y !== v.value) }))} />{v.value}</label>
            ))}
          </div>
        ))}
      </div>
      {params.length > 1 && <div className="row" role="radiogroup" aria-label="Kombination">
        <label className="row small"><input type="radio" style={{ width: 'auto' }} checked={mode === 'pairwise'} onChange={() => setMode('pairwise')} /> paarweise (jedes Wertepaar zweier Merkmale mindestens einmal)</label>
        <label className="row small"><input type="radio" style={{ width: 'auto' }} checked={mode === 'all'} onChange={() => setMode('all')} /> alle Kombinationen</label>
      </div>}
      {comboError && <div className="notice warn small">{comboError}</div>}
      {configs.length > 20 && <div className="notice warn small">Höchstens 20 Zyklen auf einmal – bitte paarweise oder weniger Werte wählen.</div>}
      {configs.length > 1 && <div className="table-wrap" style={{ maxHeight: 200 }}><table className="small"><tbody>
        {configs.map((c, i) => <tr key={i}><td className="fit">{i + 1}</td><td>{Object.entries(c).map(([k, v]) => `${dims.data?.find((d) => d.key === k)?.name ?? k}: ${v.join('')}`).join(' · ')}</td></tr>)}
      </tbody></table></div>}
      <p className="small muted">Übernommen werden die Testfälle in ihrer <strong>aktuellen</strong> Version, Zuständige bleiben erhalten.</p>
    </Modal>
  );
}

interface Comparison {
  a: { id: string; name: string; build: string | null }; b: { id: string; name: string; build: string | null };
  counts: Record<string, number>;
  items: { key: string; title: string; change: string; a: { status: string; executionId: string; version: number } | null; b: { status: string; executionId: string; version: number } | null }[];
}
const CHANGE: Record<string, [string, string]> = {
  regression: ['Regression', 'bad'], fixed: ['behoben', 'ok'], stillFailing: ['weiterhin fehlerhaft', 'warn'], other: ['geändert', 'neutral'],
  same: ['unverändert', 'neutral'], onlyA: ['nur links', 'neutral'], onlyB: ['nur rechts', 'neutral'],
};

/** Zwei Zyklen vergleichen (z. B. Build 7.4.2 gegen 7.4.3). */
export function CompareDialog({ projectKey, cycle, statuses, onClose }: { projectKey: string; cycle: Cycle; statuses: ExecutionStatus[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const candidates = useApi<{ items: Cycle[] }>(`/api/projects/${projectKey}/cycles?limit=30${q ? `&q=${encodeURIComponent(q)}` : cycle.planId ? `&planId=${cycle.planId}` : ''}`);
  const [other, setOther] = useState<string | null>(null);
  const cmp = useApi<Comparison>(other ? `/api/cycle-comparison?a=${other}&b=${cycle.id}` : null);
  const [filter, setFilter] = useState<string | null>(null);
  const items = (cmp.data?.items ?? []).filter((i) => !filter || i.change === filter);
  return (
    <Modal size="large" title={`„${cycle.name}“ vergleichen`} onClose={onClose} footer={<button onClick={onClose}>Schließen</button>}>
      <div className="row">
        <input placeholder="Vergleichszyklus suchen (Name, Build, Umgebung)" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
        <select value={other ?? ''} onChange={(e) => { setOther(e.target.value || null); setFilter(null); }} style={{ flex: 1, width: 'auto' }} aria-label="Vergleichszyklus">
          <option value="">Vergleichszyklus wählen (links = älterer Stand) …</option>
          {candidates.data?.items.filter((c) => c.id !== cycle.id).map((c) => <option key={c.id} value={c.id}>{c.name}{c.build ? ` · Build ${c.build}` : ''}</option>)}
        </select>
      </div>
      <ErrorNote error={cmp.error} />
      {cmp.data && <>
        <div className="stat-chips">
          <button className={`chip-btn ${!filter ? 'on' : ''}`} onClick={() => setFilter(null)}>Alle ({cmp.data.items.length})</button>
          {Object.entries(CHANGE).filter(([k]) => cmp.data!.counts[k]).map(([k, [label]]) => (
            <button key={k} className={`chip-btn ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{label} ({cmp.data!.counts[k]})</button>
          ))}
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th className="fit">Testfall</th><th>Titel</th><th className="fit">{cmp.data.a.name}{cmp.data.a.build ? ` (${cmp.data.a.build})` : ''}</th>
            <th className="fit">{cmp.data.b.name}{cmp.data.b.build ? ` (${cmp.data.b.build})` : ''}</th><th className="fit">Veränderung</th></tr></thead>
          <tbody>{items.map((i) => (
            <tr key={i.key}>
              <td className="fit mono small"><a href={href(['p', projectKey, 'repo'], { tc: i.key })}>{i.key}</a></td><td>{i.title}</td>
              <td className="fit">{i.a ? <a href={href(['p', projectKey, 'cycles', cmp.data!.a.id], { exec: i.a.executionId })}><StatusBadge code={i.a.status} statuses={statuses} /></a> : '–'}</td>
              <td className="fit">{i.b ? <a href={href(['p', projectKey, 'cycles', cmp.data!.b.id], { exec: i.b.executionId })}><StatusBadge code={i.b.status} statuses={statuses} /></a> : '–'}</td>
              <td className="fit"><span className={`badge ${CHANGE[i.change]![1]}`}>{CHANGE[i.change]![0]}</span></td>
            </tr>
          ))}</tbody>
        </table></div>
      </>}
    </Modal>
  );
}

/** Offene Ausführungen nach Auslastung verteilen. */
export function DistributeDialog({ cycleId, onClose, onDone }: { cycleId: string; onClose: () => void; onDone: () => void }) {
  const dir = useApi<{ users: { id: string; username: string; displayName: string }[] }>('/api/directory');
  const [people, setPeople] = useState<string[]>([]);
  const [extra, setExtra] = useState('');
  const [onlyUnassigned, setOnly] = useState(true);
  const [weight, setWeight] = useState<'steps' | 'count' | 'duration'>('duration');
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<unknown>(null);
  async function go() {
    try {
      const all = [...people, ...extra.split(',').map((x) => x.trim()).filter(Boolean)];
      const r = await api<{ assigned: Record<string, number> }>('POST', `/api/cycles/${cycleId}/distribute`, { assignees: all, onlyUnassigned, weight });
      setResult(r.assigned);
      onDone();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Modal title="Nach Auslastung verteilen" help="cycle-repeat" onClose={onClose}
      footer={<><button onClick={onClose}>{result ? 'Schließen' : 'Abbrechen'}</button>{!result && <button className="primary" onClick={go} disabled={!people.length && !extra.trim()}>Verteilen</button>}</>}>
      <ErrorNote error={error} />
      {result ? <div className="notice ok">{Object.entries(result).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div> : <>
        <p className="small muted">Offene Ausführungen werden an die jeweils am wenigsten ausgelastete Person vergeben (bestehende offene Ausführungen
          im Projekt zählen mit); große Tests zuerst.</p>
        <div className="field">Personen
          <div className="table-wrap" style={{ maxHeight: 240 }}><table><tbody>{dir.data?.users.map((u) => (
            <tr key={u.id}><td className="fit"><input type="checkbox" style={{ width: 'auto' }} checked={people.includes(u.username)}
              onChange={(e) => setPeople((p) => (e.target.checked ? [...p, u.username] : p.filter((x) => x !== u.username)))} aria-label={u.username} /></td>
              <td>{u.displayName}</td><td className="small muted">{u.username}</td></tr>
          ))}</tbody></table></div>
        </div>
        <label className="field">Weitere Namen (Komma-getrennt, z. B. aus dem Altsystem)<input value={extra} onChange={(e) => setExtra(e.target.value)} /></label>
        <div className="row">
          <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={onlyUnassigned} onChange={(e) => setOnly(e.target.checked)} />nur noch nicht zugewiesene</label>
          <select value={weight} onChange={(e) => setWeight(e.target.value as 'steps' | 'count' | 'duration')} style={{ width: 'auto' }} aria-label="Gewichtung">
            <option value="duration">Aufwand nach Schätzung (sonst gemessene Dauer, sonst Schritte)</option>
            <option value="steps">Aufwand nach Schrittanzahl</option><option value="count">je Test gleich</option>
          </select>
        </div>
      </>}
    </Modal>
  );
}
