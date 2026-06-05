// Security hardening unit tests: id sanitization + CORS origin policy.

import { describe, it, expect, afterEach } from "vitest";
import { assertSafeId } from "../storage.js";
import { allowedCorsOrigin } from "../cors.js";

describe("assertSafeId (path-traversal guard)", () => {
  it("accepts normal nanoid/uuid-style ids", () => {
    expect(() => assertSafeId("professor_mari")).not.toThrow();
    expect(() => assertSafeId("lLllj_HkCCu1LvuuWcRjv")).not.toThrow();
    expect(() => assertSafeId("char-123_ABC")).not.toThrow();
  });
  it("rejects separators, traversal, and null bytes", () => {
    for (const bad of ["..", "../etc", "a/b", "a\\b", "../../secret", "x\0y", ""]) {
      expect(() => assertSafeId(bad), bad).toThrow();
    }
  });
});

describe("allowedCorsOrigin (loopback-only)", () => {
  afterEach(() => { delete process.env.MARINARA_EXTENDER_ALLOWED_ORIGIN; });

  it("reflects loopback origins", () => {
    expect(allowedCorsOrigin("http://127.0.0.1:7860")).toBe("http://127.0.0.1:7860");
    expect(allowedCorsOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(allowedCorsOrigin("http://[::1]:3000")).toBe("http://[::1]:3000");
  });
  it("denies remote origins (no ACAO → browser blocks the read)", () => {
    expect(allowedCorsOrigin("https://evil.example")).toBeNull();
    expect(allowedCorsOrigin("https://marinara.evil.com")).toBeNull();
    expect(allowedCorsOrigin("garbage")).toBeNull();
  });
  it("returns null when there is no Origin (non-browser request)", () => {
    expect(allowedCorsOrigin(undefined)).toBeNull();
  });
  it("honors an explicitly configured extra origin", () => {
    process.env.MARINARA_EXTENDER_ALLOWED_ORIGIN = "https://my.marinara.host";
    expect(allowedCorsOrigin("https://my.marinara.host")).toBe("https://my.marinara.host");
    expect(allowedCorsOrigin("https://other.host")).toBeNull();
  });
});
