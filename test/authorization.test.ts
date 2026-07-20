import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelAuthorization,
  completeAuthorization,
  prepareAuthorization,
} from "../src/authorization.js";
import { configure, resetConfig } from "../src/config.js";
import { AuthClientError } from "../src/errors.js";
import { generatePkce } from "../src/pkce.js";
import { startPendingAuth, takePendingAuth } from "../src/pending.js";
import { getState, resetStore, setState } from "../src/store.js";
import { tokenStore } from "../src/session.js";

const AUTH = "https://auth.example";
const TRANSACTION_PREFIX = "acw_headless_authorization:";

function transactionRecord(state: string): Record<string, unknown> | null {
  const raw = sessionStorage.getItem(`${TRANSACTION_PREFIX}${state}`);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

function stubSuccessfulCompletion(options: { delayToken?: boolean } = {}) {
  let releaseToken: (() => void) | null = null;
  const tokenGate = new Promise<void>((resolve) => {
    releaseToken = resolve;
  });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/auth/oauth/token")) {
      if (options.delayToken) await tokenGate;
      return new Response(
        JSON.stringify({ access_token: "AT", refresh_token: "RT", token_type: "bearer", expires_in: 900 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/auth/userinfo")) {
      return new Response(
        JSON.stringify({ id: "u-1", email: "user@example.com", avatar_url: "https://img/u.png" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, releaseToken: () => releaseToken?.() };
}

describe("headless authorization transaction", () => {
  beforeEach(() => {
    resetConfig();
    resetStore();
    sessionStorage.clear();
    localStorage.clear();
    configure({ authUrl: AUTH, clientId: "fusion", redirectUri: "https://fusion.example/auth/callback" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prepareAuthorization 返回标准授权参数，并按高熵 state 保存带版本和过期时间的 PKCE 事务", async () => {
    const before = Date.now();
    const prepared = await prepareAuthorization({ redirectPath: "/chat/42" });
    const record = transactionRecord(prepared.state);

    expect(prepared).toMatchObject({
      responseType: "code",
      clientId: "fusion",
      redirectUri: "https://fusion.example/auth/callback",
      codeChallengeMethod: "S256",
    });
    expect(prepared.state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(prepared.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(prepared).not.toHaveProperty("codeVerifier");
    expect(record).toMatchObject({
      version: 1,
      state: prepared.state,
      authUrl: AUTH,
      clientId: "fusion",
      redirectUri: "https://fusion.example/auth/callback",
      redirectPath: "/chat/42",
    });
    expect(record).not.toHaveProperty("email");
    expect(record?.expiresAt).toEqual(expect.any(Number));
    expect(record?.expiresAt as number).toBeGreaterThan(before);

    const { challenge } = await generatePkce(record?.verifier as string);
    expect(challenge).toBe(prepared.codeChallenge);
  });

  it("多个 headless transaction 并存，且不会覆盖 legacy redirect pending", async () => {
    const legacyState = startPendingAuth("legacy-verifier");
    const first = await prepareAuthorization({ redirectPath: "/first" });
    const second = await prepareAuthorization({ redirectPath: "/second" });

    expect(first.state).not.toBe(second.state);
    expect(transactionRecord(first.state)).not.toBeNull();
    expect(transactionRecord(second.state)).not.toBeNull();
    expect(takePendingAuth()).toEqual({ state: legacyState, verifier: "legacy-verifier" });
  });

  it("cancelAuthorization 只清目标事务，不影响其他 headless 或 legacy 事务", async () => {
    const legacyState = startPendingAuth("legacy-verifier");
    const first = await prepareAuthorization();
    const second = await prepareAuthorization();

    cancelAuthorization(first.state);

    expect(transactionRecord(first.state)).toBeNull();
    expect(transactionRecord(second.state)).not.toBeNull();
    expect(takePendingAuth()).toEqual({ state: legacyState, verifier: "legacy-verifier" });
  });

  it("未知 state 直接拒绝，不换 token，也不清除其他事务", async () => {
    const valid = await prepareAuthorization();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeAuthorization({ authorizationCode: "AC-forged", state: "unknown-state" }),
    ).rejects.toMatchObject({
      name: "AuthClientError",
      code: "authorization_state_invalid",
      retryable: false,
    } satisfies Partial<AuthClientError>);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(transactionRecord(valid.state)).not.toBeNull();
    expect(getState().status).toBe("loading");
  });

  it("过期事务拒绝换码并只清自身，不影响其他有效事务", async () => {
    const expired = await prepareAuthorization();
    const valid = await prepareAuthorization();
    const record = transactionRecord(expired.state)!;
    sessionStorage.setItem(
      `${TRANSACTION_PREFIX}${expired.state}`,
      JSON.stringify({ ...record, expiresAt: Date.now() - 1 }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorization({ authorizationCode: "AC", state: expired.state })).rejects.toThrow(
      /expired|state/i,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(transactionRecord(expired.state)).toBeNull();
    expect(transactionRecord(valid.state)).not.toBeNull();
  });

  it("记录内 state 或版本被篡改时拒绝换码并只清目标记录", async () => {
    const tampered = await prepareAuthorization();
    const valid = await prepareAuthorization();
    const record = transactionRecord(tampered.state)!;
    sessionStorage.setItem(
      `${TRANSACTION_PREFIX}${tampered.state}`,
      JSON.stringify({ ...record, version: 999, state: valid.state }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorization({ authorizationCode: "AC", state: tampered.state })).rejects.toThrow(/state/i);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(transactionRecord(tampered.state)).toBeNull();
    expect(transactionRecord(valid.state)).not.toBeNull();
  });

  it("事务与当前 client 配置不一致时拒绝换码并保留事务供原配置恢复", async () => {
    const prepared = await prepareAuthorization();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    configure({ authUrl: AUTH, clientId: "other-client", redirectUri: "https://other.example/callback" });

    await expect(completeAuthorization({ authorizationCode: "AC", state: prepared.state })).rejects.toMatchObject({
      name: "AuthClientError",
      code: "authorization_configuration_mismatch",
      retryable: false,
    } satisfies Partial<AuthClientError>);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(transactionRecord(prepared.state)).not.toBeNull();
  });

  it("authorization code 为空时不消费已验证事务，允许调用方修正后重试", async () => {
    const prepared = await prepareAuthorization();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorization({ authorizationCode: "", state: prepared.state })).rejects.toMatchObject({
      name: "AuthClientError",
      code: "authorization_code_invalid",
      retryable: false,
    } satisfies Partial<AuthClientError>);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(transactionRecord(prepared.state)).not.toBeNull();
  });

  it("state 成功匹配后一次性消费事务，并用原 verifier 换 token、拉 userinfo、更新 store", async () => {
    const prepared = await prepareAuthorization({ redirectPath: "/chat/new" });
    const record = transactionRecord(prepared.state)!;
    const { calls } = stubSuccessfulCompletion();

    const result = await completeAuthorization({ authorizationCode: "AC-1", state: prepared.state });

    const tokenCall = calls.find((call) => call.url.endsWith("/auth/oauth/token"))!;
    expect(JSON.parse(tokenCall.init?.body as string)).toEqual({
      code: "AC-1",
      client_id: "fusion",
      code_verifier: record.verifier,
    });
    expect(transactionRecord(prepared.state)).toBeNull();
    expect(tokenStore().getAccessToken()).toBe("AT");
    expect(tokenStore().getRefreshToken()).toBe("RT");
    expect(getState()).toMatchObject({ status: "authenticated", user: { id: "u-1" } });
    expect(result).toMatchObject({
      status: "authenticated",
      redirectPath: "/chat/new",
      user: { id: "u-1", avatarUrl: "https://img/u.png" },
    });
  });

  it("同一 state 并发 complete 合流，只验证一次 code 并执行一次 token exchange", async () => {
    const prepared = await prepareAuthorization();
    const { fetchMock, releaseToken } = stubSuccessfulCompletion({ delayToken: true });

    const first = completeAuthorization({ authorizationCode: "AC-1", state: prepared.state });
    const second = completeAuthorization({ authorizationCode: "AC-1", state: prepared.state });
    releaseToken();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 一次 token exchange + 一次 userinfo 请求
  });

  it("同一 state 并发传入不同 authorization code 时拒绝冲突调用，但不影响真实 completion", async () => {
    const prepared = await prepareAuthorization();
    const { fetchMock, releaseToken } = stubSuccessfulCompletion({ delayToken: true });

    const genuine = completeAuthorization({ authorizationCode: "AC-genuine", state: prepared.state });
    const conflicting = completeAuthorization({ authorizationCode: "AC-conflicting", state: prepared.state });

    await expect(conflicting).rejects.toMatchObject({
      name: "AuthClientError",
      code: "authorization_conflict",
      retryable: false,
    } satisfies Partial<AuthClientError>);
    releaseToken();
    await expect(genuine).resolves.toMatchObject({ status: "authenticated", user: { id: "u-1" } });

    const tokenCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/auth/oauth/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(JSON.parse((tokenCalls[0]?.[1] as RequestInit).body as string)).toMatchObject({ code: "AC-genuine" });
  });

  it("state 匹配后即使 token exchange 失败也保持一次性消费，必须重新 prepare", async () => {
    const prepared = await prepareAuthorization();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 502 })));

    await expect(completeAuthorization({ authorizationCode: "AC", state: prepared.state })).rejects.toThrow(
      /token exchange/i,
    );

    expect(transactionRecord(prepared.state)).toBeNull();
    await expect(completeAuthorization({ authorizationCode: "AC", state: prepared.state })).rejects.toThrow(/state/i);
  });

  it("token exchange HTTP 失败会暴露结构化错误并保留兼容消息", async () => {
    const prepared = await prepareAuthorization();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 502 })));

    await expect(completeAuthorization({ authorizationCode: "AC", state: prepared.state })).rejects.toMatchObject({
      name: "AuthClientError",
      code: "token_exchange_failed",
      status: 502,
      retryable: false,
      message: "auth-client-web: token exchange failed (502).",
    } satisfies Partial<AuthClientError>);
  });

  it("token exchange 网络异常因事务已消费而不可直接重试", async () => {
    const prepared = await prepareAuthorization();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network down");
    }));

    const error = await completeAuthorization({ authorizationCode: "AC", state: prepared.state }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({
      name: "AuthClientError",
      code: "token_exchange_failed",
      retryable: false,
      message: "auth-client-web: token exchange failed (network error).",
    } satisfies Partial<AuthClientError>);
    expect(error).not.toHaveProperty("status");
  });

  it.each([
    ["空 access_token", { access_token: "", refresh_token: "RT-new", expires_in: 900 }],
    ["空 refresh_token", { access_token: "AT-new", refresh_token: " ", expires_in: 900 }],
    ["字符串 expires_in", { access_token: "AT-new", refresh_token: "RT-new", expires_in: "900" }],
    ["负 expires_in", { access_token: "AT-new", refresh_token: "RT-new", expires_in: -1 }],
  ])("token exchange 拒绝%s且不请求 userinfo、不提交会话", async (_label, payload) => {
    const prepared = await prepareAuthorization();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorization({ authorizationCode: "AC", state: prepared.state })).rejects.toMatchObject({
      name: "AuthClientError",
      code: "token_exchange_invalid_response",
      retryable: false,
    } satisfies Partial<AuthClientError>);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(tokenStore().getRefreshToken()).toBeNull();
  });

  it("token exchange 拒绝异常 JSON，不请求 userinfo、不提交会话", async () => {
    const prepared = await prepareAuthorization();
    const fetchMock = vi.fn(async () =>
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorization({ authorizationCode: "AC", state: prepared.state })).rejects.toMatchObject({
      name: "AuthClientError",
      code: "token_exchange_invalid_response",
      retryable: false,
    } satisfies Partial<AuthClientError>);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokenStore().getAccessToken()).toBeNull();
  });

  it("userinfo 失败时不提交新 token/user/store，完整保留旧会话", async () => {
    tokenStore().setSession({ accessToken: "AT-old", refreshToken: "RT-old", expiresIn: 3600 });
    tokenStore().setUser({ id: "u-old", email: "old@example.com" });
    setState({ status: "authenticated", user: { id: "u-old", email: "old@example.com" } });
    const prepared = await prepareAuthorization();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/auth/oauth/token")) {
          return new Response(
            JSON.stringify({ access_token: "AT-new", refresh_token: "RT-new", token_type: "bearer", expires_in: 900 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("userinfo unavailable", { status: 502 });
      }),
    );

    await expect(completeAuthorization({ authorizationCode: "AC", state: prepared.state })).rejects.toMatchObject({
      name: "AuthClientError",
      code: "userinfo_failed",
      status: 502,
      retryable: false,
      message: "auth-client-web: userinfo failed (502)",
    } satisfies Partial<AuthClientError>);

    expect(tokenStore().getAccessToken()).toBe("AT-old");
    expect(tokenStore().getRefreshToken()).toBe("RT-old");
    expect(tokenStore().getUser()).toEqual({ id: "u-old", email: "old@example.com" });
    expect(getState()).toEqual({ status: "authenticated", user: { id: "u-old", email: "old@example.com" } });
  });

  it("首次等待后 configure 切换不会改变 token/userinfo 端点或 storage keys 快照", async () => {
    configure({
      authUrl: "https://auth-a.example",
      clientId: "client-a",
      redirectUri: "https://app-a.example/callback",
      storageKeys: { accessToken: "a-at", refreshToken: "a-rt", expiresAt: "a-exp", user: "a-user" },
    });
    const prepared = await prepareAuthorization();
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.endsWith("/auth/oauth/token")) {
          await tokenGate;
          return new Response(
            JSON.stringify({ access_token: "AT-a", refresh_token: "RT-a", token_type: "bearer", expires_in: 900 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ id: "u-a", email: "a@example.com" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const completion = completeAuthorization({ authorizationCode: "AC-a", state: prepared.state });
    configure({
      authUrl: "https://auth-b.example",
      clientId: "client-b",
      redirectUri: "https://app-b.example/callback",
      storageKeys: { accessToken: "b-at", refreshToken: "b-rt", expiresAt: "b-exp", user: "b-user" },
    });
    releaseToken();

    await expect(completion).resolves.toMatchObject({ status: "authenticated", user: { id: "u-a" } });
    expect(urls).toEqual([
      "https://auth-a.example/auth/oauth/token",
      "https://auth-a.example/auth/userinfo",
    ]);
    expect(localStorage.getItem("a-at")).toBe("AT-a");
    expect(localStorage.getItem("a-rt")).toBe("RT-a");
    expect(JSON.parse(localStorage.getItem("a-user")!)).toMatchObject({ id: "u-a" });
    expect(localStorage.getItem("b-at")).toBeNull();
    expect(localStorage.getItem("b-user")).toBeNull();
  });

  it("AbortSignal 在 userinfo 阶段取消时不半提交，并清理 in-flight 合流记录", async () => {
    tokenStore().setSession({ accessToken: "AT-old", refreshToken: "RT-old", expiresIn: 3600 });
    tokenStore().setUser({ id: "u-old" });
    setState({ status: "authenticated", user: { id: "u-old" } });
    const prepared = await prepareAuthorization();
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/auth/oauth/token")) {
          return new Response(
            JSON.stringify({ access_token: "AT-new", refresh_token: "RT-new", token_type: "bearer", expires_in: 900 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return await new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        });
      }),
    );

    const completion = completeAuthorization({
      authorizationCode: "AC",
      state: prepared.state,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(completion).rejects.toMatchObject({ name: "AbortError" });
    expect(tokenStore().getAccessToken()).toBe("AT-old");
    expect(tokenStore().getUser()).toEqual({ id: "u-old" });
    expect(getState()).toEqual({ status: "authenticated", user: { id: "u-old" } });
    await expect(completeAuthorization({ authorizationCode: "AC", state: prepared.state })).rejects.toThrow(/state/i);
  });
});
