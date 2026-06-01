import { afterEach, describe, expect, it, vi } from "vitest";

import * as navigation from "../src/navigation.js";

describe("submitForm()", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("builds and submits a hidden POST form with one hidden input per field", () => {
    // jsdom does not implement HTMLFormElement.submit (it would navigate) -- stub it.
    const submitSpy = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});

    navigation.submitForm("https://auth.example/auth/logout", {
      post_logout_redirect_uri: "https://app.example/auth/callback",
      client_id: "audio",
    });

    const form = document.body.querySelector("form");
    expect(form).not.toBeNull();
    expect(form!.method).toBe("post");
    expect(form!.action).toBe("https://auth.example/auth/logout");

    const inputs = Array.from(form!.querySelectorAll("input"));
    expect(inputs.map((i) => [i.type, i.name, i.value])).toEqual([
      ["hidden", "post_logout_redirect_uri", "https://app.example/auth/callback"],
      ["hidden", "client_id", "audio"],
    ]);
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("submits an empty-field form (no inputs) without error", () => {
    const submitSpy = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
    navigation.submitForm("https://auth.example/auth/logout", {});
    const form = document.body.querySelector("form");
    expect(form).not.toBeNull();
    expect(form!.querySelectorAll("input").length).toBe(0);
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });
});
