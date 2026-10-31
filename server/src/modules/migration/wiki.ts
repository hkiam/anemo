/**
 * Zerlegt Jira-Wiki-Beschreibungen in Panels. In der Discovery zeigte sich, dass Tests eine
 * Panel-Konvention nutzen (Allgemein, Fokus/Abgrenzung, Vorbedingungen, Technisches, Automation,
 * Testhinweise, Dokumentation). Bekannte Panels werden strukturiert übernommen, alle anderen als
 * benannte Abschnitte – nichts geht verloren.
 */

export interface WikiPanel {
  title: string;
  content: string;
}

export interface ParsedDescription {
  objective: string | null;
  preconditions: string | null;
  testData: string | null;
  sections: { title: string; content: string }[];
  /** Panels, die keinen Inhalt haben (leere Vorlagenabschnitte) – nur zur Info im Mapping-Bericht. */
  emptyPanels: string[];
}

const PANEL_RE = /\{panel(?::([^}]*))?\}([\s\S]*?)\{panel\}/gi;

/** Panel-Titel bereinigen: Bilder (!url!), Fett (*…*), Farben und Leerraum entfernen. */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/![^!\s]+!/g, '')
    .replace(/\{color[^}]*\}/g, '')
    .replace(/[*_+]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function panelTitle(params: string | undefined): string {
  if (!params) return '';
  for (const part of params.split('|')) {
    const [k, ...v] = part.split('=');
    if (k?.trim().toLowerCase() === 'title') return cleanTitle(v.join('='));
  }
  return '';
}

export function splitPanels(text: string): { panels: WikiPanel[]; rest: string } {
  const panels: WikiPanel[] = [];
  const rest = text.replace(PANEL_RE, (_m, params: string | undefined, body: string) => {
    panels.push({ title: panelTitle(params), content: body.trim() });
    return '\n';
  });
  return { panels, rest: rest.replace(/\n{3,}/g, '\n\n').trim() };
}

const ROLE_BY_TITLE: [RegExp, 'objective' | 'preconditions' | 'testData'][] = [
  [/^(allgemein|beschreibung|ziel|testziel|description|objective)$/i, 'objective'],
  [/^(vorbedingung(en)?|voraussetzung(en)?|preconditions?)$/i, 'preconditions'],
  [/^(testdaten|test data)$/i, 'testData'],
];

/** Titelvarianten aus gewachsenen Vorlagen auf einen kanonischen Abschnittsnamen abbilden (aus dem Pilotprojekt). */
const CANONICAL_SECTION: [RegExp, string][] = [
  [/^(test)?fokus\s*(\/|und)?\s*(test)?abgrenzung$|^testfokus$/i, 'Fokus / Abgrenzung'],
  [/^automation\b.*|^automatisierung\b.*/i, 'Automation'],
  [/^technische?s?(\s+informationen)?$/i, 'Technisches'],
  [/^testhinweise?$|^hinweise?$/i, 'Testhinweise'],
];

export function canonicalSectionTitle(title: string): string {
  return CANONICAL_SECTION.find(([re]) => re.test(title.trim()))?.[1] ?? title;
}

export function parseDescription(text: string | null | undefined): ParsedDescription {
  const result: ParsedDescription = { objective: null, preconditions: null, testData: null, sections: [], emptyPanels: [] };
  if (!text?.trim()) return result;
  const { panels, rest } = splitPanels(text);
  const append = (field: 'objective' | 'preconditions' | 'testData', value: string) => {
    result[field] = result[field] ? `${result[field]}\n\n${value}` : value;
  };
  for (const p of panels) {
    if (!p.content) {
      result.emptyPanels.push(p.title || '(ohne Titel)');
      continue;
    }
    const role = ROLE_BY_TITLE.find(([re]) => re.test(p.title))?.[1];
    if (role) append(role, p.content);
    else {
      const title = canonicalSectionTitle(p.title || 'Abschnitt');
      const existing = result.sections.find((x) => x.title === title);
      if (existing) existing.content += `\n\n${p.content}`;
      else result.sections.push({ title, content: p.content });
    }
  }
  if (rest) {
    // Freitext außerhalb der Panels: ohne Panels ist es die Beschreibung, sonst ein eigener Abschnitt.
    if (panels.length === 0) append('objective', rest);
    else result.sections.push({ title: 'Weitere Angaben', content: rest });
  }
  return result;
}
