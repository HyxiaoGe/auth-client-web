/**
 * Fetch the current user's profile from auth-service. The backend speaks snake_case
 * (`avatar_url`); we normalize the avatar to the SDK's `avatarUrl` while passing through
 * the rest of the payload (is_superuser, preferences, ...) so apps can read app-specific
 * fields without the SDK having to know about them.
 */

import { getConfigSnapshot, type ResolvedConfig } from "./config.js";
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
  const res = await fetch(`${config.authUrl}/auth/userinfo`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!res.ok) {
    throw new Error(`auth-client-web: userinfo failed (${res.status})`);
  }
  const raw = (await res.json()) as Record<string, unknown> & { avatar_url?: unknown };
  const { avatar_url, ...rest } = raw;
  // Identity is the whole point of userinfo: refuse to fabricate one. Without this, a response
  // missing `id` would coerce to the literal string "undefined" and silently corrupt every
  // downstream consumer (cache keys, audit logs, current-user comparisons) across the SSO fleet.
  if (rest.id === undefined || rest.id === null || rest.id === "") {
    throw new Error("auth-client-web: userinfo response is missing a user id.");
  }
  const user: AuthUser = { ...rest, id: String(rest.id) };
  if (typeof avatar_url === "string") user.avatarUrl = avatar_url;
  return user;
}
