import { describe, expect, it } from "vitest";

import { AuthClientError } from "../src/index.js";

describe("AuthClientError public API", () => {
  it("从包入口导出稳定的结构化字段并保持 Error 语义", () => {
    const error = new AuthClientError("boom", {
      code: "token_exchange_failed",
      status: 503,
      retryable: true,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AuthClientError);
    expect(error).toMatchObject({
      name: "AuthClientError",
      message: "boom",
      code: "token_exchange_failed",
      status: 503,
      retryable: true,
    });
  });
});
