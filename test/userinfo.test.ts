import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { fetchUserInfo } from "../src/userinfo.js";

describe("fetchUserInfo()", () => {
  beforeEach(() => {
    resetConfig();
    configure({ authUrl: "https://auth.example", clientId: "audio", redirectUri: "https://app/cb" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs /auth/userinfo with a Bearer token and maps avatar_url -> avatarUrl", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          id: "u-1",
          email: "a@b.c",
          name: "Ada",
          avatar_url: "https://img/a.png",
          is_superuser: true,
          preferences: { theme: "dark" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const user = await fetchUserInfo("AT-123");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://auth.example/auth/userinfo");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer AT-123" });
    expect(user).toMatchObject({
      id: "u-1",
      email: "a@b.c",
      name: "Ada",
      avatarUrl: "https://img/a.png",
      is_superuser: true,
    });
    expect(user.avatar_url).toBeUndefined(); // the snake_case alias is not leaked through
  });

  it("throws when the userinfo endpoint rejects the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    await expect(fetchUserInfo("bad")).rejects.toThrow();
  });
});
