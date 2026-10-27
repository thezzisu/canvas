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
export function sessionCookie(header: string | undefined) {
  return (
    header
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("canvas_session="))
      ?.slice(15) ?? ""
  );
}
