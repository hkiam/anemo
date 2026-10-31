/**
 * Fremdkomponenten beim Build prüfen und SBOM erzeugen – ohne zusätzliche Abhängigkeiten, nur aus package-lock.json
 * und node_modules.
 *
 *   node tools/third-party.ts check   Lizenzen gegen config/third-party.json prüfen
 *   node tools/third-party.ts audit   bekannte Schwachstellen (npm audit) der Laufzeitkomponenten prüfen
 *   node tools/third-party.ts sbom    SBOM (CycloneDX 1.5 und SPDX 2.3) und THIRD-PARTY-NOTICES.md schreiben
 *   node tools/third-party.ts all     alles; Optionen: --out <Verzeichnis> (Standard build/third-party), --audit-optional
 *
 * „Laufzeit“ = was ausgeliefert wird: Abhängigkeiten des Servers (im Container) und der Web-Oberfläche (im Bundle).
 * Dazu kommen mitgelieferte Dateien ohne npm-Paket (Schriften, Farbprofil der PDF-Berichte), die in config/third-party.json
 * unter „vendored“ mit Quelle, Lizenz und SHA-256 je Datei stehen; die Prüfung vergleicht die Prüfsummen.
 * Entwicklungswerkzeuge (Vite, TypeScript, Playwright …) werden geprüft und in einer eigenen SBOM geführt, aber milder
 * bewertet, weil sie nicht ausgeliefert werden. Ein Verstoß bei Laufzeitkomponenten bricht den Build ab (Exit-Code 1).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface Policy {
  allowed: string[]; review: string[]; denied: string[]; devAllowedReview?: boolean;
  exceptions: Record<string, string>; audit?: { failOn: string[]; runtimeOnly?: boolean };
  vendored?: Vendored[];
}
/** Mitgelieferte Dateien ohne npm-Paket: Verzeichnis mit Lizenztext, Quelle und SHA-256 je Datei */
export interface Vendored {
  name: string; version: string; license: string; usage: Usage; path: string; source: string; repository?: string;
  files: Record<string, string>;
}
export type Usage = 'server' | 'web' | 'dev';
export interface Component {
  path: string; name: string; version: string; license: string | null; usage: Usage; resolved: string | null; integrity: string | null;
  dependencies: string[]; repository: string | null;
  /** Paket-URL für Komponenten außerhalb von npm */
  purl?: string;
}
export type Verdict = 'allowed' | 'review' | 'denied' | 'unknown';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** SPDX-Ausdruck bewerten: bei OR genügt eine zulässige Alternative, bei AND müssen alle zulässig sein. */
export function classifyLicense(expr: string | null, p: Pick<Policy, 'allowed' | 'review' | 'denied'>): Verdict {
  if (!expr || !expr.trim()) return 'unknown';
  const e = expr.trim().replace(/^\((.*)\)$/s, '$1');
  const rank: Record<Verdict, number> = { allowed: 0, review: 1, unknown: 2, denied: 3 };
  if (/\sOR\s/i.test(e)) return e.split(/\s+OR\s+/i).map((x) => classifyLicense(x, p)).sort((a, b) => rank[a] - rank[b])[0]!;
  if (/\sAND\s/i.test(e)) return e.split(/\s+AND\s+/i).map((x) => classifyLicense(x, p)).sort((a, b) => rank[b] - rank[a])[0]!;
  const id = e.replace(/\+$/, '').replace(/\s+WITH\s+.*/i, '').trim();
  const norm = (x: string) => x.toLowerCase();
  if (p.denied.some((d) => norm(d) === norm(id)) || /^(A|L)?GPL/i.test(id) && !p.review.some((r) => norm(r) === norm(id)) && !/^LGPL/i.test(id)) return 'denied';
  if (p.allowed.some((a) => norm(a) === norm(id))) return 'allowed';
  if (p.review.some((r) => norm(r) === norm(id))) return 'review';
  return 'unknown';
}

const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

/** Komponenten aus package-lock.json; Verwendung über die Abhängigkeiten der Arbeitsbereiche server/web. */
export function loadInventory(root = ROOT): Component[] {
  const lock = readJson(join(root, 'package-lock.json')) as { packages: Record<string, Record<string, unknown>> };
  const pk = lock.packages;
  const nameOf = (path: string) => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  // Abhängigkeit aufschlüsseln wie Node: erst verschachtelt, dann in übergeordneten node_modules
  const resolveDep = (from: string, dep: string): string | null => {
    let base = from;
    for (;;) {
      const cand = `${base ? `${base}/` : ''}node_modules/${dep}`;
      if (pk[cand]) return cand;
      if (!base) return null;
      const i = base.lastIndexOf('/node_modules/');
      base = i >= 0 ? base.slice(0, i) : '';
    }
  };
  const comps = new Map<string, Component>();
  for (const [path, e] of Object.entries(pk)) {
    if (!path.includes('node_modules/') || e.link) continue;
    if (e.optional && !existsSync(join(root, path))) continue; // nicht installierte Plattformpakete
    let license = (e.license as string | undefined) ?? null;
    let repository: string | null = null;
    const pj = join(root, path, 'package.json');
    if (existsSync(pj)) {
      const p = readJson(pj) as { license?: string | { type?: string }; licenses?: { type?: string }[]; repository?: string | { url?: string } };
      license ??= typeof p.license === 'string' ? p.license : p.license?.type ?? p.licenses?.map((l) => l.type).filter(Boolean).join(' OR ') ?? null;
      repository = typeof p.repository === 'string' ? p.repository : p.repository?.url ?? null;
    }
    const deps = Object.keys({ ...(e.dependencies as object ?? {}), ...(e.optionalDependencies as object ?? {}), ...(e.peerDependencies as object ?? {}) })
      .map((d) => resolveDep(path, d)).filter((x): x is string => !!x && x !== path);
    comps.set(path, {
      path, name: (e.name as string | undefined) ?? nameOf(path), version: String(e.version ?? ''), license, usage: 'dev',
      resolved: (e.resolved as string | undefined) ?? null, integrity: (e.integrity as string | undefined) ?? null, dependencies: deps,
      repository: repository?.replace(/^git\+/, '').replace(/\.git$/, '') ?? null,
    });
  }
  // Laufzeit: erreichbar aus den dependencies von server bzw. web (nicht devDependencies)
  const mark = (ws: string, usage: Usage) => {
    const wsEntry = pk[ws];
    const start = Object.keys((wsEntry?.dependencies as object) ?? {}).map((d) => resolveDep(ws, d)).filter((x): x is string => !!x);
    const queue = [...start];
    while (queue.length) {
      const p = queue.shift()!;
      const c = comps.get(p);
      if (!c || c.usage === usage || (c.usage === 'server' && usage === 'web')) continue;
      c.usage = c.usage === 'web' && usage === 'server' ? 'server' : usage;
      queue.push(...c.dependencies);
    }
  };
  mark('web', 'web');
  mark('server', 'server');
  return [...comps.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Mitgelieferte Dateien als Komponenten */
export function loadVendored(policy: Pick<Policy, 'vendored'>): Component[] {
  return (policy.vendored ?? []).map((v) => ({
    path: v.path, name: v.name, version: v.version, license: v.license, usage: v.usage, resolved: v.source, integrity: null, dependencies: [],
    repository: v.repository ?? null, purl: `pkg:generic/${encodeURIComponent(v.name)}@${encodeURIComponent(v.version)}?download_url=${encodeURIComponent(v.source)}`,
  }));
}

/** Prüfsummen der mitgelieferten Dateien; Abweichungen und fehlende Dateien sind Fehler. */
export function checkVendored(policy: Pick<Policy, 'vendored'>, root = ROOT): string[] {
  const problems: string[] = [];
  for (const v of policy.vendored ?? []) {
    for (const [file, sha256] of Object.entries(v.files)) {
      const f = join(root, v.path, file);
      if (!existsSync(f)) { problems.push(`${v.name}: ${v.path}/${file} fehlt`); continue; }
      const actual = createHash('sha256').update(readFileSync(f)).digest('hex');
      if (actual !== sha256) problems.push(`${v.name}: ${v.path}/${file} hat die Prüfsumme ${actual} statt ${sha256}`);
    }
  }
  return problems;
}

export interface Finding { component: Component; verdict: Verdict; level: 'error' | 'warning' | 'ok'; note: string }

export function checkLicenses(comps: Component[], policy: Policy): Finding[] {
  return comps.map((c) => {
    const exception = policy.exceptions[`${c.name}@${c.version}`] ?? policy.exceptions[c.name];
    const verdict = classifyLicense(c.license, policy);
    if (exception) return { component: c, verdict, level: 'ok' as const, note: `Ausnahme: ${exception}` };
    const runtime = c.usage !== 'dev';
    if (verdict === 'allowed') return { component: c, verdict, level: 'ok' as const, note: '' };
    if (verdict === 'review') {
      return runtime || !policy.devAllowedReview
        ? { component: c, verdict, level: 'error' as const, note: 'Lizenz mit Auflagen – prüfen und als Ausnahme mit Begründung eintragen' }
        : { component: c, verdict, level: 'ok' as const, note: 'nur Entwicklung (nicht ausgeliefert)' };
    }
    const what = verdict === 'denied' ? 'nicht zulässige Lizenz' : 'Lizenz unbekannt';
    return { component: c, verdict, level: runtime ? 'error' as const : 'warning' as const, note: runtime ? what : `${what} (nur Entwicklung)` };
  });
}

// ---------------------------------------------------------------------------------------------
// SBOM
// ---------------------------------------------------------------------------------------------

export const purlOf = (c: Pick<Component, 'name' | 'version' | 'purl'>) => c.purl ??
  `pkg:npm/${c.name.startsWith('@') ? `%40${c.name.slice(1)}` : c.name}@${encodeURIComponent(c.version)}`;
const sriToHex = (sri: string | null) => {
  const m = sri ? /^sha512-(.+)$/.exec(sri.split(/\s+/)[0]!) : null;
  return m ? Buffer.from(m[1]!, 'base64').toString('hex') : null;
};
const licenseEntry = (expr: string | null) =>
  !expr ? [] : /\s(OR|AND|WITH)\s/i.test(expr) ? [{ expression: expr }] : [{ license: { id: expr } }];

export interface ProductInfo { name: string; version: string; license: string; baseImage: string | null }

export function productInfo(root = ROOT): ProductInfo {
  const pkg = readJson(join(root, 'package.json')) as { name: string; version?: string; license?: string };
  let sha = process.env.ANEMO_VERSION ?? '';
  if (!sha) {
    try { sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* ohne Git */ }
  }
  const docker = existsSync(join(root, 'Dockerfile')) ? readFileSync(join(root, 'Dockerfile'), 'utf8') : '';
  const froms = [...docker.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]!);
  return {
    name: pkg.name, license: pkg.license ?? 'NOASSERTION', baseImage: froms.at(-1) ?? null,
    version: process.env.ANEMO_VERSION ?? `${pkg.version ?? '0.0.0'}${sha ? `+${sha}` : ''}`,
  };
}

export function buildCycloneDx(comps: Component[], product: ProductInfo, now = new Date()) {
  const ref = (c: Component) => `${purlOf(c)}#${c.path}`;
  const byPath = new Map(comps.map((c) => [c.path, c]));
  const components: Record<string, unknown>[] = comps.map((c) => {
    const scoped = c.name.startsWith('@') ? c.name.split('/') : null;
    const hash = sriToHex(c.integrity);
    return {
      type: 'library', 'bom-ref': ref(c),
      ...(scoped ? { group: scoped[0], name: scoped.slice(1).join('/') } : { name: c.name }),
      version: c.version, purl: purlOf(c), scope: c.usage === 'dev' ? 'excluded' : 'required',
      licenses: licenseEntry(c.license),
      ...(hash ? { hashes: [{ alg: 'SHA-512', content: hash }] } : {}),
      externalReferences: [
        ...(c.resolved ? [{ type: 'distribution', url: c.resolved }] : []),
        ...(c.repository && /^https?:\/\//.test(c.repository) ? [{ type: 'vcs', url: c.repository }] : []),
      ],
      properties: [{ name: 'anemo:usage', value: c.usage === 'server' ? 'Server (Container)' : c.usage === 'web' ? 'Web-Oberfläche (Bundle)' : 'Entwicklung' }],
    };
  });
  if (product.baseImage) {
    const [image, tag] = product.baseImage.split(':');
    components.push({
      type: 'container', 'bom-ref': `container:${product.baseImage}`, name: image, version: tag ?? 'latest', scope: 'required',
      description: 'Basis-Image (enthält Node.js und Systembibliotheken); dessen Inhalt erfasst ein Image-Scan (z. B. syft) in der CI',
    });
  }
  const runtimeRoots = comps.filter((c) => c.usage !== 'dev' && !comps.some((o) => o.usage !== 'dev' && o.dependencies.includes(c.path)));
  return {
    bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${randomUUID()}`, version: 1,
    metadata: {
      timestamp: now.toISOString(),
      tools: { components: [{ type: 'application', name: 'anemo-third-party', version: '1' }] },
      component: { type: 'application', 'bom-ref': 'anemo', name: product.name, version: product.version, licenses: licenseEntry(product.license) },
    },
    components,
    dependencies: [
      { ref: 'anemo', dependsOn: [...runtimeRoots.map(ref), ...(product.baseImage ? [`container:${product.baseImage}`] : [])] },
      ...comps.map((c) => ({ ref: ref(c), dependsOn: c.dependencies.map((d) => byPath.get(d)).filter((x): x is Component => !!x).map(ref) })),
    ],
  };
}

export function buildSpdx(comps: Component[], product: ProductInfo, now = new Date()) {
  const id = (c: Component) => `SPDXRef-Package-${createHash('sha1').update(c.path).digest('hex').slice(0, 12)}-${c.name.replace(/[^A-Za-z0-9.-]+/g, '-')}`;
  const byPath = new Map(comps.map((c) => [c.path, c]));
  const root = 'SPDXRef-Package-anemo';
  return {
    spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: `${product.name}-${product.version}`,
    documentNamespace: `https://spdx.org/spdxdocs/${product.name}-${randomUUID()}`,
    creationInfo: { created: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), creators: ['Tool: anemo-third-party-1'] },
    packages: [
      { SPDXID: root, name: product.name, versionInfo: product.version, downloadLocation: 'NOASSERTION', filesAnalyzed: false,
        licenseConcluded: product.license, licenseDeclared: product.license, copyrightText: 'NOASSERTION', primaryPackagePurpose: 'APPLICATION' },
      ...comps.map((c) => {
        const hash = sriToHex(c.integrity);
        return {
          SPDXID: id(c), name: c.name, versionInfo: c.version, downloadLocation: c.resolved ?? 'NOASSERTION', filesAnalyzed: false,
          licenseConcluded: 'NOASSERTION', licenseDeclared: c.license ?? 'NOASSERTION', copyrightText: 'NOASSERTION',
          primaryPackagePurpose: 'LIBRARY',
          ...(hash ? { checksums: [{ algorithm: 'SHA512', checksumValue: hash }] } : {}),
          externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: purlOf(c) }],
          comment: c.usage === 'dev' ? 'nur Entwicklung (nicht ausgeliefert)' : c.usage === 'web' ? 'im Bundle der Web-Oberfläche' : 'im Server-Container',
        };
      }),
    ],
    relationships: [
      { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: root },
      ...comps.filter((c) => !comps.some((o) => o.dependencies.includes(c.path)))
        .map((c) => ({ spdxElementId: root, relationshipType: c.usage === 'dev' ? 'DEV_DEPENDENCY_OF' : 'DEPENDS_ON', relatedSpdxElement: id(c) }))
        .map((r) => (r.relationshipType === 'DEV_DEPENDENCY_OF' ? { spdxElementId: r.relatedSpdxElement, relationshipType: r.relationshipType, relatedSpdxElement: root } : r)),
      ...comps.flatMap((c) => c.dependencies.map((d) => byPath.get(d)).filter((x): x is Component => !!x)
        .map((d) => ({ spdxElementId: id(c), relationshipType: 'DEPENDS_ON', relatedSpdxElement: id(d) }))),
    ],
  };
}

/** Lizenztexte der ausgelieferten Komponenten (Apache-2.0 § 4: Hinweise Dritter weitergeben). */
export function noticesMarkdown(comps: Component[], product: ProductInfo, root = ROOT): string {
  const shipped = comps.filter((c) => c.usage !== 'dev');
  const text = (c: Component) => {
    const dir = join(root, c.path);
    const f = existsSync(dir) ? readdirSync(dir).find((x) => /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i.test(x)) : undefined;
    return f ? readFileSync(join(dir, f), 'utf8').trim() : null;
  };
  return [
    `# Komponenten Dritter in ${product.name} ${product.version}`, '',
    `${product.name} steht unter ${product.license} (siehe LICENSE und NOTICE). Ausgeliefert werden die folgenden Komponenten Dritter`,
    'mit ihren Lizenzen; Werkzeuge, die nur zum Bauen und Testen dienen, sind nicht enthalten (siehe SBOM).', '',
    '| Komponente | Version | Lizenz | Verwendung |', '|---|---|---|---|',
    ...shipped.map((c) => `| ${c.name} | ${c.version} | ${c.license ?? 'unbekannt'} | ${c.usage === 'server' ? 'Server' : 'Web-Oberfläche'} |`),
    '',
    ...shipped.flatMap((c) => [`## ${c.name} ${c.version}`, '', `Lizenz: ${c.license ?? 'unbekannt'}${c.repository ? ` · Quelle: ${c.repository}` : ''}`, '',
      '```', text(c) ?? '(kein Lizenztext im Paket enthalten – siehe Lizenzkennung)', '```', '']),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Schwachstellen
// ---------------------------------------------------------------------------------------------

export function audit(policy: Policy, root = ROOT): { ok: boolean; skipped?: string; findings: { name: string; severity: string; title: string; url: string }[] } {
  const args = ['audit', '--json', ...(policy.audit?.runtimeOnly !== false ? ['--omit=dev'] : [])];
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  let data: { vulnerabilities?: Record<string, { severity: string; via: (string | { title?: string; url?: string; severity?: string })[] }>; error?: { summary?: string } };
  try { data = JSON.parse(r.stdout || '{}'); } catch { return { ok: false, skipped: `npm audit nicht auswertbar: ${(r.stderr || '').slice(0, 200)}`, findings: [] }; }
  if (data.error) return { ok: false, skipped: `npm audit: ${data.error.summary ?? 'Fehler'}`, findings: [] };
  const failOn = new Set(policy.audit?.failOn ?? ['high', 'critical']);
  const findings = Object.entries(data.vulnerabilities ?? {}).flatMap(([name, v]) =>
    v.via.filter((x): x is { title?: string; url?: string; severity?: string } => typeof x === 'object')
      .map((x) => ({ name, severity: x.severity ?? v.severity, title: x.title ?? '', url: x.url ?? '' })));
  return { ok: !findings.some((f) => failOn.has(f.severity)), findings };
}

// ---------------------------------------------------------------------------------------------
// Aufruf
// ---------------------------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'all';
  const outIdx = args.indexOf('--out');
  const out = resolve(ROOT, outIdx >= 0 ? args[outIdx + 1]! : 'build/third-party');
  const policy = readJson(join(ROOT, 'config/third-party.json')) as Policy;
  const comps = [...loadInventory(), ...loadVendored(policy)];
  const product = productInfo();
  let failed = false;
  const report: string[] = [`# Prüfung der Fremdkomponenten – ${product.name} ${product.version}`, '', `Stand: ${new Date().toISOString()}`, ''];

  if (cmd === 'check' || cmd === 'all') {
    const f = checkLicenses(comps, policy);
    const errors = f.filter((x) => x.level === 'error');
    const warnings = f.filter((x) => x.level === 'warning');
    const runtime = comps.filter((c) => c.usage !== 'dev');
    console.log(`Lizenzen: ${runtime.length} ausgelieferte und ${comps.length - runtime.length} Entwicklungskomponenten geprüft – ${errors.length} Verstöße, ${warnings.length} Hinweise.`);
    for (const x of [...errors, ...warnings]) console.log(`  ${x.level === 'error' ? '✗' : '!'} ${x.component.name}@${x.component.version} (${x.component.license ?? 'unbekannt'}, ${x.component.usage}): ${x.note}`);
    report.push('## Lizenzen', '', '| Komponente | Version | Lizenz | Verwendung | Bewertung |', '|---|---|---|---|---|',
      ...f.map((x) => `| ${x.component.name} | ${x.component.version} | ${x.component.license ?? 'unbekannt'} | ${x.component.usage} | ${x.level === 'ok' ? `ok${x.note ? ` – ${x.note}` : ''}` : `**${x.level === 'error' ? 'Verstoß' : 'Hinweis'}**: ${x.note}`} |`), '');
    if (errors.length) failed = true;
    const vendored = checkVendored(policy);
    console.log(`Mitgelieferte Dateien: ${(policy.vendored ?? []).reduce((a, v) => a + Object.keys(v.files).length, 0)} geprüft – ${vendored.length} Abweichungen.`);
    for (const x of vendored) console.log(`  ✗ ${x}`);
    report.push('## Mitgelieferte Dateien', '', vendored.length ? vendored.map((x) => `- **Verstoß**: ${x}`).join('\n') : 'Prüfsummen stimmen.', '');
    if (vendored.length) failed = true;
  }
  if (cmd === 'audit' || cmd === 'all') {
    const a = audit(policy);
    if (a.skipped) {
      const optional = args.includes('--audit-optional');
      console.log(`${optional ? 'Hinweis' : 'Fehler'}: Schwachstellenprüfung nicht möglich – ${a.skipped}`);
      report.push('## Schwachstellen', '', `Nicht geprüft: ${a.skipped}`, '');
      if (!optional) failed = true;
    } else {
      console.log(`Schwachstellen (${policy.audit?.runtimeOnly !== false ? 'Laufzeit' : 'alle'}): ${a.findings.length} gefunden${a.ok ? '' : ' – Abbruch wegen hoher/kritischer Einstufung'}.`);
      for (const x of a.findings) console.log(`  ${x.severity}: ${x.name} – ${x.title} ${x.url}`);
      report.push('## Schwachstellen', '', a.findings.length ? a.findings.map((x) => `- ${x.severity}: ${x.name} – ${x.title} ${x.url}`).join('\n') : 'Keine bekannten Schwachstellen.', '');
      if (!a.ok) failed = true;
    }
  }
  if (cmd === 'sbom' || cmd === 'all') {
    mkdirSync(out, { recursive: true });
    const shipped = comps.filter((c) => c.usage !== 'dev');
    writeFileSync(join(out, 'anemo.cdx.json'), `${JSON.stringify(buildCycloneDx(shipped, product), null, 2)}\n`);
    writeFileSync(join(out, 'anemo.spdx.json'), `${JSON.stringify(buildSpdx(shipped, product), null, 2)}\n`);
    writeFileSync(join(out, 'anemo-mit-entwicklung.cdx.json'), `${JSON.stringify(buildCycloneDx(comps, product), null, 2)}\n`);
    writeFileSync(join(out, 'THIRD-PARTY-NOTICES.md'), `${noticesMarkdown(comps, product)}\n`);
    console.log(`SBOM: ${out}/anemo.cdx.json (CycloneDX 1.5), anemo.spdx.json (SPDX 2.3), anemo-mit-entwicklung.cdx.json, THIRD-PARTY-NOTICES.md – ${shipped.length} ausgelieferte Komponenten.`);
  }
  if (cmd === 'check' || cmd === 'audit' || cmd === 'all') {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'pruefbericht.md'), `${report.join('\n')}\n`);
  }
  if (!['check', 'audit', 'sbom', 'all'].includes(cmd)) {
    console.error('Aufruf: node tools/third-party.ts <check|audit|sbom|all> [--out <Verzeichnis>] [--audit-optional]');
    process.exit(2);
  }
  if (failed) {
    console.error('Prüfung der Fremdkomponenten fehlgeschlagen – Details oben und im Prüfbericht.');
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
