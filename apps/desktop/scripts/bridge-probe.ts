/**
 * The bridge probe: does D3's IPC path work in a real Electron renderer?
 *
 * Unit tests prove the pieces; this proves the seam. It opens a sandboxed
 * `BrowserWindow` with the real preload, drives a handshake, sends 1 MiB of
 * `term.output` slices through the bounded ingress, and confirms the renderer
 * received and acknowledged every byte. It also sends one bulk frame, so the
 * three delivery channels are exercised rather than only the terminal bypass.
 *
 * The page is a `data:` document with no UI: this is a transport measurement,
 * not a rendering one, and loading the full shell would mix E1's work into the
 * result. The probe prints one `BRIDGERESULT` line and exits.
 */

import { app, BrowserWindow, ipcMain } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";

import type { Frame } from "@haruyuki/protocol";

import { createBridgeHost } from "../src/main/bridge/host.js";
import { registerBridgeIpc } from "../src/main/bridge/register.js";
import { createTerminalIngress, PENDING_CAP_BYTES } from "../src/main/bridge/terminal-ingress.js";

/** The preload the shell builds; the probe bundle sits in `dist/probe`. */
const PRELOAD = path.join(__dirname, "../main/preload.cjs");

/** 8 KiB, C5's fixed terminal slice. */
const CHUNK = 8192;

/** 128 slices = 1 MiB. */
const SLICES = 128;

/** How long any single wait may take. */
const WAIT_MS = 15_000;

/** What the probe reports. */
interface ProbeResult {
  bridgePresent?: boolean;
  accepts?: number;
  termBytes?: number;
  acks?: number;
  bulkFrames?: number;
  notices?: number;
  replayBytes?: number;
  replayTextOk?: boolean;
  boundedPending?: number;
  unboundedPending?: number;
  errors?: string[];
  rss?: number;
  elapsedMs?: number;
}

const result: ProbeResult = { errors: [] };

/** The renderer's probe state, read with `executeJavaScript`. */
interface RendererProbe {
  accepts: number;
  termBytes: number;
  acks: number;
  bulkFrames: number;
  notices: number;
  replayText: string;
  errors: string[];
}

function finish(code: number): void {
  process.stdout.write(`BRIDGERESULT ${JSON.stringify(result)}\n`);
  app.exit(code);
}

/** Wait until `read` returns true or the deadline passes. */
async function waitFor(read: () => Promise<boolean>, timeoutMs = WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await read()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return false;
}

/** Install the page-side listeners and send the ready frame. */
const PAGE_SETUP = `
(() => {
  const probe = { accepts: 0, termBytes: 0, acks: 0, bulkFrames: 0, notices: 0, replayText: "", errors: [] };
  window.__d3probe = probe;

  window.haruyuki.on("bridge:control.frame.deliver", (payload) => {
    try {
      const frame = JSON.parse(payload);
      if (frame.t === "bridge.accept") probe.accepts += 1;
    } catch (error) {
      probe.errors.push("control: " + String(error));
    }
  });

  window.haruyuki.on("bridge:stream.frame.deliver", (payload) => {
    try {
      const frame = JSON.parse(payload);
      if (frame.t !== "term.output") return;
      probe.termBytes += frame.body.bytes;
      if (frame.body.terminal_id === "replay") probe.replayText += frame.body.text;
      if (window.__d3probeNoAck === true) return;
      window.haruyuki
        .invoke("bridge:stream.terminal.ack", {
          terminal_id: frame.body.terminal_id,
          bytes: frame.body.bytes,
        })
        .then(() => { probe.acks += 1; })
        .catch((error) => probe.errors.push("ack: " + String(error)));
    } catch (error) {
      probe.errors.push("stream: " + String(error));
    }
  });

  window.haruyuki.on("bridge:bulk.frame.deliver", (payload) => {
    try {
      const frame = JSON.parse(payload);
      if (frame.t === "bulk.page") probe.bulkFrames += 1;
    } catch (error) {
      probe.errors.push("bulk: " + String(error));
    }
  });

  window.haruyuki.on("bridge:stream.terminal.notice", (payload) => {
    try {
      const notice = typeof payload === "string" ? JSON.parse(payload) : payload;
      probe.notices += 1;
      probe.errors.push("notice: " + JSON.stringify(notice));
    } catch (error) {
      probe.errors.push("notice: " + String(error));
    }
  });

  window.haruyuki
    .invoke("bridge:control.frame.submit", JSON.stringify({
      v: 1, ch: "control", seq: 0, t: "bridge.ready",
      body: { appVersion: "probe", bridgeVersion: "1" },
    }))
    .catch((error) => probe.errors.push("ready: " + String(error)));
})();
`;

/** Read the renderer's counters. */
async function readRenderer(window: BrowserWindow): Promise<RendererProbe> {
  const value = (await window.webContents.executeJavaScript("window.__d3probe", true)) as
    RendererProbe | undefined;

  return value ?? { accepts: 0, termBytes: 0, acks: 0, bulkFrames: 0, notices: 0, errors: [] };
}

/** One terminal frame; `text` is ASCII so byte count equals length. */
function termFrame(index: number): Frame {
  return {
    v: 1,
    ch: "stream",
    seq: 0,
    t: "term.output",
    body: {
      terminal_id: "probe",
      slice: index,
      slices: SLICES,
      offset: index * CHUNK,
      bytes: CHUNK,
      final: index === SLICES - 1,
      text: "x".repeat(CHUNK),
    },
  } as Frame;
}

async function main(): Promise<void> {
  const started = Date.now();

  // The replay phase destroys the first window before opening the second. On
  // Windows Electron's default `window-all-closed` would quit the app in that
  // gap, and the second `loadFile` would fail with ERR_FAILED.
  app.on("window-all-closed", () => {});

  await app.whenReady();

  const host = createBridgeHost({
    expectedBridgeVersion: "1",
    coreVersion: "probe",
    bulkPages: 0,
  });

  registerBridgeIpc({ ipc: ipcMain, host });

  const window = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    result.errors?.push(`preload-error ${preloadPath}: ${error.message}`);
  });

  host.attach(window.webContents, "boot");

  // A `file:` document rather than `data:`: Electron does not run a preload for
  // an opaque data URL, and a missing preload would be reported as "the bridge
  // is broken" rather than "the probe chose the wrong URL".
  const pagePath = path.join(app.getPath("temp"), `haruyuki-d3-probe-${process.pid}.html`);

  writeFileSync(pagePath, "<!doctype html><html><body><p>d3 probe</p></body></html>");

  await window.loadFile(pagePath);

  result.bridgePresent =
    (await window.webContents.executeJavaScript("typeof window.haruyuki", true)) === "object";

  if (!result.bridgePresent) {
    result.errors?.push("window.haruyuki missing");
    finish(1);
    return;
  }

  await window.webContents.executeJavaScript(PAGE_SETUP, true);

  const accepted = await waitFor(async () => (await readRenderer(window)).accepts > 0);

  if (!accepted) {
    result.errors?.push("no bridge.accept");
    finish(1);
    return;
  }

  for (let index = 0; index < SLICES; index += 1) host.send(termFrame(index));

  const allBytes = await waitFor(
    async () => (await readRenderer(window)).termBytes >= SLICES * CHUNK,
  );

  // One bulk frame, to prove the third delivery channel is not dead.
  host.send({
    v: 1,
    ch: "bulk",
    seq: 0,
    t: "bulk.page",
    body: { items: [1, 2, 3], page: 0 },
  } as Frame);

  const gotBulk = await waitFor(async () => (await readRenderer(window)).bulkFrames > 0);

  // The acks are asynchronous; wait for the last one after the bytes arrived.
  await waitFor(async () => (await readRenderer(window)).acks >= SLICES, 5_000);

  const renderer = await readRenderer(window);
  const firstTermBytes = renderer.termBytes;

  result.accepts = renderer.accepts;
  result.termBytes = firstTermBytes;
  result.acks = renderer.acks;
  result.bulkFrames = renderer.bulkFrames;
  result.notices = renderer.notices;
  result.errors = [...(result.errors ?? []), ...renderer.errors];

  // The content half: bytes the old renderer received but never acked must
  // appear in the next renderer. The page stops acking, eight 1 KiB slices go
  // in flight, then a detach + second page must replay exactly those bytes.
  await window.webContents.executeJavaScript("window.__d3probeNoAck = true", true);

  const REPLAY_CHUNK = 1024;
  const REPLAY_SLICES = 8;
  const replayText = "R".repeat(REPLAY_CHUNK);

  for (let index = 0; index < REPLAY_SLICES; index += 1) {
    host.send({
      v: 1,
      ch: "stream",
      seq: 0,
      t: "term.output",
      body: {
        terminal_id: "replay",
        slice: index,
        slices: REPLAY_SLICES,
        offset: index * REPLAY_CHUNK,
        bytes: REPLAY_CHUNK,
        final: index === REPLAY_SLICES - 1,
        text: replayText,
      },
    } as Frame);
  }

  const firstGotReplay = await waitFor(
    async () => (await readRenderer(window)).replayText.length === REPLAY_CHUNK * REPLAY_SLICES,
  );

  host.detach("reload");
  window.destroy();

  const second = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  host.attach(second.webContents, "load");

  const secondPage = path.join(app.getPath("temp"), `haruyuki-d3-probe-2-${process.pid}.html`);

  writeFileSync(secondPage, "<!doctype html><html><body><p>d3 probe 2</p></body></html>");

  await second.loadFile(secondPage);

  await second.webContents.executeJavaScript("window.__d3probeNoAck = true", true);
  await second.webContents.executeJavaScript(PAGE_SETUP, true);

  const secondGotReplay = await waitFor(
    async () => (await readRenderer(second)).replayText.length === REPLAY_CHUNK * REPLAY_SLICES,
  );

  const secondProbe = await readRenderer(second);

  result.replayBytes = secondProbe.replayText.length;
  result.replayTextOk =
    firstGotReplay &&
    secondGotReplay &&
    secondProbe.replayText === replayText.repeat(REPLAY_SLICES);
  result.errors = [...(result.errors ?? []), ...secondProbe.errors];

  second.destroy();

  // The reverse half, run in the real main process: the bounded entry must
  // hold at the cap, and the `Infinity` variant must exceed it. The second
  // number is the one that proves the cap is doing the work.
  const bounded = createTerminalIngress();
  const unbounded = createTerminalIngress({ pendingCapBytes: Infinity });

  bounded.attach(() => {});
  unbounded.attach(() => {});

  for (let index = 0; index < 1280; index += 1) {
    const payload = `flood-${index}`;
    const body = {
      terminal_id: "flood",
      slice: index,
      slices: 1280,
      offset: index * CHUNK,
      bytes: CHUNK,
      final: index === 1279,
      text: "x".repeat(CHUNK),
    };

    bounded.accept(payload, body);
    unbounded.accept(payload, body);
  }

  result.boundedPending = bounded.stats().pendingBytes;
  result.unboundedPending = unbounded.stats().pendingBytes;

  result.rss = process.memoryUsage().rss;
  result.elapsedMs = Date.now() - started;

  const ok =
    allBytes &&
    gotBulk &&
    firstTermBytes === SLICES * CHUNK &&
    result.replayTextOk === true &&
    (result.boundedPending ?? Infinity) <= PENDING_CAP_BYTES &&
    (result.unboundedPending ?? 0) > PENDING_CAP_BYTES;

  finish(ok ? 0 : 1);
}

void main().catch((error: unknown) => {
  result.errors?.push(error instanceof Error ? error.message : String(error));
  finish(1);
});
