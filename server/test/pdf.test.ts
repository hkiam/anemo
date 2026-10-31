import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { inflateSync } from 'node:zlib';
import { glyphs, markdownToPdf } from '../src/platform/pdf.ts';
import { parseTrueType } from '../src/platform/pdf-font.ts';

/** Kleiner Leser für die erzeugten PDFs: Querverweisstrom, Objektströme, Ströme und Text über die ToUnicode-CMaps. */
function reader(pdf: Buffer) {
  const text = pdf.toString('latin1');
  const direct = (at: number, n: number) => {
    assert.equal(text.slice(at, at + `${n} 0 obj\n`.length), `${n} 0 obj\n`, `Objekt ${n} am Offset ${at}`);
    return text.slice(at + `${n} 0 obj\n`.length, text.indexOf('\nendobj', at));
  };
  const decode = (o: string) => {
    const raw = Buffer.from(o.slice(o.indexOf('stream\n') + 7, o.lastIndexOf('\nendstream')), 'latin1');
    assert.equal(raw.length, Number(/\/Length (\d+)/.exec(o.slice(0, o.indexOf('stream\n')))![1]), 'Länge des Stroms');
    return /\/FlateDecode/.test(o.slice(0, o.indexOf('stream\n'))) ? inflateSync(raw) : raw;
  };
  // Querverweisstrom: /W [1 4 2] – Typ 1 = Offset, Typ 2 = Objektstrom und Index
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
  const xrefNo = Number(/^(\d+) 0 obj\n/.exec(text.slice(startxref))![1]);
  const xrefObj = direct(startxref, xrefNo);
  assert.match(xrefObj, /\/Type \/XRef/);
  const rows = decode(xrefObj);
  const entries = Array.from({ length: rows.length / 7 }, (_, n) => ({ type: rows[7 * n]!, a: rows.readUInt32BE(7 * n + 1), b: rows.readUInt16BE(7 * n + 5) }));
  const objStm = new Map<number, string[]>();
  const obj = (n: number): string => {
    const e = entries[n];
    assert.ok(e && e.type > 0, `Objekt ${n}`);
    if (e.type === 1) return direct(e.a, n);
    if (!objStm.has(e.a)) {
      const o = obj(e.a);
      const data = decode(o).toString('latin1');
      const first = Number(/\/First (\d+)/.exec(o)![1]);
      const head = data.slice(0, first).trim().split(/\s+/).map(Number);
      objStm.set(e.a, head.filter((_, i) => i % 2).map((off, i, a) => data.slice(first + off, i + 1 < a.length ? first + a[i + 1]! : undefined).trim()));
    }
    return objStm.get(e.a)![e.b]!;
  };
  const stream = (n: number) => decode(obj(n));
  /** alle Objekte (auch aus Objektströmen) als Text */
  const all = entries.map((e, n) => (e.type ? obj(n) : '')).join('\n');
  const trailer = xrefObj.slice(0, xrefObj.indexOf('stream\n'));
  const ref = (s: string, key: string) => Number(new RegExp(`/${key} (\\d+) 0 R`).exec(s)![1]);
  const catalog = obj(Number(/\/Root (\d+) 0 R/.exec(trailer)![1]));
  const pages = [...obj(ref(catalog, 'Pages')).matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  /** Text einer Seite (Kopf, Inhalt, Fuß in Stromreihenfolge) */
  const pageText = (p: number) => {
    const page = obj(p);
    const maps: Record<string, Map<string, string>> = {};
    for (const [, name, n] of page.matchAll(/\/(F[RBC]) (\d+) 0 R/g)) {
      const cmap = stream(ref(obj(Number(n)), 'ToUnicode')).toString('latin1');
      const m = new Map<string, string>();
      for (const [, cid, u] of cmap.matchAll(/<([0-9A-F]{4})> <([0-9A-F]+)>/g)) m.set(cid!, Buffer.from(u!, 'hex').swap16().toString('utf16le'));
      maps[name!] = m;
    }
    const content = stream(ref(page, 'Contents')).toString('latin1');
    let out = '';
    let font = '';
    for (const [, f, hex] of content.matchAll(/\/(F[RBC]) [\d.]+ Tf|<([0-9A-F]*)> Tj/g)) {
      if (f) { font = f; continue; }
      out += hex!.match(/.{4}/g)?.map((c) => maps[font]!.get(c) ?? '�').join('') ?? '';
    }
    return { out, content, page };
  };
  return { text, all, trailer, entries, obj, stream, ref, catalog, pages, pageText };
}

describe('PDF aus Markdown', () => {
  const rows = Array.from({ length: 80 }, (_, i) => `| DEMO-T${i + 1} | Akte öffnen und „prüfen“ – Variante ${i + 1} mit etwas längerem Text, der umbrechen muss | **Bestanden** ✓ |`).join('\n');
  const md = `# Testabschlussbericht – DEMO\n\nErstellt von Prüferin · Profil „Standard“\n\n## Bewertung: Freigabe empfohlen\n\n- Alle Tests bestanden ✓\n- Kein offener Fehler ✗ → ≥ 3 ≤ 5 ≠ 4\n  - verschachtelt\n1. erstens\n\n#### Details\n\n\`\`\`\nconst x = 1;\n\`\`\`\n\n## Testfälle\n\n| Schlüssel | Titel | Ergebnis |\n|---|---|---|\n${rows}\n\n---\nVertraulich 🔒 ⏱ Ende`;
  const title = 'Testabschlussbericht – DEMO Äöü';
  const pdf = markdownToPdf(md, { title, footer: 'Beispiel GmbH · vertraulich', author: 'Prüferin' });
  const r = reader(pdf);

  it('erzeugt ein gültiges PDF mit Umlauten, Tabellen über mehrere Seiten und Seitenzahlen', async () => {
    await writeFile(join(tmpdir(), 'anemo-test-report.pdf'), pdf);
    assert.ok(r.text.startsWith('%PDF-1.7'));
    assert.ok(r.text.trimEnd().endsWith('%%EOF'));
    const pages = Number(/\/Count (\d+)/.exec(r.all)![1]);
    assert.ok(pages >= 3, `mehrere Seiten (${pages})`);
    assert.equal(r.pages.length, pages);
    // Querverweise: jedes Objekt erreichbar (direkt per Offset oder im Objektstrom), Größe stimmt
    assert.equal(Number(/\/Size (\d+)/.exec(r.trailer)![1]), r.entries.length);
    assert.ok(r.entries.slice(1).every((e) => e.type === 1 || e.type === 2));
    assert.ok(r.entries.some((e) => e.type === 2), 'Objektströme benutzt');
    // Text der ersten Seite über ToUnicode: Umlaute, typografische Zeichen, Seitenzahl
    const first = r.pageText(r.pages[0]!).out;
    assert.match(first, new RegExp(`Seite 1 von ${pages}`));
    assert.match(first, /öffnen/);
    assert.match(first, /„prüfen“/);
    assert.match(r.pageText(r.pages.at(-1)!).out, new RegExp(`Seite ${pages} von ${pages}`));
  });

  it('Unicode-Zeichen bleiben erhalten, Emoji ohne Glyphe entfallen', () => {
    const all = r.pages.map((p) => r.pageText(p).out).join('\n');
    for (const ch of ['✓', '✗', '→', '≥', '≤', '≠', '•', '–']) assert.ok(all.includes(ch), `${ch} dargestellt`);
    assert.ok(!all.includes('🔒') && !all.includes('⏱') && !all.includes('�'));
    assert.match(all, /Vertraulich +Ende/);
    assert.deepEqual(glyphs('a🔒b', 'R').map((g) => g.text), ['a', 'b']);
    assert.deepEqual(glyphs('\u{10FFFD}', 'R').map((g) => g.text), [], 'Zeichen außerhalb der BMP ohne Glyphe entfallen');
    assert.deepEqual(glyphs('', 'R').map((g) => g.text), ['?'], 'fehlende Zeichen werden „?“');
  });

  it('Schriften sind als Teilmenge mit Breiten und ToUnicode eingebettet', () => {
    assert.doesNotMatch(r.all, /Helvetica|Courier|WinAnsiEncoding/);
    const type0 = [...r.all.matchAll(/\/Subtype \/Type0 \/BaseFont \/([A-Z]{6})\+(DejaVuSans[-\w]*) \/Encoding \/Identity-H \/DescendantFonts \[(\d+) 0 R\] \/ToUnicode (\d+) 0 R/g)];
    assert.deepEqual(type0.map((m) => m[2]).sort(), ['DejaVuSans', 'DejaVuSans-Bold', 'DejaVuSansMono']);
    for (const m of type0) {
      const cid = r.obj(Number(m[3]));
      assert.match(cid, /\/Subtype \/CIDFontType2/);
      assert.match(cid, /\/CIDToGIDMap \/Identity/);
      assert.match(cid, /\/W \[1 \[[\d ]+\]\]/);
      const program = r.stream(r.ref(r.obj(r.ref(cid, 'FontDescriptor')), 'FontFile2'));
      // eingebettete Teilmenge ist eine lesbare TrueType-Schrift und deutlich kleiner als das Original
      const sub = parseTrueType(program);
      assert.ok(sub.numGlyphs > 1 && sub.numGlyphs < 200, `${m[2]}: ${sub.numGlyphs} Glyphen`);
      assert.ok(program.length < 40_000, `${m[2]}: ${program.length} Bytes`);
    }
  });

  it('Tagged PDF nach PDF/UA: Strukturbaum, markierte Inhalte, Sprache, Titel', () => {
    const c = r.catalog;
    assert.match(c, /\/MarkInfo << \/Marked true >>/);
    assert.match(c, /\/Lang \(de-DE\)/);
    assert.match(c, /\/ViewerPreferences << \/DisplayDocTitle true >>/);
    const root = r.obj(r.ref(c, 'StructTreeRoot'));
    assert.match(root, /\/Type \/StructTreeRoot/);
    const elems = [...r.all.matchAll(/\/Type \/StructElem \/S \/(\w+)/g)].map((m) => m[1]);
    for (const t of ['Document', 'H1', 'H2', 'H3', 'P', 'L', 'LI', 'Lbl', 'LBody', 'Table', 'THead', 'TBody', 'TR', 'TH', 'TD', 'Code']) assert.ok(elems.includes(t), `${t} vorhanden`);
    assert.ok(!elems.includes('H4'), 'Überschriftenebenen ohne Sprung (#### nach ## wird H3)');
    assert.equal(elems.filter((t) => t === 'TH').length, 3, 'Kopfzeile nur einmal im Strukturbaum');
    assert.equal(elems.filter((t) => t === 'TR').length, 81);
    assert.match(r.all, /\/S \/TH [^>]*\/A << \/O \/Table \/Scope \/Column >>/);
    assert.match(r.all, /\/S \/L [^>]*\/ListNumbering \/Disc/);
    // jede MCID im Inhalt steht im ParentTree; Kopf-/Fußzeile und wiederholte Tabellenköpfe sind Artefakte
    const nums = /\/ParentTree << \/Nums \[([\s\S]*?)\] >>/.exec(root)![1]!;
    r.pages.forEach((p, i) => {
      const { content, page } = r.pageText(p);
      assert.match(page, new RegExp(`/StructParents ${i} `));
      const mcids = [...content.matchAll(/<<\/MCID (\d+)>> BDC/g)].map((m) => Number(m[1]));
      assert.deepEqual(mcids, mcids.map((_, k) => k), 'MCIDs fortlaufend');
      const entry = new RegExp(`(?:^|\\] )${i} \\[([^\\]]*)\\]`).exec(nums)![1]!;
      assert.equal([...entry.matchAll(/\d+ 0 R/g)].length, mcids.length, `ParentTree Seite ${i + 1}`);
      assert.match(content, /\/Artifact <<\/Type \/Pagination \/Subtype \/Header>> BDC/);
      assert.match(content, /\/Artifact <<\/Type \/Pagination \/Subtype \/Footer>> BDC/);
      // kein Text außerhalb markierter Inhalte
      let depth = 0;
      for (const [op] of content.matchAll(/\bBDC\b|\bBMC\b|\bEMC\b|\bTj\b/g)) {
        if (op === 'EMC') depth--;
        else if (op === 'Tj') assert.ok(depth > 0, 'Text markiert');
        else depth++;
      }
      assert.equal(depth, 0);
      if (i > 0 && i < r.pages.length - 1) assert.ok(!/\/TH <<\/MCID/.test(content), 'wiederholte Kopfzeile ist Artefakt');
    });
  });

  it('Metadaten für PDF/A-2b und PDF/UA-1: XMP, Info, OutputIntent, Dokument-ID', () => {
    const meta = r.obj(r.ref(r.catalog, 'Metadata'));
    assert.doesNotMatch(meta.slice(0, meta.indexOf('stream')), /Filter/, 'XMP unkomprimiert');
    const xmp = Buffer.from(meta.slice(meta.indexOf('stream\n') + 7), 'latin1').toString('utf8');
    assert.match(xmp, /<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Testabschlussbericht – DEMO Äöü<\/rdf:li>/);
    assert.match(xmp, /<dc:language><rdf:Bag><rdf:li>de-DE<\/rdf:li>/);
    assert.match(xmp, /<dc:creator><rdf:Seq><rdf:li>Prüferin<\/rdf:li>/);
    assert.match(xmp, /<pdfuaid:part>1<\/pdfuaid:part>/);
    assert.match(xmp, /<pdfaid:part>2<\/pdfaid:part>/);
    assert.match(xmp, /<pdfaid:conformance>B<\/pdfaid:conformance>/);
    const info = r.obj(Number(/\/Info (\d+) 0 R/.exec(r.trailer)![1]));
    const hex = /\/Title <FEFF([0-9A-F]+)>/.exec(info)![1]!;
    assert.equal(Buffer.from(hex, 'hex').swap16().toString('utf16le'), title);
    const created = /\/CreationDate \(D:(\d{14})\+00'00'\)/.exec(info)![1]!;
    assert.ok(xmp.includes(`<xmp:CreateDate>${created.replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/, '$1-$2-$3T$4:$5:$6')}+00:00</xmp:CreateDate>`), 'Datum in Info und XMP gleich');
    const intent = r.obj(Number(/\/OutputIntents \[(\d+) 0 R\]/.exec(r.catalog)![1]));
    assert.match(intent, /\/S \/GTS_PDFA1/);
    const icc = r.stream(r.ref(intent, 'DestOutputProfile'));
    assert.equal(icc.toString('latin1', 36, 40), 'acsp', 'ICC-Profil');
    assert.equal(icc.toString('latin1', 16, 20), 'RGB ');
    assert.match(r.trailer, /\/ID \[<[0-9A-F]{32}> <[0-9A-F]{32}>\]/);
    assert.doesNotMatch(r.all, /\/Encrypt|\/SMask|\/CA |\/ca /);
  });

  it('kurzes Dokument ohne Tabellen und Listen', () => {
    const small = reader(markdownToPdf('Nur ein Absatz.', { title: 'Kurz' }));
    assert.equal(small.pages.length, 1);
    assert.match(small.pageText(small.pages[0]!).out, /Nur ein Absatz\./);
    assert.match(small.all, /\/S \/Document [^>]*\/K \d+ 0 R/);
  });
});
