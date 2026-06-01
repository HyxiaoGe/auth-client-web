import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { getAccessToken, resetTokens } from "../src/tokens.js";
import { tokenStore } from "../src/session.js";
import { getState, resetStore } from "../src/store.js";

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
