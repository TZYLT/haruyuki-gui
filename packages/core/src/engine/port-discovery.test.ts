/**
 * Tests for stdout port discovery.
 *
 * Every case builds its own readable stream, so no engine process is spawned:
 * `Readable.from` yields one data event per array entry, which is how a chunk
 * boundary cutting a line in half is reproduced deterministically, and
 * `PassThrough` gives a stream that stays open (the timeout and early-end
 * cases).
 */

import { PassThrough, Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { parseWsUrlLine, PortNotFoundError, waitForWsUrl } from "./port-discovery";
import type { EngineErrorCode } from "./types";

const LISTENING_LINE = "Listening on ws://127.0.0.1:6387";
const WS_LINE = "WebSocket: ws://127.0.0.1:6387/ws";
const WS_URL = "ws://127.0.0.1:6387/ws";
const OPENAI_LINE = "OpenAI: ws://127.0.0.1:1234";

/** One data event per entry, each entry encoded as bytes like a real stdout pipe. */
function streamFromChunks(chunks: readonly string[]): Readable {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk, "utf8")));
}

/** Single-chunk stream that then ends, for the "whole output arrived at once" case. */
function streamFromText(text: string): Readable {
  return streamFromChunks([text]);
}

/** Resolve to the error instead of throwing, so a resolve/reject mismatch fails the assertion. */
async function rejectionOf(promise: Promise<string>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

function expectPortNotFound(error: unknown): PortNotFoundError {
  expect(error).toBeInstanceOf(PortNotFoundError);
  const portError = error as PortNotFoundError;
  expect(portError.code).toBe("PORT_NOT_FOUND");
  return portError;
}

describe("parseWsUrlLine", () => {
  it("accepts exactly a WebSocket line", () => {
    expect(parseWsUrlLine(WS_LINE)).toBe(WS_URL);
  });

  it("tolerates a trailing carriage return", () => {
    expect(parseWsUrlLine(`${WS_LINE}\r`)).toBe(WS_URL);
  });

  it("rejects the listen address, which has no /ws path", () => {
    expect(parseWsUrlLine(LISTENING_LINE)).toBeNull();
  });

  it("rejects the OpenAI line emitted when --openai-api is used", () => {
    // Stress shape: an OpenAI line that does carry a ws:// URL.
    expect(parseWsUrlLine(OPENAI_LINE)).toBeNull();
    // Real 0.6.0 shape (`console.log(\`OpenAI:  ${origin}/v1\`)`, two spaces).
    expect(parseWsUrlLine("OpenAI:  http://127.0.0.1:1234/v1")).toBeNull();
  });

  it("rejects empty and unrelated lines", () => {
    expect(parseWsUrlLine("")).toBeNull();
    expect(parseWsUrlLine("starting engine...")).toBeNull();
    // Leading whitespace means this is not the stdout shape we match.
    expect(parseWsUrlLine(` ${WS_LINE}`)).toBeNull();
  });

  it("does not swallow a URL followed by extra spaces", () => {
    expect(parseWsUrlLine(`${WS_LINE} `)).toBeNull();
  });
});

describe("waitForWsUrl", () => {
  it("finds the URL after the Listening line", async () => {
    const stream = streamFromText(`${LISTENING_LINE}\n${WS_LINE}\n`);

    await expect(waitForWsUrl(stream, 1000)).resolves.toBe(WS_URL);
  });

  it("ignores an OpenAI line that also carries a ws:// URL", async () => {
    const stream = streamFromText(`${LISTENING_LINE}\n${OPENAI_LINE}\n${WS_LINE}\n`);

    await expect(waitForWsUrl(stream, 1000)).resolves.toBe(WS_URL);
  });

  it("reassembles a line split across three chunks", async () => {
    const stream = streamFromChunks([
      `${LISTENING_LINE}\nWebSo`,
      "cket: ws://127.0.0.1:63",
      "87/ws\n",
    ]);

    await expect(waitForWsUrl(stream, 1000)).resolves.toBe(WS_URL);
  });

  it("accepts \\r\\n line endings", async () => {
    const stream = streamFromText(`${LISTENING_LINE}\r\n${WS_LINE}\r\n`);

    await expect(waitForWsUrl(stream, 1000)).resolves.toBe(WS_URL);
  });

  it("resolves when the matching line has no trailing newline", async () => {
    const stream = streamFromText(`${LISTENING_LINE}\n${WS_LINE}`);

    await expect(waitForWsUrl(stream, 1000)).resolves.toBe(WS_URL);
  });

  it("times out with PORT_NOT_FOUND when only the Listening line arrives", async () => {
    // PassThrough stays open, which is what a half-started engine looks like.
    const stream = new PassThrough();
    stream.write(`${LISTENING_LINE}\n`);

    const error = await rejectionOf(waitForWsUrl(stream, 50));
    stream.destroy();

    expectPortNotFound(error);
  });

  it("counts an unterminated last line in the diagnosis", async () => {
    const stream = new PassThrough();
    // No newline: the engine was still writing when the budget ran out, which is
    // exactly the case where "0 line(s) read" would send the reader hunting for
    // the wrong thing.
    stream.write("Listening on ws://127.0.0.1:6387");

    const error = expectPortNotFound(await rejectionOf(waitForWsUrl(stream, 50)));
    stream.destroy();

    expect(error.lineCount).toBe(1);
    expect(error.detail).toContain("1 line(s)");
    expect(error.detail).toContain("Listening on ws://127.0.0.1:6387");
  });

  it("reports how many lines it saw and the last one on timeout", async () => {
    const stream = new PassThrough();
    stream.write(`${LISTENING_LINE}\n`);
    stream.write(`${OPENAI_LINE}\n`);

    const error = expectPortNotFound(await rejectionOf(waitForWsUrl(stream, 50)));
    stream.destroy();

    // Compile-time: the local code is a member of the frozen taxonomy, so the
    // facade can map it onto EngineErrorCode without a cast or a translation table.
    const mapped: EngineErrorCode = error.code;
    expect(mapped).toBe("PORT_NOT_FOUND");

    expect(error.lineCount).toBe(2);
    expect(error.detail).toContain("2 line(s)");
    expect(error.detail).toContain(OPENAI_LINE);
    expect(error.message).toContain("timed out after 50ms");
  });

  it("rejects instead of swallowing a URL followed by extra spaces", async () => {
    expect(parseWsUrlLine(`${WS_LINE} `)).toBeNull();

    const stream = streamFromText(`${WS_LINE} \n`);
    const error = expectPortNotFound(await rejectionOf(waitForWsUrl(stream, 1000)));

    expect(error.detail).toContain("ended");
  });

  it("rejects when the stream ends before the URL arrives, without waiting for the timeout", async () => {
    const stream = streamFromText(`${LISTENING_LINE}\n`);
    const startedAt = Date.now();

    const error = expectPortNotFound(await rejectionOf(waitForWsUrl(stream, 5000)));
    const elapsedMs = Date.now() - startedAt;

    expect(error.detail).toContain("ended");
    expect(error.lineCount).toBe(1);
    // Far below the 5 s timeout: proof that `end` rejects rather than hangs.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("rejects immediately when the stream had already ended", async () => {
    // Drain the fixture first so `readableEnded` is true before port discovery
    // attaches; without the guard this case would hang until the timeout.
    const stream = streamFromText(`${LISTENING_LINE}\n`);
    await new Promise<void>((resolve) => {
      stream.on("end", () => {
        resolve();
      });
      stream.resume();
    });

    const startedAt = Date.now();
    const error = expectPortNotFound(await rejectionOf(waitForWsUrl(stream, 5000)));

    expect(error.detail).toContain("already ended");
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("rejects with PORT_NOT_FOUND when the stream itself errors", async () => {
    const stream = new PassThrough();
    stream.write(`${LISTENING_LINE}\n`);
    stream.destroy(new Error("stdout pipe closed"));

    const error = expectPortNotFound(await rejectionOf(waitForWsUrl(stream, 1000)));

    expect(error.detail).toContain("failed");
  });
});
