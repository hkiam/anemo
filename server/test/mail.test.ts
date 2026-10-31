import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { dispatchMail, setMailSender } from '../src/modules/notifications/index.ts';
import { sendMail } from '../src/platform/smtp.ts';
import { type TestEnv, testEnv } from './helpers.ts';

describe('SMTP-Client', () => {
  it('spricht SMTP mit AUTH PLAIN, Dot-Stuffing und UTF-8-Betreff', async () => {
    const log: string[] = [];
    let data = '';
    const server = createServer((s) => {
      s.setEncoding('utf8');
      let inData = false;
      let buf = '';
      s.write('220 mock ESMTP\r\n');
      s.on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (inData) {
            if (line === '.') { inData = false; s.write('250 OK queued\r\n'); } else data += `${line}\n`;
            continue;
          }
          log.push(line);
          if (line.startsWith('EHLO')) s.write('250-mock\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (line.startsWith('AUTH PLAIN')) s.write('235 ok\r\n');
          else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); }
          else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
          else s.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    await sendMail({ host: '127.0.0.1', port, secure: 'none', user: 'u', password: 'p', from: 'Anemo <qa@example.test>', rejectUnauthorized: true },
      { to: ['anna@example.test'], subject: 'Prüfung fällig', text: 'Zeile 1\n.Punktzeile' });
    server.close();
    assert.deepEqual(log.filter((l) => !l.startsWith('AUTH')), ['EHLO anemo', 'MAIL FROM:<qa@example.test>', 'RCPT TO:<anna@example.test>', 'DATA', 'QUIT']);
    assert.equal(log.find((l) => l.startsWith('AUTH')), `AUTH PLAIN ${Buffer.from('\0u\0p').toString('base64')}`);
    assert.match(data, /^Subject: =\?UTF-8\?B\?/m);
    const body = Buffer.from(data.split('\n\n')[1]!.replace(/\n/g, ''), 'base64').toString();
    assert.equal(body, 'Zeile 1\r\n.Punktzeile');
  });
});

describe('E-Mail-Benachrichtigungen', () => {
  let env: TestEnv;
  const sent: { to: string[]; subject: string; text: string }[] = [];
  let fail = false;
  before(async () => {
    env = await testEnv();
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_FROM = 'qa@example.test';
    setMailSender(async (_cfg, m) => { if (fail) throw new Error('down'); sent.push(m); });
    for (const u of ['anna', 'bert']) {
      const r = await env.call('POST', '/api/admin/users', { username: u, displayName: u.toUpperCase(), password: 'Sicheres-Passwort-1' });
      await env.call('PATCH', `/api/admin/users/${r.body.id}`, { email: `${u}@example.test` });
    }
    await env.call('POST', '/api/projects', { key: 'ML', name: 'Mail' });
    for (const t of ['A', 'B']) await env.call('POST', '/api/projects/ML/test-cases', { content: { title: t, steps: [{ action: 'a', expected: 'b' }] } });
  });
  after(async () => {
    setMailSender(null);
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_FROM;
    await env.close();
  });

  it('fasst Zuweisungen je Empfänger zusammen, meldet eigene Aktionen nicht, wiederholt bei Ausfall', async () => {
    await dispatchMail(env.db); // Lesezeiger ans Ende
    sent.length = 0;
    const c = (await env.call('POST', '/api/projects/ML/cycles', { name: 'Regression' })).body.id;
    await env.call('POST', `/api/cycles/${c}/executions`, { testCaseIds: ['ML-T1', 'ML-T2'] });
    const ids = (await env.call('GET', `/api/cycles/${c}/executions`)).body.items.map((e: any) => e.id);
    await env.call('POST', '/api/executions/bulk-assign', { ids, assignee: 'anna' }, 'bert');
    await env.call('POST', '/api/executions/bulk-assign', { ids: [ids[0]], assignee: 'bert' }, 'bert');
    fail = true;
    assert.deepEqual(await dispatchMail(env.db), { sent: 0, failed: 1 });
    fail = false;
    assert.deepEqual(await dispatchMail(env.db), { sent: 0, failed: 0 }, 'wartet nach Fehler');
    await env.db`update mail_state set next_attempt_at = null`;
    const r = await dispatchMail(env.db);
    assert.deepEqual(r, { sent: 1, failed: 0 });
    assert.deepEqual(sent[0]!.to, ['anna@example.test']);
    assert.equal(sent[0]!.subject, 'Anemo: 2 Neuigkeiten');
    assert.match(sent[0]!.text, /Zugewiesen: ML-T1 „A“ in „Regression“ \(von bert\)/);
  });

  it('Abmelden einer Benachrichtigung und geschützte Projekte', async () => {
    const prefs = (await env.call('GET', '/api/auth/notifications')).body;
    assert.equal(prefs.mailConfigured, true);
    await env.call('PUT', '/api/projects/ML/external-services', { externalServices: 'blocked' });
    sent.length = 0;
    const c = (await env.call('POST', '/api/projects/ML/cycles', { name: 'Geheim' })).body.id;
    await env.call('POST', `/api/cycles/${c}/executions`, { testCaseIds: ['ML-T1'] });
    const [e] = (await env.call('GET', `/api/cycles/${c}/executions`)).body.items;
    await env.call('POST', '/api/executions/bulk-assign', { ids: [e.id], assignee: 'anna' }, 'bert');
    await dispatchMail(env.db);
    assert.match(sent[0]!.text, /geschützten Projekt \(ML\)/);
    assert.doesNotMatch(sent[0]!.text, /„A“/);
  });
});
