import { getConfigSnapshot } from "./config.js";
import { withSessionMutationLock } from "./session-mutation.js";
import { beginAuthSessionTransition } from "./request-lifecycle.js";
import { createTokenStore } from "./storage.js";
import { setState, type AuthUser } from "./store.js";

export type ClearLocalSessionResult =
  | { status: "cleared" }
  | { status: "changed"; user: AuthUser | null };

/**
 * 仅当共享存储仍是调用方实际收到 401 的那张 access token 时才清除本地会话。
 * 若兄弟标签已提交新账号，保留胜出的新会话并把它发布给当前标签，绝不让迟到清理覆盖新身份。
 */
export function clearLocalSessionIfCurrent(
  expectedAccessToken: string | null,
): Promise<ClearLocalSessionResult> {
  const config = getConfigSnapshot();
  return withSessionMutationLock(config, async () => {
    const store = createTokenStore(config.storageKeys);
    const currentAccessToken = store.getAccessToken();
    // 调用前的 SDK refresh 可能已经用同一“定论失败”清掉 A；此时本地已达到目标，
    // 不能把“空会话”误判成兄弟标签的新提交。
    if (currentAccessToken === null) {
      store.clear();
      setState({ user: null, status: "unauthenticated" });
      return { status: "cleared" };
    }
    if (currentAccessToken !== expectedAccessToken) {
      const user = normalizeUser(store.getUser());
      if (currentAccessToken !== null && user !== null) {
        // 条件清理调用方可能尚未收到兄弟标签的 switched 通知；先同步发布屏障，
        // 让宿主清完 A 的运行态后再采用 B，不能直接开放新身份请求。
        beginAuthSessionTransition();
        setState({ status: "synchronizing" });
        setState({ user, status: "authenticated" });
      }
      return { status: "changed", user };
    }

    store.clear();
    setState({ user: null, status: "unauthenticated" });
    return { status: "cleared" };
  });
}

function normalizeUser(value: unknown): AuthUser | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  return record as AuthUser;
}
