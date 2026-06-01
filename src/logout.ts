/**
 * Logout: best-effort revoke this app's refresh token, then unconditionally clear the local
 * session and flip the store to unauthenticated. Logout must NEVER leave a user stuck
 * "logged in" locally because the network hiccuped, so the wire call is wrapped and ignored
 * on failure -- the local clear always runs.
 *
 * Two modes:
 *  - default (per-app): clear locally, then optionally redirect to `redirectTo`.
 *  - `{ global: true }` (Single Logout): after the local clear, a top-level POST-form
 *    navigation to `${authUrl}/auth/logout` destroys the shared IdP session so EVERY app
 *    signs out. A top-level navigation is required because the SameSite=Lax session cookie
 *    only rides top-level navigations, and /auth/logout is POST-only -- hence a submitted
 *    form, not a GET redirect. auth-service 302s back to `postLogoutRedirectUri`, which must
 *    be a registered redirect_uri (defaults to this app's `redirectUri`, already registered).
 */

import { getConfig } from "./config.js";
import * as navigation from "./navigation.js";
import { tokenStore } from "./session.js";
import { setState } from "./store.js";

export type LogoutOptions = {
  /** Where to send the browser after the local session is cleared (per-app logout only). */
  redirectTo?: string;
  /** End the shared IdP session too (cross-app Single Logout), not just this app. */
  global?: boolean;
  /** Where auth-service should 302 back after a global logout. Must be a registered
   * redirect_uri; defaults to this app's configured `redirectUri`. */
  postLogoutRedirectUri?: string;
};

export async function logout(options: LogoutOptions = {}): Promise<void> {
  const store = tokenStore();
  const refreshToken = store.getRefreshToken();

  if (refreshToken !== null) {
    const { authUrl } = getConfig();
    try {
      await fetch(`${authUrl}/auth/token/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch {
      // best-effort: a failed revoke must not block the local clear below
    }
  }

  store.clear();
  setState({ user: null, status: "unauthenticated" });

  if (options.global) {
    // Single Logout: top-level POST-form so the SameSite=Lax cookie reaches POST-only
    // /auth/logout, which destroys the IdP session and 302s back to a registered uri.
    const { authUrl, clientId, redirectUri } = getConfig();
    navigation.submitForm(`${authUrl}/auth/logout`, {
      post_logout_redirect_uri: options.postLogoutRedirectUri ?? redirectUri,
      client_id: clientId,
    });
    return;
  }

  if (options.redirectTo !== undefined) {
    navigation.redirect(options.redirectTo);
  }
}
