/**
 * W-15's real-engine half, opt-in.
 *
 * It is skipped unless `E1_ENGINE` names the engine package entry. The engine
 * is the 0.6.0 npm package (`haruyuki.js`), not a Windows executable: the
 * `server` argv prints a WebSocket URL and accepts a capability token, which is
 * all a command round trip needs.
 *
 * Run with:
 *   E1_ENGINE=J:/Projects/Haruyuki-desktop/_research/engine-0.6.0/package/haruyuki.js \
 *     pnpm vitest run packages/core/src/command/w15-real-engine.test.ts
 *
 * The renderer half is not in this test; the fake-port seam test covers the
 * dispatcher/merger/sender, and the desktop renderer tests cover the client.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openTransport, type EngineTransport } from "../engine/client/transport.js";
import { buildFrame } from "../engine/client/send.js";
import { createFrameReader } from "../engine/client/frame-reader.js";
import { createChannel } from "../engine/client/channel.js";
import { createCommandDispatcher } from "./dispatch.js";

const ENGINE = process.env["E1_ENGINE"];
const enabled = typeof ENGINE === "string" && existsSync(ENGINE);

let child: ChildProcess | null = null;
let transport: EngineTransport | null = null;
let temp: string | null = null;

/** @param stream a child stream @param pattern the line to wait for @returns the captured URL */
function waitForUrl(stream: NodeJS.ReadableStream, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error("engine did not print a WebSocket URL")),
      15_000,
    );

    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const line = buffer.split(/\r?\n/).find((item) => pattern.test(item));

      if (line !== undefined) {
        clearTimeout(timer);
        resolve(line.trim());
      }
    });
  });
}

describe.skipIf(!enabled)("W-15 real engine", () => {
  beforeAll(async () => {
    temp = mkdtempSync(join(tmpdir(), "e1-w15-"));
    const tokenPath = join(temp, "ws-token.txt");
    const token = "a".repeat(64);
    writeFileSync(tokenPath, token);

    child = spawn(
      process.execPath,
      [
        ENGINE as string,
        "server",
        "--listen",
        "ws://127.0.0.1:0",
        "--ws-auth",
        "capability-token",
        "--ws-token-file",
        tokenPath,
      ],
      {
        cwd: temp,
        env: { ...process.env, HARUYUKI_HOME: temp },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const line = await waitForUrl(child.stdout as NodeJS.ReadableStream, /^WebSocket:\s+/);
    const url = line.replace(/^WebSocket:\s+/, "").trim();
    const actualToken = readFileSync(tokenPath, "utf8").trim();

    transport = await openTransport(url, actualToken);
  }, 30_000);

  afterAll(() => {
    transport?.close();
    child?.kill();

    // Windows keeps a handle briefly after the child stops; the temp directory
    // is disposable, so a failed sweep is not a test failure.
    if (temp !== null) {
      try {
        rmSync(temp, { recursive: true, force: true });
      } catch {
        // leave the OS temp directory for the next cleanup
      }
    }
  });

  it("answers device.info through a real channel", async () => {
    const active = transport;

    if (active === null) throw new Error("transport was not opened");

    const channel = createChannel({
      agentId: "__control__",
      reader: createFrameReader(),
      write: (request, requestId) => {
        const frame = buildFrame(request, {}, requestId);
        active.send(frame.raw);
      },
    });
    active.onFrame(({ raw }) => channel.ingest(raw));
    const dispatcher = createCommandDispatcher({ getChannel: () => channel });
    const reply = await dispatcher.invoke({ capability: "device.info", body: {} });

    expect(reply.ok).toBe(true);

    if (reply.ok) {
      expect(reply.completion).toBe("answered");
      expect(reply.data).toBeTruthy();
    }
  }, 20_000);

  it("returns accepted for terminal.kill, an untracked capability", async () => {
    const active = transport;

    if (active === null) throw new Error("transport was not opened");

    const channel = createChannel({
      agentId: "__control__",
      reader: createFrameReader(),
      write: (request, requestId) => active.send(buildFrame(request, {}, requestId).raw),
    });
    active.onFrame(({ raw }) => channel.ingest(raw));
    const dispatcher = createCommandDispatcher({ getChannel: () => channel });
    const reply = await dispatcher.invoke({
      capability: "terminal.kill",
      body: { terminal_id: "e1-w15-missing" },
    });

    expect(reply).toEqual({ ok: true, completion: "accepted" });
  }, 20_000);
});
