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

import { completeAuthorizationCode, type AuthenticatedResult } from "./authorization-code.js";
import { clearPendingAuth, peekPendingAuth } from "./pending.js";
import { setState } from "./store.js";
import { takeRedirectPath } from "./authorize.js";
import { getConfigSnapshot } from "./config.js";

export type CallbackResult =
  | AuthenticatedResult
  | { status: "unauthenticated"; error: string }
  | { status: "no_callback" };

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

  // 上面的 no-callback 分支已在运行时证明该不变量；这里显式声明，帮助 TypeScript
  // 在独立的 error 分支收窄之后确认 code 类型。
  if (code === null) {
    throw new Error("auth-client-web: callback is missing an authorization code.");
  }
  const config = getConfigSnapshot();
  const user = await completeAuthorizationCode(code, pending.verifier, config);
  return { status: "authenticated", user, redirectPath: takeRedirectPath() };
}
