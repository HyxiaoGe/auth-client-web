/**
 * Headless 授权事务存储。
 *
 * 与 pending.ts 的 legacy 跳转流程不同，一个页面可以同时存在多个 headless 授权事务。
 * 因此每个 PKCE verifier 都按各自的高熵 OAuth state 隔离并存入 sessionStorage，
 * 使其仅在当前标签页有效并随标签页关闭而消失。记录不包含登录标识或其他 PII。
 */

import { randomUrlSafe } from "./encoding.js";

const STORAGE_PREFIX = "acw_headless_authorization:";
const RECORD_VERSION = 1 as const;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export type PendingAuthorization = {
  version: typeof RECORD_VERSION;
  state: string;
  verifier: string;
  authUrl: string;
  clientId: string;
  redirectUri: string;
  redirectPath: string;
  expiresAt: number;
};

function storageKey(state: string): string {
  return `${STORAGE_PREFIX}${state}`;
}

function isPendingAuthorization(value: unknown, expectedState: string): value is PendingAuthorization {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<PendingAuthorization>;
  return (
    record.version === RECORD_VERSION &&
    record.state === expectedState &&
    typeof record.verifier === "string" &&
    record.verifier.length > 0 &&
    typeof record.authUrl === "string" &&
    record.authUrl.length > 0 &&
    typeof record.clientId === "string" &&
    record.clientId.length > 0 &&
    typeof record.redirectUri === "string" &&
    record.redirectUri.length > 0 &&
    typeof record.redirectPath === "string" &&
    typeof record.expiresAt === "number" &&
    Number.isFinite(record.expiresAt)
  );
}

export function createPendingAuthorization(input: {
  verifier: string;
  authUrl: string;
  clientId: string;
  redirectUri: string;
  redirectPath?: string;
  now?: number;
  ttlMs?: number;
}): PendingAuthorization {
  const state = randomUrlSafe(32);
  const record: PendingAuthorization = {
    version: RECORD_VERSION,
    state,
    verifier: input.verifier,
    authUrl: input.authUrl,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    redirectPath: input.redirectPath ?? "/",
    expiresAt: (input.now ?? Date.now()) + (input.ttlMs ?? DEFAULT_TTL_MS),
  };
  sessionStorage.setItem(storageKey(state), JSON.stringify(record));
  return record;
}

/** 读取但不消费；无效或过期数据只清理本次请求的 state。 */
export function peekPendingAuthorization(state: string, now: number = Date.now()): PendingAuthorization | null {
  const key = storageKey(state);
  const raw = sessionStorage.getItem(key);
  if (raw === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    sessionStorage.removeItem(key);
    return null;
  }

  if (!isPendingAuthorization(value, state) || value.expiresAt <= now) {
    sessionStorage.removeItem(key);
    return null;
  }
  return value;
}

/** 只消费指定事务，不触碰 legacy 或其他 headless 事务。 */
export function clearPendingAuthorization(state: string): void {
  sessionStorage.removeItem(storageKey(state));
}
