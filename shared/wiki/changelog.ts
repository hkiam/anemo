/**
 * Manuelle Änderungstabellen in Beschreibungen erkennen (Roadmap E), z. B. „||Bearbeiter||Datum||Grund||“.
 * Der Text bleibt unverändert; die Einträge werden nur als dokumentierte Änderungen ausgewiesen.
 */
import { type Inline, parse } from './parse.ts';

export interface DocumentedChange { date: string | null; sortKey: string; author: string | null; note: string }

const plain = (c: Inline[]): string => c.map((n) => (typeof n === 'string' ? n : n.t === 'br' ? ' ' : 'c' in n ? plain(n.c) : 'text' in n ? n.text : '')).join('').replace(/\s+/g, ' ').trim();

const DATE = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})|(\d{4})-(\d{2})-(\d{2})/;
function isoDate(s: string): string | null {
  const m = DATE.exec(s);
  if (!m) return null;
  if (m[4]) return `${m[4]}-${m[5]}-${m[6]}`;
  const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  return `${y}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
}

/** Spalten einer Änderungstabelle: Datum + Person + Beschreibung (Grund/Änderung/Kommentar). */
function columns(header: string[]): { date: number; author: number; note: number } | null {
  const h = header.map((x) => x.toLowerCase());
  const date = h.findIndex((x) => /^(datum|date|geändert am|am)$/.test(x));
  const author = h.findIndex((x) => /^(bearbeiter|autor|author|geändert von|von|wer|name)$/.test(x));
  const note = h.findIndex((x) => /^(grund|änderung|änderungen|beschreibung|kommentar|was|bemerkung|anmerkung)$/.test(x));
  return date >= 0 && author >= 0 && note >= 0 ? { date, author, note } : null;
}

export function documentedChanges(...texts: (string | null | undefined)[]): DocumentedChange[] {
  const out: DocumentedChange[] = [];
  for (const t of texts) {
    for (const b of parse(t)) {
      if (b.t !== 'table' || b.rows.length < 2) continue;
      const cols = columns(b.rows[0]!.cells.map(plain));
      if (!cols) continue;
      for (const r of b.rows.slice(1)) {
        const cell = (i: number) => (r.cells[i] ? plain(r.cells[i]!) : '');
        const note = cell(cols.note);
        if (!note && !cell(cols.date)) continue;
        const date = isoDate(cell(cols.date));
        out.push({ date, sortKey: date ?? '', author: cell(cols.author) || null, note: note || '–' });
      }
    }
  }
  return out.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
}
