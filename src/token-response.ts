import { AuthClientError, type AuthClientErrorCode } from "./errors.js";

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

type ParseTokenResponseOptions = {
  code: AuthClientErrorCode;
  message: string;
  retryable: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 在任何 token 被持久化或用于 userinfo 前验证 auth-service 的运行时响应。 */
export async function parseTokenResponse(
  response: Response,
  options: ParseTokenResponseOptions,
): Promise<TokenResponse> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (cause) {
    throw new AuthClientError(options.message, {
      code: options.code,
      status: response.status,
      retryable: options.retryable,
      cause,
    });
  }

  if (
    !isRecord(raw) ||
    typeof raw.access_token !== "string" ||
    raw.access_token.trim().length === 0 ||
    typeof raw.refresh_token !== "string" ||
    raw.refresh_token.trim().length === 0 ||
    typeof raw.expires_in !== "number" ||
    !Number.isSafeInteger(raw.expires_in) ||
    raw.expires_in <= 0
  ) {
    throw new AuthClientError(options.message, {
      code: options.code,
      status: response.status,
      retryable: options.retryable,
    });
  }

  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    expires_in: raw.expires_in,
  };
}
