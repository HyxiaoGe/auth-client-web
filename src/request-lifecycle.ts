import { AuthClientError } from "./errors.js";
import { getState } from "./store.js";

let sessionEpoch = 0;
const activeControllers = new Set<AbortController>();

function blockedError(): AuthClientError {
  return new AuthClientError("auth-client-web: authenticated request crossed an account transition.", {
    code: "session_reconcile_blocked",
    retryable: true,
    blocking: true,
  });
}

/** 捕获请求所属的认证代际；同步屏障期间禁止创建新的认证请求。 */
export function captureAuthSessionEpoch(): number {
  if (getState().status === "synchronizing") throw blockedError();
  return sessionEpoch;
}

/** 在每个异步边界后复验，拒绝把旧账号迟到响应交给新账号调用方。 */
export function assertAuthSessionEpoch(expectedEpoch: number): void {
  if (sessionEpoch !== expectedEpoch || getState().status === "synchronizing") {
    throw blockedError();
  }
}

/** 账户切换一经确认，立即推进代际并中止所有仍在途的 SDK 认证请求。 */
export function beginAuthSessionTransition(): void {
  sessionEpoch += 1;
  for (const controller of activeControllers) controller.abort();
  activeControllers.clear();
}

export function registerAuthRequest(
  expectedEpoch: number,
  callerSignal?: AbortSignal | null,
): { controller: AbortController; release: () => void } {
  assertAuthSessionEpoch(expectedEpoch);
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  activeControllers.add(controller);

  let released = false;
  return {
    controller,
    release: () => {
      if (released) return;
      released = true;
      activeControllers.delete(controller);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

/** Test hook. */
export function resetAuthRequestLifecycle(): void {
  for (const controller of activeControllers) controller.abort();
  activeControllers.clear();
  sessionEpoch = 0;
}
