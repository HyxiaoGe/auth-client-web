/**
 * The session-bound token store. A thin accessor that ties `createTokenStore` to the
 * keys from the active config, so the rest of the SDK never has to thread keys around.
 */

import { getConfig } from "./config.js";
import { createTokenStore, type TokenStore } from "./storage.js";

export function tokenStore(): TokenStore {
  return createTokenStore(getConfig().storageKeys);
}
