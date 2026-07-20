import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { AuthClientError } from "../src/errors.js";
import { fetchWithAuth } from "../src/http.js";
import { beginAuthSessionTransition, resetAuthRequestLifecycle } from "../src/request-lifecycle.js";
import { resetTokens } from "../src/tokens.js";
import { tokenStore } from "../src/session.js";
import { resetStore, setState } from "../src/store.js";

const AUTH = "https://auth.example";
const API = "https://api.example/data";

function authHeader(init?: RequestInit): string | null {
  const h = new Headers(init?.headers);
  return h.get("authorization");
}

describe("fetchWithAuth()", () => {
  beforeEach(() => {
    resetConfig();
    resetStore();
    resetTokens();
    resetAuthRequestLifecycle();
    localStorage.clear();
    configure({ authUrl: AUTH, clientId: "audio", redirectUri: "https://app/cb" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches the bearer token and returns the response", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 });
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      expect(authHeader(init)).toBe("Bearer AT");
      return new Response("data", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithAuth(API);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("on 401, refreshes once and retries with the new token", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 });
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `${AUTH}/auth/token/refresh`) {
        return new Response(
          JSON.stringify({ access_token: "AT2", refresh_token: "RT2", token_type: "bearer", expires_in: 900 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      seen.push(authHeader(init)!);
      return new Response("x", { status: seen.length === 1 ? 401 : 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithAuth(API);
    expect(res.status).toBe(200);
    expect(seen).toEqual(["Bearer AT", "Bearer AT2"]); // stale token, then refreshed token
  });

  it("returns the 401 (no infinite loop) when the refresh itself fails", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 });
    let resourceCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === `${AUTH}/auth/token/refresh`) return new Response("no", { status: 401 });
      resourceCalls++;
      return new Response("x", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithAuth(API);
    expect(res.status).toBe(401);
    expect(resourceCalls).toBe(1); // tried once, refresh failed, no second resource hit
  });

  it("returns the original 401 (no throw) when the retry refresh fails transiently (5xx)", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 });
    let resourceCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === `${AUTH}/auth/token/refresh`) return new Response("boom", { status: 502 });
      resourceCalls++;
      return new Response("x", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithAuth(API); // a 502 refresh throws internally; must be swallowed
    expect(res.status).toBe(401);
    expect(resourceCalls).toBe(1); // tried once, transient refresh failed, no second resource hit
  });

  it("preserves the caller's method and body", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 });
    let captured: RequestInit | undefined;
    const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
      captured = init;
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithAuth(API, { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "x-custom": "1" } });
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toBe(JSON.stringify({ a: 1 }));
    expect(new Headers(captured?.headers).get("x-custom")).toBe("1"); // caller header preserved
    expect(authHeader(captured)).toBe("Bearer AT"); // ...alongside the injected bearer
  });

  it("账户切换屏障生效后拒绝发送新请求，不会继续使用旧身份或降级为匿名请求", async () => {
    tokenStore().setSession({ accessToken: "AT-old", refreshToken: "RT-old", expiresIn: 3600 });
    setState({ user: { id: "u-old" }, status: "synchronizing" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithAuth(API, { method: "POST", body: "write" })).rejects.toMatchObject({
      name: "AuthClientError",
      code: "session_reconcile_blocked",
      blocking: true,
      retryable: true,
    } satisfies Partial<AuthClientError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("账户切换会中止并拒绝旧 epoch 的迟到响应", async () => {
    tokenStore().setSession({ accessToken: "AT-old", refreshToken: "RT-old", expiresIn: 3600 });
    setState({ user: { id: "u-old" }, status: "authenticated" });
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.fn(
      async () => new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchWithAuth(API);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    beginAuthSessionTransition();
    setState({ status: "synchronizing" });
    resolveResponse(new Response("account-a", { status: 200 }));

    await expect(pending).rejects.toMatchObject({
      code: "session_reconcile_blocked",
      blocking: true,
    } satisfies Partial<AuthClientError>);
  });
});
