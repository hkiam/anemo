import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { buildCycloneDx, buildSpdx, checkLicenses, checkVendored, classifyLicense, type Component, loadInventory, loadVendored, type Policy, purlOf } from './third-party.ts';

const policy = { allowed: ['MIT', 'Apache-2.0', 'BSD-3-Clause'], review: ['MPL-2.0', 'LGPL-3.0-only'], denied: ['GPL-3.0-only', 'AGPL-3.0-only'], devAllowedReview: true, exceptions: { 'sonder@1.0.0': 'mit Rechtsabteilung geklärt' } };
const comp = (name: string, license: string | null, usage: Component['usage']): Component =>
  ({ path: `node_modules/${name}`, name, version: '1.0.0', license, usage, resolved: null, integrity: 'sha512-AAAA', dependencies: [], repository: null });

it('bewertet SPDX-Ausdrücke', () => {
  assert.equal(classifyLicense('MIT', policy), 'allowed');
  assert.equal(classifyLicense('(MIT OR GPL-3.0-only)', policy), 'allowed', 'eine zulässige Alternative genügt');
  assert.equal(classifyLicense('MIT AND GPL-3.0-only', policy), 'denied', 'bei AND zählt die strengste');
  assert.equal(classifyLicense('GPL-2.0-or-later', policy), 'denied', 'GPL ohne Listeneintrag ist unzulässig');
  assert.equal(classifyLicense('MPL-2.0', policy), 'review');
  assert.equal(classifyLicense('Apache-2.0 WITH LLVM-exception', policy), 'allowed');
  assert.equal(classifyLicense(null, policy), 'unknown');
  assert.equal(classifyLicense('SEE LICENSE IN LICENSE.txt', policy), 'unknown');
});

it('Laufzeit streng, Entwicklung mild, Ausnahmen mit Begründung', () => {
  const f = checkLicenses([comp('a', 'GPL-3.0-only', 'server'), comp('b', 'MPL-2.0', 'web'), comp('c', 'MPL-2.0', 'dev'), comp('d', null, 'dev'), comp('sonder', 'GPL-3.0-only', 'server')], policy);
  assert.deepEqual(f.map((x) => x.level), ['error', 'error', 'ok', 'warning', 'ok']);
  assert.match(f[4]!.note, /Rechtsabteilung/);
});

it('SBOM im CycloneDX- und SPDX-Format', () => {
  const c = [{ ...comp('@scope/lib', 'MIT', 'server'), dependencies: ['node_modules/dep'] }, comp('dep', '(MIT OR Apache-2.0)', 'server')];
  const product = { name: 'anemo', version: '1.2.3', license: 'Apache-2.0', baseImage: 'gcr.io/distroless/nodejs22-debian12:nonroot' };
  assert.equal(purlOf(c[0]!), 'pkg:npm/%40scope/lib@1.0.0');
  const cdx = buildCycloneDx(c, product);
  assert.equal(cdx.specVersion, '1.5');
  const lib = cdx.components.find((x) => x.name === 'lib')!;
  assert.equal(lib.group, '@scope');
  assert.deepEqual(lib.hashes, [{ alg: 'SHA-512', content: '000000' }]);
  assert.deepEqual(cdx.components.find((x) => x.name === 'dep')!.licenses, [{ expression: '(MIT OR Apache-2.0)' }]);
  assert.ok(cdx.components.some((x) => x.type === 'container'), 'Basis-Image erfasst');
  assert.deepEqual(cdx.dependencies.find((d) => d.ref === 'anemo')!.dependsOn.length, 2, 'Wurzel → lib und Basis-Image');
  const spdx = buildSpdx(c, product);
  assert.equal(spdx.spdxVersion, 'SPDX-2.3');
  assert.equal(spdx.packages.length, 3);
  assert.ok(spdx.packages.every((p) => /^SPDXRef-[A-Za-z0-9.-]+$/.test(p.SPDXID)));
  assert.ok(spdx.relationships.some((r) => r.relationshipType === 'DESCRIBES'));
});

it('Bestand des Repositorys: Server- und Web-Komponenten erkannt', () => {
  const inv = loadInventory();
  const by = (n: string) => inv.find((c) => c.name === n);
  assert.equal(by('hono')?.usage, 'server');
  assert.equal(by('react')?.usage, 'web');
  assert.equal(by('vite')?.usage, 'dev');
});

it('mitgelieferte Dateien (Schriften, Farbprofil): Komponenten mit Lizenz und Prüfsummen', () => {
  const policy = JSON.parse(readFileSync(new URL('../config/third-party.json', import.meta.url), 'utf8')) as Policy;
  const v = loadVendored(policy);
  const fonts = v.find((c) => c.name === 'dejavu-fonts')!;
  assert.equal(fonts.usage, 'server');
  assert.match(purlOf(fonts), /^pkg:generic\/dejavu-fonts@2\.37\?download_url=/);
  assert.deepEqual(checkLicenses(v, policy).map((f) => f.level), v.map(() => 'ok'), 'Lizenz zulässig oder begründete Ausnahme');
  assert.deepEqual(checkVendored(policy), []);
  const changed = { vendored: [{ ...policy.vendored![0]!, files: { 'DejaVuSans.ttf': '0'.repeat(64), 'fehlt.ttf': '0'.repeat(64) } }] };
  assert.equal(checkVendored(changed).length, 2, 'Abweichung und fehlende Datei gemeldet');
});
