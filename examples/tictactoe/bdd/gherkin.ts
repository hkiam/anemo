/**
 * Minimaler Gherkin-Leser (deutsch/englisch) für das Beispiel: Funktionalität, Grundlage, Szenario,
 * Szenariogrundriss mit Beispielen, Tags. Für echte Projekte eignen sich playwright-bdd oder Cucumber.js –
 * hier soll man in wenigen Zeilen sehen, wie Gherkin zu ausführbaren Tests wird.
 */
export interface Scenario { name: string; tags: string[]; steps: string[] }
export interface Feature { name: string; tags: string[]; scenarios: Scenario[] }

const KW = {
  feature: /^(Funktionalität|Funktion|Feature):\s*(.*)$/,
  background: /^(Grundlage|Hintergrund|Background):/,
  scenario: /^(Szenario|Beispiel|Scenario|Example):\s*(.*)$/,
  outline: /^(Szenariogrundriss|Szenarien|Scenario Outline|Scenario Template):\s*(.*)$/,
  examples: /^(Beispiele|Examples):/,
  step: /^(Angenommen|Gegeben sei|Wenn|Dann|Und|Aber|Given|When|Then|And|But)\s+(.*)$/,
};

export function parseFeature(text: string): Feature {
  const feature: Feature = { name: '', tags: [], scenarios: [] };
  let background: string[] = [];
  let current: (Scenario & { outline?: boolean; examples?: string[][] }) | null = null;
  let tags: string[] = [];
  let target: 'background' | 'scenario' | 'examples' | null = null;
  const finish = () => {
    if (!current) return;
    if (current.outline) {
      const [head, ...rows] = current.examples ?? [];
      rows.forEach((row, i) => feature.scenarios.push({
        name: `${current!.name} (${i + 1})`, tags: current!.tags,
        steps: [...background, ...current!.steps.map((s) => s.replace(/<([^>]+)>/g, (_, k: string) => row[head!.indexOf(k)] ?? `<${k}>`))],
      }));
    } else feature.scenarios.push({ name: current.name, tags: current.tags, steps: [...background, ...current.steps] });
    current = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('@')) { tags.push(...line.split(/\s+/)); continue; }
    let m;
    if ((m = KW.feature.exec(line))) { feature.name = m[2]!; feature.tags = tags; tags = []; target = null; }
    else if (KW.background.test(line)) { target = 'background'; }
    else if ((m = KW.outline.exec(line))) { finish(); current = { name: m[2]!, tags: [...feature.tags, ...tags], steps: [], outline: true, examples: [] }; tags = []; target = 'scenario'; }
    else if ((m = KW.scenario.exec(line))) { finish(); current = { name: m[2]!, tags: [...feature.tags, ...tags], steps: [] }; tags = []; target = 'scenario'; }
    else if (KW.examples.test(line)) { target = 'examples'; }
    else if (line.startsWith('|') && target === 'examples' && current) current.examples!.push(line.slice(1, -1).split('|').map((c) => c.trim()));
    else if ((m = KW.step.exec(line))) {
      if (target === 'background') background.push(line);
      else current?.steps.push(line);
    }
  }
  finish();
  return feature;
}
