/**
 * Authenticated fetch wrapper. Injects the current access token as a Bearer header, and on a
 * 401 forces exactly one refresh + retry -- covering tokens the resource server rejects even
 * though our local clock still considered them fresh (revoked, rotated elsewhere, clock skew).
 *
 * The retry is bounded to one attempt: a failed refresh returns the original 401 rather than
 * looping. The caller's method, body, and headers are preserved; only Authorization is set.
 */

import { getAccessToken, refresh } from "./tokens.js";

function withAuth(init: RequestInit, token: string | null): RequestInit {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

export async function fetchWithAuth(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  const res = await fetch(input as string, withAuth(init, token));
  if (res.status !== 401) {
    return res;
  }

  // Token was rejected server-side -- force one refresh and retry once.
  const fresh = await refresh();
  if (fresh === null) {
    return res;
  }
  return fetch(input as string, withAuth(init, fresh));
}
