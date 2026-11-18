/**
 * The terminal panel's `CommandSender`, backed by the real command channel.
 *
 * Why this module exists
 *   The command client knows how to cross the preload boundary and deliberately
 *   knows nothing about terminals; the panel knows the four terminal commands but
 *   lives in `packages/ui`, which may not import the desktop shell. This file is
 *   the only place both halves are visible, so the camelCase arguments the panel
 *   speaks are translated to the wire's snake_case here and nowhere else. A second
 *   translation anywhere else would be a second place for the two spellings to
 *   disagree, and the body is the only thing the engine validates.
 *
 * Why success is `{ ok: true }` and not the reply
 *   The terminal capabilities are one-way: an `answered` arm is impossible on the
 *   wire, and `accepted` only means the frame was written. The sender contract has
 *   no room for "which of the two completions", and inventing one would tempt a
 *   caller to treat `accepted` as "the terminal exists" - only a pushed frame can
 *   prove that. Reporting the handover and nothing more keeps the claim true.
 *
 * Why the body is derived from the arguments rather than the capability name
 *   The name travels through untouched: the command layer validates it against
 *   the frozen table, so a second spelling in the shell would be the exact copy a
 *   capability-name scan rejects. The four argument shapes are distinguishable by
 *   the fields they carry, which is enough to build each body without naming a
 *   capability at all.
 *
 * Why the failure detail prefers `engineText`
 *   `detail` is written by this side for a log; `engineText` is the engine's own
 *   answer, and it is the only text that can tell a user why the engine refused.
 *   Keeping it ahead of `detail` makes the visible message match the cause.
 */

import type { CommandErrorCode, CommandReply } from "@haruyuki/core";
import type { CommandSender } from "@haruyuki/ui";

import type { CommandClient } from "./command.js";

/**
 * The command union the panel hands down.
 *
 * `@haruyuki/ui` exports the sender contract but not the union it accepts, and
 * the shell must not deep-import another package's internals. The parameter of
 * the exported contract is the same type, so it is recovered from there rather
 * than re-spelled here, where the copy would drift.
 */
type TerminalCommand = Parameters<CommandSender>[0];

/** What a sender call resolves to, so the helpers below share one return type. */
type CommandAnswer = Awaited<ReturnType<CommandSender>>;

/** The failed arm of a reply, named once so the detail handling reads clearly. */
type CommandRefusal = Extract<CommandReply, { readonly ok: false }>;

/** One of the three reasons the panel branches on. */
type CommandFailure = Extract<CommandAnswer, { readonly ok: false }>["reason"];

/**
 * Build the wire body for one command from the arguments it carries.
 *
 * The input args are told apart by `data`, and spawn from resize by the optional
 * `cwd`; a kill carries neither. `cwd` is added only when it is present, because
 * an absent field asks the engine for its own start directory, while an explicit
 * empty value would ask for something else.
 *
 * @param command the command to translate
 * @returns a plain body object in the wire's spelling
 */
function wireBody(command: TerminalCommand): Record<string, unknown> {
  const args = command.args;

  if ("data" in args) {
    return { terminal_id: args.terminalId, data: args.data };
  }

  if ("cols" in args) {
    if ("cwd" in args && args.cwd !== undefined) {
      return {
        terminal_id: args.terminalId,
        cols: args.cols,
        rows: args.rows,
        cwd: args.cwd,
      };
    }

    return { terminal_id: args.terminalId, cols: args.cols, rows: args.rows };
  }

  return { terminal_id: args.terminalId };
}

/**
 * Translate a failed reply's code into the panel's three-way reason.
 *
 * The channel can go away in two ways this build has a code for: the layer never
 * had a live channel, or the engine client was not connected. There is no
 * separate connection-lost code to map, so the remaining codes - the engine's
 * own refusals, a bad payload, a missing scope - all mean the engine answered no
 * and the user needs to see what it said.
 *
 * @param code the reply's code
 * @returns the reason the panel branches on
 */
function reasonFor(code: CommandErrorCode): CommandFailure {
  switch (code) {
    case "COMMAND_CHANNEL_UNAVAILABLE":
    case "NOT_CONNECTED":
      return "channel-unavailable";

    case "COMMAND_UNKNOWN_CAPABILITY":
    case "COMMAND_CAPABILITY_UNAVAILABLE":
      return "not-implemented";

    default:
      return "engine-rejected";
  }
}

/**
 * Turn a failed reply into the sender's failure arm.
 *
 * @param reply the failed reply
 * @returns a failure carrying the engine's words when there are any
 */
function refusal(reply: CommandRefusal): CommandAnswer {
  const reason = reasonFor(reply.code);
  const detail = reply.engineText ?? reply.detail;

  // Built without assigning `undefined`: under `exactOptionalPropertyTypes` a
  // present-but-undefined key is a different value from an absent one, and "the
  // reply had nothing to add" is the absent one.
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

/**
 * Describe a thrown client call.
 *
 * A rejecting client is a channel problem whatever the exception is: the write
 * itself failed, or the connection settled under the call. The text is kept
 * because a defect in the client surfaces the same way, and swallowing its
 * message would leave a field report pointing at the connection.
 *
 * @param thrown the value the client rejected with
 * @returns a detail string for the failure
 */
function thrownDetail(thrown: unknown): string {
  if (thrown instanceof Error && thrown.message !== "") return thrown.message;

  const text = String(thrown);

  return text === "" || text === "[object Object]"
    ? "the command client rejected the request without a message"
    : text;
}

/**
 * Build the sender the terminal panel is given.
 *
 * @param client the renderer's command client
 * @returns a sender that reports three failures as values and never rejects
 */
export function createTerminalCommandSender(client: CommandClient): CommandSender {
  return async (command) => {
    let reply: CommandReply;

    try {
      // The terminal capabilities are device-wide, so no runtime scope is
      // passed: a scope here would be refused as an envelope mismatch, and the
      // capability table already says none of them needs one.
      reply = await client.invoke(command.name, wireBody(command));
    } catch (thrown) {
      return { ok: false, reason: "channel-unavailable", detail: thrownDetail(thrown) };
    }

    if (reply.ok) return { ok: true };

    return refusal(reply);
  };
}
