/** @vitest-environment jsdom */
/**
 * The failure reaches the panel's store.
 *
 * This is the case the whole change exists for. The host always knew why the
 * shell had stopped -- it wrote the sentence to the log and the status bar's
 * tooltip -- but the panel's message family carried the phase and rebuilt the
 * message from `{ kind, phase }`, so everything else was dropped on arrival. The
 * symptom was a panel that said `failed` and rendered nothing.
 *
 * So the assertion is not "the message type has a field": it is that a message
 * shaped like the host's reaches `snapshot().status` with every fact intact, and
 * that a phase without its failure is refused rather than half-rendered.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTransport, type WebviewTransport } from "../transport.js";

/** The bridge version this bundle speaks; the host has to announce the same. */
const { WEBVIEW_BRIDGE_VERSION } = await import("../bridge.js");

/** One message this panel sent. */
interface Posted {
  readonly kind: string;
}

/** The messages this panel sent, in order. */
const posted: Posted[] = [];

/** A page handle the transport can attach to, without a real VS Code API. */
const API = {
  postMessage(message: Posted): void {
    posted.push(message);
  },
  getState: () => undefined,
  setState: () => undefined,
};

/** Install a transport bound to the fake page handle. */
function connect(): WebviewTransport {
  return createTransport({ api: API as never });
}

/**
 * Hand one message to the transport as if the host had posted it.
 *
 * Every case delivers the handshake first for the same reason the host sends it:
 * the bridge refuses a `status` before it knows which protocol it is speaking,
 * so a case that skipped it would be asserting on a message it rejected for
 * another reason.
 *
 * @param data the message the host would post
 */
function deliver(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

/**
 * The handshake every real host sends before anything else.
 *
 * The version is imported rather than written here so this file cannot drift
 * from the bundle: a literal would pass after the protocol moved.
 */
async function boot(): Promise<Record<string, unknown>> {
  return {
    kind: "boot",
    appVersion: "1.0.0",
    bridgeVersion: WEBVIEW_BRIDGE_VERSION,
    frameProtocolVersion: 1,
  };
}

beforeEach(() => {
  posted.length = 0;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>)["acquireVsCodeApi"];
});

describe("the status failure on the wire", () => {
  it("carries every fact the page renders into the store", async () => {
    const transport = connect();

    deliver(await boot());

    deliver({
      kind: "status",
      phase: "failed",
      failure: {
        kind: "untested-engine",
        detail: "the engine reports version 2.0.0",
        candidateDir: "/opt/haruyuki",
        expectedVersion: "1.4.0",
        actualVersion: "2.0.0",
      },
    });

    const status = transport.bridge.snapshot().status;

    expect(status?.phase).toBe("failed");
    expect(status?.failure?.kind).toBe("untested-engine");
    expect(status?.failure?.expectedVersion).toBe("1.4.0");
    expect(status?.failure?.actualVersion).toBe("2.0.0");
    expect(status?.failure?.candidateDir).toBe("/opt/haruyuki");

    transport.dispose();
  });

  it("carries the lists a folder refusal is repaired from", async () => {
    const transport = connect();

    deliver(await boot());

    deliver({
      kind: "status",
      phase: "failed",
      failure: {
        kind: "start-failed",
        detail: "/tmp/x: haruyuki.js is missing",
        missingEntries: ["haruyuki.js", "node_modules"],
        searchedPaths: ["/opt/a", "/opt/b"],
      },
    });

    const failure = transport.bridge.snapshot().status?.failure;

    // Two lists, copied element by element: the message is untrusted input, so a
    // reference kept from it would be a reference into another process's data.
    expect(failure?.missingEntries).toEqual(["haruyuki.js", "node_modules"]);
    expect(failure?.searchedPaths).toEqual(["/opt/a", "/opt/b"]);

    transport.dispose();
  });

  it("refuses a failed phase that carries no failure", async () => {
    const transport = connect();

    deliver(await boot());

    // The host refuses this pairing on its way out, so seeing it here means a
    // bug. Carrying it would leave the page with a heading and nothing under it.
    deliver({ kind: "status", phase: "failed" });

    expect(transport.bridge.snapshot().status).toBeNull();

    transport.dispose();
  });

  it("accepts a phase that is not a failure without one", async () => {
    const transport = connect();

    deliver(await boot());
    deliver({ kind: "status", phase: "ready" });

    // The optional failure must stay optional: a connected shell sends no facts.
    expect(transport.bridge.snapshot().status?.phase).toBe("ready");
    expect(transport.bridge.snapshot().status?.failure).toBeUndefined();

    transport.dispose();
  });

  it("drops an unknown key rather than forwarding it", async () => {
    const transport = connect();

    deliver(await boot());

    deliver({
      kind: "status",
      phase: "failed",
      failure: { kind: "start-failed", detail: "boom", smuggled: "/etc/passwd" },
    });

    // Every field is rebuilt explicitly, which is the rule this change restored:
    // a spread here is what silently dropped the facts in the first place.
    expect(transport.bridge.snapshot().status?.failure).toEqual({
      kind: "start-failed",
      detail: "boom",
    });

    transport.dispose();
  });
});
