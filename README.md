# auth-client-web

Framework-neutral browser SDK for **auth-service**。提供 PKCE 跳转登录、无跳转中央会话恢复、已登录账户对账、token 刷新、认证请求和安全退出，同时提供与邮箱、短信或具体 UI 无关的 headless OAuth authorization transaction。

> 配套后端共享库见 `auth-service/auth-client`（Python，JWKS 验签）。本包是其前端对应物。

## 安装

npm registry 正式包是自用项目和第三方项目的默认安装方式。`0.x` 阶段次版本仍可能调整公共 API，因此建议锁定当前兼容范围并提交 lockfile：

```bash
npm install auth-client-web@^0.4.0
```

包只提供 ESM，不提供 CommonJS 构建。ESM 项目可以直接静态导入；CommonJS 工具链需要使用动态 `import("auth-client-web")`，或由应用构建工具完成 ESM 转换。

只有无法访问 npm registry 时才使用 Git tag 备用安装；不要依赖会移动的默认分支：

```bash
npm install github:HyxiaoGe/auth-client-web#v0.4.0
```

Git 安装会通过 `prepare` 自动构建 `dist/`，安装时间和工具链要求都高于正式包，不应作为正常接入方式。

## 状态

`0.4.0` 已发布到 npm。它新增无页面跳转的中央会话恢复、同源多标签会话采用，以及统一的跨标签会话写锁；继续兼容 `login()`、`silentLogin()`、`handleCallback()`、headless authorization transaction 和既有存储键。

## 接入前准备

在写前端代码前，先让 auth-service 管理员为新应用提供以下配置：

- 独立 `client_id`；不要与 Fusion、Audio 或其他应用共用 client；
- 精确注册的 `redirect_uri`，包括 scheme、host、port 和 path；
- 前端 Origin 已加入 auth-service 的 CORS allowlist；
- 资源服务使用该应用自己的 JWT audience 验签，不能只校验签名；
- 需要邮箱验证码时，确认 `GET /auth/capabilities?client_id=...&redirect_uri=...` 返回 `email_headless_login: true`；
- 使用 JSON `resumeSession()` / `reconcileSession()`、邮箱 headless 或可靠全局退出时，应用
  Origin 与 auth-service 必须满足 auth-service 的 schemeful same-site 策略；不同 registrable
  domain 只能回退到顶层 `/authorize` 跳转流程。

推荐给每个环境分配不同 client，例如 `example-web-dev` 和 `example-web-prod`。`authUrl`、`clientId`、`redirectUri` 可以来自公开的构建配置，但数据库、OAuth secret、邮件凭据和 JWT 私钥只能配置在服务端。

## 能力概览

| 模块 | 作用 |
|---|---|
| `pkce` / `encoding` | PKCE S256 生成；challenge 与后端 `verify_pkce` 用同一 RFC 7636 向量交叉验证、逐字一致 |
| `pending` | 顶层跳转前持久化 `state`(CSRF) + `code_verifier`，回调页取回（sessionStorage，单次）；peek/clear 分离，便于「先校验后消费」 |
| `config` | `configure()`：authUrl / clientId / redirectUri + 可覆盖存储键（迁移时保留各 app 既有键） |
| `storage` | token 存储（localStorage，键可配，时钟可注入，绝对过期 + skew 提前刷新） |
| `store` | 框架无关可观察 `{user, status}`，`subscribe()` 供各框架适配镜像 |
| `authorize` | `buildAuthorizeUrl` / `login` / `silentLogin`（顶层跳 `/auth/authorize`，登录后落地路径记忆） |
| `callback` | `handleCallback`——安全核心：先校验 state 再消费一次性材料 → `code_verifier` 换码 → 拉 userinfo → 翻转 store |
| `authorization` | `prepareAuthorization` / `completeAuthorization` / `cancelAuthorization`（应用内 headless OAuth，按高熵 state 隔离事务） |
| `authorization-code` | 顶层回调和 headless 流程共享的 authorization code → token → userinfo → store 完成内核 |
| `reconcile` / `session-sync` | `POST /auth/session/reconcile` + credentialed PKCE 换票；Web Lock、BroadcastChannel 与 storage commit 协调同源多标签 |
| `resume` | 本地无 token 时通过 `POST /auth/session/resume` + PKCE 无跳转恢复中央 Cookie 会话；支持提交前业务清理 |
| `session-mutation` / `session-clear` | 统一串行恢复、对账、回调、headless 换码和登出；按实际被拒 access token 条件清理，避免迟到清理覆盖兄弟标签的新账号 |
| `session` / `userinfo` | 配置绑定的 tokenStore 访问器；`/auth/userinfo` 拉取并把 `avatar_url` 归一化为 `avatarUrl`（缺 `id` 即抛错） |
| `tokens` | `getAccessToken` + 单 in-flight 刷新合流；401 跨标签轮转守卫 |
| `http` | `fetchWithAuth`——注入 Bearer，401 有界重试，并以 epoch + AbortController 阻断账户切换前的迟到请求 |
| `logout` | 尽力撤销 refresh token，本地必清；全局退出把本地 access token 的 sid 作为目标交给服务端复验 |

## 最小接入

### 1. 配置与登录回调

```ts
import {
  configure,
  handleCallback,
  login,
  subscribe,
  type AuthState,
} from "auth-client-web";

const authUrl = "https://auth.example.com";
const clientId = "example-web";
const redirectUri = "https://app.example.com/auth/callback";

// 只在浏览器启动阶段调用一次。SSR 模块加载阶段不要调用。
configure({ authUrl, clientId, redirectUri });

// SDK 不绑定 React/Vue/Zustand/Redux；把后续变更镜像进宿主自己的状态层。
const unsubscribe = subscribe((state: AuthState) => updateAppAuthState(state));

// Google / GitHub 顶层跳转登录。provider 必须是 auth-service 已启用的 provider。
export function signInWithGoogle(): Promise<void> {
  return login("google", { redirectPath: "/tasks" });
}

// 在精确注册的 redirect_uri 页面调用。它会校验 state、用 PKCE 换票并拉取 userinfo。
export async function finishAuthCallback(): Promise<void> {
  const callback = await handleCallback();
  if (callback.status === "authenticated") {
    updateAppAuthState({ user: callback.user, status: "authenticated" });
    history.replaceState(null, "", callback.redirectPath);
  }
  // unauthenticated 是 prompt=none 等已验证回调的结果；no_callback 表示当前 URL 不是认证回调。
}

// 框架卸载时调用 unsubscribe()。
```

`subscribe()` 不会在订阅时立即回放当前快照。应用首次启动时可以用 `tokenStore().getUser<AuthUser>()` 读取 SDK 持久化的缓存用户来初始化自己的状态层，再按下文先做会话对账；不要在对账前调用 `getAccessToken()` 刷新旧账户，也不要直接读取 SDK 的 localStorage 键。

### 2. 无跳转恢复、已登录账户对账与静默 SSO

`0.4.0` 推荐优先使用 JSON 会话能力：本地无 access token 时调用 `resumeSession()`，本地已有 access token 时调用 `reconcileSession()`。前者从中央 IdP Cookie 无跳转恢复当前应用，后者检测中央账户是否已经切换。

```ts
import {
  AuthClientError,
  reconcileSession,
  refresh,
  resumeSession,
  tokenStore,
  type AuthUser,
} from "auth-client-web";

async function synchronizeBrowserSession(): Promise<void> {
  const resume = async (): Promise<void> => {
    const result = await resumeSession({
      beforeCommit: async ({ user }) => {
        await clearUserScopedState(null, user);
      },
    });
    if (result.status === "resumed") await reloadUserData(result.user);
    if (result.status === "local_session") {
      const user = tokenStore().getUser<AuthUser>();
      if (user !== null) updateAppAuthState({ user, status: "authenticated" });
    }
    if (result.status === "no_session") {
      updateAppAuthState({ user: null, status: "unauthenticated" });
    }
  };

  const store = tokenStore();
  const accessToken = store.getAccessToken();
  if (accessToken === null) {
    await resume();
    return;
  }

  const cachedUser = store.getUser<AuthUser>();
  if (cachedUser !== null) {
    updateAppAuthState({ user: cachedUser, status: "authenticated" });
  }
  const reconcile = () => reconcileSession({
    beforeCommit: async ({ previousUser, user }) => {
      await clearUserScopedState(previousUser, user);
    },
  });
  let result;
  try {
    result = await reconcile();
  } catch (error) {
    if (!(error instanceof AuthClientError) || error.status !== 401) throw error;
    const refreshed = await refresh();
    if (refreshed === null) {
      await resume();
      return;
    }
    result = await reconcile();
  }
  if (result.status === "switched") await reloadUserData(result.user);
}

// “自动恢复”由宿主决定触发时机；SDK 本身不会注册监听器或定时器。
function scheduleSessionSync(): void {
  void synchronizeBrowserSession().catch(reportAuthSyncError);
}

scheduleSessionSync();
window.addEventListener("focus", scheduleSessionSync);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleSessionSync();
});
```

`resumeSession()` 与 `reconcileSession()` 会分别合流同标签并发调用；宿主仍应避免同时注册多个高频定时器。`beforeCommit` 必须停止 SSE/WebSocket 和旧用户请求、清理用户绑定缓存，再允许新账户数据进入页面。

`reconcileSession()` 故意不在内部 refresh：账户切换后旧 sid 可能已经撤销，但对账仍需要原始票据中的绑定。raw access token 返回 401 时，宿主可以像上例一样只 refresh 一次并重试一次；refresh 被 401/403 明确拒绝后再走 `resumeSession()`。网络错误、429 或 5xx 是可重试故障，必须保留旧会话，不能当作退出。`no_session` 默认不会删除本地 token；要求“中央退出后聚焦即退出”的产品可以在收到该状态后清理用户数据并调用本地 `logout()`。

`silentLogin()` 仍保留兼容：它会顶层跳转到 `/auth/authorize?prompt=none`，无中央会话时再带 `error=login_required` 返回回调页。仅在 auth-service 尚未提供 `/auth/session/resume`，或产品明确接受一次顶层往返时使用：

```ts
import { silentLogin } from "auth-client-web";

await silentLogin();
```

### 3. Token 刷新与认证请求

```ts
import { fetchWithAuth, getAccessToken, refresh } from "auth-client-web";

const token = await getAccessToken();        // 有效 token 直接返回；临近过期时自动 refresh
const forced = await refresh();              // 仅在确实需要主动轮换时使用
const response = await fetchWithAuth("/api/tasks");
```

`fetchWithAuth()` 自动注入 Bearer；资源服务返回 401 时最多 refresh 并重试一次，不会无限循环。并发刷新在同标签合流，支持 Web Locks 时也会跨同源标签串行，适配 auth-service 的 refresh token rotation。业务请求应优先使用它；SSE/WebSocket 或其他未经过它的请求必须由宿主在账户切换时主动中止。

### 4. 退出

```ts
import { logout } from "auth-client-web";

await logout({ redirectTo: "/" });
await logout({
  global: true,
  postLogoutRedirectUri: "https://app.example.com/auth/callback",
});
```

默认退出会尽力撤销当前 refresh token，并始终清理本地会话；`global: true` 还会通过顶层 POST 结束匹配的中央 IdP session。`postLogoutRedirectUri` 必须已经为当前 client 注册。全局退出会发生页面导航，上述两个调用是互斥示例，不应连续执行。

## 已登录账户对账

`reconcileSession()` 供宿主在页面刷新、重新聚焦、从后台恢复或低频定时探测时调用。它不会自行启动定时器。中央会话仍是同一账户时返回 `match`；浏览器没有中央会话时返回 `no_session`，两者都不会改动本地 token。中央账户已经切换时，SDK 会在内存中完成一笔新的 PKCE 授权，并且只在 token 与 userinfo 都成功后一次性提交新会话。

```ts
import {
  AuthClientError,
  reconcileSession,
  subscribe,
} from "auth-client-web";

subscribe((state) => {
  if (state.status === "synchronizing") {
    // 已确认中央账户变化：暂停新请求、终止旧账户的流，并隐藏旧数据。
    enterAccountSwitchBarrier();
  }
});

try {
  const result = await reconcileSession({
    beforeCommit: async ({ previousUser, user }) => {
      // 新票据尚未写入：在原子提交前终止旧请求、清旧缓存并切到安全路由。
      await resetApplicationForUser(previousUser, user);
    },
  });
  if (result.status === "switched") {
    // 新会话已提交；现在可以为 result.user 重拉数据并提示账户已切换。
    await loadApplicationForUser(result.user);
  }
} catch (error) {
  if (error instanceof AuthClientError && error.blocking) {
    // mismatch 已确认但换票未完成：保持屏障，稍后重新发起整笔 reconcile。
  }
}
```

返回类型为：

```ts
type ReconcileSessionResult =
  | { status: "match" }
  | { status: "no_session" }
  | { status: "switched"; previousUser: AuthUser | null; user: AuthUser };
```

对账预检发生网络或可重试 HTTP 错误时，SDK 保留当前会话并抛出 `session_reconcile_failed`（`blocking=false`）。服务端已经确认 `switch_required` 后，SDK 立即把可观察状态切到 `synchronizing`；此时 `getAccessToken()`、`refresh()` 和 `fetchWithAuth()` 都会以 blocking 错误拒绝继续交出或发送旧票据。`beforeCommit` 在新 token/user 已验证但尚未持久化时执行，供宿主完成业务隔离。此后的 state 校验、换票、userinfo、`beforeCommit` 或持久化失败统一抛出 `session_reconcile_blocked`（`blocking=true`），宿主不能静默恢复旧身份写入。

SDK 会在支持时用按 client 命名的 Web Lock 合流同源多标签操作，并用 BroadcastChannel + 不含敏感信息的 localStorage commit 消息同步 `synchronizing` / `authenticated` 状态。不支持 Web Lock 时仍可工作；服务端的一次性 code、PKCE、Origin/client/redirect/sid 绑定才是安全边界，前端锁不是授权边界。authorization code、PKCE verifier 和 state 仅存在于调用栈内存，不写入 localStorage、sessionStorage、URL 或日志。

## 无跳转恢复中央会话

宿主已处于未登录态、且本地没有 access token 时，可以在标签页重新聚焦或低频定时探测中调用 `resumeSession()`。中央 Cookie 不存在时返回 `no_session`；同源兄弟标签已经完成恢复时返回 `local_session`；需要为当前应用补票时，SDK 完成 PKCE 换票和 userinfo 校验后返回 `resumed`。

```ts
import { resumeSession } from "auth-client-web";

const result = await resumeSession({
  beforeCommit: async ({ user }) => {
    // 新 token 尚未写入：先中止旧身份请求、清理用户绑定缓存。
    await resetApplicationForUser(user);
  },
});

if (result.status === "resumed") {
  await loadApplicationForUser(result.user);
}
```

`resumeSession()` 只适用于本地无票据场景。已登录应用与中央账户不一致时仍使用 `reconcileSession()`。资源服务明确以 401/403 拒绝某张旧 access token 后，宿主可调用 `clearLocalSessionIfCurrent(rejectedToken)`：只有共享存储仍是该旧票据时才清理；若兄弟标签已原子提交新会话，则返回 `changed` 并保留新用户。

配套 auth-service 协议：

1. credentialed `POST /auth/session/reconcile`，Bearer 为本地 access token，请求体包含 `client_id`、`redirect_uri`、`state`、`code_challenge`、`code_challenge_method=S256`；
2. 返回 `match`、`no_session`，或 `{status:"switch_required", code, state}`，不得暴露中央 `user_id`；
3. `switch_required` 后 credentialed `POST /auth/oauth/token`，额外携带原始 `state`、`redirect_uri` 与 `code_verifier`，服务端必须再次校验当前 Cookie sid/version 后才能消费 code。

SDK 自带的 `fetchWithAuth()` 会在切换确认时中止在途请求，并在取 token、首请求、refresh 与重试后的每个异步边界复验初始 epoch，避免把 A 的请求改用 B token 重放。宿主仍需负责业务层隔离：一旦进入 `synchronizing`，停止未走 SDK 的请求并终止 SSE/WebSocket；切换成功后清理旧用户命名空间的缓存、草稿和敏感路由，再为新用户重拉数据。SDK 无法替宿主推断这些业务资源。

## 全局退出的 session 目标绑定

`logout({ global: true })` 会在清理本地存储前读取当前 access token 的 JWT payload。若其中包含形状合法的 `sid`（16–128 位 URL-safe 字符），SDK 会在顶层 POST form 中附加 `session_sid`：

```text
POST /auth/logout/session
client_id=...
post_logout_redirect_uri=...
session_sid=<本地 access token 的 sid>
```

这一步解析不验签，也不参与浏览器端授权判断；`session_sid` 只是客户端声明的退出目标。auth-service 必须把它与 HttpOnly IdP Cookie 指向的真实 sid 精确比较，只有一致时才允许撤销 sid、删除 session 和清 Cookie。不一致必须返回 `409 session_mismatch`，并且不能产生撤销、删除、清 Cookie 或跳转等副作用。

存量 access token 或畸形 token 没有可用 sid 时，SDK 回退到旧 `/auth/logout`。配套服务端的兼容端点只执行注册回跳，不猜测、更不撤销“当前 Cookie sid”：Cookie 可能已经从本地账户 A 切到 B，猜测会错误登出 B。旧客户端和 sidless 存量会话仍会完成本地清理，但需要获得带 sid 的新票据后才能安全执行跨应用全局退出。

公共网络、协议和授权事务错误会抛出 `AuthClientError`。调用方应判断稳定的 `code`、`status` 和 `retryable`，不要解析 `message`；兼容消息只为旧应用迁移保留。

```ts
import { AuthClientError, getAccessToken } from "auth-client-web";

try {
  await getAccessToken();
} catch (error) {
  if (error instanceof AuthClientError && error.retryable) {
    // 网络、限流或 refresh 响应丢失：保留现有会话，稍后重试。
  }
}
```

## Headless authorization

SDK 只准备和完成 OAuth authorization transaction，**不发送邮箱验证码、不提供登录弹窗，也不接触邮箱或手机号**。登录表单、倒计时、错误提示和验证码投递由宿主 UI 调用 auth-service 交互接口完成；验证成功后，auth-service 只返回短期、单次的 authorization code 和原始 state，SDK 再使用当前标签页保存的 transaction-specific PKCE verifier 完成登录。

邮箱验证码使用 auth-service 的三个真实接口：

1. `POST /auth/email/headless/start` 创建绑定浏览器、Origin、client、redirect URI、state 和 PKCE 的 flow；
2. `POST /auth/email/headless/send` 发送验证码；
3. `POST /auth/email/headless/verify` 验证验证码并返回一次性 `code + state`。

三个请求都必须使用 `credentials: "include"`。`send` 和 `verify` 还必须携带 `start` 返回的 `X-CSRF-Token`。下面的 `postAuth()` 是宿主示例辅助函数，不是 SDK 导出：

```ts
import {
  prepareAuthorization,
  completeAuthorization,
  cancelAuthorization,
} from "auth-client-web";

type EmailStartResponse = {
  flow_id: string;
  csrf_token: string;
  expires_in: number;
  code_length: number;
};

type EmailSendResponse = {
  accepted: true;
  next: "verify";
  expires_in: number;
  resend_after: number;
  masked_destination: string;
};

type EmailVerifyResponse = {
  code: string;
  state: string;
  expires_in: number;
};

async function postAuth<T>(
  path: string,
  body: unknown,
  csrfToken?: string,
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrfToken !== undefined) headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(`${authUrl}${path}`, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `auth-service ${response.status}`);
  return payload;
}

// 打开邮箱登录弹窗时创建一笔 SDK authorization transaction。
const authorization = await prepareAuthorization({ redirectPath: "/chat/new" });
const flow = await postAuth<EmailStartResponse>("/auth/email/headless/start", {
  response_type: authorization.responseType,
  client_id: authorization.clientId,
  redirect_uri: authorization.redirectUri,
  state: authorization.state,
  code_challenge: authorization.codeChallenge,
  code_challenge_method: authorization.codeChallengeMethod,
});

// 用户提交邮箱。202 只代表请求被接受，不泄露账户是否存在，也不保证邮件最终送达。
const sent = await postAuth<EmailSendResponse>(
  "/auth/email/headless/send",
  { flow_id: flow.flow_id, email },
  flow.csrf_token,
);
showVerificationStep(sent.masked_destination, sent.resend_after);

// 用户提交 6 位验证码；completeAuthorization 会验证原始 state 并完成 PKCE 换票。
const verified = await postAuth<EmailVerifyResponse>(
  "/auth/email/headless/verify",
  { flow_id: flow.flow_id, code: verificationCode },
  flow.csrf_token,
);
const result = await completeAuthorization({
  authorizationCode: verified.code,
  state: verified.state,
});
// result: { status: "authenticated", user, redirectPath: "/chat/new" }

// 用户在 verify 前关闭弹窗时调用；不要把 state 当作验证码 flow_id。
function closeEmailLoginDialog(): void {
  cancelAuthorization(authorization.state);
}
```

实际 UI 应在开始 flow 前调用 capabilities，并在 `email_headless_login !== true` 时隐藏邮箱入口：

```ts
const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri });
const response = await fetch(`${authUrl}/auth/capabilities?${query}`, {
  credentials: "include",
});
const capabilities = await response.json() as { email_headless_login?: boolean };
const emailLoginAvailable = response.ok && capabilities.email_headless_login === true;
```

Headless email 只支持符合 auth-service Origin 策略的 HTTPS Web Origin 或 loopback HTTP 开发 Origin；`Origin: null`、自定义 scheme 和 packaged Electron Origin 不可用。对 `429` 应读取 `Retry-After` / `retry_after` 后倒计时，不得自动重试刷邮件；`400 invalid_code`、`403 invalid_interaction`、`410 interaction_expired` 和 `503 delivery_unavailable` 应分别提示重输、重开 flow 或暂时禁用入口。

每笔 headless transaction 都以高熵 state 为键保存在 `sessionStorage`，记录带版本和过期时间，不保存 PII。未知、过期或不匹配的 state 不会触发 token exchange；同一 state 的并发完成调用会合流。state 验证成功后，pending verifier 会在换 token 前一次性消费。

`completeAuthorization` 可选接收 `signal: AbortSignal`，并将取消贯穿 token exchange 与 userinfo。取消或 userinfo 失败时不会把新 token 与旧用户混合提交，但授权事务仍按一次性语义消费，需要重新 `prepareAuthorization()`。

各框架的薄适配在各自应用侧基于 `subscribe()` 构建，不进本包；新项目不需要参考 Fusion 或 Audio 源码才能使用上述公共 API。

## 运行环境

本包面向现代浏览器，编译目标为 ES2022。执行认证流程的页面需要：

- 支持 ESM、`fetch`、Web Crypto、`TextEncoder`、`AbortSignal`、`localStorage` 和 `sessionStorage`；
- 在 HTTPS 或 `localhost` 等安全上下文中运行，以便使用 `crypto.subtle` 完成 PKCE；
- 允许当前站点使用 Web Storage；隐私模式或禁用存储时，调用方需要处理浏览器抛出的错误；
- 把认证调用放在客户端执行。包可以被 ESM 工具链解析，但依赖 `window`、`document` 或 Web Storage 的流程不能在 Node.js/SSR 阶段运行。

`navigator.locks` 和 `BroadcastChannel` 是可选增强：支持时用于跨标签页串行 refresh 与所有会话写事务，并即时通知兄弟标签；不支持时 SDK 会分别回退到直接请求与 storage 事件协调。

package metadata 为使用 Node.js ESM 工具链的消费者声明 Node.js 18 或更高版本；浏览器才是 SDK 的实际运行环境。仓库的构建、测试和发布工具链因为 Vite 8 需要 Node.js 20.19.0 或更高版本，这个开发要求不会给浏览器增加 Node.js 运行时依赖。

### 兼容矩阵

| 环境 | 支持情况 | 接入要求 |
|---|---|---|
| React / Next.js / Vue / Vite 等现代 ESM Web 应用 | 支持 | 认证初始化只能在客户端执行；Next.js 组件需要 client boundary |
| SSR / Node.js 服务端执行 | 不支持认证流程 | 可以解析包，但不能在服务端调用依赖 `window`、Web Crypto 或 Web Storage 的 API |
| CommonJS 工具链 | 有条件支持 | 使用动态 `import("auth-client-web")` 或由构建工具转换 ESM |
| 现代 Chrome / Edge / Firefox / Safari | 支持基础流程 | Web Locks / BroadcastChannel 缺失时会降级，仍需完成目标浏览器回归 |
| HTTPS Web Origin / localhost | 支持 | PKCE 需要安全上下文；headless email 还必须通过 auth-service Origin 与 CORS 校验 |
| Electron 自定义或 packaged Origin | SDK 跳转能力取决于宿主导航适配；headless email 不支持 | 不要把 `Origin: null` 或自定义 scheme 接入 headless email |
| 非 JavaScript 后端 | 前端 SDK 不受影响 | 资源服务必须自行完成 JWKS、issuer、expiry 和本应用 audience 校验 |

## Token 存储与安全边界

SDK 默认把 access token、refresh token、到期时间和用户信息写入当前源的 `localStorage`；OAuth `state` 与 PKCE verifier 写入当前标签页的 `sessionStorage`。这些数据不会被 SDK 加密，任何能在同源页面执行的 JavaScript 都可能读取 `localStorage` 中的 token。

因此，本包适合已经接受“浏览器 JavaScript 可读 token”这一边界的应用。接入方应至少使用严格 CSP、避免第三方或未受信任脚本、持续防范 XSS、不把 token 写入日志，并在退出登录时清理本地会话。如果安全模型要求 refresh token 只能存在于 HttpOnly Cookie，本包当前的默认存储模型不适用，应在 auth-service 和客户端共同支持相应会话模式后再接入。

覆盖 `storageKeys` 只会改变键名，不会提升存储安全性，也不会在不同源之间共享 token。

## 版本兼容

auth-service 当前没有与 npm 包一一对应的稳定版本号，因此兼容性以 HTTP/OAuth 协议端点为准：

| auth-client-web | 所需 auth-service 能力 | 建议 |
|---|---|---|
| `0.4.x` | `0.3.x` 全部能力；无跳转恢复还需要 credentialed `/auth/session/resume`，并在换票时复验 Cookie sid/version/user/generation | **当前推荐**；先部署配套 auth-service，再升级 SDK 和宿主，并在 `beforeCommit` 清理用户绑定业务状态 |
| `0.3.x` | `0.2.x` 全部能力；账户对账还需要 credentialed `/auth/session/reconcile`、带 `state/redirect_uri` 的 credentialed 换票，以及服务端 sid 级撤销与二次 Cookie 会话校验 | 支持已登录账户对账，不包含本地无票据时的 JSON 会话恢复 |
| `0.2.x` | `/auth/authorize`、`/auth/oauth/token`、`/auth/userinfo`、`/auth/token/refresh`；使用 headless transaction 时，应用的交互接口还需原样返回短期单次 `code` 与 `state` | 旧应用兼容；支持跳转登录、静默 SSO 与 headless transaction |
| `0.1.x` | 跳转授权、PKCE 换码、userinfo 与 refresh 端点 | 仅用于仍未接入 headless transaction 的旧应用 |

`/auth/token/revoke` 和 `/auth/logout` 用于完整退出流程。升级前应在目标 auth-service 环境验证登录、refresh、userinfo、退出和回调恢复；应用依赖建议使用 npm lockfile 锁定具体版本。`0.x` 阶段次版本可能包含公共 API 变更。

## 接入回归清单

新项目至少完成以下真实环境回归，不能只以 TypeScript 构建通过代替登录链路：

- [ ] npm 依赖来自 registry，lockfile 锁定实际版本，生产 bundle 中没有重复 SDK 版本；
- [ ] Google、GitHub（按启用项）登录能回到精确 `redirect_uri`，伪造/不匹配 state 被拒绝；
- [ ] 邮箱入口按 capabilities 显隐，发送、错误验证码、正确验证码、重发倒计时和限流提示符合接口结果；
- [ ] 新邮箱与已有邮箱都能登录，前端不根据 `202` 响应猜测账户是否存在；
- [ ] 页面刷新后本地会话恢复，access token 临近过期时只发生一次 refresh rotation；
- [ ] 资源接口返回 401 时最多刷新并重试一次，refresh 被 401/403 拒绝后进入未登录态；
- [ ] 在另一个已登录应用切换账户后，本应用重新聚焦会进入 `synchronizing`、清旧缓存并采用新账户；
- [ ] 本地无 token、中央 IdP 有会话时，`resumeSession()` 无页面跳转恢复；中央无会话时保持未登录；
- [ ] 两个同源标签并发 refresh、resume 和账户切换时不会互相登出或出现混合用户数据；
- [ ] 本地退出只影响当前应用；全局退出结束匹配的中央 session，其他应用的旧票据在受保护请求/refresh 被拒后安全清理；
- [ ] 后端拒绝 issuer、过期 token 和错误 audience；不同 client 的 token 不能越权访问；
- [ ] 浏览器 console、前端日志、埋点和错误上报中没有 access token、refresh token、authorization code、PKCE verifier、验证码或完整邮箱。

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run lint:package
npm run check          # 顺序执行以上发布门禁
npm run pack:dry-run   # 检查实际 tarball 内容
```

## 发布

`auth-client-web` 已完成首次 npm 发布；消费者直接使用 registry 正式包，不需要自行执行本节操作。维护者后续版本继续只通过 [`.github/workflows/publish.yml`](https://github.com/HyxiaoGe/auth-client-web/blob/master/.github/workflows/publish.yml) 的 npm Trusted Publishing 发布。

当前发布链路已经采用 GitHub OIDC、npm provenance 和 GitHub environment `npm`，不读取长期 `NPM_TOKEN`。任何真实发布都属于不可逆的外部操作，仍必须由维护者确认版本、包内容和 tag：

1. 确认 npm Trusted Publisher 仍绑定 `HyxiaoGe/auth-client-web`、工作流 `publish.yml` 和 GitHub environment `npm`。
2. 确认 GitHub environment `npm` 的 required reviewers 与仓库 Variable `NPM_TRUSTED_PUBLISHING_ENABLED=true` 未被移除；变量未设置时，tag 会被忽略，不会触发真实发布。
3. 确保 `package.json` 的版本尚未发布，让 tag 严格等于 `v<package version>`，并且 tag 指向的提交已经进入远端 `master` 历史。侧分支提交即使被打上版本 tag，也会在发布前被拒绝。

发布前在本地执行：

```bash
npm run check
npm run pack:dry-run
git push origin master
git tag v0.4.1
git push origin v0.4.1
```

`v0.4.1` 只是下一版本示例，实际 tag 必须与当前 `package.json` 版本一致。tag 工作流会拉取完整 Git 历史并显式更新 `origin/master`，确认 tag 提交是 `origin/master` 的祖先后，再执行依赖安装、审计、类型检查、测试、构建和 publint；提交不在 `master` 或 tag 与包版本不一致时都会失败。
