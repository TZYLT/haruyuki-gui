import { createSessionStore } from "@haruyuki/core";
import type { MergerChange } from "@haruyuki/core";
import type { ControlFrame, Frame, SessionViewBody } from "@haruyuki/protocol";
import { describe, expect, it, vi } from "vitest";

import { createSessionWiring } from "../wiring.js";

/** A recording bridge sink; the shell's own `host.send` in production. */
function createSink(): { frames: Frame[]; send: (frame: Frame) => void } {
  const frames: Frame[] = [];

  return {
    frames,
    send: (frame) => {
      frames.push(frame);
    },
  };
}

/** One subscribe request, serialized the way the renderer sends it. */
function subscribePayload(
  instanceId = "tab-1",
  selector = "entity.agents",
  reqId = "req-1",
): string {
  return JSON.stringify({
    v: 1,
    ch: "control",
    seq: 0,
    t: "session.subscribe",
    body: { instanceId, selector, params: {}, active: true },
    reqId,
  });
}

/** One merged change, in the shape the event merger hands the command service. */
const CHANGE: MergerChange = {
  authorAgentId: "a1",
  runtimeAgentId: "a1",
  subagentId: null,
  conversationId: "c1",
  at: 1_700_000_000_000,
  kind: "message.complete",
  messageId: "m1",
  runId: null,
  textLength: 2,
  incomplete: false,
};

describe("createSessionWiring", () => {
  it("turns one session.subscribe into one session.view, and consumes the request", () => {
    const store = createSessionStore();
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    const consumed = wiring.onControlFrame(subscribePayload());

    expect(consumed).toBe(true);
    expect(sink.frames).toHaveLength(1);

    const frame = sink.frames[0] as ControlFrame<"session.view", SessionViewBody>;

    expect(frame.t).toBe("session.view");
    expect(frame.ch).toBe("control");
    expect(frame.body.instanceId).toBe("tab-1");
    expect(frame.body.selector).toBe("entity.agents");
    expect(frame.reqId).toBe("req-1");
  });

  it("hands an unrecognised frame back instead of consuming it", () => {
    const store = createSessionStore();
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    const ready = JSON.stringify({
      v: 1,
      ch: "control",
      seq: 0,
      t: "bridge.ready",
      body: { appVersion: "0.1.0", bridgeVersion: "1" },
    });

    expect(wiring.onControlFrame(ready)).toBe(false);
    expect(wiring.onControlFrame("not json")).toBe(false);
    expect(sink.frames).toHaveLength(0);
  });

  it("answers a session.select with a correlated session.result", () => {
    const store = createSessionStore();
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    const consumed = wiring.onControlFrame(
      JSON.stringify({
        v: 1,
        ch: "control",
        seq: 0,
        t: "session.select",
        body: { instanceId: "tab-1", selector: "entity.agents", params: {} },
        reqId: "req-9",
      }),
    );

    expect(consumed).toBe(true);

    const frame = sink.frames[0] as ControlFrame<"session.result", { ok: boolean }>;

    expect(frame.t).toBe("session.result");
    expect(frame.reqId).toBe("req-9");
    expect(frame.body.ok).toBe(true);
  });

  it("answers an unknown selector with the refusal arm rather than throwing", () => {
    const store = createSessionStore();
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    wiring.onControlFrame(
      JSON.stringify({
        v: 1,
        ch: "control",
        seq: 0,
        t: "session.select",
        body: { instanceId: "tab-1", selector: "view.nothing", params: {} },
        reqId: "req-10",
      }),
    );

    const frame = sink.frames[0] as ControlFrame<"session.result", { ok: false; code: string }>;

    expect(frame.body.ok).toBe(false);
    expect(frame.body.code).toBe("SESSION_UNKNOWN_SELECTOR");
  });

  it("answers a session.select that names no instance, because a select is one-shot", () => {
    const store = createSessionStore();
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    const consumed = wiring.onControlFrame(
      JSON.stringify({
        v: 1,
        ch: "control",
        seq: 0,
        t: "session.select",
        body: { selector: "entity.agents", params: {} },
        reqId: "req-11",
      }),
    );

    expect(consumed).toBe(true);

    const frame = sink.frames[0] as ControlFrame<"session.result", { ok: boolean }>;

    expect(frame.t).toBe("session.result");
    expect(frame.body.ok).toBe(true);
  });

  it("refuses a session.select with no selector at all", () => {
    const store = createSessionStore();
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    wiring.onControlFrame(
      JSON.stringify({
        v: 1,
        ch: "control",
        seq: 0,
        t: "session.select",
        body: { instanceId: "tab-1", params: {} },
        reqId: "req-12",
      }),
    );

    const frame = sink.frames[0] as ControlFrame<"session.result", { ok: false; code: string }>;

    expect(frame.body).toEqual({ ok: false, selector: "", code: "SESSION_BAD_PARAMS" });
  });

  it("stops pushing for an unsubscribed instance", () => {
    const store = createSessionStore();
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    wiring.onControlFrame(subscribePayload());
    const afterSubscribe = sink.frames.length;

    wiring.onControlFrame(
      JSON.stringify({
        v: 1,
        ch: "control",
        seq: 0,
        t: "session.unsubscribe",
        body: { instanceId: "tab-1", selector: "entity.agents", params: {} },
        reqId: "req-2",
      }),
    );
    wiring.onMergerChange(CHANGE);

    expect(sink.frames.length).toBe(afterSubscribe);
  });

  it("feeds one merged change to the store's ingest", () => {
    const store = createSessionStore();
    const ingest = vi.spyOn(store, "ingest");
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    wiring.onMergerChange(CHANGE);

    expect(ingest).toHaveBeenCalledWith(CHANGE);
    expect(store.stats().ingestCount).toBe(1);
  });

  it("pushes a fresh session.view when the subscribed value moves", () => {
    const store = createSessionStore();
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    wiring.onControlFrame(subscribePayload());
    expect(sink.frames).toHaveLength(1);

    // A page of agents arrives the way the shell feeds it; the subscribed
    // selector reads that collection, so the push half has to answer it.
    store.ingestAgents([{ id: "a1", name: "Agent one" }]);

    expect(sink.frames.length).toBeGreaterThan(1);

    const pushed = sink.frames.at(-1) as ControlFrame<"session.view", SessionViewBody>;

    expect(pushed.t).toBe("session.view");
    expect(pushed.body.epoch).toBe(store.stats().epoch);
    expect(JSON.stringify(pushed.body.value)).toContain("a1");
  });

  it("releases every subscription on dispose and pushes nothing afterwards", () => {
    const store = createSessionStore();
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    wiring.onControlFrame(subscribePayload());
    const afterSubscribe = sink.frames.length;

    wiring.dispose();
    wiring.onMergerChange(CHANGE);

    expect(store.stats().subscriptions).toBe(0);
    expect(sink.frames.length).toBe(afterSubscribe);
  });
});
