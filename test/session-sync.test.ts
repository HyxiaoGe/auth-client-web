import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configure, resetConfig } from "../src/config.js";
import { tokenStore } from "../src/session.js";
import { getState, resetStore, setState, subscribe } from "../src/store.js";

const EVENT_KEY = "acw_session_sync:fusion";

function syncEvent(
  type: "switching" | "switched",
  clientId = "fusion",
  nonce = "event-1",
): string {
  return JSON.stringify({ version: 1, clientId, type, nonce });
}

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];

  private listener: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    if (type === "message") this.listener = listener;
  }

  postMessage(): void {}

  close(): void {
    this.listener = null;
  }

  emit(data: unknown): void {
    this.listener?.(new MessageEvent("message", { data }));
  }
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
    FakeBroadcastChannel.instances = [];
    vi.unstubAllGlobals();
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
    const observedStatuses: string[] = [];
    const unsubscribe = subscribe((state) => observedStatuses.push(state.status));
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

    unsubscribe();
    expect(observedStatuses).toEqual(["synchronizing", "authenticated"]);
    expect(getState()).toEqual({ user: newUser, status: "authenticated" });
  });

  it("缺少完整 token/user 提交时 switched 事件 fail closed 并退出同步屏障", () => {
    setState({ user: { id: "u-old" }, status: "synchronizing" });
    tokenStore().setUser({ id: "u-new" });

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: EVENT_KEY,
        newValue: syncEvent("switched"),
        storageArea: localStorage,
      }),
    );

    expect(getState()).toEqual({ user: null, status: "unauthenticated" });
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(tokenStore().getUser()).toBeNull();
  });

  it("权威会话 record 损坏时不采用可能陈旧的 legacy 镜像", () => {
    setState({ user: { id: "u-old" }, status: "synchronizing" });
    tokenStore().setAuthenticatedSession(
      { accessToken: "AT-new", refreshToken: "RT-new", expiresIn: 900 },
      { id: "u-new" },
    );
    localStorage.setItem("auth-client-web:session:v1:acw_access_token", "{broken-json");

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: EVENT_KEY,
        newValue: syncEvent("switched", "fusion", "corrupt-record"),
        storageArea: localStorage,
      }),
    );

    expect(getState()).toEqual({ user: null, status: "unauthenticated" });
    expect(tokenStore().getAccessToken()).toBeNull();
    expect(localStorage.getItem("acw_access_token")).toBeNull();
  });

  it("同一 switched nonce 经 BroadcastChannel 与 storage 重复到达时只应用一次", () => {
    resetConfig();
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    configure({
      authUrl: "https://auth.example",
      clientId: "fusion",
      redirectUri: "https://fusion.example/auth/callback",
    });
    setState({ user: { id: "u-old" }, status: "synchronizing" });
    const newUser = { id: "u-new", email: "new@example.com" };
    tokenStore().setAuthenticatedSession(
      { accessToken: "AT-new", refreshToken: "RT-new", expiresIn: 900 },
      newUser,
    );
    const observedStatuses: string[] = [];
    const unsubscribe = subscribe((state) => observedStatuses.push(state.status));
    const rawEvent = syncEvent("switched", "fusion", "dual-channel-event");

    FakeBroadcastChannel.instances[0]?.emit(JSON.parse(rawEvent) as unknown);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: EVENT_KEY,
        newValue: rawEvent,
        storageArea: localStorage,
      }),
    );

    unsubscribe();
    expect(observedStatuses).toEqual(["synchronizing", "authenticated"]);
    expect(getState()).toEqual({ user: newUser, status: "authenticated" });
  });

  it("完整 switching 到 switched 序列经双通道重复投递时只推进一次会话状态", () => {
    resetConfig();
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    configure({
      authUrl: "https://auth.example",
      clientId: "fusion",
      redirectUri: "https://fusion.example/auth/callback",
    });
    setState({ user: { id: "u-old" }, status: "authenticated" });
    const observedStatuses: string[] = [];
    const unsubscribe = subscribe((state) => observedStatuses.push(state.status));
    const switching = syncEvent("switching", "fusion", "switching-dual-channel");

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: EVENT_KEY,
        newValue: switching,
        storageArea: localStorage,
      }),
    );
    FakeBroadcastChannel.instances[0]?.emit(JSON.parse(switching) as unknown);

    const newUser = { id: "u-new", email: "new@example.com" };
    tokenStore().setAuthenticatedSession(
      { accessToken: "AT-new", refreshToken: "RT-new", expiresIn: 900 },
      newUser,
    );
    const switched = syncEvent("switched", "fusion", "switched-dual-channel");
    FakeBroadcastChannel.instances[0]?.emit(JSON.parse(switched) as unknown);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: EVENT_KEY,
        newValue: switched,
        storageArea: localStorage,
      }),
    );

    unsubscribe();
    expect(observedStatuses).toEqual(["synchronizing", "synchronizing", "authenticated"]);
    expect(getState()).toEqual({ user: newUser, status: "authenticated" });
  });

  it("去重缓存有界，且重新 configure 后允许应用旧 nonce", () => {
    setState({ user: { id: "u-old" }, status: "authenticated" });
    const observedStatuses: string[] = [];
    const unsubscribe = subscribe((state) => observedStatuses.push(state.status));

    for (let index = 0; index < 129; index += 1) {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: EVENT_KEY,
          newValue: syncEvent("switching", "fusion", `event-${index}`),
          storageArea: localStorage,
        }),
      );
    }
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: EVENT_KEY,
        newValue: syncEvent("switching", "fusion", "event-0"),
        storageArea: localStorage,
      }),
    );
    expect(observedStatuses).toHaveLength(130);

    resetConfig();
    configure({
      authUrl: "https://auth.example",
      clientId: "fusion",
      redirectUri: "https://fusion.example/auth/callback",
    });
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: EVENT_KEY,
        newValue: syncEvent("switching", "fusion", "event-128"),
        storageArea: localStorage,
      }),
    );

    unsubscribe();
    expect(observedStatuses).toHaveLength(131);
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
