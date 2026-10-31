/**
 * Minimaler LDAPv3-Client ohne Abhängigkeiten (RFC 4511): Simple Bind, Search, Unbind über LDAP oder LDAPS.
 * Genügt für Anmeldung gegen Active Directory/OpenLDAP und das Lesen von Gruppen; kein Schreiben.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

// ---------------------------------------------------------------------------------------------
// BER (Basic Encoding Rules) – nur was LDAP braucht
// ---------------------------------------------------------------------------------------------

export interface Ber { tag: number; value: Buffer; children?: Ber[] }

function lengthBytes(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
export const tlv = (tag: number, value: Buffer) => Buffer.concat([Buffer.from([tag]), lengthBytes(value.length), value]);
export const seq = (tag: number, ...items: Buffer[]) => tlv(tag, Buffer.concat(items));
export const int = (n: number, tag = 0x02) => {
  const bytes: number[] = [];
  let x = n;
  do { bytes.unshift(x & 0xff); x >>= 8; } while (x > 0);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(tag, Buffer.from(bytes));
};
export const str = (s: string, tag = 0x04) => tlv(tag, Buffer.from(s, 'utf8'));
export const bool = (b: boolean) => tlv(0x01, Buffer.from([b ? 0xff : 0]));

/** Ein Element ab Offset lesen; null, wenn noch nicht vollständig empfangen */
export function readBer(buf: Buffer, offset = 0): { ber: Ber; end: number } | null {
  if (buf.length < offset + 2) return null;
  const tag = buf[offset]!;
  let len = buf[offset + 1]!;
  let p = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (buf.length < p + n) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i]!;
    p += n;
  }
  if (buf.length < p + len) return null;
  const value = buf.subarray(p, p + len);
  const ber: Ber = { tag, value };
  if (tag & 0x20) { // konstruiert
    ber.children = [];
    let q = 0;
    while (q < value.length) {
      const c = readBer(value, q);
      if (!c) break;
      ber.children.push(c.ber);
      q = c.end;
    }
  }
  return { ber, end: p + len };
}
export const berInt = (b: Ber) => b.value.reduce((a, x) => a * 256 + x, 0);
export const berStr = (b: Ber) => b.value.toString('utf8');

// ---------------------------------------------------------------------------------------------
// Filter: (&(a=b)(|(c=d)(e=*))(!(f=g))) – Gleichheit, Vorhandensein, Teilstring mit *, und/oder/nicht
// ---------------------------------------------------------------------------------------------

export function encodeFilter(f: string): Buffer {
  let i = 0;
  const parse = (): Buffer => {
    if (f[i] !== '(') throw new Error(`LDAP-Filter: „(“ erwartet bei ${i}`);
    i++;
    const op = f[i];
    if (op === '&' || op === '|') {
      i++;
      const parts: Buffer[] = [];
      while (f[i] === '(') parts.push(parse());
      i++;
      return seq(op === '&' ? 0xa0 : 0xa1, ...parts);
    }
    if (op === '!') {
      i++;
      const inner = parse();
      i++;
      return seq(0xa2, inner);
    }
    const close = f.indexOf(')', i);
    const item = f.slice(i, close);
    i = close + 1;
    const eq = item.indexOf('=');
    const attr = item.slice(0, eq);
    const val = unescapeValue(item.slice(eq + 1));
    if (val === '*') return str(attr, 0x87); // present
    if (val.includes('*')) {
      const parts = val.split('*');
      const subs: Buffer[] = [];
      parts.forEach((p, k) => {
        if (!p) return;
        subs.push(str(p, k === 0 ? 0x80 : k === parts.length - 1 ? 0x82 : 0x81));
      });
      return seq(0xa4, str(attr), seq(0x30, ...subs));
    }
    return seq(0xa3, str(attr), str(val));
  };
  return parse();
}
const unescapeValue = (v: string) => v.replace(/\\([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
/** Wert für Filter maskieren (RFC 4515) – Benutzereingaben immer maskieren! */
export const escapeFilter = (v: string) => v.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

// ---------------------------------------------------------------------------------------------
// Verbindung
// ---------------------------------------------------------------------------------------------

export interface LdapEntry { dn: string; attributes: Record<string, string[]> }

export class LdapClient {
  private socket: Socket;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (msgs: Ber[]) => void; reject: (e: Error) => void; msgs: Ber[]; endTag: number }>();
  private closed: Error | null = null;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        const r = readBer(this.buf);
        if (!r) break;
        this.buf = this.buf.subarray(r.end);
        const [idB, op] = r.ber.children ?? [];
        if (!idB || !op) continue;
        const p = this.pending.get(berInt(idB));
        if (!p) continue;
        p.msgs.push(op);
        if (op.tag === p.endTag) {
          this.pending.delete(berInt(idB));
          p.resolve(p.msgs);
        }
      }
    });
    const fail = (e: Error) => {
      this.closed = e;
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('LDAP-Verbindung geschlossen')));
    socket.setTimeout(15_000, () => socket.destroy(new Error('LDAP-Zeitüberschreitung')));
  }

  static async connect(url: string, opts: { rejectUnauthorized?: boolean } = {}): Promise<LdapClient> {
    const u = new URL(url);
    const tls = u.protocol === 'ldaps:';
    const port = Number(u.port || (tls ? 636 : 389));
    const socket = tls ? tlsConnect({ host: u.hostname, port, servername: u.hostname, rejectUnauthorized: opts.rejectUnauthorized ?? true }) : netConnect({ host: u.hostname, port });
    await new Promise<void>((res, rej) => {
      socket.once(tls ? 'secureConnect' : 'connect', () => res());
      socket.once('error', rej);
    });
    return new LdapClient(socket);
  }

  private request(op: Buffer, endTag: number): Promise<Ber[]> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, msgs: [], endTag });
      this.socket.write(seq(0x30, int(id), op));
    });
  }

  private static check(result: Ber, what: string): void {
    const [code, , msg] = result.children ?? [];
    const c = code ? berInt(code) : -1;
    if (c !== 0) {
      const err = new Error(`${what}: LDAP-Code ${c}${msg && msg.value.length ? ` (${berStr(msg)})` : ''}`) as Error & { code: number };
      err.code = c;
      throw err;
    }
  }

  /** Simple Bind; wirft bei falschen Zugangsdaten (Code 49) */
  async bind(dn: string, password: string): Promise<void> {
    if (!password) throw new Error('Leeres Kennwort (anonymer Bind) nicht erlaubt');
    const [res] = await this.request(seq(0x60, int(3), str(dn), str(password, 0x80)), 0x61);
    LdapClient.check(res!, 'Bind');
  }

  async search(base: string, filter: string, attributes: string[], scope: 0 | 1 | 2 = 2, sizeLimit = 100): Promise<LdapEntry[]> {
    const op = seq(0x63, str(base), int(scope, 0x0a), int(0, 0x0a), int(sizeLimit), int(10), bool(false), encodeFilter(filter), seq(0x30, ...attributes.map((a) => str(a))));
    const msgs = await this.request(op, 0x65);
    const done = msgs.at(-1)!;
    // sizeLimitExceeded (4) liefert dennoch Einträge
    const code = berInt(done.children![0]!);
    if (code !== 0 && code !== 4) LdapClient.check(done, 'Suche');
    return msgs.filter((m) => m.tag === 0x64).map((m) => {
      const [dn, attrs] = m.children!;
      const attributes: Record<string, string[]> = {};
      for (const a of attrs?.children ?? []) {
        const [type, vals] = a.children!;
        attributes[berStr(type!).toLowerCase()] = (vals?.children ?? []).map(berStr);
      }
      return { dn: berStr(dn!), attributes };
    });
  }

  close(): void {
    if (!this.closed) {
      try {
        this.socket.write(seq(0x30, int(this.nextId++), tlv(0x42, Buffer.alloc(0))));
      } catch { /* egal */ }
    }
    this.socket.destroy();
  }
}
