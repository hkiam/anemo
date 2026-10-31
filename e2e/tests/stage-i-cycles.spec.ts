/** Stufe I – Zyklen, Durchführung, Cockpit: Burn-down, Lagebild und Teststatusbericht, Excel-Rundlauf, Fehler je Schritt, Sitzungsfund, Beobachten. */
import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { toast, watchErrors } from './helpers.ts';

test.describe.configure({ mode: 'serial' });
let planId = '';
let cycleId = '';
let execId = '';
let sessionId = '';

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test.beforeAll(async ({ request }) => {
  const plan = await request.post('/api/projects/DEMO/plans', { data: { name: `Stufe I ${Date.now()}`, release: '9.9' } });
  expect(plan.status(), await plan.text()).toBe(201);
  planId = (await plan.json()).id;
  const cycle = await request.post('/api/projects/DEMO/cycles', { data: { name: 'Stufe I – Rundlauf', planId, startDate: day(-3), endDate: day(30) } });
  expect(cycle.status(), await cycle.text()).toBe(201);
  cycleId = (await cycle.json()).id;
  const tcs: string[] = [];
  for (const title of ['Akte anlegen (Stufe I)', 'Akte ablegen (Stufe I)', 'Akte suchen (Stufe I)']) {
    const tc = await request.post('/api/projects/DEMO/test-cases', { data: { content: { title, format: 'CLASSIC', steps: [
      { action: 'Maske öffnen', data: '', expected: 'Maske erscheint' }, { action: 'Speichern', data: '', expected: 'gespeichert' },
    ], labels: [], components: [], sections: [], customFields: {} } } });
    expect(tc.status(), await tc.text()).toBe(201);
    tcs.push((await tc.json()).id);
  }
  expect((await request.post(`/api/cycles/${cycleId}/executions`, { data: { testCaseIds: tcs } })).ok()).toBeTruthy();
  const execs = await (await request.get(`/api/cycles/${cycleId}/executions?limit=10`)).json();
  execId = execs.items[0].id;
  // ein Ergebnis, damit die Linie fällt und ein Tempo entsteht
  const r = await request.post(`/api/executions/${execs.items[1].id}/result`, { data: { status: 'PASS' } });
  expect(r.ok(), await r.text()).toBeTruthy();
  // Sitzung mit Fehler-Beobachtung
  const s = await request.post(`/api/cycles/${cycleId}/sessions`, { data: { charter: 'Erkunde die Ablage, um Datenverluste zu finden', timeboxMinutes: 30 } });
  sessionId = (await s.json()).id;
  expect((await request.post(`/api/sessions/${sessionId}/timer`, { data: { action: 'start' } })).ok()).toBeTruthy();
  expect((await request.post(`/api/sessions/${sessionId}/findings`, { data: { kind: 'bug', text: 'Ablage verliert den Betreff' } })).ok()).toBeTruthy();
});

test('Cockpit: Burn-down gegen geplantes Ende, Lagebild und Teststatusbericht', async ({ page, request }) => {
  const errors = watchErrors(page);
  await page.goto(`/#/p/DEMO/cycles?plan=${planId}&tab=cockpit`);
  await expect(page.getByRole('heading', { name: 'Burn-down gegen geplantes Ende' })).toBeVisible();
  await expect(page.getByTestId('burndown-sentence')).toContainText(/2 offen · Tempo [\d,]+ erledigte je Arbeitstag \(Mittel der letzten 10 Arbeitstage\) · Prognose fertig am \d\d\.\d\d\. – im Plan/);
  await expect(page.locator('.burn-end')).toContainText('Ende');

  await expect(page.getByRole('heading', { name: 'Lagebild (Zwischenbericht)' })).toBeVisible();
  await page.getByRole('button', { name: '✎ Lagebild schreiben' }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Einschätzung, Hindernisse, nächste Schritte' }).fill('Testumgebung stabil; PROJ-123 blockiert die Ablage.');
  await page.getByRole('dialog').getByRole('button', { name: 'Speichern' }).click();
  await expect(toast(page, 'Lagebild gespeichert')).toBeVisible();
  await expect(page.locator('.card', { hasText: 'Lagebild (Zwischenbericht)' })).toContainText('PROJ-123 blockiert die Ablage');

  await page.getByLabel('Berichtszeitraum').selectOption('14');
  const html = page.locator('.status-report-links').getByRole('link', { name: 'HTML' });
  await expect(html).toHaveAttribute('href', new RegExp(`from=${day(-13)}`));
  const r = await request.get((await html.getAttribute('href'))!);
  expect(r.ok()).toBeTruthy();
  const body = await r.text();
  expect(body).toContain('Teststatusbericht');
  expect(body).toContain('PROJ-123 blockiert die Ablage');

  // Berichte-Menü des Testplans
  await page.goto(`/#/p/DEMO/cycles?plan=${planId}`);
  await page.getByRole('button', { name: 'Berichte', exact: true }).click();
  await expect(page.locator('.report-item', { hasText: 'Teststatusbericht (Zwischenbericht)' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Excel-Rundlauf: Ausgabe als Arbeitsmappe, unveränderte Mappe ergibt 0 übernommen', async ({ page, request }, info) => {
  const errors = watchErrors(page);
  await page.goto(`/#/p/DEMO/cycles/${cycleId}`);
  await page.getByRole('button', { name: 'Austausch' }).click();
  await page.getByRole('menuitem', { name: /Excel-Rundlauf/ }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByRole('heading', { name: '1. Ausgeben' })).toBeVisible();
  const href = await dlg.getByRole('link', { name: /Arbeitsmappe herunterladen/ }).getAttribute('href');
  expect(href).toContain('onlyOpen=true');
  const x = await request.get(href!);
  expect(x.ok()).toBeTruthy();
  expect(x.headers()['content-type']).toContain('spreadsheetml');
  const file = info.outputPath('rundlauf.xlsx');
  writeFileSync(file, await x.body());
  await dlg.getByLabel('Ausgefüllte Arbeitsmappe').setInputFiles(file);
  await expect(dlg.getByTestId('offline-summary')).toContainText('Probelauf: 0 übernommen');
  await expect(dlg.getByTestId('offline-summary')).toContainText('0 Fehler');
  await expect(dlg.getByRole('button', { name: 'Übernehmen' })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('Fehler je Schritt: Dialog mit Schweregrad und Schrittbezug; CI ohne GitLab nicht startbar', async ({ page }) => {
  await page.goto(`/#/p/DEMO/cycles/${cycleId}?exec=${execId}`);
  await page.getByRole('button', { name: 'Fehler zu Schritt 2 melden' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel('Schweregrad')).toBeVisible();
  await dlg.getByLabel('Schweregrad').selectOption('Hoch');
  await expect(dlg.getByLabel('Betroffener Schritt')).toHaveValue(/.+/);
  await expect(dlg.getByTestId('defect-target')).toContainText('direktes Anlegen derzeit nicht möglich');
  await dlg.getByRole('button', { name: 'Abbrechen' }).click();

  await page.getByRole('button', { name: 'Austausch' }).click();
  await page.getByRole('menuitem', { name: /CI-Pipeline starten/ }).click();
  await expect(page.getByRole('dialog').locator('.notice.warn')).toContainText('CI-Start nicht möglich');
  await expect(page.getByRole('dialog').getByRole('button', { name: '▶ Pipeline starten' })).toBeDisabled();
});

test('Sitzungsfund: „Als Fehler anlegen“ zeigt den Grund, wenn keine Anbindung besteht', async ({ page }) => {
  await page.goto(`/#/f/DEMO/session/${sessionId}`);
  const li = page.locator('.findings li', { hasText: 'Ablage verliert den Betreff' });
  await li.getByRole('button', { name: '🐞 Als Fehler anlegen' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByLabel('Titel')).toHaveValue('Ablage verliert den Betreff');
  await dlg.getByLabel('Schweregrad').selectOption('Mittel');
  await dlg.getByRole('button', { name: 'Fehler anlegen' }).click();
  await expect(dlg.locator('.error-note')).toBeVisible();
  await expect(li.getByRole('button', { name: '🐞 Als Fehler anlegen' })).toBeVisible();
});

test('Beobachten: Zyklus an und aus', async ({ page }) => {
  await page.goto(`/#/p/DEMO/cycles/${cycleId}`);
  await page.getByRole('button', { name: 'Beobachten', exact: true }).click();
  await expect(toast(page, /Zyklus wird beobachtet/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Beobachtet/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /^Beobachtet/ }).click();
  await expect(toast(page, /nicht mehr beobachtet/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Beobachten/ })).toHaveAttribute('aria-pressed', 'false');
});

test('Freitext-Testfall: Durchführung zeigt die Testanweisung statt Schritten', async ({ page, request }) => {
  const tc = await request.post('/api/projects/DEMO/test-cases', { data: { content: {
    title: 'Freitext: Akte prüfen (Stufe I)', format: 'PLAIN', plainText: 'h3. Ablauf\n* Akte DEMO-T1 öffnen\n* *Betreff* prüfen und Ergebnis notieren',
    steps: [], labels: [], components: [], sections: [], customFields: {},
  } } });
  expect(tc.status(), await tc.text()).toBe(201);
  const tcId = (await tc.json()).id as string;
  expect((await request.post(`/api/cycles/${cycleId}/executions`, { data: { testCaseIds: [tcId] } })).ok()).toBeTruthy();
  const execs = await (await request.get(`/api/cycles/${cycleId}/executions?limit=50`)).json();
  const ex = execs.items.find((e: { testCaseId: string }) => e.testCaseId === tcId);
  await page.goto(`/#/p/DEMO/cycles/${cycleId}?exec=${ex.id}`);
  const instr = page.getByRole('region', { name: 'Testanweisung' });
  await expect(instr).toContainText('Akte DEMO-T1 öffnen');
  await expect(instr.getByRole('heading', { name: 'Ablauf' })).toBeVisible();
  await expect(instr.locator('strong, b', { hasText: 'Betreff' })).toBeVisible();
  await expect(page.locator('table.run-steps')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Gesamtergebnis' })).toBeVisible();
});
