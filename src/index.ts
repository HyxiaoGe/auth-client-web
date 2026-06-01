/**
 * auth-client-web — framework-neutral browser SDK for auth-service.
 *
 * The full silent-SSO flow assembled from PKCE/state/storage primitives:
 *   configure() once at startup, then login()/silentLogin() to start the redirect,
 *   handleCallback() on the redirect_uri page, getAccessToken()/fetchWithAuth() for API
 *   calls, logout() to end the session, and subscribe() to mirror {user, status} into a
 *   framework store. Apps wrap these in a thin Zustand/Redux/React adapter.
 */

// Configuration
export { configure, getConfig } from "./config.js";
export type { AuthConfig, ResolvedConfig, StorageKeys } from "./config.js";

// Reactive state
export { getState, subscribe } from "./store.js";
export type { AuthState, AuthStatus, AuthUser } from "./store.js";

// Sign-in (top-level redirect to /authorize)
export { login, silentLogin, buildAuthorizeUrl, takeRedirectPath } from "./authorize.js";
export type { AuthorizeOptions } from "./authorize.js";

// Callback handling on the redirect_uri page
export { handleCallback } from "./callback.js";
export type { CallbackResult } from "./callback.js";

// Tokens + authenticated requests
export { getAccessToken, refresh } from "./tokens.js";
export { fetchWithAuth } from "./http.js";

// Profile
export { fetchUserInfo } from "./userinfo.js";

// Sign-out
export { logout } from "./logout.js";
export type { LogoutOptions } from "./logout.js";

// Lower-level primitives (advanced / testing)
export { generatePkce } from "./pkce.js";
export type { PkcePair } from "./pkce.js";
export { createTokenStore } from "./storage.js";
export type { SessionTokens, TokenStore } from "./storage.js";
export { tokenStore } from "./session.js";
