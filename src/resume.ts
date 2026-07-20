/**
 * 在宿主没有本地 access token 时，尝试从浏览器的中央 IdP Cookie 恢复会话。
 *
 * PKCE verifier 与 state 只存在于本次调用内存。服务端仅返回绑定当前 client、
 * redirect_uri、state 和 PKCE challenge 的一次性 authorization code；完整 token 与
 * userinfo 验证成功后才原子提交本地会话。
 */

import {
  commitAuthenticatedSession,
  exchangeAuthorizationCode,
} from "./authorization-code.js";
import { getConfigSnapshot, type ResolvedConfig } from "./config.js";
import { randomUrlSafe } from "./encoding.js";
import { AuthClientError, isAbortError, isRetryableStatus } from "./errors.js";
import { generatePkce } from "./pkce.js";
import { withSessionMutationLock } from "./session-mutation.js";
import { createTokenStore } from "./storage.js";
import type { AuthUser } from "./store.js";

export type ResumeSessionOptions = {
  signal?: AbortSignal;
  /**
   * 新 token 与 userinfo 已验证、但尚未写入宿主 localStorage 前执行。
   * 宿主应在这里中止旧身份请求并清理用户绑定缓存，避免恢复后的新身份看到旧身份数据。
   */
  beforeCommit?: (context: { user: AuthUser }) => void | Promise<void>;
};

export type ResumeSessionResult =
  | { status: "local_session" }
  | { status: "no_session" }
  | { status: "resumed"; user: AuthUser };

type ResumeResponse =
  | { status: "no_session" }
  | { status: "resume_required"; code: string; state: string };

const inFlightByClient = new Map<string, Promise<ResumeSessionResult>>();

export function resumeSession(options: ResumeSessionOptions = {}): Promise<ResumeSessionResult> {
  const config = getConfigSnapshot();
  const current = inFlightByClient.get(config.clientId);
  if (current !== undefined) return current;

  const operation = withSessionMutationLock(config, () => doResume(config, options)).finally(() => {
    if (inFlightByClient.get(config.clientId) === operation) {
      inFlightByClient.delete(config.clientId);
    }
  });
  inFlightByClient.set(config.clientId, operation);
  return operation;
}

async function doResume(
  config: ResolvedConfig,
  options: ResumeSessionOptions,
): Promise<ResumeSessionResult> {
  const store = createTokenStore(config.storageKeys);
  if (store.getAccessToken() !== null) return { status: "local_session" };

  const { verifier, challenge, method } = await generatePkce();
  const state = randomUrlSafe(32);
  let response: Response;
  try {
    response = await fetch(`${config.authUrl}/auth/session/resume`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      signal: options.signal,
      body: JSON.stringify({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: method,
      }),
    });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw resumeFailure("auth-client-web: session resume failed (network error).", {
      retryable: true,
      cause,
    });
  }

  if (!response.ok) {
    throw resumeFailure(`auth-client-web: session resume failed (${response.status}).`, {
      status: response.status,
      retryable: isRetryableStatus(response.status),
    });
  }

  const resumed = await parseResumeResponse(response);
  if (resumed.status === "no_session") return resumed;
  if (resumed.state !== state) {
    throw invalidResumeResponse(response.status, "returned a mismatched state");
  }

  let prepared: Awaited<ReturnType<typeof exchangeAuthorizationCode>>;
  try {
    prepared = await exchangeAuthorizationCode(resumed.code, verifier, config, {
      signal: options.signal,
      credentials: "include",
      state,
      redirectUri: config.redirectUri,
    });
    await options.beforeCommit?.({ user: prepared.user });
    commitAuthenticatedSession(prepared, config);
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    const authError = cause instanceof AuthClientError ? cause : null;
    throw resumeFailure("auth-client-web: session resume could not be completed.", {
      status: authError?.status,
      retryable: authError?.retryable ?? false,
      cause,
    });
  }

  return { status: "resumed", user: prepared.user };
}

async function parseResumeResponse(response: Response): Promise<ResumeResponse> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (cause) {
    throw new AuthClientError("auth-client-web: session resume returned invalid JSON.", {
      code: "session_resume_invalid_response",
      status: response.status,
      retryable: false,
      blocking: false,
      cause,
    });
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidResumeResponse(response.status);
  }
  const record = raw as Record<string, unknown>;
  if (record.status === "no_session") return { status: "no_session" };
  if (
    record.status === "resume_required" &&
    typeof record.code === "string" &&
    record.code.length > 0 &&
    typeof record.state === "string" &&
    record.state.length > 0
  ) {
    return { status: "resume_required", code: record.code, state: record.state };
  }
  throw invalidResumeResponse(response.status);
}

function invalidResumeResponse(status: number, detail = "returned an invalid response"): AuthClientError {
  return new AuthClientError(`auth-client-web: session resume ${detail}.`, {
    code: "session_resume_invalid_response",
    status,
    retryable: false,
    blocking: false,
  });
}

function resumeFailure(
  message: string,
  options: {
    status?: number;
    retryable: boolean;
    cause?: unknown;
  },
): AuthClientError {
  return new AuthClientError(message, {
    code: "session_resume_failed",
    status: options.status,
    retryable: options.retryable,
    blocking: false,
    cause: options.cause,
  });
}

/** Test hook: 清理同标签合流状态。 */
export function resetResume(): void {
  inFlightByClient.clear();
}
