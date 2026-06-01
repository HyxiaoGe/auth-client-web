import { beforeEach, describe, expect, it, vi } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { generatePkce } from "../src/pkce.js";
import { buildAuthorizeUrl, login, silentLogin } from "../src/authorize.js";
import * as navigation from "../src/navigation.js";
import { takePendingAuth } from "../src/pending.js";

function parse(url: string) {
  const u = new URL(url);
  return { base: `${u.origin}${u.pathname}`, q: u.searchParams };
}

describe("buildAuthorizeUrl", () => {
  beforeEach(() => {
    resetConfig();
    sessionStorage.clear();
    configure({ authUrl: "https://auth.example", clientId: "appA", redirectUri: "https://app/cb" });
  });

  it("targets /auth/authorize with the required OIDC + PKCE params", async () => {
    const { base, q } = parse(await buildAuthorizeUrl({}));
    expect(base).toBe("https://auth.example/auth/authorize");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("appA");
    expect(q.get("redirect_uri")).toBe("https://app/cb");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBeTruthy();
    expect(q.get("state")).toBeTruthy();
    expect(q.has("prompt")).toBe(false);
    expect(q.has("provider")).toBe(false);
  });

  it("the URL's code_challenge is S256 of the PERSISTED verifier, and state matches", async () => {
    const { q } = parse(await buildAuthorizeUrl({ provider: "google" }));
    const pending = takePendingAuth();
    expect(pending).not.toBeNull();
    expect(pending!.state).toBe(q.get("state"));
    const { challenge } = await generatePkce(pending!.verifier);
    expect(challenge).toBe(q.get("code_challenge")); // the verifier we kept proves this code
  });

  it("adds prompt and provider when given", async () => {
    const { q } = parse(await buildAuthorizeUrl({ prompt: "none", provider: "github" }));
    expect(q.get("prompt")).toBe("none");
    expect(q.get("provider")).toBe("github");
  });
});

describe("login / silentLogin", () => {
  beforeEach(() => {
    resetConfig();
    sessionStorage.clear();
    configure({ authUrl: "https://auth.example", clientId: "appA", redirectUri: "https://app/cb" });
  });

  it("login() navigates to an interactive authorize URL and remembers the post-login path", async () => {
    const redirect = vi.spyOn(navigation, "redirect").mockImplementation(() => {});
    await login("google", { redirectPath: "/tasks" });
    expect(redirect).toHaveBeenCalledOnce();
    const { q } = parse(redirect.mock.calls[0]![0]);
    expect(q.get("provider")).toBe("google");
    expect(q.has("prompt")).toBe(false);
    expect(sessionStorage.getItem("acw_redirect_path")).toBe("/tasks");
  });

  it("silentLogin() navigates with prompt=none for an invisible SSO probe", async () => {
    const redirect = vi.spyOn(navigation, "redirect").mockImplementation(() => {});
    await silentLogin();
    const { q } = parse(redirect.mock.calls[0]![0]);
    expect(q.get("prompt")).toBe("none");
  });
});
