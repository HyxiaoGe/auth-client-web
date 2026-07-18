/**
 * Headless OAuth 授权原语。
 *
 * 这些 API 不感知邮箱、短信、OTP 投递或具体 UI。应用将准备好的 OAuth 公开参数交给
 * auth-service 的具体交互，再使用这里保存的事务级 PKCE verifier 完成返回的授权码。
 */

import { completeAuthorizationCode, type AuthenticatedResult } from "./authorization-code.js";
import {
  clearPendingAuthorization,
  createPendingAuthorization,
  peekPendingAuthorization,
} from "./authorization-pending.js";
import { getConfigSnapshot } from "./config.js";
import { generatePkce } from "./pkce.js";

export type PrepareAuthorizationOptions = {
  redirectPath?: string;
};

export type PreparedAuthorization = {
  responseType: "code";
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
};

export type CompleteAuthorizationOptions = {
  authorizationCode: string;
  state: string;
  signal?: AbortSignal;
};

type InFlightCompletion = {
  authorizationCode: string;
  promise: Promise<AuthenticatedResult>;
};

const inFlightCompletions = new Map<string, InFlightCompletion>();

export async function prepareAuthorization(
  options: PrepareAuthorizationOptions = {},
): Promise<PreparedAuthorization> {
  const config = getConfigSnapshot();
  const { authUrl, clientId, redirectUri } = config;
  const { verifier, challenge, method } = await generatePkce();
  const pending = createPendingAuthorization({
    verifier,
    authUrl,
    clientId,
    redirectUri,
    redirectPath: options.redirectPath,
  });

  return {
    responseType: "code",
    clientId,
    redirectUri,
    state: pending.state,
    codeChallenge: challenge,
    codeChallengeMethod: method,
  };
}

export function completeAuthorization(options: CompleteAuthorizationOptions): Promise<AuthenticatedResult> {
  const existing = inFlightCompletions.get(options.state);
  if (existing !== undefined) {
    if (existing.authorizationCode === options.authorizationCode) return existing.promise;
    return Promise.reject(
      new Error("auth-client-web: conflicting authorization code for an in-flight state."),
    );
  }

  const completion = doCompleteAuthorization(options).finally(() => {
    if (inFlightCompletions.get(options.state)?.promise === completion) {
      inFlightCompletions.delete(options.state);
    }
  });
  inFlightCompletions.set(options.state, {
    authorizationCode: options.authorizationCode,
    promise: completion,
  });
  return completion;
}

async function doCompleteAuthorization(options: CompleteAuthorizationOptions): Promise<AuthenticatedResult> {
  if (options.authorizationCode.length === 0) {
    throw new Error("auth-client-web: authorization code must not be empty.");
  }

  const pending = peekPendingAuthorization(options.state);
  if (pending === null) {
    throw new Error("auth-client-web: unknown, expired, or mismatched state for authorization completion.");
  }

  const config = getConfigSnapshot();
  const { authUrl, clientId, redirectUri } = config;
  if (pending.authUrl !== authUrl || pending.clientId !== clientId || pending.redirectUri !== redirectUri) {
    throw new Error("auth-client-web: authorization transaction does not match the active client configuration.");
  }

  // state 与客户端绑定已经验证。在首次网络等待前消费事务，避免重放或独立调用方
  // 再次使用同一 authorization code/verifier。
  clearPendingAuthorization(options.state);
  const user = await completeAuthorizationCode(
    options.authorizationCode,
    pending.verifier,
    config,
    options.signal,
  );
  return { status: "authenticated", user, redirectPath: pending.redirectPath };
}

export function cancelAuthorization(state: string): void {
  clearPendingAuthorization(state);
}

export type { AuthenticatedResult } from "./authorization-code.js";
