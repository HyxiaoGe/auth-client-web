/**
 * The single place the SDK performs a top-level browser navigation. Isolated behind a
 * function so it can be spied in tests (jsdom's window.location.assign is non-configurable)
 * and, later, guarded for SSR (window may be undefined).
 */

export function redirect(url: string): void {
  window.location.assign(url);
}
