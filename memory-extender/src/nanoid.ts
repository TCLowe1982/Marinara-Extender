// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

import { randomBytes } from "crypto";

const CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function nanoid(length = 10): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => CHARS[b % CHARS.length]).join("");
}
