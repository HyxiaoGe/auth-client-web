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
import { setState, type AuthUser } from "./store.js";
import { takeRedirectPath } from "./authorize.js";
import { getConfigSnapshot } from "./config.js";
import { AuthClientError } from "./errors.js";
import { createTokenStore } from "./storage.js";

export type CallbackResult =
  | AuthenticatedResult
  | { status: "unauthenticated"; error: string }
  | { status: "no_callback" };

function normalizeCachedUser(value: unknown): AuthUser | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.id === undefined || candidate.id === null || String(candidate.id).trim().length === 0) return null;
  return { ...candidate, id: String(candidate.id) };
}

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
    throw new AuthClientError(
      "auth-client-web: state mismatch on callback (possible CSRF, replay, or forgery).",
      {
        code: "authorization_state_invalid",
        retryable: false,
      },
    );
  }

  // State proven -- now it is safe to consume the one-time material exactly once.
  clearPendingAuth();

  // Provider/IdP reported an error (e.g. login_required from a silent probe).
  if (error !== null) {
    const config = getConfigSnapshot();
    const tokenStore = createTokenStore(config.storageKeys);
    const accessToken = tokenStore.getAccessToken();
    const refreshToken = tokenStore.getRefreshToken();
    const cachedUser = normalizeCachedUser(tokenStore.getUser());
    if (
      accessToken !== null &&
      accessToken.trim().length > 0 &&
      refreshToken !== null &&
      refreshToken.trim().length > 0 &&
      cachedUser !== null
    ) {
      setState({ user: cachedUser, status: "authenticated" });
      return { status: "authenticated", user: cachedUser, redirectPath: takeRedirectPath() };
    }

    // 只有完整 token pair + 有效缓存用户才能恢复认证；残缺持久状态应原子清除。
    tokenStore.clear();
    setState({ user: null, status: "unauthenticated" });
    return { status: "unauthenticated", error };
  }

  // 上面的 no-callback 分支已在运行时证明该不变量；这里显式声明，帮助 TypeScript
  // 在独立的 error 分支收窄之后确认 code 类型。
  if (code === null) {
    throw new AuthClientError("auth-client-web: callback is missing an authorization code.", {
      code: "callback_invalid",
      retryable: false,
    });
  }
  const config = getConfigSnapshot();
  const user = await completeAuthorizationCode(code, pending.verifier, config);
  return { status: "authenticated", user, redirectPath: takeRedirectPath() };
}
