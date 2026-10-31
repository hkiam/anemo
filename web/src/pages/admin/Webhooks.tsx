import { useState } from 'react';
import { api, fmtDate, useApi } from '../../api.ts';
import { ErrorNote, Modal } from '../../components/common.tsx';
import type { Project } from '../../types.ts';
import { askConfirm } from '../../ux.tsx';

interface Delivery { eventSeq: number; eventType: string; ok: boolean; status: number | null; error: string | null; at: string }
interface Hook {
  id: string; name: string; url: string; format: 'json' | 'chat'; eventTypes: string[]; projectKey: string | null; active: boolean;
  failures: number; nextAttemptAt: string | null; deliveries: Delivery[];
}
const LABEL: Record<string, string> = {
  TestFailed: 'Test fehlgeschlagen', TestExecuted: 'Ergebnis erfasst', ExecutionAssigned: 'Ausführung zugewiesen', TestCycleCreated: 'Zyklus angelegt',
  TestAddedToCycle: 'Test eingeplant', TestCaseCreated: 'Testfall angelegt', TestCaseChanged: 'Testfall geändert (neue Version)',
  TestCaseMetaChanged: 'Testfall-Status/Ordner geändert', ReferenceLinked: 'Verweis verknüpft', ReferenceRemoved: 'Verweis entfernt', MigrationCompleted: 'Migration abgeschlossen',
};

/** Webhooks aus dem Ereignisprotokoll (ADR-0019). */
export function Webhooks() {
  const data = useApi<{ eventTypes: string[]; webhooks: Hook[] }>('/api/admin/webhooks');
  const [editing, setEditing] = useState<Hook | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="card"><div className="card-body stack">
      <div className="row"><h3>Webhooks &amp; Benachrichtigungen</h3><span className="spacer" /><button className="primary small" onClick={() => setEditing('new')}>+ Webhook</button></div>
      <p className="small muted">Ereignisse (z. B. „Test fehlgeschlagen“) an Teams/Mattermost/Slack (Format „Chat“) oder eigene Dienste (JSON mit Signatur
        <code> X-Anemo-Signature: sha256=…</code>). Zustellung in Reihenfolge mit Wiederholung; Projekte mit gesperrten externen Diensten senden nichts.</p>
      <ErrorNote error={data.error} />
      {secret && <div className="notice ok">Signaturschlüssel (nur jetzt sichtbar): <code className="mono">{secret}</code></div>}
      {msg && <div className="notice info">{msg}</div>}
      {data.data?.webhooks.length === 0 && <div className="small muted">Noch keine Webhooks.</div>}
      {data.data?.webhooks.map((w) => (
        <details key={w.id} className="webhook">
          <summary className="row">
            <strong>{w.name}</strong><span className="badge neutral">{w.format === 'chat' ? 'Chat' : 'JSON'}</span>
            {!w.active && <span className="badge">inaktiv</span>}
            {w.failures > 0 && <span className="badge bad" title={`nächster Versuch ${fmtDate(w.nextAttemptAt)}`}>{w.failures} Fehlversuch(e)</span>}
            <span className="small muted">{w.projectKey ?? 'alle Projekte'} · {w.eventTypes.length ? w.eventTypes.map((t) => LABEL[t] ?? t).join(', ') : 'alle Ereignisse'}</span>
            <span className="spacer" />
            <button className="small" onClick={async (e) => { e.preventDefault(); const r = await api<{ ok: boolean; status: number | null; error: string | null }>('POST', `/api/admin/webhooks/${w.id}/test`); setMsg(r.ok ? `Testnachricht an „${w.name}“ zugestellt (${r.status}).` : `Testnachricht fehlgeschlagen: ${r.status ?? ''} ${r.error ?? ''}`); }}>Test</button>
            <button className="small" onClick={(e) => { e.preventDefault(); setEditing(w); }}>Bearbeiten</button>
          </summary>
          <div className="small muted mono" style={{ margin: '4px 0' }}>{w.url}</div>
          <table className="small"><tbody>{w.deliveries.map((d) => (
            <tr key={`${d.eventSeq}-${d.at}`}><td className="fit">{fmtDate(d.at)}</td><td className="fit">{LABEL[d.eventType] ?? d.eventType}</td>
              <td className={d.ok ? '' : 'rate-bad'}>{d.ok ? `✓ ${d.status}` : `✗ ${d.status ?? ''} ${d.error ?? ''}`}</td></tr>
          ))}{w.deliveries.length === 0 && <tr><td className="muted">noch keine Zustellungen</td></tr>}</tbody></table>
        </details>
      ))}
      {editing && data.data && <HookEditor hook={editing === 'new' ? null : editing} eventTypes={data.data.eventTypes}
        onClose={() => setEditing(null)} onSaved={(s) => { setEditing(null); if (s) setSecret(s); data.reload(); }} />}
    </div></div>
  );
}

function HookEditor({ hook, eventTypes, onClose, onSaved }: { hook: Hook | null; eventTypes: string[]; onClose: () => void; onSaved: (secret?: string) => void }) {
  const projects = useApi<Project[]>('/api/projects');
  const [f, setF] = useState({ name: hook?.name ?? '', url: hook?.url ?? '', format: hook?.format ?? 'chat', eventTypes: hook?.eventTypes ?? ['TestFailed'], projectKey: hook?.projectKey ?? null, active: hook?.active ?? true });
  const [error, setError] = useState<unknown>(null);
  async function save() {
    try {
      if (hook) {
        await api('PUT', `/api/admin/webhooks/${hook.id}`, f);
        onSaved();
      } else onSaved((await api<{ secret: string }>('POST', '/api/admin/webhooks', f)).secret);
    } catch (e) {
      setError(e);
    }
  }
  async function remove() {
    if (!hook || !(await askConfirm({ title: 'Webhook löschen', message: `Webhook „${hook.name}“ löschen?`, confirmLabel: 'Löschen', danger: true }))) return;
    await api('DELETE', `/api/admin/webhooks/${hook.id}`).catch(setError);
    onSaved();
  }
  return (
    <Modal title={hook ? `Webhook „${hook.name}“` : 'Neuer Webhook'} help="admin-webhooks" onClose={onClose}
      footer={<>{hook && <button className="danger" onClick={remove}>Löschen</button>}<span className="spacer" /><button onClick={onClose}>Abbrechen</button>
        <button className="primary" onClick={save} disabled={!f.name.trim() || !/^https?:\/\//.test(f.url)}>Speichern</button></>}>
      <ErrorNote error={error} />
      <div className="grid2">
        <label className="field">Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></label>
        <label className="field">Format
          <select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value as Hook['format'] })}>
            <option value="chat">Chat (Teams, Mattermost, Slack – Feld „text“)</option><option value="json">JSON (Ereignis mit Signatur)</option>
          </select>
        </label>
      </div>
      <label className="field">Ziel-URL<input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://…" /></label>
      <label className="field">Projekt
        <select value={f.projectKey ?? ''} onChange={(e) => setF({ ...f, projectKey: e.target.value || null })}>
          <option value="">alle Projekte</option>{projects.data?.map((p) => <option key={p.key} value={p.key}>{p.key} – {p.name}</option>)}
        </select>
      </label>
      <div className="field">Ereignisse (keine Auswahl = alle)
        <div className="grid2" style={{ color: 'var(--text)' }}>{eventTypes.map((t) => (
          <label key={t} className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.eventTypes.includes(t)}
            onChange={(e) => setF({ ...f, eventTypes: e.target.checked ? [...f.eventTypes, t] : f.eventTypes.filter((x) => x !== t) })} />{LABEL[t] ?? t}</label>
        ))}</div>
      </div>
      <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />aktiv</label>
    </Modal>
  );
}
