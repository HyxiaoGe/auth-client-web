import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { logout } from "../src/logout.js";
import * as navigation from "../src/navigation.js";
import { tokenStore } from "../src/session.js";
import { getState, resetStore, setState } from "../src/store.js";

const AUTH = "https://auth.example";

describe("logout()", () => {
  beforeEach(() => {
    resetConfig();
    resetStore();
    localStorage.clear();
    configure({ authUrl: AUTH, clientId: "audio", redirectUri: "https://app/cb" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("revokes the stored refresh token, clears the session, and unauthenticates", async () => {
    setState({ user: { id: "u" }, status: "authenticated" });
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 900 });
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ message: "ok" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await logout();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${AUTH}/auth/token/revoke`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ refresh_token: "RT" });
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(getState()).toEqual({ user: null, status: "unauthenticated" });
  });

  it("still clears + unauthenticates with no network call when there is no refresh token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await logout();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getState().status).toBe("unauthenticated");
  });

  it("clears locally even if the revoke request fails (logout is best-effort on the wire)", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 900 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(logout()).resolves.toBeUndefined();
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(getState().status).toBe("unauthenticated");
  });

  it("navigates to redirectTo after clearing when given", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 900 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const redirect = vi.spyOn(navigation, "redirect").mockImplementation(() => {});
    await logout({ redirectTo: "/goodbye" });
    expect(redirect).toHaveBeenCalledWith("/goodbye");
  });
});
