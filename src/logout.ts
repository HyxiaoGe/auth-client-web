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
  // 必须在本地 clear 前捕获。JWT payload 在这里不作为授权依据，只把 auth-service
  // 已签发票据中的 sid 原样声明给服务端，由服务端与当前 HttpOnly Cookie 再比较。
  const sessionSid = extractSessionSid(store.getAccessToken());
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
    const fields: Record<string, string> = {
      post_logout_redirect_uri: options.postLogoutRedirectUri ?? redirectUri,
      client_id: clientId,
    };
    // 存量 access token 没有 sid 时省略字段，保持 SDK 请求形状兼容；是否接受
    // legacy 全局登出由 auth-service 的 fail-closed 迁移策略决定。
    if (sessionSid !== null) fields.session_sid = sessionSid;
    navigation.submitForm(
      `${authUrl}${sessionSid === null ? "/auth/logout" : "/auth/logout/session"}`,
      fields,
    );
    return;
  }

  if (options.redirectTo !== undefined) {
    navigation.redirect(options.redirectTo);
  }
}

/**
 * 只解析 JWT payload 中形状符合 auth-service opaque session id 的 sid。
 *
 * 浏览器不持有验签密钥，因此返回值绝不能用于本地授权决策；/auth/logout 会把它
 * 与受保护 Cookie 的真实 sid 比较，不一致时必须无副作用拒绝。
 */
function extractSessionSid(accessToken: string | null): string | null {
  if (accessToken === null) return null;
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (payload === undefined || payload.length === 0 || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;

  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const sid = (parsed as Record<string, unknown>).sid;
    return typeof sid === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(sid) ? sid : null;
  } catch {
    return null;
  }
}
