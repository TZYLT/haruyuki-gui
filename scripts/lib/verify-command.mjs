/**
 * Launching one segment's command, on both ways a process can be started.
 *
 * A shell takes a single quoted line; a direct launch takes an argv array. The
 * two are kept apart on purpose -- a `shell` flag on one shared shape would force
 * every later reader to work out which field belongs to which form.
 *
 * The direct form exists because the shell form has a ceiling that a growing
 * suite reaches: `cmd.exe` refuses a command line over 8191 characters, and a
 * segment that passes one path per test file gets there around 167 files. What it
 * reports is a translator's error text, which the output contract then folds into
 * question marks -- a failure that reads as "the code is broken" while nothing
 * ran at all.
 */

import { spawnSync } from "node:child_process";

/**
 * Longest command line a direct launch is allowed to build.
 *
 * A direct launch skips the shell, which removes the 8191-character `cmd.exe`
 * limit. What remains is the operating system's own ceiling on a process command
 * line (32767 UTF-16 code units on Windows); this budget stays under it and names
 * the failure when it is reached, instead of surfacing an error text nobody can
 * read.
 */
const MAX_DIRECT_COMMAND_CHARS = 30000;

/**
 * Whether a command has to go through a shell.
 *
 * On Windows only a batch shim does. `pnpm` resolves through `PATH` to
 * `pnpm.cmd`, so it needs one; a real image (`node.exe`) does not, and routing it
 * through `cmd.exe` subjects it to that shell's command line limit for no gain.
 * The test for "a real image" is the `.exe` extension: a bare name may resolve to
 * a shim, and a `.ps1` would need its own interpreter invocation rather than a
 * shell, so neither is in the direct set.
 *
 * POSIX keeps the shell: its limit is measured in megabytes, so the extra layer
 * costs nothing and the existing quoting stays exercised.
 *
 * @param {{ command: string, args: string[] }} command
 * @returns {boolean}
 */
export function needsShell(command) {
  if (process.platform !== "win32") return true;

  return !/\.exe$/i.test(command.command);
}

/**
 * Run one command and capture everything a verdict and a report need.
 *
 * @param {{ command: string, args: string[] }} command
 * @param {{
 *   cwd: string,
 *   timeoutMs: number,
 *   maxBuffer: number,
 *   normalize: (output: string) => string,
 * }} settings
 * @returns {{ status: number | null, output: string, spawnFailed: boolean, timedOut: boolean }}
 */
export function runCommand(command, settings) {
  const shared = {
    cwd: settings.cwd,
    encoding: "utf8",
    maxBuffer: settings.maxBuffer,
    windowsHide: true,
    // A hung segment must fail, not hang the run. `spawnSync` reports the kill as
    // an `error` with code `ETIMEDOUT`, which the caller's `spawnFailed` channel
    // already turns into a failure line.
    timeout: settings.timeoutMs,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  };

  const shell = needsShell(command);

  if (!shell) {
    const lineLength =
      command.command.length +
      command.args.reduce((total, argument) => total + argument.length + 1, 0);

    if (lineLength > MAX_DIRECT_COMMAND_CHARS) {
      return {
        status: null,
        output: settings.normalize(
          `the command line would be ${String(lineLength)} characters, over the ` +
            `${String(MAX_DIRECT_COMMAND_CHARS)} a direct launch is allowed; ` +
            `split the segment rather than growing the argument list`,
        ),
        spawnFailed: true,
        timedOut: false,
      };
    }
  }

  const result = shell
    ? spawnSync(toShellLine(command), { ...shared, shell: true })
    : spawnSync(command.command, command.args, { ...shared, shell: false });

  const timedOut = result.error?.code === "ETIMEDOUT";

  return {
    status: timedOut ? null : result.status,
    output: settings.normalize(
      `${result.stdout ?? ""}${result.stderr ?? ""}${
        timedOut ? `\nsegment exceeded ${String(settings.timeoutMs)} ms and was killed` : ""
      }`,
    ),
    spawnFailed: result.error !== undefined,
    timedOut,
  };
}

/**
 * @param {{ command: string, args: string[] }} command
 * @returns {string} One quoted command line, ready for `shell: true`.
 */
function toShellLine(command) {
  return [command.command, ...command.args].map(quoteArgument).join(" ");
}

/**
 * Quote one argument for the shell. Plain tokens (the common case here) are left
 * alone so the replayed command line stays readable.
 *
 * @param {string} argument
 * @returns {string}
 */
function quoteArgument(argument) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(argument)) {
    return argument;
  }

  if (process.platform === "win32") {
    return `"${argument.replaceAll('"', '\\"')}"`;
  }

  return `'${argument.replaceAll("'", "'\\''")}'`;
}
