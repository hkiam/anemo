/** Testfälle: Ordnerbaum auf-/zuklappbar, verstellbare Spalten – beides persönlich gespeichert. */
import { expect, test } from '@playwright/test';
import { watchErrors } from './helpers.ts';

test.describe.configure({ mode: 'serial' });
const stamp = Date.now().toString(36);
const parentName = `Baum ${stamp}`;
const childName = `Ast ${stamp}`;

test.beforeAll(async ({ request }) => {
  const parent = await (await request.post('/api/projects/DEMO/folders', { data: { name: parentName, parentId: null } })).json();
  const child = await (await request.post('/api/projects/DEMO/folders', { data: { name: childName, parentId: parent.id } })).json();
  await request.post('/api/projects/DEMO/test-cases', { data: { folderId: child.id, content: { title: `Im Ast ${stamp}`, steps: [{ action: 'a', expected: 'b' }] } } });
  // Ausgangslage: alles zugeklappt, Standardbreiten
  await request.put('/api/me/preferences/repo.folders.demo', { data: { value: null } });
  await request.put('/api/me/preferences/layout.repo', { data: { value: null } });
});

// andere Tests sollen die Standardansicht sehen
test.afterAll(async ({ request }) => {
  await request.put('/api/me/preferences/layout.repo', { data: { value: null } });
  await request.put('/api/me/preferences/repo.folders.demo', { data: { value: null } });
});

test('Ordner sind zu Beginn zugeklappt, lassen sich einzeln und alle auf- und zuklappen', async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('anemo.pref.')) localStorage.removeItem(k); });
  await page.goto('/#/p/DEMO/repo');
  const tree = page.getByRole('tree', { name: 'Ordner' });
  const parent = tree.getByRole('treeitem', { name: new RegExp(parentName) });
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  // Gesamtzahl einschließlich Unterordner
  await expect(parent).toHaveAccessibleName(new RegExp(`${parentName}, 1 Testfall`));
  await expect(tree.getByRole('treeitem', { name: new RegExp(childName) })).toHaveCount(0);
  // Tastatur: → klappt auf, ← klappt zu
  await parent.focus();
  await page.keyboard.press('ArrowRight');
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
  await expect(tree.getByRole('treeitem', { name: new RegExp(childName) })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(parent).toHaveAttribute('aria-expanded', 'false');
  // alle auf, alle zu
  await page.getByRole('button', { name: '⊞ Alle auf' }).click();
  await expect(tree.getByRole('treeitem', { name: new RegExp(childName) })).toBeVisible();
  await page.getByRole('button', { name: '⊟ Alle zu' }).click();
  await expect(tree.getByRole('treeitem', { name: new RegExp(childName) })).toHaveCount(0);
  // Ordner über einen Link öffnen: übergeordnete werden aufgeklappt; Zustand bleibt nach dem Neuladen
  const folders = await (await page.request.get('/api/projects/DEMO/folders')).json();
  const child = folders.find((f: { name: string }) => f.name === childName);
  await page.goto(`/#/p/DEMO/repo?folder=${child.id}`);
  await expect(tree.getByRole('treeitem', { name: new RegExp(childName) })).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(900); // Speichern ist gebündelt
  await page.reload();
  await expect(parent).toHaveAttribute('aria-expanded', 'true');
  expect(errors).toEqual([]);
});

test('Spaltenbreiten ziehen, per Tastatur ändern, zurücksetzen – gespeichert je Benutzer', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/#/p/DEMO/repo?tc=DEMO-T1');
  const folderPane = page.locator('.folder-pane');
  const listPane = page.locator('.split > .pane').nth(1);
  await expect(page.locator('.detail-pane')).toBeVisible();
  const before = (await folderPane.boundingBox())!;
  const handle = page.getByRole('separator', { name: 'Breite der Ordnerspalte' });
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + 200);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 120, h.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await folderPane.boundingBox())!.width)).toBeGreaterThan(before.width + 100);
  // Liste per Tastatur schmaler
  const listBefore = (await listPane.boundingBox())!.width;
  await page.getByRole('separator', { name: 'Breite der Testfallliste' }).focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => (await listPane.boundingBox())!.width).toBeLessThan(listBefore - 40);
  await page.waitForTimeout(900);
  const saved = await (await page.request.get('/api/me/preferences/layout.repo')).json();
  expect(saved.value.folders).toBeGreaterThan(before.width + 100);
  expect(saved.value.list).toBeGreaterThan(200);
  await page.reload();
  await expect.poll(async () => Math.round((await folderPane.boundingBox())!.width)).toBe(saved.value.folders);
  // Doppelklick = Standardbreite; Ordnerspalte aus- und wieder einblenden
  await handle.dblclick();
  await expect.poll(async () => Math.round((await folderPane.boundingBox())!.width)).toBe(Math.round(before.width));
  await page.getByRole('button', { name: 'Ordnerspalte ausblenden' }).click();
  await expect(page.getByRole('tree', { name: 'Ordner' })).toBeHidden();
  await page.getByRole('button', { name: 'Ordner einblenden' }).click();
  await expect(page.getByRole('tree', { name: 'Ordner' })).toBeVisible();
  expect(errors).toEqual([]);
});
