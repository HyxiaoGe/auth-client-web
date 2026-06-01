# auth-client-web

Framework-neutral browser SDK for **auth-service**. 把「无 token → 静默 `/authorize?prompt=none` → 失败才显式登录」这套单点登录（SSO）逻辑收敛一次，audio / fusion 及未来新项目接入即得 SSO。

> 配套后端共享库见 `auth-service/auth-client`（Python，JWKS 验签）。本包是其前端对应物。

## 状态

P3.1 编排层已完成并通过对抗式安全评审加固（严格 TDD，53 测试绿，`tsc --noEmit` 干净，构建正常）。

| 模块 | 作用 |
|---|---|
| `pkce` / `encoding` | PKCE S256 生成；challenge 与后端 `verify_pkce` 用同一 RFC 7636 向量交叉验证、逐字一致 |
| `pending` | 顶层跳转前持久化 `state`(CSRF) + `code_verifier`，回调页取回（sessionStorage，单次）；peek/clear 分离，便于「先校验后消费」 |
| `config` | `configure()`：authUrl / clientId / redirectUri + 可覆盖存储键（迁移时保留各 app 既有键） |
| `storage` | token 存储（localStorage，键可配，时钟可注入，绝对过期 + skew 提前刷新） |
| `store` | 框架无关可观察 `{user, status}`，`subscribe()` 供各框架适配镜像 |
| `authorize` | `buildAuthorizeUrl` / `login` / `silentLogin`（顶层跳 `/auth/authorize`，登录后落地路径记忆） |
| `callback` | `handleCallback`——安全核心：先校验 state 再消费一次性材料 → `code_verifier` 换码 → 拉 userinfo → 翻转 store |
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
