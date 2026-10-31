/**
 * Schrittdefinitionen: ein regulärer Ausdruck je Formulierung, dahinter Playwright. Angesprochen wird die
 * Oberfläche wie von Menschen – über Rollen und sichtbare Namen (getByRole), nicht über CSS-Klassen.
 * So bleiben Tests stabil, und dieselben Namen nutzen auch KI-Agenten (Playwright MCP) zur Orientierung.
 */
import { expect, type Page } from '@playwright/test';

type Step = { re: RegExp; run: (page: Page, ...args: string[]) => Promise<void> };
const steps: Step[] = [];
const Schritt = (re: RegExp, run: Step['run']) => steps.push({ re, run });
const Q = '["„“]'; // gerade oder deutsche Anführungszeichen
const feld = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}(: [XO])?$`) });
const liste = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

Schritt(/^ein neues Spiel ist geöffnet$/, async (page) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Tic-Tac-Toe' })).toBeVisible();
});
Schritt(new RegExp(`^ich ${Q}(.+?)${Q} wähle$`), async (page, name) => {
  await (name === 'Neues Spiel' ? page.getByRole('button', { name }) : feld(page, name!)).click();
});
Schritt(/^X die Felder (.+) und O die Felder (.+) wählen$/, async (page, x, o) => {
  const xs = liste(x!), os = liste(o!);
  for (let i = 0; i < xs.length; i++) {
    await feld(page, xs[i]!).click();
    if (os[i]) await feld(page, os[i]!).click();
  }
});
Schritt(new RegExp(`^steht ${Q}(.+?)${Q} im Status$`), async (page, text) => {
  await expect(page.getByRole('status')).toHaveText(text!);
});
Schritt(/^alle 9 Felder sind leer$/, async (page) => {
  const felder = page.getByRole('grid', { name: 'Spielbrett' }).getByRole('button');
  await expect(felder).toHaveCount(9);
  for (const f of await felder.all()) await expect(f).toHaveText('');
});
Schritt(new RegExp(`^zeigt ${Q}(.+?)${Q} ein ${Q}([XO])${Q}$`), async (page, name, zeichen) => {
  await expect(feld(page, name!)).toHaveText(zeichen!);
});
Schritt(new RegExp(`^ist ${Q}(.+?)${Q} nicht mehr wählbar$`), async (page, name) => {
  await expect(feld(page, name!)).toBeDisabled();
});
Schritt(/^sind die Gewinnfelder (.+) markiert$/, async (page, namen) => {
  for (const n of liste(namen!)) await expect(feld(page, n)).toHaveClass(/gewinn/);
});
Schritt(/^sind alle freien Felder gesperrt$/, async (page) => {
  for (const f of await page.getByRole('grid', { name: 'Spielbrett' }).getByRole('button').all()) await expect(f).toBeDisabled();
});

/** Führt einen Gherkin-Schritt aus; unbekannte Formulierungen schlagen mit einer klaren Meldung fehl. */
export async function runStep(page: Page, line: string): Promise<void> {
  const text = line.replace(/^(Angenommen|Gegeben sei|Wenn|Dann|Und|Aber|Given|When|Then|And|But)\s+/, '');
  for (const s of steps) {
    const m = s.re.exec(text);
    if (m) return s.run(page, ...m.slice(1));
  }
  throw new Error(`Kein Schritt definiert für: „${text}“ – in bdd/steps.ts ergänzen (oder vom KI-Agenten vorschlagen lassen)`);
}
