/**
 * The single place the SDK performs a top-level browser navigation. Isolated behind a
 * function so it can be spied in tests (jsdom's window.location.assign is non-configurable)
 * and, later, guarded for SSR (window may be undefined).
 */

export function redirect(url: string): void {
  window.location.assign(url);
}

/**
 * Top-level POST navigation via a hidden auto-submitting form. Used by Single Logout: a
 * SameSite=Lax session cookie is only sent on a top-level navigation, and /auth/logout is
 * POST-only, so window.location.assign (a GET) cannot reach it -- a submitted form can.
 * Each field becomes a hidden <input>. Like redirect(), isolated for spying/SSR-guarding.
 */
export function submitForm(url: string, fields: Record<string, string>): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = url;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}
