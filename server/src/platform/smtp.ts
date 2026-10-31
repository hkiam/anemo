/**
 * Schlanker SMTP-Client ohne Abhängigkeiten (RFC 5321): implizites TLS (465) oder STARTTLS (587), AUTH PLAIN/LOGIN,
 * UTF-8-Betreff (RFC 2047) und Text in Base64. Für Benachrichtigungen, nicht für Massenversand.
 */
import { randomUUID } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { settingsEnv } from './settings.ts';

export interface SmtpConfig { host: string; port: number; secure: 'tls' | 'starttls' | 'none'; user?: string | undefined; password?: string | undefined; from: string; rejectUnauthorized: boolean }

export function smtpConfig(env: NodeJS.ProcessEnv = settingsEnv()): SmtpConfig | null {
  if (!env.SMTP_HOST || !env.SMTP_FROM) return null;
  const port = Number(env.SMTP_PORT ?? 587);
  const secure = (env.SMTP_SECURE as SmtpConfig['secure'] | undefined) ?? (port === 465 ? 'tls' : port === 25 ? 'none' : 'starttls');
  return { host: env.SMTP_HOST, port, secure, user: env.SMTP_USER, password: env.SMTP_PASSWORD, from: env.SMTP_FROM, rejectUnauthorized: env.SMTP_TLS_INSECURE !== 'true' };
}

export interface Mail { to: string[]; subject: string; text: string }

class Conn {
  private buf = '';
  private waiters: ((line: string) => void)[] = [];
  socket: Socket | TLSSocket;
  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.attach();
  }
  attach() {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (d: string) => {
      this.buf += d;
      // vollständige Antwort: letzte Zeile "ddd text"
      let m: RegExpExecArray | null;
      while ((m = /^(?:\d{3}-.*\r\n)*\d{3}(?: .*)?\r\n/.exec(this.buf))) {
        this.buf = this.buf.slice(m[0].length);
        this.waiters.shift()?.(m[0]);
      }
    });
  }
  read(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      this.socket.once('error', reject);
    });
  }
  async cmd(line: string | null, expect: number[]): Promise<string> {
    const p = this.read();
    if (line !== null) this.socket.write(`${line}\r\n`);
    const r = await p;
    const code = Number(r.slice(0, 3));
    if (!expect.includes(code)) throw new Error(`SMTP ${line?.startsWith('AUTH') ? 'AUTH' : line ?? 'Begrüßung'}: ${r.trim()}`);
    return r;
  }
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addr = (s: string) => /<([^>]+)>/.exec(s)?.[1] ?? s.trim();

export function buildMessage(cfg: SmtpConfig, mail: Mail, now = new Date()): string {
  const domain = addr(cfg.from).split('@')[1] ?? 'anemo';
  const nameAddr = (s: string) => {
    const m = /^(.*)<([^>]+)>$/.exec(s.trim());
    return m ? `${encodeHeader(m[1]!.trim().replace(/^"|"$/g, ''))} <${m[2]}>` : s.trim();
  };
  const body = b64(mail.text.replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${nameAddr(cfg.from)}`, `To: ${mail.to.join(', ')}`, `Subject: ${encodeHeader(mail.subject)}`, `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated', '', body,
  ].join('\r\n');
}

export async function sendMail(cfg: SmtpConfig, mail: Mail): Promise<void> {
  const timeout = 20_000;
  let socket: Socket | TLSSocket = cfg.secure === 'tls'
    ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized })
    : netConnect({ host: cfg.host, port: cfg.port });
  socket.setTimeout(timeout, () => socket.destroy(new Error('SMTP-Zeitüberschreitung')));
  let c = new Conn(socket);
  try {
    await c.cmd(null, [220]);
    let ehlo = await c.cmd('EHLO anemo', [250]);
    if (cfg.secure === 'starttls') {
      if (!/STARTTLS/i.test(ehlo)) throw new Error('Server bietet kein STARTTLS an (SMTP_SECURE=none setzen, falls gewollt)');
      await c.cmd('STARTTLS', [220]);
      socket.removeAllListeners('data');
      socket = tlsConnect({ socket, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized });
      await new Promise<void>((res, rej) => { (socket as TLSSocket).once('secureConnect', () => res()); socket.once('error', rej); });
      c = new Conn(socket);
      ehlo = await c.cmd('EHLO anemo', [250]);
    }
    if (cfg.user) {
      if (/AUTH[^\r\n]*PLAIN/i.test(ehlo)) await c.cmd(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.password ?? ''}`)}`, [235]);
      else {
        await c.cmd('AUTH LOGIN', [334]);
        await c.cmd(b64(cfg.user), [334]);
        await c.cmd(b64(cfg.password ?? ''), [235]);
      }
    }
    await c.cmd(`MAIL FROM:<${addr(cfg.from)}>`, [250]);
    for (const to of mail.to) await c.cmd(`RCPT TO:<${addr(to)}>`, [250, 251]);
    await c.cmd('DATA', [354]);
    const data = buildMessage(cfg, mail).replace(/^\./gm, '..');
    await c.cmd(`${data}\r\n.`, [250]);
    await c.cmd('QUIT', [221]).catch(() => undefined);
  } finally {
    socket.destroy();
  }
}
