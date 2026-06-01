/**
 * The callback handler -- the security heart of the SDK. After /authorize redirects the
 * browser back to the app's redirect_uri, the app calls handleCallback() once on that page.
 *
 * It enforces, in order:
 *   1. CSRF: the returned `state` must match the one we persisted before redirecting, and
 *      the pending material (state + verifier) must exist at all. Either failure aborts
 *      BEFORE the code is exchanged, so a forged/replayed callback never burns a real code.
 *   2. PKCE: the persisted code_verifier is threaded into the token exchange, proving this
 *      browser initiated the flow.
 *
 * `error=login_required` is the expected outcome of a silent (prompt=none) probe against a
 * cold IdP session; it is reported as a benign unauthenticated result, not thrown.
 */

import { getConfig } from "./config.js";
import { clearPendingAuth, peekPendingAuth } from "./pending.js";
import { tokenStore } from "./session.js";
import { setState, type AuthUser } from "./store.js";
import { fetchUserInfo } from "./userinfo.js";
import { takeRedirectPath } from "./authorize.js";

export type CallbackResult =
  | { status: "authenticated"; user: AuthUser; redirectPath: string }
  | { status: "unauthenticated"; error: string }
  | { status: "no_callback" };

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
};

export async function handleCallback(url: string = window.location.href): Promise<CallbackResult> {
  const params = new URL(url).searchParams;
  const code = params.get("code");
  const error = params.get("error");
  const returnedState = params.get("state");

  // Not a callback at all -- don't touch app state.
  if (code === null && error === null) {
    return { status: "no_callback" };
  }

  // CSRF gate FIRST, and crucially BEFORE consuming the pending material. We only *peek* here so
  // that an unverifiable callback (forged ?error=...&state=..., a code with a mismatched state, a
  // replay) cannot burn the victim's in-flight verifier -- which would otherwise let an attacker
  // who can land the browser on the redirect_uri sabotage the genuine login. auth-service echoes
  // the real high-entropy state on BOTH success and error, so a mismatch is always illegitimate.
  const pending = peekPendingAuth();
  if (pending === null || returnedState !== pending.state) {
    throw new Error("auth-client-web: state mismatch on callback (possible CSRF, replay, or forgery).");
  }

  // State proven -- now it is safe to consume the one-time material exactly once.
  clearPendingAuth();

  // Provider/IdP reported an error (e.g. login_required from a silent probe).
  if (error !== null) {
    setState({ user: null, status: "unauthenticated" });
    return { status: "unauthenticated", error };
  }

  const { authUrl, clientId } = getConfig();
  const res = await fetch(`${authUrl}/auth/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, client_id: clientId, code_verifier: pending.verifier }),
  });
  if (!res.ok) {
    throw new Error(`auth-client-web: token exchange failed (${res.status}).`);
  }
  const tokens = (await res.json()) as TokenResponse;
  const store = tokenStore();
  store.setSession({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
  });

  const user = await fetchUserInfo(tokens.access_token);
  store.setUser(user);
  setState({ user, status: "authenticated" });

  return { status: "authenticated", user, redirectPath: takeRedirectPath() };
}
