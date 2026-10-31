import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { fieldsFor, findField, type Scope, tokenize, validate } from '../../../shared/aql/aql.ts';

const OPS = ['=', '!=', '~', '!~', '>', '>=', '<', '<=', 'IN (', 'NICHT IN (', 'IST LEER', 'IST NICHT LEER'];
const KEYWORDS = ['UND', 'ODER', 'NICHT', 'SORTIERT NACH'];

export const AQL_EXAMPLES: Record<Scope, [string, string][]> = {
  testcase: [
    ['priorität >= Kritisch UND kategorie = Freigegeben', 'Wichtige, freigegebene Testfälle'],
    ['label IN (smoke, regression) UND NICHT ordner ~ Alt', 'Labels, ohne Ordner „Alt…“'],
    ['ergebnis = Fehlgeschlagen UND ausgeführt > -14d', 'Zuletzt fehlgeschlagen (14 Tage)'],
    ['anforderung = DEMO-1234', 'Tests zu einer Anforderung'],
    ['feld.Team = Alpha SORTIERT NACH geändert ABSTEIGEND', 'Eigenes Feld, neueste zuerst'],
    ['geändert > -7d UND geändertvon = ich()', 'Was ich diese Woche geändert habe'],
  ],
  execution: [
    ['status = Fehlgeschlagen UND fehler IST LEER', 'Fehlschläge ohne Fehlerticket'],
    ['zugewiesen = ich() UND kategorie = offen', 'Meine offenen Ausführungen'],
    ['zyklus ~ Regression UND konfiguration.datenbank = Oracle', 'Regression auf Oracle'],
    ['ausgeführt >= heute() SORTIERT NACH ausgeführt ABSTEIGEND', 'Heute ausgeführt'],
    ['release = "7.5" UND kategorie IN (Fehlgeschlagen, Blockiert)', 'Probleme im Release'],
    ['zugewiesen IST LEER UND kategorie = offen', 'Nicht zugewiesen'],
  ],
};

/**
 * Eingabe für die Abfragesprache: prüft beim Tippen (gleicher Parser wie der Server), markiert Fehler mit Position,
 * schlägt Felder, Vergleiche und Werte vor; „?“ zeigt alle Felder und Beispiele.
 */
export function QueryInput({ scope, value, onSubmit, onChange, values = {}, placeholder, autoFocus }: {
  scope: Scope; value: string; onSubmit: (aql: string) => void;
  /** jede Eingabe (für Formulare, die ohne „Suchen“ abgeschickt werden) */
  onChange?: (aql: string) => void;
  /** Wertvorschläge je Feld (kanonischer Name), z. B. { status: [...], label: [...] } */
  values?: Record<string, string[]>;
  placeholder?: string; autoFocus?: boolean;
}) {
  const [text, setText] = useState(value);
  const [caret, setCaret] = useState(value.length);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const [help, setHelp] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const uid = useId();
  const listId = `${uid}-vorschlaege`;
  const errId = `${uid}-fehler`;
  useEffect(() => setText(value), [value]);
  const error = useMemo(() => (text.trim() ? validate(text, scope) : null), [text, scope]);
  const suggestions = useMemo(() => suggest(text, caret, scope, values), [text, caret, scope, values]);
  useEffect(() => setSel(0), [suggestions.items.join('|')]);

  const accept = (item: string) => {
    const before = text.slice(0, suggestions.from);
    const after = text.slice(caret);
    const insert = item + (item.endsWith('(') ? '' : ' ');
    const next = before + insert + after.replace(/^\S*/, '');
    setText(next);
    onChange?.(next);
    const pos = (before + insert).length;
    setCaret(pos);
    requestAnimationFrame(() => { ref.current?.setSelectionRange(pos, pos); ref.current?.focus(); });
  };
  const submit = () => { if (!error) { setOpen(false); onSubmit(text.trim()); } };
  const shown = suggestions.items.slice(0, 12);
  const listOpen = open && shown.length > 0;

  return (
    <div className="aql">
      <div className="row" style={{ gap: 6 }}>
        <div className="aql-box" style={{ flex: 1 }}>
          <input ref={ref} className={`mono ${error ? 'aql-error' : ''}`} value={text} autoFocus={autoFocus} spellCheck={false}
            placeholder={placeholder ?? (scope === 'testcase' ? 'z. B. priorität >= Kritisch UND label = smoke' : 'z. B. status = Fehlgeschlagen UND zugewiesen = ich()')}
            role="combobox" aria-label="Abfrage" aria-invalid={!!error} aria-describedby={error ? errId : undefined} aria-autocomplete="list"
            aria-expanded={listOpen} aria-controls={listId} aria-activedescendant={listOpen ? `${listId}-${sel}` : undefined}
            onChange={(e) => { setText(e.target.value); onChange?.(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setOpen(true); }}
            onClick={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
            onKeyUp={(e) => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) setCaret((e.target as HTMLInputElement).selectionStart ?? 0); }}
            onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              const n = shown.length;
              if (!open && n && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setOpen(true); return; }
              if (open && n && e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % n); return; }
              if (open && n && e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + n) % n); return; }
              if (open && n && (e.key === 'Tab' || (e.key === 'Enter' && suggestions.partial))) { e.preventDefault(); accept(shown[sel]!); return; }
              if (e.key === 'Escape' && listOpen) { e.stopPropagation(); setOpen(false); return; }
              if (e.key === 'Enter') { e.preventDefault(); submit(); }
            }} />
          <ul className="aql-suggest" role="listbox" id={listId} aria-label="Vorschläge" hidden={!listOpen}>
            {listOpen && shown.map((s, i) => (
              <li key={s} id={`${listId}-${i}`} role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); accept(s); }}>
                <span className="mono">{s}</span>{suggestions.kind === 'field' && <span className="small muted">{findField(s, scope)?.help}</span>}
              </li>
            ))}
          </ul>
        </div>
        <button type="button" className="small" onClick={submit} disabled={!!error}>Suchen</button>
        <button type="button" className="small ghost" onClick={() => setHelp((h) => !h)} aria-expanded={help} aria-label="Felder und Beispiele der Abfragesprache" title="Felder und Beispiele">?</button>
      </div>
      <div id={errId} className={error ? 'small err aql-msg' : 'sr-only'} aria-live="polite">
        {error && <><span className="mono aql-caret" aria-hidden="true">{text.slice(0, error.pos).replace(/./g, ' ')}^</span>{' '}
          <span className="sr-only">Fehler bei Zeichen {error.pos + 1}: </span>{error.message}</>}
      </div>
      {help && <QueryHelp scope={scope} onPick={(q) => { setText(q); setHelp(false); onSubmit(q); }} />}
    </div>
  );
}

function QueryHelp({ scope, onPick }: { scope: Scope; onPick: (q: string) => void }) {
  return (
    <div className="aql-help card"><div className="card-body stack">
      <div className="small">Bedingungen <span className="mono">feld vergleich wert</span>, verknüpft mit <b>UND</b>, <b>ODER</b>, <b>NICHT</b> und Klammern
        (ohne Verknüpfung gilt UND). Vergleiche: <span className="mono">= != ~ (enthält) &lt; &gt; IN (…) IST LEER</span>. Werte mit Leerzeichen in
        Anführungszeichen. Datum: <span className="mono">-7d, -2w, -1m, heute(), 01.10.2026</span>; Person: <span className="mono">ich()</span>.
        Freie Wörter durchsuchen den Text. Sortieren: <span className="mono">SORTIERT NACH feld ABSTEIGEND</span> (bzw. AUFSTEIGEND; kurz AB/AUF).</div>
      <div className="grid2">
        <div><h4>Beispiele</h4><ul className="aql-examples">{AQL_EXAMPLES[scope].map(([q, d]) => (
          <li key={q}><button type="button" className="link mono" onClick={() => onPick(q)}>{q}</button><div className="small muted">{d}</div></li>
        ))}</ul></div>
        <div><h4>Felder</h4><table className="small"><tbody>{fieldsFor(scope).map((f) => (
          <tr key={f.name}><td className="mono fit">{f.name}{f.type === 'custom' || f.type === 'config' ? '.…' : ''}</td><td className="muted">{f.help}</td></tr>
        ))}</tbody></table></div>
      </div>
    </div></div>
  );
}

/** Vorschläge an der Schreibmarke: Feldname, Vergleich, Wert oder Verknüpfung. */
function suggest(text: string, caret: number, scope: Scope, values: Record<string, string[]>): { items: string[]; from: number; kind: 'field' | 'op' | 'value' | 'kw'; partial: boolean } {
  const head = text.slice(0, caret);
  const m = /[^\s()=,~<>!"]*$/.exec(head);
  const word = m ? m[0] : '';
  const from = caret - word.length;
  let toks: ReturnType<typeof tokenize> = [];
  try { toks = tokenize(head.slice(0, from)).filter((t) => t.kind !== 'eof'); } catch { return { items: [], from, kind: 'field', partial: false }; }
  const last = toks.at(-1);
  const prev = toks.at(-2);
  const lc = word.toLowerCase();
  const match = (list: string[]) => list.filter((x) => x.toLowerCase().startsWith(lc) && x.toLowerCase() !== lc);
  // nach einem Vergleich → Werte des Felds
  if (last && (last.kind === 'op' || (last.kind === 'lparen' && prev?.value.toLowerCase() === 'in') || last.kind === 'comma')) {
    const fieldTok = [...toks].reverse().find((t, i, arr) => t.kind === 'word' && (arr[i - 1]?.kind === 'op' || ['in', 'nicht'].includes(arr[i - 1]?.value.toLowerCase() ?? '')));
    const f = fieldTok ? findField(fieldTok.value, scope) : undefined;
    const vals = f ? [...(values[f.name] ?? []), ...(f.values ?? []), ...(f.type === 'user' ? ['ich()'] : []), ...(f.type === 'date' ? ['heute()', '-7d', '-30d'] : []), ...(f.type === 'bool' ? ['ja', 'nein'] : [])] : [];
    const quoted = vals.map((v) => (/[\s(),=~<>!]/.test(v) ? `"${v}"` : v));
    return { items: match([...new Set(quoted)]), from, kind: 'value', partial: !!word };
  }
  // nach einem Feldnamen → Vergleich
  if (last?.kind === 'word' && findField(last.value, scope) && !word && !(prev?.kind === 'op')) {
    return { items: OPS, from, kind: 'op', partial: false };
  }
  // nach einem Wert → Verknüpfung, sonst Feldnamen
  const afterValue = last && (last.kind === 'string' || last.kind === 'rparen' || (last.kind === 'word' && prev?.kind === 'op'));
  if (afterValue && !word) return { items: KEYWORDS, from, kind: 'kw', partial: false };
  if (!word) return { items: [], from, kind: 'field', partial: false };
  const fields = fieldsFor(scope).map((f) => (f.type === 'custom' || f.type === 'config' ? `${f.name}.` : f.name));
  return { items: match([...fields, ...KEYWORDS]), from, kind: 'field', partial: true };
}
