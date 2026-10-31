/**
 * Darstellung aller Ansichten je Bildschirmgröße (Projekte desktop/laptop/mobile): keine Laufzeitfehler, kein
 * seitlicher Überlauf (auch nicht innerhalb von Tabellen, solange Platz wäre), Bedienelemente erreichbar und
 * ausreichend groß, Schrift lesbar, keine schweren Barrierefreiheitsverstöße (axe-core, WCAG 2 A/AA). Screenshots landen im Bericht und unter e2e/.state/shots zur
 * Sichtprüfung.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { STATE, watchErrors } from './helpers.ts';

interface Ids { cycle: string; exec: string; plan: string; session: string }
let ids: Ids;

test.beforeAll(async ({ request }) => {
  const cycles = await (await request.get('/api/projects/DEMO/cycles?limit=1')).json();
  const cycle = cycles.items[0].id as string;
  const execs = await (await request.get(`/api/cycles/${cycle}/executions?limit=1`)).json();
  const plans = await (await request.get('/api/projects/DEMO/plans')).json();
  const sessions = await (await request.get(`/api/cycles/${cycle}/sessions`)).json();
  const session = sessions[0]?.id ?? (await (await request.post(`/api/cycles/${cycle}/sessions`, { data: { charter: 'Layoutprüfung: Sitzung erkunden', timeboxMinutes: 30 } })).json()).id;
  ids = { cycle, exec: execs.items[0].id, plan: plans[0].id, session };
});

const PAGES: [string, (i: Ids) => string][] = [
  ['start', () => '/#/p/DEMO/start'],
  ['testfaelle', () => '/#/p/DEMO/repo'],
  ['testfaelle-abfrage', () => '/#/p/DEMO/repo?aql=priorit%C3%A4t%20%3E%3D%20Schwer'],
  ['ausfuehrungen-suche', () => '/#/p/DEMO/cycles?view=search&aql=kategorie%20%3D%20offen'],
  ['admin-felder', () => '/#/admin/fields'],
  ['testfall-detail', () => '/#/p/DEMO/repo?tc=DEMO-T1'],
  ['planung', () => '/#/p/DEMO/cycles'],
  ['testplan', (i) => `/#/p/DEMO/cycles?plan=${i.plan}`],
  ['matrix', (i) => `/#/p/DEMO/cycles?plan=${i.plan}&tab=matrix`],
  ['cockpit', (i) => `/#/p/DEMO/cycles?plan=${i.plan}&tab=cockpit`],
  ['zyklus', (i) => `/#/p/DEMO/cycles/${i.cycle}`],
  ['zyklus-ausfuehrung', (i) => `/#/p/DEMO/cycles/${i.cycle}?exec=${i.exec}`],
  ['mir-zugewiesen', () => '/#/p/DEMO/cycles?view=mine'],
  ['protokoll', () => '/#/p/DEMO/cycles?view=audit'],
  ['freigaben', () => '/#/p/DEMO/cycles?view=reviews'],
  ['test-health', () => '/#/p/DEMO/health'],
  ['portfolio', () => '/#/portfolio'],
  ['suche', () => '/#/search?q=Akte'],
  ['hilfe', () => '/#/hilfe'],
  ['admin-benutzer', () => '/#/admin/users'],
  ['admin-gruppen', () => '/#/admin/groups'],
  ['admin-projekte', () => '/#/admin/projects'],
  ['admin-workflow', () => '/#/admin/workflow'],
  ['admin-integrationen', () => '/#/admin/integrations'],
  ['admin-einstellungen', () => '/#/admin/settings'],
  ['admin-anmeldung', () => '/#/admin/auth'],
  ['admin-email', () => '/#/admin/mail'],
  ['admin-webhooks', () => '/#/admin/webhooks'],
  ['admin-openproject', () => '/#/admin/openproject'],
  ['admin-gitlab', () => '/#/admin/gitlab'],
  ['admin-jira', () => '/#/admin/jira'],
  ['admin-automation', () => '/#/admin/automation'],
  ['admin-fehlervorlagen', () => '/#/admin/templates'],
  ['admin-feldvorlagen', () => '/#/admin/field-templates'],
  ['admin-ki', () => '/#/admin/ai'],
  ['admin-berichte', () => '/#/admin/reports'],
  ['admin-konfigurationen', () => '/#/configurations'],
  ['projekte-uebertragen', () => '/#/transfer'],
  ['admin-projekte-uebertragen', () => '/#/admin/transfers'],
  ['admin-migration', () => '/#/migration'],
  ['admin-ereignisse', () => '/#/events'],
  ['fokus-durchfuehrung', (i) => `/#/f/DEMO/run/${i.exec}`],
  ['fokus-testfall', () => '/#/f/DEMO/testcase/DEMO-T1'],
  ['fokus-testplan', (i) => `/#/f/DEMO/plan/${i.plan}`],
  ['fokus-zyklus', (i) => `/#/f/DEMO/cycle/${i.cycle}`],
  ['fokus-sitzung', (i) => `/#/f/DEMO/session/${i.session}`],
  ['testfall-editor', () => '/#/f/DEMO/testcase/new'],
];

/**
 * axe-Regeln, die hier nachweislich Fehlalarme liefern. Echte Verstöße werden nicht abgeschaltet – auch nicht für
 * Seiten, die noch überarbeitet werden; sie erscheinen als weiche Fehler im Bericht.
 */
const AXE_FALSE_POSITIVES: Record<string, string> = {
};

/** Schwere axe-Verstöße (serious/critical) als lesbare Zeilen: Regel, Kurzbeschreibung, betroffene Elemente. */
async function axeViolations(page: Page): Promise<{ lines: string[]; raw: unknown }> {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).disableRules(Object.keys(AXE_FALSE_POSITIVES)).analyze();
  const serious = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const lines = serious.flatMap((v) => v.nodes.slice(0, 8).map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} – ${(n.failureSummary ?? v.help).split('\n').slice(0, 2).join(' ').slice(0, 220)}`));
  return { lines, raw: serious.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target, html: n.html.slice(0, 200), summary: n.failureSummary })) })) };
}

/** Messung im Browser: Überlauf, zu kleine Schrift, zu kleine oder abgeschnittene Bedienelemente. */
async function measure(page: Page, mobile: boolean) {
  return page.evaluate((mobile) => {
    const vw = window.innerWidth;
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
    };
    const label = (e: Element) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : ''} „${(e.textContent || (e as HTMLInputElement).placeholder || e.getAttribute('aria-label') || '').trim().slice(0, 40)}“`;
    const overflowX = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw;
    const controls = [...document.querySelectorAll('button, a.btn, select, input:not([type=checkbox]):not([type=radio]):not([type=file]):not([hidden]), textarea')].filter(visible);
    const minH = mobile ? 30 : 22;
    const small = controls.filter((e) => e.getBoundingClientRect().height < minH && !e.closest('.wiki-toolbar, .we-toolbar')).map(label);
    // Bedienelemente, die rechts aus dem sichtbaren Bereich ragen, ohne in einem scrollbaren Container zu liegen
    const clipped = controls.filter((e) => {
      const r = e.getBoundingClientRect();
      if (r.right <= vw + 1) return false;
      for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return false; }
      return true;
    }).map(label);
    // Bereiche, die seitlich scrollen, obwohl Platz wäre: Tabellen auf dem Desktop nie, andere nur bei freiem Platz daneben
    const squeezed = mobile ? [] : [...document.querySelectorAll('body *')].filter((e) => {
      const s = getComputedStyle(e);
      if ((s.overflowX !== 'auto' && s.overflowX !== 'scroll') || e.scrollWidth - e.clientWidth <= 2 || !visible(e)) return false;
      return e.matches('.table-wrap') || vw - e.getBoundingClientRect().right > 40;
    }).map((e) => `${label(e).slice(0, 80)}: ${e.scrollWidth - e.clientWidth}px verdeckt`);
    const tiny: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.textContent?.trim() || !visible(el)) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 11.5) tiny.push(`${fs}px ${label(el)}`);
    }
    return { overflowX, small: [...new Set(small)], clipped: [...new Set(clipped)], squeezed: [...new Set(squeezed)], tiny: [...new Set(tiny)] };
  }, mobile);
}

for (const [name, path] of PAGES) {
  test(`Darstellung: ${name}`, async ({ page }, info) => {
    const mobile = (page.viewportSize()?.width ?? 1440) < 700;
    const errors = watchErrors(page);
    await page.goto(path(ids));
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/Lädt\s?…/).filter({ visible: true })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('.error-note')).toHaveCount(0);
    const shot = await page.screenshot({ fullPage: false, path: `${STATE}shots/${info.project.name}/${name}.png` });
    await info.attach(name, { body: shot, contentType: 'image/png' });
    const m = await measure(page, mobile);
    await info.attach('messung', { body: JSON.stringify(m, null, 2), contentType: 'application/json' });
    expect.soft(errors, 'Laufzeitfehler').toEqual([]);
    expect.soft(m.overflowX, 'seitlicher Überlauf der Seite (px)').toBeLessThanOrEqual(1);
    // nur die Bereiche innen scrollen – die Seite selbst nie (sonst lässt sie sich per Mausrad aus dem Fenster schieben)
    const overflowY = await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);
    expect.soft(overflowY, 'Seite höher als das Fenster (px)').toBeLessThanOrEqual(1);
    expect.soft(m.clipped, 'abgeschnittene Bedienelemente').toEqual([]);
    expect.soft(m.squeezed, 'seitlich scrollende Tabellen/Bereiche, obwohl Platz wäre').toEqual([]);
    expect.soft(m.tiny, 'Schrift kleiner als 11,5 px').toEqual([]);
    expect.soft(m.small, `Bedienelemente niedriger als ${mobile ? 30 : 22} px`).toEqual([]);
    const axe = await axeViolations(page);
    await info.attach('axe', { body: JSON.stringify(axe.raw, null, 2), contentType: 'application/json' });
    expect.soft(axe.lines, 'Barrierefreiheit (axe, WCAG 2 A/AA, serious/critical)').toEqual([]);
  });
}
