/**
 * Tests for the core command dispatcher.
 *
 * What this suite is pinning, and why in this shape
 *   The dispatcher is a *sequence* of gates, so the cases are written in the
 *   order the gates run and each one asserts the side effect that gate is
 *   supposed to prevent: no channel lookup, no `send`, exactly one `send`. An
 *   error-code-only assertion would stay green if the dispatcher validated
 *   everything after it had already sent, which is the one failure mode a
 *   command layer must never have.
 *
 *   Two groups are about *derivation* rather than refusal: `answered` versus
 *   `accepted` (a table lookup the page must not repeat) and the passthrough of
 *   the engine client's own codes (`REJECTED`, `NOT_CONNECTED` are the two a
 *   user actually sees). The rest pin the four envelope refusals and the
 *   channel-unavailable arm.
 *
 * Capability names used here are real rows of the frozen table, chosen for the
 * classification they exercise: `device.info` is a no-scope request/response,
 * `conversation.sync` is a scoped request/response, `file.watch` is silent,
 * `terminal.spawn` is id-less, `file.ops` is duplex, and `device.setState` is a
 * scoped id-less command. Picking a name at random would make the
 * `answered`/`accepted` cases depend on the table instead of documenting it.
 */

import { describe, expect, it } from "vitest";

import type { CapabilityName } from "../engine/client/capability-names.js";
import { isCapabilityName } from "../engine/client/capability-names.js";
import type { CommandRequest, CommandResult, RuntimeScope } from "../engine/client/types.js";

import { CONTROL_AGENT_ID, createCommandDispatcher } from "./dispatch.js";
import type {
  CommandDispatcher,
  CommandDispatcherOptions,
  CommandSendChannel,
} from "./dispatch.js";
import { COMMAND_LAYER_ERROR_CODES } from "./types.js";
import type { CommandCall, CommandReply } from "./types.js";

/** A no-scope capability whose completion mode is `response`. */
const ANSWERED = "device.info";
/** A scoped capability whose completion mode is `response`. */
const SCOPED_ANSWERED = "conversation.sync";
/** A capability that carries a request id and never answers. */
const SILENT = "file.watch";
/** A capability whose wire has no request id at all. */
const UNTRACKED = "terminal.spawn";
/** A bidirectional wire: no request/reply pairing exists. */
const DUPLEX = "file.ops";
/** A scoped capability whose completion mode is not `response`. */
const SCOPED_ACCEPTED = "device.setState";

const SCOPE: RuntimeScope = { agent_id: "agent-1", conversation_id: "conv-1" };
const UNBOUND_SCOPE: RuntimeScope = { agent_id: null, conversation_id: "conv-1" };

/** Build a call, omitting `runtime` entirely when it is not part of the case. */
function call(
  capability: string,
  body: Record<string, unknown> = {},
  runtime?: RuntimeScope,
): CommandCall {
  return runtime === undefined ? { capability, body } : { capability, body, runtime };
}

/** A successful channel answer with a decoded body. */
function okResult(data: unknown): CommandResult {
  return { ok: true, data, raw: {} };
}

/** A classified channel failure, with the engine's words only when asked for. */
function errorResult(
  code: "REJECTED" | "NOT_CONNECTED" | "TIMEOUT",
  engineText?: string,
): CommandResult {
  return engineText === undefined
    ? { ok: false, error: { code, detail: `the channel classified this as ${code}` } }
    : { ok: false, error: { code, detail: `the channel classified this as ${code}`, engineText } };
}

/** A channel that records every request and answers with one fixed result. */
function recordingChannel(result: CommandResult): {
  channel: CommandSendChannel;
  requests: CommandRequest[];
} {
  const requests: CommandRequest[] = [];
  return {
    requests,
    channel: {
      send: (request) => {
        requests.push(request);
        return Promise.resolve(result);
      },
    },
  };
}

/** The dispatcher plus the agent ids its lookup was asked for, in order. */
function withLookup(
  channel: CommandSendChannel | undefined,
  options: Omit<CommandDispatcherOptions, "getChannel"> = {},
): { dispatcher: CommandDispatcher; agentIds: string[] } {
  const agentIds: string[] = [];
  const dispatcher = createCommandDispatcher({
    getChannel: (agentId) => {
      agentIds.push(agentId);
      return channel;
    },
    ...options,
  });
  return { dispatcher, agentIds };
}

/** Narrow a reply to its failure arm, failing the test on a success. */
function failure(reply: CommandReply): Extract<CommandReply, { ok: false }> {
  if (reply.ok) {
    throw new Error("expected a failure reply");
  }
  return reply;
}

describe("command envelope: the call itself", () => {
  it("refuses a call that is not a plain object without touching the pool", async () => {
    const { dispatcher, agentIds } = withLookup(recordingChannel(okResult(undefined)).channel);

    for (const bad of [null, undefined, 42, "device.info", [], [{ capability: ANSWERED }]]) {
      const reply = await dispatcher.invoke(bad as unknown as CommandCall);
      expect(failure(reply).code).toBe("COMMAND_BAD_PAYLOAD");
    }

    expect(agentIds).toEqual([]);
  });

  it("refuses a capability that is not a name in the frozen table", async () => {
    const { channel, requests } = recordingChannel(okResult(undefined));
    const { dispatcher, agentIds } = withLookup(channel);

    const cases: unknown[] = ["not.a.capability", "", "   ", "DEVICE.INFO", 42, null, undefined];
    for (const capability of cases) {
      const reply = await dispatcher.invoke({ capability, body: {} } as unknown as CommandCall);
      expect(failure(reply).code).toBe("COMMAND_UNKNOWN_CAPABILITY");
    }

    expect(requests).toEqual([]);
    expect(agentIds).toEqual([]);
  });

  it("treats every name in the table as known, and only those", () => {
    // The dispatcher's gate is the table's own predicate; a name the table does
    // not have must never be forwarded, and this pins that the two agree.
    expect(isCapabilityName(ANSWERED)).toBe(true);
    expect(isCapabilityName(SCOPED_ANSWERED)).toBe(true);
    expect(isCapabilityName("device.unknown")).toBe(false);
  });
});

describe("availability gate", () => {
  it("refuses a capability this runtime does not offer, before the payload is read", async () => {
    const { channel, requests } = recordingChannel(okResult(undefined));
    const seen: CapabilityName[] = [];
    const { dispatcher } = withLookup(channel, {
      isAvailable: (capability) => {
        seen.push(capability);
        return false;
      },
    });

    // A body that would otherwise be refused: the unavailable answer must come
    // first, because the caller's next step is to hide the affordance.
    const reply = await dispatcher.invoke(call(ANSWERED, { runtime: "not allowed here" }));

    expect(failure(reply).code).toBe("COMMAND_CAPABILITY_UNAVAILABLE");
    expect(seen).toEqual([ANSWERED]);
    expect(requests).toEqual([]);
  });

  it("sends when the gate says yes, and sends when there is no gate at all", async () => {
    const gated = recordingChannel(okResult({ backend: "fake" }));
    const withGate = withLookup(gated.channel, { isAvailable: () => true });

    const gatedReply = await withGate.dispatcher.invoke(call(ANSWERED));
    expect(gatedReply).toEqual({ ok: true, completion: "answered", data: { backend: "fake" } });
    expect(gated.requests).toHaveLength(1);

    const ungated = recordingChannel(okResult({ backend: "fake" }));
    const withoutGate = withLookup(ungated.channel);
    await withoutGate.dispatcher.invoke(call(ANSWERED));
    expect(ungated.requests).toHaveLength(1);
  });
});

describe("runtime scope", () => {
  it("requires a scope for a scoped capability and refuses before the body is read", async () => {
    const { channel, requests } = recordingChannel(okResult(undefined));
    const { dispatcher } = withLookup(channel);

    // The body smuggles an envelope key, which is a payload failure - but the
    // missing scope is the earlier question and must win.
    const reply = await dispatcher.invoke(call(SCOPED_ANSWERED, { runtime: SCOPE }));

    expect(failure(reply).code).toBe("COMMAND_SCOPE_REQUIRED");
    expect(requests).toEqual([]);
  });

  it("refuses a runtime whose shape is not the frozen one", async () => {
    const { channel, requests } = recordingChannel(okResult({}));
    const { dispatcher } = withLookup(channel);

    const malformed: unknown[] = [
      null,
      [],
      "agent-1",
      {},
      { conversation_id: "conv-1" },
      { agent_id: 42, conversation_id: "conv-1" },
      { agent_id: "agent-1" },
      { agent_id: "agent-1", conversation_id: null },
      { agent_id: "agent-1", conversation_id: 7 },
    ];

    for (const runtime of malformed) {
      const reply = await dispatcher.invoke({
        capability: SCOPED_ANSWERED,
        body: {},
        runtime,
      } as unknown as CommandCall);
      expect(failure(reply).code).toBe("COMMAND_SCOPE_REQUIRED");
    }

    expect(requests).toEqual([]);
  });

  it("forwards a valid scope as a sibling of the body", async () => {
    const { channel, requests } = recordingChannel(okResult({ replayed: true }));
    const { dispatcher } = withLookup(channel);

    const reply = await dispatcher.invoke(call(SCOPED_ANSWERED, { reason: "resume" }, SCOPE));

    expect(reply).toEqual({ ok: true, completion: "answered", data: { replayed: true } });
    expect(requests).toEqual([
      { capability: SCOPED_ANSWERED, body: { reason: "resume" }, runtime: SCOPE },
    ]);
  });

  it("forwards a scope on an unscoped capability when the caller sent one", async () => {
    const { channel, requests } = recordingChannel(okResult({}));
    const { dispatcher } = withLookup(channel);

    await dispatcher.invoke(call(UNTRACKED, {}, SCOPE));

    expect(requests).toEqual([{ capability: UNTRACKED, body: {}, runtime: SCOPE }]);
  });
});

describe("payload", () => {
  it("refuses a body that is not a plain object", async () => {
    const { channel, requests } = recordingChannel(okResult({}));
    const { dispatcher } = withLookup(channel);

    const badBodies: unknown[] = [null, undefined, 42, "text", [], ["a"], new Date(0)];
    for (const body of badBodies) {
      const reply = await dispatcher.invoke({
        capability: ANSWERED,
        body,
      } as unknown as CommandCall);
      expect(failure(reply).code).toBe("COMMAND_BAD_PAYLOAD");
    }

    expect(requests).toEqual([]);
  });

  it("refuses a body carrying an envelope key, and names every one it found", async () => {
    const { channel, requests } = recordingChannel(okResult({}));
    const { dispatcher } = withLookup(channel);

    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ runtime: SCOPE }, ["runtime"]],
      [{ requestId: "r-1" }, ["requestId"]],
      [{ request_id: "r-1" }, ["request_id"]],
      [{ type: "message.send" }, ["type"]],
      [{ capability: ANSWERED }, ["capability"]],
      [{ runtime: SCOPE, type: "x", capability: "y" }, ["capability", "runtime", "type"]],
    ];

    for (const [body, expected] of cases) {
      const reply = await dispatcher.invoke(call(ANSWERED, body));
      const { code, detail } = failure(reply);
      expect(code).toBe("COMMAND_BAD_PAYLOAD");
      for (const key of expected) {
        expect(detail).toContain(key);
      }
    }

    expect(requests).toEqual([]);
  });

  it("refuses an envelope key even when its value is undefined", async () => {
    // Presence is the rule, not truthiness: a caller that wrote the key built
    // the wrong request whether or not it filled it in.
    const { channel, requests } = recordingChannel(okResult({}));
    const { dispatcher } = withLookup(channel);

    const reply = await dispatcher.invoke(call(ANSWERED, { runtime: undefined }));

    expect(failure(reply).code).toBe("COMMAND_BAD_PAYLOAD");
    expect(requests).toEqual([]);
  });

  it("forwards a body with lookalike keys verbatim", async () => {
    const { channel, requests } = recordingChannel(okResult({}));
    const { dispatcher } = withLookup(channel);

    const body = { runtimeId: "keep", types: ["a"], requestIdentifier: "keep" };
    await dispatcher.invoke(call(ANSWERED, body));

    expect(requests[0]?.body).toEqual(body);
    expect(requests[0]?.body).toBe(body);
  });
});

describe("channel routing", () => {
  it("uses the control channel for a call without a scope", async () => {
    const { channel, requests } = recordingChannel(okResult({}));
    const { dispatcher, agentIds } = withLookup(channel);

    await dispatcher.invoke(call(ANSWERED));

    expect(agentIds).toEqual(["__control__"]);
    expect(CONTROL_AGENT_ID).toBe("__control__");
    expect(requests).toHaveLength(1);
  });

  it("uses the control channel when the scope names no agent", async () => {
    const { channel } = recordingChannel(okResult({}));
    const { dispatcher, agentIds } = withLookup(channel);

    await dispatcher.invoke(call(ANSWERED, {}, UNBOUND_SCOPE));

    expect(agentIds).toEqual(["__control__"]);
  });

  it("uses the agent's channel when the scope names one", async () => {
    const { channel, requests } = recordingChannel(okResult({}));
    const { dispatcher, agentIds } = withLookup(channel);

    await dispatcher.invoke(call(SCOPED_ACCEPTED, {}, SCOPE));

    expect(agentIds).toEqual(["agent-1"]);
    expect(requests).toEqual([{ capability: SCOPED_ACCEPTED, body: {}, runtime: SCOPE }]);
  });

  it("reports an unavailable channel instead of sending or throwing", async () => {
    const { dispatcher, agentIds } = withLookup(undefined);

    const unscoped = await dispatcher.invoke(call(ANSWERED));
    expect(failure(unscoped).code).toBe("COMMAND_CHANNEL_UNAVAILABLE");

    const scoped = await dispatcher.invoke(call(SCOPED_ANSWERED, {}, SCOPE));
    expect(failure(scoped).code).toBe("COMMAND_CHANNEL_UNAVAILABLE");

    // The lookup is asked in the same order as the routing cases: control for
    // the unscoped call, the named agent for the scoped one.
    expect(agentIds).toEqual(["__control__", "agent-1"]);
  });
});

describe("reply derivation", () => {
  it("answers for a capability whose completion mode is response", async () => {
    const { channel } = recordingChannel(okResult({ backend: "fake", version: "0.9.0" }));
    const { dispatcher } = withLookup(channel);

    const reply = await dispatcher.invoke(call(ANSWERED));

    expect(reply).toEqual({
      ok: true,
      completion: "answered",
      data: { backend: "fake", version: "0.9.0" },
    });
  });

  it("accepts for silent, id-less and duplex capabilities alike", async () => {
    for (const capability of [SILENT, UNTRACKED, DUPLEX]) {
      const { channel, requests } = recordingChannel(okResult({ ignored: true }));
      const { dispatcher } = withLookup(channel);

      const reply = await dispatcher.invoke(call(capability));

      expect(reply).toEqual({ ok: true, completion: "accepted" });
      // `accepted` never carries a body: the decoded answer is not an answer to
      // this command, and surfacing it would invite treating it as one.
      expect(Object.hasOwn(reply, "data")).toBe(false);
      expect(requests).toHaveLength(1);
    }
  });

  it("accepts for a scoped capability whose completion mode is not response", async () => {
    const { channel } = recordingChannel(okResult(undefined));
    const { dispatcher } = withLookup(channel);

    const reply = await dispatcher.invoke(call(SCOPED_ACCEPTED, { enabled: true }, SCOPE));

    expect(reply).toEqual({ ok: true, completion: "accepted" });
  });

  it("passes REJECTED through with the engine's own words", async () => {
    const { channel } = recordingChannel(errorResult("REJECTED", "model not available"));
    const { dispatcher } = withLookup(channel);

    const reply = failure(await dispatcher.invoke(call(ANSWERED)));

    expect(reply.code).toBe("REJECTED");
    expect(reply.detail).toBe("the channel classified this as REJECTED");
    expect(reply.engineText).toBe("model not available");
  });

  it("passes NOT_CONNECTED through and omits engineText when there was none", async () => {
    const { channel } = recordingChannel(errorResult("NOT_CONNECTED"));
    const { dispatcher } = withLookup(channel);

    const reply = failure(await dispatcher.invoke(call(SCOPED_ANSWERED, {}, SCOPE)));

    expect(reply.code).toBe("NOT_CONNECTED");
    // Absent, not `undefined`: the key's presence is what a later reader sees.
    expect(Object.hasOwn(reply, "engineText")).toBe(false);
  });

  it("does not retry and does not batch", async () => {
    const failing = recordingChannel(errorResult("NOT_CONNECTED"));
    const { dispatcher } = withLookup(failing.channel);

    await dispatcher.invoke(call(ANSWERED));
    await dispatcher.invoke(call(ANSWERED));

    // One call, one send: no retry inside a call, no coalescing across calls.
    expect(failing.requests).toHaveLength(2);
  });
});

describe("the layer code set", () => {
  it("is frozen at the five documented codes, in check order", () => {
    expect([...COMMAND_LAYER_ERROR_CODES]).toEqual([
      "COMMAND_UNKNOWN_CAPABILITY",
      "COMMAND_CAPABILITY_UNAVAILABLE",
      "COMMAND_SCOPE_REQUIRED",
      "COMMAND_BAD_PAYLOAD",
      "COMMAND_CHANNEL_UNAVAILABLE",
    ]);
  });

  it("is reachable end to end: every layer code is produced by some call", async () => {
    const { channel } = recordingChannel(okResult({}));

    const scenarios: CommandCall[] = [
      { capability: "not.a.capability", body: {} },
      { capability: SCOPED_ANSWERED, body: {} },
      { capability: ANSWERED, body: { type: "x" } },
    ];

    const produced = new Set<string>();
    for (const scenario of scenarios) {
      produced.add(failure(await withLookup(channel).dispatcher.invoke(scenario)).code);
    }

    produced.add(
      failure(
        await withLookup(channel, { isAvailable: () => false }).dispatcher.invoke(call(ANSWERED)),
      ).code,
    );
    produced.add(failure(await withLookup(undefined).dispatcher.invoke(call(ANSWERED))).code);

    expect([...produced].sort()).toEqual([...COMMAND_LAYER_ERROR_CODES].sort());
  });

  it("keeps every detail English ASCII so a log line survives any locale", async () => {
    const { channel } = recordingChannel(okResult({}));
    const replies: CommandReply[] = [
      await withLookup(channel).dispatcher.invoke(null as unknown as CommandCall),
      await withLookup(channel).dispatcher.invoke({ capability: "nope", body: {} }),
      await withLookup(channel, { isAvailable: () => false }).dispatcher.invoke(call(ANSWERED)),
      await withLookup(channel).dispatcher.invoke(call(SCOPED_ANSWERED, {})),
      await withLookup(channel).dispatcher.invoke(call(ANSWERED, { runtime: {} })),
      await withLookup(undefined).dispatcher.invoke(call(ANSWERED)),
    ];

    for (const reply of replies) {
      const { detail } = failure(reply);
      expect(detail).toBeDefined();
      expect(detail).toMatch(/^[\x20-\x7E]+$/);
    }
  });
});
