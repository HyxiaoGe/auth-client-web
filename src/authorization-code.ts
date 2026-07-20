/** 顶层跳转与 headless OAuth 流程共享的 authorization code 完成内核。 */

import type { ResolvedConfig } from "./config.js";
import { AuthClientError, isAbortError } from "./errors.js";
import { createTokenStore } from "./storage.js";
import { setState, type AuthUser } from "./store.js";
import { parseTokenResponse } from "./token-response.js";
import { fetchUserInfoForConfig } from "./userinfo.js";

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
  let res: Response;
  try {
    res = await fetch(`${config.authUrl}/auth/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        code: authorizationCode,
        client_id: config.clientId,
        code_verifier: codeVerifier,
      }),
    });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new AuthClientError("auth-client-web: token exchange failed (network error).", {
      code: "token_exchange_failed",
      retryable: false,
      cause,
    });
  }
  if (!res.ok) {
    throw new AuthClientError(`auth-client-web: token exchange failed (${res.status}).`, {
      code: "token_exchange_failed",
      status: res.status,
      retryable: false,
    });
  }

  const tokens = await parseTokenResponse(res, {
    code: "token_exchange_invalid_response",
    message: "auth-client-web: token exchange returned an invalid token response.",
    retryable: false,
  });
  // userinfo 成功前不触碰旧会话；失败或取消时，旧 token、旧 user 和全局 store
  // 必须作为一个整体保持不变，避免新 token 与旧用户错配。
  let user: AuthUser;
  try {
    user = await fetchUserInfoForConfig(tokens.access_token, config, signal);
  } catch (error) {
    // state/verifier 已在首次网络等待前消费，authorization code 也可能已被服务端兑换。
    // 即便底层 userinfo 失败本身可重试，调用方也无法安全重放整笔授权事务。
    if (error instanceof AuthClientError && error.retryable) {
      throw new AuthClientError(error.message, {
        code: error.code,
        status: error.status,
        retryable: false,
        cause: error,
      });
    }
    throw error;
  }
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
