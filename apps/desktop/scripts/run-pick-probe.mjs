/**
 * Raise the four `pickPaths` dialogs and print what they return.
 *
 * Run this yourself: it opens real dialogs, and nothing can answer them but a person.
 *
 *   node apps/desktop/scripts/run-pick-probe.mjs
 *
 * Two launch details, both learned from `verify-host-port.mjs` and both load-bearing:
 *
 *   `ELECTRON_RUN_AS_NODE` must be stripped. This session's environment sets it to `1`,
 *   which makes the Electron binary behave as plain Node -- no `app`, no `dialog`, and the
 *   probe dies on `dialog` being undefined. The launcher removes it for the child only.
 *
 *   `app.exit` does not drain stdout, so the probe writes its answers to a file and this
 *   script reads that file. Printing from inside the Electron process loses the last
 *   lines, which is exactly the lines that say what happened.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

/** Where the probe leaves its answers. */
/**
 * Which probe to run, and where its answers land.
 *
 * Two probes need a human and therefore a launcher each time: the four-dialog pass, and
 * the single cancellation. Sharing one launcher keeps the two launch details above in one
 * place rather than duplicated.
 */
const WHICH = process.argv[2] === "cancel" ? "cancel" : "pick";

const REPORT = path.join(
  process.cwd(),
  "apps",
  "desktop",
  "dist",
  "probe",
  WHICH === "cancel" ? "cancel-answers.json" : "pick-answers.json",
);

/** The bundled probe. */
const BUNDLE = path.join(
  process.cwd(),
  "apps",
  "desktop",
  "dist",
  "probe",
  WHICH === "cancel" ? "cancel-probe.cjs" : "pick-path-probe.cjs",
);

/** The Electron binary for this checkout. */
const ELECTRON = path.join(process.cwd(), "node_modules", "electron", "dist", "electron.exe");

for (const required of [BUNDLE, ELECTRON]) {
  if (!existsSync(required)) {
    process.stderr.write(
      `missing: ${required}\nrun: pnpm --filter @haruyuki/desktop run build:probe\n`,
    );
    process.exit(1);
  }
}

// A stale report would be indistinguishable from a fresh one.
if (existsSync(REPORT)) rmSync(REPORT);

/**
 * The child's environment, without the variable that turns Electron into Node.
 *
 * @returns a copy of the environment minus `ELECTRON_RUN_AS_NODE`
 */
function environment() {
  const copy = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (key === "ELECTRON_RUN_AS_NODE") continue;
    if (value !== undefined) copy[key] = value;
  }

  return copy;
}

process.stdout.write(
  WHICH === "cancel"
    ? "\nOne dialog will open. Press Cancel (or Esc) -- that is the answer being tested.\n\n"
    : "\nFour dialogs will open, one after another. Answer each one.\n" +
        "  Ctrl+click (or Shift+click) to select more than one where asked.\n" +
        "  Press Cancel on any of them to record a cancellation -- that is a valid answer.\n\n",
);

const child = spawn(ELECTRON, [BUNDLE], {
  cwd: process.cwd(),
  env: environment(),
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: false,
});

child.on("close", (code) => {
  if (!existsSync(REPORT)) {
    process.stderr.write(`\nthe probe exited (${String(code)}) without writing answers\n`);
    process.exit(1);
  }

  const answers = JSON.parse(readFileSync(REPORT, "utf8"));

  process.stdout.write("\n=== what the dialogs returned ===\n");

  for (const [key, answer] of Object.entries(answers)) {
    const record = answer;
    process.stdout.write(
      `${key.padEnd(18)} properties=${JSON.stringify(record["properties"])} ` +
        `canceled=${String(record["canceled"])} count=${String(record["count"])} ` +
        `names=${JSON.stringify(record["names"])}\n`,
    );
  }

  process.stdout.write("\n");
});
