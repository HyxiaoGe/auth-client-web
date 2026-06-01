import { beforeEach, describe, expect, it, vi } from "vitest";

import { getState, resetStore, setState, subscribe } from "../src/store.js";

describe("auth store (framework-neutral observable)", () => {
  beforeEach(() => {
    resetStore();
  });

  it("starts in loading with no user", () => {
    expect(getState()).toEqual({ user: null, status: "loading" });
  });

  it("setState merges and notifies subscribers", () => {
    const seen = vi.fn();
    subscribe(seen);
    setState({ status: "authenticated", user: { id: "1" } });
    expect(getState()).toEqual({ status: "authenticated", user: { id: "1" } });
    expect(seen).toHaveBeenCalledWith({ status: "authenticated", user: { id: "1" } });
  });

  it("unsubscribe stops further notifications", () => {
    const seen = vi.fn();
    const off = subscribe(seen);
    off();
    setState({ status: "unauthenticated" });
    expect(seen).not.toHaveBeenCalled();
  });
});
