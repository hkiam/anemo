/**
 * Lieferpaket je Testplan/Release (C2): Abschlussbericht, Testprotokolle je Zyklus, maschinenlesbare Ergebnisse,
 * Evidenzen, Prüfsummen (SHA-256) und optional eine Ed25519-Signatur über die Prüfsummenliste.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../../platform/db.ts';
import { type ZipEntry, zipStream } from '../../platform/zip.ts';
import { type AttachmentRef, completionReport, testLog, traceability } from './data.ts';
import { type ProfileOptions, renderHtml, renderMarkdown } from './render.ts';

const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
const evidencePath = (a: AttachmentRef) => `evidenzen/${a.id.slice(-12)}-${slug(a.fileName)}`;

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export async function buildPackage(db: Db, opts: { planId: string; profile: { name: string; options: ProfileOptions }; actor: string; attachmentDir: string }) {
  const completion = await completionReport(db, opts.planId, opts.actor, { steps: false });
  const files: ZipEntry[] = [];
  const used = new Map<string, AttachmentRef>();
  const url = (a: AttachmentRef) => evidencePath(a);
  const html = renderHtml(completion, opts.profile, url);
  html.used.forEach((a) => used.set(a.id, a));
  files.push({ name: 'Testabschlussbericht.html', data: html.html }, { name: 'Testabschlussbericht.md', data: renderMarkdown(completion, opts.profile) });
  const trace = await traceability(db, opts.planId, opts.actor);
  files.push({ name: 'Rueckverfolgbarkeit.html', data: renderHtml(trace, opts.profile, url).html }, { name: 'Rueckverfolgbarkeit.md', data: renderMarkdown(trace, opts.profile) });
  const logs = [];
  let n = 0;
  for (const c of completion.cycles) {
    const log = await testLog(db, c.id, opts.actor, { steps: opts.profile.options.sections.steps });
    logs.push(log);
    // In Protokollen gehören Evidenzen dazu; Pfade relativ zum Unterordner
    const r = renderHtml(log, opts.profile, (a) => `../${evidencePath(a)}`);
    r.used.forEach((a) => used.set(a.id, a));
    files.push({ name: `Testprotokolle/${String(++n).padStart(2, '0')}-${slug(c.name)}.html`, data: r.html });
  }
  files.push({ name: 'ergebnisse.json', data: JSON.stringify({ format: 'anemo-results/1', completion, traceability: trace, testLogs: logs }, null, 2) });

  const locations = used.size
    ? await db<{ id: string; location: string }[]>`select id, location from attachment where id = any(${[...used.keys()]}::uuid[]) and storage = 'LOCAL'`
    : [];
  for (const l of locations) files.push({ name: evidencePath(used.get(l.id)!), path: join(opts.attachmentDir, l.location) });

  // Prüfsummen über alle Inhalte
  const sums: { path: string; sha256: string; size: number }[] = [];
  for (const f of files) {
    if ('data' in f) {
      const b = typeof f.data === 'string' ? Buffer.from(f.data) : f.data;
      sums.push({ path: f.name, sha256: sha256(b), size: b.length });
    } else if ('path' in f) {
      sums.push({ path: f.name, sha256: await sha256File(f.path), size: (await stat(f.path)).size });
    }
  }
  const manifest = {
    format: 'anemo-delivery/1', generatedAt: completion.generatedAt, generatedBy: opts.actor, profile: opts.profile.name,
    project: completion.project, plan: completion.plan, assessment: completion.assessment, files: sums,
  };
  files.push({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
  sums.push({ path: 'manifest.json', sha256: sha256(JSON.stringify(manifest, null, 2)), size: Buffer.byteLength(JSON.stringify(manifest, null, 2)) });
  const sumsText = `${sums.map((s) => `${s.sha256}  ${s.path}`).join('\n')}\n`;
  files.push({ name: 'SHA256SUMS', data: sumsText });

  let signed = false;
  const keyFile = process.env.ANEMO_SIGNING_KEY_FILE;
  if (keyFile) {
    const key = createPrivateKey(await readFile(keyFile));
    files.push({ name: 'SHA256SUMS.sig', data: sign(null, Buffer.from(sumsText), key) });
    files.push({ name: 'anemo-signatur-public.pem', data: createPublicKey(key).export({ type: 'spki', format: 'pem' }) as string });
    signed = true;
  }
  files.push({ name: 'LIESMICH.txt', data: readme(completion.project.key, completion.plan.name, signed) });
  const name = `Lieferpaket-${slug(completion.project.key)}-${slug(completion.plan.release ?? completion.plan.name)}-${completion.generatedAt.toISOString().slice(0, 10)}.zip`;
  return { name, stream: zipStream(files) };
}

function readme(project: string, plan: string, signed: boolean): string {
  return `Lieferpaket Testnachweise – ${project} / ${plan}

Inhalt
  Testabschlussbericht.html  Abschlussbericht (im Browser öffnen; „Drucken → Als PDF speichern“ für PDF)
  Testabschlussbericht.md    derselbe Bericht als Markdown
  Testprotokolle/            Testprotokoll je Testzyklus
  ergebnisse.json            maschinenlesbare Ergebnisse (Format anemo-results/1)
  evidenzen/                 Screenshots und Dateien, auf die die Berichte verweisen
  manifest.json              Metadaten und Prüfsummen
  SHA256SUMS                 SHA-256-Prüfsummen aller Dateien

Prüfen der Vollständigkeit (Linux/macOS):
  shasum -a 256 -c SHA256SUMS
${signed ? `
Prüfen der Signatur (Ed25519, OpenSSL ≥ 3):
  openssl pkeyutl -verify -pubin -inkey anemo-signatur-public.pem -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig
Der öffentliche Schlüssel sollte zusätzlich auf getrenntem Weg bestätigt werden.
` : `
Dieses Paket ist nicht signiert (kein Signaturschlüssel eingerichtet).
`}`;
}
