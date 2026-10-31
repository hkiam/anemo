import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { type Block, type Inline, inline, parse } from '../../../shared/wiki/parse.ts';

/** Anhänge, gegen die eingebettete Bilder (!name.png!) und Anhang-Links ([^name]) aufgelöst werden. */
export interface WikiAttachment { id: string; fileName: string; /** lokale Vorschau (noch nicht hochgeladen) */ url?: string }
const AttachmentContext = createContext<WikiAttachment[]>([]);

export function WikiAttachments({ attachments, children }: { attachments: WikiAttachment[] | undefined; children: ReactNode }) {
  const outer = useContext(AttachmentContext);
  const merged = useMemo(() => [...(attachments ?? []), ...outer], [attachments, outer]);
  return <AttachmentContext.Provider value={merged}>{children}</AttachmentContext.Provider>;
}

const EMOJI: Record<string, string> = {
  check: '✅', cross: '❌', warning: '⚠️', question: '❓', info: 'ℹ️', on: '💡', off: '⚫', star: '⭐',
  thumbsup: '👍', thumbsdown: '👎', plus: '➕', minus: '➖',
  'star-yellow': '⭐', 'star-red': '🔴', 'star-green': '🟢', 'star-blue': '🔵',
};

/** Nur unbedenkliche Farbwerte übernehmen (Namen, #hex, rgb()). */
const safeColor = (c: string) => (/^(#[0-9a-f]{3,8}|[a-z]+|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))$/i.test(c) ? c : undefined);

/** Nur http(s)-/mailto-Links als echte Links; andere Ziele (file:, javascript:) werden als Text gezeigt. */
const safeHref = (h: string) => (/^(https?:|mailto:)/i.test(h) ? h : null);

export const attachmentUrl = (a: WikiAttachment) => a.url ?? `/api/attachments/${a.id}/content`;
export const useWikiAttachments = () => useContext(AttachmentContext);

/** Bildquelle auflösen: Anhang des Objekts (per Dateiname) oder Jira-Anhang über seine ID. */
export function resolveImage(src: string, atts: WikiAttachment[]): { url: string | null; label: string } {
  const jira = /\/secure\/(?:attachment|thumbnail)\/(\d+)\/([^/?#]+)/.exec(src);
  if (jira) return { url: `/api/attachments/source/jira-${jira[1]}/content`, label: decodeURIComponent(jira[2]!) };
  if (/^https?:\/\//i.test(src)) return { url: null, label: src };
  const name = src.split('/').pop()!.trim();
  const hit = atts.find((a) => a.fileName === name) ?? atts.find((a) => a.fileName.toLowerCase() === name.toLowerCase());
  return { url: hit ? attachmentUrl(hit) : null, label: name };
}

function Img({ src, options }: { src: string; options: Record<string, string> }) {
  const atts = useContext(AttachmentContext);
  const { url, label } = resolveImage(src, atts);
  if (!url) {
    // Bild ist am Objekt nicht vorhanden (in der Quelle meist ebenso, z. B. Text aus einem anderen Test kopiert).
    // Ein gleichnamiger Anhang woanders wird bewusst nicht geraten – die Suche zeigt die Kandidaten.
    const search = `#/search?q=${encodeURIComponent(label)}&types=attachment`;
    return (
      <a className="wiki-missing" href={search} target="_blank" rel="noreferrer"
        title={`Das Bild „${label}“ ist an diesem Testfall nicht als Anhang vorhanden – auch nicht im Altsystem. Häufige Ursache: Text aus einem anderen Test kopiert. Klicken: gleichnamige Anhänge suchen.`}>
        🖼 {label} – nicht vorhanden, gleichnamige suchen
      </a>
    );
  }
  const style: React.CSSProperties = {};
  if (options.width && /^\d+$/.test(options.width)) style.width = Number(options.width);
  if (options.height && /^\d+$/.test(options.height)) style.height = Number(options.height);
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className={`wiki-img ${options.thumbnail ? 'thumb' : ''}`} title={label}>
      <img src={url} alt={label} style={style} loading="lazy" />
    </a>
  );
}

function AttachmentLink({ name }: { name: string }) {
  const atts = useContext(AttachmentContext);
  const hit = atts.find((a) => a.fileName.toLowerCase() === name.toLowerCase());
  return hit ? <a href={attachmentUrl(hit)} target="_blank" rel="noreferrer noopener">📎 {name}</a>
    : <span className="wiki-missing">📎 {name}</span>;
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return <>{nodes.map((n, i) => <InlineNode key={i} n={n} />)}</>;
}

function InlineNode({ n }: { n: Inline }): ReactNode {
  if (typeof n === 'string') return n;
  switch (n.t) {
    case 'b': return <strong><Inlines nodes={n.c} /></strong>;
    case 'i': return <em><Inlines nodes={n.c} /></em>;
    case 'u': return <u><Inlines nodes={n.c} /></u>;
    case 's': return <s><Inlines nodes={n.c} /></s>;
    case 'sup': return <sup><Inlines nodes={n.c} /></sup>;
    case 'sub': return <sub><Inlines nodes={n.c} /></sub>;
    case 'cite': return <cite><Inlines nodes={n.c} /></cite>;
    case 'mono': return <code>{n.text}</code>;
    case 'br': return <br />;
    case 'color': return <span style={{ color: safeColor(n.color) }}><Inlines nodes={n.c} /></span>;
    case 'emo': return <span role="img" aria-label={n.name}>{EMOJI[n.name] ?? ''}</span>;
    case 'mention': return <span className="chip">@{n.user}</span>;
    case 'attachment': return <AttachmentLink name={n.name} />;
    case 'img': return <Img src={n.src} options={n.options} />;
    case 'link': {
      const href = safeHref(n.href);
      return href ? <a href={href} target="_blank" rel="noreferrer noopener"><Inlines nodes={n.c} /></a>
        : <span className="wiki-link-text" title={n.href}><Inlines nodes={n.c} /></span>;
    }
  }
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return <>{blocks.map((b, i) => <BlockNode key={i} b={b} />)}</>;
}

function BlockNode({ b }: { b: Block }): ReactNode {
  switch (b.t) {
    case 'p': return <p><Inlines nodes={b.c} /></p>;
    case 'h': {
      const Tag = `h${Math.min(6, b.level + 2)}` as 'h3';
      return <Tag className="wiki-h"><Inlines nodes={b.c} /></Tag>;
    }
    case 'hr': return <hr />;
    case 'code': return <pre className="code">{b.text}</pre>;
    case 'quote': return <blockquote><Blocks blocks={b.c} /></blockquote>;
    case 'panel': return (
      <div className="wiki-panel">
        {b.title && <div className="wiki-panel-title"><Inlines nodes={parseTitle(b.title)} /></div>}
        <div className="wiki-panel-body"><Blocks blocks={b.c} /></div>
      </div>
    );
    case 'list': {
      const Tag = b.ordered ? 'ol' : 'ul';
      return <Tag>{b.items.map((it, i) => <li key={i}><Inlines nodes={it.c} />{it.children.length > 0 && <Blocks blocks={it.children} />}</li>)}</Tag>;
    }
    case 'table': return (
      <div className="wiki-table"><table><tbody>
        {b.rows.map((r, ri) => (
          <tr key={ri}>{r.cells.map((c, ci) => (r.header[ci]
            ? <th key={ci}><Inlines nodes={c} /></th>
            : <td key={ci}><Inlines nodes={c} /></td>))}</tr>
        ))}
      </tbody></table></div>
    );
  }
}

// Panel-Titel enthalten selbst Markup (z. B. "!icon.png! *Allgemein*")
const parseTitle = (t: string) => inline(t);

/** Jira-Wiki-Text sicher darstellen (Strukturbaum → React, kein HTML-Durchreichen). */
export function Wiki({ text, compact }: { text: string | null | undefined; compact?: boolean }) {
  const blocks = useMemo(() => parse(text), [text]);
  if (!text?.trim()) return <span className="muted">–</span>;
  return <div className={`wiki ${compact ? 'compact' : ''}`}><Blocks blocks={blocks} /></div>;
}

