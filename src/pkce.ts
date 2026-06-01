/**
 * PKCE (RFC 7636) for the public-client browser flow.
 *
 * The S256 transform here MUST agree byte-for-byte with auth-service's `verify_pkce`
 * (BASE64URL(SHA256(verifier)) with no padding); the shared RFC 7636 Appendix B vector
 * is the contract test on both sides. Uses the Web Crypto API (browser + Node 18+).
 */

import { base64UrlEncode, randomUrlSafe } from "./encoding.js";

export type PkcePair = {
  verifier: string;
  challenge: string;
  method: "S256";
};

/**
 * Produce a PKCE pair. Pass an explicit `verifier` only in tests / to reproduce a vector;
 * production callers omit it so a cryptographically random verifier is generated (a fresh
 * 43-char base64url string, within RFC 7636 §4.1's 43..128 unreserved range).
 */
export async function generatePkce(verifier?: string): Promise<PkcePair> {
  const v = verifier ?? randomUrlSafe(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return { verifier: v, challenge: base64UrlEncode(new Uint8Array(digest)), method: "S256" };
}
