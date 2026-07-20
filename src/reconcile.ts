/**
 * 将应用本地票据与当前浏览器的中央 IdP 会话对账。
 *
 * authorization code 与 PKCE verifier 只存在于当前函数内存，不进入 URL、日志或
 * Web Storage。Web Lock 只用于降低同源多标签竞态；真正的安全边界仍由服务端对
 * Origin、client、redirect、PKCE、旧票据 sid 和当前 Cookie sid 的绑定校验提供。
 */

import {
  commitAuthenticatedSession,
  exchangeAuthorizationCode,
} from "./authorization-code.js";
import { getConfigSnapshot, type ResolvedConfig } from "./config.js";
import { randomUrlSafe } from "./encoding.js";
import { AuthClientError, isAbortError, isRetryableStatus } from "./errors.js";
import { generatePkce } from "./pkce.js";
import { beginAuthSessionTransition } from "./request-lifecycle.js";
import { publishSessionSync } from "./session-sync.js";
import { withSessionMutationLock } from "./session-mutation.js";
import { createTokenStore } from "./storage.js";
import { getState, setState, type AuthUser } from "./store.js";

export type ReconcileSessionOptions = {
  signal?: AbortSignal;
  /**
   * 新 token 与 userinfo 已验证、但尚未写入全局会话时执行。
   * 宿主应在这里同步终止旧请求并清理旧用户业务缓存；回调不得记录认证材料。
   */
  beforeCommit?: (context: {
    previousUser: AuthUser | null;
    user: AuthUser;
  }) => void | Promise<void>;
};

export type ReconcileSessionResult =
  | { status: "match" }
  | { status: "no_session" }
  | { status: "switched"; previousUser: AuthUser | null; user: AuthUser };

type ReconcileResponse =
  | { status: "match" }
  | { status: "no_session" }
  | { status: "switch_required"; code: string; state: string };

let inFlight: Promise<ReconcileSessionResult> | null = null;

export function reconcileSession(options: ReconcileSessionOptions = {}): Promise<ReconcileSessionResult> {
  if (inFlight !== null) return inFlight;
  const config = getConfigSnapshot();
  const operation = withSessionMutationLock(config, () => doReconcile(config, options)).finally(() => {
    if (inFlight === operation) inFlight = null;
  });
  inFlight = operation;
  return operation;
}

async function doReconcile(
  config: ResolvedConfig,
  options: ReconcileSessionOptions,
): Promise<ReconcileSessionResult> {
  const store = createTokenStore(config.storageKeys);
  // 不先 refresh：账户切换后旧 sid 可能已经被撤销，但 reconcile 端点仍需读取旧票据
  // 中受签名保护的 client/sid 绑定来安全换票。
  const accessToken = store.getAccessToken();
  if (accessToken === null) return { status: "no_session" };

  const { verifier, challenge, method } = await generatePkce();
  const state = randomUrlSafe(32);
  let response: Response;
  try {
    response = await fetch(`${config.authUrl}/auth/session/reconcile`, {
      method: "POST",
      credentials: "include",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
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
    throw new AuthClientError("auth-client-web: session reconcile failed (network error).", {
      code: "session_reconcile_failed",
      retryable: true,
      blocking: false,
      cause,
    });
  }

  if (!response.ok) {
    throw new AuthClientError(`auth-client-web: session reconcile failed (${response.status}).`, {
      code: "session_reconcile_failed",
      status: response.status,
      retryable: isRetryableStatus(response.status),
      blocking: false,
    });
  }

  const reconciled = await parseReconcileResponse(response);
  if (reconciled.status === "match" || reconciled.status === "no_session") {
    return reconciled;
  }

  // token store 与这次 Bearer 使用同一组配置键，是旧会话身份的权威本地快照；
  // 内存 store 可能尚未 hydrate，只在持久化用户缺失时兜底。
  const previousUser = store.getUser<AuthUser>() ?? getState().user;
  beginSwitchBarrier(config);
  if (reconciled.state !== state) {
    throw blockedError("auth-client-web: session reconcile returned a mismatched state.");
  }

  let prepared: Awaited<ReturnType<typeof exchangeAuthorizationCode>>;
  try {
    prepared = await exchangeAuthorizationCode(reconciled.code, verifier, config, {
      signal: options.signal,
      credentials: "include",
      state,
      redirectUri: config.redirectUri,
    });
    await options.beforeCommit?.({ previousUser, user: prepared.user });
    commitAuthenticatedSession(prepared, config);
  } catch (cause) {
    // mismatch 已经由可信的 reconcile 响应确认。即使网络失败，也不能恢复旧身份写入；
    // 宿主应保持请求屏障并重新发起整笔 reconcile，获取新的单次 code。
    setState({ user: previousUser, status: "synchronizing" });
    throw blockedError("auth-client-web: confirmed session switch could not be completed.", cause);
  }

  return { status: "switched", previousUser, user: prepared.user };
}

function beginSwitchBarrier(config: ResolvedConfig): void {
  beginAuthSessionTransition();
  setState({ status: "synchronizing" });
  publishSessionSync("switching", config);
}

function blockedError(message: string, cause?: unknown): AuthClientError {
  const authError = cause instanceof AuthClientError ? cause : null;
  return new AuthClientError(message, {
    code: "session_reconcile_blocked",
    status: authError?.status,
    retryable: authError?.retryable ?? false,
    blocking: true,
    cause,
  });
}

async function parseReconcileResponse(response: Response): Promise<ReconcileResponse> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (cause) {
    throw new AuthClientError("auth-client-web: session reconcile returned invalid JSON.", {
      code: "session_reconcile_invalid_response",
      status: response.status,
      retryable: false,
      blocking: false,
      cause,
    });
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalidReconcileResponse(response.status);
  }
  const record = raw as Record<string, unknown>;
  if (record.status === "match" || record.status === "no_session") return { status: record.status };
  if (
    record.status === "switch_required" &&
    typeof record.code === "string" &&
    record.code.length > 0 &&
    typeof record.state === "string" &&
    record.state.length > 0
  ) {
    return { status: "switch_required", code: record.code, state: record.state };
  }
  throw invalidReconcileResponse(response.status);
}

function invalidReconcileResponse(status: number): AuthClientError {
  return new AuthClientError("auth-client-web: session reconcile returned an invalid response.", {
    code: "session_reconcile_invalid_response",
    status,
    retryable: false,
    blocking: false,
  });
}

/** Test hook: 清理同标签合流状态。 */
export function resetReconcile(): void {
  inFlight = null;
}
