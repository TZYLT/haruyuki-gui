/**
 * The message contract between the extension host and the core child.
 *
 * These are the checks the two sides rely on instead of trusting each other:
 * every message is narrowed field by field, and an unknown `kind` is a refusal
 * rather than a throw, because the pipe is the one place where garbage arrives
 * from another process.
 */

import { describe, expect, it } from "vitest";

import {
  FRAME_CHANNELS,
  RUNTIME_FAILURE_KINDS,
  RUNTIME_PHASES,
  SECURE_OPS,
  isCommandReply,
  isCoreToHost,
  isHostToCore,
  isJsonValue,
  isRecord,
  narrowCommandCall,
  narrowCoreToHost,
  narrowHostToCore,
} from "../ipc.js";

/** @returns whether the narrowed init carries an engine version */
function hasEngineVersion(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;

  const { engine } = message as { engine?: unknown };

  return typeof engine === "object" && engine !== null && "version" in engine;
}

const INIT = {
  kind: "init",
  paths: { userData: "/u", logs: "/l", cache: "/c", temp: "/t" },
  cwd: "/work",
  locale: "en",
  engine: { kind: "bundled", dir: "/engine", bundlePath: "/engine/haruyuki.js" },
  expectedVersion: "1.0.0",
};

describe("isJsonValue", () => {
  it("accepts the JSON subset, including undefined in an object", () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue(undefined)).toBe(true);
    expect(isJsonValue("text")).toBe(true);
    expect(isJsonValue(12)).toBe(true);
    expect(isJsonValue(false)).toBe(true);
    expect(isJsonValue([1, "two", { three: 3 }])).toBe(true);
    expect(isJsonValue({ absent: undefined, list: [{ deep: [1] }] })).toBe(true);
  });

  it("refuses everything JSON would mangle or throw on", () => {
    expect(isJsonValue(() => 1)).toBe(false);
    expect(isJsonValue(Symbol("s"))).toBe(false);
    expect(isJsonValue(10n)).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(new Map([["a", 1]]))).toBe(false);
    expect(isJsonValue(new Set(["a"]))).toBe(false);
    expect(isJsonValue(/re/)).toBe(false);
    expect(isJsonValue(new (class Box {})())).toBe(false);
  });

  it("refuses a cycle instead of overflowing the stack", () => {
    const node: Record<string, unknown> = { name: "root" };

    node.self = node;

    expect(isJsonValue(node)).toBe(false);
  });

  it("refuses a value nested past the depth limit", () => {
    let deep: unknown = "leaf";

    for (let index = 0; index < 40; index += 1) deep = { next: deep };

    expect(isJsonValue(deep)).toBe(false);
  });
});

describe("isRecord", () => {
  it("accepts a plain object and an object with a null prototype", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it("refuses arrays, null and primitives", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("text")).toBe(false);
    expect(isRecord(1)).toBe(false);
  });
});

describe("narrowCommandCall", () => {
  it("keeps the envelope and drops unknown keys", () => {
    const narrowed = narrowCommandCall({
      capability: "device.info",
      body: { id: "1" },
      extra: "dropped",
    });

    expect(narrowed).toEqual({
      ok: true,
      message: { capability: "device.info", body: { id: "1" } },
    });
  });

  it("keeps a runtime scope, including a null agent id", () => {
    const narrowed = narrowCommandCall({
      capability: "message.send",
      body: {},
      runtime: { agent_id: null, conversation_id: "c1", extra: true },
    });

    expect(narrowed.ok && narrowed.message.runtime).toEqual({
      agent_id: null,
      conversation_id: "c1",
    });
  });

  it("refuses a missing capability, a non-object body and a body JSON cannot carry", () => {
    expect(narrowCommandCall({ body: {} }).ok).toBe(false);
    expect(narrowCommandCall({ capability: "", body: {} }).ok).toBe(false);
    expect(narrowCommandCall({ capability: "a", body: [] }).ok).toBe(false);
    expect(narrowCommandCall({ capability: "a", body: { at: new Date() } }).ok).toBe(false);
  });

  it("refuses an incomplete runtime scope", () => {
    expect(narrowCommandCall({ capability: "a", body: {}, runtime: {} }).ok).toBe(false);
    expect(
      narrowCommandCall({
        capability: "a",
        body: {},
        runtime: { agent_id: 1, conversation_id: "c" },
      }).ok,
    ).toBe(false);
  });
});

describe("narrowHostToCore", () => {
  it("accepts a complete init", () => {
    const narrowed = narrowHostToCore(INIT);

    expect(narrowed).toEqual({ ok: true, message: INIT });
    expect(isHostToCore(INIT)).toBe(true);
  });

  it("drops an absent engine version instead of forwarding undefined", () => {
    const narrowed = narrowHostToCore({
      ...INIT,
      engine: { kind: "external", dir: "/e", bundlePath: "/e/bundle.mjs" },
    });

    expect(narrowed.ok && hasEngineVersion(narrowed.message)).toBe(false);
  });

  it("refuses an init that is missing any required field", () => {
    for (const broken of [
      { ...INIT, paths: { userData: "/u" } },
      { ...INIT, paths: undefined },
      { ...INIT, engine: { kind: "elsewhere", dir: "/e", bundlePath: "/e/b" } },
      { ...INIT, engine: { kind: "bundled", dir: "", bundlePath: "/e/b" } },
      { ...INIT, cwd: "" },
      { ...INIT, locale: undefined },
      { ...INIT, expectedVersion: "" },
    ]) {
      expect(narrowHostToCore(broken).ok, JSON.stringify(broken)).toBe(false);
    }
  });

  it("accepts a command with an id", () => {
    const narrowed = narrowHostToCore({
      kind: "command.invoke",
      callId: "call-1",
      call: { capability: "device.info", body: {} },
    });

    expect(narrowed.ok).toBe(true);
  });

  it("refuses a command without an id", () => {
    expect(
      narrowHostToCore({ kind: "command.invoke", call: { capability: "a", body: {} } }).ok,
    ).toBe(false);
  });

  it("accepts the three secret operations and pairs set with a value", () => {
    for (const op of SECURE_OPS) {
      const message =
        op === "set"
          ? { kind: "secure.request", requestId: "r", op, key: "k", value: "v" }
          : { kind: "secure.request", requestId: "r", op, key: "k" };

      expect(narrowHostToCore(message).ok, op).toBe(true);
    }

    expect(
      narrowHostToCore({ kind: "secure.request", requestId: "r", op: "set", key: "k" }).ok,
    ).toBe(false);
    expect(
      narrowHostToCore({
        kind: "secure.request",
        requestId: "r",
        op: "get",
        key: "k",
        value: "unused",
      }).ok,
    ).toBe(false);
    expect(
      narrowHostToCore({ kind: "secure.request", requestId: "r", op: "list", key: "k" }).ok,
    ).toBe(false);
  });

  it("accepts shutdown", () => {
    expect(narrowHostToCore({ kind: "shutdown" })).toEqual({
      ok: true,
      message: { kind: "shutdown" },
    });
  });

  it("refuses an unknown kind as a value, not as an exception", () => {
    const narrowed = narrowHostToCore({ kind: "command.list", callId: "x" });

    expect(narrowed.ok).toBe(false);
    expect(!narrowed.ok && narrowed.reason).toContain("unknown host-to-core kind");
    expect(() => narrowHostToCore("not a message")).not.toThrow();
    expect(narrowHostToCore(null).ok).toBe(false);
  });
});

describe("narrowCoreToHost", () => {
  it("accepts ready", () => {
    expect(narrowCoreToHost({ kind: "ready" })).toEqual({ ok: true, message: { kind: "ready" } });
  });

  it("accepts a frame on each known channel and refuses the rest", () => {
    for (const channel of FRAME_CHANNELS) {
      expect(narrowCoreToHost({ kind: "frame", channel, payload: "{}" }).ok, channel).toBe(true);
    }

    expect(narrowCoreToHost({ kind: "frame", channel: "data", payload: "{}" }).ok).toBe(false);
    expect(narrowCoreToHost({ kind: "frame", channel: "control" }).ok).toBe(false);
  });

  it("accepts a correlated reply only when it is a reply", () => {
    const answered = { ok: true, completion: "answered", data: { ok: true } };
    const accepted = { ok: true, completion: "accepted" };
    const failed = { ok: false, code: "TIMEOUT" };

    for (const reply of [answered, accepted, failed]) {
      expect(
        narrowCoreToHost({ kind: "command.reply", callId: "c", reply }).ok,
        JSON.stringify(reply),
      ).toBe(true);
      expect(isCommandReply(reply)).toBe(true);
    }

    expect(narrowCoreToHost({ kind: "command.reply", callId: "c", reply: { ok: true } }).ok).toBe(
      false,
    );
    expect(narrowCoreToHost({ kind: "command.reply", reply: failed }).ok).toBe(false);
  });

  it("accepts a secret reply with a value, one with an error, and an absent key", () => {
    expect(narrowCoreToHost({ kind: "secure.reply", requestId: "r", value: "v" }).ok).toBe(true);
    expect(narrowCoreToHost({ kind: "secure.reply", requestId: "r", error: "boom" }).ok).toBe(true);

    const absent = narrowCoreToHost({ kind: "secure.reply", requestId: "r" });

    expect(absent.ok).toBe(true);
    expect(absent.ok && "value" in absent.message).toBe(false);
    expect(
      narrowCoreToHost({ kind: "secure.reply", requestId: "r", value: "v", error: "e" }).ok,
    ).toBe(false);
  });

  it("accepts a status on each phase", () => {
    for (const phase of RUNTIME_PHASES) {
      const message =
        phase === "failed"
          ? { kind: "status", phase, failure: { kind: "start-failed", detail: "boom" } }
          : { kind: "status", phase, engineVersion: "1.0.0", cwd: "/w" };

      expect(narrowCoreToHost(message).ok, phase).toBe(true);
    }

    expect(narrowCoreToHost({ kind: "status", phase: "warming" }).ok).toBe(false);
    // A failed phase without a failure would render an empty page.
    expect(narrowCoreToHost({ kind: "status", phase: "failed" }).ok).toBe(false);
  });

  it("refuses a failure whose kind is not in the closed set", () => {
    expect(
      narrowCoreToHost({
        kind: "status",
        phase: "failed",
        failure: { kind: "exploded", detail: "boom" },
      }).ok,
    ).toBe(false);

    for (const kind of RUNTIME_FAILURE_KINDS) {
      expect(
        narrowCoreToHost({ kind: "status", phase: "failed", failure: { kind, detail: "d" } }).ok,
        kind,
      ).toBe(true);
    }
  });

  it("accepts a log line and refuses a non-string", () => {
    expect(narrowCoreToHost({ kind: "log", line: "starting" }).ok).toBe(true);
    expect(narrowCoreToHost({ kind: "log", line: 1 }).ok).toBe(false);
  });

  it("refuses an unknown kind as a value", () => {
    const narrowed = narrowCoreToHost({ kind: "frame.batch" });

    expect(narrowed.ok).toBe(false);
    expect(!narrowed.ok && narrowed.reason).toContain("unknown core-to-host kind");
    expect(isCoreToHost({ kind: "heartbeat" })).toBe(false);
    expect(narrowCoreToHost(undefined).ok).toBe(false);
  });
});
