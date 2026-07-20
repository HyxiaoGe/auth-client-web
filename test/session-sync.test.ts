import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { tokenStore } from "../src/session.js";
import { getState, resetStore, setState } from "../src/store.js";

const EVENT_KEY = "acw_session_sync:fusion";

function syncEvent(type: "switching" | "switched", clientId = "fusion"): string {
  return JSON.stringify({ version: 1, clientId, type, nonce: "event-1" });
}

describe("同源多标签会话切换通知", () => {
  beforeEach(() => {
    resetConfig();
    resetStore();
    localStorage.clear();
    configure({
      authUrl: "https://auth.example",
      clientId: "fusion",
      redirectUri: "https://fusion.example/auth/callback",
    });
  });

  afterEach(() => {
    resetConfig();
  });

  it("收到 switching storage 事件时立即进入同步屏障，但保留当前用户供宿主展示", () => {
    const oldUser = { id: "u-old" };
    setState({ user: oldUser, status: "authenticated" });

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: EVENT_KEY,
        newValue: syncEvent("switching"),
        storageArea: localStorage,
      }),
    );

    expect(getState()).toEqual({ user: oldUser, status: "synchronizing" });
  });

  it("收到 switched commit 事件后只从已完整提交的本地会话重建认证状态", () => {
    setState({ user: { id: "u-old" }, status: "synchronizing" });
    const newUser = { id: "u-new", email: "new@example.com" };
    tokenStore().setAuthenticatedSession(
      { accessToken: "AT-new", refreshToken: "RT-new", expiresIn: 900 },
      newUser,
    );

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: EVENT_KEY,
        newValue: syncEvent("switched"),
        storageArea: localStorage,
      }),
    );

    expect(getState()).toEqual({ user: newUser, status: "authenticated" });
  });

  it("缺少完整 token/user 提交时忽略 switched 事件并维持屏障", () => {
    setState({ user: { id: "u-old" }, status: "synchronizing" });
    tokenStore().setUser({ id: "u-new" });

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: EVENT_KEY,
        newValue: syncEvent("switched"),
        storageArea: localStorage,
      }),
    );

    expect(getState()).toEqual({ user: { id: "u-old" }, status: "synchronizing" });
  });

  it("忽略其他 client、其他 key 和畸形消息", () => {
    const current = { user: { id: "u-old" }, status: "authenticated" as const };
    setState(current);

    for (const [key, value] of [
      [EVENT_KEY, syncEvent("switching", "audio")],
      ["acw_session_sync:other", syncEvent("switching")],
      [EVENT_KEY, "not-json"],
    ]) {
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: value, storageArea: localStorage }),
      );
    }

    expect(getState()).toEqual(current);
  });
});
