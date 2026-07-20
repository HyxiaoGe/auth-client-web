import type { ResolvedConfig } from "./config.js";

/**
 * 所有会写 token/user 的认证事务共用同一把跨标签锁。
 * 这样旧会话清理、恢复、对账、回调和显式登出不会互相覆盖最后一次原子提交。
 */
export async function withSessionMutationLock<T>(
  config: ResolvedConfig,
  run: () => Promise<T>,
): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return run();

  let settled = false;
  let result: T | undefined;
  await locks.request(`auth-client-web:session-mutation:${config.clientId}`, async () => {
    result = await run();
    settled = true;
  });
  if (!settled) throw new Error("auth-client-web: session mutation lock completed without a result.");
  return result as T;
}
