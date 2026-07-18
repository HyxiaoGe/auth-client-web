# auth-client-web

Framework-neutral browser SDK for **auth-service**. 把「无 token → 静默 `/authorize?prompt=none` → 失败才显式登录」这套单点登录（SSO）逻辑收敛一次，同时提供与邮箱、短信或具体 UI 无关的 headless OAuth authorization transaction，供应用内验证码等交互安全复用同一套 PKCE 换码和会话落库能力。

> 配套后端共享库见 `auth-service/auth-client`（Python，JWKS 验签）。本包是其前端对应物。

## 状态

`0.2.0` 在原有顶层跳转流程之外增加 headless authorization transaction；原有 `login()`、`silentLogin()`、`handleCallback()` 和 legacy sessionStorage 键保持兼容。

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
| `session` / `userinfo` | 配置绑定的 tokenStore 访问器；`/auth/userinfo` 拉取并把 `avatar_url` 归一化为 `avatarUrl`（缺 `id` 即抛错） |
| `tokens` | `getAccessToken` + 单 in-flight 刷新合流；401 跨标签轮转守卫 |
| `http` | `fetchWithAuth`——注入 Bearer，401 强制刷新并仅重试一次（有界） |
| `logout` | 尽力撤销 refresh token，本地必清并置未登录，可选跳转 |

## 用法

```ts
import { configure, login, silentLogin, handleCallback, getAccessToken, fetchWithAuth, logout, subscribe } from "auth-client-web";

configure({ authUrl, clientId, redirectUri });   // 启动时一次（storageKeys 可选，迁移时保留各 app 既有键）

// 应用加载、本地无 token 时：静默探测共享 IdP 会话
silentLogin();                                    // 顶层跳 …&prompt=none；无会话则 ?error=login_required 原路返回，无 UI
login("google", { redirectPath: "/tasks" });      // 显式登录：顶层跳 /auth/authorize（带 PKCE + state）

// 在 redirect_uri 回调页：
const result = await handleCallback();            // 默认读 window.location.href；校验 state → 换 token → 拉 userinfo
// result: { status: "authenticated", user, redirectPath } | { status: "unauthenticated", error } | { status: "no_callback" }

const token = await getAccessToken();             // 过期自动刷新（同标签并发合流）
const res = await fetchWithAuth("/api/...");      // 自动带 Bearer，401 刷新后重试一次

const off = subscribe((s) => render(s));          // 镜像 {user, status} 进框架 store（Zustand/Redux 适配在各 app 侧）

await logout({ redirectTo: "/" });
```

## Headless authorization

SDK 只准备和完成 OAuth authorization transaction，不负责发送邮箱或短信验证码，也不接触邮箱、手机号等登录标识。应用把公开参数交给 auth-service 的交互接口；交互验证成功后，auth-service 只返回短期、单次的 authorization code 和原始 state，SDK 再用保存在当前标签页中的 transaction-specific PKCE verifier 完成登录。

```ts
import {
  prepareAuthorization,
  completeAuthorization,
  cancelAuthorization,
} from "auth-client-web";

// 1. 用户开始应用内登录时准备 OAuth 参数。
const authorization = await prepareAuthorization({ redirectPath: "/chat/new" });

// 2. 应用把这些公开字段传给 auth-service 的邮箱、短信或其他验证交互。
await startInteraction({
  response_type: authorization.responseType,
  client_id: authorization.clientId,
  redirect_uri: authorization.redirectUri,
  state: authorization.state,
  code_challenge: authorization.codeChallenge,
  code_challenge_method: authorization.codeChallengeMethod,
});

// 3. auth-service 验证交互后返回 code + 原始 state。
const result = await completeAuthorization({
  authorizationCode: interactionResult.code,
  state: interactionResult.state,
});
// result: { status: "authenticated", user, redirectPath: "/chat/new" }

// 用户关闭弹窗时只取消这一笔 transaction，不影响其他登录事务。
cancelAuthorization(authorization.state);
```

每笔 headless transaction 都以高熵 state 为键保存在 `sessionStorage`，记录带版本和过期时间，不保存 PII。未知、过期或不匹配的 state 不会触发 token exchange；同一 state 的并发完成调用会合流。state 验证成功后，pending verifier 会在换 token 前一次性消费。

`completeAuthorization` 可选接收 `signal: AbortSignal`，并将取消贯穿 token exchange 与 userinfo。取消或 userinfo 失败时不会把新 token 与旧用户混合提交，但授权事务仍按一次性语义消费，需要重新 `prepareAuthorization()`。

各框架的薄适配（audio = Zustand，fusion = Redux）在各自应用侧基于 `subscribe()` 构建，不进本包。

## 安装（git URL，零 registry）

```bash
npm install git+https://github.com/<owner>/auth-client-web.git
```

包带 `prepare` 脚本，git 安装时自动 `tsc` 构建出 `dist/`。

## 开发

```bash
npm install
npm test          # vitest run
npm run typecheck
npm run build
```
