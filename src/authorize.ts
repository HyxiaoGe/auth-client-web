/**
 * Builds the top-level redirect to auth-service's /auth/authorize and kicks it off.
 *
 * Every authorize request generates a fresh PKCE pair and CSRF state; the verifier+state
 * are persisted (pending.ts) so the callback can prove and complete the exchange.
 * `silentLogin` is the SSO probe (prompt=none): if no IdP session exists, auth-service
 * bounces back with ?error=login_required and no UI is shown.
 */

import { getConfig } from "./config.js";
import * as navigation from "./navigation.js";
import { startPendingAuth } from "./pending.js";
import { generatePkce } from "./pkce.js";

const REDIRECT_PATH_KEY = "acw_redirect_path";

export type AuthorizeOptions = {
  provider?: string;
  prompt?: string;
};

export async function buildAuthorizeUrl(opts: AuthorizeOptions): Promise<string> {
  const { authUrl, clientId, redirectUri } = getConfig();
  const { verifier, challenge, method } = await generatePkce();
  const state = startPendingAuth(verifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: method,
  });
  if (opts.prompt) params.set("prompt", opts.prompt);
  if (opts.provider) params.set("provider", opts.provider);

  return `${authUrl}/auth/authorize?${params.toString()}`;
}

/** Interactive login: remember where to land, then top-level redirect to authorize. */
export async function login(provider?: string, opts?: { redirectPath?: string }): Promise<void> {
  if (opts?.redirectPath) sessionStorage.setItem(REDIRECT_PATH_KEY, opts.redirectPath);
  navigation.redirect(await buildAuthorizeUrl({ provider }));
}

/** Silent SSO probe: prompt=none, no UI. Use on app load when there is no local token. */
export async function silentLogin(): Promise<void> {
  navigation.redirect(await buildAuthorizeUrl({ prompt: "none" }));
}

/** Read+clear the post-login path saved by login() (default "/"). */
export function takeRedirectPath(): string {
  const path = sessionStorage.getItem(REDIRECT_PATH_KEY);
  sessionStorage.removeItem(REDIRECT_PATH_KEY);
  return path ?? "/";
}
