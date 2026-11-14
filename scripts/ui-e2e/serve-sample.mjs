/**
 * serve-sample.mjs - build the sample page and serve it for the layout check.
 *
 * The layout check needs a real page at a real URL. Rather than ask a human to run
 * a dev server first -- which makes the check something people skip -- this script
 * builds the sample once with Vite and serves the output from memory.
 *
 * Vite is used only as a build tool here, not as a dev server: a production build
 * is what the check should measure, because a dev build injects HMR client code and
 * its own overlay, and neither belongs in a layout measurement.
 *
 * Usage:
 *   node scripts/ui-e2e/serve-sample.mjs                 # serve on 5173
 *   node scripts/ui-e2e/serve-sample.mjs --port 5180
 *
 * Prints `<url>` on stdout once listening, so a caller can wait for it.
 */

import { createServer } from "node:http";

import { fail } from "../lib/gate-cli.mjs";

/**
 * Build the sample page and return the compiled assets keyed by path.
 *
 * @returns a map of request path to { body, type }
 */
async function buildSample() {
  let vite;

  try {
    vite = await import("vite");
  } catch {
    throw new Error("vite is not installed; it is a root devDependency of this repository");
  }

  // Resolved off the module namespace rather than destructured into a bare name:
  // an undeclared assignment target throws a ReferenceError inside the try above,
  // which the catch then reported as "vite is not installed" -- a wrong message for
  // a script whose actual problem was its own syntax.
  const result = await vite.build({
    root: "packages/ui/src/examples",
    logLevel: "silent",
    build: {
      write: false,
      // A single HTML entry: the sample is one page, and code splitting would make
      // the measurement depend on which chunk happened to load first.
      rollupOptions: { input: "packages/ui/src/examples/index.html" },
    },
  });

  const outputs = Array.isArray(result) ? result[0].output : result.output;
  const assets = new Map();

  for (const output of outputs) {
    // A chunk carries its text in `code`; a static asset carries it in `source`.
    // Reading only `source` silently produced undefined for every chunk.
    const text = typeof output.code === "string" ? output.code : output.source;
    const body = typeof text === "string" ? Buffer.from(text) : text;

    assets.set(`/${output.fileName}`, {
      body,
      type: output.fileName.endsWith(".html") ? "text/html" : "text/javascript",
    });
  }

  return assets;
}

/**
 * Serve a built asset map.
 *
 * @param assets the built assets
 * @param port port to listen on
 * @returns the server
 */
function serve(assets, port) {
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    // Anything unknown falls back to the HTML entry: the sample is a single page,
    // and a client-side route should still render.
    const asset = assets.get(path) ?? assets.get("/index.html");

    if (asset === undefined) {
      response.writeHead(404).end("not found");

      return;
    }

    response.writeHead(200, { "content-type": asset.type }).end(asset.body);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

try {
  // Not `parseArgs` from gate-cli: that helper understands only boolean switches
  // and `--root`, which is deliberate -- it is the contract every gate shares. This
  // script is a development tool that needs a value option, so it parses its own.
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex === -1 ? 5173 : Number(process.argv[portIndex + 1]);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("--port expects a positive integer");
  }

  const assets = await buildSample();

  await serve(assets, port);

  console.log(`http://127.0.0.1:${port}/`);
  // Stays alive on purpose: printing the URL then exiting would hand the caller a
  // dead address.
} catch (error) {
  fail(error);
}
