import { beforeEach, describe, expect, it } from "vitest";

import { startPendingAuth, takePendingAuth } from "../src/pending.js";

describe("pending auth (state + PKCE verifier across the redirect)", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("round-trips the verifier and returns a fresh state", () => {
    const state = startPendingAuth("verifier-xyz");
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/); // url-safe CSRF token
    expect(state.length).toBeGreaterThanOrEqual(20);

    const pending = takePendingAuth();
    expect(pending).toEqual({ state, verifier: "verifier-xyz" });
  });

  it("is single-use: a second take returns null", () => {
    startPendingAuth("v1");
    takePendingAuth();
    expect(takePendingAuth()).toBeNull();
  });

  it("returns null when nothing is pending", () => {
    expect(takePendingAuth()).toBeNull();
  });

  it("only one auth is in flight: a second start overwrites the first", () => {
    startPendingAuth("v1");
    const state2 = startPendingAuth("v2");
    expect(takePendingAuth()).toEqual({ state: state2, verifier: "v2" });
  });

  it("generates a different state each call", () => {
    const s1 = startPendingAuth("v");
    const s2 = startPendingAuth("v");
    expect(s1).not.toBe(s2);
  });
});
