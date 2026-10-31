import type { ReactNode } from 'react';
import { helpSlug } from '../../../shared/help/topics.ts';

/**
 * Kleiner Markdown-Renderer für das Handbuch (Überschriften, Absätze, Listen, Tabellen, Code, Zitate, Links,
 * Fett/Kursiv/Code). Ausgabe ausschließlich als React-Elemente – kein innerHTML.
 */
type LinkMap = (href: string) => { href: string; external: boolean } | null;

function inline(text: string, link: LinkMap, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<!\w)_([^_\n]+)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{inline(m[2], link, k)}</strong>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<em key={k}>{inline((m[3] ?? m[4])!, link, k)}</em>);
    else {
      const target = link(m[6]!);
      out.push(target ? <a key={k} href={target.href} {...(target.external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>{inline(m[5]!, link, k)}</a> : <span key={k}>{inline(m[5]!, link, k)}</span>);
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, link }: { text: string; link: LinkMap }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const isBlockStart = (l: string) => /^(#{1,6} |```|\s*[-*] |\s*\d+\. |\||> )/.test(l) || !l.trim();
  while (i < lines.length) {
    const l = lines[i]!;
    if (!l.trim()) { i++; continue; }
    const h = /^(#{1,6}) (.*)$/.exec(l);
    if (h) {
      const level = Math.min(6, h[1]!.length + 1);
      const Tag = `h${level}` as 'h2';
      const id = helpSlug(h[2]!.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'));
      blocks.push(<Tag key={k++} id={id}>{inline(h[2]!, link)}</Tag>);
      i++;
      continue;
    }
    if (l.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!);
      i++;
      blocks.push(<pre key={k++} className="code">{body.join('\n')}</pre>);
      continue;
    }
    if (l.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) {
        const cells = lines[i]!.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(<div key={k++} className="table-wrap"><table><thead><tr>{head!.map((c, j) => <th key={j}>{inline(c, link)}</th>)}</tr></thead>
        <tbody>{body.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, link)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^\s*([-*]|\d+\.) /.test(l)) {
      const ordered = /^\s*\d+\. /.test(l);
      const items: { text: string; indent: number }[] = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.) /.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        const m = /^(\s*)(?:[-*]|\d+\.) (.*)$/.exec(lines[i]!);
        if (m) items.push({ text: m[2]!, indent: m[1]!.length });
        else items[items.length - 1]!.text += ` ${lines[i]!.trim()}`;
        i++;
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={k++}>{items.map((it, j) => <li key={j} style={it.indent ? { marginLeft: it.indent * 8 } : undefined}>{inline(it.text, link)}</li>)}</Tag>);
      continue;
    }
    if (l.startsWith('> ')) {
      const q: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('> ')) q.push(lines[i++]!.slice(2));
      blocks.push(<blockquote key={k++}>{inline(q.join(' '), link)}</blockquote>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i]!)) para.push(lines[i++]!.trim());
    if (!para.length) para.push(lines[i++]!.trim());
    blocks.push(<p key={k++}>{inline(para.join(' '), link)}</p>);
  }
  return <div className="markdown">{blocks}</div>;
}
