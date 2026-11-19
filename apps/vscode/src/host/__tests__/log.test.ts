/**
 * The log channel: the lines it writes, and the lines it refuses to.
 *
 * The module's contract is negative -- no token, no credential, no conversation
 * content -- so every case here is an absence. They are the cases a shell gets
 * wrong once and then has a support thread with a live token in it, which is why
 * they are asserted rather than reviewed.
 *
 * `OutputChannel` is injected, so the recorder is five lines and no editor runs.
 */

import { describe, expect, it } from "vitest";

import {
  createShellLog,
  describeError,
  REDACTED,
  redactLine,
  type OutputChannelLike,
} from "../log.js";

/** An `OutputChannel` that records the lines appended to it. */
function recorder(): {
  readonly channel: OutputChannelLike;
  readonly lines: string[];
  readonly shows: () => number;
} {
  const lines: string[] = [];
  let shows = 0;

  return {
    lines,
    shows: () => shows,
    channel: {
      appendLine(value: string): void {
        lines.push(value);
      },
      show(): void {
        shows += 1;
      },
    },
  };
}

describe("log: redaction", () => {
  it("scrubs a token in every spelling a shell produces", () => {
    const spelled = [
      "engine argv: --ws-auth capability-token --token=abcd1234",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
      "connecting to ws://127.0.0.1:9000/client?token=abcd1234&x=1",
      "store.get token: abcd1234",
      "apiKey=sk-live-1234",
      "api_key: sk-live-1234",
      'json {"token":"abcd1234"}',
    ];

    for (const line of spelled) {
      const scrubbed = redactLine(line);

      expect(scrubbed).not.toContain("abcd1234");
      expect(scrubbed).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(scrubbed).not.toContain("sk-live-1234");
      expect(scrubbed).toContain(REDACTED);
    }
  });

  it("keeps the key so the line still says what was scrubbed", () => {
    expect(redactLine("token=abcd1234")).toBe(`token=${REDACTED}`);
    expect(redactLine("Authorization: Bearer abcd1234")).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it("is idempotent, so scrubbing twice is scrubbing once", () => {
    const once = redactLine("GET ws://host/x?token=abcd1234");

    expect(redactLine(once)).toBe(once);
  });

  it("leaves a line with no secret alone", () => {
    const line = 'CORE_READY {"engineVersion":"0.6.0","cwd":"/tmp/engine"}';

    expect(redactLine(line)).toBe(line);
  });

  it("does not match a word that merely starts with a secret name", () => {
    // `tokenCount` and `tokenizer` are counters, not credentials.
    const line = "tokenCount=3 tokenizer=ready";

    expect(redactLine(line)).toBe(line);
  });
});

describe("log: error summaries", () => {
  it("reports the code and the message, never the stack", () => {
    const error = Object.assign(new Error("the child refused the fork"), {
      name: "CoreHostError",
      code: "SPAWN_FAILED",
    });

    const summary = describeError(error);

    expect(summary).toEqual({
      name: "CoreHostError",
      message: "the child refused the fork",
      code: "SPAWN_FAILED",
    });
    expect(Object.keys(summary)).not.toContain("stack");
  });

  it("summarises a thrown non-Error without throwing itself", () => {
    expect(describeError("boom").message).toBe("boom");
    expect(describeError(undefined).message).toBe("undefined");
    expect(describeError({ message: "from an object" }).message).toBe("from an object");
    expect(describeError({}).message).toBe("");
  });
});

describe("log: the channel", () => {
  it("prefixes one line and adds nothing of its own", () => {
    const sink = recorder();
    const log = createShellLog({ channel: sink.channel });

    log.write("CORE_PHASE starting");

    expect(sink.lines).toEqual(["[haruyuki] CORE_PHASE starting"]);
  });

  it("redacts before appending, so nothing unfiltered reaches the channel", () => {
    const sink = recorder();
    const log = createShellLog({ channel: sink.channel });

    log.write("argv --ws-token-file=/tmp/token.txt --token=abcd1234");
    log.event("SECURE_GET", { token: "abcd1234", key: "user" });

    expect(sink.lines.join("\n")).not.toContain("abcd1234");
    expect(sink.lines[0]).toContain(REDACTED);
    expect(sink.lines[1]).toContain(REDACTED);
  });

  it("renders an event as one line with its fields", () => {
    const sink = recorder();
    const log = createShellLog({ channel: sink.channel });

    log.event("PANEL_OPEN_REQUESTED", { appVersion: "0.1.0" });

    expect(sink.lines).toEqual(['[haruyuki] PANEL_OPEN_REQUESTED {"appVersion":"0.1.0"}']);
  });

  it("keeps the code when its fields cannot be serialised", () => {
    const sink = recorder();
    const log = createShellLog({ channel: sink.channel });
    const cycle: Record<string, unknown> = {};

    cycle["self"] = cycle;

    log.event("SOMETHING", cycle);

    // A logger that throws inside a failure path replaces the failure it was
    // reporting, so the unserialisable case still produces its line.
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toContain("SOMETHING");
  });

  it("shows the channel only when asked, never as a side effect of a line", () => {
    const sink = recorder();
    const log = createShellLog({ channel: sink.channel });

    expect(sink.shows()).toBe(0);

    log.write("CORE_PHASE starting");
    log.event("CORE_READY");

    expect(sink.shows()).toBe(0);

    log.show();

    expect(sink.shows()).toBe(1);
  });
});

/**
 * A channel that has already been closed under the logger.
 *
 * This is not a hypothetical shape: VS Code tears the output channel down before
 * (or interleaved with) `deactivate`, and the real `appendLine` then throws
 * `Channel has been closed`. A logger that lets that escape turns "one line was
 * not written" into "the extension threw during shutdown", which is how a window
 * closed at launch looks to a user.
 */
function closedChannel(options: { readonly onShow?: () => void } = {}): {
  readonly channel: OutputChannelLike;
  readonly appends: () => number;
  readonly shows: () => number;
} {
  let appends = 0;
  let shows = 0;

  return {
    appends: () => appends,
    shows: () => shows,
    channel: {
      appendLine(): void {
        appends += 1;

        throw new Error("Channel has been closed");
      },
      show(): void {
        shows += 1;

        if (options.onShow !== undefined) {
          options.onShow();
          return;
        }

        throw new Error("Channel has been closed");
      },
    },
  };
}

describe("log: a closed channel must not reach the caller", () => {
  it("swallows a throwing appendLine and counts it", () => {
    const sink = closedChannel();
    const log = createShellLog({ channel: sink.channel });

    expect(() => log.event("EXTENSION_DEACTIVATED", { panel: false })).not.toThrow();
    expect(sink.appends()).toBe(1);
    expect(log.droppedLines).toBe(1);
  });

  it("counts every dropped line and throws none, three times over", () => {
    const sink = closedChannel();
    const log = createShellLog({ channel: sink.channel });

    expect(() => {
      log.write("one");
      log.event("TWO");
      log.failure("THREE", new Error("boom"));
    }).not.toThrow();

    expect(sink.appends()).toBe(3);
    expect(log.droppedLines).toBe(3);
  });

  it("keeps a successful line out of the dropped count", () => {
    const sink = recorder();
    const log = createShellLog({ channel: sink.channel });

    log.write("one");
    log.event("TWO");

    expect(log.droppedLines).toBe(0);

    // A channel that dies mid-session starts counting from there, which is the
    // reading that tells "the channel closed" from "the channel never worked".
    const dying = createShellLog({
      channel: {
        appendLine(): void {
          throw new Error("Channel has been closed");
        },
        show(): void {},
      },
    });

    dying.write("one");

    expect(dying.droppedLines).toBe(1);
  });

  it("swallows a throwing show", () => {
    const sink = closedChannel();
    const log = createShellLog({ channel: sink.channel });

    expect(() => log.show()).not.toThrow();
    expect(sink.shows()).toBe(1);
  });

  it("does not try to log the failure to the same dead channel", () => {
    // The trap: a catch block that calls `append` again loops or throws twice.
    // One attempted write, one dropped line, no exception.
    const sink = closedChannel();
    const log = createShellLog({ channel: sink.channel });

    expect(() => log.write("one")).not.toThrow();
    expect(sink.appends()).toBe(1);
    expect(log.droppedLines).toBe(1);
  });
});
