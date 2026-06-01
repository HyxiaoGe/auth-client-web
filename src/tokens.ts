/**
 * Access-token accessor with on-demand refresh.
 *
 * `getAccessToken()` is the single read path the rest of the SDK (and apps) use. If the
 * stored token is still within its skew window it is returned as-is; otherwise a refresh is
 * triggered. Concurrent callers during a refresh are COALESCED onto one in-flight promise,
 * so a page that fires N requests on load performs exactly one /token/refresh -- important
 * because refresh tokens rotate, and a refresh storm would otherwise invalidate itself.
 *
 * (Cross-tab coalescing via the Web Locks API is a deliberate follow-up; this covers the
 * dominant single-tab case. Cross-tab races degrade gracefully to a 401 + re-auth.)
 */

import { getConfig } from "./config.js";
import { tokenStore } from "./session.js";
import { setState } from "./store.js";

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
};

let inFlight: Promise<string | null> | null = null;

export async function getAccessToken(): Promise<string | null> {
  const store = tokenStore();
  if (!store.isExpired()) {
    return store.getAccessToken();
  }
  return refresh();
}

/** Force a refresh, coalescing concurrent callers onto a single network request. */
export function refresh(): Promise<string | null> {
  if (inFlight) return inFlight;
  inFlight = doRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doRefresh(): Promise<string | null> {
  const store = tokenStore();
  const refreshToken = store.getRefreshToken();
  if (refreshToken === null) {
    setState({ user: null, status: "unauthenticated" });
    return null;
  }

  const { authUrl } = getConfig();
  const res = await fetch(`${authUrl}/auth/token/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    // Cross-tab rotation guard: refresh tokens rotate, so a sibling tab may have already spent
    // ours and persisted a fresh pair -- in which case THIS 401 is stale, not a real logout. Only
    // clear the session if the stored refresh token is still the one we just sent.
    if (store.getRefreshToken() !== refreshToken) {
      return store.getAccessToken();
    }
    store.clear();
    setState({ user: null, status: "unauthenticated" });
    return null;
  }
  const tokens = (await res.json()) as TokenResponse;
  store.setSession({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
  });
  return tokens.access_token;
}

/** Test hook: drop any in-flight refresh between cases. */
export function resetTokens(): void {
  inFlight = null;
}
