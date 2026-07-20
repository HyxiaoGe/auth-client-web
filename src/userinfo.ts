/**
 * Fetch the current user's profile from auth-service. The backend speaks snake_case
 * (`avatar_url`); we normalize the avatar to the SDK's `avatarUrl` while passing through
 * the rest of the payload (is_superuser, preferences, ...) so apps can read app-specific
 * fields without the SDK having to know about them.
 */

import { getConfigSnapshot, type ResolvedConfig } from "./config.js";
import { AuthClientError, isAbortError, isRetryableStatus } from "./errors.js";
import type { AuthUser } from "./store.js";

export async function fetchUserInfo(accessToken: string): Promise<AuthUser> {
  return fetchUserInfoForConfig(accessToken, getConfigSnapshot());
}

/** 使用调用方在首次网络等待前捕获的配置读取用户，供完整授权事务内部复用。 */
export async function fetchUserInfoForConfig(
  accessToken: string,
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<AuthUser> {
  let res: Response;
  try {
    res = await fetch(`${config.authUrl}/auth/userinfo`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new AuthClientError("auth-client-web: userinfo failed (network error)", {
      code: "userinfo_failed",
      retryable: true,
      cause,
    });
  }
  if (!res.ok) {
    throw new AuthClientError(`auth-client-web: userinfo failed (${res.status})`, {
      code: "userinfo_failed",
      status: res.status,
      retryable: isRetryableStatus(res.status),
    });
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (cause) {
    throw new AuthClientError("auth-client-web: userinfo response is invalid JSON.", {
      code: "userinfo_invalid_response",
      status: res.status,
      retryable: false,
      cause,
    });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AuthClientError("auth-client-web: userinfo response is invalid.", {
      code: "userinfo_invalid_response",
      status: res.status,
      retryable: false,
    });
  }
  const { avatar_url, ...rest } = raw as Record<string, unknown>;
  // Identity is the whole point of userinfo: refuse to fabricate one. Without this, a response
  // missing `id` would coerce to the literal string "undefined" and silently corrupt every
  // downstream consumer (cache keys, audit logs, current-user comparisons) across the SSO fleet.
  if (rest.id === undefined || rest.id === null || rest.id === "") {
    throw new AuthClientError("auth-client-web: userinfo response is missing a user id.", {
      code: "userinfo_invalid_response",
      status: res.status,
      retryable: false,
    });
  }
  const user: AuthUser = { ...rest, id: String(rest.id) };
  if (typeof avatar_url === "string") user.avatarUrl = avatar_url;
  return user;
}
