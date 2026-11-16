/**
 * The media-channel probe: the assertions that need a real renderer.
 *
 * Every other test in this item runs in Node and checks what the main process
 * decides. This one checks what the browser does with that decision, and the
 * three questions it answers cannot be answered any other way:
 *
 *   - a `.txt` served as `text/plain` arrives as a plain-text document, not a
 *          rendered one -- i.e. `nosniff` holds through the custom scheme.
 *   - an `.html` served as `text/plain` does not execute its script. This is the
 *          the security claim the whole channel rests on, and it is measured here
 *          rather than argued from the table.
 *   - a 27 MB image streams without stalling the main process, measured as the
 *          worst gap in this process's own timer.
 *
 * One constraint shapes the whole file, and it is measured rather than assumed: a
 * second `BrowserWindow` in the same process fails to load this scheme, so there
 * is exactly one window and each stage navigates it in turn. A probe that made a
 * fresh window per stage would be measuring window creation.
 *
 * The report goes to a file and is flushed after every stage. `app.exit` does not
 * drain piped stdout on Windows, and one crashing stage must not discard the
 * measurements the earlier ones already produced.
 */

import { app, BrowserWindow, protocol } from "electron";
import { appendFileSync, writeFileSync, writeSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createMediaHandler, MEDIA_PRIVILEGES, MEDIA_SCHEME } from "../src/main/media-protocol.js";
import { MEDIA_TYPE_POLICY } from "../src/main/media-mime.js";
import { APP_PRIVILEGES, APP_SCHEME } from "../src/main/protocol.js";

/** Everything the probe reports. */
interface ProbeResult {
  textContentType?: string;
  textRefused?: boolean;
  htmlContentType?: string;
  htmlExecuted?: boolean;
  imageOutcome?: string;
  imageBytes?: number;

  imageWorstGapMs?: number;
  exeRefused?: boolean;
  outsideRefused?: boolean;
  fatal?: string;
}

const result: ProbeResult = {};

/** Pixels per edge; 3 bytes each puts the fixture near 27 MB. */
const BMP_SIDE = 3000;

/** The sampler's tick; the large-image stage judges the worst gap against it. */
const TICK_MS = 10;

/** The worst gap this process's timer has seen. */
let worstGapSeen = 0;

/** The one window. See the file header. */
let page: BrowserWindow | undefined;

/** The scratch directory for this run. */
function scratchDir(): string {
  return path.join(app.getPath("temp"), `d2-media-probe-${process.pid}`);
}

/**
 * Append a breadcrumb, synchronously, so a crash still explains itself.
 *
 * @param message what just happened
 */
function trace(message: string): void {
  const file = process.env["HARUYUKI_D2_TRACE"];
  if (file === undefined) return;

  try {
    appendFileSync(file, `${Date.now()} ${message}\n`, "utf8");
  } catch {
    // Tracing must never be the reason a probe fails.
  }
}

/** Write whatever has been measured so far to the report file. */
function flush(): void {
  const out = process.env["HARUYUKI_D2_MEDIA_OUT"];
  if (out === undefined) return;

  try {
    writeFileSync(out, `MEDIARESULT ${JSON.stringify(result)}\n`, "utf8");
  } catch {
    // A later flush may succeed.
  }
}

/**
 * Print the result and exit.
 *
 * @param code exit code
 */
function finish(code: number): void {
  flush();

  try {
    writeSync(1, `MEDIARESULT ${JSON.stringify(result)}\n`);
  } catch {
    // The file above is the authoritative copy.
  }

  app.exit(code);
}

/**
 * Build a valid BMP.
 *
 * BMP rather than PNG because it needs no dependency and no compression: the point
 * is a multi-megabyte image the renderer really decodes, so the handler has to
 * stream rather than hand over a buffer.
 *
 * @param side pixels per edge
 */
function makeBmp(side: number): Buffer {
  const rowBytes = side * 3;
  const padding = (4 - (rowBytes % 4)) % 4;
  const pixelBytes = (rowBytes + padding) * side;
  const fileBytes = 54 + pixelBytes;

  const header = Buffer.alloc(54);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(fileBytes, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(side, 18);
  header.writeInt32LE(side, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixelBytes, 34);

  // A flat mid-grey field: decoding it is the work, the content is irrelevant.
  return Buffer.concat([header, Buffer.alloc(pixelBytes, 0x80)]);
}

/**
 * Write the fixtures and the host page.
 *
 * @returns absolute paths the stages need
 */
async function writeFixtures(): Promise<{ bmp: string; html: string; text: string; exe: string }> {
  const scratch = scratchDir();
  await mkdir(scratch, { recursive: true });

  const bmp = path.join(scratch, "big.bmp");
  const html = path.join(scratch, "source.html");
  const text = path.join(scratch, "notes.txt");
  const exe = path.join(scratch, "fake.exe");

  await writeFile(bmp, makeBmp(BMP_SIDE));
  await writeFile(
    html,
    "<html><body><script>window.__EXECUTED__=true</script><p>source only</p></body></html>",
    "utf8",
  );
  await writeFile(text, "plain words\n", "utf8");
  // Not a real executable: the point is the extension, which is what the table
  // decides on.
  await writeFile(exe, "MZ not really", "utf8");
  await writeFile(
    path.join(scratch, "host.html"),
    '<html><body style="margin:0">host</body></html>',
    "utf8",
  );

  return { bmp, html, text, exe };
}

/**
 * The one window, created on first use.
 *
 * The preload is required rather than optional: without it this host refuses to
 * load any custom scheme at all, which is a property of the window configuration
 * and has nothing to do with the scheme under test.
 */
function ensureWindow(): BrowserWindow {
  if (page !== undefined && !page.isDestroyed()) return page;

  page = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: process.env["HARUYUKI_D2_PRELOAD"],
    },
  });

  return page;
}

/**
 * Load a URL, reporting failure rather than throwing.
 *
 * @param target window to load in
 * @param url URL to load
 */
async function load(target: BrowserWindow, url: string): Promise<boolean> {
  try {
    await target.loadURL(url);
    return true;
  } catch (error) {
    trace(`load:failed ${url} :: ${String(error)}`);
    return false;
  }
}

/** Register both schemes. Must happen before ready, and only once. */
function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { ...APP_PRIVILEGES } },
    { scheme: MEDIA_SCHEME, privileges: { ...MEDIA_PRIVILEGES } },
  ]);
}

/**
 * Install both handlers.
 *
 * The media handler is the real one, wired to the real table: a probe with its own
 * simplified handler would be measuring the probe.
 *
 * @param root the single directory this probe authorises
 */
function installHandlers(root: string): void {
  protocol.handle(
    MEDIA_SCHEME,
    createMediaHandler({
      types: MEDIA_TYPE_POLICY,
      // The readable set is one directory, so `outsideRefused` below is a real
      // boundary refusal rather than a table refusal.
      readableRoots: () => [root],
      trustAllPaths: () => false,
      onFailure: (error) => trace(`media:refused ${error.code} :: ${error.detail}`),
    }),
  );

  protocol.handle(APP_SCHEME, async () => {
    try {
      const { readFile } = await import("node:fs/promises");
      const body = await readFile(path.join(root, "host.html"));

      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  let previous = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - previous;
    if (gap > worstGapSeen) worstGapSeen = gap;
    previous = now;
  }, TICK_MS);
  timer.unref();
}

/**
 * Stage `plain-text-document`: a `.txt` served as `text/plain` arrives as plain text.
 *
 * @param file the text fixture
 * @param mediaUrl its media URL
 */
async function probeText(file: string, mediaUrl: string): Promise<void> {
  const target = ensureWindow();

  if (!(await load(target, mediaUrl))) {
    result.textRefused = true;
    return;
  }

  const outcome = (await target.webContents.executeJavaScript(
    `({ contentType: document.contentType, text: (document.body?.textContent ?? "").slice(0, 20) })`,
  )) as { contentType?: string; text?: string };

  result.textContentType = outcome.contentType;
  trace(
    `text:contentType ${String(outcome.contentType)} text=${String(outcome.text).slice(0, 10)}`,
  );
  void file;
}

/**
 * Stage `html-does-not-execute`: an `.html` served as `text/plain` does not execute.
 *
 * This is the security claim the channel rests on. If the script ran, the whole
 * MIME-based defence is worthless and the requirement has to change.
 *
 * @param mediaUrl the media URL of the HTML fixture
 */
async function probeHtml(mediaUrl: string): Promise<void> {
  const target = ensureWindow();

  if (!(await load(target, mediaUrl))) return;

  const outcome = (await target.webContents.executeJavaScript(
    `({ contentType: document.contentType, executed: window.__EXECUTED__ === true })`,
  )) as { contentType?: string; executed?: boolean };

  result.htmlContentType = outcome.contentType;
  result.htmlExecuted = outcome.executed;
  trace(`html:contentType ${String(outcome.contentType)} executed=${String(outcome.executed)}`);
}

/**
 * Stage `large-image-streams`: a 27 MB image streams without stalling this process.
 *
 * @param mediaUrl the media URL of the large fixture
 * @param bytes the fixture's size on disk
 */
async function probeStream(mediaUrl: string, bytes: number): Promise<void> {
  const target = ensureWindow();

  // The image is loaded through an element on a real page, which is what the
  // product does. A top-level navigation to an image fails here for reasons that
  // have nothing to do with the scheme.
  if (!(await load(target, `${APP_SCHEME}://haruyuki/host.html`))) return;

  const before = worstGapSeen;

  const outcome = (await target.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const started = performance.now();
      const image = new Image();
      image.onload = () => resolve({
        outcome: "loaded",
        width: image.naturalWidth,
        height: image.naturalHeight,
        renderMs: Math.round(performance.now() - started),
      });
      image.onerror = () => resolve({ outcome: "image-error" });
      image.src = ${JSON.stringify(mediaUrl)};
      setTimeout(() => resolve({ outcome: "timeout" }), 30000);
    })
  `)) as { outcome?: string; width?: number; height?: number };

  result.imageOutcome = outcome.outcome;
  result.imageBytes = bytes;
  result.imageWorstGapMs = worstGapSeen - before;
  trace(
    `image:${String(outcome.outcome)} bytes=${String(bytes)} gap=${String(worstGapSeen - before)}`,
  );
}

/** Run every stage, keeping whatever completed. */
async function main(): Promise<void> {
  trace("main:enter");
  registerSchemes();
  await app.whenReady();
  trace("main:ready");

  const fixtures = await writeFixtures();
  trace("main:fixtures");
  installHandlers(scratchDir());

  /** Build the media URL the way `resolveLocalResource` does. */
  const urlOf = (absolute: string): string =>
    `${MEDIA_SCHEME}://local/${encodeURIComponent(absolute)}`;

  trace("text:start");
  await probeText(fixtures.text, urlOf(fixtures.text)).catch((error) => {
    result.fatal = `text: ${String(error)}`;
  });
  trace("text:done");
  flush();

  trace("html:start");
  await probeHtml(urlOf(fixtures.html)).catch((error) => {
    result.fatal = `html: ${String(error)}`;
  });
  trace("html:done");
  flush();

  trace("stream:start");
  await probeStream(urlOf(fixtures.bmp), makeBmp(BMP_SIDE).byteLength).catch((error) => {
    result.fatal = `stream: ${String(error)}`;
  });
  trace("stream:done");
  flush();

  // A refused type and a refused path are checked through the handler directly:
  // the answer is the status code, which needs no renderer.
  trace("refusals:start");
  try {
    const handler = createMediaHandler({
      types: MEDIA_TYPE_POLICY,
      readableRoots: () => [scratchDir()],
      trustAllPaths: () => false,
    });

    const exeResponse = await handler(new Request(urlOf(fixtures.exe)));
    result.exeRefused = exeResponse.status === 415;

    const outside = path.join(app.getPath("home"), "d2-probe-outside.txt");
    const outsideResponse = await handler(new Request(urlOf(outside)));
    result.outsideRefused = outsideResponse.status === 403;
  } catch (error) {
    result.fatal = `refusals: ${String(error)}`;
  }
  trace("refusals:done");
  flush();

  await rm(scratchDir(), { recursive: true, force: true }).catch(() => undefined);
  trace("main:end");
  finish(0);
}

main().catch((error) => {
  result.fatal = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  finish(1);
});
