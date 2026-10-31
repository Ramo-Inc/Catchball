// ULID（時刻で並ぶ ID）とトークン
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()): string {
  let t = now, time = '';
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  const rnd = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[rnd[i] % 32];
  return time + rand;
}

export const newMessageId = () => 'm_' + ulid();
export const newNotifyId = () => 'n_' + ulid();

// トークン：sm1.<credential_id>.<secret>。DB には sha256(secret) だけを保存する
export function newToken(): { credentialId: string; token: string; hash: string } {
  const credentialId = 'c_' + ulid();
  const secret = randomBytes(32).toString('base64url');
  return { credentialId, token: `sm1.${credentialId}.${secret}`, hash: sha256(secret) };
}

export function parseToken(token: string): { credentialId: string; secret: string } | null {
  const m = /^sm1\.(c_[0-9A-Z]{26})\.([A-Za-z0-9_-]{20,})$/.exec(token);
  return m ? { credentialId: m[1], secret: m[2] } : null;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
