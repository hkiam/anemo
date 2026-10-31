import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {
  readonly status: number;
  readonly issues: { message: string; path?: (string | number)[] }[];

  constructor(status: number, message: string, issues: { message: string }[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

/** Wird ausgelöst, wenn die Sitzung abgelaufen ist (App zeigt dann die Anmeldung). */
export const UNAUTHORIZED_EVENT = 'anemo:unauthorized';

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  // JSON parsen; Text (z. B. Markdown des Handbuchs) unverändert zurückgeben
  const data = text ? ((res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text) : null;
  if (res.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) {
    const issues = data?.issues ?? [];
    const detail = issues.length ? issues.map((i: { message: string }) => i.message).join('; ') : data?.detail ?? res.statusText;
    throw new ApiError(res.status, detail, issues);
  }
  return data as T;
}

export const get = <T,>(path: string) => api<T>('GET', path);

/** Minimaler Datenlade-Hook: lädt bei Änderung von {@code path}, {@code reload()} lädt neu. */
export function useApi<T>(path: string | null): { data: T | undefined; error: Error | undefined; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: !!path });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) {
      setState({ loading: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    get<T>(path).then(
      (data) => !cancelled && setState({ data, loading: false }),
      (error: Error) => !cancelled && setState({ error, loading: false }),
    );
    return () => {
      cancelled = true;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

/** Anzeigezeitzone – unabhängig von der Zeitzone des Rechners (Teams und Server arbeiten in Deutschland). */
export const TIME_ZONE = 'Europe/Berlin';
const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Reiner Kalendertag „YYYY-MM-DD“ ohne Umweg über Date/UTC (sonst rutscht er westlich von UTC auf den Vortag). */
const fmtPlainDay = (m: RegExpExecArray) => `${Number(m[3])}.${Number(m[2])}.${m[1]}`;

export const fmtDate = (v: string | null | undefined) => {
  if (!v) return '–';
  const day = DAY_ONLY.exec(v);
  if (day) return fmtPlainDay(day);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: TIME_ZONE });
};
export const fmtDay = (v: string | null | undefined) => {
  if (!v) return '–';
  const day = DAY_ONLY.exec(v);
  if (day) return fmtPlainDay(day);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('de-DE', { timeZone: TIME_ZONE });
};

export interface UploadedAttachment { id: string; fileName: string; contentType: string | null; sizeBytes: number | null }

/** Datei an ein Objekt hängen (multipart); Rechte prüft der Server (Pflegen bzw. Ausführen). */
export async function uploadAttachment(ownerType: 'TEST_CASE' | 'TEST_EXECUTION' | 'EXPLORATORY_SESSION', ownerId: string, file: File, stepId?: string): Promise<UploadedAttachment> {
  const form = new FormData();
  form.set('ownerType', ownerType);
  form.set('ownerId', ownerId);
  if (stepId) form.set('stepId', stepId);
  form.set('file', file, file.name);
  const res = await fetch('/api/attachments', { method: 'POST', body: form, credentials: 'same-origin' });
  const data = await res.json().catch(() => null);
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) throw new ApiError(res.status, data?.detail ?? res.statusText);
  return data as UploadedAttachment;
}
