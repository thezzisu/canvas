import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, hash: string) {
  const [salt, key] = hash.split(":");
  if (!salt || !key || key.length !== 128) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(key, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function bearerToken(header: string | undefined): string {
  return /^Bearer ([A-Za-z0-9_-]{1,256})$/u.exec(header || '')?.[1] || '';
}

export function parseAllowedOrigins(value = ''): Set<string> {
  return new Set(value.split(',').map(value => value.trim()).filter(Boolean).map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password)
      throw new Error('CANVAS_ALLOWED_ORIGINS must contain exact HTTP(S) origins');
    return url.origin;
  }));
}

export function allowedOrigin(origin: string, requestOrigin: string, allowed: ReadonlySet<string>): boolean {
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === origin
      && (origin === requestOrigin || allowed.has(origin));
  } catch { return false; }
}
