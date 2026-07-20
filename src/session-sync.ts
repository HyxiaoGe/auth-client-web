/**
 * 同源多标签的会话切换通知。
 *
 * BroadcastChannel 用于即时通知，localStorage commit 记录用于不支持
 * BroadcastChannel 的浏览器。这里不传 token、授权码或用户资料；消息仅用于让
 * 兄弟标签页尽早建立请求屏障，并在完整会话提交后从各自的 token store 重读状态。
 */

import type { ResolvedConfig } from "./config.js";
import { beginAuthSessionTransition } from "./request-lifecycle.js";
import { createTokenStore } from "./storage.js";
import { setState, type AuthUser } from "./store.js";

const EVENT_VERSION = 1 as const;

type SessionSyncEvent = {
  version: typeof EVENT_VERSION;
  clientId: string;
  type: "switching" | "switched";
  nonce: string;
};

type ActiveSync = {
  config: ResolvedConfig;
  storageKey: string;
  channel: BroadcastChannel | null;
  onStorage: (event: StorageEvent) => void;
};

let active: ActiveSync | null = null;

function eventKey(clientId: string): string {
  return `acw_session_sync:${clientId}`;
}

function channelName(clientId: string): string {
  return `auth-client-web:session-sync:${clientId}`;
}

function parseEvent(value: unknown, clientId: string): SessionSyncEvent | null {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Partial<SessionSyncEvent>;
  if (
    record.version !== EVENT_VERSION ||
    record.clientId !== clientId ||
    (record.type !== "switching" && record.type !== "switched") ||
    typeof record.nonce !== "string" ||
    record.nonce.length === 0
  ) {
    return null;
  }
  return record as SessionSyncEvent;
}

function applyEvent(event: SessionSyncEvent, config: ResolvedConfig): void {
  if (event.type === "switching") {
    beginAuthSessionTransition();
    setState({ status: "synchronizing" });
    return;
  }

  // 即使浏览器漏掉了 switching 事件，switched 也必须先终止旧账号在途请求，
  // 再从原子会话记录采用新身份。
  beginAuthSessionTransition();
  const store = createTokenStore(config.storageKeys);
  const user = store.getUser<AuthUser>();
  if (store.getAccessToken() === null || user === null || typeof user.id !== "string" || user.id.length === 0) {
    return;
  }
  setState({ user, status: "authenticated" });
}

export function configureSessionSync(config: ResolvedConfig): void {
  disposeSessionSync();
  if (typeof window === "undefined") return;

  const storageKey = eventKey(config.clientId);
  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(channelName(config.clientId));
      channel.addEventListener("message", (message: MessageEvent<unknown>) => {
        const event = parseEvent(message.data, config.clientId);
        if (event !== null) applyEvent(event, config);
      });
    } catch {
      channel = null;
    }
  }

  const onStorage = (storageEvent: StorageEvent): void => {
    if (storageEvent.key !== storageKey || storageEvent.newValue === null) return;
    const event = parseEvent(storageEvent.newValue, config.clientId);
    if (event !== null) applyEvent(event, config);
  };
  window.addEventListener("storage", onStorage);
  active = { config, storageKey, channel, onStorage };
}

export function publishSessionSync(type: SessionSyncEvent["type"], config: ResolvedConfig): void {
  const event: SessionSyncEvent = {
    version: EVENT_VERSION,
    clientId: config.clientId,
    type,
    nonce: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
  };

  // 当前标签页不会收到自己的 storage 事件，因此调用方仍需自行更新 store。
  // 通知失败不影响服务端安全边界或当前标签页的会话原子提交。
  try {
    localStorage.setItem(eventKey(config.clientId), JSON.stringify(event));
  } catch {
    // best-effort coordination only
  }
  try {
    active?.channel?.postMessage(event);
  } catch {
    // best-effort coordination only
  }
}

export function disposeSessionSync(): void {
  if (active === null) return;
  if (typeof window !== "undefined") window.removeEventListener("storage", active.onStorage);
  try {
    active.channel?.close();
  } catch {
    // best-effort cleanup only
  }
  active = null;
}
