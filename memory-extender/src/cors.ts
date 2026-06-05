// CORS origin policy.
//
// The sidecar binds to 127.0.0.1, but any web page the user visits can still
// fetch() it. With Access-Control-Allow-Origin: * the browser would let a remote
// page READ the responses — i.e. read/exfiltrate the user's memory store. So we
// only echo the origin back (allowing the read) when it's a loopback origin
// (where the extension/setup page live) or an explicitly configured one. A
// remote page (https://evil.example) gets no ACAO header, so the browser blocks
// it from reading the response.

export function allowedCorsOrigin(origin: string | undefined): string | null {
  if (!origin) return null; // not a browser cross-origin request — no header needed
  const extra = process.env.MARINARA_EXTENDER_ALLOWED_ORIGIN;
  if (extra && origin === extra) return origin;
  try {
    const host = new URL(origin).hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]") {
      return origin;
    }
  } catch {
    // malformed Origin — deny
  }
  return null;
}
