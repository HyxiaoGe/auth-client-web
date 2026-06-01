/**
 * Persists the one in-flight authorization across the top-level redirect to /authorize.
 *
 * The CSRF `state` and the PKCE `code_verifier` are generated before navigating away and
 * must be recovered on the callback page. They live in sessionStorage (cleared on tab
 * close, not shared cross-tab) under fixed keys -- only one auth can be in flight at a
 * time because the redirect replaces the page.
 */

import { randomUrlSafe } from "./encoding.js";

const STATE_KEY = "acw_oauth_state";
const VERIFIER_KEY = "acw_pkce_verifier";

export type PendingAuth = {
  state: string;
  verifier: string;
};

/** Generate + persist a fresh state for this `verifier`, returning the state to send. */
export function startPendingAuth(verifier: string): string {
  const state = randomUrlSafe(32);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  return state;
}

/** Read the pending auth WITHOUT consuming it. Returns null if nothing (or only part) is pending. */
export function peekPendingAuth(): PendingAuth | null {
  const state = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (state === null || verifier === null) return null;
  return { state, verifier };
}

/** Drop the pending auth. Used to consume it only AFTER the CSRF state has been verified. */
export function clearPendingAuth(): void {
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
}

/** Read and clear the pending auth. Returns null if nothing (or only part) is pending. */
export function takePendingAuth(): PendingAuth | null {
  const pending = peekPendingAuth();
  clearPendingAuth();
  return pending;
}
