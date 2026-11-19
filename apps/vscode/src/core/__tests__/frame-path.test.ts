/**
 * The core's frame outlet.
 *
 * Two properties are worth a test of their own, because nothing else can prove
 * them: the payload is serialized exactly once (so the string that leaves the
 * core is the string a byte comparison can pin), and a frame that cannot be
 * carried is refused instead of taking the pipe down with it.
 */

import type { Frame, FrameChannel } from "@haruyuki/protocol";
import { describe, expect, it, vi } from "vitest";

import type { CoreToHost } from "../ipc.js";
import type { CoreEngine } from "../main.js";
import { runCoreMain } from "../main.js";
import { createFrameOutlet, encodeFrame, frameMessage, type FrameSource } from "../frame-path.js";

/** A control frame with a body whose key order a re-encode would change. */
const STATE_FRAME: Frame<"state.loop"> = {
  v: 1,
  ch: "control",
  seq: 7,
  t: "state.loop",
  body: { zeta: 1, alpha: [2, 3], note: "a b" },
};

/** A stream frame, the shape terminal bytes travel in. */
const STREAM_FRAME: Frame<"term.output"> = {
  v: 1,
  ch: "stream",
  seq: 8,
  t: "term.output",
  body: { terminal_id: "t1", text: "hi", final: true },
};

/** A source a test drives by hand, recording how often it was subscribed. */
type Rig = {
  readonly source: FrameSource;
  readonly counts: { subscriptions: number; offs: number };
  emit(channel: FrameChannel, frame: Frame): void;
};

/**
 * Build a frame source whose listener a test can push frames into.
 *
 * @returns the source and the counters the assertions read
 */
function createRig(): Rig {
  const listeners = new Set<(channel: FrameChannel, frame: Frame) => void>();
  const counts = { subscriptions: 0, offs: 0 };
  const rig: Rig = {
    counts,
    source: {
      onFrame(callback) {
        counts.subscriptions += 1;
        listeners.add(callback);

        return () => {
          counts.offs += 1;
          listeners.delete(callback);
        };
      },
    },
    emit(channel, frame) {
      for (const listener of [...listeners]) listener(channel, frame);
    },
  };

  return rig;
}

describe("encodeFrame", () => {
  it("serializes once into the exact JSON text for the frame", () => {
    const encoded = encodeFrame(STATE_FRAME);

    expect(encoded).toEqual({ ok: true, payload: JSON.stringify(STATE_FRAME) });
  });

  it("refuses a frame that is not carryable instead of throwing", () => {
    const cyclic: Frame = { v: 1, ch: "control", seq: 0, t: "state.loop", body: {} };
    (cyclic.body as Record<string, unknown>).self = cyclic;

    expect(encodeFrame(cyclic)).toEqual({ ok: false, reason: "the frame is not a JSON value" });

    const bigint: Frame = { v: 1, ch: "control", seq: 0, t: "state.loop", body: { n: 1n } };

    expect(encodeFrame(bigint)).toMatchObject({ ok: false });

    const instance: Frame = {
      v: 1,
      ch: "control",
      seq: 0,
      t: "state.loop",
      body: { at: new Date(0) },
    };

    expect(encodeFrame(instance)).toMatchObject({ ok: false });
  });
});

describe("frameMessage", () => {
  it("wraps the payload as a pipe message on the frame's own channel", () => {
    expect(frameMessage("stream", STREAM_FRAME)).toEqual({
      ok: true,
      message: {
        kind: "frame",
        channel: "stream",
        payload: JSON.stringify(STREAM_FRAME),
      },
    });
  });

  it("refuses a frame whose route disagrees with its own channel", () => {
    // Delivering a control frame on the stream route would make the renderer read
    // a snapshot as terminal bytes, so the disagreement is refused, not fixed up.
    expect(frameMessage("stream", STATE_FRAME)).toEqual({
      ok: false,
      reason: "the frame route stream disagrees with its channel control",
    });
  });
});

describe("createFrameOutlet", () => {
  it("subscribes to the source once, however many listeners arrive", () => {
    const rig = createRig();
    const outlet = createFrameOutlet(rig.source);

    outlet.onFrame(() => undefined);
    outlet.onFrame(() => undefined);

    expect(rig.counts.subscriptions).toBe(1);
  });

  it("hands every listener the serialized payload, not the frame", () => {
    const rig = createRig();
    const outlet = createFrameOutlet(rig.source);
    const seen: { channel: FrameChannel; payload: string }[] = [];

    outlet.onFrame((channel, payload) => {
      seen.push({ channel, payload });
    });

    rig.emit("control", STATE_FRAME);

    expect(seen).toEqual([{ channel: "control", payload: JSON.stringify(STATE_FRAME) }]);
  });

  it("unsubscribes a listener once and leaves the others connected", () => {
    const rig = createRig();
    const outlet = createFrameOutlet(rig.source);
    const first: string[] = [];
    const second: string[] = [];

    const off = outlet.onFrame((_channel, payload) => first.push(payload));

    outlet.onFrame((_channel, payload) => second.push(payload));

    off();
    off();

    rig.emit("stream", STREAM_FRAME);

    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
  });

  it("keeps the remaining listeners when one throws", () => {
    const rig = createRig();
    const log = vi.fn();
    const outlet = createFrameOutlet(rig.source, log);
    const kept: string[] = [];

    outlet.onFrame(() => {
      throw new Error("the pipe is closed");
    });
    outlet.onFrame((_channel, payload) => kept.push(payload));

    rig.emit("control", STATE_FRAME);

    expect(kept).toEqual([JSON.stringify(STATE_FRAME)]);
    expect(log).toHaveBeenCalledWith("CORE_FRAME_LISTENER_FAILED", { channel: "control" });
  });

  it("logs a refused frame instead of delivering it", () => {
    const rig = createRig();
    const log = vi.fn();
    const outlet = createFrameOutlet(rig.source, log);
    const seen: string[] = [];

    outlet.onFrame((_channel, payload) => seen.push(payload));

    rig.emit("control", { v: 1, ch: "stream", seq: 0, t: "state.loop", body: {} });

    expect(seen).toEqual([]);
    expect(log).toHaveBeenCalledWith("CORE_FRAME_REFUSED", {
      channel: "control",
      reason: "the frame route control disagrees with its channel stream",
    });
  });

  it("delivers nothing after dispose and disposes only once", () => {
    const rig = createRig();
    const outlet = createFrameOutlet(rig.source);
    const seen: string[] = [];

    outlet.onFrame((_channel, payload) => seen.push(payload));
    outlet.dispose();
    outlet.dispose();

    rig.emit("control", STATE_FRAME);

    expect(seen).toEqual([]);
    expect(rig.counts.offs).toBe(1);
  });

  it("returns an inert subscription once disposed", () => {
    const rig = createRig();
    const outlet = createFrameOutlet(rig.source);

    outlet.dispose();

    const off = outlet.onFrame(() => undefined);

    expect(typeof off).toBe("function");
    expect(rig.counts.subscriptions).toBe(0);
    off();
  });
});

describe("the outlet as the child lifecycle's engine seam", () => {
  it("carries the serialized payload into the pipe unchanged", async () => {
    // The lifecycle subscribes to `engine.onFrame` and forwards whatever it
    // hands back as the `frame` message. Assigning the outlet's own `onFrame`
    // there is the wiring the composition root does, so this is also a check
    // that the two signatures still fit each other.
    const rig = createRig();
    const outlet = createFrameOutlet(rig.source);
    const sent: CoreToHost[] = [];
    let deliver: (message: unknown) => void = () => undefined;
    let exit: () => void = () => undefined;

    const engine: CoreEngine = {
      async stop() {},
      onFrame: outlet.onFrame,
    };

    runCoreMain({
      startEngine: async () => engine,
      transport: {
        send(message) {
          sent.push(message);
        },
        onMessage(listener) {
          deliver = listener;

          return () => undefined;
        },
        onDisconnect() {
          return () => undefined;
        },
        ppid() {
          return 1;
        },
        parentAlive() {
          return true;
        },
        exit() {
          exit();
        },
      },
    });

    deliver({
      kind: "init",
      paths: { userData: "/u", logs: "/l", cache: "/c", temp: "/t" },
      cwd: "/work",
      locale: "en",
      engine: { kind: "bundled", dir: "/engine", bundlePath: "/engine/haruyuki.js" },
      expectedVersion: "1.0.0",
      capabilities: {
        canNotify: false,
        canPopout: false,
        canFloat: false,
        canOpenExternal: false,
        canPickFiles: false,
        canReadDroppedFiles: false,
      },
    });

    // Past `ready`, the lifecycle has subscribed to the engine.
    await vi.waitFor(() => {
      expect(sent.some((message) => message.kind === "ready")).toBe(true);
    });

    rig.emit("control", STATE_FRAME);

    const frames = sent.filter((message) => message.kind === "frame");

    expect(frames).toEqual([
      { kind: "frame", channel: "control", payload: JSON.stringify(STATE_FRAME) },
    ]);

    exit();
    outlet.dispose();
  });
});
