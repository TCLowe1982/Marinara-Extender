// Marinara Extender
// Copyright (C) 2026 TC Lowe
// Licensed under AGPL-3.0-only. See LICENSE.

// fetch with retry/backoff for transient upstream failures — used for external
// LLM calls so a bulk import (many sequential calls) survives provider rate
// limits and brief overloads instead of failing the whole run.

const RETRYABLE_STATUS = new Set([429, 503, 529]); // rate limit, unavailable, overloaded

function backoffMs(attempt: number, baseMs: number): number {
  const expo = Math.min(15_000, baseMs * 2 ** attempt);
  return expo + Math.floor(Math.random() * 250); // jitter to de-sync concurrent callers
}

export async function fetchWithBackoff(
  url: string,
  init: RequestInit,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<Response> {
  const { attempts = 4, baseMs = 600 } = opts;
  for (let i = 0; ; i++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (i >= attempts - 1) throw err; // network error — retry a few times
      await new Promise((r) => setTimeout(r, backoffMs(i, baseMs)));
      continue;
    }
    if (res.ok || !RETRYABLE_STATUS.has(res.status) || i >= attempts - 1) return res;
    // Honor Retry-After when the server provides it; otherwise exponential backoff.
    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(i, baseMs);
    console.warn(`[ME:http] ${res.status} from upstream — retrying in ${Math.round(wait)}ms (attempt ${i + 1}/${attempts})`);
    await new Promise((r) => setTimeout(r, wait));
  }
}
