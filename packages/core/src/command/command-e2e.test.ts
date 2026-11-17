/**
 * W-15's merged seam, with the engine replaced by a fake port.
 *
 * The fake is the **engine side** only: a `Channel.send` that answers the
 * command, and an `EngineEventFrame` that stands in for a terminal output. The
 * command dispatcher, the C1 merger and the C5 sender are the real ones; the
 * renderer's own client is covered by `apps/desktop`.
 *
 * The real-engine half is `_research/engine-0.6.0/probe.mjs` (0.6.0 package,
 * `server` argv): it proves the package starts; this test proves the two seams
 * in one process without requiring the package.
 */

import { describe, expect, it, vi } from "vitest";

import { createFrameSender } from "../bridge/sender.js";
import { createEventMerger } from "../merge/event-merger.js";
import { createCommandDispatcher } from "./dispatch.js";
import type { CommandCall, CommandReply } from "./types.js";

describe("W-15 command + frame seam", () => {
  it("returns answered for a response capability", async () => {
    const send = vi.fn(async (_request: unknown) => ({
      ok: true as const,
      data: { version: "0.6.0" },
      raw: {},
    }));
    const dispatcher = createCommandDispatcher({
      getChannel: (agentId) => (agentId === "__control__" ? { send } : undefined),
    });

    const reply = await dispatcher.invoke({ capability: "device.info", body: {} } as CommandCall);

    expect(reply).toEqual({ ok: true, completion: "answered", data: { version: "0.6.0" } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ capability: "device.info", body: {} });
  });

  it("returns accepted for an untracked capability and does not claim data", async () => {
    const send = vi.fn(async (_request: unknown) => ({
      ok: true as const,
      data: { ignored: true },
      raw: {},
    }));
    const dispatcher = createCommandDispatcher({
      getChannel: () => ({ send }),
    });

    const reply: CommandReply = await dispatcher.invoke({
      capability: "terminal.kill",
      body: { terminal_id: "t-1" },
    } as CommandCall);

    expect(reply).toEqual({ ok: true, completion: "accepted" });
    expect(reply).not.toHaveProperty("data");
  });

  it("moves a terminal output through the real merger and sender", () => {
    const emitted: unknown[] = [];
    const sender = createFrameSender({
      transport: (payload) => emitted.push(JSON.parse(payload)),
    });
    const merger = createEventMerger({
      agentId: "agent-a",
      onFrame: (frame) => sender.send(frame),
    });

    const changes = merger.ingest({
      type: "terminal_output",
      raw: { type: "terminal_output", terminal_id: "t-1", data: "hi" },
      at: 1,
    });

    expect(changes).toEqual([]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ t: "term.output", ch: "stream" });
  });
});
