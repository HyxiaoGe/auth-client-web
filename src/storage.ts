/**
 * 版本化、单记录的浏览器会话存储。
 *
 * 四个历史 key 仍作为滚动升级镜像保留，但 SDK 的所有读写只以一个 JSON record
 * 为权威来源。localStorage 的单次 setItem 是原子的，因此兄弟标签不会再读到
 * ``B access + A refresh/user`` 这类跨身份混合状态。
 */

import type { StorageKeys } from "./config.js";

export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

type StoredSession = {
  version: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: unknown | null;
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

function recordKey(keys: StorageKeys): string {
  return `auth-client-web:session:v1:${keys.accessToken}`;
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Partial<StoredSession>;
  return (
    record.version === 1 &&
    typeof record.accessToken === "string" &&
    record.accessToken.length > 0 &&
    typeof record.refreshToken === "string" &&
    record.refreshToken.length > 0 &&
    typeof record.expiresAt === "number" &&
    Number.isFinite(record.expiresAt)
  );
}

export function createTokenStore(keys: StorageKeys, now: () => number = () => Date.now()): TokenStore {
  const sessionKey = recordKey(keys);

  const readCanonical = (): StoredSession | null => {
    const raw = localStorage.getItem(sessionKey);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isStoredSession(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const readLegacy = (): StoredSession | null => {
    const accessToken = localStorage.getItem(keys.accessToken);
    const refreshToken = localStorage.getItem(keys.refreshToken);
    const rawExpiry = localStorage.getItem(keys.expiresAt);
    if (accessToken === null || refreshToken === null || rawExpiry === null) return null;
    const expiresAt = Number(rawExpiry);
    if (!Number.isFinite(expiresAt)) return null;
    let user: unknown | null = null;
    const rawUser = localStorage.getItem(keys.user);
    if (rawUser !== null) {
      try {
        user = JSON.parse(rawUser) as unknown;
      } catch {
        user = null;
      }
    }
    return { version: 1, accessToken, refreshToken, expiresAt, user };
  };

  const read = (): StoredSession | null => readCanonical() ?? readLegacy();

  const mirrorLegacy = (session: StoredSession): void => {
    // 同步镜像只服务仍直接读取旧 key 的 0.2.x 宿主；新 SDK 永不把它们当权威。
    // record 已先原子提交，即使镜像因配额失败也不能回滚为旧身份。
    try {
      localStorage.setItem(keys.accessToken, session.accessToken);
      localStorage.setItem(keys.refreshToken, session.refreshToken);
      localStorage.setItem(keys.expiresAt, String(session.expiresAt));
      if (session.user === null) localStorage.removeItem(keys.user);
      else localStorage.setItem(keys.user, JSON.stringify(session.user));
    } catch {
      // best-effort rolling compatibility mirror
    }
  };

  const commit = (session: StoredSession): void => {
    try {
      localStorage.setItem(sessionKey, JSON.stringify(session));
    } catch (error) {
      clearStoredSession();
      throw error;
    }
    mirrorLegacy(session);
  };

  const clearStoredSession = (): void => {
    localStorage.removeItem(sessionKey);
    localStorage.removeItem(keys.accessToken);
    localStorage.removeItem(keys.refreshToken);
    localStorage.removeItem(keys.expiresAt);
    localStorage.removeItem(keys.user);
  };

  return {
    setSession(tokens) {
      const previous = read();
      commit({
        version: 1,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: now() + tokens.expiresIn * 1000,
        user: previous?.user ?? null,
      });
    },
    setAuthenticatedSession(tokens, user) {
      commit({
        version: 1,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: now() + tokens.expiresIn * 1000,
        user,
      });
    },
    getAccessToken() {
      return read()?.accessToken ?? null;
    },
    getRefreshToken() {
      return read()?.refreshToken ?? null;
    },
    isExpired(skewMs = 30_000) {
      const session = read();
      return session === null || now() + skewMs >= session.expiresAt;
    },
    setUser(user) {
      const session = read();
      if (session === null) {
        // 兼容认证回调尚未写 token 的历史调用顺序；不会形成可用混合会话。
        localStorage.setItem(keys.user, JSON.stringify(user));
        return;
      }
      commit({ ...session, user });
    },
    getUser<T = unknown>(): T | null {
      const session = read();
      if (session !== null) return (session.user as T | null | undefined) ?? null;
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
