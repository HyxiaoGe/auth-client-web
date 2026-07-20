/**
 * Token store over localStorage, parameterized by key names (so apps keep their existing
 * keys on migration) and with an injectable clock (so expiry is deterministic in tests).
 *
 * Expiry is stored as an absolute epoch-ms deadline; `isExpired` treats the token as
 * expired a `skewMs` window early so a refresh fires before the resource server would
 * reject it.
 */

import type { StorageKeys } from "./config.js";

export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds, as returned by /auth/oauth/token
};

export type TokenStore = {
  setSession(tokens: SessionTokens): void;
  setAuthenticatedSession(tokens: SessionTokens, user: unknown): void;
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  isExpired(skewMs?: number): boolean;
  setUser(user: unknown): void;
  getUser<T = unknown>(): T | null;
  clear(): void;
};

export function createTokenStore(keys: StorageKeys, now: () => number = () => Date.now()): TokenStore {
  const clearStoredSession = (): void => {
    localStorage.removeItem(keys.accessToken);
    localStorage.removeItem(keys.refreshToken);
    localStorage.removeItem(keys.expiresAt);
    localStorage.removeItem(keys.user);
  };

  return {
    setSession(tokens) {
      try {
        localStorage.setItem(keys.accessToken, tokens.accessToken);
        localStorage.setItem(keys.refreshToken, tokens.refreshToken);
        localStorage.setItem(keys.expiresAt, String(now() + tokens.expiresIn * 1000));
      } catch (error) {
        clearStoredSession();
        throw error;
      }
    },
    setAuthenticatedSession(tokens, user) {
      try {
        localStorage.setItem(keys.accessToken, tokens.accessToken);
        localStorage.setItem(keys.refreshToken, tokens.refreshToken);
        localStorage.setItem(keys.expiresAt, String(now() + tokens.expiresIn * 1000));
        localStorage.setItem(keys.user, JSON.stringify(user));
      } catch (error) {
        // localStorage 没有跨 key 事务；配额耗尽后 setItem 回滚也可能继续失败。
        // removeItem 不受配额限制，因此提交失败时 fail closed，避免新 token 与旧用户混存。
        clearStoredSession();
        throw error;
      }
    },
    getAccessToken() {
      return localStorage.getItem(keys.accessToken);
    },
    getRefreshToken() {
      return localStorage.getItem(keys.refreshToken);
    },
    isExpired(skewMs = 30_000) {
      const raw = localStorage.getItem(keys.expiresAt);
      if (raw === null || localStorage.getItem(keys.accessToken) === null) return true;
      const expiresAt = Number(raw);
      if (!Number.isFinite(expiresAt)) return true;
      return now() + skewMs >= expiresAt;
    },
    setUser(user) {
      localStorage.setItem(keys.user, JSON.stringify(user));
    },
    getUser<T = unknown>(): T | null {
      const raw = localStorage.getItem(keys.user);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    clear() {
      clearStoredSession();
    },
  };
}
