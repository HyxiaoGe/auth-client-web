/**
 * Local logout: best-effort revoke this app's refresh token, then unconditionally clear the
 * local session and flip the store to unauthenticated. Logout must NEVER leave a user stuck
 * "logged in" locally because the network hiccuped, so the wire call is wrapped and ignored
 * on failure -- the local clear always runs.
 *
 * This is per-app logout. Cross-app Single Logout (destroying the shared IdP session so every
 * app signs out) requires a top-level navigation to auth-service and is handled separately.
 */

import { getConfig } from "./config.js";
import * as navigation from "./navigation.js";
import { tokenStore } from "./session.js";
import { setState } from "./store.js";

export type LogoutOptions = {
  /** Where to send the browser after the local session is cleared. */
  redirectTo?: string;
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

  if (options.redirectTo !== undefined) {
    navigation.redirect(options.redirectTo);
  }
}
