// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// CSRF protection for mutating requests (MarinaraExtender-cb4).
//
// The sidecar binds to 127.0.0.1, and CORS (cors.ts) already stops a remote
// page from READING responses — but a cross-origin "simple" request (form or
// text/plain POST, no preflight) still EXECUTES server-side even though the
// response is unreadable. Body-less mutating endpoints (/api/cleanup and
// friends) were genuinely exposed.
//
// The rule, applied to every non-GET /api/* request:
//   - No Origin header -> allow. Browsers ALWAYS send Origin on cross-origin
//     requests and on same-origin fetch POSTs, so an Origin-less mutating
//     request is a non-browser client (node script, curl) — local tooling
//     that cannot be CSRF'd.
//   - Origin present  -> the origin must pass the CORS allowlist AND the
//     request must carry the per-process token in the x-me-csrf header.
//     The token is readable at GET /api/csrf-token, whose response only
//     loopback/configured origins can read (CORS) — a remote page can
//     neither read the token nor send the custom header without a preflight
//     it will fail.
//
// The token is minted fresh per process, so a sidecar restart invalidates
// clients — the extension refreshes on 403 and retries once.

import { randomBytes } from "crypto";
import { allowedCorsOrigin } from "./cors.js";

export const CSRF_HEADER = "x-me-csrf";

const TOKEN = randomBytes(24).toString("hex");

export function csrfToken(): string {
  return TOKEN;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Returns the rejection reason, or null when the request may proceed.
export function csrfRejection(
  method: string,
  origin: string | undefined,
  tokenHeader: unknown,
): string | null {
  if (SAFE_METHODS.has(method.toUpperCase())) return null;
  if (!origin) return null; // non-browser client — not CSRF-able
  if (!allowedCorsOrigin(origin)) return `origin not allowed: ${origin}`;
  if (tokenHeader !== TOKEN) return "missing or stale x-me-csrf token (GET /api/csrf-token)";
  return null;
}
