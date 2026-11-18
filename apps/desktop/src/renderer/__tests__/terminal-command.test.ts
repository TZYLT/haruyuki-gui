/**
 * Tests for the terminal command sender.
 *
 * The sender is the seam between the panel's camelCase commands and the wire's
 * snake_case bodies, so the cases are about that translation and about the
 * three-way failure classification: the bodies are compared exactly (including
 * the absence of `cwd` and of a runtime scope), both success completions must
 * collapse to one answer, and every failure must keep its reason and text.
 *
 * The fake client records the call rather than wrapping a spy, because the
 * assertions that matter are about the body's absence of a key and about the
 * number of arguments the client was called with - `runtime` is positional, so
 * "two arguments" is the evidence that no scope was sent.
 */

import { describe, expect, it } from "vitest";

import type { CommandErrorCode, CommandReply } from "@haruyuki/core";
import type { CommandSender } from "@haruyuki/ui";

import type { CommandClient } from "../command.js";
import { createTerminalCommandSender } from "../terminal-command.js";

type TerminalCommand = Parameters<CommandSender>[0];

interface Call {
  readonly capability: string;
  readonly body: Record<string, unknown>;
  /** How many arguments followed the body; zero means no runtime was passed. */
  readonly trailing: number;
}

/** A client that answers every call with one fixed reply and records the calls. */
function recordingClient(reply: CommandReply): {
  readonly client: CommandClient;
  readonly calls: Call[];
} {
  const calls: Call[] = [];

  return {
    calls,
    client: {
      invoke(capability, body, ...rest) {
        calls.push({ capability, body, trailing: rest.length });

        return Promise.resolve(reply);
      },
    },
  };
}

/** The only call a test expects, so a missing or extra call fails loudly. */
function onlyCall(calls: readonly Call[]): Call {
  expect(calls).toHaveLength(1);

  const call = calls[0];

  if (call === undefined) throw new Error("the sender made no call");

  return call;
}

describe("createTerminalCommandSender", () => {
  it("sends a spawn with its directory as a snake_case body and no runtime", async () => {
    const { client, calls } = recordingClient({ ok: true, completion: "accepted" });
    const sender = createTerminalCommandSender(client);

    const answer = await sender({
      name: "terminal.spawn",
      args: { terminalId: "t-1", cols: 120, rows: 40, cwd: "J:/work" },
    });

    expect(answer).toEqual({ ok: true });
    expect(onlyCall(calls)).toEqual({
      capability: "terminal.spawn",
      body: { terminal_id: "t-1", cols: 120, rows: 40, cwd: "J:/work" },
      trailing: 0,
    });
  });

  it("leaves cwd out of a spawn that does not name a directory", async () => {
    const { client, calls } = recordingClient({ ok: true, completion: "accepted" });
    const sender = createTerminalCommandSender(client);

    await sender({ name: "terminal.spawn", args: { terminalId: "t-1", cols: 80, rows: 24 } });

    const { body } = onlyCall(calls);
    expect(body).toEqual({ terminal_id: "t-1", cols: 80, rows: 24 });
    expect(Object.hasOwn(body, "cwd")).toBe(false);
  });

  it("sends input with its data field", async () => {
    const { client, calls } = recordingClient({ ok: true, completion: "accepted" });
    const sender = createTerminalCommandSender(client);

    await sender({ name: "terminal.input", args: { terminalId: "t-2", data: "ls\r" } });

    expect(onlyCall(calls)).toEqual({
      capability: "terminal.input",
      body: { terminal_id: "t-2", data: "ls\r" },
      trailing: 0,
    });
  });

  it("sends a resize with its dimensions", async () => {
    const { client, calls } = recordingClient({ ok: true, completion: "accepted" });
    const sender = createTerminalCommandSender(client);

    await sender({ name: "terminal.resize", args: { terminalId: "t-3", cols: 100, rows: 30 } });

    expect(onlyCall(calls)).toEqual({
      capability: "terminal.resize",
      body: { terminal_id: "t-3", cols: 100, rows: 30 },
      trailing: 0,
    });
  });

  it("sends a kill with the terminal id alone", async () => {
    const { client, calls } = recordingClient({ ok: true, completion: "accepted" });
    const sender = createTerminalCommandSender(client);

    await sender({ name: "terminal.kill", args: { terminalId: "t-4" } });

    expect(onlyCall(calls)).toEqual({
      capability: "terminal.kill",
      body: { terminal_id: "t-4" },
      trailing: 0,
    });
  });

  it("treats an answered reply as success", async () => {
    const { client } = recordingClient({
      ok: true,
      completion: "answered",
      data: { ignored: true },
    });
    const sender = createTerminalCommandSender(client);

    const answer = await sender({ name: "terminal.kill", args: { terminalId: "t-5" } });

    expect(answer).toEqual({ ok: true });
  });

  it("treats an accepted reply as success", async () => {
    const { client } = recordingClient({ ok: true, completion: "accepted" });
    const sender = createTerminalCommandSender(client);

    const answer = await sender({ name: "terminal.kill", args: { terminalId: "t-6" } });

    expect(answer).toEqual({ ok: true });
  });

  const refused: ReadonlyArray<{ readonly code: CommandErrorCode; readonly reason: string }> = [
    // No live channel: wait for a reconnect.
    { code: "COMMAND_CHANNEL_UNAVAILABLE", reason: "channel-unavailable" },
    { code: "NOT_CONNECTED", reason: "channel-unavailable" },
    // Version or capability mismatch: retrying cannot help.
    { code: "COMMAND_UNKNOWN_CAPABILITY", reason: "not-implemented" },
    { code: "COMMAND_CAPABILITY_UNAVAILABLE", reason: "not-implemented" },
    // The engine answered and said no, or the request itself was refused.
    { code: "REJECTED", reason: "engine-rejected" },
    { code: "UNKNOWN_COMMAND", reason: "engine-rejected" },
    { code: "TIMEOUT", reason: "engine-rejected" },
    { code: "SEND_FAILED", reason: "engine-rejected" },
    { code: "MALFORMED_RESPONSE", reason: "engine-rejected" },
    { code: "AUTH_FAILED", reason: "engine-rejected" },
    { code: "COMMAND_BAD_PAYLOAD", reason: "engine-rejected" },
    { code: "COMMAND_SCOPE_REQUIRED", reason: "engine-rejected" },
  ];

  it.each(refused)("classifies $code as $reason", async ({ code, reason }) => {
    const { client } = recordingClient({ ok: false, code });
    const sender = createTerminalCommandSender(client);

    const answer = await sender({ name: "terminal.kill", args: { terminalId: "t-7" } });

    expect(answer).toEqual({ ok: false, reason });
    expect(Object.hasOwn(answer, "detail")).toBe(false);
  });

  it("prefers the engine's own words over the detail line", async () => {
    const { client } = recordingClient({
      ok: false,
      code: "REJECTED",
      detail: "the engine refused the command",
      engineText: "PTY limit reached",
    });
    const sender = createTerminalCommandSender(client);

    const answer = await sender({
      name: "terminal.spawn",
      args: { terminalId: "t-8", cols: 80, rows: 24 },
    });

    expect(answer).toEqual({ ok: false, reason: "engine-rejected", detail: "PTY limit reached" });
  });

  it("falls back to the detail line when the engine said nothing", async () => {
    const { client } = recordingClient({
      ok: false,
      code: "NOT_CONNECTED",
      detail: "the engine client is not connected",
    });
    const sender = createTerminalCommandSender(client);

    const answer = await sender({ name: "terminal.kill", args: { terminalId: "t-9" } });

    expect(answer).toEqual({
      ok: false,
      reason: "channel-unavailable",
      detail: "the engine client is not connected",
    });
  });

  it("classifies a rejecting client as channel-unavailable and does not throw", async () => {
    const client: CommandClient = {
      invoke: () => Promise.reject(new Error("the channel closed")),
    };
    const sender = createTerminalCommandSender(client);

    const answer = await sender({
      name: "terminal.input",
      args: { terminalId: "t-10", data: "x" },
    });

    expect(answer).toEqual({
      ok: false,
      reason: "channel-unavailable",
      detail: "the channel closed",
    });
  });

  it("does not mutate the command it was given", async () => {
    const { client } = recordingClient({ ok: true, completion: "accepted" });
    const sender = createTerminalCommandSender(client);
    const command: TerminalCommand = {
      name: "terminal.spawn",
      args: { terminalId: "t-11", cols: 80, rows: 24, cwd: "J:/work" },
    };

    await sender(command);

    expect(command).toEqual({
      name: "terminal.spawn",
      args: { terminalId: "t-11", cols: 80, rows: 24, cwd: "J:/work" },
    });
  });
});
