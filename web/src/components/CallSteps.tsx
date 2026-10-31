import { useState } from 'react';
import { useApi } from '../api.ts';
import type { Step, TestCaseListItem } from '../types.ts';
import { ErrorNote, Modal } from './common.tsx';
import { limitHint, plural } from '../text.ts';

/** Aufruf-Schritt im Editor: aufgerufener Testfall, festgelegte Version, Hinweis auf neuere Version. */
export function CallStepCell({ step, onChange }: { step: Step; onChange: (s: Step) => void }) {
  const tc = useApi<{ key: string; currentVersion: number; version: { title: string; steps: Step[] } }>(step.call ? `/api/test-cases/${step.call.testCaseId}` : null);
  if (!step.call) return null;
  const pinned = step.call.versionNo ?? null;
  const newer = tc.data && pinned !== null && tc.data.currentVersion > pinned;
  return (
    <div className="call-cell">
      <div className="row"><span aria-hidden>↪</span>
        <b>Aufruf {tc.data?.key ?? '…'}</b> <span>{tc.data?.version.title}</span>
        <span className="badge neutral">{pinned ? `v${pinned}` : 'aktuelle Version'}</span>
        {newer && <button type="button" className="small" onClick={() => onChange({ ...step, call: { ...step.call!, versionNo: tc.data!.currentVersion } })}
          title="Aufruf auf die neueste Fassung heben">auf v{tc.data!.currentVersion} aktualisieren</button>}
      </div>
      <div className="small muted">{tc.data ? `${tc.data.version.steps.length} Schritte werden bei der Ausführung eingesetzt` : ''} · Version wird beim Speichern festgeschrieben, damit spätere Änderungen bestehende Abläufe nicht unbemerkt verändern.</div>
    </div>
  );
}

/** Testfall zum Aufrufen wählen (gleiches Projekt, nicht der eigene). */
export function TestCasePickerDialog({ projectKey, excludeId, onClose, onPick }: { projectKey: string; excludeId?: string | undefined; onClose: () => void; onPick: (t: TestCaseListItem) => void }) {
  const [q, setQ] = useState('');
  const LIMIT = 50;
  const list = useApi<{ items: TestCaseListItem[]; total: number }>(`/api/projects/${projectKey}/test-cases?limit=${LIMIT}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const items = (list.data?.items ?? []).filter((t) => t.id !== excludeId && t.format === 'CLASSIC');
  const more = limitHint(list.data?.items.length ?? 0, list.data?.total, 'Suche verfeinern');
  return (
    <Modal title="Testfall aufrufen" help="call-test" onClose={onClose} footer={<><span className="spacer" /><button onClick={onClose}>Abbrechen</button></>}>
      <p className="small muted">Die Schritte des gewählten Testfalls werden bei der Durchführung an dieser Stelle eingesetzt (bis 5 Ebenen tief). Typisch: Anmelden,
        Akte anlegen, Daten vorbereiten. Aufrufbar sind Testfälle mit Schritten (keine Gherkin- oder Freitext-Tests).</p>
      <input type="search" autoFocus placeholder="Testfall suchen (Titel, Schlüssel) …" aria-label="Testfall zum Aufrufen suchen" value={q} onChange={(e) => setQ(e.target.value)} />
      <ErrorNote error={list.error} />
      <div className="table-wrap" style={{ maxHeight: 360 }}><table><tbody>
        {items.map((t) => (
          <tr key={t.id} className="clickable" onClick={() => onPick(t)}>
            <td className="fit mono small">{t.key}</td>
            <td><button type="button" className="link" onClick={(e) => { e.stopPropagation(); onPick(t); }} aria-label={`${t.key} ${t.title} aufrufen`}>{t.title}</button></td>
            <td className="fit small muted">{plural(t.stepCount, 'Schritt', 'Schritte')}</td>
          </tr>
        ))}
      </tbody></table>
        {!list.data && !list.error && <div className="empty small">Lädt …</div>}
        {list.data && items.length === 0 && <div className="empty">{q ? 'Keine passenden Testfälle mit Schritten.' : 'Keine aufrufbaren Testfälle im Projekt.'}</div>}
      </div>
      {more && <div className="small muted" role="status">{more}</div>}
    </Modal>
  );
}
