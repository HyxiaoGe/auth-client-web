# auth-client-web

Framework-neutral browser SDK for **auth-service**. 把「无 token → 静默 `/authorize?prompt=none` → 失败才显式登录」这套单点登录（SSO）逻辑收敛一次，同时提供与邮箱、短信或具体 UI 无关的 headless OAuth authorization transaction，供应用内验证码等交互安全复用同一套 PKCE 换码和会话落库能力。

> 配套后端共享库见 `auth-service/auth-client`（Python，JWKS 验签）。本包是其前端对应物。

## 安装

npm registry 是推荐安装方式：

```bash
npm install auth-client-web
```

包只提供 ESM，不提供 CommonJS 构建。ESM 项目可以直接静态导入；CommonJS 工具链需要使用动态 `import("auth-client-web")`，或由应用构建工具完成 ESM 转换。

需要在 registry 发布前验证，或在无法访问 registry 的环境里安装时，可以固定到明确的 Git tag（不要依赖会移动的默认分支）：

```bash
npm install github:HyxiaoGe/auth-client-web#v0.2.1
```

Git 安装会通过 `prepare` 自动构建 `dist/`。

## 状态

`0.2.1` 是首个 npm 发布准备版本：沿用 `0.2.0` 引入的 headless authorization transaction，并补齐运行时协议校验、结构化错误和 callback 会话一致性；原有 `login()`、`silentLogin()`、`handleCallback()` 和 legacy sessionStorage 键保持兼容。

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

## 运行环境

本包面向现代浏览器，编译目标为 ES2022。执行认证流程的页面需要：

- 支持 ESM、`fetch`、Web Crypto、`TextEncoder`、`AbortSignal`、`localStorage` 和 `sessionStorage`；
- 在 HTTPS 或 `localhost` 等安全上下文中运行，以便使用 `crypto.subtle` 完成 PKCE；
- 允许当前站点使用 Web Storage；隐私模式或禁用存储时，调用方需要处理浏览器抛出的错误；
- 把认证调用放在客户端执行。包可以被 ESM 工具链解析，但依赖 `window`、`document` 或 Web Storage 的流程不能在 Node.js/SSR 阶段运行。

`navigator.locks` 是可选增强：支持时用于跨标签页串行 refresh；不支持时 SDK 会回退到直接刷新。

package metadata 为使用 Node.js ESM 工具链的消费者声明 Node.js 18 或更高版本；浏览器才是 SDK 的实际运行环境。仓库的构建、测试和发布工具链因为 Vite 8 需要 Node.js 20.19.0 或更高版本，这个开发要求不会给浏览器增加 Node.js 运行时依赖。

## Token 存储与安全边界

SDK 默认把 access token、refresh token、到期时间和用户信息写入当前源的 `localStorage`；OAuth `state` 与 PKCE verifier 写入当前标签页的 `sessionStorage`。这些数据不会被 SDK 加密，任何能在同源页面执行的 JavaScript 都可能读取 `localStorage` 中的 token。

因此，本包适合已经接受“浏览器 JavaScript 可读 token”这一边界的应用。接入方应至少使用严格 CSP、避免第三方或未受信任脚本、持续防范 XSS、不把 token 写入日志，并在退出登录时清理本地会话。如果安全模型要求 refresh token 只能存在于 HttpOnly Cookie，本包当前的默认存储模型不适用，应在 auth-service 和客户端共同支持相应会话模式后再接入。

覆盖 `storageKeys` 只会改变键名，不会提升存储安全性，也不会在不同源之间共享 token。

## 版本兼容

auth-service 当前没有与 npm 包一一对应的稳定版本号，因此兼容性以 HTTP/OAuth 协议端点为准：

| auth-client-web | 所需 auth-service 能力 | 建议 |
|---|---|---|
| `0.2.x` | `/auth/authorize`、`/auth/oauth/token`、`/auth/userinfo`、`/auth/token/refresh`；使用 headless transaction 时，应用的交互接口还需原样返回短期单次 `code` 与 `state` | 当前推荐；支持跳转登录、静默 SSO 与 headless transaction |
| `0.1.x` | 跳转授权、PKCE 换码、userinfo 与 refresh 端点 | 仅用于仍未接入 headless transaction 的旧应用 |

`/auth/token/revoke` 和 `/auth/logout` 用于完整退出流程。升级前应在目标 auth-service 环境验证登录、refresh、userinfo、退出和回调恢复；应用依赖建议使用 npm lockfile 锁定具体版本。`0.x` 阶段次版本可能包含公共 API 变更。

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

首次创建 npm 包与后续版本发布分开处理。任何真实发布都属于不可逆的外部操作，必须在维护者确认版本、包内容和 npm 账号后执行。

### 首次发布

`auth-client-web` 尚未在 npm registry 创建，因而还不能预先在包设置中绑定 Trusted Publisher。首发需要维护者在本机完成 `npm login` 和 2FA，然后在合并后的干净 `master` 上执行：

```bash
npm ci
npm run check
npm run pack:dry-run
npm publish
```

首发成功后再创建并推送对应的 `v0.2.1` tag。首发不在仓库或 GitHub Secrets 中保存 npm token。

### 后续可信发布

首发完成后，后续版本只通过 [`.github/workflows/publish.yml`](https://github.com/HyxiaoGe/auth-client-web/blob/master/.github/workflows/publish.yml) 的 npm Trusted Publishing 发布：

1. 在 npm 包设置中把 `HyxiaoGe/auth-client-web`、工作流 `publish.yml` 和 GitHub environment `npm` 配置为 Trusted Publisher，并把 `npm publish` 选为 allowed action。
2. 在 GitHub 创建名为 `npm` 的 environment，并配置 required reviewers。
3. 在仓库 Variables 中显式设置 `NPM_TRUSTED_PUBLISHING_ENABLED=true`。变量未设置时，tag 只会被忽略，不会触发真实发布。
4. 确保 `package.json` 的版本尚未发布，并让 tag 严格等于 `v<package version>`。

发布前在本地执行：

```bash
npm run check
npm run pack:dry-run
git tag v0.2.2
git push origin v0.2.2
```

最后两条命令中的版本必须替换为当前 `package.json` 版本。tag 工作流会再次执行依赖安装、审计、类型检查、测试、构建和 publint；tag 与包版本不一致时会失败。发布命令使用 GitHub OIDC 和 npm provenance，不读取 `NPM_TOKEN`。
