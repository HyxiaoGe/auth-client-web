/** 顶层跳转与 headless OAuth 流程共享的 authorization code 完成内核。 */

import type { ResolvedConfig } from "./config.js";
import { createTokenStore } from "./storage.js";
import { setState, type AuthUser } from "./store.js";
import { fetchUserInfoForConfig } from "./userinfo.js";

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
};

export type AuthenticatedResult = {
  status: "authenticated";
  user: AuthUser;
  redirectPath: string;
};

/**
 * 使用原始事务绑定的 verifier 兑换 authorization code，然后持久化会话并发布认证用户。
 * 调用方进入此函数前必须自行校验 state，并消费对应 pending 材料。
 */
export async function completeAuthorizationCode(
  authorizationCode: string,
  codeVerifier: string,
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<AuthUser> {
  const res = await fetch(`${config.authUrl}/auth/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      code: authorizationCode,
      client_id: config.clientId,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`auth-client-web: token exchange failed (${res.status}).`);
  }

  const tokens = (await res.json()) as TokenResponse;
  // userinfo 成功前不触碰旧会话；失败或取消时，旧 token、旧 user 和全局 store
  // 必须作为一个整体保持不变，避免新 token 与旧用户错配。
  const user = await fetchUserInfoForConfig(tokens.access_token, config, signal);
  const store = createTokenStore(config.storageKeys);
  store.setSession({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
  });
  store.setUser(user);
  setState({ user, status: "authenticated" });
  return user;
}
