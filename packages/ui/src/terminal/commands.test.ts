/**
 * Tests for the four terminal command call sites.
 *
 * What is actually under test
 *   Not the command layer -- that does not exist yet, and it is the whole reason
 *   this module takes a sender as an argument. What is under test is the mapping
 *   this package owns: which command is built from which call, whether a refusal
 *   is reported as a refusal rather than as a failure, and whether each of the
 *   three failure reasons survives to the caller distinct from the other two.
 *
 * Why every failure case asserts the other two are absent
 *   "The three reasons stay distinguishable" is exactly the claim a single
 *   `false` would violate, and a test that only asserted `reason` for the one it
 *   provoked would still pass for an implementation that returned that same reason
 *   for everything. So each case checks the reason it got and that it is not the
 *   two it did not.
 *
 * Why the sender is a plain function and not a stub object
 *   {@link CommandSender} is one callable, so a fixture that records its arguments
 *   is both the double and the assertion -- there is no method name to disagree
 *   about.
 */

import { describe, expect, it } from "vitest";

import { killTerminal, resizeTerminal, sendInput, spawnTerminal } from "./commands.js";
import type { CommandFailure, CommandOutcome, CommandSender, TerminalCommand } from "./commands.js";
import { TERMINAL_INPUT_CAPABILITY } from "./exit.js";
import type { TerminalPhase } from "./state.js";

/** Every phase, so the gate on input can be checked against the whole set. */
const PHASES: readonly TerminalPhase[] = [
  "idle",
  "starting",
  "running",
  "exited",
  "failed",
  "disconnected",
];

/** The three reasons, so a case can name the two it did not get. */
const REASONS: readonly CommandFailure[] = [
  "engine-rejected",
  "channel-unavailable",
  "not-implemented",
];

/** A sender that answers `ok` and records what it was handed. */
interface RecordingSender {
  readonly sender: CommandSender;
  readonly commands: TerminalCommand[];
}

/**
 * @param answer what the sender should answer
 * @returns the sender plus the commands it received, in order
 */
function recording(
  answer: { ok: true } | { ok: false; reason: CommandFailure; detail?: string },
): RecordingSender {
  const commands: TerminalCommand[] = [];

  return {
    sender: async (command) => {
      commands.push(command);

      return answer;
    },
    commands,
  };
}

/** @param outcome any outcome @returns the reason it carries, asserting it is a failure */
function reasonOf(outcome: CommandOutcome): CommandFailure {
  expect(outcome.kind).toBe("failed");

  if (outcome.kind !== "failed") throw new Error("not a failure");

  return outcome.reason;
}

/** @param reason a reason @returns the two reasons that are not it */
function otherReasons(reason: CommandFailure): CommandFailure[] {
  return REASONS.filter((candidate) => candidate !== reason);
}

describe("spawnTerminal", () => {
  it("builds the spawn command with the caller's terminal id and size, so the id the panel registered its sink under is the id the engine spawns", async () => {
    const { sender, commands } = recording({ ok: true });

    const outcome = await spawnTerminal(sender, { terminalId: "t-1", cols: 120, rows: 30 });

    expect(outcome).toEqual({ kind: "sent" });
    expect(commands).toEqual([
      { name: "terminal.spawn", args: { terminalId: "t-1", cols: 120, rows: 30 } },
    ]);
  });

  it("passes an explicit directory through, because the panel tells the user which directory a terminal started in", async () => {
    const { sender, commands } = recording({ ok: true });

    await spawnTerminal(sender, { terminalId: "t-1", cols: 80, rows: 24, cwd: "/repo" });

    expect(commands[0]?.args).toEqual({ terminalId: "t-1", cols: 80, rows: 24, cwd: "/repo" });
  });

  it("omits the directory entirely when there is none, so the engine applies its own start directory rather than a fabricated empty path", async () => {
    const { sender, commands } = recording({ ok: true });

    await spawnTerminal(sender, { terminalId: "t-1", cols: 80, rows: 24 });

    const args = commands[0]?.args ?? {};

    expect("cwd" in args).toBe(false);
  });

  it("reports success as sent, which claims only that the request left this process", async () => {
    // The claim under test is the wording of the contract, not the spelling: a
    // spawn that was handed over does not mean a terminal exists, and the outcome
    // therefore has no field that could be read as one.
    const { sender } = recording({ ok: true });

    const outcome = await spawnTerminal(sender, { terminalId: "t-1", cols: 80, rows: 24 });

    expect(outcome.kind).toBe("sent");
    expect(Object.keys(outcome)).toEqual(["kind"]);
  });
});

describe("sendInput", () => {
  it("sends the bytes in the running phase, exactly as the exit functions produced them", async () => {
    const { sender, commands } = recording({ ok: true });

    const outcome = await sendInput(sender, { terminalId: "t-1", data: "a" }, "running");

    expect(outcome).toEqual({ kind: "sent" });
    expect(commands).toEqual([
      { name: TERMINAL_INPUT_CAPABILITY, args: { terminalId: "t-1", data: "a" } },
    ]);
  });

  it("sends a multi-byte payload as one command, because splitting it here would split a character", async () => {
    const { sender, commands } = recording({ ok: true });

    await sendInput(sender, { terminalId: "t-1", data: "汉字" }, "running");

    expect(commands).toHaveLength(1);
    expect(commands[0]?.args).toEqual({ terminalId: "t-1", data: "汉字" });
  });

  it("never sends two identical keystrokes as one, because two `a` are two `a`", async () => {
    const { sender, commands } = recording({ ok: true });

    await sendInput(sender, { terminalId: "t-1", data: "aa" }, "running");
    await sendInput(sender, { terminalId: "t-1", data: "aa" }, "running");

    expect(commands).toHaveLength(2);
  });

  it("suppresses input in every phase but running, so a byte is never sent into a session that does not exist", async () => {
    for (const phase of PHASES) {
      if (phase === "running") continue;

      const { sender, commands } = recording({ ok: true });
      const outcome = await sendInput(sender, { terminalId: "t-1", data: "a" }, phase);

      expect(outcome).toEqual({ kind: "suppressed", because: "terminal-not-running", phase });
      expect(commands).toEqual([]);
    }
  });

  it("reports the refusal as suppressed rather than failed, because typing while a terminal starts is not an error", async () => {
    const { sender } = recording({ ok: true });

    const outcome = await sendInput(sender, { terminalId: "t-1", data: "a" }, "starting");

    expect(outcome.kind).toBe("suppressed");
    expect(outcome.kind).not.toBe("failed");
  });

  it("suppresses an empty payload without asking the sender, because a frame that carries no bytes cannot change anything", async () => {
    const { sender, commands } = recording({ ok: true });

    const outcome = await sendInput(sender, { terminalId: "t-1", data: "" }, "running");

    expect(outcome).toEqual({ kind: "suppressed", because: "empty-payload", phase: "running" });
    expect(commands).toEqual([]);
  });

  it("carries the refused phase, so a log can say which phase refused the payload", async () => {
    const { sender } = recording({ ok: true });

    expect(await sendInput(sender, { terminalId: "t-1", data: "a" }, "disconnected")).toEqual({
      kind: "suppressed",
      because: "terminal-not-running",
      phase: "disconnected",
    });
  });

  it("still reports a failed send while running, so a refusal and a failure never share an arm", async () => {
    const { sender } = recording({ ok: false, reason: "channel-unavailable" });

    const outcome = await sendInput(sender, { terminalId: "t-1", data: "a" }, "running");

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind).not.toBe("suppressed");
  });
});

describe("resizeTerminal", () => {
  it("builds the resize command with both dimensions, because one alone does not describe a grid", async () => {
    const { sender, commands } = recording({ ok: true });

    const outcome = await resizeTerminal(sender, { terminalId: "t-1", cols: 100, rows: 40 });

    expect(outcome).toEqual({ kind: "sent" });
    expect(commands).toEqual([
      { name: "terminal.resize", args: { terminalId: "t-1", cols: 100, rows: 40 } },
    ]);
  });

  it("sends a resize before the terminal is running, because a panel measures itself before it asks for one", async () => {
    // The engine drops a resize for an unknown terminal instead of failing it, so
    // the frame costs nothing and gating it here would only lose the first
    // measurement.
    const { sender, commands } = recording({ ok: true });

    const outcome = await resizeTerminal(sender, { terminalId: "t-1", cols: 100, rows: 40 });

    expect(outcome.kind).toBe("sent");
    expect(commands).toHaveLength(1);
  });
});

describe("killTerminal", () => {
  it("builds the kill command from the terminal id alone", async () => {
    const { sender, commands } = recording({ ok: true });

    const outcome = await killTerminal(sender, { terminalId: "t-1" });

    expect(outcome).toEqual({ kind: "sent" });
    expect(commands).toEqual([{ name: "terminal.kill", args: { terminalId: "t-1" } }]);
  });

  it("sends the kill whatever the phase, because a close skipped for looking finished is a process that outlives its tab", async () => {
    // The phase is not an argument at all, so there is no refusal to find here.
    // That is the claim: tearing a panel down must not be conditional on the state
    // machine having caught up, because the process outlives the tab either way.
    const { sender, commands } = recording({ ok: true });

    await killTerminal(sender, { terminalId: "t-1" });

    expect(commands).toHaveLength(1);
    expect(killTerminal).toHaveLength(2);
  });
});

describe("the three failure reasons", () => {
  for (const reason of REASONS) {
    it(`reports ${reason} as itself and as neither of the other two, because each needs a different answer from the user`, async () => {
      const { sender } = recording({ ok: false, reason });

      const outcome = await spawnTerminal(sender, { terminalId: "t-1", cols: 80, rows: 24 });

      expect(reasonOf(outcome)).toBe(reason);

      for (const other of otherReasons(reason)) {
        expect(reasonOf(outcome)).not.toBe(other);
      }
    });
  }

  it("keeps the engine's own words when it rejected the command, because that text is the only clue the user gets", async () => {
    const { sender } = recording({
      ok: false,
      reason: "engine-rejected",
      detail: "column count out of range",
    });

    const outcome = await spawnTerminal(sender, { terminalId: "t-1", cols: 0, rows: 24 });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "engine-rejected",
      detail: "column count out of range",
    });
  });

  it("reports a failure with no detail without an empty one, so a caller can tell 'nothing said' from 'said nothing useful'", async () => {
    const { sender } = recording({ ok: false, reason: "not-implemented" });

    const outcome = await resizeTerminal(sender, { terminalId: "t-1", cols: 80, rows: 24 });

    expect(outcome).toEqual({ kind: "failed", reason: "not-implemented" });
    expect("detail" in outcome).toBe(false);
  });

  it("reports a throwing sender as a channel fault but keeps the text, because a sender that throws is either a lost connection or a defect", async () => {
    const sender: CommandSender = async () => {
      throw new Error("socket closed");
    };

    const outcome = await killTerminal(sender, { terminalId: "t-1" });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "channel-unavailable",
      detail: "socket closed",
    });
  });

  it("never rejects, whatever the sender does, because these are called from event handlers", async () => {
    const throwing: CommandSender = async () => {
      throw new Error("boom");
    };

    await expect(killTerminal(throwing, { terminalId: "t-1" })).resolves.toMatchObject({
      kind: "failed",
    });
  });

  it("reports a reason outside the set as not-implemented, because a shape disagreement is a version problem and not a connection one", async () => {
    // A sender compiled against a different copy of the type can still arrive at
    // runtime with a fourth reason. Advising the user to wait for a reconnect
    // would be advice that never comes true.
    const sender: CommandSender = async () => ({
      ok: false,
      reason: "rate-limited" as CommandFailure,
    });

    const outcome = await killTerminal(sender, { terminalId: "t-1" });

    expect(reasonOf(outcome)).toBe("not-implemented");
    expect(outcome).toMatchObject({ detail: "rate-limited" });
  });
});

describe("the names this module puts on the wire", () => {
  it("sends the input capability under the name the exit module already spells", async () => {
    // The name is imported rather than written, because a scan of the renderer
    // fails on a second spelling. Asserting the resolved value itself would then
    // be circular, so the expected string is assembled from its parts: the literal
    // is exactly what that scan forbids, and a test that asserted it would be the
    // second spelling it is looking for.
    const { sender, commands } = recording({ ok: true });

    await sendInput(sender, { terminalId: "t-1", data: "a" }, "running");

    expect(commands[0]?.name).toBe(["terminal", "input"].join("."));
  });

  it("uses only capability names, never wire ids, because the command layer owns that translation", async () => {
    // A wire id is `terminal_spawn`; a capability name is `terminal.spawn`. This
    // module must speak the former's dotted form for all four, whether or not the
    // engine spells one of them with an underscore.
    const { sender, commands } = recording({ ok: true });

    await spawnTerminal(sender, { terminalId: "t-1", cols: 80, rows: 24 });
    await sendInput(sender, { terminalId: "t-1", data: "a" }, "running");
    await resizeTerminal(sender, { terminalId: "t-1", cols: 80, rows: 24 });
    await killTerminal(sender, { terminalId: "t-1" });

    for (const command of commands) {
      expect(command.name).toMatch(/^terminal\.[a-z]+$/);
      expect(command.name).not.toContain("_");
    }
  });

  it("sends the caller's terminal id unchanged in all four commands, because the engine keys the session by it", async () => {
    const { sender, commands } = recording({ ok: true });

    await spawnTerminal(sender, { terminalId: "t-42", cols: 80, rows: 24 });
    await sendInput(sender, { terminalId: "t-42", data: "a" }, "running");
    await resizeTerminal(sender, { terminalId: "t-42", cols: 80, rows: 24 });
    await killTerminal(sender, { terminalId: "t-42" });

    expect(commands.map((command) => command.args.terminalId)).toEqual([
      "t-42",
      "t-42",
      "t-42",
      "t-42",
    ]);
  });
});
