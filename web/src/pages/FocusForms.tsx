/**
 * Pflegeformulare für Testplan, Testzyklus und Testfall – als Dialog im Hauptfenster oder als ganze Seite im
 * Fokusfenster (#/f/…). Gespeicherte Änderungen melden sich bei den anderen Fenstern (Listen laden neu).
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api, useApi } from '../api.ts';
import { ErrorNote, Modal } from '../components/common.tsx';
import { ConfigurationEditor, useDimensions } from '../components/Configuration.tsx';
import { References } from '../components/References.tsx';
import { TestCaseEditor } from '../components/TestCaseEditor.tsx';
import { href, navigate } from '../router.ts';
import { useCan } from '../session.tsx';
import type { Configuration, Cycle, Plan, TestCaseDetail } from '../types.ts';
import { askConfirm, confirmLeave, inPopup, notifyChanged, openFocus, toast, useSync, useUnsavedGuard } from '../ux.tsx';
import { WikiEditor } from '../wiki/WikiEditor.tsx';
import { FocusFrame } from './Focus.tsx';
import { FieldInputs, useFieldDefs } from '../components/Fields.tsx';

/** Datum aus der API für <input type="date">. Kalendertage kommen als UTC-Mitternacht – den Tag direkt übernehmen,
 *  damit er in keiner Zeitzone verrutscht. */
function toInputDate(v: string | null | undefined): string {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}(T00:00:00(\.000)?Z)?$/.test(v)) return v.slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Nach dem Speichern im Fokusfenster: Fenster schließen (Hauptfenster aktualisiert sich) bzw. zur Ansicht wechseln. */
function finish(target: string) {
  if (inPopup()) window.close();
  else window.location.hash = target.replace(/^#/, '');
}

/** Dirty-Tracking gegen einen Ausgangsstand; `reset` nach dem Speichern bzw. Laden. */
function useDirty<T>(value: T, key: string): [boolean, (v?: T) => void] {
  const base = useRef(JSON.stringify(value));
  const dirty = JSON.stringify(value) !== base.current;
  useUnsavedGuard(dirty, key);
  return [dirty, (v = value) => { base.current = JSON.stringify(v); }];
}

function Shell({ asPage, title, onClose, footer, popOut, children }: {
  asPage: boolean; title: string; onClose: () => void; footer: ReactNode; popOut?: (() => void) | undefined; children: ReactNode;
}) {
  if (asPage) return <div className="focus-form"><h2>{title}</h2>{children}<div className="focus-actions">{footer}</div></div>;
  return (
    <Modal title={<span className="row">{title}{popOut && <button className="ghost small" onClick={popOut} title="Im eigenen Fenster bearbeiten – volle Fläche">⧉ Fenster</button>}</span>}
      onClose={onClose} footer={footer}>{children}</Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Testplan
// ---------------------------------------------------------------------------------------------

export function PlanEditor({ projectKey, plan, asPage = false, onClose, onSaved }: {
  projectKey: string; plan: Plan | null; asPage?: boolean; onClose: () => void; onSaved: (p: Plan) => void;
}) {
  const [f, setF] = useState({ name: plan?.name ?? '', release: plan?.release ?? '', description: plan?.description ?? '' });
  const [dirty, reset] = useDirty(f, `plan-${plan?.id ?? 'new'}`);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const canEdit = useCan(projectKey, 'edit');
  const close = async () => { if (!dirty || (await confirmLeave())) onClose(); };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = { name: f.name.trim(), release: f.release.trim() || null, description: f.description || null };
      const p = plan ? await api<Plan>('PUT', `/api/plans/${plan.id}`, body) : await api<Plan>('POST', `/api/projects/${projectKey}/plans`, body);
      reset();
      toast(plan ? `Testplan „${p.name}“ gespeichert` : `Testplan „${p.name}“ angelegt`);
      notifyChanged('plan', p.id);
      onSaved(p);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!plan) return;
    if (!(await askConfirm({ title: 'Testplan löschen', message: <>„{plan.name}“ endgültig löschen? Das geht nur, solange dem Plan keine Zyklen zugeordnet sind.</>, confirmLabel: 'Löschen', danger: true }))) return;
    try {
      await api('DELETE', `/api/plans/${plan.id}`);
      reset({ name: '', release: '', description: '' });
      toast(`Testplan „${plan.name}“ gelöscht`);
      notifyChanged('plan', plan.id);
      finish(href(['p', projectKey, 'cycles']));
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Shell asPage={asPage} title={plan ? `Testplan „${plan.name}“ bearbeiten` : 'Neuer Testplan'} onClose={close}
      popOut={() => { void close().then(() => openFocus(`/f/${projectKey}/plan/${plan?.id ?? 'new'}`, 'anemo-plan')); }}
      footer={<>
        {plan && canEdit && (plan.cycleCount ?? 0) === 0 && <button className="danger" onClick={remove}>Löschen</button>}
        <span className="spacer" />
        {dirty && <span className="small muted">ungespeichert</span>}
        <button onClick={close}>{asPage ? 'Schließen' : 'Abbrechen'}</button>
        <button className="primary" disabled={saving || !f.name.trim()} onClick={save}>{saving ? 'Speichert …' : plan ? 'Speichern' : 'Anlegen'}</button>
      </>}>
      <ErrorNote error={error} />
      <div className="grid2">
        <label className="field">Name<input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Release 7.5" /></label>
        <label className="field">Release / Version<input value={f.release} onChange={(e) => setF({ ...f, release: e.target.value })} placeholder="z. B. 7.5" /></label>
      </div>
      <div className="field">Ziele, Umfang, Ein- und Ausstiegskriterien
        <WikiEditor label="Beschreibung" value={f.description} onChange={(v) => setF((x) => ({ ...x, description: v }))} minRows={asPage ? 14 : 6}
          placeholder="Testziele, Umfang, Risiken, Ein-/Ausstiegskriterien (erscheint im Testabschlussbericht)" />
      </div>
      {plan && <details open={asPage}><summary>Verweise (Anforderungen, Epics, Release)</summary>
        <References ownerType="TEST_PLAN" ownerId={plan.id} projectKey={projectKey} canEdit={canEdit} compact /></details>}
    </Shell>
  );
}

// ---------------------------------------------------------------------------------------------
// Testzyklus
// ---------------------------------------------------------------------------------------------

const NEW_PLAN = '__new__';

export function CycleEditor({ projectKey, plans, cycle, defaultPlanId, asPage = false, onClose, onSaved, onPlanCreated }: {
  projectKey: string; plans: Plan[]; cycle: Cycle | null; defaultPlanId?: string | null | undefined; asPage?: boolean;
  onClose: () => void; onSaved: (id: string) => void; onPlanCreated?: () => void;
}) {
  const [f, setF] = useState({
    name: cycle?.name ?? '', planId: cycle ? cycle.planId ?? '' : defaultPlanId ?? '', newPlan: '',
    release: cycle?.release ?? '', build: cycle?.build ?? '', environment: cycle?.environment ?? '',
    startDate: toInputDate(cycle?.startDate), endDate: toInputDate(cycle?.endDate), description: cycle?.description ?? '',
  });
  const [creatingPlan, setCreatingPlan] = useState(false);
  const cycleFields = useFieldDefs('cycle', projectKey);
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>(() => ({ ...((cycle as { customFields?: Record<string, unknown> } | null)?.customFields ?? {}) }));
  const planRelease = plans.find((p) => p.id === f.planId)?.release ?? null;
  const manual = cycle?.configurationSource === 'manual';
  const [config, setConfig] = useState<Configuration>(manual ? cycle?.configuration ?? {} : {});
  const [configTouched, setConfigTouched] = useState(false);
  const [dirty, reset] = useDirty({ f, config, fieldValues }, `cycle-${cycle?.id ?? 'new'}`);
  const dims = useDimensions();
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const close = async () => { if (!dirty || (await confirmLeave())) onClose(); };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      let planId = f.planId || null;
      if (f.newPlan.trim()) {
        planId = (await api<Plan>('POST', `/api/projects/${projectKey}/plans`, { name: f.newPlan.trim(), release: f.release || null })).id;
        notifyChanged('plan', planId);
        onPlanCreated?.();
      }
      const hasConfig = Object.values(config).some((v) => v.length);
      const body = {
        name: f.name.trim(), description: f.description || null, planId,
        release: f.release || plans.find((p) => p.id === planId)?.release || null, build: f.build || null,
        environment: f.environment || null, startDate: f.startDate || null, endDate: f.endDate || null,
        ...(cycleFields.length ? { customFields: Object.fromEntries(cycleFields.map((d) => [d.key, fieldValues[d.key] ?? null])) } : {}),
        // Konfiguration nur mitsenden, wenn sie hier festgelegt wurde – sonst erkennt der Server sie neu
        // (eine manuell gesetzte bleibt dabei unangetastet)
        ...(cycle ? (configTouched ? { configuration: hasConfig ? config : null } : {}) : { configuration: hasConfig ? config : null }),
      };
      const c = cycle ? await api<Cycle>('PUT', `/api/cycles/${cycle.id}`, body) : await api<Cycle>('POST', `/api/projects/${projectKey}/cycles`, body);
      reset();
      toast(cycle ? `Testzyklus „${c.name}“ gespeichert` : `Testzyklus „${c.name}“ angelegt`);
      notifyChanged('cycle', c.id);
      onSaved(c.id);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };
  const input = (k: keyof typeof f, label: string, type = 'text', placeholder?: string) => (
    <label className="field">{label}<input type={type} value={f[k]} placeholder={placeholder} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
  );
  const popTarget = cycle ? `/f/${projectKey}/cycle/${cycle.id}` : `/f/${projectKey}/cycle/new${f.planId ? `?plan=${f.planId}` : ''}`;
  return (
    <Shell asPage={asPage} title={cycle ? `Testzyklus „${cycle.name}“ bearbeiten` : 'Neuer Testzyklus'} onClose={close}
      popOut={() => { void close().then(() => openFocus(popTarget, 'anemo-zyklus')); }}
      footer={<>
        <span className="spacer" />
        {dirty && <span className="small muted">ungespeichert</span>}
        <button onClick={close}>{asPage ? 'Schließen' : 'Abbrechen'}</button>
        <button className="primary" disabled={saving || !f.name.trim() || (creatingPlan && !f.newPlan.trim())} onClick={save}>{saving ? 'Speichert …' : cycle ? 'Speichern' : 'Anlegen'}</button>
      </>}>
      <ErrorNote error={error} />
      <label className="field">Name<input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="z. B. Regression 7.5 Oracle / Win11" /></label>
      <div className={asPage ? 'grid3' : 'grid2'}>
        <label className="field">Testplan (Release)
          <select value={creatingPlan ? NEW_PLAN : f.planId} onChange={(e) => {
            const v = e.target.value;
            setCreatingPlan(v === NEW_PLAN);
            setF({ ...f, planId: v === NEW_PLAN ? '' : v, newPlan: '' });
          }}>
            <option value="">– ohne Testplan –</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}{p.release ? ` (${p.release})` : ''}</option>)}
            <option value={NEW_PLAN}>+ Neuer Testplan …</option>
          </select>
        </label>
        {creatingPlan && <label className="field">Name des neuen Testplans<input autoFocus value={f.newPlan} onChange={(e) => setF({ ...f, newPlan: e.target.value })} placeholder="z. B. Release 7.5" /></label>}
        <label className="field">Release<input value={f.release} onChange={(e) => setF({ ...f, release: e.target.value })}
          placeholder={planRelease ? `aus Testplan: ${planRelease}` : ''} title="Leer lassen, um das Release des Testplans zu übernehmen" /></label>
        {input('build', 'Build')}{input('environment', 'Umgebung')}
        {input('startDate', 'Start', 'date')}{input('endDate', 'Ende', 'date')}
      </div>
      {cycleFields.length > 0 && <FieldInputs defs={cycleFields} values={fieldValues} onChange={setFieldValues} />}
      <div className="field">Testumfang / Hinweise
        <WikiEditor label="Testumfang / Hinweise" value={f.description} onChange={(v) => setF((x) => ({ ...x, description: v }))} minRows={asPage ? 12 : 4}
          placeholder="Ziel des Laufs, Schwerpunkte, Testdaten, Besonderheiten der Umgebung" />
      </div>
      <details open={asPage && manual}><summary>Konfiguration festlegen {manual ? '(manuell gesetzt)' : '(sonst automatisch aus Name, Umgebung und Build erkannt)'}</summary>
        <ConfigurationEditor value={config} onChange={(v) => { setConfig(v); setConfigTouched(true); }} dims={dims} />
      </details>
    </Shell>
  );
}

// ---------------------------------------------------------------------------------------------
// Seiten im Fokusfenster
// ---------------------------------------------------------------------------------------------

export function PlanFormPage({ projectKey, planId }: { projectKey: string; planId: string | null }) {
  const plans = useApi<Plan[]>(`/api/projects/${projectKey}/plans`);
  useSync(['plan'], () => plans.reload());
  const plan = planId ? plans.data?.find((p) => p.id === planId) : null;
  const back = href(['p', projectKey, 'cycles'], planId ? { plan: planId } : {});
  if (planId && !plans.data) return <div className="empty">Lädt …</div>;
  if (planId && !plan) return <div className="empty">Testplan nicht gefunden.</div>;
  return (
    <FocusFrame title={plan ? `Testplan ${plan.name}` : 'Neuer Testplan'} back={back}
      crumbs={[<span key="p">{projectKey}</span>, <a key="pl" href={back}>Testplanung</a>, <strong key="t">{plan?.name ?? 'Neu'}</strong>]}>
      <div className="focus-page">
        <PlanEditor key={plan?.id ?? 'new'} projectKey={projectKey} plan={plan ?? null} asPage onClose={() => finish(back)}
          onSaved={(p) => (planId ? undefined : finish(href(['p', projectKey, 'cycles'], { plan: p.id })))} />
      </div>
    </FocusFrame>
  );
}

export function CycleFormPage({ projectKey, cycleId, defaultPlanId }: { projectKey: string; cycleId: string | null; defaultPlanId: string | null }) {
  const plans = useApi<Plan[]>(`/api/projects/${projectKey}/plans`);
  const cycle = useApi<Cycle>(cycleId ? `/api/cycles/${cycleId}` : null);
  const back = cycleId ? href(['p', projectKey, 'cycles', cycleId]) : href(['p', projectKey, 'cycles'], defaultPlanId ? { plan: defaultPlanId } : {});
  if (!plans.data || (cycleId && !cycle.data)) return <div className="empty">{cycle.error ? 'Testzyklus nicht gefunden.' : 'Lädt …'}</div>;
  const c = cycle.data ?? null;
  return (
    <FocusFrame title={c ? `Zyklus ${c.name}` : 'Neuer Testzyklus'} back={back}
      crumbs={[<span key="p">{projectKey}</span>, <a key="pl" href={href(['p', projectKey, 'cycles'], c?.planId ? { plan: c.planId } : {})}>{c?.planName ?? 'Testplanung'}</a>, <strong key="t">{c?.name ?? 'Neu'}</strong>]}>
      <div className="focus-page">
        <CycleEditor key={c?.id ?? 'new'} projectKey={projectKey} plans={plans.data} cycle={c} defaultPlanId={defaultPlanId} asPage
          onClose={() => finish(back)} onPlanCreated={plans.reload}
          onSaved={(id) => (cycleId ? cycle.reload() : finish(href(['p', projectKey, 'cycles', id])))} />
      </div>
    </FocusFrame>
  );
}

export function TestCaseEditPage({ projectKey, tcKey, folderId }: { projectKey: string; tcKey: string | null; folderId: string | null }) {
  const tc = useApi<TestCaseDetail>(tcKey ? `/api/test-cases/${encodeURIComponent(tcKey)}` : null);
  const [version, setVersion] = useState(0);
  const back = href(['p', projectKey, 'repo'], tcKey ? { tc: tcKey } : {});
  useEffect(() => { if (tc.data) setVersion((v) => v + 1); }, [tc.data]);
  if (tcKey && !tc.data) return <div className="empty">{tc.error ? 'Testfall nicht gefunden.' : 'Lädt …'}</div>;
  const t = tc.data ?? undefined;
  return (
    <FocusFrame title={t ? `${t.key} bearbeiten` : 'Neuer Testfall'} back={back}
      crumbs={[<span key="p">{projectKey}</span>, <a key="r" href={href(['p', projectKey, 'repo'])}>Testfälle</a>, <strong key="t">{t?.key ?? 'Neu'}</strong>]}>
      <div className="focus-page wide">
        <TestCaseEditor key={`${t?.id ?? 'new'}-${version}`} projectKey={projectKey} folderId={folderId} existing={t} asPage
          onClose={() => finish(back)}
          // Bestehender Testfall: neu laden (nächste Version bearbeitbar); neuer: zum angelegten wechseln
          onSaved={(key) => (tcKey ? tc.reload() : navigate(['f', projectKey, 'testcase', key]))} />
      </div>
    </FocusFrame>
  );
}
