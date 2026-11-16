/**
 * Capability snapshot tests: the three states must not collapse.
 *
 * Split out of `channel.test.ts` on responsibility: this suite is about what the
 * channel knows, not about what it sends. Source: docs/26 section 6.4, 
 * section 3.7, decision `D-04`.
 *
 * **Why three states and not "a flag map plus an array".** Before the first
 * frame that carries capability information, the engine's capabilities are
 * *unknown*, not empty. Collapsing `unknown` into `{ booleans: {}, slashCommands:
 * [] }` makes a consumer that renders a command palette on its first paint
 * conclude that every slash command is unavailable - and it would then hide all 14
 * of them until something else refreshed it. `confirmed-empty` is a different
 * fact again: the engine answered, and the answer was nothing, which is worth
 * caching and auditing.
 *
 * The frames below are synthetic and carry a test-owned marker field
 * (`capabilityProbe`) rather than the engine's own field for the advertised list.
 * That is deliberate: which wire field carries the flags and which carries the
 * slash commands is `CapabilityProbePort`'s question, and this
 * suite's question is whether the *three states* are distinguishable. Keeping the
 * marker test-owned is also what keeps this directory free of wire ids.
 */

import { afterEach, describe, expect, it } from "vitest";

import { assertNoLeakedTimers, closeHarnesses, makeHarness } from "./channel-test-support";

/**
 * Close every channel this file built, before the next test runs.
 *
 * Without this, a test that leaves entries in flight hands its timers and
 * unsettled promises to whatever runs next - which passes in isolation and fails
 * in a full run as a `testTimeout` in a test that did nothing wrong.
 */
afterEach(() => {
  // Asserts before it cleans: see `assertNoLeakedTimers`. Calling
  // `closeHarnesses()` first would free the timers and make the check vacuous.
  assertNoLeakedTimers();
});

/**
 * The 10 boolean flags the handshake advertises.
 *
 * Transcribed from the recorded handshake reply frames as capability
 * *concepts*; the point of the case is the count and the pass-through, not the
 * names.
 */
const BOOLEANS = {
  agentManagement: true,
  conversationManagement: true,
  memoryManagement: true,
  resourceStart: true,
  agentFreeConversations: true,
  launchSubagent: true,
  runtimeWorkspaceSandbox: true,
  runtimeExternalToolsUpdate: true,
  structuredOutputs: false,
  splitChannels: false,
} as const;

/** The 14 slash commands the recorded device-status frames advertise. */
const SLASH_COMMANDS = [
  "clear",
  "clear-messages",
  "doctor",
  "dream",
  "reflect",
  "reflection",
  "init",
  "compact",
  "reload",
  "context-limit",
  "channels",
  "toolset",
  "secret",
  "monitor-skip",
] as const;

describe("capability snapshot", () => {
  it("is unknown before any probe frame, with no collections at all", () => {
    // Red when: `unknown` collapses into `{ booleans: {}, slashCommands: [] }`.
    // A consumer would then hide every slash command on the first frame it renders.
    const h = makeHarness();
    const snapshot = h.channel.capabilities();

    expect(snapshot).toEqual({ state: "unknown" });
    expect(snapshot.state).toBe("unknown");
    // The compile-time half of this assertion is `capabilities()`'s return type:
    // reading `booleans` needs a narrow, so a collapsed union is a compile error.
  });

  it("is probed once a frame advertises the slash commands", () => {
    // Red when: the reading is ignored, or the flags and the command list are
    // merged into the wrong state.
    const h = makeHarness();
    h.channel.ingest(
      JSON.stringify({
        type: "known.event",
        capabilityProbe: { booleans: BOOLEANS, slashCommands: SLASH_COMMANDS },
      }),
    );

    const snapshot = h.channel.capabilities();
    expect(snapshot.state).toBe("probed");
    if (snapshot.state === "probed") {
      expect(Object.keys(snapshot.booleans)).toHaveLength(10);
      expect(snapshot.slashCommands).toHaveLength(14);
      expect(snapshot.booleans).toEqual(BOOLEANS);
      expect(snapshot.slashCommands).toEqual(SLASH_COMMANDS);
      expect(snapshot.probedAt).toBe(h.clock.clock.now());
    }
  });

  it("is confirmed-empty when the engine explicitly advertises nothing", () => {
    // Red when: an empty list is treated as "no information", leaving the state at
    // `probed` with an empty array - indistinguishable from a probe that silently
    // returned nothing.
    const h = makeHarness();
    h.channel.ingest(
      JSON.stringify({ type: "known.event", capabilityProbe: { booleans: {}, slashCommands: [] } }),
    );

    const snapshot = h.channel.capabilities();
    expect(snapshot.state).toBe("confirmed-empty");
    expect(snapshot).not.toEqual({ state: "unknown" });
    // And it is not `probed` with an empty list either: the two must not be the
    // same value, which is the point: the three states must not collapse.
    expect(snapshot.state).not.toBe("probed");
  });

  it("stays unknown when a frame carries only the flags", () => {
    // Red when: the flags alone are taken as a completed probe. The handshake
    // arrives before the device status, so that reading would publish an empty
    // slash-command list at exactly the moment the real one has not arrived.
    const h = makeHarness();
    h.channel.ingest(
      JSON.stringify({ type: "known.event", capabilityProbe: { booleans: { flag: true } } }),
    );
    expect(h.channel.capabilities()).toEqual({ state: "unknown" });
  });

  it("returns a snapshot a caller cannot use to mutate the channel", () => {
    // Red when: the internal arrays and flag map are handed out by reference, so a
    // consumer that sorts or edits them corrupts the cached state.
    const h = makeHarness();
    h.channel.ingest(
      JSON.stringify({
        type: "known.event",
        capabilityProbe: { booleans: { flag: true }, slashCommands: ["one"] },
      }),
    );

    const snapshot = h.channel.capabilities();
    if (snapshot.state === "probed") {
      (snapshot.slashCommands as string[]).push("injected");
      (snapshot.booleans as Record<string, boolean>)["flag"] = false;
    }

    const again = h.channel.capabilities();
    expect(again.state).toBe("probed");
    if (again.state === "probed") {
      expect(again.slashCommands).toEqual(["one"]);
      expect(again.booleans["flag"]).toBe(true);
    }
  });

  it("keeps the latest reading when a second probe frame arrives", () => {
    // Red when: only the first reading is stored, so a device-status refresh (29 of
    // them are recorded) cannot update the snapshot.
    const h = makeHarness();
    h.channel.ingest(
      JSON.stringify({ type: "known.event", capabilityProbe: { slashCommands: ["old"] } }),
    );
    h.clock.advance(1_000);
    const secondAt = h.clock.clock.now();
    h.channel.ingest(
      JSON.stringify({ type: "known.event", capabilityProbe: { slashCommands: ["new"] } }),
    );

    const snapshot = h.channel.capabilities();
    expect(snapshot.state).toBe("probed");
    if (snapshot.state === "probed") {
      expect(snapshot.slashCommands).toEqual(["new"]);
      expect(snapshot.probedAt).toBe(secondAt);
    }
  });
});
