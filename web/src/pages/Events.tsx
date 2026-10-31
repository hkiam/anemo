import { useEffect, useMemo, useState } from 'react';
import { EVENT_LABELS } from '../../../shared/events/labels.ts';
import { fmtDate, get } from '../api.ts';
import { ErrorNote } from '../components/common.tsx';

interface AuditEvent { seq: number; type: string; label: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown>; actor: string; occurredAt: string; projectKey: string | null }

/** Geänderte Felder (Audit-Ereignisse mit `changes`) als „Feld: alt → neu“ */
function changesText(p: Record<string, unknown>): string | null {
  const c = p.changes as Record<string, { from: unknown; to: unknown }> | undefined;
  if (!c) return null;
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return Object.entries(c).map(([k, v]) => `${k}: ${show(v.from)} → ${show(v.to)}`).join(' · ');
}

/**
 * Ereignisprotokoll (Audit-Trail): je Projekt für die Testleitung bzw. für die ganze Instanz in der Administration.
 * Neueste zuerst, Filter nach Art, Person und Zeitraum, Export als CSV.
 */
export function EventLog({ projectKey }: { projectKey?: string }) {
  const base = projectKey ? `/api/projects/${projectKey}/events` : '/api/admin/events';
  const [type, setType] = useState('');
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const params = useMemo(() => {
    const q = new URLSearchParams();
    if (type) q.set('type', type);
    if (actor.trim()) q.set('actor', actor.trim());
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    return q;
  }, [type, actor, from, to]);
  const load = async (beforeSeq?: number) => {
    setLoading(true);
    try {
      const q = new URLSearchParams(params);
      if (beforeSeq) q.set('beforeSeq', String(beforeSeq));
      const r = await get<{ items: AuditEvent[]; more: boolean }>(`${base}?${q}`);
      setItems((cur) => (beforeSeq ? [...cur, ...r.items] : r.items));
      setMore(r.more);
      setError(null);
    } catch (e) { setError(e); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [base, params]); // eslint-disable-line react-hooks/exhaustive-deps
  const csv = new URLSearchParams(params);
  csv.set('format', 'csv');
  const types = Object.entries(EVENT_LABELS).sort(([, a], [, b]) => a.localeCompare(b, 'de'));
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'end' }}>
        <label className="field">Ereignis<select value={type} onChange={(e) => setType(e.target.value)} style={{ width: 'auto' }}>
          <option value="">alle</option>{types.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="field">Person<input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Login" style={{ width: 160 }} /></label>
        <label className="field">von<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">bis<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <span className="spacer" />
        <a className="btn" href={`${base}?${csv}`} download>⇩ CSV</a>
      </div>
      <ErrorNote error={error} />
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Ereignisse"><table>
        <thead><tr><th className="fit">Nr.</th><th className="fit">Zeitpunkt</th><th>Ereignis</th>{!projectKey && <th className="fit">Projekt</th>}<th className="fit">Objekt</th><th className="fit">Person</th><th>Angaben</th></tr></thead>
        <tbody>{items.map((e) => (
          <tr key={e.seq}>
            <td className="fit small muted">{e.seq}</td><td className="fit small">{fmtDate(e.occurredAt)}</td>
            <td><span className="badge accent" title={e.type}>{e.label}</span></td>
            {!projectKey && <td className="fit small">{e.projectKey ?? '–'}</td>}
            <td className="fit small">{e.aggregateType}</td>
            <td className="fit small">{e.actor}</td>
            <td className="small event-data">
              {changesText(e.payload) && <div>{changesText(e.payload)}</div>}
              <details><summary className="mono">{JSON.stringify(e.payload)}</summary><pre className="mono">{JSON.stringify(e.payload, null, 2)}</pre></details>
            </td>
          </tr>
        ))}</tbody>
      </table>
        {!loading && items.length === 0 && <div className="empty">Keine Ereignisse für diese Filter.</div>}
        {loading && items.length === 0 && <div className="empty small">Lädt …</div>}
      </div>
      {more && <div><button className="small" disabled={loading} onClick={() => void load(items.at(-1)?.seq)}>Ältere laden</button></div>}
    </div>
  );
}

/** Administration → Ereignisse: Protokoll der ganzen Instanz */
export function Events() {
  return (
    <div className="page" tabIndex={0} role="region" aria-label="Ereignisse"><div className="page-wide stack">
      <h2>Ereignisse</h2>
      <p className="small muted" style={{ margin: 0 }}>Fachliche Ereignisse aller Projekte (Audit-Trail, unveränderlich gespeichert). Je Projekt sieht die Testleitung das Protokoll unter Planung & Ausführung → Protokoll. Für Agenten und Integrationen abonnierbar über <code>GET /api/events?afterSeq=…</code>.</p>
      <EventLog />
    </div></div>
  );
}
