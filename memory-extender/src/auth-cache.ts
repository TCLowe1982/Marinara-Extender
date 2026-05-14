// Holds the API key used for digest (past-chat import) operations.
// Priority: MARINARA_EXTENDER_API_KEY env var → in-memory cache (unused without proxy).

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
