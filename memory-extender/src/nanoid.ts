import { randomBytes } from "crypto";

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function nanoid(length = 10): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => CHARS[b % CHARS.length]).join("");
}
