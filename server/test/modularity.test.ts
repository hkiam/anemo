/**
 * Modulgrenzen (analog Spring Modulith): Ein Modul darf andere Module nur über deren index.ts
 * importieren, Plattformcode darf keine Module kennen, und es gibt keine Zyklen.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, dirname } from 'node:path';
import { it } from 'node:test';

const SRC = new URL('../src', import.meta.url).pathname;

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const moduleOf = (file: string) => /modules\/([^/]+)\//.exec(relative(SRC, file).replace(/\\/g, '/') + '')?.[1] ?? null;

it('Module importieren einander nur über index.ts, Plattform kennt keine Module, keine Zyklen', async () => {
  const violations: string[] = [];
  const deps = new Map<string, Set<string>>();
  for (const file of await files(SRC)) {
    const text = await readFile(file, 'utf8');
    const from = moduleOf(file);
    for (const m of text.matchAll(/from '(\.[^']+)'/g)) {
      const target = resolve(dirname(file), m[1]!);
      const to = moduleOf(target + '/');
      const rel = relative(SRC, file);
      if (rel.startsWith('platform') && to) violations.push(`${rel} → Modul ${to}`);
      if (from && to && from !== to) {
        if (!target.endsWith(`modules/${to}/index.ts`)) violations.push(`${rel} → ${relative(SRC, target)} (nur index.ts erlaubt)`);
        (deps.get(from) ?? deps.set(from, new Set()).get(from)!).add(to);
      }
    }
  }
  assert.deepEqual(violations, []);
  const visit = (m: string, path: string[]): void => {
    if (path.includes(m)) throw new Error(`Zyklus: ${[...path, m].join(' → ')}`);
    for (const d of deps.get(m) ?? []) visit(d, [...path, m]);
  };
  for (const m of deps.keys()) visit(m, []);
});
