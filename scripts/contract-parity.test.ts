/**
 * Parity and startup-text tests.
 *
 * The green cases run against the real read-only engine mirror at
 * `_research/haruyuki` (v0.6.0 @ 1641a4f): the four locked counts
 * (14 advertised / 3 handled elsewhere / 1 alias / 12 dispatch cases), the
 * three parity invariants and the two-required-one-optional startup shapes are
 * facts about that checkout, not fixture choices. A missing mirror skips those
 * engine-bound suites (`describeWithEngine`) instead of failing: a clean clone
 * has no `_research/` and the default `verify` must stay green, and a
 * skip is not a silent pass because the synthetic parser cases below
 * still run and the fixture-driven gate test covers the same pipeline.
 *
 * The red cases feed synthetic source through the pure parsers, which is the
 * seam the contract gate needs for its fixtures: no engine tree, no writes, no process
 * spawn. The final suite is engine-free on purpose: it pins the reusable
 * `checkParityConsistency` contract the gate consumes (empty input is not a
 * pass, duplicate ids are reported once, a dangling alias is reported alone).
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
import { assertFailure, assertSuccess, defined } from "./lib/test-assert.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_ROOT = path.join(REPO_ROOT, "_research", "haruyuki");

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

/**
 * The extraction shape the engine-bound suites below read.
 *
 * Spelled out here because `extractParity`'s own JSDoc says
 * `@returns {object}`, which TypeScript resolves to `any` - every assertion on
 * `parity.*` would be unchecked, which is exactly the hole this type check
 * exists to close. With the shape declared, a renamed or misspelled field in
 * these assertions is a compile error instead of a silently passing
 * `expect(undefined)`. The extractor's field names are pinned by the fixture
 * gate test as well; keep both in step if the snapshot shape changes.
 */
type ParityExtraction =
  | {
      ok: true;
      engineRoot: string;
      remoteCommands: {
        advertised: string[];
        handledElsewhere: Record<string, string>;
        unadvertisedAliases: Record<string, string>;
        dispatchCases: string[];
      };
      counts: {
        advertisedCommands: number;
        handledElsewhere: number;
        unadvertisedAliases: number;
        dispatchCases: number;
      };
      startupText: { required: string[]; optional: string[] };
      consistency: {
        ok: boolean;
        vacuous: boolean;
        advertisedWithoutHandler: string[];
        unadvertisedCaseWithoutAlias: string[];
        aliasWithoutCase: string[];
      };
      health: {
        degraded: boolean;
        coarse: { reason?: string; text?: string; line?: number }[];
        unparsed: { file: string; symbol: string }[];
      };
    }
  | {
      ok: false;
      code: string;
      file: string;
      symbol: string;
      message: string;
      health: {
        degraded: true;
        coarse: { reason?: string; text?: string; line?: number }[];
        unparsed: { file: string; symbol: string }[];
      };
    };

/** The success arm: the engine-bound assertions below all read this shape. */
type ParitySuccess = Extract<ParityExtraction, { ok: true }>;

/** Parity extraction over the pinned engine source, filled in by `beforeAll`. */
let parity: ParitySuccess;
const ENGINE_AVAILABLE = existsSync(path.join(ENGINE_ROOT, "src", "websocket"));

/**
 * Engine-bound suites skip themselves in a clean clone: the pinned mirror is
 * not committed, and a clean-clone `verify` must stay green.
 * Run them where `_research/haruyuki` exists; the fixture-driven gate test
 * covers the pipeline without the mirror.
 */
const describeWithEngine = ENGINE_AVAILABLE ? describe : describe.skip;

beforeAll(() => {
  if (!ENGINE_AVAILABLE) {
    return;
  }

  const extraction = extractParity({ engineRoot: ENGINE_ROOT });
  assertSuccess(extraction, "parity extraction on the pinned engine source");
  parity = extraction;
});

describeWithEngine("parity extraction on the pinned engine source", () => {
  it("extracts 14 advertised ids in declaration order", () => {
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
      vacuous: false,
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
    const listening = defined(parity.startupText.required[0], "startupText.required[0]");
    const webSocket = defined(parity.startupText.required[1], "startupText.required[1]");
    const openAi = defined(parity.startupText.optional[0], "startupText.optional[0]");

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

    assertSuccess(constants, "parseRemoteConstants on the real source");
    expect(constants.advertised).toHaveLength(14);
    assertSuccess(dispatch, "parseDispatchCases on the real source");
    expect(dispatch.dispatchCases).toHaveLength(12);
    assertSuccess(startup, "parseStartupLines on the real source");
    expect(startup.required).toHaveLength(2);
    expect(startup.optional).toHaveLength(1);
  });

  it("fails explicitly when the engine mirror is missing", () => {
    const missing = extractParity({
      engineRoot: path.join(REPO_ROOT, "_research", "haruyuki-does-not-exist"),
    });

    assertFailure(missing, "extractParity with a missing engine mirror");
    expect(missing.code).toBe(PARITY_FAILURE_CODES.ENGINE_SOURCE_MISSING);
    expect(missing.health.degraded).toBe(true);
    expect(missing.file).toBe(PARITY_SOURCES.constants);
    expect(missing.message).toContain("engine source file not found");
  });
});

describeWithEngine("parity invariants on synthetic source", () => {
  /**
   * Parse both synthetic sources and assemble the block
   * `checkParityConsistency` consumes.
   *
   * The return type is spelled out (not the JSDoc `object` it used to be) so
   * the callers can read the four fields without a cast; the parsers are
   * asserted here, which is what narrows `constants`/`dispatch` to their
   * success arm.
   *
   * @returns the two parser results plus the assembled remote-command block
   */
  function syntheticParity(): {
    constants: ReturnType<typeof parseRemoteConstants>;
    dispatch: ReturnType<typeof parseDispatchCases>;
    remote: {
      advertised: string[];
      handledElsewhere: Record<string, string>;
      unadvertisedAliases: Record<string, string>;
      dispatchCases: string[];
    };
  } {
    const constants = parseRemoteConstants(SYNTHETIC_CONSTANTS);
    const dispatch = parseDispatchCases(SYNTHETIC_COMMANDS);

    assertSuccess(constants, "parseRemoteConstants on the synthetic source");
    assertSuccess(dispatch, "parseDispatchCases on the synthetic source");

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
      vacuous: false,
      advertisedWithoutHandler: [],
      unadvertisedCaseWithoutAlias: [],
      aliasWithoutCase: [],
    });
  });

  it("flags an advertised id whose case was deleted", () => {
    const withoutDoctor = SYNTHETIC_COMMANDS.replace('    case "doctor":\n      break;\n', "");
    const { remote } = syntheticParity();

    expect(withoutDoctor).not.toContain('case "doctor"');

    const withoutDoctorDispatch = parseDispatchCases(withoutDoctor);
    assertSuccess(withoutDoctorDispatch, 'parseDispatchCases after deleting case "doctor"');

    const consistency = checkParityConsistency({
      ...remote,
      dispatchCases: withoutDoctorDispatch.dispatchCases,
    });

    expect(consistency.ok).toBe(false);
    expect(consistency.advertisedWithoutHandler).toEqual(["doctor"]);
    expect(consistency.unadvertisedCaseWithoutAlias).toEqual([]);
  });

  it("flags a dispatch case renamed to an id that is not an alias", () => {
    const renamed = SYNTHETIC_COMMANDS.replace('case "doctor"', 'case "medicine"');
    const { remote } = syntheticParity();

    expect(renamed).toContain('case "medicine"');

    const renamedDispatch = parseDispatchCases(renamed);
    assertSuccess(renamedDispatch, 'parseDispatchCases after renaming case "doctor"');

    const consistency = checkParityConsistency({
      ...remote,
      dispatchCases: renamedDispatch.dispatchCases,
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
    assertSuccess(startup, "parseStartupLines after renaming the WebSocket label");
    expect(startup.required).toHaveLength(2);

    const wsShape = defined(startup.required[1], "startupText.required[1]");

    expect(wsShape).toBe("^WS:\\s+(ws://\\S+)$");
    expect(new RegExp(wsShape).test(STARTUP_OUTPUT.webSocket)).toBe(false);
    expect(new RegExp(wsShape).test("WS: ws://127.0.0.1:4500/ws")).toBe(true);
  });

  it("records a non-literal case label as coarse instead of stringifying it", () => {
    const nonLiteral = SYNTHETIC_COMMANDS.replace('case "doctor"', "case SOME_COMMAND_ID");
    const dispatch = parseDispatchCases(nonLiteral);

    assertSuccess(dispatch, "parseDispatchCases on a non-literal case label");
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
    assertFailure(constants, "parseRemoteConstants on a non-literal element");
    expect(constants.code).toBe(PARITY_FAILURE_CODES.CONSTANT_ELEMENT_NOT_LITERAL);
    expect(constants.symbol).toBe("SUPPORTED_REMOTE_COMMANDS");
  });

  it("fails structurally when a parity constant is missing", () => {
    const withoutAliases = SYNTHETIC_CONSTANTS.slice(
      0,
      SYNTHETIC_CONSTANTS.indexOf("export const UNADVERTISED_REMOTE_COMMAND_ALIASES"),
    );
    const constants = parseRemoteConstants(withoutAliases);

    assertFailure(constants, "parseRemoteConstants with a missing constant");
    expect(constants.code).toBe(PARITY_FAILURE_CODES.CONSTANT_NOT_FOUND);
    expect(constants.symbol).toBe("UNADVERTISED_REMOTE_COMMAND_ALIASES");
  });

  it("fails structurally when the dispatch switch is missing", () => {
    const noSwitch = SYNTHETIC_COMMANDS.replace("switch (command.command_id)", "switch (other)");
    const dispatch = parseDispatchCases(noSwitch);

    assertFailure(dispatch, "parseDispatchCases with the switch missing");
    expect(dispatch.code).toBe(PARITY_FAILURE_CODES.DISPATCH_SWITCH_NOT_FOUND);
  });

  it("fails structurally when the startup handler is missing", () => {
    const startup = parseStartupLines("export function run(): void { console.log('x'); }");

    assertFailure(startup, "parseStartupLines with the handler missing");
    expect(startup.code).toBe(PARITY_FAILURE_CODES.STARTUP_HANDLER_NOT_FOUND);
    expect(startup.symbol).toBe("onListening");
  });
});

/**
 * Engine-free pins on the reusable consistency export (P5-9, P5-7, P5-8).
 *
 * The input is the `snapshot.special.remoteCommands` block, which is exactly
 * what the gate can read without touching the engine mirror. `ok` is false on
 * empty input and every output list is deduplicated, so a vanished extraction
 * or a duplicated id cannot read as clean.
 */
describe("parity consistency contract (pure)", () => {
  it("treats empty input as inconsistent instead of a vacuous pass", () => {
    const consistency = checkParityConsistency({
      advertised: [],
      handledElsewhere: {},
      unadvertisedAliases: {},
      dispatchCases: [],
    });

    expect(consistency.vacuous).toBe(true);
    expect(consistency.ok).toBe(false);
    expect(consistency.advertisedWithoutHandler).toEqual([]);
    expect(consistency.unadvertisedCaseWithoutAlias).toEqual([]);
    expect(consistency.aliasWithoutCase).toEqual([]);
  });

  it("does not throw on a partial or missing remote command block", () => {
    // The evaluator deliberately coerces a missing/non-object block to `{}` and
    // reports `vacuous: true` (its own header: "Never throws"), which is what this
    // test pins, but its JSDoc `@param` still declares a required object. The
    // annotation is narrower than the behaviour, so the two calls that exercise
    // the tolerated input are suppressed; a directive that stops matching fails
    // loudly (TS2578), so tightening the JSDoc later cannot leave a dead one.
    // @ts-expect-error - missing block is tolerated at run time (see above).
    expect(() => checkParityConsistency(undefined)).not.toThrow();
    // @ts-expect-error - missing block is tolerated at run time (see above).
    expect(checkParityConsistency(undefined).vacuous).toBe(true);

    const partial = checkParityConsistency({ advertised: ["clear"] });

    expect(partial.vacuous).toBe(false);
    expect(partial.ok).toBe(false);
    expect(partial.advertisedWithoutHandler).toEqual(["clear"]);
  });

  it("reports a duplicated id once instead of once per copy", () => {
    const consistency = checkParityConsistency({
      advertised: ["clear", "doctor", "doctor"],
      handledElsewhere: {},
      unadvertisedAliases: {},
      dispatchCases: ["clear", "clear"],
    });

    expect(consistency.ok).toBe(false);
    expect(consistency.advertisedWithoutHandler).toEqual(["doctor"]);
    expect(consistency.unadvertisedCaseWithoutAlias).toEqual([]);
    expect(consistency.aliasWithoutCase).toEqual([]);
  });

  it("reports only the dangling alias when no other invariant is violated (P5-7)", () => {
    const consistency = checkParityConsistency({
      advertised: ["clear"],
      handledElsewhere: {},
      unadvertisedAliases: { "set-max-context": "Pre-rename wire id for context-limit." },
      dispatchCases: ["clear"],
    });

    expect(consistency.ok).toBe(false);
    expect(consistency.advertisedWithoutHandler).toEqual([]);
    expect(consistency.unadvertisedCaseWithoutAlias).toEqual([]);
    expect(consistency.aliasWithoutCase).toEqual(["set-max-context"]);
  });

  it("accepts the snapshot block shape the gate consumes unchanged (P5-8)", () => {
    const fromSnapshotBlock = {
      advertised: ["clear"],
      handledElsewhere: {},
      unadvertisedAliases: {},
      dispatchCases: ["clear"],
    };

    expect(checkParityConsistency(fromSnapshotBlock)).toEqual({
      ok: true,
      vacuous: false,
      advertisedWithoutHandler: [],
      unadvertisedCaseWithoutAlias: [],
      aliasWithoutCase: [],
    });
  });
});
