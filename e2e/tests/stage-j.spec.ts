import { expect, test } from '@playwright/test';
import { toast } from './helpers.ts';

test('J4: aus der Durchführung den Testfall ansehen (Fassung der Ausführung) und im eigenen Fenster bearbeiten', async ({ page, context, request }) => {
  const created = await (await request.post('/api/projects/DEMO/test-cases', { data: { content: { title: 'J4 Testfall', format: 'CLASSIC',
    steps: [{ action: 'Öffnen', data: '', expected: 'Offen' }], labels: [], components: [], sections: [], customFields: {} } } })).json();
  const key = created.key as string;
  const cycle = (await (await request.post('/api/projects/DEMO/cycles', { data: { name: 'J4 Testfall aus Durchführung' } })).json()).id;
  await request.post(`/api/cycles/${cycle}/executions`, { data: { testCaseIds: [created.id] } });
  const exec = (await (await request.get(`/api/cycles/${cycle}/executions`)).json()).items[0].id;
  await page.goto(`/#/p/DEMO/cycles/${cycle}?exec=${exec}`);
  const tc = await (await request.get(`/api/test-cases/${key}`)).json();

  await page.getByRole('button', { name: 'Testfall', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: `Testfall ${key}` });
  await expect(dlg.getByLabel('Angezeigte Version')).toHaveValue(String(tc.currentVersion));
  await dlg.getByRole('button', { name: 'Schließen' }).first().click();

  const [win] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: 'Testfall bearbeiten' }).click()]);
  await expect(win).toHaveURL(new RegExp(`#/f/DEMO/testcase/${key}`));
  await win.getByLabel('Titel').fill(`${tc.version.title} (geändert)`);
  await win.getByRole('button', { name: 'Speichern', exact: true }).first().click();
  await expect(toast(page, new RegExp(`neue Fassung v${tc.currentVersion + 1} gespeichert – diese Ausführung bleibt bei v${tc.currentVersion}`))).toBeVisible();
  await expect(page.getByText(`bezieht sich auf v${tc.currentVersion}`)).toBeVisible();
});

test('J1: Abschnitte – im Testfall auf-/zuklappen, im Editor anlegen, in der Durchführung ohne Bewertung mit Fortschritt', async ({ page, request }) => {
  const created = await (await request.post('/api/projects/DEMO/test-cases', { data: { content: { title: 'J1 Abschnitte', format: 'CLASSIC', steps: [
    { kind: 'group', title: 'Einstellungen', action: '', data: '', expected: '' },
    { action: 'Option A setzen', data: '', expected: 'A gesetzt' },
    { action: 'Option B setzen', data: '', expected: 'B gesetzt' },
    { kind: 'group', title: 'Test durchführen', action: '', data: '', expected: '' },
    { action: 'Akte J1 öffnen', data: '', expected: 'Akte offen' },
  ], labels: [], components: [], sections: [], customFields: {} } } })).json();
  await page.goto(`/#/p/DEMO/repo?tc=${created.key}`);
  const toggle = page.getByRole('button', { name: 'Einstellungen' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Option A setzen')).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Option A setzen')).toHaveCount(0);
  await expect(page.getByText('Akte J1 öffnen')).toBeVisible();
  await page.getByRole('button', { name: 'Alle Abschnitte aufklappen' }).click();
  await expect(page.getByText('Option A setzen')).toBeVisible();

  // Editor: Abschnitt hinzufügen und benennen
  await page.locator('.detail-head').getByRole('button', { name: 'Bearbeiten' }).click();
  await page.getByRole('button', { name: '§ Abschnitt' }).click();
  await page.getByLabel('Name des Abschnitts').last().fill('Aufräumen');
  await page.getByRole('button', { name: '+ Schritt' }).click();
  await page.getByRole('textbox', { name: 'Aktion 4', exact: true }).fill('Akte schließen');
  await page.getByRole('button', { name: 'Speichern', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Aufräumen', exact: true })).toHaveAttribute('aria-expanded', 'true');

  // Durchführung: Abschnitt ohne Statusknöpfe, Fortschritt, Nummern nur für Prüfschritte
  const cycle = (await (await request.post('/api/projects/DEMO/cycles', { data: { name: 'J1 Abschnitte' } })).json()).id;
  await request.post(`/api/cycles/${cycle}/executions`, { data: { testCaseIds: [created.id] } });
  const exec = (await (await request.get(`/api/cycles/${cycle}/executions`)).json()).items[0].id;
  await page.goto(`/#/p/DEMO/cycles/${cycle}?exec=${exec}`);
  const groupRow = page.locator('tr.step-group', { hasText: 'Einstellungen' });
  await expect(groupRow.getByText('0/2 erledigt')).toBeVisible();
  await expect(groupRow.getByRole('group')).toHaveCount(0);
  await page.getByRole('group', { name: 'Status Schritt 1' }).getByRole('button', { name: 'Bestanden' }).click();
  await expect(groupRow.getByText('1/2 erledigt')).toBeVisible();
  // nach der Bearbeitung: 4 Prüfschritte in 3 Abschnitten
  await expect(page.getByRole('group', { name: 'Status Schritt 4' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Status Schritt 5' })).toHaveCount(0);
  await expect(page.locator('tr.step-group')).toHaveCount(3);
});

test('J2: begonnene Ausführung bleibt bei ihrer Fassung und lässt sich mit Vorschau umstellen', async ({ page, request }) => {
  const created = await (await request.post('/api/projects/DEMO/test-cases', { data: { content: { title: 'J2 Versionstreue', format: 'CLASSIC', steps: [
    { action: 'Maske J2 öffnen', data: '', expected: 'offen' }, { action: 'Knopf A drücken', data: '', expected: 'A' },
  ], labels: [], components: [], sections: [], customFields: {} } } })).json();
  const cycle = (await (await request.post('/api/projects/DEMO/cycles', { data: { name: 'J2 Versionstreue' } })).json()).id;
  await request.post(`/api/cycles/${cycle}/executions`, { data: { testCaseIds: [created.id] } });
  const exec = (await (await request.get(`/api/cycles/${cycle}/executions`)).json()).items[0].id;
  const ids = (await (await request.get(`/api/executions/${exec}`)).json()).steps.map((s: { id: string }) => s.id);
  await request.post(`/api/executions/${exec}/result`, { data: { status: 'WIP', stepResults: [{ stepId: ids[0], status: 'PASS' }, { stepId: ids[1], status: 'FAIL', comment: 'Knopf A fehlt' }] } });
  const tc = await (await request.get(`/api/test-cases/${created.id}`)).json();
  await request.put(`/api/test-cases/${created.id}/content`, { data: { content: { ...tc.version, steps: [tc.version.steps[0], { ...tc.version.steps[1], action: 'Knopf B drücken' }] } } });

  await page.goto(`/#/p/DEMO/cycles/${cycle}?exec=${exec}`);
  await expect(page.getByText('Knopf A drücken')).toBeVisible();
  await page.getByRole('button', { name: 'Auf v2 umstellen …' }).click();
  const dlg = page.getByRole('dialog', { name: /Auf Fassung v2 umstellen/ });
  await expect(dlg.getByText('1 bleiben')).toBeVisible();
  await expect(dlg.getByText('1 wieder offen')).toBeVisible();
  await dlg.getByRole('button', { name: 'Umstellen' }).click();
  await expect(page.getByText('Knopf B drücken')).toBeVisible();
  await expect(page.getByText('vor Umstellung (v1):')).toBeVisible();
});

test('J3: wer hat welche Zelle wann geändert – Markierung, Verlauf, Hervorhebung seit Version', async ({ page, request }) => {
  const created = await (await request.post('/api/projects/DEMO/test-cases', { data: { content: { title: 'J3 Zellhistorie', format: 'CLASSIC', steps: [
    { action: 'Zelle J3', data: '', expected: 'alt' }, { action: 'Unverändert J3', data: '', expected: 'bleibt' },
  ], labels: [], components: [], sections: [], customFields: {} } } })).json();
  const tc = await (await request.get(`/api/test-cases/${created.id}`)).json();
  await request.put(`/api/test-cases/${created.id}/content`, { data: { content: { ...tc.version, steps: [{ ...tc.version.steps[0], expected: 'neu' }, tc.version.steps[1]] } } });
  await page.goto(`/#/p/DEMO/repo?tc=${created.key}`);
  const meta = page.getByRole('button', { name: /^Erwartetes Ergebnis Schritt 1: zuletzt geändert .* \(v2\) · 2 Fassungen/ });
  await meta.focus();
  await expect(meta).toBeVisible();
  await meta.click();
  const dlg = page.getByRole('dialog', { name: 'Verlauf: Erwartetes Ergebnis Schritt 1' });
  await expect(dlg.locator('ol.cell-history > li')).toHaveCount(2);
  await expect(dlg.getByText('neu')).toBeVisible();
  await dlg.getByRole('button', { name: 'Schließen' }).first().click();
  await page.getByLabel('Geänderte Zellen hervorheben seit Version').selectOption('1');
  await expect(page.locator('td.cell-changed')).toHaveCount(1);
});

test('J5: Feldvorlagen – Verwaltung, im Editor per 📋 einfügen', async ({ page, request }) => {
  const t = await (await request.post('/api/field-templates', { data: { name: 'J5 Prüfliste', fields: ['expected'], content: '* Prüfung J5 erfüllt', project: 'DEMO' } })).json();
  await page.goto('/#/admin/field-templates');
  await expect(page.getByRole('cell', { name: 'Vorbedingung / Vorgehen', exact: true })).toBeVisible();
  await page.goto('/#/p/DEMO/repo');
  await page.getByRole('button', { name: '+ Testfall' }).click();
  const field = page.getByRole('textbox', { name: 'Erwartung 1', exact: true });
  await field.click();
  await page.getByRole('toolbar', { name: 'Formatierung Erwartung 1' }).getByRole('button', { name: /Vorlage einfügen/ }).click();
  await page.getByRole('menu', { name: 'Vorlagen für Erwartung 1' }).getByRole('menuitem', { name: /J5 Prüfliste/ }).click();
  await expect(field).toContainText('Prüfung J5 erfüllt');
  await page.getByRole('textbox', { name: 'Aktion 1', exact: true }).click();
  await page.getByRole('toolbar', { name: 'Formatierung Aktion 1' }).getByRole('button', { name: /Vorlage einfügen/ }).click();
  await page.getByRole('menu', { name: 'Vorlagen für Aktion 1' }).getByRole('menuitem', { name: /^Vorbedingung \/ Vorgehen · System$/ }).click();
  await expect(page.getByRole('textbox', { name: 'Aktion 1', exact: true })).toContainText('Vorbedingung');
  await request.delete(`/api/field-templates/${t.id}`);
});

test('Dauerhafte Links /go/…: Testfall und Ausführung öffnen die richtige Ansicht', async ({ page, request }) => {
  await page.goto('/go/testfall/DEMO-T1');
  await expect(page).toHaveURL(/#\/p\/DEMO\/repo\?tc=DEMO-T1/);
  const cycle = (await (await request.post('/api/projects/DEMO/cycles', { data: { name: 'Go-Link' } })).json()).id;
  const tc = (await (await request.get('/api/test-cases/DEMO-T1')).json()).id;
  await request.post(`/api/cycles/${cycle}/executions`, { data: { testCaseIds: [tc] } });
  const exec = (await (await request.get(`/api/cycles/${cycle}/executions`)).json()).items[0].id;
  await page.goto(`/go/ausfuehrung/${exec}`);
  await expect(page).toHaveURL(new RegExp(`#/p/DEMO/cycles/${cycle}\\?exec=${exec}`));
  await page.goto('/go/ausfuehrung/00000000-0000-0000-0000-000000000000');
  await expect(page.getByRole('alert').filter({ hasText: 'lässt sich nicht öffnen' })).toBeVisible();
});

test('Versionsnummer: im Kontomenü sichtbar, Details unter Administration → Allgemein', async ({ page }) => {
  await page.goto('/#/p/DEMO/start');
  await page.getByRole('button', { name: /Administrator/ }).click();
  const v = page.locator('.app-version');
  await expect(v).toContainText(/Anemo \d+\.\d+\.\d+/);
  await v.click();
  await expect(page).toHaveURL(/#\/admin\/settings/);
  await expect(page.locator('table.kv')).toContainText('Datenbankstand');
});
