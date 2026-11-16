import { describe, expect, it } from "vitest";

import { CSP, CSP_DIRECTIVES, headersFor, shouldApplyFallbackCsp } from "../csp.js";

describe("CSP", () => {
  it("has exactly the eleven directives, one of which D2 added", () => {
    // The count is part of the contract: a policy that quietly gained or lost a
    // directive is a different policy, and the difference is invisible when you
    // read a long header value.
    // Eleven, not the ten `D1` froze: D2 adds `media-src` so a user's local video
    // can play, because `default-src 'none'` would otherwise block every media
    // element. Nothing else moved -- see the diff-pin test below.
    expect(CSP_DIRECTIVES).toHaveLength(11);
  });

  it("changed only by addition: every D1 directive is still there, and unchanged", () => {
    // This is the assertion that makes "only add, never remove" checkable rather
    // than a promise. The requirement allows D2 to add a scheme to three
    // directives and forbids changing any existing value; the frozen contract stays
    // compatible precisely because `D1`'s semantics are unchanged).
    //
    // Adding a source to `img-src` does change that directive's value, which is
    // why the distinction has to be written down: "only add" means the *previous
    // tokens are all still present in the same order*, not that the line is
    // byte-identical. Anything that drops or reorders a token fails here.
    const FROZEN_BY_D1: readonly [string, readonly string[]][] = [
      ["default-src", ["'none'"]],
      ["script-src", ["'self'"]],
      ["style-src", ["'self'", "'unsafe-inline'"]],
      ["img-src", ["'self'", "data:"]],
      ["font-src", ["'self'", "data:"]],
      ["connect-src", ["'self'"]],
      ["object-src", ["'none'"]],
      ["base-uri", ["'none'"]],
      ["form-action", ["'none'"]],
      ["frame-ancestors", ["'none'"]],
    ];

    for (const [directive, tokens] of FROZEN_BY_D1) {
      const line = CSP_DIRECTIVES.find((d) => d.startsWith(`${directive} `));

      expect(line, directive).toBeDefined();
      if (line === undefined) continue;

      // The D1 tokens must be a prefix of the current value, in order.
      expect(line, directive).toBe(
        `${directive} ${[...tokens].join(" ")}`.concat(
          line.slice(`${directive} ${[...tokens].join(" ")}`.length),
        ),
      );
      expect(line.split(" ").slice(0, tokens.length + 1), directive).toEqual([
        directive,
        ...tokens,
      ]);
    }
  });

  it("grants the media scheme to exactly the three directives D2 needs", () => {
    // Images, fonts and media elements. Not `connect-src` (the channel forbids
    // fetch), not `script-src` (nothing from a user's disk may run), not
    // `default-src` (the deny-by-default rule stays absolute).
    const withMedia = CSP_DIRECTIVES.filter((d) => d.includes("haruyuki-media:"));

    expect(withMedia.map((d) => d.split(" ")[0]).sort()).toEqual([
      "font-src",
      "img-src",
      "media-src",
    ]);
  });

  it("denies by default", () => {
    expect(CSP_DIRECTIVES).toContain("default-src 'none'");
  });

  it("forbids inline and evaluated script", () => {
    const scriptSrc = CSP_DIRECTIVES.find((d) => d.startsWith("script-src"));

    expect(scriptSrc).toBe("script-src 'self'");
    expect(CSP).not.toContain("unsafe-eval");
    // `'unsafe-inline'` is allowed for style, never for script.
    expect(scriptSrc).not.toContain("unsafe-inline");
  });

  it("allows inline style, which the component and math layers need", () => {
    expect(CSP_DIRECTIVES).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("allows data: fonts and images but not data: scripts", () => {
    expect(CSP_DIRECTIVES).toContain("font-src 'self' data: haruyuki-media:");
    expect(CSP_DIRECTIVES).toContain("img-src 'self' data: haruyuki-media:");

    const scriptSrc = CSP_DIRECTIVES.find((d) => d.startsWith("script-src"));
    expect(scriptSrc).not.toContain("data:");
  });

  it("does not open any origin beyond self for connections", () => {
    const connectSrc = CSP_DIRECTIVES.find((d) => d.startsWith("connect-src"));

    expect(connectSrc).toBe("connect-src 'self'");
    expect(connectSrc).not.toContain("ws:");
    expect(connectSrc).not.toContain("*");
  });

  it("blocks plugins, base retargeting, form navigation and framing", () => {
    expect(CSP_DIRECTIVES).toContain("object-src 'none'");
    expect(CSP_DIRECTIVES).toContain("base-uri 'none'");
    expect(CSP_DIRECTIVES).toContain("form-action 'none'");
    expect(CSP_DIRECTIVES).toContain("frame-ancestors 'none'");
  });

  it("contains no 'unsafe-eval' anywhere", () => {
    // The renderer bundle has zero `eval`/`new Function` (route fact 10). If this
    // ever fails, the bundle changed and the CSP should not be relaxed to match.
    expect(CSP).not.toContain("eval");
  });
});

describe("headersFor", () => {
  it("carries the policy, the decided type and nosniff", () => {
    const headers = headersFor("text/html; charset=utf-8");

    expect(headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(headers["content-security-policy"]).toBe(CSP);
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
  });

  it("gives every content type the same policy", () => {
    const a = headersFor("text/javascript; charset=utf-8");
    const b = headersFor("image/svg+xml");

    expect(a["content-security-policy"]).toBe(b["content-security-policy"]);
  });
});

describe("shouldApplyFallbackCsp", () => {
  it("covers the shell's own scheme", () => {
    expect(shouldApplyFallbackCsp("app://haruyuki/index.html")).toBe(true);
    expect(shouldApplyFallbackCsp("app://haruyuki/assets/app.js")).toBe(true);
  });

  it("covers a request whose host is wrong, because it is still the scheme", () => {
    expect(shouldApplyFallbackCsp("app://elsewhere/index.html")).toBe(true);
  });

  it("leaves other schemes alone", () => {
    expect(shouldApplyFallbackCsp("https://example.com/x.png")).toBe(false);
    expect(shouldApplyFallbackCsp("devtools://devtools/x")).toBe(false);
    expect(shouldApplyFallbackCsp("file:///C:/x.html")).toBe(false);
  });

  it("does not match a string that merely contains the prefix", () => {
    expect(shouldApplyFallbackCsp("https://example.com/app://x")).toBe(false);
  });
});
