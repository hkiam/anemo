import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { attachmentEl, blocksOf, imageEl, type ImageResolver, toDom } from './dom.ts';
import { parse } from '../../../shared/wiki/parse.ts';
import { roundTrips, sameTree, serialize } from '../../../shared/wiki/serialize.ts';
import { resolveImage, useWikiAttachments, type WikiAttachment } from './Wiki.tsx';
import { askText, toast } from '../ux.tsx';

interface Props {
  value: string | null | undefined;
  onChange: (markup: string) => void;
  /** zusätzliche Anhänge für Bildauflösung (außer denen aus dem umgebenden WikiAttachments) */
  attachments?: WikiAttachment[];
  /** Datei hochladen; ohne diese Funktion sind Einfügen/Ablegen von Dateien abgeschaltet */
  upload?: (file: File) => Promise<WikiAttachment>;
  minRows?: number;
  /** schmale Variante (z. B. Schritttabelle): Werkzeugleiste nur bei Fokus, schwebend */
  compact?: boolean;
  placeholder?: string;
  label?: string;
  /** Feldvorlagen (Stufe J5): per Knopf an der Schreibmarke einfügen; leeres Feld wird damit gefüllt */
  templates?: { id: string; name: string; content: string; scope?: string }[];
  /** „Feldinhalt als Vorlage speichern …“ (nur mit Berechtigung angeboten) */
  onSaveTemplate?: (content: string) => void;
}

const IMAGE = /^image\/(png|jpe?g|gif|webp)$/;
const COLORS = [['#de350b', 'Rot'], ['#00875a', 'Grün'], ['#ff8b00', 'Orange'], ['#0052cc', 'Blau'], ['#6b778c', 'Grau']] as const;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const NOT_VISUAL = 'Dieser Text enthält Formatierungen, die der visuelle Editor nicht verlustfrei abbilden kann – er wird als Markup bearbeitet.';

/** Eindeutiger, sprechender Dateiname (eingefügte Screenshots heißen sonst alle „image.png“). */
export function uniqueFileName(file: File, taken: string[]): string {
  const ext = /\.[a-z0-9]{1,8}$/i.exec(file.name)?.[0] ?? (IMAGE.test(file.type) ? `.${file.type.split('/')[1]!.replace('jpeg', 'jpg')}` : '');
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  const base = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name) ? `screenshot-${stamp}` : file.name.slice(0, file.name.length - ext.length);
  const clean = base.replace(/[!|[\]{}^~*\\/:]/g, '_').trim() || 'datei';
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  let name = `${clean}${ext}`;
  for (let i = 2; lower.has(name.toLowerCase()); i++) name = `${clean}-${i}${ext}`;
  return name;
}

/**
 * WYSIWYG-Editor für Jira-Wiki-Markup. Gespeichert wird Markup; der visuelle Modus wird nur angeboten, wenn
 * der Text darüber verlustfrei neu geschrieben werden kann (sonst Markup-Modus mit Hinweis).
 */
export function WikiEditor({ value, onChange, attachments, upload, minRows = 3, compact, placeholder, label, templates, onSaveTemplate }: Props) {
  const ctxAtts = useWikiAttachments();
  const extra = useRef<WikiAttachment[]>([]);
  const atts = useMemo(() => [...(attachments ?? []), ...ctxAtts], [attachments, ctxAtts]);
  const attsRef = useRef(atts);
  attsRef.current = atts;
  const resolver: ImageResolver = useCallback((src) => resolveImage(src, [...extra.current, ...attsRef.current]).url, []);

  const text = value ?? '';
  const surface = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const emitted = useRef<string | null>(null);
  const saved = useRef<Range | null>(null);
  const [mode, setMode] = useState<'visual' | 'markup'>(() => (roundTrips(text) ? 'visual' : 'markup'));
  const [notice, setNotice] = useState<string | null>(() => (roundTrips(text) ? null : NOT_VISUAL));
  const [busy, setBusy] = useState(0);
  const [empty, setEmpty] = useState(!text.trim());
  const [palette, setPalette] = useState(false);

  const render = useCallback((t: string) => {
    const root = surface.current;
    if (!root) return;
    const tree = parse(t);
    root.replaceChildren(toDom(document, tree, resolver));
    emitted.current = t;
    setEmpty(!t.trim());
    // Gegenprobe über das DOM: was angezeigt wird, muss genau so zurückgelesen werden
    if (!sameTree(blocksOf(root), tree)) {
      setMode('markup');
      setNotice(NOT_VISUAL);
    }
  }, [resolver]);

  // Wert von außen geändert (oder Wechsel in den visuellen Modus) → neu aufbauen
  useLayoutEffect(() => {
    if (mode === 'visual' && emitted.current !== text) render(text);
  }, [text, mode, render]);
  // Anhänge nachgeladen → Bilder auflösen, solange nicht bearbeitet wird
  useEffect(() => {
    if (mode === 'visual' && surface.current && !surface.current.contains(document.activeElement)) render(emitted.current ?? text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atts]);

  const emit = () => {
    const root = surface.current;
    if (!root) return;
    const md = serialize(blocksOf(root));
    emitted.current = md;
    setEmpty(!md.trim());
    onChange(md);
  };

  const remember = () => {
    const sel = window.getSelection();
    if (sel?.rangeCount && surface.current?.contains(sel.getRangeAt(0).commonAncestorContainer)) saved.current = sel.getRangeAt(0).cloneRange();
  };
  const restore = (): Range | null => {
    const r = saved.current;
    if (!r || !surface.current?.contains(r.commonAncestorContainer)) return null;
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    return r;
  };

  const exec = (cmd: string, arg?: string) => {
    surface.current?.focus();
    restore();
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(cmd, false, arg);
    emit();
    remember();
  };

  // ---- Dateien ----
  async function uploadFiles(files: File[], at?: Range | null) {
    if (!upload) return;
    for (const f of files) {
      const named = new File([f], uniqueFileName(f, [...extra.current, ...attsRef.current].map((a) => a.fileName)), { type: f.type });
      setBusy((b) => b + 1);
      try {
        const a = await upload(named);
        extra.current = [...extra.current, a];
        if (mode === 'markup') {
          insertMarkup(IMAGE.test(named.type) ? `!${a.fileName}!` : `[^${a.fileName}]`);
          continue;
        }
        const node = IMAGE.test(named.type) ? imageEl(document, a.fileName, {}, resolver) : attachmentEl(document, a.fileName);
        const r = at ?? restore();
        if (r && surface.current?.contains(r.commonAncestorContainer)) {
          r.deleteContents();
          r.insertNode(node);
          r.setStartAfter(node);
          r.collapse(true);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(r);
          saved.current = r.cloneRange();
        } else {
          const p = document.createElement('p');
          p.append(node);
          surface.current?.append(p);
        }
        at = null;
        emit();
      } catch (e) {
        setNotice(`Hochladen fehlgeschlagen: ${(e as Error).message}`);
      } finally {
        setBusy((b) => b - 1);
      }
    }
  }

  function insertMarkup(snippet: string) {
    const ta = area.current;
    const cur = ta?.value ?? text;
    const pos = ta?.selectionStart ?? cur.length;
    const next = `${cur.slice(0, pos)}${snippet}${cur.slice(ta?.selectionEnd ?? pos)}`;
    onChange(next);
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      if (upload) void uploadFiles(files);
      else setNotice('Dateien können hier erst nach dem ersten Speichern eingefügt werden.');
      return;
    }
    if (mode === 'markup') return;
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    if (html) {
      // Eingefügtes HTML wird über den Strukturbaum bereinigt (nur Jira-darstellbare Formatierung bleibt)
      const tree = blocksOf(new DOMParser().parseFromString(html, 'text/html').body);
      const box = document.createElement('div');
      box.append(toDom(document, tree, resolver));
      const single = tree.length === 1 && tree[0]!.t === 'p';
      document.execCommand('insertHTML', false, single ? (box.firstElementChild as HTMLElement).innerHTML : box.innerHTML);
    } else {
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    }
    emit();
  };

  const onDrop = (e: React.DragEvent) => {
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    e.preventDefault();
    if (!upload) return setNotice('Dateien können hier erst nach dem ersten Speichern abgelegt werden.');
    const r = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY) ?? null;
    void uploadFiles(files, r);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      void addLink();
    } else if (e.key === 'Tab' && window.getSelection()?.anchorNode?.parentElement?.closest('li')) {
      e.preventDefault();
      exec(e.shiftKey ? 'outdent' : 'indent');
    }
  };

  async function addLink() {
    remember();
    const hadSelection = !!saved.current && !saved.current.collapsed;
    const url = await askText({ title: 'Link einfügen', label: 'Adresse', placeholder: 'https://…', hint: hadSelection ? 'Der markierte Text wird verlinkt.' : 'Ohne Markierung wird die Adresse als Text eingefügt.', confirmLabel: 'Einfügen' });
    if (!url || !/^(https?:|mailto:)/i.test(url.trim())) {
      if (url) toast('Nur Adressen mit https://, http:// oder mailto: sind erlaubt.', 'bad');
      return;
    }
    if (hadSelection) exec('createLink', url.trim());
    else exec('insertHTML', `<a href="${esc(url.trim())}" data-href="${esc(url.trim())}">${esc(url.trim())}</a>`);
  }
  function inlineCode() {
    const t = window.getSelection()?.toString() || 'Code';
    exec('insertHTML', `<code>${esc(t)}</code>`);
  }
  function table() {
    exec('insertHTML', '<table><tbody><tr><th>Spalte 1</th><th>Spalte 2</th></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p><br></p>');
  }
  async function panel() {
    remember();
    const title = ((await askText({ title: 'Hinweiskasten einfügen', label: 'Titel', initial: 'Hinweis', confirmLabel: 'Einfügen' })) ?? '').replace(/[|{}]/g, '').trim();
    if (!title) return;
    exec('insertHTML', `<div class="wiki-panel" data-panel="${esc(title)}"><div class="wiki-panel-title" contenteditable="false">${esc(title)}</div><div class="wiki-panel-body"><p>Text</p></div></div><p><br></p>`);
  }

  // ---- Feldvorlagen (J5) ----
  const [tplOpen, setTplOpen] = useState(false);
  function insertTemplate(content: string) {
    setTplOpen(false);
    if (!text.trim()) { onChange(content); if (mode === 'visual' && surface.current) { surface.current.replaceChildren(toDom(document, parse(content), resolver)); emitted.current = content; setEmpty(false); } return; }
    if (mode === 'markup') { insertMarkup(content); return; }
    const box = document.createElement('div');
    box.append(toDom(document, parse(content), resolver));
    exec('insertHTML', box.innerHTML);
  }

  function switchMode() {
    if (mode === 'visual') {
      setMode('markup');
      setNotice(null);
      return;
    }
    if (!roundTrips(text)) return setNotice(NOT_VISUAL);
    emitted.current = null;
    setNotice(null);
    setMode('visual');
  }

  const fileInput = useRef<HTMLInputElement>(null);
  const B = ({ cmd, title, children, onClick }: { cmd?: string; title: string; children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" className="we-btn" title={title} aria-label={title} tabIndex={-1}
      onMouseDown={(e) => { e.preventDefault(); remember(); }}
      onClick={() => (onClick ? onClick() : cmd && exec(cmd))}>{children}</button>
  );

  return (
    <div className={`wiki-editor ${compact ? 'compact' : ''}`} style={{ '--rows': minRows } as React.CSSProperties}>
      <div className="we-toolbar" role="toolbar" aria-label={label ? `Formatierung ${label}` : 'Formatierung'}>
        {mode === 'visual' && <>
          <B cmd="bold" title="Fett (Strg+B)"><b>F</b></B>
          <B cmd="italic" title="Kursiv (Strg+I)"><i>K</i></B>
          <B cmd="underline" title="Unterstrichen (Strg+U)"><u>U</u></B>
          <B cmd="strikeThrough" title="Durchgestrichen"><s>S</s></B>
          <B title="Code im Text" onClick={inlineCode}>{'{}'}</B>
          <span className="we-color">
            <B title="Textfarbe" onClick={() => setPalette((x) => !x)}><span style={{ color: '#de350b' }}>A</span></B>
            {palette && <span className="we-palette">{COLORS.map(([c, n]) => (
              <button key={c} type="button" title={n} aria-label={n} style={{ background: c }} onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setPalette(false); exec('foreColor', c); }} />
            ))}</span>}
          </span>
          {!compact && <>
            <span className="we-sep" />
            <B title="Überschrift" onClick={() => exec('formatBlock', '<h2>')}>H</B>
            <B title="Absatz" onClick={() => exec('formatBlock', '<p>')}>¶</B>
          </>}
          <span className="we-sep" />
          <B cmd="insertUnorderedList" title="Aufzählung">•</B>
          <B cmd="insertOrderedList" title="Nummerierung">1.</B>
          {!compact && <>
            <B title="Zitat" onClick={() => exec('formatBlock', '<blockquote>')}>❝</B>
            <B title="Codeblock" onClick={() => exec('formatBlock', '<pre>')}>{'</>'}</B>
            <B title="Tabelle einfügen" onClick={table}>▦</B>
            <B title="Hinweiskasten (Panel)" onClick={panel}>▭</B>
          </>}
          <B title="Link (Strg+K)" onClick={addLink}>🔗</B>
        </>}
        {upload && <B title="Bild oder Datei einfügen (auch per Einfügen/Ablegen)" onClick={() => fileInput.current?.click()}>📎</B>}
        {mode === 'visual' && <B cmd="removeFormat" title="Formatierung entfernen">⌫</B>}
        {((templates?.length ?? 0) > 0 || onSaveTemplate) && <span className="we-color">
          <B title="Vorlage einfügen (formatierter Standardaufbau)" onClick={() => { remember(); setTplOpen((x) => !x); }}>📋</B>
          {tplOpen && <span className="we-palette we-templates" role="menu" aria-label={`Vorlagen${label ? ` für ${label}` : ''}`}>
            {(templates ?? []).map((t) => (
              <button key={t.id} type="button" role="menuitem" className="ghost small" onMouseDown={(e) => e.preventDefault()} onClick={() => insertTemplate(t.content)}
                title={t.content.slice(0, 300)}>{t.name}{t.scope && <span className="small muted"> · {t.scope}</span>}</button>
            ))}
            {(templates ?? []).length === 0 && <span className="small muted" style={{ padding: '2px 6px' }}>Keine Vorlagen für dieses Feld</span>}
            {onSaveTemplate && <button type="button" role="menuitem" className="ghost small" onMouseDown={(e) => e.preventDefault()} disabled={!text.trim()}
              onClick={() => { setTplOpen(false); onSaveTemplate(text); }}>＋ Feldinhalt als Vorlage speichern …</button>}
          </span>}
        </span>}
        <span className="spacer" />
        {busy > 0 && <span className="small muted">lädt hoch …</span>}
        <button type="button" className="we-btn we-mode" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={switchMode}
          title={mode === 'visual' ? 'Jira-Markup direkt bearbeiten' : 'Zur visuellen Bearbeitung'}>{mode === 'visual' ? 'Markup' : 'Visuell'}</button>
      </div>
      {mode === 'visual' ? (
        <div ref={surface} className={`we-surface wiki ${empty ? 'empty' : ''}`} contentEditable suppressContentEditableWarning role="textbox" aria-multiline
          aria-label={label} data-placeholder={placeholder ?? ''} spellCheck
          onInput={emit} onBlur={remember} onKeyUp={remember} onMouseUp={remember} onPaste={onPaste} onDrop={onDrop} onKeyDown={onKeyDown}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
          onFocus={() => document.execCommand('defaultParagraphSeparator', false, 'p')} />
      ) : (
        <textarea ref={area} className="we-markup mono" value={text} rows={Math.max(minRows, Math.min(20, text.split('\n').length + 1))}
          aria-label={label} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} onPaste={onPaste} onDrop={onDrop}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }} />
      )}
      {notice && <div className="we-notice small">{notice}</div>}
      {upload && <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void uploadFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />}
    </div>
  );
}
