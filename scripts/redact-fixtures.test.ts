/**
 * Self-tests for `scripts/redact-fixtures.mjs` (A3; docs/18 R-06 / the log,
 * section 3.2 step 1, section 8 INV-A3-2).
 *
 * One raw `kind: "wire"` recording is built in `os.tmpdir()` and trips every
 * gate rule: an absolute Windows path, an absolute POSIX path, the local user
 * name, an email address, a bearer token, a 64-hex token, a provider key, a
 * non-synthetic request id and the recorder's `r0` marker. The real gate is
 * spawned against a temporary corpus tree: it must fail on the raw file and
 * pass on the redacted copy.
 *
 * Also covered:
 *   - every original request id keeps one synthetic id across the file, and a
 *     response still answers its request;
 *   - `perm-<toolCallId>` becomes `synthetic-perm-<slug>` while the unchanged
 *     `tool_call_id` keeps the link to the tool call;
 *   - a second run is byte-identical and the pass is idempotent on its own
 *     output;
 *   - the corpus file is pure ASCII (non-ASCII prompt text is escaped);
 *   - a frames fixture is refused with exit code 2.
 *
 * Temp trees are removed pointwise after every case; nothing is written below
 * the repository's own `fixtures/` directory.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REDACT = path.join(REPO_ROOT, "scripts", "redact-fixtures.mjs");
const GATE = path.join(REPO_ROOT, "scripts", "check-fixtures.mjs");

/** Contract snapshot the gate reads for the version-alignment comparison. */
const PIN_FILE = "packages/protocol/src/contract/snapshot.json";
const PINNED = { version: "0.6.0", commit: "1641a4f" };

/** Synthetic request-id vocabulary, as defined by the gate. */
const SYNTHETIC_REQUEST_ID = /^(?:r|req)-\d{1,6}$|^synthetic-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The name the gate must refuse to see in a corpus fixture. */
const LOCAL_NAME = localUserName();

/** This machine's name: the engine echoes it back as `connection_name`. */
const LOCAL_HOST = os.hostname().trim();

/** Fixture identity: the value appears verbatim in the raw file. */
const NAME = LOCAL_NAME === "" ? "localuser" : LOCAL_NAME;
const WINDOWS_PATH = `C:\\Users\\${NAME}\\notes.txt`;
const POSIX_PATH = `/home/${NAME}/notes.txt`;
const EMAIL = "alice.cooper@example.com";
const BEARER = "Bearer abcdef0123456789";
const HEX_TOKEN = "0123456789abcdef".repeat(4);
const PROVIDER_KEY = `sk-${"a1".repeat(16)}`;

/** The device name the pass substitutes for this machine's name. */
const SYNTHETIC_HOSTNAME = "synthetic-host";
const UNICODE_NOTE = "\u4e2d\u6587";
const REQUEST_ID = "msg-abc-1";
const APPROVAL_ID = "perm-tool-call-abc";
const TOOL_CALL_ID = "tool-call-abc";

/** Every gate rule the raw fixture must trip, in gate order. */
const EXPECTED_RULES = [
  "redaction-state",
  "redaction-path",
  "redaction-username",
  "redaction-email",
  "redaction-token",
  "redaction-host",
  "redaction-request-id",
];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
}

/** Tracked temp roots, removed pointwise after every test. */
const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    removeTree(root);
  }
});

describe("redaction pass", () => {
  it("trips every gate rule on the raw file and produces a gate-green corpus file", () => {
    const rawText = buildRawRecording();
    const root = makeTree({
      [PIN_FILE]: `${JSON.stringify({ schemaVersion: 1, engine: PINNED })}\n`,
      "fixtures/engine/recordings/raw.jsonl": rawText,
    });

    const rawGate = runGate(root);

    expect(rawGate.status, rawGate.output).toBe(1);
    for (const rule of EXPECTED_RULES) {
      if (rule === "redaction-username" && LOCAL_NAME.length < 2) {
        continue;
      }

      expect(rawGate.output, `raw gate should flag ${rule}`).toContain(` ${rule} `);
    }

    const input = path.join(root, "fixtures", "engine", "recordings", "raw.jsonl");
    const output = path.join(root, "clean.jsonl");
    const run = runRedact([input, output, "--report"]);

    expect(run.status, run.output).toBe(0);
    expect(run.stderr).toContain("redaction-path=");
    expect(run.stderr).toContain("redaction-host=");
    expect(run.stderr).toContain("request-id-map=");
    expect(/^[\x00-\x7F]*$/.test(run.stderr)).toBe(true);

    const outputText = readFileSync(output, "utf8");

    expect(/^[\x00-\x7F]*$/.test(outputText)).toBe(true);

    const rawDocuments = parseJsonl(rawText);
    const outputDocuments = parseJsonl(outputText);
    const header = asRecord(outputDocuments[0]);

    expect(header.kind).toBe("wire");
    expect(header.redaction).toBe("r2");
    expect(outputDocuments.length).toBe(rawDocuments.length);

    const decoded = outputDocuments.map((document) => JSON.stringify(document)).join("\n");

    expect(decoded).toContain("C:/work/notes.txt");
    expect(decoded).toContain("/tmp/x/notes.txt");
    expect(decoded).toContain("<redacted-token>");
    expect(decoded).toContain("<redacted-email>");
    expect(decoded).not.toContain(EMAIL);
    expect(decoded).not.toContain(BEARER);
    expect(decoded).not.toContain(HEX_TOKEN);
    expect(decoded).not.toContain(PROVIDER_KEY);
    // The device name is replaced whole in `connection_name` and wherever else
    // it was mentioned; the placeholder is the only device name the gate takes.
    expect(decoded).toContain(`"connection_name":"${SYNTHETIC_HOSTNAME}"`);

    if (LOCAL_HOST.length >= 4) {
      expect(decoded).not.toContain(LOCAL_HOST);
    }

    if (LOCAL_NAME.length >= 2) {
      expect(decoded).not.toContain(LOCAL_NAME);
    }

    // A request and its response share the original id; the map must keep them
    // equal. The same holds for the two lines of the approval pair.
    const mapping = new Map<string, string>();

    for (const [index, rawDocument] of rawDocuments.entries()) {
      const outputDocument = outputDocuments[index];
      const rawIds = collectRequestIds(rawDocument);
      const outputIds = collectRequestIds(outputDocument);

      expect(outputIds.length).toBe(rawIds.length);

      for (const [position, rawId] of rawIds.entries()) {
        const outputId = outputIds[position] ?? "";

        expect(outputId).toMatch(SYNTHETIC_REQUEST_ID);

        const seen = mapping.get(rawId);

        if (seen === undefined) {
          mapping.set(rawId, outputId);
        } else {
          expect(outputId).toBe(seen);
        }
      }
    }

    expect(mapping.get(REQUEST_ID)).toBeDefined();

    const approvalRequest = asRecord(outputDocuments[3]);
    const approvalMessage = asRecord(approvalRequest.msg);
    const approvalId = collectRequestIds(approvalRequest)[0] ?? "";

    expect(approvalId).toBe("synthetic-perm-tool-call-abc");
    expect(approvalMessage.tool_call_id).toBe(TOOL_CALL_ID);
    expect(collectRequestIds(outputDocuments[4])[0]).toBe(approvalId);

    const inputMessage = asRecord(asRecord(outputDocuments[1]).msg);

    expect(inputMessage.note).toBe(UNICODE_NOTE);

    const cleanRoot = makeTree({
      [PIN_FILE]: `${JSON.stringify({ schemaVersion: 1, engine: PINNED })}\n`,
      "fixtures/engine/recordings/clean.jsonl": outputText,
    });
    const greenGate = runGate(cleanRoot);

    expect(greenGate.status, greenGate.output).toBe(0);
    expect(greenGate.output).toContain("PASS");
    expect(greenGate.output).not.toContain("redaction-");
  });

  it("is byte-identical on a second run and idempotent on its own output", () => {
    const root = makeTree({ "raw.jsonl": buildRawRecording() });
    const input = path.join(root, "raw.jsonl");
    const first = path.join(root, "first.jsonl");
    const second = path.join(root, "second.jsonl");
    const repeated = path.join(root, "repeated.jsonl");

    expect(runRedact([input, first]).status).toBe(0);
    expect(runRedact([input, second]).status).toBe(0);
    expect(readFileSync(second).equals(readFileSync(first))).toBe(true);

    expect(runRedact([first, repeated]).status).toBe(0);
    expect(readFileSync(repeated).equals(readFileSync(first))).toBe(true);
  });

  it("refuses a frames fixture with exit code 2", () => {
    const root = makeTree({
      "frames.jsonl": `${JSON.stringify({
        kind: "frames",
        schemaVersion: 1,
        bridgeVersion: 1,
        clock: "virtual",
      })}\n`,
    });
    const output = path.join(root, "out.jsonl");
    const run = runRedact([path.join(root, "frames.jsonl"), output]);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("wire");
    expect(existsSync(output)).toBe(false);
  });
});

/**
 * One raw recording that contains every rule the gate checks.
 *
 * @returns JSONL text, header first, with a trailing newline
 */
function buildRawRecording(): string {
  const header = {
    kind: "wire",
    schemaVersion: 1,
    engine: { ...PINNED },
    scenario: "redact-self-test",
    redaction: "r0",
    clock: "real",
    recordedAt: "2026-01-01T00:00:00.000Z",
  };
  const prompt =
    `Open ${WINDOWS_PATH} and ${POSIX_PATH} as ${NAME}; mail ${EMAIL}; ` +
    `token ${BEARER}; digest ${HEX_TOKEN}; key ${PROVIDER_KEY}; host ${LOCAL_HOST}.`;
  const rows: unknown[] = [
    {
      dir: "c2s",
      at: 0,
      msg: { type: "input", request_id: REQUEST_ID, prompt, note: UNICODE_NOTE },
    },
    {
      dir: "s2c",
      at: 5,
      msg: { type: "stream_delta", request_id: REQUEST_ID, delta: { message: prompt } },
    },
    {
      dir: "c2s",
      at: 9,
      msg: { type: "control_request", request_id: APPROVAL_ID, tool_call_id: TOOL_CALL_ID },
    },
    {
      dir: "s2c",
      at: 12,
      msg: { type: "control_response", request_id: APPROVAL_ID, decision: "allow" },
    },
    {
      dir: "s2c",
      at: 20,
      msg: {
        type: "update_device_status",
        device_status: {
          owner: NAME,
          connection_name: LOCAL_HOST,
          current_working_directory: WINDOWS_PATH,
          memory_directory: `D:\\private\\${NAME}\\memory`,
          skills: [{ name: "skill", path: `/opt/${NAME}/skill` }],
        },
      },
    },
    {
      dir: "s2c",
      at: 30,
      msg: {
        type: "turn_finished",
        usage: { author: EMAIL, token: BEARER, digest: HEX_TOKEN, key: PROVIDER_KEY },
      },
    },
    {
      // Syntactically synthetic, but the 64-hex tail would still fire
      // `redaction-token`; the pass must treat it as unsafe and remap it too.
      dir: "s2c",
      at: 40,
      msg: { type: "turn_finished", request_id: `synthetic-${HEX_TOKEN}` },
    },
  ];

  return `${[JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join("\n")}\n`;
}

/**
 * @param args redact.mjs arguments
 * @returns exit code plus captured output
 */
function runRedact(args: string[]): RunResult {
  return runNode([REDACT, ...args]);
}

/**
 * @param root tree to scan
 * @returns exit code plus captured output
 */
function runGate(root: string): RunResult {
  return runNode([GATE, "--root", root]);
}

/**
 * @param args full node arguments
 * @returns exit code plus captured output
 */
function runNode(args: string[]): RunResult {
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  return { status: result.status, stdout, stderr, output: `${stdout}${stderr}` };
}

/**
 * @param text JSONL contents
 * @returns parsed documents, blank lines dropped
 */
function parseJsonl(text: string): unknown[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);
}

/**
 * Every string value under a `request_id` key, in walk order (arrays inherit
 * the key, as in the gate).
 *
 * @param document parsed JSONL document
 * @returns request id values
 */
function collectRequestIds(document: unknown): string[] {
  const found: string[] = [];

  walkStrings(document, "", (key, value) => {
    if (key === "request_id") {
      found.push(value);
    }
  });

  return found;
}

/**
 * @param node current value
 * @param key key the value sits under
 * @param visit called once per string
 */
function walkStrings(
  node: unknown,
  key: string,
  visit: (key: string, value: string) => void,
): void {
  if (typeof node === "string") {
    visit(key, node);

    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      walkStrings(item, key, visit);
    }

    return;
  }

  if (typeof node === "object" && node !== null) {
    for (const [childKey, child] of Object.entries(node)) {
      walkStrings(child, childKey, visit);
    }
  }
}

/**
 * @param value candidate
 * @returns value as a plain object, or an empty object
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

/**
 * Write a tree of regular files below an existing directory.
 *
 * @param root absolute destination directory
 * @param files repo-relative path to contents
 */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);

    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
}

/**
 * @param files repo-relative path to contents
 * @returns absolute temp root, tracked for cleanup
 */
function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "haruyuki-redact-"));

  createdRoots.push(root);
  writeTree(root, files);

  return root;
}

/**
 * Remove a tree bottom-up with unlink/rmdir only (no recursive delete).
 *
 * @param root absolute tree root
 */
function removeTree(root: string): void {
  if (!existsSync(root)) {
    return;
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);

    if (entry.isDirectory()) {
      removeTree(absolute);
    } else {
      unlinkSync(absolute);
    }
  }

  rmdirSync(root);
}

/**
 * @returns the OS user name, or "" when the platform has none
 */
function localUserName(): string {
  try {
    return os.userInfo().username.trim();
  } catch {
    return "";
  }
}
