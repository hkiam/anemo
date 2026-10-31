/**
 * Version der laufenden Anwendung: Versionsnummer aus package.json (Wurzel), Commit und Build-Zeitpunkt aus dem
 * Container-Build (ANEMO_COMMIT, ANEMO_BUILT_AT); in der Entwicklung der Commit aus git, sofern verfügbar.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const startedAt = new Date();

function readVersion(): string {
  try { return (JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { version?: string }).version ?? '0.0.0'; } catch { return '0.0.0'; }
}

function devCommit(): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 2000 });
    return r.status === 0 ? r.stdout.trim() || null : null;
  } catch { return null; }
}

const info = {
  version: readVersion(),
  commit: process.env.ANEMO_COMMIT?.trim() || devCommit(),
  builtAt: process.env.ANEMO_BUILT_AT?.trim() || null,
};

export interface VersionInfo { version: string; commit: string | null; builtAt: string | null; startedAt: string; label: string }

/** Version für Anzeige und Schnittstellen, z. B. „0.9.0 (4be6902)“. */
export function versionInfo(): VersionInfo {
  return { ...info, startedAt: startedAt.toISOString(), label: `${info.version}${info.commit ? ` (${info.commit})` : ''}` };
}
