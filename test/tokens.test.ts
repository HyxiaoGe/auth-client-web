import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { AuthClientError } from "../src/errors.js";
import { getAccessToken, refresh, resetTokens } from "../src/tokens.js";
import { tokenStore } from "../src/session.js";
import { getState, resetStore, setState } from "../src/store.js";

const AUTH = "https://auth.example";

function stubRefresh(opts: { status?: number } = {}) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (opts.status && opts.status >= 400) return new Response("no", { status: opts.status });
    return new Response(
      JSON.stringify({ access_token: "AT2", refresh_token: "RT2", token_type: "bearer", expires_in: 900 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getAccessToken() + refresh coalescing", () => {
  beforeEach(() => {
    resetConfig();
    resetStore();
    resetTokens();
    localStorage.clear();
    configure({ authUrl: AUTH, clientId: "audio", redirectUri: "https://app/cb" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the stored token without a network call when it is still fresh", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 });
    const fetchMock = stubRefresh();
    expect(await getAccessToken()).toBe("AT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("账户切换屏障生效后不返回或刷新旧票据", async () => {
    tokenStore().setSession({ accessToken: "AT-old", refreshToken: "RT-old", expiresIn: 3600 });
    setState({ user: { id: "u-old" }, status: "synchronizing" });
    const fetchMock = stubRefresh();

    await expect(getAccessToken()).rejects.toMatchObject({
      name: "AuthClientError",
      code: "session_reconcile_blocked",
      blocking: true,
    } satisfies Partial<AuthClientError>);
    await expect(refresh()).rejects.toMatchObject({
      name: "AuthClientError",
      code: "session_reconcile_blocked",
      blocking: true,
    } satisfies Partial<AuthClientError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("共享存储已提交 B 但切换事件尚未投递时同步阻断 A 请求", async () => {
    tokenStore().setAuthenticatedSession(
      { accessToken: "AT-old", refreshToken: "RT-old", expiresIn: 3600 },
      { id: "u-old" },
    );
    setState({ user: { id: "u-old" }, status: "authenticated" });

    // 模拟兄弟标签完成原子 B 会话提交，但 switched 事件仍排在浏览器任务队列中。
    tokenStore().setAuthenticatedSession(
      { accessToken: "AT-new", refreshToken: "RT-new", expiresIn: 3600 },
      { id: "u-new" },
    );
    const observedStatuses: string[] = [];
    const unsubscribe = (await import("../src/store.js")).subscribe((state) => {
      observedStatuses.push(state.status);
    });

    await expect(getAccessToken()).rejects.toMatchObject({
      code: "session_reconcile_blocked",
      blocking: true,
    } satisfies Partial<AuthClientError>);

    unsubscribe();
    expect(observedStatuses).toEqual(["synchronizing", "authenticated"]);
    expect(getState()).toEqual({ user: { id: "u-new" }, status: "authenticated" });
    expect(await getAccessToken()).toBe("AT-new");
  });

  it("refreshes an expired token and persists the rotated pair", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: -100 }); // already expired
    const fetchMock = stubRefresh();

    const token = await getAccessToken();

    expect(token).toBe("AT2");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${AUTH}/auth/token/refresh`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ refresh_token: "RT" });
    expect(tokenStore().getAccessToken()).toBe("AT2");
    expect(tokenStore().getRefreshToken()).toBe("RT2"); // rotation persisted
  });

  it("coalesces concurrent refreshes into a single network call", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: -100 });
    const fetchMock = stubRefresh();

    const results = await Promise.all([getAccessToken(), getAccessToken(), getAccessToken()]);

    expect(results).toEqual(["AT2", "AT2", "AT2"]);
    expect(fetchMock).toHaveBeenCalledOnce(); // three callers, one refresh
  });

  it("clears the session and unauthenticates when refresh is rejected", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: -100 });
    stubRefresh({ status: 401 });

    expect(await getAccessToken()).toBeNull();
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(getState().status).toBe("unauthenticated");
  });

  it("does not clear the session on 401 when another tab already rotated the token", async () => {
    // Two tabs race a refresh. Tab A wins and persists AT2/RT2 to shared storage; our request
    // (Tab B, with the now-spent RT) comes back 401. We must recover A's token, not log the user out.
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: -100 });
    const fetchMock = vi.fn(async () => {
      // simulate the winning tab persisting a rotated pair before our 401 lands
      tokenStore().setSession({ accessToken: "AT2", refreshToken: "RT2", expiresIn: 900 });
      return new Response("rotated away", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = await getAccessToken();

    expect(token).toBe("AT2"); // recovered the winner's access token
    expect(tokenStore().getAccessToken()).toBe("AT2"); // session NOT cleared
    expect(getState().status).not.toBe("unauthenticated");
  });

  it("returns null without a network call when there is no refresh token", async () => {
    const fetchMock = stubRefresh();
    expect(await getAccessToken()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** A stand-in for the browser LockManager. The real API guarantees cross-TAB mutual exclusion;
 * a single test process can't span tabs, so we only assert the SDK ROUTES its refresh through
 * the lock (named per client) and presents the rotating refresh token strictly while the lock
 * is held -- the property that stops two tabs presenting the same token and tripping
 * auth-service's refresh-reuse detection (which revokes every token for the user). */
function fakeLockManager() {
  const names: string[] = [];
  const held = new Set<string>();
  const tails = new Map<string, Promise<void>>();
  return {
    names,
    isHeld: (name?: string) => name === undefined ? held.size > 0 : held.has(name),
    manager: {
      request: async (name: string, cb: () => Promise<unknown>) => {
        names.push(name);
        const previous = tails.get(name) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        tails.set(name, previous.then(() => current));
        await previous;
        held.add(name);
        try {
          return await cb();
        } finally {
          held.delete(name);
          release();
        }
      },
    },
  };
}

function rotatedResponse(access: string, refreshTok: string) {
  return new Response(
    JSON.stringify({ access_token: access, refresh_token: refreshTok, token_type: "bearer", expires_in: 900 }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("refresh(): cross-tab coalescing via Web Locks", () => {
  beforeEach(() => {
    resetConfig();
    resetStore();
    resetTokens();
    localStorage.clear();
    configure({ authUrl: AUTH, clientId: "fusion", redirectUri: "https://app/cb" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes the refresh through a per-client Web Lock when navigator.locks is available", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "R1", expiresIn: 900 });
    const lock = fakeLockManager();
    vi.stubGlobal("navigator", { locks: lock.manager });
    vi.stubGlobal("fetch", vi.fn(async () => rotatedResponse("AT2", "R2")));

    const token = await refresh();

    expect(lock.names).toEqual([
      "auth-client-web:refresh:fusion",
      "auth-client-web:session-mutation:fusion",
    ]);
    expect(token).toBe("AT2");
    expect(tokenStore().getRefreshToken()).toBe("R2"); // rotated inside the lock
  });

  it("presents the refresh token only while the lock is held (no stale pre-lock network call)", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "R1", expiresIn: 900 });
    const lock = fakeLockManager();
    vi.stubGlobal("navigator", { locks: lock.manager });
    const heldWhenFetched: boolean[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        heldWhenFetched.push(lock.isHeld());
        return rotatedResponse("AT2", "R2");
      }),
    );

    await refresh();

    expect(heldWhenFetched).toEqual([true]); // the POST /auth/token/refresh fired inside the lock
  });

  it("最终 CAS 后排队提交 B 时，A refresh 成功结果不能在统一写锁外覆盖 B", async () => {
    tokenStore().setAuthenticatedSession(
      { accessToken: "AT-old", refreshToken: "R-old", expiresIn: 900 },
      { id: "u-old" },
    );
    setState({ user: { id: "u-old" }, status: "authenticated" });
    const lock = fakeLockManager();
    vi.stubGlobal("navigator", { locks: lock.manager });
    vi.stubGlobal("fetch", vi.fn(async () => rotatedResponse("AT-old-rotated", "R-old-rotated")));

    const originalGetItem = Storage.prototype.getItem;
    let queuedSwitch: Promise<unknown> | null = null;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      const value = originalGetItem.call(this, key);
      if (
        queuedSwitch === null &&
        key.startsWith("auth-client-web:session:v1:") &&
        lock.isHeld("auth-client-web:session-mutation:fusion")
      ) {
        queuedSwitch = lock.manager.request("auth-client-web:session-mutation:fusion", async () => {
          tokenStore().setAuthenticatedSession(
            { accessToken: "AT-B", refreshToken: "R-B", expiresIn: 900 },
            { id: "u-B" },
          );
          setState({ user: { id: "u-B" }, status: "authenticated" });
        });
      }
      return value;
    });

    await refresh();
    await queuedSwitch;

    expect(tokenStore().getAccessToken()).toBe("AT-B");
    expect(tokenStore().getRefreshToken()).toBe("R-B");
    expect(tokenStore().getUser()).toEqual({ id: "u-B" });
  });

  it("最终 CAS 后排队提交 B 时，A refresh 的 401 清理不能删除 B", async () => {
    tokenStore().setAuthenticatedSession(
      { accessToken: "AT-old", refreshToken: "R-old", expiresIn: 900 },
      { id: "u-old" },
    );
    setState({ user: { id: "u-old" }, status: "authenticated" });
    const lock = fakeLockManager();
    vi.stubGlobal("navigator", { locks: lock.manager });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rejected", { status: 401 })));

    const originalGetItem = Storage.prototype.getItem;
    let queuedSwitch: Promise<unknown> | null = null;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      const value = originalGetItem.call(this, key);
      if (
        queuedSwitch === null &&
        key.startsWith("auth-client-web:session:v1:") &&
        lock.isHeld("auth-client-web:session-mutation:fusion")
      ) {
        queuedSwitch = lock.manager.request("auth-client-web:session-mutation:fusion", async () => {
          tokenStore().setAuthenticatedSession(
            { accessToken: "AT-B", refreshToken: "R-B", expiresIn: 900 },
            { id: "u-B" },
          );
          setState({ user: { id: "u-B" }, status: "authenticated" });
        });
      }
      return value;
    });

    await expect(refresh()).resolves.toBeNull();
    await queuedSwitch;

    expect(tokenStore().getAccessToken()).toBe("AT-B");
    expect(tokenStore().getRefreshToken()).toBe("R-B");
    expect(tokenStore().getUser()).toEqual({ id: "u-B" });
  });

  it("refresh 等待期间账户切换屏障生效时丢弃旧 sid 的成功响应", async () => {
    tokenStore().setSession({ accessToken: "AT-old", refreshToken: "R-old", expiresIn: 900 });
    setState({ user: { id: "u-old" }, status: "authenticated" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        setState({ status: "synchronizing" });
        return rotatedResponse("AT-old-rotated", "R-old-rotated");
      }),
    );

    await expect(refresh()).rejects.toMatchObject({
      code: "session_reconcile_blocked",
      blocking: true,
    } satisfies Partial<AuthClientError>);
    expect(tokenStore().getAccessToken()).toBe("AT-old");
    expect(tokenStore().getRefreshToken()).toBe("R-old");
  });

  it("旧 refresh 成功响应晚于兄弟标签的新会话提交时采用胜者，不覆盖新账户", async () => {
    tokenStore().setSession({ accessToken: "AT-old", refreshToken: "R-old", expiresIn: 900 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        tokenStore().setAuthenticatedSession(
          { accessToken: "AT-new-user", refreshToken: "R-new-user", expiresIn: 900 },
          { id: "u-new" },
        );
        setState({ user: { id: "u-new" }, status: "authenticated" });
        return rotatedResponse("AT-stale-old-user", "R-stale-old-user");
      }),
    );

    await expect(refresh()).resolves.toBe("AT-new-user");
    expect(tokenStore().getAccessToken()).toBe("AT-new-user");
    expect(tokenStore().getRefreshToken()).toBe("R-new-user");
    expect(tokenStore().getUser()).toEqual({ id: "u-new" });
  });

  it("解析旧 refresh 响应期间新会话落库时仍会在最终提交前重新采用胜者", async () => {
    tokenStore().setSession({ accessToken: "AT-old", refreshToken: "R-old", expiresIn: 900 });
    const response = rotatedResponse("AT-stale-old-user", "R-stale-old-user");
    const originalJson = response.json.bind(response);
    vi.spyOn(response, "json").mockImplementation(async () => {
      tokenStore().setAuthenticatedSession(
        { accessToken: "AT-new-user", refreshToken: "R-new-user", expiresIn: 900 },
        { id: "u-new" },
      );
      setState({ user: { id: "u-new" }, status: "authenticated" });
      return originalJson();
    });
    vi.stubGlobal("fetch", vi.fn(async () => response));

    await expect(refresh()).resolves.toBe("AT-new-user");
    expect(tokenStore().getAccessToken()).toBe("AT-new-user");
    expect(tokenStore().getRefreshToken()).toBe("R-new-user");
    expect(tokenStore().getUser()).toEqual({ id: "u-new" });
  });

  it("falls back to a direct refresh when navigator.locks is unavailable (SSR / old browsers)", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "R1", expiresIn: 900 });
    vi.stubGlobal("navigator", {}); // no .locks
    vi.stubGlobal("fetch", vi.fn(async () => rotatedResponse("AT2", "R2")));

    const token = await refresh();

    expect(token).toBe("AT2");
    expect(tokenStore().getRefreshToken()).toBe("R2");
  });
});

/** A rotation RESPONSE lost over a flaky tunnel can surface as a 5xx / network error, not a clean
 * 401. A client-side clock cannot prove a replay still falls inside auth-service's grace window,
 * so the SDK never replays a one-time refresh token after an ambiguous outcome. It quarantines the
 * old token and lets the host recover through central SSO. A definitive 401/403 logs out; 429 is
 * preserved because the server explicitly answered without rotating. */
describe("refresh(): transient (5xx/429) vs definitive (401/403) failure", () => {
  beforeEach(() => {
    resetConfig();
    resetStore();
    resetTokens();
    localStorage.clear();
    configure({ authUrl: AUTH, clientId: "audio", redirectUri: "https://app/cb" });
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: -100 }); // expired
    setState({ user: { id: "u1" }, status: "authenticated" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("logs out on a 401 (refresh token truly rejected)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    expect(await refresh()).toBeNull();
    expect(getState().status).toBe("unauthenticated");
    expect(tokenStore().getRefreshToken()).toBeNull();
  });

  it("logs out on a 403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
    expect(await refresh()).toBeNull();
    expect(getState().status).toBe("unauthenticated");
    expect(tokenStore().getRefreshToken()).toBeNull();
  });

  it("单次 5xx 后隔离不可安全重放的旧 refresh token", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(refresh()).rejects.toMatchObject({
      name: "AuthClientError",
      code: "token_refresh_outcome_unknown",
      status: 502,
      retryable: false,
      message: "Token refresh outcome is unknown: 502",
    } satisfies Partial<AuthClientError>);
    expect(getState().status).toBe("unauthenticated");
    expect(tokenStore().getRefreshToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT log out on a 429 -- transient", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    await expect(refresh()).rejects.toThrow();
    expect(getState().status).toBe("authenticated");
    expect(tokenStore().getRefreshToken()).toBe("RT");
  });

  it("单次网络异常后隔离旧会话，绝不重放结果未知的一次性票据", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(refresh()).rejects.toMatchObject({
      name: "AuthClientError",
      code: "token_refresh_outcome_unknown",
      retryable: false,
      message: "Token refresh outcome is unknown: network error",
    } satisfies Partial<AuthClientError>);
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(tokenStore().getRefreshToken()).toBeNull();
    expect(getState().status).toBe("unauthenticated");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("响应丢失后即使后续预设成功也不发送第二次旧票据", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(rotatedResponse("AT-successor", "RT-successor"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refresh()).rejects.toMatchObject({
      code: "token_refresh_outcome_unknown",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenStore().getRefreshToken()).toBeNull();
    expect(getState().status).toBe("unauthenticated");
  });

  it("网关 5xx 后即使后续预设成功也不重放旧票据", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(rotatedResponse("AT-successor", "RT-successor"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refresh()).rejects.toMatchObject({
      code: "token_refresh_outcome_unknown",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenStore().getRefreshToken()).toBeNull();
  });
});

describe("refresh(): token 响应运行时校验", () => {
  beforeEach(() => {
    resetConfig();
    resetStore();
    resetTokens();
    localStorage.clear();
    configure({ authUrl: AUTH, clientId: "audio", redirectUri: "https://app/cb" });
    tokenStore().setSession({ accessToken: "AT-old", refreshToken: "RT-old", expiresIn: -100 });
    setState({ user: { id: "u1" }, status: "authenticated" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["空 access_token", { access_token: "", refresh_token: "RT2", expires_in: 900 }],
    ["空 refresh_token", { access_token: "AT2", refresh_token: "   ", expires_in: 900 }],
    ["字符串 expires_in", { access_token: "AT2", refresh_token: "RT2", expires_in: "900" }],
    ["非正 expires_in", { access_token: "AT2", refresh_token: "RT2", expires_in: 0 }],
  ])("拒绝%s响应并立即隔离旧 token", async (_label, payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(refresh()).rejects.toMatchObject({
      name: "AuthClientError",
      code: "token_refresh_outcome_unknown",
      retryable: false,
    } satisfies Partial<AuthClientError>);
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(tokenStore().getRefreshToken()).toBeNull();
    expect(getState()).toEqual({ user: null, status: "unauthenticated" });
  });

  it("单次异常 JSON 后隔离旧 token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(refresh()).rejects.toMatchObject({
      name: "AuthClientError",
      code: "token_refresh_outcome_unknown",
      retryable: false,
    } satisfies Partial<AuthClientError>);
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(tokenStore().getRefreshToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("无效成功响应后即使后续预设成功也不重放旧票据", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
      )
      .mockResolvedValueOnce(rotatedResponse("AT-successor", "RT-successor"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refresh()).rejects.toMatchObject({
      code: "token_refresh_outcome_unknown",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenStore().getRefreshToken()).toBeNull();
  });
});

describe("refresh(): 持久化提交失败", () => {
  beforeEach(() => {
    resetConfig();
    resetStore();
    resetTokens();
    localStorage.clear();
    configure({ authUrl: AUTH, clientId: "audio", redirectUri: "https://app/cb" });
    tokenStore().setSession({ accessToken: "AT-old", refreshToken: "RT-old", expiresIn: -100 });
    tokenStore().setUser({ id: "u-old" });
    setState({ user: { id: "u-old" }, status: "authenticated" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("轮换 token 原子 record 写入失败时不留下混合会话，并透传 QuotaExceededError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => rotatedResponse("AT-new", "RT-new")));
    const originalSetItem = Storage.prototype.setItem;
    let writes = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage) {
        writes += 1;
        if (writes === 1) throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      }
      originalSetItem.call(this, key, value);
    });

    await expect(refresh()).rejects.toMatchObject({ name: "QuotaExceededError" });

    expect(tokenStore().getAccessToken()).toBeNull();
    expect(tokenStore().getRefreshToken()).toBeNull();
    expect(tokenStore().getUser()).toBeNull();
    expect(getState()).toEqual({ user: null, status: "unauthenticated" });
  });
});
