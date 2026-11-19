/**
 * Tests for the renderer command client.
 *
 * The client is the last place a value from another process is still `unknown`,
 * so the cases are about the boundary rather than about any business rule: the
 * channel name, the payload's exact shape (scope outside the body), the four
 * reply arms, and a malformed answer becoming a refusal instead of a throw.
 *
 * The fake bridge records `(channel, payload)` rather than wrapping a spy: the
 * assertions that matter are about the payload's shape and about the absence of a
 * key (`runtime`, `engineText`, `data`), and both read better against a recorded
 * value than against a matcher call.
 */

import { describe, expect, it, vi } from "vitest";

import type { CommandReply, RuntimeScope } from "@haruyuki/core";

import { BRIDGE_CHANNEL_NAMES } from "../../shared/bridge.js";
import { createCommandClient } from "../command.js";
import type { CommandBridgeSurface } from "../command.js";

const SCOPE: RuntimeScope = { agent_id: "agent-1", conversation_id: "conv-1" };

/** A bridge that records every call and answers with one fixed value. */
function bridgeReturning(answer: unknown): {
  bridge: CommandBridgeSurface;
  calls: Array<{ channel: string; payload: unknown }>;
} {
  const calls: Array<{ channel: string; payload: unknown }> = [];

  return {
    calls,
    bridge: {
      invoke: (channel, payload) => {
        calls.push({ channel, payload });
        return Promise.resolve(answer);
      },
    },
  };
}

/** A bridge whose IPC call fails, as a missing handler on the main side would. */
function bridgeRejecting(): CommandBridgeSurface {
  return {
    invoke: () => Promise.reject(new Error("no handler registered")),
  };
}

/** The payload of the single call a test expects. */
function onlyPayload(calls: Array<{ channel: string; payload: unknown }>): Record<string, unknown> {
  expect(calls).toHaveLength(1);

  const payload = calls[0]?.payload;

  if (typeof payload !== "object" || payload === null) {
    throw new Error("the client sent no payload object");
  }

  return payload as Record<string, unknown>;
}

describe("createCommandClient", () => {
  it("calls the command channel with capability and body, and nothing else", async () => {
    const { bridge, calls } = bridgeReturning({ ok: true, completion: "accepted" });
    const client = createCommandClient(bridge);
    const body = { reason: "sample" };

    await client.invoke("device.info", body);

    expect(calls[0]?.channel).toBe(BRIDGE_CHANNEL_NAMES.commandInvoke);
    expect(onlyPayload(calls)).toEqual({ capability: "device.info", body });
    expect(Object.hasOwn(onlyPayload(calls), "runtime")).toBe(false);
  });

  it("sends the runtime as a sibling of the body, never inside it", async () => {
    const { bridge, calls } = bridgeReturning({ ok: true, completion: "accepted" });
    const client = createCommandClient(bridge);
    const body = { terminal_id: "sample" };

    await client.invoke("terminal.kill", body, SCOPE);

    const payload = onlyPayload(calls);
    expect(payload).toEqual({ capability: "terminal.kill", body, runtime: SCOPE });

    const sentBody = payload["body"];
    expect(sentBody).toBe(body);
    expect(Object.hasOwn(body, "runtime")).toBe(false);
  });

  it("does not mutate the body it was given", async () => {
    const { bridge } = bridgeReturning({ ok: true, completion: "accepted" });
    const client = createCommandClient(bridge);
    const body = { terminal_id: "sample" };

    await client.invoke("terminal.kill", body, SCOPE);

    expect(body).toEqual({ terminal_id: "sample" });
  });

  it("passes an answered reply's data through untouched", async () => {
    const data = { backend: "fake", flags: { a: true } };
    const { bridge } = bridgeReturning({ ok: true, completion: "answered", data });
    const client = createCommandClient(bridge);

    const reply = await client.invoke("device.info", {});

    expect(reply).toEqual({ ok: true, completion: "answered", data });
  });

  it("passes an accepted reply through and never invents data", async () => {
    const { bridge } = bridgeReturning({ ok: true, completion: "accepted", data: "stray" });
    const client = createCommandClient(bridge);

    const reply = await client.invoke("terminal.kill", {});

    expect(reply).toEqual({ ok: true, completion: "accepted" });
    expect(Object.hasOwn(reply, "data")).toBe(false);
  });

  it("passes a failure's code, detail and engine text through", async () => {
    const { bridge } = bridgeReturning({
      ok: false,
      code: "REJECTED",
      detail: "the engine refused the command",
      engineText: "model not available",
    });
    const client = createCommandClient(bridge);

    const reply = await client.invoke("device.info", {});

    expect(reply).toEqual({
      ok: false,
      code: "REJECTED",
      detail: "the engine refused the command",
      engineText: "model not available",
    });
  });

  it("omits engineText when the reply had none", async () => {
    const { bridge } = bridgeReturning({
      ok: false,
      code: "NOT_CONNECTED",
      detail: "the engine is not connected",
    });
    const client = createCommandClient(bridge);

    const reply = await client.invoke("device.info", {});

    expect(reply).toEqual({
      ok: false,
      code: "NOT_CONNECTED",
      detail: "the engine is not connected",
    });
    expect(Object.hasOwn(reply, "engineText")).toBe(false);
  });

  it("falls back to the code itself when the value is a shape this build does not know", async () => {
    // The code set is closed for one version of the surface; a newer main process
    // may send a code this renderer has never heard of. That is version skew, not
    // a malformed reply, and the page can still render the token.
    const { bridge } = bridgeReturning({ ok: false, code: "SOME_FUTURE_CODE", detail: "later" });
    const client = createCommandClient(bridge);

    const reply = await client.invoke("device.info", {});

    expect(reply).toEqual({ ok: false, code: "SOME_FUTURE_CODE", detail: "later" });
  });

  it("turns a bridge rejection into COMMAND_CHANNEL_UNAVAILABLE instead of throwing", async () => {
    const client = createCommandClient(bridgeRejecting());

    const reply = await client.invoke("device.info", {});

    expect(reply).toMatchObject({ ok: false, code: "COMMAND_CHANNEL_UNAVAILABLE" });
  });

  it("refuses a malformed reply with COMMAND_BAD_PAYLOAD, for every malformed shape", async () => {
    const malformed: unknown[] = [
      null,
      undefined,
      42,
      "answered",
      [],
      {},
      { ok: "true", completion: "answered", data: null },
      { ok: true },
      { ok: true, completion: "unknown" },
      { ok: true, completion: "answered" },
      { ok: false },
      { ok: false, code: "" },
      { ok: false, code: 42 },
      { ok: false, code: "REJECTED", detail: 42 },
      { ok: false, code: "REJECTED", engineText: {} },
    ];

    for (const answer of malformed) {
      const { bridge } = bridgeReturning(answer);
      const client = createCommandClient(bridge);

      const reply = await client.invoke("device.info", {});

      if (reply.ok) {
        throw new Error(`expected a refusal for ${JSON.stringify(answer)}`);
      }

      expect(reply.code).toBe("COMMAND_BAD_PAYLOAD");
      // The detail is a log line, so it stays English ASCII like every other
      // detail this repository writes.
      expect(reply.detail).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  it("keeps a refusal it produced readable in the reply type", async () => {
    const client = createCommandClient(bridgeReturning(null).bridge);

    const reply: CommandReply = await client.invoke("device.info", {});

    expect(reply).toEqual({
      ok: false,
      code: "COMMAND_BAD_PAYLOAD",
      detail: "the command reply is not a plain object",
    });
  });

  it("calls the bridge once per invoke, with no retry", async () => {
    const invoke = vi.fn(async () => ({ ok: false, code: "NOT_CONNECTED" }));
    const client = createCommandClient({ invoke });

    await client.invoke("device.info", {});
    await client.invoke("device.info", {});

    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
