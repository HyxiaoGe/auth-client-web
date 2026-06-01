/**
 * Framework-neutral reactive state: the SDK owns {user, status} and notifies subscribers.
 * App-side adapters (Zustand/Redux/React) subscribe and mirror this into their own store.
 */

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export type AuthUser = {
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  [key: string]: unknown;
};

export type AuthState = {
  user: AuthUser | null;
  status: AuthStatus;
};

let state: AuthState = { user: null, status: "loading" };
const listeners = new Set<(s: AuthState) => void>();

export function getState(): AuthState {
  return state;
}

export function setState(patch: Partial<AuthState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

/** Subscribe to state changes; returns an unsubscribe function. */
export function subscribe(listener: (s: AuthState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: reset state and drop all subscribers. */
export function resetStore(): void {
  state = { user: null, status: "loading" };
  listeners.clear();
}
