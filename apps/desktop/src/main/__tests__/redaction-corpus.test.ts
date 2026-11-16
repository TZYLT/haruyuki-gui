/**
 * The redaction corpus: a table of the shapes that must be removed, and a table
 * of the shapes that must survive.
 *
 * The unit test next door states one case per behaviour. This file is the
 * regression net: it enumerates the spellings a secret actually takes in the
 * files a bundle carries (Windows and POSIX homes, headers, query strings, JSON
 * keys, camel and snake case) and the ordinary text that a careless pattern
 * would mangle. Every case is data, so adding a spelling is one row.
 *
 * Every case is data, so adding a spelling is one row. The edge cases at the end
 * cover a bare JSON `key` field and a rate metric that contains the word
 * `tokens`; both are asserted as required behaviour, not as known gaps.
 */

import { describe, expect, it } from "vitest";

import {
  CYCLE_PLACEHOLDER,
  REDACTED,
  TOKEN_FILE_PLACEHOLDER,
  redactDiagnosticText,
  redactValue,
} from "../diagnostics/redact.js";

/** The Windows home every case is written against. */
const HOME_WIN = String.raw`C:\Users\ana`;
/** The POSIX home, for the same corpus on the other separator. */
const HOME_POSIX = "/home/ana";

/** One corpus row: the text, the home it is written against, and the result. */
interface TextCase {
  readonly name: string;
  readonly input: string;
  readonly homeDir: string;
  readonly expected: string;
}

describe("home paths", () => {
  const cases: readonly TextCase[] = [
    {
      name: "windows backslashes, mid-line",
      input: String.raw`cwd C:\Users\ana\proj\apps\a.ts`,
      homeDir: HOME_WIN,
      expected: String.raw`cwd ~\proj\apps\a.ts`,
    },
    {
      name: "windows forward slashes",
      input: "cwd C:/Users/ana/proj/apps/a.ts",
      homeDir: HOME_WIN,
      expected: "cwd ~/proj/apps/a.ts",
    },
    {
      name: "windows home alone on a line",
      input: String.raw`C:\Users\ana`,
      homeDir: HOME_WIN,
      expected: "~",
    },
    {
      name: "windows home followed by a quote",
      input: String.raw`path="C:\Users\ana\proj"`,
      homeDir: HOME_WIN,
      expected: String.raw`path="~\proj"`,
    },
    {
      name: "posix home",
      input: "/home/ana/proj/apps/a.ts",
      homeDir: HOME_POSIX,
      expected: "~/proj/apps/a.ts",
    },
    {
      name: "every occurrence, not the first",
      input: `${String.raw`C:\Users\ana\a`} and ${String.raw`C:\Users\ana\b`}`,
      homeDir: HOME_WIN,
      expected: String.raw`~\a and ~\b`,
    },
    {
      name: "home in a JSON-escaped document",
      input: JSON.stringify({ path: String.raw`C:\Users\ana\proj\a.ts` }),
      homeDir: HOME_WIN,
      expected: JSON.stringify({ path: String.raw`~\proj\a.ts` }),
    },
  ];

  for (const testCase of cases) {
    it(`replaces the ${testCase.name}`, () => {
      const out = redactDiagnosticText(testCase.input, { homeDir: testCase.homeDir });

      expect(out).toBe(testCase.expected);
      expect(out).not.toContain("ana");
    });
  }

  it("does not eat a different user whose name starts with the same letters", () => {
    const out = redactDiagnosticText(String.raw`C:\Users\anonymous\proj`, { homeDir: HOME_WIN });

    expect(out).toBe(String.raw`C:\Users\anonymous\proj`);
  });

  it("replaces nothing when no home is known", () => {
    const text = String.raw`C:\Users\ana\proj`;

    expect(redactDiagnosticText(text)).toBe(text);
  });
});

describe("secret shapes", () => {
  /** A secret value that must not appear, and the marker that replaces it. */
  interface SecretCase {
    readonly name: string;
    readonly input: string;
    readonly secret: string;
    /** Defaults to {@link REDACTED}; a token-file path gets its own marker. */
    readonly marker?: string;
  }

  const CASES: readonly SecretCase[] = [
    {
      name: "authorization header with a bearer token",
      input: "Authorization: Bearer abc.def-123_456",
      secret: "abc.def-123_456",
    },
    {
      name: "lower-case authorization header",
      input: "authorization: bearer sk-live-9f8e7d",
      secret: "sk-live-9f8e7d",
    },
    {
      name: "token in a query string",
      input: "ws://h/api?token=abc123&user=bob",
      secret: "abc123",
    },
    { name: "password assignment", input: "password=hunter2", secret: "hunter2" },
    { name: "api key assignment", input: "API_KEY=sk-live-xyz", secret: "sk-live-xyz" },
    { name: "secret assignment", input: "client_secret=shhh-1234", secret: "shhh-1234" },
    {
      name: "credential assignment",
      input: "credential=creds-9876",
      secret: "creds-9876",
    },
    {
      name: "JSON token field",
      input: JSON.stringify({ token: "tok-live-4242", endpoint: "https://x" }),
      secret: "tok-live-4242",
    },
    {
      name: "JSON apiKey field",
      input: JSON.stringify({ apiKey: "sk-live-5555", safe: "keep me" }),
      secret: "sk-live-5555",
    },
    {
      name: "JSON snake-case api_key field",
      input: JSON.stringify({ api_key: "sk-live-6666" }),
      secret: "sk-live-6666",
    },
    {
      name: "JSON password field",
      input: JSON.stringify({ password: "hunter2" }),
      secret: "hunter2",
    },
    {
      name: "JSON secret field",
      input: JSON.stringify({ secret: "s3cr3t-value" }),
      secret: "s3cr3t-value",
    },
    {
      name: "JSON authorization field",
      input: JSON.stringify({ authorization: "Bearer abc123" }),
      secret: "abc123",
    },
    {
      name: "cookie header",
      input: "Cookie: sid=abcdef123; theme=dark",
      secret: "abcdef123",
    },
    {
      name: "set-cookie header",
      input: "Set-Cookie: session=xyz-987",
      secret: "xyz-987",
    },
    {
      name: "colon-form api key header",
      input: "X-Api-Key: sk-live-header",
      secret: "sk-live-header",
    },
    {
      name: "colon-form token field",
      input: "token: tok-colon-42",
      secret: "tok-colon-42",
    },
    {
      name: "token file flag",
      input: String.raw`--ws-token-file C:\tokens\engine`,
      secret: String.raw`C:\tokens\engine`,
      // The path is not a secret value but a location: the marker says so.
      marker: TOKEN_FILE_PLACEHOLDER,
    },
    {
      name: "run token the caller already knows",
      input: "engine runToken 9f8e7d6c5b4a",
      secret: "9f8e7d6c5b4a",
    },
  ];

  for (const testCase of CASES) {
    it(`removes the secret from ${testCase.name}`, () => {
      const homeDir = HOME_WIN;
      const out = redactDiagnosticText(testCase.input, {
        homeDir,
        secrets: [testCase.secret],
      });

      expect(out).not.toContain(testCase.secret);
      // The label survives: a reader still needs to know a secret was there.
      expect(out).toContain(testCase.marker ?? REDACTED);
    });
  }

  it("keeps the shape of a query string and of a JSON document", () => {
    const query = redactDiagnosticText("ws://h/api?token=abc123&user=bob");

    expect(query).toBe(`ws://h/api?token=${REDACTED}&user=bob`);

    const json = JSON.stringify({ token: "abc123", keep: "value" });
    const parsed = JSON.parse(redactDiagnosticText(json)) as Record<string, unknown>;

    expect(parsed["token"]).toBe(REDACTED);
    expect(parsed["keep"]).toBe("value");
  });

  it("keeps the flag but drops the path of a token file", () => {
    expect(redactDiagnosticText(String.raw`--ws-token-file=C:\tokens\engine`)).toBe(
      `--ws-token-file=${TOKEN_FILE_PLACEHOLDER}`,
    );
  });
});

describe("benign text survives", () => {
  const CASES: readonly string[] = [
    "tokenizer=byte-pair",
    "tokenizer: bpe",
    '"tokenizer": "bpe"',
    "tokenizer.initialize()",
    "tokens used: 42",
    "the token bucket is full",
    "password field is empty",
    "Authorization is required",
    "secretive plans for Tuesday",
    "the API returned 200",
    "GET /api/v1/health 200 3ms",
    "settings version 1, theme light, contrast normal",
  ];

  for (const text of CASES) {
    it(`leaves ${JSON.stringify(text)} alone`, () => {
      expect(redactDiagnosticText(text)).toBe(text);
    });
  }

  it("leaves Chinese text untouched", () => {
    const text = "诊断包导出完成：共 7 个文件，已脱敏。日志路径：~/logs/shell-2026-11-16.jsonl";

    expect(redactDiagnosticText(text)).toBe(text);
  });

  it("keeps a Chinese line readable while removing a home path in it", () => {
    const out = redactDiagnosticText(`${HOME_POSIX}/项目/日志.jsonl 已读取`, {
      homeDir: HOME_POSIX,
    });

    expect(out).toBe("~/项目/日志.jsonl 已读取");
  });
});

describe("structured values", () => {
  it("redacts secret keys at any depth and in arrays, keeping everything else", () => {
    const input = {
      engine: {
        runToken: "tok-1",
        apiKey: "sk-2",
        name: "engine-1",
        nested: { password: "p-3", keep: "visible" },
      },
      list: [{ secret: "s-4" }, { safe: "kept" }, [{ authorization: "Bearer a-5" }]],
      count: 3,
      enabled: true,
      missing: null,
    };
    const out = redactValue(input);

    expect(out).toEqual({
      engine: {
        runToken: REDACTED,
        apiKey: REDACTED,
        name: "engine-1",
        nested: { password: REDACTED, keep: "visible" },
      },
      list: [{ secret: REDACTED }, { safe: "kept" }, [{ authorization: REDACTED }]],
      count: 3,
      enabled: true,
      missing: null,
    });
    // The result must survive the serialisation every bundle writer does.
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("redacts ordinary strings inside the structure too", () => {
    const out = redactValue(
      {
        path: String.raw`C:\Users\ana\proj\a.ts`,
        note: "token=abc123",
        text: "日志正常",
      },
      { homeDir: HOME_WIN },
    );

    expect(out).toEqual({
      path: String.raw`~\proj\a.ts`,
      note: `token=${REDACTED}`,
      text: "日志正常",
    });
  });

  it("survives a cycle at the root and in an array instead of throwing", () => {
    const root: Record<string, unknown> = { name: "root", list: [] as unknown[] };
    const list = root["list"] as unknown[];

    list.push(root);
    root["self"] = root;

    let out: Record<string, unknown> | undefined;

    expect(() => {
      out = redactValue(root);
    }).not.toThrow();
    expect(out?.["name"]).toBe("root");
    expect(out?.["self"]).toBe(CYCLE_PLACEHOLDER);

    const copiedList = out?.["list"] as unknown[] | undefined;

    expect(copiedList?.[0]).toBe(CYCLE_PLACEHOLDER);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("does not mutate the value it was given", () => {
    const input = { token: "abc", nested: { password: "p" } };
    const snapshot = JSON.stringify(input);

    redactValue(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

/**
 * Edge cases that are still real behaviour, not known gaps.
 *
 * The bare `key` field matters because the requirement says the bundle contains
 * no key/token, and `tokens_per_second` is a metric the module promises to keep.
 */
describe("edge cases", () => {
  it("redacts a JSON field named exactly key", () => {
    const out = redactDiagnosticText(JSON.stringify({ key: "sk-live-7777", keep: "value" }));
    const parsed = JSON.parse(out) as Record<string, unknown>;

    expect(parsed["key"]).toBe(REDACTED);
    expect(parsed["keep"]).toBe("value");
  });

  it("redacts a nested value under a key named exactly key", () => {
    const out = redactValue({ nested: { key: "sk-live-8888" } });

    expect(out).toEqual({ nested: { key: REDACTED } });
  });

  it("leaves the tokens_per_second metric alone", () => {
    expect(redactDiagnosticText("tokens_per_second=42")).toBe("tokens_per_second=42");
  });
});
