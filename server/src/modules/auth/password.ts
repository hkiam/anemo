/** Kennwort-Hashing mit scrypt (Node-Bordmittel, keine Abhängigkeit). Format: scrypt$N$r$p$salt$hash (Base64). */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { settingsEnv } from '../../platform/settings.ts';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((ok, fail) => scryptCb(password, salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, key) => (e ? fail(e) : ok(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Mindestlänge laut Einstellung ANEMO_PASSWORD_MIN_LENGTH (8–128, Standard 12). */
export function minPasswordLength(env: NodeJS.ProcessEnv = settingsEnv()): number {
  const n = Number(env.ANEMO_PASSWORD_MIN_LENGTH ?? 12);
  return Number.isFinite(n) ? Math.min(128, Math.max(8, Math.round(n))) : 12;
}

/** Mindestanforderungen an lokale Kennwörter. */
export function passwordProblem(password: string, opts: { username?: string | null | undefined; minLength?: number } = {}): string | null {
  const min = opts.minLength ?? minPasswordLength();
  if (password.length < min) return `Das Kennwort muss mindestens ${min} Zeichen lang sein.`;
  if (password.length > 256) return 'Das Kennwort darf höchstens 256 Zeichen lang sein.';
  if (!/[a-zA-Z]/.test(password) || !/[^a-zA-Z]/.test(password)) return 'Das Kennwort muss Buchstaben und Ziffern oder Sonderzeichen enthalten.';
  if (opts.username && opts.username.length >= 3 && password.toLowerCase().includes(opts.username.toLowerCase())) return 'Das Kennwort darf den Benutzernamen nicht enthalten.';
  return null;
}

/** Einmal-Kennwort: gut lesbar (ohne 0/O/1/l/I), Gruppen mit Bindestrich, garantiert Buchstaben und Ziffern. */
export function randomPassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(20);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  const groups = s.match(/.{5}/g)!.slice(0, 4);
  groups[3] = `${groups[3]!.slice(0, 4)}${2 + (bytes[0]! % 8)}`;
  return groups.join('-');
}
