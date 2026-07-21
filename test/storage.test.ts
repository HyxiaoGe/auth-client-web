import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StorageKeys } from "../src/config.js";
import { createTokenStore } from "../src/storage.js";

const KEYS: StorageKeys = {
  accessToken: "a",
  refreshToken: "r",
  expiresAt: "e",
  user: "u",
};

describe("createTokenStore", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for everything when empty", () => {
    const store = createTokenStore(KEYS);
    expect(store.getAccessToken()).toBeNull();
    expect(store.getRefreshToken()).toBeNull();
    expect(store.getUser()).toBeNull();
    expect(store.isExpired()).toBe(true); // no token == expired
  });

  it("persists a session and reads it back", () => {
    const store = createTokenStore(KEYS, () => 1_000_000);
    store.setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 });
    expect(store.getAccessToken()).toBe("AT");
    expect(store.getRefreshToken()).toBe("RT");
    expect(localStorage.getItem("e")).toBe(String(1_000_000 + 3600 * 1000)); // absolute epoch-ms
  });

  it("treats the token as expired within the skew window before real expiry", () => {
    let now = 1_000_000;
    const store = createTokenStore(KEYS, () => now);
    store.setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 });
    expect(store.isExpired()).toBe(false);

    now = 1_000_000 + (3600 - 10) * 1000; // 10s before expiry, inside the 30s skew
    expect(store.isExpired(30_000)).toBe(true);

    now = 1_000_000 + (3600 - 40) * 1000; // 40s before expiry, outside skew
    expect(store.isExpired(30_000)).toBe(false);
  });

  it("round-trips the user object and tolerates malformed JSON", () => {
    const store = createTokenStore(KEYS);
    store.setUser({ id: "1", email: "a@b.c" });
    expect(store.getUser()).toEqual({ id: "1", email: "a@b.c" });

    localStorage.setItem("u", "{not json");
    expect(store.getUser()).toBeNull();
  });

  it("clear() wipes every key", () => {
    const store = createTokenStore(KEYS, () => 1_000_000);
    store.setSession({ accessToken: "AT", refreshToken: "RT", expiresIn: 3600 });
    store.setUser({ id: "1" });
    store.clear();
    expect(localStorage.getItem("a")).toBeNull();
    expect(localStorage.getItem("r")).toBeNull();
    expect(localStorage.getItem("e")).toBeNull();
    expect(localStorage.getItem("u")).toBeNull();
  });

  it("完整认证会话原子 record 写入失败时清空所有键", () => {
    const store = createTokenStore(KEYS, () => 1_000_000);
    store.setSession({ accessToken: "AT-old", refreshToken: "RT-old", expiresIn: 3600 });
    store.setUser({ id: "u-old" });
    const originalSetItem = Storage.prototype.setItem;
    let writes = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage) {
        writes += 1;
        if (writes === 1) throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      }
      originalSetItem.call(this, key, value);
    });

    expect(() =>
      store.setAuthenticatedSession(
        { accessToken: "AT-new", refreshToken: "RT-new", expiresIn: 900 },
        { id: "u-new" },
      ),
    ).toThrowError(expect.objectContaining({ name: "QuotaExceededError" }));

    expect(store.getAccessToken()).toBeNull();
    expect(store.getRefreshToken()).toBeNull();
    expect(store.getUser()).toBeNull();
    expect(localStorage.getItem("e")).toBeNull();
  });

  it("token 会话原子 record 写入失败时同样 fail closed，并保留原始错误", () => {
    const store = createTokenStore(KEYS, () => 1_000_000);
    store.setSession({ accessToken: "AT-old", refreshToken: "RT-old", expiresIn: 3600 });
    store.setUser({ id: "u-old" });
    const originalSetItem = Storage.prototype.setItem;
    let writes = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage) {
        writes += 1;
        if (writes === 1) throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      }
      originalSetItem.call(this, key, value);
    });

    expect(() =>
      store.setSession({ accessToken: "AT-new", refreshToken: "RT-new", expiresIn: 900 }),
    ).toThrowError(expect.objectContaining({ name: "QuotaExceededError" }));

    expect(store.getAccessToken()).toBeNull();
    expect(store.getRefreshToken()).toBeNull();
    expect(store.getUser()).toBeNull();
    expect(localStorage.getItem("e")).toBeNull();
  });

  it("兄弟标签在兼容镜像写入期间始终读取完整的新会话", () => {
    const store = createTokenStore(KEYS, () => 1_000_000);
    store.setAuthenticatedSession(
      { accessToken: "AT-old", refreshToken: "RT-old", expiresIn: 3600 },
      { id: "u-old" },
    );
    const observations: Array<[string | null, string | null, unknown]> = [];
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      originalSetItem.call(this, key, value);
      if (this === localStorage) {
        const sibling = createTokenStore(KEYS, () => 1_000_000);
        observations.push([
          sibling.getAccessToken(),
          sibling.getRefreshToken(),
          sibling.getUser(),
        ]);
      }
    });

    store.setAuthenticatedSession(
      { accessToken: "AT-new", refreshToken: "RT-new", expiresIn: 900 },
      { id: "u-new" },
    );

    expect(observations).not.toHaveLength(0);
    expect(observations.every(([access, refresh, user]) =>
      access === "AT-new" && refresh === "RT-new" && (user as { id: string }).id === "u-new"
    )).toBe(true);
  });

  it("权威 record 存在但损坏时不会回退到 legacy 镜像", () => {
    const store = createTokenStore(KEYS, () => 1_000_000);
    store.setAuthenticatedSession(
      { accessToken: "AT", refreshToken: "RT", expiresIn: 900 },
      { id: "u" },
    );
    localStorage.setItem("auth-client-web:session:v1:a", "{broken-json");

    expect(store.getSessionSnapshot()).toBeNull();
    expect(store.getAccessToken()).toBeNull();
    expect(store.getRefreshToken()).toBeNull();
    expect(store.getUser()).toBeNull();
  });
});
