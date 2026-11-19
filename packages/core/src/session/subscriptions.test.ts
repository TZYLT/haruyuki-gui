/**
 * The subscription table, pinned from the promises a page depends on.
 *
 * Every case can fail on its own, and each names the wrong rule it catches:
 *
 * - a subscription answers at once, not at the next change;
 * - subscribing an instance again replaces it, so one change is one frame;
 * - a released subscription hears nothing more, and a stale handle does not
 *   silence the subscription that replaced it;
 * - a reconnect re-sends every live subscription carrying the new generation;
 * - a conversation becoming watched empties its badge once, on the edge only;
 * - a change reaches the subscriptions that read that entity, and no others;
 * - a burst of changes on one instance is gathered into one frame per window,
 *   and the frame that is sent carries the newest value in it.
 *
 * Two of these were confirmed by breaking the module on purpose - keeping the
 * replaced subscription alive, and clearing the badge on every arrival instead of
 * on the edge - and each break turns exactly the intended case red.
 *
 * The burst cases run on a hand-driven clock: `setTimeout` would make the suite
 * wait a quarter of a second per case and would still not say when the window
 * opened.
 */

import { describe, expect, it } from "vitest";

import type { SelectRequest, SelectResult } from "@haruyuki/protocol";

import { createBurstScheduler } from "./burst-scheduler.js";
import { createSessionStore } from "./store.js";
import {
  PUSH_WINDOW_MS,
  createSubscriptionTable,
  type SelectEmit,
  type ChangedEntities,
  type SubscriptionTable,
  type UnreadBridge,
} from "./subscriptions.js";

/** The key a fake selector run files its answer under. */
function keyOf(selector: string, params: Readonly<Record<string, unknown>>): string {
  const fields = Object.entries(params)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .sort();

  return `${selector}?${fields.join("&")}`;
}

/** A table over a hand-written store, plus the ways a test writes to it. */
type Harness = {
  readonly table: SubscriptionTable;
  /** Change the value one selector instance will report from now on. */
  set(selector: string, params: Readonly<Record<string, unknown>>, value: unknown): void;
  /** How many times one selector instance was run. */
  runsOf(selector: string, params: Readonly<Record<string, unknown>>): number;
};

/**
 * A clock nobody advances but the test.
 *
 * `schedule` stores the callback and refuses to run it, which is the only way a
 * case can say both "the window has not closed yet" and "now it has" without
 * waiting. Advancing to a deadline runs every callback due by then, because a
 * real timer queue would.
 */
function fakeClock(): {
  readonly now: () => number;
  readonly schedule: (fn: () => void, ms: number) => () => void;
  /** Move time forward, running the callbacks that come due on the way. */
  advance(ms: number): void;
  /** How many callbacks are waiting. */
  pending(): number;
} {
  let at = 0;
  let armed = 0;
  const queue = new Map<number, { due: number; fn: () => void }>();
  let nextHandle = 0;

  const run = (ms: number): void => {
    at += ms;

    for (const [handle, job] of [...queue]) {
      if (job.due > at) {
        continue;
      }

      queue.delete(handle);
      armed -= 1;
      job.fn();
    }
  };

  return {
    now: () => at,
    schedule: (fn, ms) => {
      nextHandle += 1;
      armed += 1;

      const handle = nextHandle;

      queue.set(handle, { due: at + ms, fn });

      return () => {
        if (!queue.delete(handle)) {
          return;
        }

        armed -= 1;
      };
    },
    advance: run,
    pending: () => armed,
  };
}

/**
 * Build a table whose selector run answers from a mutable map.
 *
 * The generation the fake hands back is always 0: stamping the real one is the
 * table's job, and a fake that already knew it could hide a missing stamp.
 */
function harness(
  options: {
    unread?: UnreadBridge;
    epoch?: number;
    schedule?: (fn: () => void, ms: number) => () => void;
    now?: () => number;
  } = {},
): Harness {
  const held = new Map<string, { value: unknown; revision: number }>();
  const runs = new Map<string, number>();
  let revisionCounter = 0;

  const table = createSubscriptionTable({
    select: (request) => {
      const key = keyOf(request.selector, request.params);
      const entry = held.get(key);

      runs.set(key, (runs.get(key) ?? 0) + 1);

      return {
        selector: request.selector,
        params: request.params,
        revision: entry?.revision ?? 0,
        epoch: 0,
        value: entry?.value ?? null,
      };
    },
    // Spread, not `unread: options.unread`: with `exactOptionalPropertyTypes` an
    // absent key and a key holding `undefined` are different types, and this
    // option is absent when the test wants no badge at all.
    ...(options.unread === undefined ? {} : { unread: options.unread }),
    ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    table,
    set(selector, params, value) {
      revisionCounter += 1;
      held.set(keyOf(selector, params), { value, revision: revisionCounter });
    },
    runsOf(selector, params) {
      return runs.get(keyOf(selector, params)) ?? 0;
    },
  };
}

/** One subscription request, with the shape a page sends. */
function request(
  instanceId: string,
  selector: string,
  params: Readonly<Record<string, unknown>> = {},
  active?: boolean,
): SelectRequest {
  return active === undefined
    ? { instanceId, selector, params }
    : { instanceId, selector, params, active };
}

/** Collect the frames one sink receives. */
function collect(): { frames: SelectResult[]; emit: (result: SelectResult) => void } {
  const frames: SelectResult[] = [];

  return {
    frames,
    emit: (result) => {
      frames.push(result);
    },
  };
}

describe("a subscription answers with the current value at once", () => {
  it("emits one frame during subscribe, before any change", () => {
    const harnessed = harness();
    const sink = collect();

    harnessed.set(
      "view.nav",
      { agentId: "agent-1" },
      { rows: [{ conversationId: "c-1" }], hasMore: false },
    );
    harnessed.table.subscribe(request("tab-1", "view.nav", { agentId: "agent-1" }), sink.emit);

    // Not "eventually": the frame exists by the time `subscribe` returned, which
    // is the only reading that lets a freshly mounted page render at once.
    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0]?.selector).toBe("view.nav");
    expect(sink.frames[0]?.value).toEqual({ rows: [{ conversationId: "c-1" }], hasMore: false });
    expect(sink.frames[0]?.epoch).toBe(0);
  });

  it("sends nothing for a change that leaves the value alone", () => {
    const harnessed = harness();
    const sink = collect();

    harnessed.set("entity.queue", { conversationId: "c-1" }, { conversationId: "c-1", length: 2 });
    harnessed.table.subscribe(
      request("tab-1", "entity.queue", { conversationId: "c-1" }),
      sink.emit,
    );

    expect(harnessed.table.notify(["queues"])).toBe(0);
    expect(sink.frames).toHaveLength(1);

    harnessed.set("entity.queue", { conversationId: "c-1" }, { conversationId: "c-1", length: 3 });
    expect(harnessed.table.notify(["queues"])).toBe(1);
    expect(sink.frames).toHaveLength(2);
    expect(sink.frames[1]?.value).toEqual({ conversationId: "c-1", length: 3 });
  });
});

describe("subscribing an instance again replaces it", () => {
  it("retires the earlier sink, so one change is one frame", () => {
    const harnessed = harness();
    const earlier = collect();
    const later = collect();

    harnessed.set("view.nav", { agentId: "agent-1", pinned: [] }, { rows: ["a"], hasMore: false });
    harnessed.set(
      "view.nav",
      { agentId: "agent-1", pinned: ["c-2"] },
      { rows: ["b"], hasMore: false },
    );

    harnessed.table.subscribe(
      request("tab-1", "view.nav", { agentId: "agent-1", pinned: [] }),
      earlier.emit,
    );

    harnessed.table.subscribe(
      request("tab-1", "view.nav", { agentId: "agent-1", pinned: ["c-2"] }),
      later.emit,
    );

    expect(earlier.frames).toHaveLength(1);
    expect(later.frames).toHaveLength(1);
    expect(later.frames[0]?.value).toEqual({ rows: ["b"], hasMore: false });

    // One change, one frame, and it goes to the new shape only. An append would
    // send it twice and leave the retired copy rendering a stale list.
    harnessed.set(
      "view.nav",
      { agentId: "agent-1", pinned: ["c-2"] },
      { rows: ["b", "c"], hasMore: false },
    );

    expect(harnessed.table.notify(["agents"])).toBe(1);
    expect(earlier.frames).toHaveLength(1);
    expect(later.frames).toHaveLength(2);

    expect(harnessed.table.stats().replaced).toBe(1);
    expect(harnessed.table.stats().subscriptions).toBe(1);
  });

  it("does not let the retired handle silence its replacement", () => {
    const harnessed = harness();
    const sink = collect();
    const params = { agentId: "agent-1" };

    harnessed.set("view.nav", params, { rows: [], hasMore: false });

    const retired = harnessed.table.subscribe(request("tab-1", "view.nav", params), () => {});
    harnessed.table.subscribe(request("tab-1", "view.nav", params), sink.emit);

    // A page that unmounts the old render after the new one mounted holds the
    // retired handle. Releasing it must not take the live subscription with it.
    retired();

    harnessed.set("view.nav", params, { rows: ["a"], hasMore: false });

    expect(harnessed.table.notify(["agents"])).toBe(1);
    expect(sink.frames).toHaveLength(2);
  });
});

describe("a released subscription hears nothing more", () => {
  it("stops at unsubscribe and tolerates a second release", () => {
    const harnessed = harness();
    const sink = collect();
    const params = { conversationId: "c-1" };

    harnessed.set("entity.turns", params, [{ turnRef: "t-1" }]);

    const off = harnessed.table.subscribe(request("tab-1", "entity.turns", params), sink.emit);

    expect(harnessed.table.notify(["turns"])).toBe(0);
    expect(sink.frames).toHaveLength(1);

    off();
    expect(sink.frames).toHaveLength(1);
    expect(harnessed.table.stats().subscriptions).toBe(0);

    // Unmounting twice is ordinary in a renderer; it must not throw.
    off();
    expect(harnessed.table.notify(["turns"])).toBe(0);
    expect(sink.frames).toHaveLength(1);
  });
});

describe("a reconnect re-sends every live subscription", () => {
  it("stamps the new generation on the value each one holds now", () => {
    const harnessed = harness();
    const first = collect();
    const second = collect();

    harnessed.set("entity.queue", { conversationId: "c-1" }, { length: 1 });
    harnessed.set("entity.queue", { conversationId: "c-2" }, { length: 5 });

    harnessed.table.subscribe(
      request("tab-1", "entity.queue", { conversationId: "c-1" }),
      first.emit,
    );
    harnessed.table.subscribe(
      request("tab-2", "entity.queue", { conversationId: "c-2" }),
      second.emit,
    );

    expect(harnessed.table.rebaseEpoch(2)).toBe(2);

    // Each live subscription is answered exactly once, with the value it holds
    // right now and the generation that value now belongs to.
    expect(first.frames.map((frame) => frame.epoch)).toEqual([0, 2]);
    expect(second.frames.map((frame) => frame.epoch)).toEqual([0, 2]);
    expect(first.frames[1]?.value).toEqual({ length: 1 });
    expect(second.frames[1]?.value).toEqual({ length: 5 });
  });

  it("advances by itself when no generation is named, and stays quiet after", () => {
    const harnessed = harness();
    const sink = collect();

    harnessed.set("entity.device", { agentId: "agent-1" }, { isOnline: true });
    harnessed.table.subscribe(request("tab-1", "entity.device", { agentId: "agent-1" }), sink.emit);

    harnessed.table.rebaseEpoch();

    expect(harnessed.table.epoch).toBe(1);
    expect(sink.frames.map((frame) => frame.epoch)).toEqual([0, 1]);

    // Already re-sent under this generation: another unchanged report of the
    // same entity must not repeat it.
    expect(harnessed.table.notify(["devices"])).toBe(0);
    expect(sink.frames).toHaveLength(2);
  });
});

describe("the badge is emptied on the edge, not on every arrival", () => {
  it("clears once when two instances arrive, and once more after all leave", () => {
    const clears: string[] = [];
    const reports: string[] = [];

    const unread: UnreadBridge = {
      setActive: (conversationId, active) => {
        reports.push(`${active ? "watched" : "unwatched"}:${conversationId}`);
      },
      clear: (conversationId) => {
        clears.push(conversationId);
      },
    };

    const harnessed = harness({ unread });
    const params = { conversationId: "c-1" };

    harnessed.set("view.tabActivity", params, { streaming: true, approvals: 0, unread: 3 });

    const offFirst = harnessed.table.subscribe(
      request("tab-1", "view.tabActivity", params, true),
      () => {},
    );

    expect(clears).toEqual(["c-1"]);

    // A second tab opening on the conversation the reader is already in is not
    // another arrival: the badge was emptied the moment the first one landed.
    harnessed.table.subscribe(request("tab-2", "view.tabActivity", params, true), () => {});
    expect(clears).toEqual(["c-1"]);
    expect(harnessed.table.stats().watched).toBe(1);

    // One of the two leaving still leaves the conversation watched.
    offFirst();
    expect(clears).toEqual(["c-1"]);
    expect(harnessed.table.stats().watched).toBe(1);
    expect(reports).toEqual(["watched:c-1"]);
  });

  it("clears again when the reader comes back after everyone left", () => {
    const clears: string[] = [];
    const harnessed = harness({
      unread: {
        setActive: () => {},
        clear: (conversationId) => {
          clears.push(conversationId);
        },
      },
    });
    const params = { conversationId: "c-1" };
    const sink = collect();

    harnessed.set("view.tabActivity", params, { unread: 4 });

    const off = harnessed.table.subscribe(
      request("tab-1", "view.tabActivity", params, true),
      sink.emit,
    );
    expect(clears).toEqual(["c-1"]);

    off();
    expect(harnessed.table.stats().watched).toBe(0);

    // Nobody watches it any more, so the next arrival is a new edge.
    harnessed.table.subscribe(request("tab-2", "view.tabActivity", params, true), () => {});
    expect(clears).toEqual(["c-1", "c-1"]);
  });

  it("clears on the flip from inactive to active for the same instance", () => {
    const clears: string[] = [];
    const harnessed = harness({
      unread: {
        setActive: () => {},
        clear: (conversationId) => {
          clears.push(conversationId);
        },
      },
    });
    const params = { conversationId: "c-1" };

    harnessed.set("view.tabActivity", params, { unread: 2 });

    // A background tab subscribes too; it is not the reader being there.
    harnessed.table.subscribe(request("tab-1", "view.tabActivity", params, false), () => {});
    expect(clears).toEqual([]);
    expect(harnessed.table.stats().watched).toBe(0);

    // The same instance is now the active one: that is the edge, exactly once.
    harnessed.table.subscribe(request("tab-1", "view.tabActivity", params, true), () => {});
    expect(clears).toEqual(["c-1"]);

    // Reporting itself again as active is not another arrival.
    harnessed.table.subscribe(request("tab-1", "view.tabActivity", params, true), () => {});
    expect(clears).toEqual(["c-1"]);
  });

  it("leaves a different conversation's badge alone", () => {
    const clears: string[] = [];
    const harnessed = harness({
      unread: {
        setActive: () => {},
        clear: (conversationId) => {
          clears.push(conversationId);
        },
      },
    });

    harnessed.set("view.tabActivity", { conversationId: "c-1" }, { unread: 1 });
    harnessed.set("view.tabActivity", { conversationId: "c-2" }, { unread: 1 });

    harnessed.table.subscribe(
      request("tab-1", "view.tabActivity", { conversationId: "c-1" }, true),
      () => {},
    );
    harnessed.table.subscribe(
      request("tab-2", "view.tabActivity", { conversationId: "c-2" }, true),
      () => {},
    );

    expect(clears).toEqual(["c-1", "c-2"]);
    expect(harnessed.table.stats().watched).toBe(2);
  });
});

describe("a change reaches only the subscriptions that read it", () => {
  it("tells the agent subscriptions about agents, and nobody else", () => {
    const harnessed = harness();
    const requests = [
      request("tab-agents", "entity.agents", {}),
      request("tab-agent", "entity.agent", { agentId: "agent-1" }),
      request("tab-conv", "entity.conversations", {}),
      request("tab-turns", "entity.turns", { conversationId: "c-1" }),
      request("tab-queue", "entity.queue", { conversationId: "c-1" }),
      request("tab-device", "entity.device", { agentId: "agent-1" }),
      request("tab-blocks", "entity.blocks", { turnRef: "t-1" }),
      request("tab-usage", "entity.usage", { conversationId: "c-1" }),
      request("tab-subagents", "entity.subagents", { conversationId: "c-1" }),
      request("tab-approvals", "entity.approvals", { agentId: "agent-1" }),
    ];

    const frames = new Map<string, number>();

    for (const one of requests) {
      harnessed.set(one.selector, one.params, { first: true });

      harnessed.table.subscribe(one, () => {
        frames.set(one.instanceId, (frames.get(one.instanceId) ?? 0) + 1);
      });
    }

    // A real change in agents, and nowhere else.
    harnessed.set("entity.agents", {}, { first: false });
    harnessed.set("entity.agent", { agentId: "agent-1" }, { first: false });

    expect(harnessed.table.notify(["agents"])).toBe(2);

    // Two of the ten read agents - the whole list, and the one narrowed to an
    // agent. Telling all ten would make one message re-render the whole window.
    expect(frames.get("tab-agents")).toBe(2);
    expect(frames.get("tab-agent")).toBe(2);

    for (const one of requests.slice(2)) {
      expect(frames.get(one.instanceId)).toBe(1);
    }
  });

  it("narrows a scoped subscription to the ids that moved", () => {
    const harnessed = harness();
    const first = collect();
    const second = collect();

    harnessed.set("entity.turns", { conversationId: "c-1" }, [{ turnRef: "t-1" }]);
    harnessed.set("entity.turns", { conversationId: "c-2" }, [{ turnRef: "t-2" }]);

    harnessed.table.subscribe(
      request("tab-1", "entity.turns", { conversationId: "c-1" }),
      first.emit,
    );
    harnessed.table.subscribe(
      request("tab-2", "entity.turns", { conversationId: "c-2" }),
      second.emit,
    );

    // Another conversation's turns are none of the first tab's business.
    harnessed.set("entity.turns", { conversationId: "c-2" }, [
      { turnRef: "t-2" },
      { turnRef: "t-3" },
    ]);

    expect(harnessed.table.notify({ turns: ["c-2"] })).toBe(1);
    expect(first.frames).toHaveLength(1);
    expect(second.frames).toHaveLength(2);

    // Both moved this time, so an unnamed change reaches both.
    harnessed.set("entity.turns", { conversationId: "c-1" }, [
      { turnRef: "t-1" },
      { turnRef: "t-9" },
    ]);

    expect(harnessed.table.notify({ turns: null })).toBe(1);
    expect(first.frames).toHaveLength(2);
    expect(harnessed.runsOf("entity.turns", { conversationId: "c-1" })).toBe(2);
  });

  it("does not run an unaffected selector at all", () => {
    const harnessed = harness();
    const sink = collect();

    harnessed.set("entity.subagents", { conversationId: "c-1" }, []);
    harnessed.table.subscribe(
      request("tab-1", "entity.subagents", { conversationId: "c-1" }),
      sink.emit,
    );

    for (const kind of [
      "agents",
      "conversations",
      "turns",
      "blocks",
      "queues",
      "usage",
      "approvals",
      "devices",
    ]) {
      harnessed.table.notify([kind]);
    }

    // One run for the first frame and one for nothing else: a subscription that
    // never reads agents must not pay for a change to agents.
    expect(harnessed.runsOf("entity.subagents", { conversationId: "c-1" })).toBe(1);
    expect(sink.frames).toHaveLength(1);
  });

  it("re-runs a selector nobody has described on any change", () => {
    const harnessed = harness();
    const sink = collect();

    harnessed.set("view.unknown", {}, { anything: true });
    harnessed.table.subscribe(request("tab-1", "view.unknown", {}), sink.emit);

    harnessed.set("view.unknown", {}, { anything: false });
    harnessed.table.notify(["usage"]);

    expect(harnessed.runsOf("view.unknown", {})).toBe(2);
    expect(sink.frames).toHaveLength(2);
  });
});

describe("unusable input is skipped, never thrown", () => {
  it("survives junk requests, junk change reports and a badge that throws", () => {
    const harnessed = harness({
      unread: {
        setActive: () => {
          throw new Error("the badge is not ready");
        },
        clear: () => {
          throw new Error("the badge is not ready");
        },
      },
    });

    harnessed.set("view.tabActivity", { conversationId: "c-1" }, { unread: 1 });

    const bad = [
      { instanceId: "", selector: "view.nav", params: {} },
      { instanceId: 7, selector: "view.nav", params: {} },
      { instanceId: "tab-1", selector: "", params: null },
    ];

    for (const one of bad) {
      // A refused request still hands back a handle a page can call.
      const off = harnessed.table.subscribe(one as unknown as SelectRequest, () => {});

      off();
    }

    expect(harnessed.table.stats().dropped).toBe(3);

    // The badge throwing must not take the subscription with it.
    harnessed.table.subscribe(
      request("tab-1", "view.tabActivity", { conversationId: "c-1" }, true),
      () => {},
    );
    expect(harnessed.table.stats().subscriptions).toBe(1);
    expect(harnessed.table.stats().watched).toBe(1);

    // A change report with nothing usable is not a broadcast.
    for (const junk of ["agents", { nobody: ["x"] }, { turns: [] }, {}, 7, null]) {
      expect(harnessed.table.notify(junk as unknown as ChangedEntities)).toBe(0);
    }

    // The failed badge calls were counted, not thrown; the subscription itself
    // heard its first frame regardless.
    expect(harnessed.table.stats().dropped).toBe(3);
  });

  it("drops a selector run that fails and keeps the subscription live", () => {
    const sink = collect();
    let shouldThrow = false;

    const table = createSubscriptionTable({
      select: (request) => {
        if (shouldThrow) {
          throw new Error("the selector is not ready");
        }

        return {
          selector: request.selector,
          params: request.params,
          revision: 1,
          epoch: 0,
          value: 1,
        };
      },
    });

    table.subscribe(request("tab-1", "view.nav", {}), sink.emit);

    shouldThrow = true;
    expect(table.notify(["conversations"])).toBe(0);
    expect(table.stats().selectFailed).toBe(1);

    // Recovered: the subscription was never dropped.
    shouldThrow = false;
    expect(table.rebaseEpoch(1)).toBe(1);
    expect(sink.frames.map((frame) => frame.epoch)).toEqual([0, 1]);
  });
});

describe("a burst on one instance is gathered into one frame per window", () => {
  it("sends the newest value once per window and counts what it swallowed", () => {
    const clock = fakeClock();
    const harnessed = harness({ schedule: clock.schedule, now: clock.now });
    const sink = collect();
    const params = { turnRef: "t-1" };

    harnessed.set("entity.blocks", params, [{ blockId: "b-1", text: "0" }]);
    harnessed.table.subscribe(request("tab-1", "entity.blocks", params), sink.emit);

    // The first frame is on the wire before `subscribe` returned, and it did not
    // have to wait for a window.
    expect(sink.frames).toHaveLength(1);
    expect(clock.pending()).toBe(0);

    // Two hundred updates inside one window, as a fast producer would send them.
    for (let index = 1; index <= 200; index += 1) {
      harnessed.set("entity.blocks", params, [{ blockId: "b-1", text: String(index) }]);
      harnessed.table.notify(["blocks"]);
    }

    // Nothing has been sent yet: the window is still open, and one timer is
    // armed for the instance rather than two hundred.
    expect(sink.frames).toHaveLength(1);
    expect(clock.pending()).toBe(1);

    clock.advance(PUSH_WINDOW_MS);

    // One frame, carrying the newest value, and 199 updates accounted for.
    expect(sink.frames).toHaveLength(2);
    expect(sink.frames[1]?.value).toEqual([{ blockId: "b-1", text: "200" }]);
    expect(harnessed.table.stats().coalesced).toBe(199);
    expect(harnessed.table.stats().pushes).toBe(2);
  });

  it("opens a fresh window per instance, so one busy tab does not silence another", () => {
    const clock = fakeClock();
    const harnessed = harness({ schedule: clock.schedule, now: clock.now });
    const first = collect();
    const second = collect();

    harnessed.set("entity.blocks", { turnRef: "t-1" }, [{ blockId: "b-1" }]);
    harnessed.set("entity.blocks", { turnRef: "t-2" }, [{ blockId: "b-2" }]);

    harnessed.table.subscribe(request("tab-1", "entity.blocks", { turnRef: "t-1" }), first.emit);
    harnessed.table.subscribe(request("tab-2", "entity.blocks", { turnRef: "t-2" }), second.emit);

    harnessed.set("entity.blocks", { turnRef: "t-1" }, [{ blockId: "b-1", text: "a" }]);
    harnessed.set("entity.blocks", { turnRef: "t-2" }, [{ blockId: "b-2", text: "b" }]);

    harnessed.table.notify(["blocks"]);

    // Two instances, two windows, two timers.
    expect(clock.pending()).toBe(2);

    clock.advance(PUSH_WINDOW_MS);

    expect(first.frames).toHaveLength(2);
    expect(second.frames).toHaveLength(2);
    expect(second.frames[1]?.value).toEqual([{ blockId: "b-2", text: "b" }]);
  });

  it("still answers a burst once when there is no window at all", () => {
    // The same construction with no scheduler: this is the path a caller that
    // injects nothing gets, and it must stay synchronous, one frame per change.
    const harnessed = harness();
    const sink = collect();
    const params = { turnRef: "t-1" };

    harnessed.set("entity.blocks", params, [{ blockId: "b-1", text: "0" }]);
    harnessed.table.subscribe(request("tab-1", "entity.blocks", params), sink.emit);

    for (let index = 1; index <= 200; index += 1) {
      harnessed.set("entity.blocks", params, [{ blockId: "b-1", text: String(index) }]);
      harnessed.table.notify(["blocks"]);
    }

    // 200 updates, 200 frames: the window is the only thing that would have
    // absorbed them, so this case fails the moment the window is wired in
    // unconditionally.
    expect(sink.frames).toHaveLength(201);
    expect(harnessed.table.stats().coalesced).toBe(0);
  });

  it("re-answers on a connection boundary once, without a stale frame first", () => {
    const clock = fakeClock();
    const harnessed = harness({ schedule: clock.schedule, now: clock.now });
    const sink = collect();

    harnessed.set("entity.queue", { conversationId: "c-1" }, { length: 1 });
    harnessed.table.subscribe(
      request("tab-1", "entity.queue", { conversationId: "c-1" }),
      sink.emit,
    );

    harnessed.set("entity.queue", { conversationId: "c-1" }, { length: 2 });
    harnessed.table.notify(["queues"]);

    expect(sink.frames).toHaveLength(1);

    // A reconnect is not a burst. The gathered update is dropped rather than
    // sent under the old generation, and the boundary re-answers once with the
    // newest value and the new generation.
    expect(harnessed.table.rebaseEpoch(5)).toBe(1);

    expect(sink.frames).toHaveLength(2);
    expect(sink.frames[1]).toMatchObject({ epoch: 5, value: { length: 2 } });
    expect(clock.pending()).toBe(0);
  });

  it("drops a window whose instance unsubscribed rather than framing a dead page", () => {
    const clock = fakeClock();
    const harnessed = harness({ schedule: clock.schedule, now: clock.now });
    const sink = collect();
    const params = { turnRef: "t-1" };

    harnessed.set("entity.blocks", params, [{ blockId: "b-1" }]);
    const off = harnessed.table.subscribe(request("tab-1", "entity.blocks", params), sink.emit);

    harnessed.set("entity.blocks", params, [{ blockId: "b-1", text: "late" }]);
    harnessed.table.notify(["blocks"]);

    off();
    clock.advance(PUSH_WINDOW_MS);

    // The page unmounted inside the window; it hears nothing more, and no timer
    // is left waiting for it.
    expect(sink.frames).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });
});

describe("the shipped scheduler drives the same window", () => {
  it("gathers a real burst on the host timer and lands the newest value", async () => {
    // The clock is the host's here, on purpose: every other burst case drives a
    // fake one, so this is the only case that would catch a scheduler that never
    // armed a timer at all.
    const scheduler = createBurstScheduler();
    const harnessed = harness({ schedule: scheduler.schedule, now: scheduler.now });
    const sink = collect();
    const params = { turnRef: "t-1" };

    harnessed.set("entity.blocks", params, [{ blockId: "b-1", text: "0" }]);
    harnessed.table.subscribe(request("tab-1", "entity.blocks", params), sink.emit);

    for (let index = 1; index <= 20; index += 1) {
      harnessed.set("entity.blocks", params, [{ blockId: "b-1", text: String(index) }]);
      harnessed.table.notify(["blocks"]);
    }

    // Nothing yet: the window has not run out.
    expect(sink.frames).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, PUSH_WINDOW_MS + 60));

    // Well under the twenty updates, and carrying the last of them.
    expect(sink.frames.length).toBeLessThan(20);
    expect(sink.frames.at(-1)?.value).toEqual([{ blockId: "b-1", text: "20" }]);
    expect(harnessed.table.stats().coalesced).toBeGreaterThan(0);
  });
});

describe("the window is what absorbs a burst, end to end through the store", () => {
  /** A store with one agent and one conversation, as the shell seeds it. */
  function seededStore(deps: Record<string, unknown> = {}) {
    const store = createSessionStore(deps as never);

    store.ingestAgents([{ id: "agent-a", name: "Agent A" }]);
    store.ingestConversations(
      [{ id: "c-1", agent_id: "agent-a", last_message_at: "2026-11-19T00:00:00.000Z" }],
      { hasMore: false },
    );
    store.ingest({
      conversationId: "c-1",
      at: 1,
      subagentId: null,
      kind: "message.delta",
      messageId: "m-1",
      runId: "local-run-1",
      runSeq: 1,
      text: "hello",
      parts: [],
      first: true,
      authorAgentId: "agent-a",
      runtimeAgentId: "agent-a",
    } as never);

    return store;
  }

  /** Two instances watching the blocks of the one open turn. */
  function watched(store: ReturnType<typeof seededStore>, onFrame: SelectEmit) {
    const turnRef = [...store.getSnapshot().turns.values()][0]?.turnRef ?? "t-1";

    store.subscribe(
      { instanceId: "tab-1", selector: "entity.blocks", params: { turnRef } },
      onFrame,
    );
    store.subscribe(
      { instanceId: "tab-2", selector: "entity.blocks", params: { turnRef } },
      onFrame,
    );

    return turnRef;
  }

  /** Stream two hundred content updates, as a fast producer would. */
  function stream(store: ReturnType<typeof seededStore>): void {
    for (let index = 0; index < 200; index += 1) {
      store.ingestContent("c-1", {
        messageId: "m-1",
        upserts: [{ id: "b-1", text: `chunk-${index}` }],
        removes: [],
      });
    }
  }

  it("answers two hundred updates within one window, and counts what it kept", () => {
    const clock = fakeClock();
    const store = seededStore({ schedule: clock.schedule, now: clock.now });
    const frames = collect();

    watched(store, frames.emit);

    const before = frames.frames.length;

    stream(store);

    // Still inside the window: the producer has finished, the page has not been
    // woken a single time since the burst began.
    expect(frames.frames.length).toBe(before);

    clock.advance(PUSH_WINDOW_MS);

    // At most one frame per instance, carrying the newest text.
    expect(frames.frames.length - before).toBeLessThanOrEqual(4);
    expect(store.stats().pushesCoalesced).toBeGreaterThan(0);
  });

  it("returns to one frame per update when no scheduler is injected", () => {
    // The same construction with nothing injected. This is the path a caller
    // that wants every change delivered synchronously gets, and it is what makes
    // the case above able to fail: wire the window in unconditionally and this
    // count collapses.
    const store = seededStore();
    const frames = collect();

    watched(store, frames.emit);

    const before = frames.frames.length;

    stream(store);

    expect(frames.frames.length - before).toBeGreaterThan(300);
  });

  it("answers a direct select immediately, window or not", () => {
    const clock = fakeClock();
    const store = seededStore({ schedule: clock.schedule, now: clock.now });
    const frames = collect();
    const turnRef = watched(store, frames.emit);

    // Two instances, so two first frames are already on the wire.
    const before = frames.frames.length;

    stream(store);

    // A read the page asks for is not a change being pushed: it reads the newest
    // state as it stands and does not wait for a window, which is why a page can
    // still scroll and re-read while a burst is pending.
    const during = store.select({
      instanceId: "tab-3",
      selector: "entity.blocks",
      params: { turnRef },
    });

    expect(during.value).toMatchObject([{ blockId: "b-1", block: { text: "chunk-199" } }]);

    // And asking did not cost the pending windows anything: still one timer per
    // instance, and no frame sent early.
    expect(frames.frames.length).toBe(before);
    expect(clock.pending()).toBe(2);

    clock.advance(PUSH_WINDOW_MS);

    // One frame per instance when the windows close, and no more.
    expect(frames.frames.length).toBe(before + 2);
  });
});
