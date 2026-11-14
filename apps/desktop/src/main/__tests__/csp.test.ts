import { describe, expect, it } from "vitest";

import { CSP, CSP_DIRECTIVES, headersFor, shouldApplyFallbackCsp } from "../csp.js";

describe("CSP", () => {
  it("has exactly the ten frozen directives", () => {
    // The count is part of the contract: a policy that quietly gained or lost a
    // directive is a different policy, and the difference is invisible when you
    // read a long header value.
    expect(CSP_DIRECTIVES).toHaveLength(10);
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
    expect(CSP_DIRECTIVES).toContain("font-src 'self' data:");
    expect(CSP_DIRECTIVES).toContain("img-src 'self' data:");

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
