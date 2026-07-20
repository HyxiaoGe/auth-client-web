/**
 * Authenticated fetch wrapper. Injects the current access token as a Bearer header, and on a
 * 401 forces exactly one refresh + retry -- covering tokens the resource server rejects even
 * though our local clock still considered them fresh (revoked, rotated elsewhere, clock skew).
 *
 * The retry is bounded to one attempt: a failed refresh returns the original 401 rather than
 * looping. The caller's method, body, and headers are preserved; only Authorization is set.
 */

import { getAccessToken, refresh } from "./tokens.js";
import { AuthClientError } from "./errors.js";
import {
  assertAuthSessionEpoch,
  captureAuthSessionEpoch,
  registerAuthRequest,
} from "./request-lifecycle.js";

function withAuth(init: RequestInit, token: string | null): RequestInit {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

export async function fetchWithAuth(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const requestEpoch = captureAuthSessionEpoch();
  // A transient refresh failure (5xx / flaky tunnel) throws rather than logging out; treat it as
  // "no fresh token" so one bad refresh degrades to a single failed request, never an exception
  // bubbling out of fetchWithAuth.
  let token: string | null;
  try {
    token = await getAccessToken();
  } catch (error) {
    if (error instanceof AuthClientError && error.blocking) throw error;
    token = null;
  }
  assertAuthSessionEpoch(requestEpoch);
  const request = registerAuthRequest(requestEpoch, init.signal);
  const requestInit = withAuth({ ...init, signal: request.controller.signal }, token);
  try {
    const res = await fetch(input as string, requestInit);
    assertAuthSessionEpoch(requestEpoch);
    if (res.status !== 401) {
      return res;
    }

    // Token was rejected server-side -- force one refresh and retry once. 整笔请求始终绑定
    // 初始 epoch；若中途切换账号，绝不能把原本属于 A 的写操作改用 B token 重放。
    let fresh: string | null;
    try {
      fresh = await refresh();
    } catch (error) {
      assertAuthSessionEpoch(requestEpoch);
      if (error instanceof AuthClientError && error.blocking) throw error;
      return res; // transient refresh failure -> return the original 401, don't loop or throw
    }
    assertAuthSessionEpoch(requestEpoch);
    if (fresh === null) {
      return res;
    }
    const retried = await fetch(
      input as string,
      withAuth({ ...init, signal: request.controller.signal }, fresh),
    );
    assertAuthSessionEpoch(requestEpoch);
    return retried;
  } catch (error) {
    // 切换触发的 abort 与普通调用方 abort 必须区分：前者是阻断性认证错误，
    // 调用方不得把它当作可忽略的网络取消后继续采用旧缓存。
    assertAuthSessionEpoch(requestEpoch);
    throw error;
  } finally {
    request.release();
  }
}
