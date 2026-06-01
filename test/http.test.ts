import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { fetchWithAuth } from "../src/http.js";
import { resetTokens } from "../src/tokens.js";
import { tokenStore } from "../src/session.js";
import { resetStore } from "../src/store.js";

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
});
