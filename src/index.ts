/**
 * auth-client-web — framework-neutral browser SDK for auth-service.
 *
 * Public surface (in progress). Built so far: configuration + the PKCE/state/storage
 * primitives the silent-SSO flow is assembled from. The orchestration layer
 * (login / silentLogin / handleCallback / getAccessToken / logout / fetchWithAuth /
 * subscribe) lands next.
 */

export { configure, getConfig } from "./config.js";
export type { AuthConfig, ResolvedConfig, StorageKeys } from "./config.js";
export { generatePkce } from "./pkce.js";
export type { PkcePair } from "./pkce.js";
export { createTokenStore } from "./storage.js";
export type { SessionTokens, TokenStore } from "./storage.js";
