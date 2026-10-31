/** Erzeugt aus der Feature-Datei je Szenario einen Playwright-Test; Tags (@TTT-T2) stehen im Testnamen. */
import { readFileSync } from 'node:fs';
import { test } from '@playwright/test';
import { parseFeature } from '../bdd/gherkin.ts';
import { runStep } from '../bdd/steps.ts';

const feature = parseFeature(readFileSync(new URL('../features/spiel.feature', import.meta.url), 'utf8'));

test.describe(feature.name, () => {
  for (const s of feature.scenarios) {
    test(`${s.name} ${s.tags.filter((t) => /-T\d+$/.test(t)).join(' ')}`.trim(), async ({ page }) => {
      for (const step of s.steps) await test.step(step, () => runStep(page, step));
    });
  }
});
