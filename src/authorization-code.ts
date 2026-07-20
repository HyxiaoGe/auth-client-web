/** 顶层跳转与 headless OAuth 流程共享的 authorization code 完成内核。 */

import type { ResolvedConfig } from "./config.js";
import { AuthClientError, isAbortError } from "./errors.js";
import { createTokenStore } from "./storage.js";
import { withSessionMutationLock } from "./session-mutation.js";
import { publishSessionSync } from "./session-sync.js";
import { setState, type AuthUser } from "./store.js";
import { parseTokenResponse } from "./token-response.js";
import { fetchUserInfoForConfig } from "./userinfo.js";

export type AuthenticatedResult = {
  status: "authenticated";
  user: AuthUser;
  redirectPath: string;
};

export type CompleteAuthorizationCodeOptions = {
  signal?: AbortSignal;
  credentials?: RequestCredentials;
  state?: string;
  redirectUri?: string;
};

export type PreparedAuthenticatedSession = {
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  };
  user: AuthUser;
};

/**
 * 使用原始事务绑定的 verifier 兑换 authorization code，然后持久化会话并发布认证用户。
 * 调用方进入此函数前必须自行校验 state，并消费对应 pending 材料。
 */
export async function completeAuthorizationCode(
  authorizationCode: string,
  codeVerifier: string,
  config: ResolvedConfig,
  options: CompleteAuthorizationCodeOptions = {},
): Promise<AuthUser> {
  return withSessionMutationLock(config, async () => {
    const session = await exchangeAuthorizationCode(authorizationCode, codeVerifier, config, options);
    commitAuthenticatedSession(session, config);
    return session.user;
  });
}

/**
 * 完成 code exchange 与 userinfo，但不触碰持久化和全局 store。
 * 对账流程用它在提交前给宿主一个清理旧用户业务状态的同步屏障。
 */
export async function exchangeAuthorizationCode(
  authorizationCode: string,
  codeVerifier: string,
  config: ResolvedConfig,
  options: CompleteAuthorizationCodeOptions = {},
): Promise<PreparedAuthenticatedSession> {
  let res: Response;
  try {
    res = await fetch(`${config.authUrl}/auth/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: options.credentials,
      signal: options.signal,
      body: JSON.stringify({
        code: authorizationCode,
        client_id: config.clientId,
        code_verifier: codeVerifier,
        ...(options.redirectUri === undefined ? {} : { redirect_uri: options.redirectUri }),
        ...(options.state === undefined ? {} : { state: options.state }),
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
    user = await fetchUserInfoForConfig(tokens.access_token, config, options.signal);
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
  return {
    tokens: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
    },
    user,
  };
}

/** 以 fail-closed 语义一次性提交已完整验证的 token + user，并发布认证态。 */
export function commitAuthenticatedSession(
  session: PreparedAuthenticatedSession,
  config: ResolvedConfig,
): void {
  const store = createTokenStore(config.storageKeys);
  try {
    store.setAuthenticatedSession(session.tokens, session.user);
  } catch (error) {
    // 持久层已经 fail closed；同步收敛内存状态，绝不发布仅写入一半的新用户会话。
    setState({ user: null, status: "unauthenticated" });
    throw error;
  }
  setState({ user: session.user, status: "authenticated" });
  publishSessionSync("switched", config);
}
