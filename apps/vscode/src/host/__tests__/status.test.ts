/**
 * The status bar: five states, one command, and the facts a bug report needs.
 *
 * No editor is involved. `StatusBarItem` is five members, so the double here is
 * a plain recorder and the assertions are about the words and the tooltip the
 * user would see.
 *
 * The five-state case is the one that matters: a shell that collapses
 * `starting` and `failed` into "not ready" tells a user to wait when it has
 * already given up, so every state is asserted to render its own word.
 */

import { describe, expect, it } from "vitest";

import type { CoreStatusSnapshot } from "../../core/ipc.js";
import {
  createStatusBar,
  stateForPhase,
  STATUS_STATES,
  type StatusBarLike,
  type StatusState,
} from "../status.js";

/** A `StatusBarItem` that records every write instead of showing anything. */
function fakeItem(): {
  readonly item: StatusBarLike;
  readonly writes: string[];
  readonly shown: () => number;
  readonly hidden: () => number;
} {
  const writes: string[] = [];
  let shows = 0;
  let hides = 0;

  const item: StatusBarLike = {
    text: "",
    tooltip: undefined,
    command: undefined,
    show(): void {
      shows += 1;
      writes.push("show");
    },
    hide(): void {
      hides += 1;
      writes.push("hide");
    },
  };

  return { item, writes, shown: () => shows, hidden: () => hides };
}

/** One status snapshot as the core sends it. */
function snapshot(
  phase: CoreStatusSnapshot["phase"],
  extra: Partial<CoreStatusSnapshot> = {},
): CoreStatusSnapshot {
  return { phase, ...extra };
}

/** The one line of a tooltip that carries a fact, or `""`. */
function tooltipLine(tooltip: unknown, prefix: string): string {
  return typeof tooltip === "string"
    ? (tooltip.split("\n").find((l) => l.startsWith(prefix)) ?? "")
    : "";
}

describe("status bar: the five states", () => {
  it("renders a distinct word for each of the five states", () => {
    const { item } = fakeItem();
    const bar = createStatusBar({ item });

    const rendered = STATUS_STATES.map((state) => bar.textFor(state));

    expect(STATUS_STATES).toHaveLength(5);
    // Five states, five different texts: a mapping that reuses a word would
    // pass a "renders something" assertion and fail this one.
    expect(new Set(rendered).size).toBe(5);

    expect(bar.textFor("inactive")).toContain("Idle");
    expect(bar.textFor("starting")).toContain("Starting");
    expect(bar.textFor("connected")).toContain("Connected");
    expect(bar.textFor("disconnected")).toContain("Disconnected");
    expect(bar.textFor("failed")).toContain("Failed");
  });

  it("maps every core phase onto exactly one of the five states", () => {
    expect(stateForPhase("starting")).toBe("starting");
    expect(stateForPhase("ready")).toBe("connected");
    expect(stateForPhase("stopped")).toBe("disconnected");
    expect(stateForPhase("failed")).toBe("failed");
  });

  it("shows starting, connected, disconnected and failed as four different items", () => {
    const { item } = fakeItem();
    const bar = createStatusBar({ item });

    const seen = new Map<StatusState, string>();

    for (const state of ["starting", "connected", "disconnected", "failed"] as const) {
      bar.set(state);
      seen.set(state, item.text);
    }

    expect(new Set(seen.values()).size).toBe(4);
    expect(bar.state).toBe("failed");
  });

  it("starts idle and hidden, then shows on the first real state", () => {
    const recorder = fakeItem();
    const bar = createStatusBar({ item: recorder.item });

    // `createStatusBarItem` hands back a hidden item, so an idle bar writes no
    // transition at all rather than a show followed by a hide.
    expect(bar.state).toBe("inactive");
    expect(recorder.item.text).toContain("Idle");
    expect(recorder.shown()).toBe(0);
    expect(recorder.hidden()).toBe(0);

    bar.set("starting");

    expect(recorder.shown()).toBe(1);

    // Idle hides it again; a second idle writes no third transition.
    bar.set("inactive");
    bar.set("inactive");

    expect(recorder.hidden()).toBe(1);
  });

  it("returns to idle from the terminal states without a second show", () => {
    const recorder = fakeItem();
    const bar = createStatusBar({ item: recorder.item });

    bar.set("connected");
    bar.set("disconnected");
    bar.set("failed");

    // Four states, one show and no hide: the item stays visible throughout.
    expect(recorder.shown()).toBe(1);
    expect(recorder.hidden()).toBe(0);

    bar.set("inactive");

    expect(recorder.hidden()).toBe(1);
  });
});

describe("status bar: what it reports", () => {
  it("carries the three facts a bug report needs in the tooltip", () => {
    const { item } = fakeItem();
    const bar = createStatusBar({ item, appVersion: "9.9.9" });

    bar.apply(snapshot("ready", { engineVersion: "0.6.0", source: "bundled", cwd: "/tmp/engine" }));

    const tooltip = item.tooltip;

    expect(typeof tooltip).toBe("string");
    expect(tooltipLine(tooltip, "App version:")).toBe("App version: 9.9.9");
    expect(tooltipLine(tooltip, "Tested engine:")).toBe("Tested engine: 0.6.0");
    expect(tooltipLine(tooltip, "Engine version:")).toBe("Engine version: 0.6.0");
    expect(tooltipLine(tooltip, "Engine source:")).toBe("Engine source: bundled");
    expect(tooltipLine(tooltip, "Working directory:")).toBe("Working directory: /tmp/engine");
  });

  it("names the version and origin it does not have instead of dropping the line", () => {
    const { item } = fakeItem();
    const bar = createStatusBar({ item });

    bar.set("failed");

    expect(tooltipLine(item.tooltip, "Engine version:")).toBe("Engine version: not reported");
    expect(tooltipLine(item.tooltip, "Engine source:")).toBe("Engine source: unknown");
    expect(tooltipLine(item.tooltip, "Working directory:")).toBe("Working directory: unknown");
  });

  it("is an entry point to the panel in every state", () => {
    const { item } = fakeItem();
    const bar = createStatusBar({ item });

    // Even before anything runs.
    expect(item.command).toBe("haruyuki.openPanel");

    for (const state of STATUS_STATES) {
      bar.set(state);

      expect(item.command).toBe("haruyuki.openPanel");
    }
  });

  it("applies a core snapshot and reports a failure kind without its detail", () => {
    const { item } = fakeItem();
    const codes: string[] = [];
    const bar = createStatusBar({
      item,
      log: (code) => codes.push(code),
    });

    bar.apply(
      snapshot("failed", {
        failure: { kind: "start-failed", detail: "a sentence carrying whatever was captured" },
        cwd: "/tmp/engine",
      }),
    );

    expect(bar.state).toBe("failed");
    expect(codes).toEqual(["HOST_STATUS_FAILED"]);
  });

  it("does not rewrite the item when the same state and facts arrive twice", () => {
    const recorder = fakeItem();
    const bar = createStatusBar({ item: recorder.item });

    bar.apply(snapshot("ready", { engineVersion: "0.6.0" }));
    const after = recorder.writes.length;
    const text = recorder.item.text;

    bar.apply(snapshot("ready", { engineVersion: "0.6.0" }));

    // Same state, same facts: the tooltip still names the old version.
    expect(tooltipLine(recorder.item.tooltip, "Engine version:")).toBe("Engine version: 0.6.0");
    expect(recorder.writes.length).toBe(after);
    expect(recorder.item.text).toBe(text);

    // A new fact is a new render, not a no-op. The item's text is the state word
    // alone, so a memo that ignores the facts is only visible in the tooltip --
    // which is exactly where the third fact line lives.
    bar.apply(snapshot("ready", { engineVersion: "0.6.1" }));

    expect(tooltipLine(recorder.item.tooltip, "Engine version:")).toBe("Engine version: 0.6.1");
    expect(recorder.item.text).toBe(text);
    expect(recorder.writes.length).toBe(after);
  });
});
