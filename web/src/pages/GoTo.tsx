import { useEffect, useState } from 'react';
import { get } from '../api.ts';
import { searchHref } from '../components/Search.tsx';
import type { Route } from '../router.ts';

/**
 * Dauerhafte Links (/go/…, z. B. aus OpenProject oder Mails): Ziel auflösen und dorthin wechseln (ohne Eintrag im Verlauf).
 * testfall/<Schlüssel> und ticket/<Anbieter>/<Schlüssel> ohne Server; ausfuehrung|zyklus|plan|sitzung/<id> über /api/go.
 */
export function GoTo({ route }: { route: Route }) {
  const [, kind, a, b] = route.path;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const go = (hash: string) => window.location.replace(hash.startsWith('#') ? hash : `#${hash}`);
    if (kind === 'testfall' && a) { go(`#/p/${encodeURIComponent(a.replace(/-T\d+$/, ''))}/repo?tc=${encodeURIComponent(a)}`); return; }
    if (kind === 'ticket' && (b ?? a)) { go(searchHref(b ?? a!, { types: 'reference' })); return; }
    if (kind && a) {
      get<{ hash: string }>(`/api/go/${encodeURIComponent(kind)}/${encodeURIComponent(a)}`).then((r) => go(r.hash), (e: Error) => setError(e.message));
      return;
    }
    setError('Unvollständiger Link');
  }, [kind, a, b]);
  return (
    <div className="page"><div className="page-narrow">
      {error
        ? <div className="notice bad" role="alert">Der Link lässt sich nicht öffnen: {error}. Vielleicht fehlt die Berechtigung, oder das Ziel wurde gelöscht. <a href="#/">Zur Startseite</a></div>
        : <div className="muted" role="status">Öffnet …</div>}
    </div></div>
  );
}
