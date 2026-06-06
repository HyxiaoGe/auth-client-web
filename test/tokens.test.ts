import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure, resetConfig } from "../src/config.js";
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
    await expect(refresh()).rejects.toThrow();
    expect(getState().status).toBe("authenticated"); // session preserved
    expect(tokenStore().getRefreshToken()).toBe("RT"); // token kept for the next retry
  });

  it("does NOT log out on a 429 -- transient", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    await expect(refresh()).rejects.toThrow();
    expect(getState().status).toBe("authenticated");
    expect(tokenStore().getRefreshToken()).toBe("RT");
  });
});
