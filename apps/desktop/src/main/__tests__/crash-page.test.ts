import { describe, expect, it } from "vitest";

import { engineCrashQuery, rendererCrashQuery } from "../crash/page.js";

describe("rendererCrashQuery", () => {
  it("carries the kind, reason and exit code", () => {
    const query = new URLSearchParams(rendererCrashQuery({ reason: "crashed", exitCode: 2 }));

    expect(query.get("crash")).toBe("renderer");
    expect(query.get("reason")).toBe("crashed");
    expect(query.get("code")).toBe("2");
    expect(query.get("signal")).toBe("");
  });

  it("turns a null exit code into an empty value, not the word null", () => {
    const query = new URLSearchParams(rendererCrashQuery({ reason: "oom", exitCode: null }));

    expect(query.get("code")).toBe("");
  });

  it("keeps a separator inside the reason from splitting the query", () => {
    const query = new URLSearchParams(rendererCrashQuery({ reason: "a&b=c", exitCode: 1 }));

    expect(query.get("reason")).toBe("a&b=c");
    expect(query.get("crash")).toBe("renderer");
  });
});

describe("engineCrashQuery", () => {
  it("carries the kind, exit code and signal", () => {
    const query = new URLSearchParams(engineCrashQuery({ code: 1, signal: "SIGKILL" }));

    expect(query.get("crash")).toBe("engine");
    expect(query.get("code")).toBe("1");
    expect(query.get("signal")).toBe("SIGKILL");
    expect(query.get("reason")).toBe("");
  });

  it("turns a null code and signal into empty values", () => {
    const query = new URLSearchParams(engineCrashQuery({ code: null, signal: null }));

    expect(query.get("code")).toBe("");
    expect(query.get("signal")).toBe("");
  });
});
