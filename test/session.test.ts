import { beforeEach, describe, expect, it } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { tokenStore } from "../src/session.js";

describe("tokenStore()", () => {
  beforeEach(() => {
    resetConfig();
    localStorage.clear();
  });

  it("binds to the configured storage keys", () => {
    configure({
      authUrl: "https://auth.example",
      clientId: "audio",
      redirectUri: "https://app/cb",
      storageKeys: { accessToken: "auth_access_token", refreshToken: "r", expiresAt: "e", user: "u" },
    });
    tokenStore().setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 });
    expect(localStorage.getItem("auth_access_token")).toBe("AT"); // wrote to the app's key
  });
});
