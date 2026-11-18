/**
 * The extension host's frame and command path.
 *
 * These tests are written against fake ports and a recording outbox, because the
 * properties under test are this module's own decisions: a frame's payload is
 * carried byte for byte, one panel command gets exactly one answer, and an
 * in-flight command is settled even when the port never answers.
 *
 * The malformed-payload case is the load-bearing one. The payload used there is
 * deliberately not valid JSON, so a host that parsed it would throw instead of
 * forwarding it; the assertion is on the exact string, not on a decoded shape.
 */

import type { CommandCall, CommandReply } from "@haruyuki/core";
import type { FrameChannel } from "@haruyuki/protocol";
import { describe, expect, it, vi } from "vitest";

import type { CoreFrame } from "../../core/ipc.js";
import {
  createCommandPath,
  createFrameForwarder,
  createOutbox,
  type CommandPort,
  type FramePort,
  type HostToWebview,
} from "../command-path.js";

/**
 * A payload no JSON parser accepts: a truncated object, a raw control character
 * and a quote that is never closed. Any host-side `JSON.parse` throws on it.
 */
const MALFORMED = '{"v":1,"ch":"control","seq":3,"t":"state.loop","body":{"x":"\u0000\u0007\n';

/** A well-formed payload, used where the content is not the point. */
const WELL_FORMED = JSON.stringify({ v: 1, ch: "stream", seq: 4, t: "term.output", body: {} });

/** A device-wide command, the shape a panel sends most often. */
const DEVICE_INFO: CommandCall = { capability: "device.info", body: {} };

/** A recording panel: every message the host posts, in order. */
type Recorder = {
  readonly post: (message: HostToWebview) => void;
  readonly sent: HostToWebview[];
};

/**
 * Build the post function a panel would provide.
 *
 * @returns the post function and the messages it received
 */
function createRecorder(): Recorder {
  const sent: HostToWebview[] = [];

  return {
    sent,
    post(message) {
      sent.push(message);
    },
  };
}

/** A command port whose answer each test controls. */
type CommandRig = {
  readonly port: CommandPort;
  readonly calls: CommandCall[];
  /** Answer the oldest unanswered call. */
  answer(reply: CommandReply): void;
  /** Answer the Nth still-unanswered call, counting from zero. */
  answerAt(index: number, reply: CommandReply): void;
  fail(error: Error): void;
};

/**
 * Build a command port that answers on demand, in whatever order a test picks.
 *
 * @returns the port, the forwarded calls, and the ways to settle them
 */
function createCommandRig(): CommandRig {
  const calls: CommandCall[] = [];
  const waiters: { resolve: (reply: CommandReply) => void; reject: (error: Error) => void }[] = [];

  return {
    calls,
    port: {
      invoke(call) {
        calls.push(call);

        return new Promise<CommandReply>((resolve, reject) => {
          waiters.push({ resolve, reject });
        });
      },
    },
    answer(reply) {
      for (const waiter of waiters.splice(0)) waiter.resolve(reply);
    },
    answerAt(index, reply) {
      const [waiter] = waiters.splice(index, 1);

      waiter?.resolve(reply);
    },
    fail(error) {
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    },
  };
}

/** A frame port a test can push frames into. */
function createFrameRig(): {
  readonly port: FramePort;
  emit(frame: CoreFrame): void;
  readonly counts: { offs: number };
} {
  const listeners = new Set<(frame: CoreFrame) => void>();
  const counts = { offs: 0 };

  return {
    counts,
    port: {
      onFrame(callback) {
        listeners.add(callback);

        return () => {
          counts.offs += 1;
          listeners.delete(callback);
        };
      },
    },
    emit(frame) {
      for (const listener of [...listeners]) listener(frame);
    },
  };
}

/** @returns an answered reply carrying one capability name */
function answered(capability: string): CommandReply {
  return { ok: true, completion: "answered", data: { capability } };
}

describe("the core -> host -> webview frame direction", () => {
  it("carries a payload that is not valid JSON, byte for byte", () => {
    const recorder = createRecorder();
    const rig = createFrameRig();
    const outbox = createOutbox(recorder.post);

    createFrameForwarder({ host: rig.port, outbox });

    // A host that parsed the payload would throw here rather than forward it.
    expect(() => {
      JSON.parse(MALFORMED);
    }).toThrow();

    rig.emit({ kind: "frame", channel: "control", payload: MALFORMED });

    expect(recorder.sent).toEqual([{ kind: "frame", channel: "control", payload: MALFORMED }]);

    // Not merely equal after decoding: the same string, character for character.
    const delivered = recorder.sent[0];

    expect(delivered?.kind === "frame" ? delivered.payload : "").toBe(MALFORMED);
    expect([...(delivered?.kind === "frame" ? delivered.payload : "")]).toEqual([...MALFORMED]);
  });

  it("does not re-encode a well-formed payload with a non-canonical key order", () => {
    const recorder = createRecorder();
    const rig = createFrameRig();
    const outbox = createOutbox(recorder.post);

    createFrameForwarder({ host: rig.port, outbox });

    // Key order and spacing a `JSON.stringify(JSON.parse(...))` would change.
    const spaced = '{ "seq" : 1,\n  "v":1, "ch":"control", "t":"state.loop", "body":{} }';

    rig.emit({ kind: "frame", channel: "control", payload: spaced });

    expect(recorder.sent).toEqual([{ kind: "frame", channel: "control", payload: spaced }]);
  });

  it("keeps the frame's channel and never reads the payload to learn it", () => {
    const recorder = createRecorder();
    const rig = createFrameRig();
    const outbox = createOutbox(recorder.post);

    createFrameForwarder({ host: rig.port, outbox });

    // The payload claims one channel; the envelope another. The envelope wins,
    // because the payload is not inspected at all.
    rig.emit({ kind: "frame", channel: "bulk", payload: '{"ch":"stream"}' });

    expect(recorder.sent).toEqual([{ kind: "frame", channel: "bulk", payload: '{"ch":"stream"}' }]);
  });

  it("stops forwarding after dispose and disposes only once", () => {
    const recorder = createRecorder();
    const rig = createFrameRig();
    const outbox = createOutbox(recorder.post);
    const forwarder = createFrameForwarder({ host: rig.port, outbox });

    forwarder.dispose();
    forwarder.dispose();

    rig.emit({ kind: "frame", channel: "stream", payload: WELL_FORMED });

    expect(recorder.sent).toEqual([]);
    expect(rig.counts.offs).toBe(1);
  });

  it("logs a panel that refuses a message instead of throwing", () => {
    const log = vi.fn();
    const outbox = createOutbox(() => {
      throw new Error("the panel is disposed");
    }, log);

    outbox.postFrame("control", WELL_FORMED);

    expect(log).toHaveBeenCalledWith("HOST_WEBVIEW_POST_FAILED", { label: "frame" });
  });
});

describe("the webview -> host -> core command direction", () => {
  it("answers an invocation with the core's reply, correlated by the panel's id", async () => {
    const recorder = createRecorder();
    const command = createCommandRig();
    const path = createCommandPath({ host: command.port, outbox: createOutbox(recorder.post) });

    expect(path.receive({ kind: "command.invoke", callId: "wv-1", call: DEVICE_INFO })).toEqual({
      ok: true,
      handled: "command",
    });

    expect(command.calls).toEqual([DEVICE_INFO]);

    command.answer(answered("device.info"));

    await vi.waitFor(() => {
      expect(recorder.sent).toEqual([
        { kind: "command.reply", callId: "wv-1", reply: answered("device.info") },
      ]);
    });
  });

  it("answers every failure arm without rejecting", async () => {
    const recorder = createRecorder();
    const command = createCommandRig();
    const path = createCommandPath({ host: command.port, outbox: createOutbox(recorder.post) });

    // one-way: accepted, then a refusal from the layer
    path.receive({ kind: "command.invoke", callId: "wv-1", call: DEVICE_INFO });
    path.receive({ kind: "command.invoke", callId: "wv-2", call: DEVICE_INFO });

    command.answerAt(0, { ok: true, completion: "accepted" });
    command.answerAt(0, { ok: false, code: "COMMAND_SCOPE_REQUIRED" });

    await vi.waitFor(() => {
      expect(recorder.sent).toEqual([
        { kind: "command.reply", callId: "wv-1", reply: { ok: true, completion: "accepted" } },
        {
          kind: "command.reply",
          callId: "wv-2",
          reply: { ok: false, code: "COMMAND_SCOPE_REQUIRED" },
        },
      ]);
    });
  });

  it("turns a port that rejects into a failed reply", async () => {
    const recorder = createRecorder();
    const command = createCommandRig();
    const path = createCommandPath({ host: command.port, outbox: createOutbox(recorder.post) });

    path.receive({ kind: "command.invoke", callId: "wv-1", call: DEVICE_INFO });
    command.fail(new Error("the pipe is closed"));

    await vi.waitFor(() => {
      expect(recorder.sent).toEqual([
        {
          kind: "command.reply",
          callId: "wv-1",
          reply: { ok: false, code: "REJECTED", detail: "the pipe is closed" },
        },
      ]);
    });
  });

  it("settles a command the core never answers, instead of hanging", async () => {
    vi.useFakeTimers();

    try {
      const recorder = createRecorder();
      const command = createCommandRig();
      const path = createCommandPath({
        host: command.port,
        outbox: createOutbox(recorder.post),
        replyTimeoutMs: 50,
      });

      path.receive({ kind: "command.invoke", callId: "wv-1", call: DEVICE_INFO });

      expect(path.pending).toBe(1);

      await vi.advanceTimersByTimeAsync(60);

      expect(recorder.sent).toEqual([
        {
          kind: "command.reply",
          callId: "wv-1",
          reply: { ok: false, code: "TIMEOUT", detail: "no command reply within 50 ms" },
        },
      ]);
      expect(path.pending).toBe(0);

      // A late answer from the core must not produce a second reply.
      command.answer(answered("device.info"));

      await vi.advanceTimersByTimeAsync(10);

      expect(recorder.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not confuse two concurrent calls that share one capability", async () => {
    const recorder = createRecorder();
    const command = createCommandRig();
    const path = createCommandPath({ host: command.port, outbox: createOutbox(recorder.post) });

    path.receive({ kind: "command.invoke", callId: "wv-a", call: DEVICE_INFO });
    path.receive({ kind: "command.invoke", callId: "wv-b", call: DEVICE_INFO });
    path.receive({ kind: "command.invoke", callId: "wv-c", call: DEVICE_INFO });

    expect(path.pending).toBe(3);

    // Answers arrive out of order, which is the case a shared counter would break.
    command.answerAt(1, answered("b"));
    command.answerAt(0, answered("a"));
    command.answerAt(0, answered("c"));

    await vi.waitFor(() => {
      expect(recorder.sent).toEqual([
        { kind: "command.reply", callId: "wv-b", reply: answered("b") },
        { kind: "command.reply", callId: "wv-a", reply: answered("a") },
        { kind: "command.reply", callId: "wv-c", reply: answered("c") },
      ]);
    });

    expect(path.pending).toBe(0);
  });

  it("refuses a second command on an id that is still in flight", () => {
    const recorder = createRecorder();
    const command = createCommandRig();
    const log = vi.fn();
    const path = createCommandPath({
      host: command.port,
      outbox: createOutbox(recorder.post),
      log,
    });

    path.receive({ kind: "command.invoke", callId: "wv-1", call: DEVICE_INFO });

    // A duplicate id would make the single reply ambiguous, and the log line is
    // the only evidence the second request existed.
    expect(path.receive({ kind: "command.invoke", callId: "wv-1", call: DEVICE_INFO })).toEqual({
      ok: false,
      reason: 'the callId "wv-1" is already in flight',
    });

    expect(command.calls).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("HOST_COMMAND_REFUSED", {
      code: "REJECTED",
      detail: 'the callId "wv-1" is already in flight',
    });
  });

  it("leaves a message another module owns alone", () => {
    const recorder = createRecorder();
    const command = createCommandRig();
    const path = createCommandPath({ host: command.port, outbox: createOutbox(recorder.post) });

    expect(path.receive({ kind: "ready", appVersion: "1.0.0", bridgeVersion: "1" })).toEqual({
      ok: true,
      handled: "ignored",
    });
    expect(path.receive("a string, not a message")).toEqual({ ok: true, handled: "ignored" });

    expect(command.calls).toEqual([]);
    expect(recorder.sent).toEqual([]);
  });

  it("refuses a malformed invocation without forwarding it", () => {
    const recorder = createRecorder();
    const command = createCommandRig();
    const path = createCommandPath({ host: command.port, outbox: createOutbox(recorder.post) });

    // `{}` is deliberately absent: a message with no `kind` belongs to no
    // module in particular, which the previous case covers.
    const cases: unknown[] = [
      { kind: "command.invoke", call: DEVICE_INFO, callId: 7 },
      { kind: "command.invoke", callId: "wv-1", call: { capability: "", body: {} } },
      { kind: "command.invoke", callId: "wv-1", call: { capability: "device.info", body: 3 } },
      { kind: "command.invoke", callId: "wv-1" },
    ];

    for (const candidate of cases) {
      expect(path.receive(candidate)).toMatchObject({ ok: false });
    }

    expect(command.calls).toEqual([]);
    expect(path.pending).toBe(0);
  });

  it("mints an id for a command that carried none, and echoes it back", async () => {
    const recorder = createRecorder();
    const command = createCommandRig();
    const path = createCommandPath({ host: command.port, outbox: createOutbox(recorder.post) });

    // An absent id is not a malformed message: the panel said nothing to echo
    // back, so the host mints one rather than dropping a legitimate command.
    expect(path.receive({ kind: "command.invoke", call: DEVICE_INFO })).toEqual({
      ok: true,
      handled: "command",
    });

    command.answer(answered("device.info"));

    await vi.waitFor(() => {
      expect(recorder.sent).toHaveLength(1);
    });

    const reply = recorder.sent[0];

    expect(reply?.kind === "command.reply" ? reply.callId : "").toMatch(/^host-/);
  });

  it("refuses a callId that is too long for the panel leg", () => {
    const recorder = createRecorder();
    const command = createCommandRig();
    const path = createCommandPath({ host: command.port, outbox: createOutbox(recorder.post) });

    const long = "w".repeat(129);

    expect(path.receive({ kind: "command.invoke", callId: long, call: DEVICE_INFO })).toEqual({
      ok: false,
      reason: "the callId exceeds 128 characters",
    });
    expect(path.receive({ kind: "command.invoke", callId: "", call: DEVICE_INFO })).toMatchObject({
      ok: false,
    });
    expect(command.calls).toEqual([]);
  });

  it("settles in-flight commands when disposed, and ignores anything later", async () => {
    const recorder = createRecorder();
    const command = createCommandRig();
    const path = createCommandPath({ host: command.port, outbox: createOutbox(recorder.post) });

    path.receive({ kind: "command.invoke", callId: "wv-1", call: DEVICE_INFO });

    expect(path.pending).toBe(1);

    path.dispose();
    path.dispose();

    expect(path.pending).toBe(0);
    expect(recorder.sent).toEqual([]);

    command.answer(answered("device.info"));

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(recorder.sent).toEqual([]);
    expect(path.receive({ kind: "command.invoke", callId: "wv-2", call: DEVICE_INFO })).toEqual({
      ok: false,
      reason: "the command path is disposed",
    });
  });
});

describe("the two directions together", () => {
  it("carries frames and commands without either one reading the other's payload", async () => {
    const recorder = createRecorder();
    const command = createCommandRig();
    const frames = createFrameRig();
    const outbox = createOutbox(recorder.post);

    createFrameForwarder({ host: frames.port, outbox });

    const path = createCommandPath({ host: command.port, outbox });

    frames.emit({ kind: "frame", channel: "stream", payload: MALFORMED });

    path.receive({ kind: "command.invoke", callId: "wv-1", call: DEVICE_INFO });

    command.answer(answered("device.info"));

    await vi.waitFor(() => {
      expect(recorder.sent).toEqual([
        { kind: "frame", channel: "stream", payload: MALFORMED },
        { kind: "command.reply", callId: "wv-1", reply: answered("device.info") },
      ]);
    });
  });
});
