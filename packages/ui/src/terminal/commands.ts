/**
 * The four terminal commands, as call sites rather than a command layer.
 *
 * Why this file exists at all
 *   The renderer has no way to ask the engine to do something: the command layer
 *   that would carry a business command from a page to the core belongs to
 *   another work stream and has not been delivered yet. So this module is the one
 *   place in the renderer that knows the shape of that layer. When the layer
 *   arrives, its shape is reconciled here and nowhere else -- the panel keeps
 *   calling `spawnTerminal` / `sendInput` / `resizeTerminal` / `killTerminal`,
 *   and no component is rewritten.
 *
 * Success means "handed over", not "done"
 *   This is the easiest thing here to misread, so it is stated first. All four
 *   commands are fire-and-forget on the wire: they carry no request id, the
 *   engine answers none of them, and the command layer resolves as soon as the
 *   write returns. A successful `spawnTerminal` therefore does not mean a
 *   terminal exists -- it means the request left this process. The terminal
 *   exists only when the engine pushes the frame that says so, and that frame
 *   goes to the phase machine, not here. A caller that treated a resolved
 *   promise as "the terminal is up" would enable input for a process that may
 *   never be created, and nothing in the response would contradict it.
 *
 * Three failures, never one boolean
 *   The command layer reports why a command could not be sent, and the three
 *   answers have three different correct responses, so collapsing them into
 *   `false` would make the panel guess:
 *
 *   - `engine-rejected`      the engine answered and said no. The user has to see
 *                            what it said, because the text is the only clue.
 *   - `channel-unavailable`  there is no live channel: not connected yet, or the
 *                            connection went away. The answer is to wait; a
 *                            retry after a recovery is expected to work.
 *   - `not-implemented`      the command layer does not have this command, or the
 *                            running engine does not implement the capability.
 *                            This is a version or capability mismatch: retrying
 *                            is pointless, and the entry should be disabled
 *                            rather than offered again.
 *
 *   The caller branches on `reason`, which is a closed set, not on the message
 *   text. See {@link CommandFailure} for why nothing here reads prose.
 *
 * A refusal is not a failure
 *   {@link SendInputOutcome} has a third arm, `suppressed`, and it is not a
 *   failure: typing while the terminal is still starting is an ordinary thing a
 *   user does, and reporting it as a failed command would show an error for a
 *   keystroke. Keeping the refusal out of the failure set is what makes "the
 *   panel shows an error" mean something.
 *
 * Pure with respect to everything but the sender: no DOM, no terminal instance,
 * no timer, no clock, no import from the engine or the protocol package.
 */

import { TERMINAL_INPUT_CAPABILITY } from "./exit.js";
import type { TerminalPhase } from "./state.js";

/**
 * One command, in the shape the command layer consumes.
 *
 * The field names are camelCase and the wire's are not: this is the shape the
 * renderer speaks, and converting it is the command layer's job. That split is
 * what lets this file be the only renderer module that has to change if the layer
 * spells its arguments differently.
 */
export type TerminalCommand =
  | {
      readonly name: "terminal.spawn";
      readonly args: {
        readonly terminalId: string;
        readonly cols: number;
        readonly rows: number;
        readonly cwd?: string;
      };
    }
  | {
      // Spelled as `typeof` of the imported constant rather than as a literal.
      // The module that produces input bytes already spells this name, and a
      // scan of the renderer fails on any second spelling -- a copy here would
      // be exactly the second producer that scan exists to find, even though it
      // is only a type. Importing it keeps the name in one place.
      readonly name: typeof TERMINAL_INPUT_CAPABILITY;
      readonly args: { readonly terminalId: string; readonly data: string };
    }
  | {
      readonly name: "terminal.resize";
      readonly args: { readonly terminalId: string; readonly cols: number; readonly rows: number };
    }
  | { readonly name: "terminal.kill"; readonly args: { readonly terminalId: string } };

/** Why a command could not be handed to the engine. A closed set, on purpose. */
export type CommandFailure =
  // The engine answered and refused. `detail` is the engine's own words.
  | "engine-rejected"
  // No live channel: not connected, or the connection went away.
  | "channel-unavailable"
  // The command layer has no such command, or the engine has no such capability.
  | "not-implemented";

/**
 * The command layer, as this package needs it.
 *
 * A rejected promise is not part of the contract -- a sender reports a failure as
 * a value so that the reason survives to the caller. One that throws anyway is
 * handled (see {@link classify}) rather than allowed to escape into an event
 * handler, where it would become an unhandled rejection.
 */
export type CommandSender = (
  command: TerminalCommand,
) => Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CommandFailure; readonly detail?: string }
>;

/**
 * What a command call produced, discriminated by `kind` rather than by a boolean.
 *
 * `sent` is deliberately not called "succeeded": it claims the command left the
 * process and nothing more. There is no `pid` and no `phase` field here for the
 * same reason -- the only evidence a terminal exists arrives as a pushed frame.
 */
export type CommandOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "failed"; readonly reason: CommandFailure; readonly detail?: string }
  | {
      readonly kind: "suppressed";
      /** Why nothing was sent. */
      readonly because: "terminal-not-running" | "empty-payload";
      /** The phase that refused it, so a caller can reproduce the decision in a log. */
      readonly phase: TerminalPhase;
    };

/**
 * The four capability names, spelled once.
 *
 * The input name is imported rather than written, because the module that
 * produces input bytes already spells it and a test scans the renderer for a
 * second spelling: a copy here would make that scan fail, and the failure is the
 * point. The other three have no other producer, so they are named here.
 */
const SPAWN = "terminal.spawn";
const RESIZE = "terminal.resize";
const KILL = "terminal.kill";

/**
 * Hand one command to the sender and translate its answer.
 *
 * @param sender the command layer, injected so this module has no dependency on it
 * @param command the command to send, verbatim
 * @returns the outcome; never rejects
 */
async function hand(sender: CommandSender, command: TerminalCommand): Promise<CommandOutcome> {
  try {
    const answer = await sender(command);

    if (answer.ok) return { kind: "sent" };

    return classify(answer.reason, answer.detail);
  } catch (thrown) {
    // A sender that throws instead of answering did not carry the command: the
    // write itself failed, or the connection settled under the call. That is a
    // channel problem whatever the exception's class is, so it is reported as
    // one -- but the text is kept, because a throwing sender is also how a bug in
    // the command layer would surface, and swallowing that text would leave the
    // caller with a "connection" message for a defect.
    return {
      kind: "failed",
      reason: "channel-unavailable",
      detail: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}

/**
 * Translate the command layer's reason into this module's outcome.
 *
 * @param reason the reason the sender reported
 * @param detail a human-readable detail, if the sender had one
 * @returns a failed outcome carrying one of the three reasons
 */
function classify(reason: CommandFailure, detail?: string): CommandOutcome {
  switch (reason) {
    case "engine-rejected":
    case "channel-unavailable":
    case "not-implemented":
      return detail === undefined ? { kind: "failed", reason } : { kind: "failed", reason, detail };

    default:
      // Unreachable in a type-correct build. A reason outside the set at runtime
      // means the command layer and this module disagree about the shape they
      // share, which is the same situation as a missing command: the version
      // skew is the problem, and a retry will reproduce it. Reporting it as a
      // connection fault instead would advise the user to wait for a recovery
      // that cannot happen.
      return { kind: "failed", reason: "not-implemented", detail: String(reason) };
  }
}

/**
 * Ask the engine to open a terminal.
 *
 * @param sender the command layer
 * @param request the terminal to create, its size, and the directory to start in
 * @returns the outcome; `sent` does not mean the terminal exists
 */
export async function spawnTerminal(
  sender: CommandSender,
  request: {
    readonly terminalId: string;
    readonly cols: number;
    readonly rows: number;
    readonly cwd?: string;
  },
): Promise<CommandOutcome> {
  // An omitted `cwd` is left out of the command rather than sent as `undefined`,
  // so the engine falls back to its own start directory. The distinction the
  // panel shows ("this directory" versus "the engine's default") therefore
  // survives the handover intact instead of depending on how a sparser layer
  // treats a present-but-empty field.
  const args =
    request.cwd === undefined
      ? { terminalId: request.terminalId, cols: request.cols, rows: request.rows }
      : {
          terminalId: request.terminalId,
          cols: request.cols,
          rows: request.rows,
          cwd: request.cwd,
        };

  return hand(sender, { name: SPAWN, args });
}

/**
 * Send one payload of user input to a terminal.
 *
 * Why the phase is checked here and not at each call site
 *   The rule is "only a running terminal accepts input", and it is a rule about
 *   every payload, not about one handler. Checking it in the panel would mean
 *   writing it once per producer and once more for the next one somebody adds --
 *   and the one that gets forgotten is the one that sends a byte into a dead
 *   session, which the engine then drops silently. Checking it in the single
 *   function every payload already has to pass through makes a missing check
 *   impossible to write.
 *
 *   The phase is a separate argument rather than a field of the request, because
 *   it is not part of the command: the wire carries bytes and a terminal id, and
 *   nothing else. Keeping it out of the request object also keeps a caller from
 *   believing the payload can carry its own permission.
 *
 * @param sender the command layer
 * @param request the terminal and the bytes, exactly as the exit functions produced them
 * @param phase the phase of the state that produced those bytes
 * @returns `sent`, `suppressed` when nothing should be sent, or `failed`
 */
export async function sendInput(
  sender: CommandSender,
  request: { readonly terminalId: string; readonly data: string },
  phase: TerminalPhase,
): Promise<CommandOutcome> {
  if (phase !== "running") {
    return { kind: "suppressed", because: "terminal-not-running", phase };
  }

  // The exit functions already return "nothing to send" for a swallowed stroke,
  // but a paste may legitimately produce an empty payload, and a command that
  // carries no bytes still costs a frame. Dropping it here keeps the wire free of
  // frames that cannot change anything.
  if (request.data === "") {
    return { kind: "suppressed", because: "empty-payload", phase };
  }

  return hand(sender, {
    name: TERMINAL_INPUT_CAPABILITY,
    args: { terminalId: request.terminalId, data: request.data },
  });
}

/**
 * Tell the engine a terminal's new size.
 *
 * @param sender the command layer
 * @param request the terminal and its new dimensions
 * @returns the outcome
 */
export async function resizeTerminal(
  sender: CommandSender,
  request: { readonly terminalId: string; readonly cols: number; readonly rows: number },
): Promise<CommandOutcome> {
  // Not phase-gated, on purpose. A panel that mounts measures itself before it
  // asks for a terminal, so the first resize legitimately names a session that
  // does not exist yet; the engine drops a resize for an unknown terminal instead
  // of failing it, so a resize in `starting` costs one frame and nothing else.
  return hand(sender, { name: RESIZE, args: request });
}

/**
 * Tell the engine to end a terminal.
 *
 * @param sender the command layer
 * @param request the terminal to end
 * @returns the outcome
 */
export async function killTerminal(
  sender: CommandSender,
  request: { readonly terminalId: string },
): Promise<CommandOutcome> {
  // Not phase-gated either: a panel sends this while it is being torn down, and
  // a close that was skipped because the phase looked finished is a process that
  // outlives its tab. A kill for a terminal that is already gone is a no-op on
  // the engine side, so sending it unconditionally is the safe direction.
  return hand(sender, { name: KILL, args: request });
}
