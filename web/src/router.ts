import { useEffect, useState } from 'react';

/** Hash-Routing: #/p/DEMO/repo?tc=DEMO-T1 – keine Serverkonfiguration nötig. */
export interface Route { path: string[]; query: URLSearchParams }

function parse(): Route {
  const [p = '', q = ''] = window.location.hash.replace(/^#\/?/, '').split('?');
  return { path: p.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function href(path: string[], query: Record<string, string | null | undefined> = {}): string {
  const q = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => !!e[1])).toString();
  return `#/${path.map(encodeURIComponent).join('/')}${q ? `?${q}` : ''}`;
}

export function navigate(path: string[], query: Record<string, string | null | undefined> = {}): void {
  window.location.hash = href(path, query);
}
