import { describe, expect, it } from "vitest";

import { generatePkce } from "../src/pkce.js";

describe("generatePkce", () => {
  it("derives the RFC 7636 Appendix B challenge from a known verifier", async () => {
    // This vector MUST match auth-service's verify_pkce (RFC 7636 Appendix B). If the
    // frontend and backend disagree on the S256 transform, every SSO exchange fails.
    const { verifier, challenge, method } = await generatePkce(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    );
    expect(verifier).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(method).toBe("S256");
  });

  it("emits a base64url challenge with no padding and no +/ characters", async () => {
    const { challenge } = await generatePkce("another-verifier-value-123456789");
    expect(challenge).not.toContain("=");
    expect(challenge).not.toContain("+");
    expect(challenge).not.toContain("/");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates a fresh RFC-compliant verifier when none is supplied", async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.verifier).not.toBe(b.verifier); // random each call
    // RFC 7636 §4.1: 43..128 chars from the unreserved set.
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    expect(a.verifier.length).toBeLessThanOrEqual(128);
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is deterministic: same verifier always yields the same challenge", async () => {
    const v = "repeatable-verifier-abcdefghijklmnop";
    const first = await generatePkce(v);
    const second = await generatePkce(v);
    expect(first.challenge).toBe(second.challenge);
  });
});
