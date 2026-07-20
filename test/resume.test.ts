import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { AuthClientError } from "../src/errors.js";
import { resumeSession } from "../src/index.js";
import { generatePkce } from "../src/pkce.js";
import { resetResume } from "../src/resume.js";
import { tokenStore } from "../src/session.js";
import { getState, resetStore, setState } from "../src/store.js";

const AUTH = "https://auth.example";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("resumeSession", () => {
  beforeEach(() => {
    resetResume();
    resetConfig();
    resetStore();
    localStorage.clear();
    sessionStorage.clear();
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

  it("已有本地 access token 时返回 local_session，且不访问中央会话", async () => {
    tokenStore().setAuthenticatedSession(
      { accessToken: "AT-local", refreshToken: "RT-local", expiresIn: 900 },
      { id: "u-local", email: "local@example.com" },
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(resumeSession()).resolves.toEqual({ status: "local_session" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokenStore().getAccessToken()).toBe("AT-local");
  });

  it("no_session 只报告中央会话不存在，不改变本地状态", async () => {
    setState({ user: null, status: "unauthenticated" });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({ status: "no_session" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resumeSession()).resolves.toEqual({ status: "no_session" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${AUTH}/auth/session/resume`);
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      client_id: "fusion",
      redirect_uri: "https://fusion.example/auth/callback",
      code_challenge_method: "S256",
    });
    expect(body.state).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/));
    expect(body.code_challenge).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]+$/));
    expect(body).not.toHaveProperty("code_verifier");
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(getState()).toEqual({ user: null, status: "unauthenticated" });
  });

  it("resume_required 在内存中完成 PKCE 换票、原子提交并发布同源同步事件", async () => {
    setState({ user: null, status: "unauthenticated" });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let resumeState = "";
    let resumeChallenge = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/auth/session/resume")) {
          const body = JSON.parse(init?.body as string) as Record<string, string>;
          resumeState = body.state ?? "";
          resumeChallenge = body.code_challenge ?? "";
          return json({ status: "resume_required", code: "AC-once", state: resumeState });
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

    await expect(resumeSession()).resolves.toEqual({
      status: "resumed",
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
      state: resumeState,
    });
    expect(tokenBody.code_verifier).toEqual(expect.any(String));
    await expect(generatePkce(tokenBody.code_verifier)).resolves.toMatchObject({
      challenge: resumeChallenge,
    });
    expect(tokenStore().getAccessToken()).toBe("AT-new");
    expect(tokenStore().getRefreshToken()).toBe("RT-new");
    expect(tokenStore().getUser()).toMatchObject({ id: "u-new" });
    expect(getState()).toMatchObject({ status: "authenticated", user: { id: "u-new" } });
    const syncEvent = JSON.parse(localStorage.getItem("acw_session_sync:fusion") ?? "null") as {
      type?: string;
    } | null;
    expect(syncEvent).toMatchObject({ type: "switched" });
  });

  it("在提交恢复会话前等待宿主清理旧身份运行态", async () => {
    const events: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/auth/session/resume")) {
          const body = JSON.parse(init?.body as string) as Record<string, string>;
          return json({ status: "resume_required", code: "AC-once", state: body.state });
        }
        if (url.endsWith("/auth/oauth/token")) {
          return json({ access_token: "AT-new", refresh_token: "RT-new", expires_in: 900 });
        }
        if (url.endsWith("/auth/userinfo")) {
          return json({ id: "u-new", email: "new@example.com" });
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    const result = await resumeSession({
      beforeCommit: async ({ user }) => {
        events.push(`cleanup:${user.id}`);
        expect(tokenStore().getAccessToken()).toBeNull();
      },
    });
    events.push(`committed:${tokenStore().getUser<{ id: string }>()?.id}`);

    expect(result).toMatchObject({ status: "resumed", user: { id: "u-new" } });
    expect(events).toEqual(["cleanup:u-new", "committed:u-new"]);
  });

  it("state 不匹配时拒绝换票，并保持本地无会话状态", async () => {
    setState({ user: null, status: "unauthenticated" });
    const fetchMock = vi.fn(async () =>
      json({ status: "resume_required", code: "AC-forged", state: "other-state" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(resumeSession()).rejects.toMatchObject({
      name: "AuthClientError",
      code: "session_resume_invalid_response",
      retryable: false,
      blocking: false,
    } satisfies Partial<AuthClientError>);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(getState()).toEqual({ user: null, status: "unauthenticated" });
  });

  it.each([
    ["invalid JSON", new Response("not-json", { status: 200 })],
    ["invalid shape", json({ status: "resume_required", code: "AC-only" })],
  ])("%s 返回稳定的 invalid_response，且不改变本地会话", async (_label, response) => {
    setState({ user: null, status: "unauthenticated" });
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(resumeSession()).rejects.toMatchObject({
      code: "session_resume_invalid_response",
      retryable: false,
      blocking: false,
    } satisfies Partial<AuthClientError>);
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(getState()).toEqual({ user: null, status: "unauthenticated" });
  });

  it.each([
    ["network", async () => { throw new TypeError("network down"); }, undefined],
    ["5xx", async () => json({ error: "unavailable" }, 503), 503],
  ])("%s 失败返回可重试错误，且不改变本地会话", async (_label, handler, status) => {
    setState({ user: null, status: "unauthenticated" });
    vi.stubGlobal("fetch", vi.fn(handler));

    await expect(resumeSession()).rejects.toMatchObject({
      code: "session_resume_failed",
      retryable: true,
      blocking: false,
      ...(status === undefined ? {} : { status }),
    } satisfies Partial<AuthClientError>);
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(getState()).toEqual({ user: null, status: "unauthenticated" });
  });

  it("换票失败统一包装为 session_resume_failed，且不提交部分会话", async () => {
    setState({ user: null, status: "unauthenticated" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/auth/session/resume")) {
          const body = JSON.parse(init?.body as string) as Record<string, string>;
          return json({ status: "resume_required", code: "AC-once", state: body.state });
        }
        return json({ error: "expired_code" }, 401);
      }),
    );

    await expect(resumeSession()).rejects.toMatchObject({
      code: "session_resume_failed",
      status: 401,
      retryable: false,
      blocking: false,
    } satisfies Partial<AuthClientError>);
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(tokenStore().getRefreshToken()).toBeNull();
    expect(getState()).toEqual({ user: null, status: "unauthenticated" });
  });

  it("同标签并发调用合流，并通过按 client 命名的 Web Lock 执行恢复", async () => {
    const lockNames: string[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: async (name: string, callback: () => Promise<unknown>) => {
          lockNames.push(name);
          return callback();
        },
      },
    });
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);

    const first = resumeSession();
    const second = resumeSession();
    resolveResponse(json({ status: "no_session" }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "no_session" },
      { status: "no_session" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(lockNames).toEqual(["auth-client-web:session-mutation:fusion"]);
  });

  it("等待 Web Lock 期间兄弟标签完成恢复时重读本地 token，不重复请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", {
      locks: {
        request: async (_name: string, callback: () => Promise<unknown>) => {
          tokenStore().setAuthenticatedSession(
            { accessToken: "AT-other-tab", refreshToken: "RT-other-tab", expiresIn: 900 },
            { id: "u-other-tab" },
          );
          return callback();
        },
      },
    });

    await expect(resumeSession()).resolves.toEqual({ status: "local_session" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
