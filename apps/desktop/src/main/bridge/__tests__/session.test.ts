import { describe, expect, it, vi } from "vitest";

import { createSession } from "../session.js";

/** A valid ready frame; C5 validates the body, not the app version. */
const READY = JSON.stringify({
  v: 1,
  ch: "control",
  seq: 0,
  t: "bridge.ready",
  body: { appVersion: "0.1.0", bridgeVersion: "1" },
});

function sessionWith(deliver: (payload: string) => void) {
  return createSession({
    deliver,
    expectedBridgeVersion: "1",
    coreVersion: "0.1.0",
    bulkPages: 0,
  });
}

describe("createSession", () => {
  it("emits exactly one accept for the first ready", () => {
    const delivered: string[] = [];
    const session = sessionWith((payload) => delivered.push(payload));

    session.submit(READY);
    session.submit(READY);

    const accepts = delivered.filter((payload) => payload.includes('"bridge.accept"'));
    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toContain('"coreVersion"');
  });

  it("rejects a mismatched ready and then stays silent", () => {
    const delivered: string[] = [];
    const session = createSession({
      deliver: (payload) => delivered.push(payload),
      expectedBridgeVersion: "2",
      coreVersion: "0.1.0",
      bulkPages: 0,
    });

    session.submit(READY);
    session.submit(READY);

    expect(delivered.filter((payload) => payload.includes('"bridge.reject"'))).toHaveLength(1);
    session.markRejected();
    expect(session.rejected).toBe(true);
  });

  it("counts a malformed submit without throwing", () => {
    const session = sessionWith(() => {});

    expect(() => session.submit("not json")).not.toThrow();
    expect(session.stats.submitFailures).toBe(1);
  });

  it("closes twice without throwing", () => {
    const session = sessionWith(() => {});

    expect(() => session.close()).not.toThrow();
    expect(() => session.close()).not.toThrow();
  });

  it("counts a close failure and still finishes closing", () => {
    const session = sessionWith(() => {});

    // The real sender's close() flushes and can rethrow a transport failure.
    // Replacing it with a throw isolates the session's "swallow, count, finish"
    // rule from C5's queue mechanics.
    (session.sender as unknown as { close: () => void }).close = () => {
      throw new Error("transport down");
    };

    expect(() => session.close()).not.toThrow();
    expect(session.stats.closeFailures).toBe(1);
    expect(() => session.close()).not.toThrow();
  });
});
