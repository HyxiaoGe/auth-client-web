import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { handleCallback } from "../src/callback.js";
import type { AuthClientError } from "../src/errors.js";
import { startPendingAuth, takePendingAuth } from "../src/pending.js";
import { resetStore, getState, setState } from "../src/store.js";
import { tokenStore } from "../src/session.js";

const AUTH = "https://auth.example";

function seedPending(verifier = "verifier-abc") {
  // mimic what buildAuthorizeUrl persisted before the redirect
  return startPendingAuth(verifier); // returns the state
}

/** A fetch double that answers /token then /auth/userinfo by URL. */
function stubFetch(opts: { tokenStatus?: number; userStatus?: number } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/auth/oauth/token")) {
      if (opts.tokenStatus && opts.tokenStatus >= 400) return new Response("bad", { status: opts.tokenStatus });
      return new Response(
        JSON.stringify({ access_token: "AT", refresh_token: "RT", token_type: "bearer", expires_in: 900 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/auth/userinfo")) {
      if (opts.userStatus && opts.userStatus >= 400) return new Response("no", { status: opts.userStatus });
      return new Response(
        JSON.stringify({ id: "u-9", email: "z@z.z", name: "Zed", avatar_url: "https://i/z.png" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

describe("handleCallback()", () => {
  beforeEach(() => {
    resetConfig();
    resetStore();
    sessionStorage.clear();
    localStorage.clear();
    configure({ authUrl: AUTH, clientId: "audio", redirectUri: "https://app/cb" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges code+verifier, stores tokens+user, and authenticates the store", async () => {
    const state = seedPending("the-real-verifier");
    const { calls } = stubFetch();

    const result = await handleCallback(`https://app/cb?code=AC-1&state=${state}`);

    // token exchange carried the PERSISTED verifier and our client_id, as JSON
    const tokenCall = calls.find((c) => c.url.endsWith("/auth/oauth/token"))!;
    expect(tokenCall.init?.method).toBe("POST");
    expect(JSON.parse(tokenCall.init!.body as string)).toEqual({
      code: "AC-1",
      client_id: "audio",
      code_verifier: "the-real-verifier",
    });

    // tokens persisted, user fetched + mapped, store flipped to authenticated
    expect(tokenStore().getAccessToken()).toBe("AT");
    expect(tokenStore().getRefreshToken()).toBe("RT");
    expect(result).toMatchObject({ status: "authenticated", user: { id: "u-9", avatarUrl: "https://i/z.png" } });
    expect(getState()).toMatchObject({ status: "authenticated", user: { id: "u-9" } });
    expect(JSON.parse(localStorage.getItem("acw_session_sync:audio") ?? "null")).toMatchObject({
      type: "switched",
    });

    // pending one-time material was consumed
    expect(takePendingAuth()).toBeNull();
  });

  it("rejects a state mismatch (CSRF) without exchanging the code", async () => {
    seedPending("v");
    const { calls } = stubFetch();
    await expect(handleCallback("https://app/cb?code=AC-1&state=FORGED")).rejects.toMatchObject({
      name: "AuthClientError",
      code: "authorization_state_invalid",
      retryable: false,
    } satisfies Partial<AuthClientError>);
    expect(calls.length).toBe(0); // never hit the token endpoint
    expect(tokenStore().getAccessToken()).toBeNull();
  });

  it("rejects when there is no pending auth (replay / forged callback)", async () => {
    const { calls } = stubFetch();
    await expect(handleCallback("https://app/cb?code=AC-1&state=whatever")).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  it("a forged error callback with a mismatched state does NOT consume pending (login-DoS defense)", async () => {
    // Victim has a real login in flight. Attacker lands the browser on an error callback whose
    // state it cannot know (high-entropy, never left the victim). It must not burn the pending
    // material, or the genuine callback that arrives next would fail.
    const realState = seedPending("real-verifier");
    const { calls } = stubFetch();

    await expect(handleCallback("https://app/cb?error=server_error&state=FORGED")).rejects.toThrow(/state/i);
    expect(calls.length).toBe(0); // nothing exchanged
    expect(getState().status).toBe("loading"); // store untouched by the forgery

    // the genuine callback now still succeeds because pending survived
    const result = await handleCallback(`https://app/cb?code=AC-1&state=${realState}`);
    expect(result).toMatchObject({ status: "authenticated", user: { id: "u-9" } });
  });

  it("a state mismatch on the success path does NOT consume pending either", async () => {
    const realState = seedPending("v");
    stubFetch();
    await expect(handleCallback("https://app/cb?code=ATTACKER&state=FORGED")).rejects.toThrow(/state/i);
    // pending preserved -> the real code+state still works
    const result = await handleCallback(`https://app/cb?code=AC-1&state=${realState}`);
    expect(result).toMatchObject({ status: "authenticated" });
  });

  it("treats error=login_required as a benign unauthenticated probe result (no throw)", async () => {
    const state = seedPending("v");
    stubFetch();
    const result = await handleCallback(`https://app/cb?error=login_required&state=${state}`);
    expect(result).toMatchObject({ status: "unauthenticated", error: "login_required" });
    expect(getState().status).toBe("unauthenticated");
    expect(takePendingAuth()).toBeNull(); // pending cleared even on the error path
  });

  it("已有完整认证会话时 error callback 保留会话并返回 authenticated", async () => {
    tokenStore().setSession({ accessToken: "AT-old", refreshToken: "RT-old", expiresIn: 3600 });
    tokenStore().setUser({ id: "u-old", email: "old@example.com" });
    setState({ user: { id: "u-old", email: "old@example.com" }, status: "authenticated" });
    sessionStorage.setItem("acw_redirect_path", "/keep-session");
    const state = seedPending("v");

    const result = await handleCallback(`https://app/cb?error=access_denied&state=${state}`);

    expect(result).toMatchObject({
      status: "authenticated",
      user: { id: "u-old" },
      redirectPath: "/keep-session",
    });
    expect(getState()).toEqual({
      status: "authenticated",
      user: { id: "u-old", email: "old@example.com" },
    });
    expect(tokenStore().getAccessToken()).toBe("AT-old");
    expect(tokenStore().getRefreshToken()).toBe("RT-old");
    expect(tokenStore().getUser()).toEqual({ id: "u-old", email: "old@example.com" });
    expect(sessionStorage.getItem("acw_redirect_path")).toBeNull();
  });

  it("页面内存重置但持久层有完整会话时 error callback 恢复 authenticated", async () => {
    tokenStore().setSession({ accessToken: "AT-old", refreshToken: "RT-old", expiresIn: 3600 });
    tokenStore().setUser({ id: "u-old" });
    const state = seedPending("v");

    const result = await handleCallback(`https://app/cb?error=server_error&state=${state}`);

    expect(result).toMatchObject({ status: "authenticated", user: { id: "u-old" } });
    expect(getState()).toEqual({ status: "authenticated", user: { id: "u-old" } });
  });

  it("持久 token 不完整时 error callback 按冷会话处理并清除残留，避免伪认证", async () => {
    localStorage.setItem("acw_access_token", "AT-orphan");
    tokenStore().setUser({ id: "u-orphan" });
    const state = seedPending("v");

    const result = await handleCallback(`https://app/cb?error=login_required&state=${state}`);

    expect(result).toEqual({ status: "unauthenticated", error: "login_required" });
    expect(getState()).toEqual({ status: "unauthenticated", user: null });
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(tokenStore().getUser()).toBeNull();
  });

  it("returns no_callback and leaves state alone when the URL has neither code nor error", async () => {
    const result = await handleCallback("https://app/cb");
    expect(result).toEqual({ status: "no_callback" });
    expect(getState().status).toBe("loading"); // untouched
  });

  it("共享换码内核后仍保留 legacy redirectPath 的成功后单次读取语义", async () => {
    sessionStorage.setItem("acw_redirect_path", "/legacy-target");
    const state = seedPending("legacy-verifier");
    stubFetch();

    const result = await handleCallback(`https://app/cb?code=AC-1&state=${state}`);

    expect(result).toMatchObject({ status: "authenticated", redirectPath: "/legacy-target" });
    expect(sessionStorage.getItem("acw_redirect_path")).toBeNull();
  });

  it("legacy token exchange 失败时不提前消费 redirectPath", async () => {
    sessionStorage.setItem("acw_redirect_path", "/keep-on-failure");
    const state = seedPending("legacy-verifier");
    stubFetch({ tokenStatus: 502 });

    await expect(handleCallback(`https://app/cb?code=AC-1&state=${state}`)).rejects.toThrow(/token exchange/i);

    expect(sessionStorage.getItem("acw_redirect_path")).toBe("/keep-on-failure");
  });

  it("legacy callback 在网络等待期间 configure 切换后仍使用最初配置快照", async () => {
    configure({
      authUrl: "https://auth-a.example",
      clientId: "client-a",
      redirectUri: "https://app-a.example/callback",
      storageKeys: { accessToken: "a-at", refreshToken: "a-rt", expiresAt: "a-exp", user: "a-user" },
    });
    const state = seedPending("legacy-verifier");
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
        return new Response(JSON.stringify({ id: "u-a" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const completion = handleCallback(`https://app-a.example/callback?code=AC-a&state=${state}`);
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
    expect(localStorage.getItem("b-at")).toBeNull();
  });
});
