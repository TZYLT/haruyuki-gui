import { describe, expect, it } from "vitest";

import {
  CYCLE_PLACEHOLDER,
  REDACTED,
  TOKEN_FILE_PLACEHOLDER,
  redactDiagnosticText,
  redactText,
  redactValue,
} from "../diagnostics/redact.js";

/** The home directory the corpus is written against. */
const HOME = "C:\\Users\\ana";

describe("redactText and the home directory", () => {
  it("replaces the home path in both separator styles", () => {
    const text = [
      "cwd C:\\Users\\ana\\proj\\apps\\a.ts",
      "config C:/Users/ana/proj/apps/a.ts",
      "bare C:\\Users\\ana",
    ].join("\n");

    expect(redactText(text, { homeDir: HOME })).toBe(
      ["cwd ~\\proj\\apps\\a.ts", "config ~/proj/apps/a.ts", "bare ~"].join("\n"),
    );
  });

  it("replaces the escaped spelling a JSON file contains", () => {
    // Bundle files are JSON, and JSON doubles the backslashes. Matching only the
    // OS spelling would leave the user's name in every structured path.
    const document = JSON.stringify({ path: "C:\\Users\\ana\\proj\\a.ts" });
    const out = redactText(document, { homeDir: HOME });

    expect(out).not.toContain("ana");
    expect((JSON.parse(out) as { path: string }).path).toBe("~\\proj\\a.ts");
  });

  it("does not eat a longer name that starts with the same characters", () => {
    // `C:\Users\ana` is a prefix of `C:\Users\anonymous`; replacing on a prefix
    // would corrupt a path that has nothing to do with the user's home.
    const text = "C:\\Users\\anonymous\\proj";

    expect(redactText(text, { homeDir: HOME })).toBe(text);
  });

  it("leaves nothing to replace when no home directory is known", () => {
    const text = "C:\\Users\\ana\\proj";

    expect(redactText(text)).toBe(text);
  });

  it.runIf(process.platform === "win32")("matches case-insensitively on Windows", () => {
    expect(redactText("C:\\USERS\\ANA\\proj", { homeDir: HOME })).toBe("~\\proj");
  });
});

describe("redactText and secrets", () => {
  it("keeps the label and drops the value, so the line stays readable", () => {
    expect(redactText("Authorization: Bearer abc.def-123")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactText("sent Bearer eyJhbGciOi.abc")).toBe(`sent Bearer ${REDACTED}`);
    expect(redactText("token=abc123")).toBe(`token=${REDACTED}`);
    expect(redactText("password=hunter2")).toBe(`password=${REDACTED}`);
  });

  it("redacts JSON values without breaking the document", () => {
    const document = JSON.stringify({
      token: "abc123",
      apiKey: "key-1",
      api_key: "key-2",
      password: "hunter2",
      Authorization: "Bearer abc123",
      keep: "this is fine",
    });
    const out = redactText(document, { homeDir: HOME });
    const parsed = JSON.parse(out) as Record<string, unknown>;

    expect(parsed["token"]).toBe(REDACTED);
    expect(parsed["apiKey"]).toBe(REDACTED);
    expect(parsed["api_key"]).toBe(REDACTED);
    expect(parsed["password"]).toBe(REDACTED);
    expect(parsed["Authorization"]).toBe(REDACTED);
    expect(parsed["keep"]).toBe("this is fine");
  });

  it("redacts a token in a query string and keeps the rest of the query", () => {
    expect(redactText("connecting ws://127.0.0.1:7788/api?token=abc123&user=bob")).toBe(
      `connecting ws://127.0.0.1:7788/api?token=${REDACTED}&user=bob`,
    );
  });

  it("replaces a local token-file path with a placeholder", () => {
    // The flag is the diagnostic fact; the path is where the secret lives. The
    // separator the caller wrote is kept, so the command line still reads as one.
    const cases: readonly [string, string][] = [
      ["--ws-token-file C:\\tokens\\engine", `--ws-token-file ${TOKEN_FILE_PLACEHOLDER}`],
      ["--ws-token-file=C:\\tokens\\engine", `--ws-token-file=${TOKEN_FILE_PLACEHOLDER}`],
      ['--ws-token-file "C:\\tokens\\engine"', `--ws-token-file ${TOKEN_FILE_PLACEHOLDER}`],
    ];

    for (const [input, expected] of cases) {
      expect(redactText(input), input).toBe(expected);
    }
  });

  it("redacts a value the caller already knows", () => {
    expect(redactText("engine runToken 9f8e7d6c5b4a", { secrets: ["9f8e7d6c5b4a"] })).toBe(
      `engine runToken ${REDACTED}`,
    );
  });

  it("does not redact words that merely contain a key name", () => {
    // The false positive that makes a redactor useless: `tokenizer` is a
    // component name, `tokens_used` is a metric, and blanking them hides the
    // evidence the bundle exists to carry.
    const text = [
      "tokenizer=byte-pair",
      "tokenizer: bpe",
      '"tokenizer": "bpe"',
      "tokenizer.initialize()",
    ].join("\n");

    expect(redactText(text)).toBe(text);
  });

  it("keeps the line structure", () => {
    const text = "a\ntoken=abc\nc";

    expect(redactText(text).split("\n")).toHaveLength(3);
  });
});

describe("redactValue", () => {
  it("redacts secret-named keys at any depth and in arrays", () => {
    const out = redactValue({
      engine: { runToken: "abc", apiKey: "key", wsToken: "ws", name: "engine-1" },
      list: [{ password: "p" }, { safe: "value" }],
      authorization: "Bearer x",
      count: 3,
    });

    expect(out).toEqual({
      engine: { runToken: REDACTED, apiKey: REDACTED, wsToken: REDACTED, name: "engine-1" },
      list: [{ password: REDACTED }, { safe: "value" }],
      authorization: REDACTED,
      count: 3,
    });
  });

  it("redacts homes and secrets inside ordinary strings too", () => {
    const out = redactValue(
      { path: "C:\\Users\\ana\\proj\\a.ts", note: "token=abc123" },
      { homeDir: HOME },
    );

    expect(out).toEqual({ path: "~\\proj\\a.ts", note: `token=${REDACTED}` });
  });

  it("survives a cycle instead of hanging", () => {
    const root: Record<string, unknown> = { name: "root" };

    root["self"] = root;

    const out = redactValue(root);

    expect(out["name"]).toBe("root");
    expect(out["self"]).toBe(CYCLE_PLACEHOLDER);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("copies a shared reference twice rather than calling it a cycle", () => {
    const shared = { n: 1 };
    const out = redactValue({ a: shared, b: shared });

    expect(out["a"]).toEqual({ n: 1 });
    expect(out["b"]).toEqual({ n: 1 });
  });

  it("keeps the value of a key called tokenizer", () => {
    expect(redactValue({ tokenizer: "bpe" })).toEqual({ tokenizer: "bpe" });
  });

  it("returns JSON-safe values for what JSON cannot represent", () => {
    const out = redactValue({
      missing: undefined,
      gone: () => 1,
      big: 1n,
      at: new Date("2026-11-16T00:00:00.000Z"),
    });

    expect(JSON.parse(JSON.stringify(out))).toEqual({
      missing: null,
      gone: null,
      big: null,
      at: "2026-11-16T00:00:00.000Z",
    });
  });

  it("does not mutate the input", () => {
    const value = { token: "abc" };

    redactValue(value);

    expect(value.token).toBe("abc");
  });
});

describe("redactDiagnosticText", () => {
  it("applies the same policy as redactText for bundle prose", () => {
    const text = "home C:\\Users\\ana\\proj\nws token=abc123\n";

    expect(redactDiagnosticText(text, { homeDir: HOME })).toBe(
      `home ~\\proj\nws token=${REDACTED}\n`,
    );
  });
});
