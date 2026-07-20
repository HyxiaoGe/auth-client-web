import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { clearLocalSessionIfCurrent } from "../src/session-clear.js";
import { tokenStore } from "../src/session.js";
import { getState, resetStore, setState } from "../src/store.js";
import { subscribe } from "../src/store.js";

describe("clearLocalSessionIfCurrent", () => {
  beforeEach(() => {
    resetConfig();
    resetStore();
    localStorage.clear();
    configure({
      authUrl: "https://auth.example",
      clientId: "audio",
      redirectUri: "https://audio.example/auth/callback",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetConfig();
  });

  it("共享存储仍是收到 401 的旧票据时清除旧会话", async () => {
    tokenStore().setAuthenticatedSession(
      { accessToken: "AT-A", refreshToken: "RT-A", expiresIn: 900 },
      { id: "A" },
    );
    setState({ user: { id: "A" }, status: "authenticated" });

    await expect(clearLocalSessionIfCurrent("AT-A")).resolves.toEqual({ status: "cleared" });

    expect(tokenStore().getAccessToken()).toBeNull();
    expect(getState()).toEqual({ user: null, status: "unauthenticated" });
  });

  it("刷新定论失败已提前清掉旧票据时视为清理完成", async () => {
    setState({ user: { id: "A" }, status: "authenticated" });

    await expect(clearLocalSessionIfCurrent("AT-A")).resolves.toEqual({ status: "cleared" });

    expect(getState()).toEqual({ user: null, status: "unauthenticated" });
  });

  it("清理真正执行前兄弟标签已提交 B 时保留并采用 B", async () => {
    tokenStore().setAuthenticatedSession(
      { accessToken: "AT-A", refreshToken: "RT-A", expiresIn: 900 },
      { id: "A" },
    );
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    vi.stubGlobal("navigator", {
      locks: {
        request: async (_name: string, callback: () => Promise<unknown>) => {
          await lockGate;
          return callback();
        },
      },
    });

    const clearing = clearLocalSessionIfCurrent("AT-A");
    tokenStore().setAuthenticatedSession(
      { accessToken: "AT-B", refreshToken: "RT-B", expiresIn: 900 },
      { id: "B", email: "b@example.com" },
    );
    const observedStatuses: string[] = [];
    const unsubscribe = subscribe((state) => observedStatuses.push(state.status));
    releaseLock();

    await expect(clearing).resolves.toEqual({
      status: "changed",
      user: { id: "B", email: "b@example.com" },
    });
    expect(tokenStore().getAccessToken()).toBe("AT-B");
    expect(tokenStore().getRefreshToken()).toBe("RT-B");
    expect(getState()).toEqual({
      user: { id: "B", email: "b@example.com" },
      status: "authenticated",
    });
    unsubscribe();
    expect(observedStatuses).toEqual(["synchronizing", "authenticated"]);
  });

  it("所有会话写事务使用同一 client 级 Web Lock 名称", async () => {
    const lockNames: string[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: async (name: string, callback: () => Promise<unknown>) => {
          lockNames.push(name);
          return callback();
        },
      },
    });

    await clearLocalSessionIfCurrent(null);

    expect(lockNames).toEqual(["auth-client-web:session-mutation:audio"]);
  });
});
