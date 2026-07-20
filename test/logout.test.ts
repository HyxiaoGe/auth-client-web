import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { logout } from "../src/logout.js";
import * as navigation from "../src/navigation.js";
import { tokenStore } from "../src/session.js";
import { getState, resetStore, setState } from "../src/store.js";

const AUTH = "https://auth.example";

function unsignedJwt(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `eyJhbGciOiJub25lIn0.${encoded}.signature-not-verified-by-client`;
}

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

  it("global logout: 有 sid 时使用严格的 /auth/logout/session", async () => {
    setState({ user: { id: "u" }, status: "authenticated" });
    const sid = "source_sid_abcdefghijklmnopqrstuvwxyz123456";
    tokenStore().setSession({ accessToken: unsignedJwt({ sid }), refreshToken: "RT", expiresIn: 900 });
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const submitForm = vi.spyOn(navigation, "submitForm").mockImplementation(() => {});

    await logout({ global: true });

    // the per-app local clear still runs first (best-effort revoke + clear + unauthenticate)
    expect(fetchMock).toHaveBeenCalledWith(`${AUTH}/auth/token/revoke`, expect.anything());
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(getState()).toEqual({ user: null, status: "unauthenticated" });
    // then the Single Logout top-level POST-form, defaulting post_logout_redirect_uri to the
    // app's registered redirectUri so the 302 bounce-back is clean
    expect(submitForm).toHaveBeenCalledWith(`${AUTH}/auth/logout/session`, {
      post_logout_redirect_uri: "https://app/cb",
      client_id: "audio",
      session_sid: sid,
    });
  });

  it("global logout: legacy access token 没有 sid 时保持省略字段兼容", async () => {
    tokenStore().setSession({
      accessToken: unsignedJwt({ sub: "u-legacy" }),
      refreshToken: "RT",
      expiresIn: 900,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const submitForm = vi.spyOn(navigation, "submitForm").mockImplementation(() => {});

    await logout({ global: true });

    expect(submitForm).toHaveBeenCalledWith(`${AUTH}/auth/logout`, {
      post_logout_redirect_uri: "https://app/cb",
      client_id: "audio",
    });
  });

  it.each([
    ["畸形 JWT", "not-a-jwt"],
    ["非法 base64url", "header.***.signature"],
    ["非对象 payload", "header.ImFiYyI.signature"],
    ["非字符串 sid", unsignedJwt({ sid: 42 })],
    ["过短 sid", unsignedJwt({ sid: "short" })],
    ["包含非 url-safe 字符", unsignedJwt({ sid: "invalid sid value with spaces" })],
    ["过长 sid", unsignedJwt({ sid: "a".repeat(129) })],
  ])("global logout: %s 不向表单附加未经形状校验的 session_sid", async (_label, accessToken) => {
    tokenStore().setSession({ accessToken, refreshToken: "RT", expiresIn: 900 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const submitForm = vi.spyOn(navigation, "submitForm").mockImplementation(() => {});

    await logout({ global: true });

    const fields = submitForm.mock.calls[0]?.[1];
    expect(fields).not.toHaveProperty("session_sid");
  });

  it("global logout: honors an explicit postLogoutRedirectUri override", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const submitForm = vi.spyOn(navigation, "submitForm").mockImplementation(() => {});
    await logout({ global: true, postLogoutRedirectUri: "https://app/bye" });
    expect(submitForm).toHaveBeenCalledWith(`${AUTH}/auth/logout`, {
      post_logout_redirect_uri: "https://app/bye",
      client_id: "audio",
    });
  });

  it("global logout: still clears locally even if the revoke fails, then navigates", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 900 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const submitForm = vi.spyOn(navigation, "submitForm").mockImplementation(() => {});
    await expect(logout({ global: true })).resolves.toBeUndefined();
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(getState().status).toBe("unauthenticated");
    expect(submitForm).toHaveBeenCalled();
  });

  it("global logout: uses the POST-form nav, not redirect(), even if redirectTo is also passed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const submitForm = vi.spyOn(navigation, "submitForm").mockImplementation(() => {});
    const redirect = vi.spyOn(navigation, "redirect").mockImplementation(() => {});
    await logout({ global: true, redirectTo: "/ignored" });
    expect(submitForm).toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("back-compat: a non-global logout never POST-forms to /auth/logout", async () => {
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 900 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const submitForm = vi.spyOn(navigation, "submitForm").mockImplementation(() => {});
    await logout();
    expect(submitForm).not.toHaveBeenCalled();
  });
});
