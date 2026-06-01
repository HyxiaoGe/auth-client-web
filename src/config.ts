/**
 * SDK configuration. Apps call `configure()` once at startup. Storage keys are
 * overridable so a migrating app can keep its existing localStorage keys (and thus its
 * already-logged-in users) instead of being forced onto the SDK's neutral defaults.
 */

export type StorageKeys = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  user: string;
};

export type AuthConfig = {
  authUrl: string;
  clientId: string;
  redirectUri: string;
  storageKeys?: Partial<StorageKeys>;
};

export type ResolvedConfig = {
  authUrl: string;
  clientId: string;
  redirectUri: string;
  storageKeys: StorageKeys;
};

const DEFAULT_KEYS: StorageKeys = {
  accessToken: "acw_access_token",
  refreshToken: "acw_refresh_token",
  expiresAt: "acw_expires_at",
  user: "acw_user",
};

let current: ResolvedConfig | null = null;

export function configure(config: AuthConfig): void {
  current = {
    authUrl: config.authUrl.replace(/\/+$/, ""),
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    storageKeys: { ...DEFAULT_KEYS, ...config.storageKeys },
  };
}

export function getConfig(): ResolvedConfig {
  if (current === null) {
    throw new Error("auth-client-web: configure() must be called before use.");
  }
  return current;
}

/** Test hook: clear module state between cases. */
export function resetConfig(): void {
  current = null;
}
