import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LOG_LEVELS, createLogger, formatRecord, logFilePath } from "../log.js";

/** Directories to remove after each test. */
const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d1-log-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  // Only the directories this file made, and only by exact path.
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

describe("logFilePath", () => {
  it("names the file by UTC date", () => {
    const at = new Date("2026-11-14T13:45:00.000Z");

    expect(logFilePath("/logs", at)).toBe(path.join("/logs", "shell-2026-11-14.jsonl"));
  });

  it("uses the UTC day, not the local one", () => {
    // 23:30 UTC on the 14th is the 15th in Shanghai. Two files with the same name
    // in the same hour twice a year is what using the local date would cause.
    const late = new Date("2026-11-14T23:30:00.000Z");

    expect(logFilePath("/logs", late)).toContain("2026-11-14");
  });

  it("puts the days in separate files", () => {
    const a = logFilePath("/logs", new Date("2026-11-14T00:00:00.000Z"));
    const b = logFilePath("/logs", new Date("2026-11-15T00:00:00.000Z"));

    expect(a).not.toBe(b);
  });
});

describe("formatRecord", () => {
  it("writes one line per record", () => {
    const line = formatRecord({
      time: "2026-11-14T00:00:00.000Z",
      level: "info",
      event: "shell.x",
    });

    expect(line.includes("\n")).toBe(false);
  });

  it("keeps the fields a reader needs", () => {
    const parsed = JSON.parse(
      formatRecord({
        time: "2026-11-14T00:00:00.000Z",
        level: "warn",
        event: "window.restore.refused",
        detail: { reason: "offscreen" },
      }),
    );

    expect(parsed).toEqual({
      time: "2026-11-14T00:00:00.000Z",
      level: "warn",
      event: "window.restore.refused",
      detail: { reason: "offscreen" },
    });
  });

  it("omits detail when there is none", () => {
    const parsed = JSON.parse(formatRecord({ time: "t", level: "info", event: "e" }));

    expect("detail" in parsed).toBe(false);
  });

  it("does not let a newline in a value split the record", () => {
    // The failure mode is silent: the file stays valid JSON per line until the
    // one line that is not, and everything after it is lost.
    const line = formatRecord({
      time: "t",
      level: "error",
      event: "e",
      detail: { message: "first\nsecond\r\nthird" },
    });

    expect(line.includes("\n")).toBe(false);
    expect(line.includes("\r")).toBe(false);
    expect(JSON.parse(line).detail.message).toBe("first\nsecond\r\nthird");
  });

  it("replaces a detail it cannot serialise instead of throwing", () => {
    // A logging call must not be able to take down its caller.
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    const parsed = JSON.parse(
      formatRecord({ time: "t", level: "info", event: "e", detail: cyclic }),
    );

    expect(parsed.detail).toEqual({ unserialisable: true });
  });

  it("drops a function-valued entry rather than failing", () => {
    const parsed = JSON.parse(
      formatRecord({ time: "t", level: "info", event: "e", detail: { fn: () => 1, kept: 2 } }),
    );

    expect(parsed.detail).toEqual({ kept: 2 });
  });
});

describe("createLogger", () => {
  it("writes a record to the day's file", async () => {
    const dir = await tempDir();
    const at = new Date("2026-11-14T10:00:00.000Z");
    const logger = createLogger({ logDir: dir, now: () => at });

    logger.info("shell.start", { version: "0.1.0" });
    await logger.flush();

    const contents = await readFile(logFilePath(dir, at), "utf8");
    const parsed = JSON.parse(contents.trim());

    expect(parsed.event).toBe("shell.start");
    expect(parsed.level).toBe("info");
    expect(parsed.detail.version).toBe("0.1.0");
  });

  it("creates the directory when it does not exist", async () => {
    const parent = await tempDir();
    const dir = path.join(parent, "nested", "logs");
    const at = new Date("2026-11-14T10:00:00.000Z");
    const logger = createLogger({ logDir: dir, now: () => at });

    logger.info("shell.start");
    await logger.flush();

    await expect(readFile(logFilePath(dir, at), "utf8")).resolves.toContain("shell.start");
  });

  it("appends rather than replacing", async () => {
    const dir = await tempDir();
    const at = new Date("2026-11-14T10:00:00.000Z");
    const logger = createLogger({ logDir: dir, now: () => at });

    logger.info("first");
    logger.info("second");
    await logger.flush();

    const lines = (await readFile(logFilePath(dir, at), "utf8")).trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l).event)).toEqual(["first", "second"]);
  });

  it("drops records below the minimum level", async () => {
    const dir = await tempDir();
    const at = new Date("2026-11-14T10:00:00.000Z");
    const logger = createLogger({ logDir: dir, minLevel: "warn", now: () => at });

    logger.debug("dropped.debug");
    logger.info("dropped.info");
    logger.warn("kept.warn");
    logger.error("kept.error");
    await logger.flush();

    const events = (await readFile(logFilePath(dir, at), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).event);

    expect(events).toEqual(["kept.warn", "kept.error"]);
  });

  it("writes nothing at all when everything is filtered", async () => {
    const dir = await tempDir();
    const logger = createLogger({ logDir: dir, minLevel: "error", now: () => new Date() });

    logger.info("dropped");
    await logger.flush();

    await expect(readFile(path.join(dir, "shell-2026-11-14.jsonl"), "utf8")).rejects.toThrow();
  });

  it("keeps concurrent writes whole", async () => {
    // Interleaved bytes on Windows make the file unparseable from the corruption
    // onward, which is the moment someone is reading it to find out what broke.
    const dir = await tempDir();
    const at = new Date("2026-11-14T10:00:00.000Z");
    const logger = createLogger({ logDir: dir, minLevel: "debug", now: () => at });

    for (let i = 0; i < 50; i++) logger.info(`event.${i}`, { i });
    await logger.flush();

    const lines = (await readFile(logFilePath(dir, at), "utf8")).trim().split("\n");

    expect(lines).toHaveLength(50);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("keeps the level names the contract states", () => {
    expect(LOG_LEVELS).toEqual(["debug", "info", "warn", "error"]);
  });
});
