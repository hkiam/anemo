/**
 * Legt einen fiktiven, aber realistischen Bestand an (Online-Shop, Release 2.4) und nimmt die Screenshots für README
 * und Website auf: docs/bilder/screenshots/*.png. Alle Namen, Tickets und Inhalte sind erfunden.
 *
 *   npm run screenshots
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page, request as pwRequest, test } from '@playwright/test';

const OUT = new URL('../../docs/bilder/screenshots/', import.meta.url).pathname;
const STATE = new URL('./.state/', import.meta.url).pathname;
const BASE = `http://localhost:${process.env.SHOWCASE_PORT ?? 8098}`;
const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

type Step = [action: string, data: string, expected: string];
interface Case { folder: string; title: string; priority: string; labels: string[]; objective: string; steps?: Step[]; gherkin?: string; req: string }

const CASES: Case[] = [
  { folder: 'Warenkorb', title: 'Artikel in den Warenkorb legen', priority: 'Kritisch', labels: ['Smoke', 'Regression'], req: 'SHOP-12',
    objective: 'Ein Artikel lässt sich aus der Detailseite in den Warenkorb legen; Menge und Summe stimmen.',
    steps: [['Artikelseite „Trekkingrucksack 40 l“ öffnen', 'Artikelnummer 100245', 'Detailseite mit Preis 89,90 € wird angezeigt'],
      ['Menge 2 wählen und „In den Warenkorb“ klicken', 'Menge: 2', 'Hinweis „2 Artikel hinzugefügt“, Symbol zeigt 2'],
      ['Warenkorb öffnen', '', 'Position mit Menge 2 und Zwischensumme 179,80 €'],
      ['Menge auf 1 reduzieren', '', 'Zwischensumme wird sofort auf 89,90 € aktualisiert']] },
  { folder: 'Warenkorb', title: 'Gutscheincode einlösen', priority: 'Schwer', labels: ['Regression'], req: 'SHOP-14',
    objective: 'Gültige Gutscheine reduzieren die Summe, ungültige werden verständlich abgelehnt.',
    gherkin: 'Funktionalität: Gutscheine\n\n  Szenariogrundriss: Gutschein einlösen\n    Angenommen der Warenkorb enthält Artikel für 120,00 €\n    Wenn ich den Code "<code>" einlöse\n    Dann sehe ich "<meldung>"\n    Und die Summe beträgt <summe>\n\n    Beispiele:\n      | code      | meldung                     | summe    |\n      | SOMMER10  | 10 % Rabatt angewendet      | 108,00 € |\n      | ABGELAUFEN| Gutschein ist abgelaufen    | 120,00 € |\n      | XYZ       | Gutschein nicht gefunden    | 120,00 € |\n' },
  { folder: 'Warenkorb', title: 'Warenkorb bleibt nach erneuter Anmeldung erhalten', priority: 'Schwer', labels: ['Regression'], req: 'SHOP-15',
    objective: 'Der Warenkorb angemeldeter Kunden wird geräteübergreifend gespeichert.',
    steps: [['Als Kundin anmelden und zwei Artikel in den Warenkorb legen', 'kundin@example.org', 'Warenkorb zeigt 2 Positionen'],
      ['Abmelden und in einem anderen Browser erneut anmelden', '', 'Warenkorb zeigt dieselben 2 Positionen']] },
  { folder: 'Bezahlung', title: 'Bezahlung mit Kreditkarte (3-D Secure)', priority: 'Blocker', labels: ['Smoke', 'Regression', 'Zahlung'], req: 'SHOP-21',
    objective: 'Kartenzahlung inklusive Zwei-Faktor-Freigabe schließt die Bestellung ab.',
    steps: [['Warenkorb mit einem Artikel zur Kasse führen', '', 'Kasse zeigt Liefer- und Zahlungsdaten'],
      ['Zahlart „Kreditkarte“ wählen und Testkarte eingeben', '4000 0000 0000 3220, 12/30, 123', 'Weiterleitung zur 3-D-Secure-Freigabe'],
      ['Freigabe bestätigen', '', 'Rückkehr in den Shop, Bestellbestätigung mit Bestellnummer'],
      ['Bestellbestätigung per E-Mail prüfen', '', 'E-Mail innerhalb von 2 Minuten, Beträge identisch']] },
  { folder: 'Bezahlung', title: 'Bezahlung per Rechnung mit Bonitätsprüfung', priority: 'Kritisch', labels: ['Regression', 'Zahlung'], req: 'SHOP-22',
    objective: 'Kauf auf Rechnung wird nur nach positiver Bonitätsprüfung angeboten.',
    steps: [['Zur Kasse gehen und „Rechnung“ wählen', 'Bestellwert 250 €', 'Geburtsdatum wird abgefragt'],
      ['Geburtsdatum eingeben und fortfahren', '01.04.1985', 'Bonitätsprüfung positiv, Bestellung möglich']] },
  { folder: 'Bezahlung', title: 'Zahlungsabbruch führt zurück in den Warenkorb', priority: 'Schwer', labels: ['Regression', 'Zahlung'], req: 'SHOP-23',
    objective: 'Bricht die Kundin die Zahlung ab, bleibt der Warenkorb unverändert erhalten.',
    steps: [['Kreditkartenzahlung starten und bei 3-D Secure „Abbrechen“ wählen', '', 'Hinweis „Zahlung abgebrochen“, Warenkorb unverändert']] },
  { folder: 'Bezahlung', title: 'Rechnungs-PDF in der Bestellübersicht', priority: 'Unwesentlich', labels: ['Regression'], req: 'SHOP-24',
    objective: 'Zu jeder Bestellung steht die Rechnung als barrierefreies PDF bereit.',
    steps: [['Kundenkonto → Bestellungen öffnen', '', 'Liste der Bestellungen'], ['„Rechnung (PDF)“ herunterladen', '', 'PDF mit Rechnungsnummer, getaggt']] },
  { folder: 'Kundenkonto', title: 'Registrierung mit Double-Opt-in', priority: 'Kritisch', labels: ['Smoke', 'Regression'], req: 'SHOP-31',
    objective: 'Neue Kundenkonten werden erst nach Bestätigung der E-Mail-Adresse aktiv.',
    steps: [['Registrierungsformular ausfüllen', 'neu@example.org, Kennwort nach Richtlinie', 'Hinweis „Bitte E-Mail bestätigen“'],
      ['Bestätigungslink aus der E-Mail öffnen', '', 'Konto aktiv, automatische Anmeldung']] },
  { folder: 'Kundenkonto', title: 'Kennwort zurücksetzen', priority: 'Schwer', labels: ['Regression', 'Sicherheit'], req: 'SHOP-32',
    objective: 'Der Link zum Zurücksetzen ist einmalig und läuft nach 30 Minuten ab.',
    steps: [['„Kennwort vergessen“ wählen und E-Mail-Adresse eingeben', 'kundin@example.org', 'Neutrale Meldung, unabhängig davon, ob das Konto existiert'],
      ['Link öffnen und neues Kennwort setzen', '', 'Anmeldung mit neuem Kennwort möglich'], ['Denselben Link erneut öffnen', '', 'Hinweis „Link ungültig oder abgelaufen“']] },
  { folder: 'Kundenkonto', title: 'Lieferadressen verwalten', priority: 'Unwesentlich', labels: ['Regression'], req: 'SHOP-33',
    objective: 'Mehrere Lieferadressen lassen sich anlegen, ändern und als Standard markieren.',
    steps: [['Neue Lieferadresse anlegen', 'Musterweg 5, 12345 Beispielstadt', 'Adresse erscheint in der Liste'], ['Als Standard markieren', '', 'Kasse schlägt die Adresse vor']] },
  { folder: 'Suche & Katalog', title: 'Volltextsuche mit Tippfehlertoleranz', priority: 'Schwer', labels: ['Regression'], req: 'SHOP-41',
    objective: 'Die Suche findet Artikel auch bei kleinen Tippfehlern.',
    gherkin: 'Funktionalität: Suche\n\n  Szenario: Tippfehler werden toleriert\n    Angenommen der Katalog enthält den Artikel "Trekkingrucksack 40 l"\n    Wenn ich nach "Trekingrucksak" suche\n    Dann erscheint "Trekkingrucksack 40 l" unter den ersten drei Treffern\n' },
  { folder: 'Suche & Katalog', title: 'Filter nach Preis und Marke', priority: 'Unwesentlich', labels: ['Regression'], req: 'SHOP-42',
    objective: 'Facettenfilter lassen sich kombinieren und in der URL teilen.',
    steps: [['Kategorie „Rucksäcke“ öffnen', '', '48 Artikel'], ['Preis 50–100 € und Marke „Alpenwerk“ wählen', '', '7 Artikel, Filter in der URL']] },
  { folder: 'Suche & Katalog', title: 'Produktbilder vergrößern (Zoom)', priority: 'Trivial', labels: [], req: 'SHOP-43',
    objective: 'Bilder lassen sich per Klick und Tastatur vergrößern.',
    steps: [['Produktbild anklicken', '', 'Zoomansicht öffnet sich'], ['Mit Esc schließen', '', 'Fokus kehrt zum Bild zurück']] },
  { folder: 'Barrierefreiheit', title: 'Kasse vollständig per Tastatur bedienbar', priority: 'Kritisch', labels: ['BITV', 'Regression'], req: 'SHOP-51',
    objective: 'Alle Schritte der Kasse sind ohne Maus erreichbar, der Fokus ist jederzeit sichtbar (WCAG 2.1.1, 2.4.7).',
    steps: [['Kasse nur mit Tab, Umschalt+Tab, Enter und Leertaste durchlaufen', '', 'Jedes Bedienelement erreichbar, Fokusrahmen sichtbar'],
      ['Fehlerhafte Eingabe absenden', 'PLZ: 1234', 'Fehlermeldung wird vorgelesen und ist mit dem Feld verknüpft']] },
  { folder: 'Barrierefreiheit', title: 'Kontraste und Textvergrößerung 200 %', priority: 'Schwer', labels: ['BITV'], req: 'SHOP-52',
    objective: 'Texte erreichen mindestens 4,5:1 und bleiben bei 200 % Zoom ohne Verlust lesbar (WCAG 1.4.3, 1.4.4).',
    steps: [['Startseite mit Kontrastprüfung analysieren', '', 'Keine Verstöße'], ['Browser-Zoom auf 200 % stellen', '', 'Kein Abschneiden, kein seitliches Scrollen']] },
  { folder: 'Barrierefreiheit', title: 'Screenreader: Bestellabschluss mit NVDA', priority: 'Schwer', labels: ['BITV'], req: 'SHOP-53',
    objective: 'Der Bestellabschluss ist mit Screenreader verständlich.',
    steps: [['Bestellung mit NVDA und Firefox abschließen', '', 'Alle Schritte und Ergebnisse werden verständlich angesagt']] },
];

/** Ergebnisse je Zyklus (Index in CASES → Status); fehlende bleiben offen */
const RESULTS: Record<string, Record<number, string>> = {
  chrome: { 0: 'PASS', 1: 'PASS', 2: 'PASS', 3: 'PASS', 4: 'PASS', 5: 'FAIL', 6: 'PASS', 7: 'PASS', 8: 'PASS', 9: 'PASS', 10: 'PASS', 11: 'PASS', 12: 'PASS', 13: 'PASS', 14: 'PASS', 15: 'NA' },
  firefox: { 0: 'PASS', 1: 'PASS', 2: 'PASS', 3: 'PASS', 4: 'BLOCKED', 6: 'PASS', 7: 'PASS', 8: 'PASS', 10: 'PASS', 11: 'FAIL_KNOWN', 13: 'PASS', 14: 'PASS', 15: 'PASS' },
  safari: { 0: 'PASS', 3: 'PASS', 7: 'PASS' },
};

async function as(user: string, password: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const r = await ctx.post('/api/auth/login', { data: { username: user, password } });
  expect(r.ok(), `Anmeldung ${user}: ${await r.text()}`).toBeTruthy();
  return ctx;
}

async function ok<T = any>(p: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const r = await p;
  expect(r.ok(), `${r.url()} → ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.status() === 204 ? (undefined as T) : r.json();
}

async function shot(page: Page, name: string, path: string, opts: { wait?: string; full?: boolean } = {}) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  if (opts.wait) await expect(page.locator(opts.wait).first()).toBeVisible();
  await page.locator('.toast').evaluateAll((els) => els.forEach((e) => e.remove()));
  await page.waitForTimeout(400);
  // Ansichten setzen den Fokus auf die Überschrift (Barrierefreiheit) – im Bild ohne Fokusrahmen
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: opts.full ?? false, animations: 'disabled', caret: 'hide' });
}

test('Beispielbestand anlegen und Screenshots aufnehmen', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  const admin = await as('admin', readFileSync(`${STATE}admin-password`, 'utf8'));

  // Konten: Testleiterin (Systemadministration, gibt frei, entscheidet), Testdesignerin (schreibt Testfälle), zwei Tester
  const pw: Record<string, string> = {};
  const ids: Record<string, string> = {};
  for (const [username, displayName] of [['martina.hoffmann', 'Martina Hoffmann'], ['sabine.krause', 'Sabine Krause'], ['jonas.weber', 'Jonas Weber'], ['lea.schmitt', 'Lea Schmitt']]) {
    pw[username] = `Pw-${randomBytes(9).toString('base64url')}4`;
    ids[username] = (await ok(admin.post('/api/admin/users', { data: { username, displayName, password: pw[username], email: `${username}@example.org` } }))).id;
  }
  await ok(admin.patch(`/api/admin/users/${ids['martina.hoffmann']}`, { data: { isSystemAdmin: true } }));

  await ok(admin.post('/api/projects', { data: { key: 'SHOP', name: 'Online-Shop', description: 'Webshop für Outdoor-Ausrüstung – Release 2.4 mit neuer Kasse' } }));
  await ok(admin.post('/api/projects', { data: { key: 'APP', name: 'Shop-App (iOS/Android)', description: 'Mobile App zum Online-Shop' } }));
  for (const [user, role] of [['sabine.krause', 'DESIGNER'], ['jonas.weber', 'TESTER'], ['lea.schmitt', 'TESTER']]) {
    for (const key of ['SHOP', 'APP']) await ok(admin.put(`/api/projects/${key}/members`, { data: { principalType: 'user', principalId: ids[user], role } }));
  }
  const lead = await as('martina.hoffmann', pw['martina.hoffmann']!);
  const sabine = await as('sabine.krause', pw['sabine.krause']!);
  const jonas = await as('jonas.weber', pw['jonas.weber']!);
  const lea = await as('lea.schmitt', pw['lea.schmitt']!);

  // Ordner und Testfälle (Version 1 von der Testdesignerin, freigegeben von der Testleitung – Vier-Augen-Prinzip)
  const folders: Record<string, string> = {};
  for (const name of [...new Set(CASES.map((c) => c.folder))]) folders[name] = (await ok(sabine.post('/api/projects/SHOP/folders', { data: { name } }))).id;
  const tcIds: string[] = [];
  for (const c of CASES) {
    const content = {
      title: c.title, objective: c.objective, priority: c.priority, labels: c.labels, components: [c.folder], sections: [], customFields: {},
      ...(c.gherkin ? { format: 'GHERKIN', gherkin: c.gherkin, steps: [] }
        : { format: 'CLASSIC', steps: c.steps!.map(([action, data, expected]) => ({ action, data, expected })) }),
      preconditions: c.folder === 'Bezahlung' ? 'Testkonto mit hinterlegter Lieferadresse; Zahlungsanbieter im Testmodus' : null,
    };
    const tc = await ok(sabine.post('/api/projects/SHOP/test-cases', { data: { folderId: folders[c.folder], owner: 'sabine.krause', content } }));
    tcIds.push(tc.id);
    await ok(sabine.post('/api/references', { data: { ownerType: 'TEST_CASE', ownerId: tc.id, relation: 'REQUIREMENT', provider: 'jira', externalKey: c.req, title: `Anforderung: ${c.title}` } }));
  }
  await ok(lead.post('/api/projects/SHOP/test-cases/approve', { data: { ids: tcIds.slice(0, -1), note: 'Review Release 2.4' } }));

  // Testplan mit Ausstiegskriterien und drei Zyklen (Konfigurationen)
  const plan = await ok(lead.post('/api/projects/SHOP/plans', { data: { name: 'Release 2.4 – Neue Kasse', release: '2.4', description: 'Systemtest und Regression für die neue Kasse mit 3-D Secure' } }));
  await ok(lead.put(`/api/plans/${plan.id}/exit-criteria`, { data: { minPassRate: 95, minExecutionRate: 100, maxOpenDefects: 1, fullCoverage: true } }));
  const cycles: Record<string, string> = {};
  for (const [k, name, configuration, start] of [
    ['chrome', 'Regression 2.4 – Chrome / Windows 11', { browser: ['Chrome'], os: ['Windows 11'] }, -12],
    ['firefox', 'Regression 2.4 – Firefox / Linux', { browser: ['Firefox'], os: ['Linux'] }, -8],
    ['safari', 'Smoke 2.4 – Safari / iOS', { browser: ['Safari'], os: ['iOS'] }, -2],
  ] as const) {
    const cy = await ok(lead.post('/api/projects/SHOP/cycles', { data: { name, planId: plan.id, build: '2.4.0-rc3', environment: 'Staging', startDate: day(start), endDate: day(5) } }));
    await ok(lead.put(`/api/cycles/${cy.id}/configuration`, { data: { configuration } }));
    const picks = k === 'safari' ? [0, 3, 7, 1, 13] : tcIds.map((_, i) => i);
    await ok(lead.post(`/api/cycles/${cy.id}/executions`, { data: { testCaseIds: picks.map((i) => tcIds[i]) } }));
    cycles[k] = cy.id;
  }

  // Ergebnisse (abwechselnd zwei Tester), Fehler mit Ticket
  for (const [k, results] of Object.entries(RESULTS)) {
    const execs = (await ok(lead.get(`/api/cycles/${cycles[k]}/executions?limit=200`))).items as { id: string; testCaseId: string; testCaseKey?: string }[];
    const byCase = new Map(execs.map((e) => [e.testCaseId, e.id]));
    await ok(lead.post('/api/executions/bulk-assign', { data: { ids: execs.filter((_, i) => i % 2 === 0).map((e) => e.id), assignee: 'jonas.weber' } }));
    await ok(lead.post('/api/executions/bulk-assign', { data: { ids: execs.filter((_, i) => i % 2 === 1).map((e) => e.id), assignee: 'lea.schmitt' } }));
    let n = 0;
    for (const [idx, status] of Object.entries(results)) {
      const exec = byCase.get(tcIds[Number(idx)]!);
      if (!exec) continue;
      const who = n++ % 2 === 0 ? jonas : lea;
      const body: Record<string, unknown> = { status };
      if (status === 'FAIL') Object.assign(body, { comment: 'Nach Abbruch bei 3-D Secure ist der Warenkorb leer.', defects: [{ provider: 'jira', key: 'SHOP-142', title: 'Warenkorb geht nach Zahlungsabbruch verloren', severity: 'Hoch' }] });
      if (status === 'FAIL_KNOWN') Object.assign(body, { comment: 'Bekannt, behoben in 2.4.1', defects: [{ provider: 'jira', key: 'SHOP-128', title: 'Markenfilter ignoriert Umlaute', severity: 'Gering' }] });
      if (status === 'BLOCKED') Object.assign(body, { comment: 'Bonitätsdienst in Staging nicht erreichbar' });
      if (status === 'NA') Object.assign(body, { comment: 'Screenreader-Test nur in Firefox vorgesehen' });
      await ok(who.post(`/api/executions/${exec}/result`, { data: body }));
    }
  }
  await ok(lead.post(`/api/cycles/${cycles.chrome}/sessions`, { data: { charter: 'Erkunde die neue Kasse mit langsamen Netzen, um Abbrüche und doppelte Bestellungen zu finden', timeboxMinutes: 60 } }));

  // Fazit und Freigabeentscheidung der Testleitung
  await ok(lead.put(`/api/plans/${plan.id}/assessment`, { data: {
    assessment: 'Die neue Kasse ist in Chrome vollständig und in Firefox weitgehend getestet. Offen ist ein Fehler beim Zahlungsabbruch (SHOP-142, hoch): Der Warenkorb geht verloren. Der Rechnungskauf konnte in Firefox wegen des nicht erreichbaren Bonitätsdienstes nicht getestet werden. Der Markenfilter (SHOP-128) ist als bekannter Fehler mit geringer Auswirkung dokumentiert.',
  } }));
  await ok(lead.put(`/api/plans/${plan.id}/release-decision`, { data: { decision: 'conditional', note: 'Freigabe unter der Auflage, dass SHOP-142 vor dem Go-live behoben und nachgetestet ist; Rechnungskauf in Firefox nachholen.' } }));

  // Zweites Projekt für die Übersicht
  const appTc = await ok(sabine.post('/api/projects/APP/test-cases', { data: { content: { title: 'Anmeldung mit Face ID', format: 'CLASSIC', priority: 'Kritisch', labels: ['Smoke'], components: [], sections: [], customFields: {}, steps: [{ action: 'App öffnen und Face ID bestätigen', data: '', expected: 'Startseite mit Begrüßung' }] } } }));
  const appCycle = await ok(lead.post('/api/projects/APP/cycles', { data: { name: 'Smoke 1.8 – iPhone 15', build: '1.8.0' } }));
  await ok(lead.post(`/api/cycles/${appCycle.id}/executions`, { data: { testCaseIds: [appTc.id] } }));

  // ---- Aufnahmen ----
  const login = await page.request.post('/api/auth/login', { data: { username: 'martina.hoffmann', password: pw['martina.hoffmann'] } });
  expect(login.ok()).toBeTruthy();
  const firstOpen = (await ok(lead.get(`/api/cycles/${cycles.safari}/executions?limit=50`))).items.find((e: { testCaseId: string }) => e.testCaseId === tcIds[13]); // offen: Kasse per Tastatur
  const tc1 = (await ok(lead.get(`/api/test-cases/${tcIds[3]}`))).key ?? 'SHOP-T4';
  const tc2 = (await ok(lead.get(`/api/test-cases/${tcIds[1]}`))).key ?? 'SHOP-T2';

  await shot(page, '01-cockpit', `/#/p/SHOP/cycles?plan=${plan.id}&tab=cockpit`);
  await shot(page, '02-testfaelle', '/#/p/SHOP/repo');
  await shot(page, '03-testfall', `/#/p/SHOP/repo?tc=${tc1}`);
  await shot(page, '04-gherkin', `/#/p/SHOP/repo?tc=${tc2}`);
  await shot(page, '05-durchfuehrung', `/#/f/SHOP/run/${firstOpen.id}`);
  await shot(page, '06-zyklus', `/#/p/SHOP/cycles/${cycles.firefox}`);
  await shot(page, '07-matrix', `/#/p/SHOP/cycles?plan=${plan.id}&tab=matrix`);
  await shot(page, '08-start', '/#/p/SHOP/start');
  await shot(page, '09-protokoll', '/#/p/SHOP/cycles?view=audit');
  await shot(page, '10-portfolio', '/#/portfolio');
  await shot(page, '11-planung', `/#/p/SHOP/cycles?plan=${plan.id}`);
});
