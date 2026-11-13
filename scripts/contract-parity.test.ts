/**
 * Parity and startup-text tests.
 *
 * The green cases run against the real read-only engine mirror at
 * `_research/haruyuki` (v0.6.0 @ 1641a4f): the four locked counts
 * (14 advertised / 3 handled elsewhere / 1 alias / 12 dispatch cases), the
 * three parity invariants and the two-required-one-optional startup shapes are
 * facts about that checkout, not fixture choices. A missing mirror is a hard
 * failure with an actionable message, never a silent skip.
 *
 * The red cases feed synthetic source through the pure parsers, which is the
 * seam the contract gate needs for its fixtures: no engine tree, no writes, no process
 * spawn.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  PARITY_FAILURE_CODES,
  PARITY_SOURCES,
  checkParityConsistency,
  extractParity,
  parseDispatchCases,
  parseRemoteConstants,
  parseStartupLines,
} from "./contract/extract-parity.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_ROOT = path.join(REPO_ROOT, "_research", "haruyuki");

const MISSING_MIRROR_HINT =
  `engine mirror is missing at ${ENGINE_ROOT}. ` +
  "`transport.ts` reads the pinned engine source: create the read-only mirror with " +
  "`git clone --shared <main checkout>/_research/haruyuki _research/haruyuki` " +
  "and check out commit 1641a4f (v0.6.0).";

/** Real stdout lines the startup shapes must accept. */
const STARTUP_OUTPUT = {
  listening: "Listening on ws://127.0.0.1:4500",
  webSocket: "WebSocket: ws://127.0.0.1:4500/ws",
  openAi: "OpenAI:  http://127.0.0.1:4500/v1",
};

/**
 * Synthetic constants: small enough to eyeball, same declaration shapes as the
 * engine file (annotated `const`, concatenated reason strings).
 */
const SYNTHETIC_CONSTANTS = `export const SUPPORTED_REMOTE_COMMANDS: readonly string[] = [
  "clear",
  // A comment between elements must not shift the declaration order.
  "doctor",
  "toolset",
];

export const REMOTE_COMMANDS_HANDLED_ELSEWHERE: Readonly<
  Record<string, string>
> = {
  toolset:
    "Handled by the dedicated update_toolset command " +
    "(handleModelToolsetCommand in commands/model-toolset.ts).",
};

export const UNADVERTISED_REMOTE_COMMAND_ALIASES: Readonly<
  Record<string, string>
> = {
  "set-max-context": "Pre-rename wire id for context-limit.",
};`;

/** Synthetic dispatch function carrying the `command.command_id` switch. */
const SYNTHETIC_COMMANDS = `export async function handleExecuteCommand(
  command: ExecuteCommandCommand,
): Promise<void> {
  switch (command.command_id) {
    case "clear": {
      break;
    }
    case "doctor":
      break;
    case "set-max-context":
      break;
  }
}`;

/** Synthetic startup handler: two unconditional lines, one behind a flag. */
const SYNTHETIC_STARTUP = [
  "export async function run(parsed: ParsedArgs): Promise<void> {",
  "  const handle = await startAppServer({",
  "    listen: undefined,",
  "    onListening: (info) => {",
  "      console.log(`Listening on ${info.url}`);",
  "      console.log(`WebSocket: ${info.controlUrl}`);",
  "      if (openaiApi) {",
  "        console.log(`OpenAI:  ${openaiBase.origin}/v1`);",
  "      }",
  "    },",
  "    onLog: (message) => {",
  "      console.error(message);",
  "    },",
  "  });",
  "  return await waitForShutdown(handle.close);",
  "}",
].join("\n");

/** @type {ReturnType<typeof extractParity>} */
let parity;

beforeAll(() => {
  if (!existsSync(path.join(ENGINE_ROOT, "src", "websocket"))) {
    throw new Error(MISSING_MIRROR_HINT);
  }

  parity = extractParity({ engineRoot: ENGINE_ROOT });
});

describe("parity extraction on the pinned engine source", () => {
  it("extracts 14 advertised ids in declaration order", () => {
    expect(parity.ok, JSON.stringify(parity)).toBe(true);
    expect(parity.remoteCommands.advertised).toHaveLength(14);
    expect(parity.remoteCommands.advertised).toEqual([
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
      "monitor_stop",
    ]);
  });

  it("extracts 3 handled-elsewhere entries and 1 unadvertised alias", () => {
    expect(Object.keys(parity.remoteCommands.handledElsewhere)).toEqual([
      "toolset",
      "secret",
      "monitor_stop",
    ]);
    expect(Object.keys(parity.remoteCommands.unadvertisedAliases)).toEqual(["set-max-context"]);
  });

  it("collapses every reason string to a single line", () => {
    const reasons = [
      ...Object.values(parity.remoteCommands.handledElsewhere),
      ...Object.values(parity.remoteCommands.unadvertisedAliases),
    ];

    expect(reasons).toHaveLength(4);

    for (const reason of reasons) {
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(reason).not.toMatch(/\n|\s{2,}/);
    }

    expect(parity.remoteCommands.handledElsewhere.toolset).toContain("update_toolset");
    expect(parity.remoteCommands.handledElsewhere.secret).toContain("secret_list");
    expect(parity.remoteCommands.handledElsewhere.monitor_stop).toContain("monitor_stop");
    expect(parity.remoteCommands.unadvertisedAliases["set-max-context"]).toContain("context-limit");
  });

  it("extracts 12 dispatch cases in lexicographic order", () => {
    expect(parity.remoteCommands.dispatchCases).toHaveLength(12);
    expect(parity.remoteCommands.dispatchCases).toEqual(
      [...parity.remoteCommands.dispatchCases].sort(),
    );
    expect(parity.remoteCommands.dispatchCases).toContain("set-max-context");
    expect(parity.remoteCommands.dispatchCases).not.toContain("secret");
  });

  it("reports no coarse or unparsed health markers", () => {
    expect(parity.health.degraded).toBe(false);
    expect(parity.health.coarse).toEqual([]);
    expect(parity.health.unparsed).toEqual([]);
    expect(parity.counts).toEqual({
      advertisedCommands: 14,
      handledElsewhere: 3,
      unadvertisedAliases: 1,
      dispatchCases: 12,
    });
  });

  it("keeps the three consistency invariants green", () => {
    expect(parity.consistency).toEqual({
      ok: true,
      advertisedWithoutHandler: [],
      unadvertisedCaseWithoutAlias: [],
      aliasWithoutCase: [],
    });
  });

  it("pins two required startup shapes and one optional shape", () => {
    expect(parity.startupText.required).toEqual([
      "^Listening on (ws://\\S+)$",
      "^WebSocket:\\s+(ws://\\S+)$",
    ]);
    expect(parity.startupText.optional).toEqual(["^OpenAI:"]);
    expect(parity.startupText.required).toHaveLength(2);
    expect(parity.startupText.optional).toHaveLength(1);
  });

  it("matches the real startup output and rejects a wrong label", () => {
    const [listening, webSocket] = parity.startupText.required;
    const [openAi] = parity.startupText.optional;

    expect(new RegExp(listening).test(STARTUP_OUTPUT.listening)).toBe(true);
    expect(new RegExp(webSocket).test(STARTUP_OUTPUT.webSocket)).toBe(true);
    expect(new RegExp(openAi).test(STARTUP_OUTPUT.openAi)).toBe(true);

    expect(new RegExp(webSocket).test("WebSocket:   ws://127.0.0.1:4500/ws")).toBe(true);
    expect(new RegExp(webSocket).test("WS: ws://127.0.0.1:4500/ws")).toBe(false);
    expect(new RegExp(webSocket).test("WebSocket: http://127.0.0.1:4500/ws")).toBe(false);
    expect(new RegExp(listening).test("Listening on http://127.0.0.1:4500")).toBe(false);
    expect(new RegExp(openAi).test("OpenAi: http://127.0.0.1:4500/v1")).toBe(false);
  });

  it("runs the pure parsers on the real source text", () => {
    const constantsText = readFileSync(
      path.join(ENGINE_ROOT, ...PARITY_SOURCES.constants.split("/")),
      "utf8",
    );
    const commandsText = readFileSync(
      path.join(ENGINE_ROOT, ...PARITY_SOURCES.commands.split("/")),
      "utf8",
    );
    const startupText = readFileSync(
      path.join(ENGINE_ROOT, ...PARITY_SOURCES.startup.split("/")),
      "utf8",
    );

    const constants = parseRemoteConstants(constantsText);
    const dispatch = parseDispatchCases(commandsText);
    const startup = parseStartupLines(startupText);

    expect(constants.ok, JSON.stringify(constants)).toBe(true);
    expect(constants.advertised).toHaveLength(14);
    expect(dispatch.ok, JSON.stringify(dispatch)).toBe(true);
    expect(dispatch.dispatchCases).toHaveLength(12);
    expect(startup.ok, JSON.stringify(startup)).toBe(true);
    expect(startup.required).toHaveLength(2);
    expect(startup.optional).toHaveLength(1);
  });

  it("fails explicitly when the engine mirror is missing", () => {
    const missing = extractParity({
      engineRoot: path.join(REPO_ROOT, "_research", "haruyuki-does-not-exist"),
    });

    expect(missing.ok).toBe(false);
    expect(missing.code).toBe(PARITY_FAILURE_CODES.ENGINE_SOURCE_MISSING);
    expect(missing.health.degraded).toBe(true);
    expect(missing.file).toBe(PARITY_SOURCES.constants);
    expect(missing.message).toContain("engine source file not found");
  });
});

describe("parity invariants on synthetic source", () => {
  /** @returns {{constants: object, dispatch: object, remote: object}} */
  function syntheticParity() {
    const constants = parseRemoteConstants(SYNTHETIC_CONSTANTS);
    const dispatch = parseDispatchCases(SYNTHETIC_COMMANDS);

    expect(constants.ok, JSON.stringify(constants)).toBe(true);
    expect(dispatch.ok, JSON.stringify(dispatch)).toBe(true);

    const remote = {
      advertised: constants.advertised,
      handledElsewhere: constants.handledElsewhere,
      unadvertisedAliases: constants.unadvertisedAliases,
      dispatchCases: dispatch.dispatchCases,
    };

    return { constants, dispatch, remote };
  }

  it("accepts the balanced synthetic source", () => {
    const { remote } = syntheticParity();

    expect(remote.advertised).toEqual(["clear", "doctor", "toolset"]);
    expect(remote.dispatchCases).toEqual(["clear", "doctor", "set-max-context"]);
    expect(checkParityConsistency(remote)).toEqual({
      ok: true,
      advertisedWithoutHandler: [],
      unadvertisedCaseWithoutAlias: [],
      aliasWithoutCase: [],
    });
  });

  it("flags an advertised id whose case was deleted", () => {
    const withoutDoctor = SYNTHETIC_COMMANDS.replace('    case "doctor":\n      break;\n', "");
    const { remote } = syntheticParity();

    expect(withoutDoctor).not.toContain('case "doctor"');

    const consistency = checkParityConsistency({
      ...remote,
      dispatchCases: parseDispatchCases(withoutDoctor).dispatchCases,
    });

    expect(consistency.ok).toBe(false);
    expect(consistency.advertisedWithoutHandler).toEqual(["doctor"]);
    expect(consistency.unadvertisedCaseWithoutAlias).toEqual([]);
  });

  it("flags a dispatch case renamed to an id that is not an alias", () => {
    const renamed = SYNTHETIC_COMMANDS.replace('case "doctor"', 'case "medicine"');
    const { remote } = syntheticParity();

    expect(renamed).toContain('case "medicine"');

    const consistency = checkParityConsistency({
      ...remote,
      dispatchCases: parseDispatchCases(renamed).dispatchCases,
    });

    expect(consistency.ok).toBe(false);
    expect(consistency.unadvertisedCaseWithoutAlias).toEqual(["medicine"]);
    expect(consistency.advertisedWithoutHandler).toEqual(["doctor"]);
    expect(consistency.aliasWithoutCase).toEqual([]);
  });

  it("stops the WebSocket startup shape from matching once the label is renamed", () => {
    const renamed = SYNTHETIC_STARTUP.replace(
      "`WebSocket: ${info.controlUrl}`",
      "`WS: ${info.controlUrl}`",
    );
    const startup = parseStartupLines(renamed);

    expect(renamed).toContain("WS:");
    expect(startup.ok, JSON.stringify(startup)).toBe(true);
    expect(startup.required).toHaveLength(2);
    expect(startup.required[1]).toBe("^WS:\\s+(ws://\\S+)$");
    expect(new RegExp(startup.required[1]).test(STARTUP_OUTPUT.webSocket)).toBe(false);
    expect(new RegExp(startup.required[1]).test("WS: ws://127.0.0.1:4500/ws")).toBe(true);
  });

  it("records a non-literal case label as coarse instead of stringifying it", () => {
    const nonLiteral = SYNTHETIC_COMMANDS.replace('case "doctor"', "case SOME_COMMAND_ID");
    const dispatch = parseDispatchCases(nonLiteral);

    expect(dispatch.ok, JSON.stringify(dispatch)).toBe(true);
    expect(dispatch.dispatchCases).toEqual(["clear", "set-max-context"]);
    expect(dispatch.coarse).toHaveLength(1);
    expect(dispatch.coarse[0]).toMatchObject({
      reason: "case-label-is-not-a-string-literal",
      text: "SOME_COMMAND_ID",
    });
    expect(dispatch.coarse[0].line).toBeGreaterThan(0);
  });

  it("fails structurally when an advertised id is not a string literal", () => {
    const nonLiteral = SYNTHETIC_CONSTANTS.replace('  "clear",', "  SOME_COMMAND_ID,");
    const constants = parseRemoteConstants(nonLiteral);

    expect(nonLiteral).toContain("SOME_COMMAND_ID,");
    expect(constants.ok).toBe(false);
    expect(constants.code).toBe(PARITY_FAILURE_CODES.CONSTANT_ELEMENT_NOT_LITERAL);
    expect(constants.symbol).toBe("SUPPORTED_REMOTE_COMMANDS");
  });

  it("fails structurally when a parity constant is missing", () => {
    const withoutAliases = SYNTHETIC_CONSTANTS.slice(
      0,
      SYNTHETIC_CONSTANTS.indexOf("export const UNADVERTISED_REMOTE_COMMAND_ALIASES"),
    );
    const constants = parseRemoteConstants(withoutAliases);

    expect(constants.ok).toBe(false);
    expect(constants.code).toBe(PARITY_FAILURE_CODES.CONSTANT_NOT_FOUND);
    expect(constants.symbol).toBe("UNADVERTISED_REMOTE_COMMAND_ALIASES");
  });

  it("fails structurally when the dispatch switch is missing", () => {
    const noSwitch = SYNTHETIC_COMMANDS.replace("switch (command.command_id)", "switch (other)");
    const dispatch = parseDispatchCases(noSwitch);

    expect(dispatch.ok).toBe(false);
    expect(dispatch.code).toBe(PARITY_FAILURE_CODES.DISPATCH_SWITCH_NOT_FOUND);
  });

  it("fails structurally when the startup handler is missing", () => {
    const startup = parseStartupLines("export function run(): void { console.log('x'); }");

    expect(startup.ok).toBe(false);
    expect(startup.code).toBe(PARITY_FAILURE_CODES.STARTUP_HANDLER_NOT_FOUND);
    expect(startup.symbol).toBe("onListening");
  });
});
