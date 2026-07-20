/**
 * Access-token accessor with on-demand refresh.
 *
 * `getAccessToken()` is the single read path the rest of the SDK (and apps) use. If the
 * stored token is still within its skew window it is returned as-is; otherwise a refresh is
 * triggered. Concurrent callers during a refresh are COALESCED onto one in-flight promise,
 * so a page that fires N requests on load performs exactly one /token/refresh -- important
 * because refresh tokens rotate, and a refresh storm would otherwise invalidate itself.
 *
 * Cross-tab coalescing is layered on top via the Web Locks API (see `withRefreshLock`): the
 * in-tab `inFlight` promise collapses N callers in ONE tab to a single request; the lock then
 * serializes that request across tabs so two tabs never present the same rotating refresh token
 * at once. Without it, a sibling tab spending the token first makes auth-service treat ours as a
 * reuse attack and revoke EVERY token for the user. Degrades to a direct call where Web Locks
 * are unavailable (SSR, old browsers, tests), preserving the prior single-tab behavior.
 */

import { getConfig, getConfigSnapshot, type ResolvedConfig } from "./config.js";
import { AuthClientError, isRetryableStatus } from "./errors.js";
import { tokenStore } from "./session.js";
import { withSessionMutationLock } from "./session-mutation.js";
import { synchronizeFromStoredSession } from "./session-sync.js";
import { createTokenStore, type TokenStore } from "./storage.js";
import { getState, setState } from "./store.js";
import { parseTokenResponse } from "./token-response.js";

let inFlight: Promise<string | null> | null = null;

export async function getAccessToken(): Promise<string | null> {
  const store = tokenStore();
  const snapshot = store.getSessionSnapshot();
  assertSessionUsable(snapshot?.user);
  if (snapshot !== null && Date.now() + 30_000 < snapshot.expiresAt) {
    return snapshot.accessToken;
  }
  return refresh();
}

/** Force a refresh, coalescing concurrent callers onto a single network request (in-tab), then
 * serializing that request across tabs via a Web Lock so siblings can't replay a spent token. */
export function refresh(): Promise<string | null> {
  if (getState().status === "synchronizing") return Promise.reject(sessionBlockedError());
  if (inFlight) return inFlight;
  const config = getConfigSnapshot();
  inFlight = withRefreshLock(() => doRefresh(config)).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** mismatch 已确认后绝不向调用方交出旧票据，也不触发旧 refresh token 轮换。 */
function assertSessionUsable(storedUser?: unknown): void {
  const state = getState();
  if (state.status === "synchronizing") throw sessionBlockedError();

  const memoryUserId = userId(state.user);
  const storedUserId = userId(storedUser);
  if (memoryUserId === null || storedUserId === null || memoryUserId === storedUserId) return;

  // 共享 localStorage 的原子会话提交早于 BroadcastChannel/storage 事件投递。
  // 在这段窗口里绝不能把 B token 交给仍由 A 页面发起的请求：同步建立 epoch 屏障，
  // 再采用已完整落库的 B 身份；当前调用仍以 blocking error 失败，下一次请求才能使用 B。
  synchronizeFromStoredSession(getConfig());
  throw sessionBlockedError();
}

function userId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function sessionBlockedError(): AuthClientError {
  return new AuthClientError("auth-client-web: session is blocked while account synchronization is in progress.", {
    code: "session_reconcile_blocked",
    retryable: true,
    blocking: true,
  });
}

/** Run the refresh under a per-client Web Lock so only one tab refreshes at a time. Refresh
 * tokens rotate (one-time use); a waiting tab re-reads the already-rotated token inside the
 * lock (doRefresh reads it there) instead of replaying the spent one and tripping auth-service's
 * reuse detection, which revokes EVERY token for the user. No Web Locks API (SSR / old browsers
 * / tests) -> direct call, i.e. the prior single-tab behavior. */
async function withRefreshLock(run: () => Promise<string | null>): Promise<string | null> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return run();
  const { clientId } = getConfig();
  let result: string | null = null;
  await locks.request(`auth-client-web:refresh:${clientId}`, async () => {
    result = await run();
  });
  return result;
}

async function doRefresh(config: ResolvedConfig): Promise<string | null> {
  const store = createTokenStore(config.storageKeys);
  const snapshot = store.getSessionSnapshot();
  assertSessionUsable(snapshot?.user);
  const refreshToken = snapshot?.refreshToken ?? null;
  if (refreshToken === null) {
    setState({ user: null, status: "unauthenticated" });
    return null;
  }

  let res: Response;
  try {
    res = await fetch(`${config.authUrl}/auth/token/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (cause) {
    // 与 HTTP 失败相同：若等待期间其他标签页已完成轮换，优先采用胜者会话。
    if (store.getRefreshToken() !== refreshToken) return readUsableAccessToken(store);
    if (getState().status === "synchronizing") throw sessionBlockedError();
    throw new AuthClientError("Token refresh failed: network error", {
      code: "token_refresh_failed",
      retryable: true,
      cause,
    });
  }
  // refresh 等待期间可能发生中央账户切换。兄弟标签已提交新会话时采用胜者；
  // 只建立了切换屏障时则丢弃旧 sid 的响应，绝不能把旧账户重新写回。
  if (store.getRefreshToken() !== refreshToken) return readUsableAccessToken(store);
  if (getState().status === "synchronizing") throw sessionBlockedError();
  if (!res.ok) {
    // Cross-tab rotation guard: refresh tokens rotate, so a sibling tab may have already spent
    // ours and persisted a fresh pair -- in which case THIS failure is stale, not a real logout.
    // Only act on it if the stored refresh token is still the one we just sent.
    if (store.getRefreshToken() !== refreshToken) {
      return readUsableAccessToken(store);
    }
    // Definitive rejection (401/403): final CAS + clear 必须与所有 callback/reconcile/resume
    // 共用 session-mutation 锁，否则 B 可在“仍是 A”的检查后落库又被迟到的 A 清掉。
    if (res.status === 401 || res.status === 403) {
      return withSessionMutationLock(config, async () => {
        const latest = store.getSessionSnapshot();
        assertSessionUsable(latest?.user);
        if (latest?.refreshToken !== refreshToken) return latest?.accessToken ?? null;
        store.clear();
        setState({ user: null, status: "unauthenticated" });
        return null;
      });
    }
    // Transient failure (5xx, 429, gateway/error page from a flaky tunnel): the rotation may well
    // have succeeded server-side with its response lost in transit. Clearing the session here would
    // turn a dropped/sluggish response into a spurious logout. Keep the token and throw so the
    // caller treats it as transient -- the unchanged token gets retried and auth-service's
    // rotation-grace window re-issues the successor.
    throw new AuthClientError(`Token refresh failed: ${res.status}`, {
      code: "token_refresh_failed",
      status: res.status,
      retryable: isRetryableStatus(res.status),
    });
  }
  const tokens = await parseTokenResponse(res, {
    code: "token_refresh_invalid_response",
    message: "Token refresh failed: invalid token response",
    retryable: true,
  });
  // response.json() 也是异步边界。最终重读、比较与写回作为一个同步临界区放进统一
  // session-mutation 锁；兄弟标签的 B 提交只能发生在它之前或之后，不能插进 CAS 与写入之间。
  return withSessionMutationLock(config, async () => {
    const latest = store.getSessionSnapshot();
    assertSessionUsable(latest?.user);
    if (latest?.refreshToken !== refreshToken) return latest?.accessToken ?? null;
    try {
      store.setSession({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
      });
    } catch (error) {
      // 持久层已 fail closed；同步清理内存认证态，并透传原始存储错误供调用方诊断。
      setState({ user: null, status: "unauthenticated" });
      throw error;
    }
    return tokens.access_token;
  });
}

function readUsableAccessToken(store: TokenStore): string | null {
  const snapshot = store.getSessionSnapshot();
  assertSessionUsable(snapshot?.user);
  return snapshot?.accessToken ?? null;
}

/** Test hook: drop any in-flight refresh between cases. */
export function resetTokens(): void {
  inFlight = null;
}
