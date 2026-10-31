import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { expect, test as setup } from '@playwright/test';
import { secret, STATE } from './helpers.ts';

const pw = () => `Pw-${randomBytes(9).toString('base64url')}4`;

setup('Admin meldet sich an, Testdaten und Konten werden angelegt', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
  await page.getByLabel('Benutzername').fill('admin');
  await page.getByLabel('Kennwort', { exact: true }).fill(secret('admin'));
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.locator('.topbar')).toBeVisible();

  const api = page.request;
  // Realistische Daten: Demo-Export aus Jira/Zephyr über den regulären Migrationsimport
  const run = await api.post('/api/migration/runs', { data: { snapshot: 'zephyr-demo' } });
  expect(run.status(), await run.text()).toBe(201);

  // Eingeschränktes Projekt mit einem Testfall
  expect((await api.post('/api/projects', { data: { key: 'GEHEIM', name: 'Geheimes Projekt' } })).status()).toBe(201);
  expect((await api.put('/api/projects/GEHEIM/visibility', { data: { visibility: 'restricted' } })).ok()).toBeTruthy();
  const tc = await api.post('/api/projects/GEHEIM/test-cases', { data: { content: { title: 'Vertraulicher Ablauf', format: 'CLASSIC', steps: [{ action: 'Akte öffnen', data: '', expected: 'geöffnet' }], labels: [], components: [], sections: [], customFields: {} } } });
  expect(tc.status(), await tc.text()).toBe(201);

  // Konten: Testerin (Ausführen in DEMO), Leser (nur lesen), Gruppe „Ermittlung“ für GEHEIM
  const secrets: Record<string, string> = {};
  const ids: Record<string, string> = {};
  for (const [username, displayName] of [['tina.tester', 'Tina Tester'], ['lena.leser', 'Lena Leser'], ['gerd.geheim', 'Gerd Geheim']] as const) {
    secrets[username] = pw();
    const r = await api.post('/api/admin/users', { data: { username, displayName, password: secrets[username] } });
    expect(r.status(), await r.text()).toBe(201);
    ids[username] = (await r.json()).id;
  }
  writeFileSync(`${STATE}secrets.json`, JSON.stringify(secrets), { mode: 0o600 });
  for (const [user, role] of [['tina.tester', 'TESTER'], ['lena.leser', 'VIEWER']] as const) {
    expect((await api.put('/api/projects/DEMO/members', { data: { principalType: 'user', principalId: ids[user], role } })).ok()).toBeTruthy();
  }
  const group = await api.post('/api/admin/groups', { data: { name: 'Ermittlung' } });
  const groupId = (await group.json()).id;
  expect((await api.put(`/api/admin/groups/${groupId}`, { data: { memberIds: [ids['gerd.geheim']] } })).ok()).toBeTruthy();
  expect((await api.put('/api/projects/GEHEIM/members', { data: { principalType: 'group', principalId: groupId, role: 'TESTER' } })).ok()).toBeTruthy();

  await page.context().storageState({ path: `${STATE}admin.json` });
});
