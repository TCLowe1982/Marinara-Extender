// Holds the most-recently-seen Authorization header from a generation request.
// The sidecar never stores API keys to disk — this cache lives only in memory
// and is used solely for digest operations the user triggers from the panel.

let cachedAuth: string | null = null;

export function cacheAuthHeader(value: string): void {
  cachedAuth = value;
}

export function getCachedAuth(): string | null {
  // Stored key (from .env or env var) takes priority over the per-request cache.
  const stored = process.env.MARINARA_EXTENDER_API_KEY;
  if (stored) return `Bearer ${stored}`;
  return cachedAuth;
}
