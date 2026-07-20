import { beforeEach, describe, expect, it } from "vitest";

import { configure, getConfig, resetConfig } from "../src/config.js";
import type { AuthClientError } from "../src/errors.js";

describe("configure / getConfig", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("throws if used before configure()", () => {
    expect(() => getConfig()).toThrow(/configure/i);
    try {
      getConfig();
    } catch (error) {
      expect(error).toMatchObject({
        name: "AuthClientError",
        code: "configuration_error",
        retryable: false,
      } satisfies Partial<AuthClientError>);
    }
  });

  it("returns the resolved config with default storage keys filled in", () => {
    configure({ authUrl: "https://auth.example", clientId: "appA", redirectUri: "https://app/cb" });
    const c = getConfig();
    expect(c.authUrl).toBe("https://auth.example");
    expect(c.clientId).toBe("appA");
    expect(c.redirectUri).toBe("https://app/cb");
    expect(c.storageKeys).toEqual({
      accessToken: "acw_access_token",
      refreshToken: "acw_refresh_token",
      expiresAt: "acw_expires_at",
      user: "acw_user",
    });
  });

  it("strips a trailing slash from authUrl so path joins are clean", () => {
    configure({ authUrl: "https://auth.example/", clientId: "appA", redirectUri: "https://app/cb" });
    expect(getConfig().authUrl).toBe("https://auth.example");
  });

  it("lets an app override storage keys to match its existing localStorage (migration continuity)", () => {
    configure({
      authUrl: "https://auth.example",
      clientId: "audio",
      redirectUri: "https://app/cb",
      storageKeys: {
        accessToken: "auth_access_token",
        refreshToken: "auth_refresh_token",
        expiresAt: "auth_token_expiry",
        user: "auth_user_info",
      },
    });
    expect(getConfig().storageKeys.accessToken).toBe("auth_access_token");
    expect(getConfig().storageKeys.user).toBe("auth_user_info");
  });
});
