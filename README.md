# auth-client-web

Framework-neutral browser SDK for **auth-service**.収敛「无 token → 静默 `/authorize?prompt=none` → 失败才显式登录」这套单点登录（SSO）逻辑一次，audio / fusion 及未来新项目接入即得 SSO。

> 配套后端共享库见 `auth-service/auth-client`（Python，JWKS 验签）。本包是其前端对应物。

## 状态（WIP）

P3.1 进行中。已落地并测试（严格 TDD，18 测试绿）：

| 模块 | 作用 |
|---|---|
| `pkce` | PKCE S256 生成；challenge 与后端 `verify_pkce` 用同一 RFC 7636 向量交叉验证、逐字一致 |
| `pending` | 顶层跳转前持久化 `state`(CSRF) + `code_verifier`，回调页取回（sessionStorage，单次） |
| `config` | `configure()`：authUrl / clientId / redirectUri + 可覆盖存储键（迁移时保留各 app 既有键） |
| `storage` | token 存储（localStorage，键可配，时钟可注入，绝对过期 + skew 提前刷新） |
| `encoding` | base64url + CSPRNG 工具 |

待做：`login` / `silentLogin` / `handleCallback`（含 state 校验 + `code_verifier` 换码）/ `getAccessToken`（刷新合流 + Web Locks）/ `logout` / `fetchWithAuth` / `subscribe` / 框架适配（Zustand / Redux）。

## 目标 API（成型后）

```ts
import { configure, login, silentLogin, handleCallback, getAccessToken, logout, subscribe } from "auth-client-web";

configure({ authUrl, clientId, redirectUri });   // 启动时一次
login("google");                                  // 顶层跳 /auth/authorize（带 PKCE + state）
silentLogin();                                    // 顶层跳 …&prompt=none（SSO 探测）
await handleCallback(new URLSearchParams(location.search)); // 回调页：校验 state → 换 token
const token = await getAccessToken();             // 过期自动刷新（跨标签合流）
```

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
