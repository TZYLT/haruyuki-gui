/**
 * The availability tri-state must not collapse into two.
 *
 * Each block below pins one rule:
 *
 * - version gate by `since`, compared numerically (`0.10.0` > `0.9.9`);
 * - an unprobed engine makes gated capabilities `unknown`, never `unavailable`;
 * - a `confirmed-empty` engine makes them `unavailable` (it did say no);
 * - a missing flag is `unknown` (flag-not-advertised), not `feature-off`;
 * - ungated families ignore the probe entirely.
 */
import { describe, expect, it } from "vitest";

import type { CapabilityName } from "@haruyuki/protocol";

import type { CapabilitySnapshot } from "../client/types.js";
import { availabilityOf, isOffered, isVersionAtLeast } from "./availability.js";

const UNPROBED: CapabilitySnapshot = { state: "unknown" };
const EMPTY: CapabilitySnapshot = { state: "confirmed-empty", probedAt: 1 };
const ALL_ON: CapabilitySnapshot = {
  state: "probed",
  booleans: {
    agent_management: true,
    conversation_management: true,
    memory_management: true,
    runtime_start: true,
    launch_subagent: true,
  },
  slashCommands: [],
  probedAt: 1,
};

describe("isVersionAtLeast", () => {
  it("compares numerically, not lexically", () => {
    expect(isVersionAtLeast("0.9.0", "0.10.0")).toBe(true);
    expect(isVersionAtLeast("0.10.0", "0.9.9")).toBe(false);
  });

  it("treats an equal version as new enough", () => {
    expect(isVersionAtLeast("0.6.0", "0.6.0")).toBe(true);
  });

  it("fills missing parts with zero", () => {
    expect(isVersionAtLeast("0.6", "0.6.0")).toBe(true);
    expect(isVersionAtLeast("0.6.1", "0.6")).toBe(false);
  });
});

describe("availabilityOf", () => {
  it("offers a gated capability when the engine says yes", () => {
    expect(availabilityOf("agent.get", ALL_ON, "0.6.0")).toEqual({ state: "available" });
  });

  it("keeps an unprobed engine unknown rather than unavailable", () => {
    expect(availabilityOf("agent.get", UNPROBED, "0.6.0")).toEqual({
      state: "unknown",
      reason: "not-probed",
    });
  });

  it("marks a confirmed-empty engine unavailable", () => {
    expect(availabilityOf("memory.list", EMPTY, "0.6.0")).toEqual({
      state: "unavailable",
      reason: "feature-off",
    });
  });

  it("distinguishes a missing flag from a false one", () => {
    const noSubagent: CapabilitySnapshot = {
      state: "probed",
      booleans: { agent_management: true },
      slashCommands: [],
      probedAt: 1,
    };

    expect(availabilityOf("subagent.launch", noSubagent, "0.6.0")).toEqual({
      state: "unknown",
      reason: "flag-not-advertised",
    });
    expect(
      availabilityOf(
        "subagent.launch",
        { ...ALL_ON, booleans: { launch_subagent: false } },
        "0.6.0",
      ),
    ).toEqual({
      state: "unavailable",
      reason: "feature-off",
    });
  });

  it("gates conversation.switch on conversation management alone", () => {
    // The engine's own runtime flag cannot be named from engine code (its
    // spelling is also a frame name), so switch follows conversation management
    // and lets the command fail loudly when the runtime is missing.
    const noConversations: CapabilitySnapshot = {
      state: "probed",
      booleans: { agent_management: true },
      slashCommands: [],
      probedAt: 1,
    };

    expect(availabilityOf("conversation.switch", noConversations, "0.6.0")).toEqual({
      state: "unknown",
      reason: "flag-not-advertised",
    });
    expect(availabilityOf("conversation.switch", ALL_ON, "0.6.0")).toEqual({
      state: "available",
    });
  });

  it("ignores the probe for ungated families", () => {
    expect(availabilityOf("workspace.list", EMPTY, "0.6.0")).toEqual({ state: "available" });
    expect(availabilityOf("workspace.list", UNPROBED, "0.6.0")).toEqual({ state: "available" });
  });

  it("rejects a capability newer than the engine even when advertised", () => {
    // A literal member, not a cast: the cast would have hidden a renamed row.
    expect(availabilityOf("workspace.tree", ALL_ON, "0.0.1")).toEqual({
      state: "unavailable",
      reason: "engine-too-old",
    });
  });

  it("shows unknown capabilities and hides only unavailable ones", () => {
    expect(isOffered({ state: "available" })).toBe(true);
    expect(isOffered({ state: "unknown", reason: "not-probed" })).toBe(true);
    expect(isOffered({ state: "unavailable", reason: "feature-off" })).toBe(false);
  });
});
