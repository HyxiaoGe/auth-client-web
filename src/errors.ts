/** SDK 对外暴露的稳定错误码。调用方应优先判断 code/status，而不是解析 message。 */
export type AuthClientErrorCode =
  | "configuration_error"
  | "authorization_conflict"
  | "authorization_code_invalid"
  | "authorization_state_invalid"
  | "authorization_configuration_mismatch"
  | "callback_invalid"
  | "token_exchange_failed"
  | "token_exchange_invalid_response"
  | "token_refresh_failed"
  | "token_refresh_invalid_response"
  | "session_reconcile_failed"
  | "session_reconcile_invalid_response"
  | "session_reconcile_blocked"
  | "session_resume_failed"
  | "session_resume_invalid_response"
  | "userinfo_failed"
  | "userinfo_invalid_response";

export type AuthClientErrorOptions = {
  code: AuthClientErrorCode;
  status?: number;
  retryable: boolean;
  blocking?: boolean;
  cause?: unknown;
};

/** 认证网络和协议边界的结构化错误，同时保留既有 message 以兼容旧消费者。 */
export class AuthClientError extends Error {
  override readonly name = "AuthClientError";
  readonly code: AuthClientErrorCode;
  declare readonly status?: number;
  readonly retryable: boolean;
  readonly blocking: boolean;

  constructor(message: string, options: AuthClientErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.retryable = options.retryable;
    this.blocking = options.blocking ?? false;
    if (options.status !== undefined) this.status = options.status;
  }
}

/** 仅把通常可通过稍后重试恢复的 HTTP 状态标为 retryable。 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** AbortSignal 是调用方控制流，不应被包装成认证网络错误。 */
export function isAbortError(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException
    ? error.name === "AbortError"
    : typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
