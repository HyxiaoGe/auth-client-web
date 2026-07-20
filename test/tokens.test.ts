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
  });

  it("returns the stored token without a network call when it is still fresh", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 });
    const fetchMock = stubRefresh();
    expect(await getAccessToken()).toBe("AT");
    expect(fetchMock).not.toHaveBeenCalled();
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
  let held = false;
  return {
    names,
    isHeld: () => held,
    manager: {
      request: async (name: string, cb: () => Promise<unknown>) => {
        names.push(name);
        held = true;
        try {
          return await cb();
        } finally {
          held = false;
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
  });

  it("routes the refresh through a per-client Web Lock when navigator.locks is available", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "R1", expiresIn: 900 });
    const lock = fakeLockManager();
    vi.stubGlobal("navigator", { locks: lock.manager });
    vi.stubGlobal("fetch", vi.fn(async () => rotatedResponse("AT2", "R2")));

    const token = await refresh();

    expect(lock.names).toEqual(["auth-client-web:refresh:fusion"]);
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

  it("falls back to a direct refresh when navigator.locks is unavailable (SSR / old browsers)", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "R1", expiresIn: 900 });
    vi.stubGlobal("navigator", {}); // no .locks
    vi.stubGlobal("fetch", vi.fn(async () => rotatedResponse("AT2", "R2")));

    const token = await refresh();

    expect(token).toBe("AT2");
    expect(tokenStore().getRefreshToken()).toBe("R2");
  });
});

/** A rotation RESPONSE lost over a flaky tunnel surfaces to the client as a 5xx / 429 / error page,
 * NOT a clean 401. Treating those transient failures as a logout is the passive-logout bug: a
 * dropped response must never clear the session. Only a definitive 401/403 (refresh token actually
 * rejected) logs out; anything else is kept and rethrown so the caller retries (and auth-service's
 * rotation-grace window re-issues the successor). */
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

  it("does NOT log out on a 5xx -- keeps the token and throws (transient)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 502 })));
    await expect(refresh()).rejects.toMatchObject({
      name: "AuthClientError",
      code: "token_refresh_failed",
      status: 502,
      retryable: true,
      message: "Token refresh failed: 502",
    } satisfies Partial<AuthClientError>);
    expect(getState().status).toBe("authenticated"); // session preserved
    expect(tokenStore().getRefreshToken()).toBe("RT"); // token kept for the next retry
  });

  it("does NOT log out on a 429 -- transient", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    await expect(refresh()).rejects.toThrow();
    expect(getState().status).toBe("authenticated");
    expect(tokenStore().getRefreshToken()).toBe("RT");
  });

  it("网络异常会转成可重试的结构化错误，并保留既有会话", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network down");
    }));

    await expect(refresh()).rejects.toMatchObject({
      name: "AuthClientError",
      code: "token_refresh_failed",
      retryable: true,
      message: "Token refresh failed: network error",
    } satisfies Partial<AuthClientError>);
    expect(tokenStore().getAccessToken()).toBe("AT");
    expect(tokenStore().getRefreshToken()).toBe("RT");
    expect(getState().status).toBe("authenticated");
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
  ])("拒绝%s且不覆盖旧 token", async (_label, payload) => {
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
      code: "token_refresh_invalid_response",
      retryable: true,
    } satisfies Partial<AuthClientError>);
    expect(tokenStore().getAccessToken()).toBe("AT-old");
    expect(tokenStore().getRefreshToken()).toBe("RT-old");
    expect(getState()).toEqual({ user: { id: "u1" }, status: "authenticated" });
  });

  it("拒绝异常 JSON 且不覆盖旧 token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    );

    await expect(refresh()).rejects.toMatchObject({
      name: "AuthClientError",
      code: "token_refresh_invalid_response",
      retryable: true,
    } satisfies Partial<AuthClientError>);
    expect(tokenStore().getAccessToken()).toBe("AT-old");
    expect(tokenStore().getRefreshToken()).toBe("RT-old");
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

  it("轮换 token 第二次 setItem 失败时不留下混合会话，并透传 QuotaExceededError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => rotatedResponse("AT-new", "RT-new")));
    const originalSetItem = Storage.prototype.setItem;
    let writes = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage) {
        writes += 1;
        if (writes === 2) throw new DOMException("Storage quota exceeded", "QuotaExceededError");
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
