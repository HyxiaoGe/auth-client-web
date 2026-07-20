import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { AuthClientError } from "../src/errors.js";
import { generatePkce } from "../src/pkce.js";
import { reconcileSession, resetReconcile } from "../src/reconcile.js";
import { tokenStore } from "../src/session.js";
import { getState, resetStore, setState } from "../src/store.js";

const AUTH = "https://auth.example";

function seedSession() {
  const oldUser = { id: "u-old", email: "old@example.com" };
  tokenStore().setAuthenticatedSession(
    { accessToken: "AT-old", refreshToken: "RT-old", expiresIn: 900 },
    oldUser,
  );
  setState({ user: oldUser, status: "authenticated" });
  return oldUser;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("reconcileSession", () => {
  beforeEach(() => {
    resetReconcile();
    resetConfig();
    resetStore();
    localStorage.clear();
    configure({
      authUrl: AUTH,
      clientId: "fusion",
      redirectUri: "https://fusion.example/auth/callback",
    });
  });

  afterEach(() => {
    resetConfig();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["match", "no_session"] as const)(
    "%s 只报告中央会话状态，不改动本地 token 与用户",
    async (status) => {
      const oldUser = seedSession();
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ status }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(reconcileSession()).resolves.toEqual({ status });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(`${AUTH}/auth/session/reconcile`);
      expect(init).toMatchObject({ method: "POST", credentials: "include" });
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer AT-old");
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body).toMatchObject({
        client_id: "fusion",
        redirect_uri: "https://fusion.example/auth/callback",
        code_challenge_method: "S256",
      });
      expect(body.state).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/));
      expect(body.code_challenge).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]+$/));
      expect(body).not.toHaveProperty("code_verifier");
      expect(tokenStore().getAccessToken()).toBe("AT-old");
      expect(tokenStore().getRefreshToken()).toBe("RT-old");
      expect(getState()).toEqual({ user: oldUser, status: "authenticated" });
    },
  );

  it("没有本地 access token 时不访问中央会话，也不改变本地状态", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(reconcileSession()).resolves.toEqual({ status: "no_session" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getState()).toEqual({ user: null, status: "loading" });
  });

  it("switch_required 在内存中完成 PKCE 换票并一次性替换完整认证会话", async () => {
    const oldUser = seedSession();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let reconcileState = "";
    let reconcileChallenge = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/auth/session/reconcile")) {
          const body = JSON.parse(init?.body as string) as Record<string, string>;
          reconcileState = String(body.state);
          reconcileChallenge = String(body.code_challenge);
          return json({ status: "switch_required", code: "AC-once", state: reconcileState });
        }
        if (url.endsWith("/auth/oauth/token")) {
          return json({ access_token: "AT-new", refresh_token: "RT-new", expires_in: 900 });
        }
        if (url.endsWith("/auth/userinfo")) {
          return json({ id: "u-new", email: "new@example.com", avatar_url: "https://img/new.png" });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    await expect(reconcileSession()).resolves.toEqual({
      status: "switched",
      previousUser: oldUser,
      user: {
        id: "u-new",
        email: "new@example.com",
        avatarUrl: "https://img/new.png",
      },
    });

    const tokenCall = calls.find((call) => call.url.endsWith("/auth/oauth/token"))!;
    expect(tokenCall.init).toMatchObject({ method: "POST", credentials: "include" });
    const tokenBody = JSON.parse(tokenCall.init?.body as string) as Record<string, string>;
    expect(tokenBody).toMatchObject({
      code: "AC-once",
      client_id: "fusion",
      redirect_uri: "https://fusion.example/auth/callback",
      state: reconcileState,
    });
    expect(tokenBody.code_verifier).toEqual(expect.any(String));
    await expect(generatePkce(tokenBody.code_verifier)).resolves.toMatchObject({
      challenge: reconcileChallenge,
    });
    const persistedValues = [
      ...Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)),
      ...Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)),
    ]
      .filter((key): key is string => key !== null)
      .map((key) => localStorage.getItem(key) ?? sessionStorage.getItem(key) ?? "");
    expect(persistedValues.join("\n")).not.toContain("AC-once");
    expect(persistedValues.join("\n")).not.toContain(tokenBody.code_verifier);
    expect(sessionStorage.length).toBe(0);
    expect(tokenStore().getAccessToken()).toBe("AT-new");
    expect(tokenStore().getRefreshToken()).toBe("RT-new");
    expect(tokenStore().getUser()).toMatchObject({ id: "u-new" });
    expect(getState()).toMatchObject({ status: "authenticated", user: { id: "u-new" } });
  });

  it("预检网络失败保持当前会话，并返回非 blocking 的可重试错误", async () => {
    const oldUser = seedSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );

    await expect(reconcileSession()).rejects.toMatchObject({
      name: "AuthClientError",
      code: "session_reconcile_failed",
      retryable: true,
      blocking: false,
    } satisfies Partial<AuthClientError>);
    expect(tokenStore().getAccessToken()).toBe("AT-old");
    expect(getState()).toEqual({ user: oldUser, status: "authenticated" });
  });

  it("预检 401 只表示本地 access token 需刷新，不建立永久切换屏障", async () => {
    const oldUser = seedSession();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "invalid_token" }, 401)));

    await expect(reconcileSession()).rejects.toMatchObject({
      code: "session_reconcile_failed",
      status: 401,
      blocking: false,
    } satisfies Partial<AuthClientError>);
    expect(getState()).toEqual({ user: oldUser, status: "authenticated" });
    expect(tokenStore().getAccessToken()).toBe("AT-old");
  });

  it("确认 switch_required 后换票失败会保留旧票据但维持同步屏障", async () => {
    const oldUser = seedSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/auth/session/reconcile")) {
          const body = JSON.parse(init?.body as string) as Record<string, string>;
          return json({ status: "switch_required", code: "AC-once", state: body.state });
        }
        return new Response("code expired", { status: 401 });
      }),
    );

    await expect(reconcileSession()).rejects.toMatchObject({
      name: "AuthClientError",
      code: "session_reconcile_blocked",
      status: 401,
      retryable: false,
      blocking: true,
    } satisfies Partial<AuthClientError>);
    expect(tokenStore().getAccessToken()).toBe("AT-old");
    expect(tokenStore().getRefreshToken()).toBe("RT-old");
    expect(getState()).toEqual({ user: oldUser, status: "synchronizing" });
  });

  it("beforeCommit 在新会话落库前运行，供宿主清理旧用户请求与缓存", async () => {
    const oldUser = seedSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/auth/session/reconcile")) {
          const body = JSON.parse(init?.body as string) as Record<string, string>;
          return json({ status: "switch_required", code: "AC-once", state: body.state });
        }
        if (url.endsWith("/auth/oauth/token")) {
          return json({ access_token: "AT-new", refresh_token: "RT-new", expires_in: 900 });
        }
        return json({ id: "u-new", email: "new@example.com" });
      }),
    );
    const beforeCommit = vi.fn(async (context: { previousUser: unknown; user: unknown }) => {
      expect(context).toEqual({
        previousUser: oldUser,
        user: { id: "u-new", email: "new@example.com" },
      });
      expect(tokenStore().getAccessToken()).toBe("AT-old");
      expect(tokenStore().getRefreshToken()).toBe("RT-old");
      expect(getState()).toEqual({ user: oldUser, status: "synchronizing" });
    });

    await expect(reconcileSession({ beforeCommit })).resolves.toMatchObject({
      status: "switched",
      user: { id: "u-new" },
    });

    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(tokenStore().getAccessToken()).toBe("AT-new");
    expect(getState()).toMatchObject({ status: "authenticated", user: { id: "u-new" } });
  });

  it("beforeCommit 清理失败时不提交新旧混合会话，并保持 blocking", async () => {
    const oldUser = seedSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/auth/session/reconcile")) {
          const body = JSON.parse(init?.body as string) as Record<string, string>;
          return json({ status: "switch_required", code: "AC-once", state: body.state });
        }
        if (url.endsWith("/auth/oauth/token")) {
          return json({ access_token: "AT-new", refresh_token: "RT-new", expires_in: 900 });
        }
        return json({ id: "u-new" });
      }),
    );

    await expect(
      reconcileSession({
        beforeCommit: async () => {
          throw new Error("cache cleanup failed");
        },
      }),
    ).rejects.toMatchObject({
      code: "session_reconcile_blocked",
      blocking: true,
    } satisfies Partial<AuthClientError>);

    expect(tokenStore().getAccessToken()).toBe("AT-old");
    expect(tokenStore().getRefreshToken()).toBe("RT-old");
    expect(tokenStore().getUser()).toEqual(oldUser);
    expect(getState()).toEqual({ user: oldUser, status: "synchronizing" });
  });

  it("服务端返回的 state 不匹配时不发送 authorization code，并进入 blocking 状态", async () => {
    const oldUser = seedSession();
    const fetchMock = vi.fn(async () =>
      json({ status: "switch_required", code: "AC-forged", state: "other-state" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(reconcileSession()).rejects.toMatchObject({
      name: "AuthClientError",
      code: "session_reconcile_blocked",
      retryable: false,
      blocking: true,
    } satisfies Partial<AuthClientError>);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokenStore().getAccessToken()).toBe("AT-old");
    expect(getState()).toEqual({ user: oldUser, status: "synchronizing" });
  });

  it("同标签并发调用合流，并通过按 client 命名的 Web Lock 执行预检", async () => {
    seedSession();
    const lockNames: string[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: async (name: string, callback: () => Promise<unknown>) => {
          lockNames.push(name);
          return callback();
        },
      },
    });
    const fetchMock = vi.fn(async () => json({ status: "match" }));
    vi.stubGlobal("fetch", fetchMock);

    const first = reconcileSession();
    const second = reconcileSession();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "match" },
      { status: "match" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(lockNames).toEqual(["auth-client-web:session-mutation:fusion"]);
  });
});
