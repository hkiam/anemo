/**
 * Kleine, logikfreie Vorlagensprache für Fehlermeldungen (Mustache-Teilmenge):
 * {{pfad}}, {{pfad|kurz}} (erste Zeile, max. 80 Zeichen), {{#pfad}}…{{/pfad}} (nur wenn gefüllt),
 * {{^pfad}}…{{/pfad}} (nur wenn leer). Keine Ausdrücke, keine Schleifen – Vorlagen bleiben harmlos.
 */
import { wikiSummary } from '../../../../shared/wiki/text.ts';

export type TemplateData = Record<string, unknown>;

function lookup(data: TemplateData, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), data);
}

const filled = (v: unknown) => v !== undefined && v !== null && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0);

/** Kurztext: erste aussagekräftige Zeile als reiner Text (Formatierung, Farben, Makros entfernt), höchstens 80 Zeichen. */
const short = (s: string) => wikiSummary(s, 80);

/**
 * Ticket-Titel sind reiner Text: Mehrfach-Leerraum und leere Trenner („ – “ am Rand oder doppelt) entfernen, höchstens
 * 255 Zeichen (Grenze in OpenProject und Jira).
 */
export function plainTitle(s: string): string {
  const t = s.replace(/\s+/g, ' ').replace(/(\s[–-]\s*){2,}/g, ' – ').replace(/^\s*[–-]\s+|\s+[–-]\s*$/g, '').replace(/\]\s+[–-]\s+/, '] ').trim();
  return t.length > 255 ? `${t.slice(0, 254).trimEnd()}…` : t;
}

export function renderTemplate(template: string, data: TemplateData): string {
  // Abschnitte zuerst (von innen nach außen)
  let out = template;
  const SECTION = /\{\{([#^])\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/;
  for (let guard = 0; guard < 100; guard++) {
    const m = SECTION.exec(out);
    if (!m) break;
    const show = m[1] === '#' ? filled(lookup(data, m[2]!)) : !filled(lookup(data, m[2]!));
    out = out.slice(0, m.index) + (show ? m[3]! : '') + out.slice(m.index + m[0].length);
  }
  out = out.replace(/\{\{\s*([\w.]+)\s*(?:\|\s*(kurz))?\s*\}\}/g, (_, path: string, filter?: string) => {
    const v = lookup(data, path);
    const s = v === undefined || v === null ? '' : String(v);
    return filter === 'kurz' ? short(s) : s;
  });
  // durch leere Abschnitte entstandene Mehrfach-Leerzeilen zusammenziehen
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
