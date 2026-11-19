import { createSessionStore } from "@haruyuki/core";
import type { MergerChange } from "@haruyuki/core";
import type { ControlFrame, Frame, SessionViewBody } from "@haruyuki/protocol";
import { describe, expect, it, vi } from "vitest";

import { VIEW_FRAME_LIMIT_BYTES, createSessionWiring } from "../wiring.js";

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

/** The size the bridge would actually carry for one frame, in UTF-8 bytes. */
function bytesOf(frame: Frame): number {
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}

/** Every `session.view` frame the sink received. */
function pushedViews(frames: readonly Frame[]): ControlFrame<"session.view", SessionViewBody>[] {
  return frames.filter(
    (frame): frame is ControlFrame<"session.view", SessionViewBody> => frame.t === "session.view",
  );
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

  it("keeps a content-sized selector off the push path and answers it in full on demand", () => {
    const store = createSessionStore();
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    // One turn, then the blocks of it: the shape that made the old advice
    // ("no view is large") wrong. 400 blocks of ordinary prose, which is what a
    // long tool-use turn actually holds.
    wiring.onMergerChange({
      ...CHANGE,
      kind: "message.delta",
      messageId: "m1",
      runId: "run-1",
      runSeq: 1,
      text: "opening the turn",
      parts: [],
      first: true,
    });
    store.ingestContent("c1", {
      messageId: "m1",
      upserts: Array.from({ length: 400 }, (_, index) => ({
        id: `b-${index}`,
        text: `block ${index} `.padEnd(112, "x"),
      })),
      removes: [],
    });

    const turnRef = [...store.getSnapshot().turns.keys()][0] as string;

    // A small subscription in the same sink, so "every pushed frame fits" is a
    // statement about frames that were actually sent rather than a rule that
    // held because nothing was sent at all.
    wiring.onControlFrame(
      JSON.stringify({
        v: 1,
        ch: "control",
        seq: 0,
        t: "session.subscribe",
        body: {
          instanceId: "tab-context",
          selector: "view.context",
          params: { conversationId: "c1" },
          active: true,
        },
        reqId: "req-context",
      }),
    );

    wiring.onControlFrame(
      JSON.stringify({
        v: 1,
        ch: "control",
        seq: 0,
        t: "session.subscribe",
        body: {
          instanceId: "tab-blocks",
          selector: "entity.blocks",
          params: { turnRef },
          active: true,
        },
        reqId: "req-1",
      }),
    );

    const views = pushedViews(sink.frames);
    const sizes = views.map(bytesOf);
    const wouldBe = bytesOf({
      v: 1,
      ch: "control",
      seq: 0,
      t: "session.view",
      body: {
        ...store.select({ instanceId: "", selector: "entity.blocks", params: { turnRef } }),
        instanceId: "tab-blocks",
      },
      reqId: "req-1",
    } as Frame);

    console.log(
      `entity.blocks over 400 blocks: would-be push ${wouldBe} B; ` +
        `pushed ${views.length} frame(s), sizes ${sizes.join(", ") || "none"}`,
    );

    // The frame that must not go out is the one this construction would have
    // produced: over the limit, and a block push was withheld.
    expect(wouldBe).toBeGreaterThan(VIEW_FRAME_LIMIT_BYTES);
    expect(views.some((view) => view.body.selector === "entity.blocks")).toBe(false);

    // The gate did not silence the subscription next to it.
    expect(views.length).toBeGreaterThan(0);
    expect(sizes.every((bytes) => bytes <= VIEW_FRAME_LIMIT_BYTES)).toBe(true);

    // Nothing was withheld from the reader: the one-shot answer is complete.
    const selected = store.select({
      instanceId: "",
      selector: "entity.blocks",
      params: { turnRef },
    });
    const blocks = selected.value as readonly unknown[];

    console.log(`entity.blocks via session.select: ${blocks.length} rows`);
    expect(blocks).toHaveLength(400);
  });

  it("withholds a push whose frame would be over the control channel limit", () => {
    const store = createSessionStore();
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    // A list selector with no shape-level ceiling: a page may legitimately
    // subscribe to it, and how much it returns depends on the session, not on the
    // page. This is the measurement doing the work, with nothing to fall back on.
    store.ingestAgents(
      Array.from({ length: 400 }, (_, index) => ({
        id: `a-${index}`,
        name: `Agent ${index}`,
        description: `agent ${index} `.padEnd(190, "y"),
      })),
    );

    wiring.onControlFrame(subscribePayload("tab-agents", "entity.agents", "req-1"));

    const views = pushedViews(sink.frames);
    const wouldBe = bytesOf({
      v: 1,
      ch: "control",
      seq: 0,
      t: "session.view",
      body: {
        ...store.select({ instanceId: "", selector: "entity.agents", params: {} }),
        instanceId: "tab-agents",
      },
      reqId: "req-1",
    } as Frame);

    console.log(`entity.agents over 400 rows: would-be push ${wouldBe} B, sent ${views.length}`);

    // The value is legitimate; only its size is not. Nothing was shortened.
    expect(wouldBe).toBeGreaterThan(VIEW_FRAME_LIMIT_BYTES);
    expect(views).toHaveLength(0);
    expect(
      store.select({ instanceId: "", selector: "entity.agents", params: {} }).value,
    ).toHaveLength(400);
  });

  it("still pushes a small result, and keeps every pushed frame inside the limit", () => {
    const store = createSessionStore();
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    store.ingestAgents([{ id: "a1", name: "Agent one", description: "the only one" }]);

    wiring.onControlFrame(subscribePayload("tab-agent", "entity.agent", "req-agent"));
    wiring.onControlFrame(
      JSON.stringify({
        v: 1,
        ch: "control",
        seq: 0,
        t: "session.subscribe",
        body: {
          instanceId: "tab-context",
          selector: "view.context",
          params: { conversationId: "c1" },
          active: true,
        },
        reqId: "req-context",
      }),
    );

    const views = pushedViews(sink.frames);
    const sizes = views.map(bytesOf);

    console.log(`small results pushed: ${sizes.length} frame(s), bytes ${sizes.join(", ")}`);

    expect(views).toHaveLength(2);
    expect(sizes.every((bytes) => bytes <= VIEW_FRAME_LIMIT_BYTES)).toBe(true);
    expect(views.map((view) => view.body.selector)).toEqual(["entity.agent", "view.context"]);
  });

  it.each([
    ["not an object at all", null],
    ["a bare string", "a string"],
    ["a number", 42],
    ["an array", [1, 2]],
  ])("answers a session.select whose body is %s instead of leaving it waiting", (_label, body) => {
    const store = createSessionStore();
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    const consumed = wiring.onControlFrame(
      JSON.stringify({ v: 1, ch: "control", seq: 0, t: "session.select", body, reqId: "req-bad" }),
    );

    // Consumed, so the request is not echoed back as a frame nobody decodes...
    expect(consumed).toBe(true);

    // ...and answered, because the caller is waiting on this correlation id.
    // Consuming without answering would leave that wait open for the page's
    // whole life, which is worse than a refusal.
    const frame = sink.frames[0] as ControlFrame<"session.result", { ok: boolean; code: string }>;

    expect(sink.frames).toHaveLength(1);
    expect(frame.reqId).toBe("req-bad");
    expect(frame.body.ok).toBe(false);
    expect(frame.body.code).toBe("SESSION_BAD_PARAMS");
  });

  it("answers nothing for a subscribe or an unsubscribe whose body is unusable", () => {
    const store = createSessionStore();
    const sink = createSink();
    const wiring = createSessionWiring({ store, send: sink.send });

    for (const t of ["session.subscribe", "session.unsubscribe"]) {
      expect(
        wiring.onControlFrame(
          JSON.stringify({ v: 1, ch: "control", seq: 0, t, body: null, reqId: "req-state" }),
        ),
      ).toBe(true);
    }

    // Neither is answered on the correlation id: both are state in the table,
    // and a request that could not be read asked for no state.
    expect(sink.frames).toHaveLength(0);
    expect(store.stats().subscriptions).toBe(0);
  });
});
