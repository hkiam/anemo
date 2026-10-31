import { expect, test } from '@playwright/test';

test('lange Ausführungsliste: die Seite selbst scrollt nicht (Fenster bleibt im sichtbaren Bereich)', async ({ page, request }) => {
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) {
    ids.push((await (await request.post('/api/projects/DEMO/test-cases', { data: { content: { title: `Scroll ${i} mit etwas längerem Titel, der umbricht`, format: 'CLASSIC',
      steps: [{ action: 'a', data: '', expected: 'b' }], labels: [], components: [], sections: [], customFields: {} } } })).json()).id);
  }
  const cycle = (await (await request.post('/api/projects/DEMO/cycles', { data: { name: 'Lange Liste' } })).json()).id;
  await request.post(`/api/cycles/${cycle}/executions`, { data: { testCaseIds: ids } });
  await page.goto(`/#/p/DEMO/cycles/${cycle}`);
  await expect(page.getByText('Scroll 39 mit etwas')).toBeAttached();
  await page.mouse.move(700, 500);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({ overflow: document.documentElement.scrollHeight - document.documentElement.clientHeight, scrollY: window.scrollY,
    headerTop: document.querySelector('.topbar')!.getBoundingClientRect().top }));
  expect(r.overflow, 'Seite höher als das Fenster').toBeLessThanOrEqual(1);
  expect(r.scrollY).toBe(0);
  expect(r.headerTop, 'Kopfzeile bleibt oben').toBe(0);
});
