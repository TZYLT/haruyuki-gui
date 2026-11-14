/**
 * Engine capability token: generation, atomic write, exact ACL and single-point removal.
 *
 * Scope source: no recursive section 3.1 (module split), 3.2 ( owns this file),
 * 4.2 (work package) and section 8 invariant 1. The engine only accepts a
 * `--ws-token-file <path>` argument, so this module deliberately hands the
 * caller a PATH and never returns a spawn argument list. That is what keeps the
 * secret out of `process.argv`, where any local process could read it .
 *
 * Two failure classes are treated differently on purpose:
 *
 * - A failure to WRITE the token file is thrown. Without a token file the engine
 *   would reject every socket handshake, so the start path must stop here.
 * - A failure to HARDEN the file (chmod / icacls) is not fatal. The token still
 *   works, only its on-disk protection is weaker, so the call succeeds and
 *   reports `acl: "degraded"` with a raw diagnostic for the host to register
 *   (no recursive section 7, risk R-5: Windows ACL failure on localized or spaced
 *   paths).
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, rename, stat, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { resolve } from "node:path";

/**
 * Fixed file name inside the caller-provided directory.
 *
 * It has no random suffix so the host can delete the known path after the engine
 * exits without having to remember a generated name.
 */
export const TOKEN_FILE_NAME = "engine-token";

/** Temporary sibling used to make the write atomic; renamed onto the final name. */
const TOKEN_TEMP_FILE_NAME = `${TOKEN_FILE_NAME}.tmp`;

/** 32 random bytes rendered as hex: 64 characters, 256 bits of entropy. */
const TOKEN_BYTE_LENGTH = 32;

/** Owner-only read/write on POSIX. */
const POSIX_TOKEN_MODE = 0o600;

/** Upper bound of the diagnostic copied into `TokenFile.reason`. */
const ACL_REASON_LIMIT = 300;

/**
 * Result of {@link writeTokenFile}.
 *
 * `path` is absolute. `acl` is `"exact"` only when the platform ACL step
 * succeeded; `"degraded"` means the file exists and is usable but its effective
 * permissions are whatever the directory gave it. `reason` carries the raw
 * command stderr (or the thrown message) when the ACL step degraded.
 */
export type TokenFile = {
  path: string;
  acl: "exact" | "degraded";
  reason?: string;
};

/**
 * Optional dependency overrides.
 *
 * Production callers pass nothing, so the real platform command runs. Tests use
 * `applyAcl` to exercise the degraded path deterministically without replacing
 * `icacls` with a fake command inside production code.
 */
export type TokenFileOptions = {
  applyAcl?: (filePath: string) => Promise<void>;
};

/** Error shape surfaced by the platform permission command. */
type AclCommandFailure = Error & {
  code?: number | string;
};

/**
 * Generate a fresh capability token.
 *
 * 32 cryptographically random bytes as lowercase hex. Callers must pass the
 * result to {@link writeTokenFile}; it must never be placed on a command line.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTE_LENGTH).toString("hex");
}

/**
 * Write `token` to `<dir>/engine-token` and apply the exact platform ACL.
 *
 * The file is first written as `engine-token.tmp` with mode 0o600 and then
 * renamed, so a concurrent reader sees either no file or the complete secret,
 * never a partially written one. The content is `token + "\n"` because the
 * engine reads it with `readTrimmedSecret`, which trims before comparing.
 *
 * On POSIX the file is chmodded to 0o600. On Windows the inherited ACEs are
 * removed and only the current account is granted read access. An ACL failure
 * degrades the result instead of throwing; a write failure throws.
 *
 * @param dir Existing directory that will hold the token file.
 * @param token Value from {@link generateToken} (or an externally supplied one).
 * @param options Test-only overrides; omit in production.
 */
export async function writeTokenFile(
  dir: string,
  token: string,
  options: TokenFileOptions = {},
): Promise<TokenFile> {
  const filePath = resolve(dir, TOKEN_FILE_NAME);
  const tempPath = resolve(dir, TOKEN_TEMP_FILE_NAME);

  try {
    // Mode is set at creation so the visible file never spends time with the
    // directory's default (inherited) permissions on POSIX; chmod below makes
    // the mode exact even when the process umask would have masked it.
    await writeFile(tempPath, `${token}\n`, { encoding: "utf8", mode: POSIX_TOKEN_MODE });
    await rename(tempPath, filePath);
  } catch (error) {
    // Best effort: a failed write or rename must not leave a stray temp file.
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }

  const applyAcl = options.applyAcl ?? applyPlatformAcl;

  try {
    await applyAcl(filePath);
    return { path: filePath, acl: "exact" };
  } catch (error) {
    return { path: filePath, acl: "degraded", reason: summarizeAclFailure(error) };
  }
}

/**
 * Remove a token file with a single `unlink`.
 *
 * A missing file is not an error: the engine may already have exited and a
 * previous cleanup attempt may have won the race. This intentionally does not
 * recurse, so a wrong path can never delete a directory tree.
 */
export async function removeTokenFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }
}

/**
 * Report whether `filePath` exists and is a regular file.
 *
 * Exposed for tests and for host self-checks; a missing path is `false` rather
 * than an exception so callers can use it as a pure predicate.
 */
export async function isTokenFilePresent(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  }
}

/**
 * Apply the exact ACL for the current platform.
 *
 * Synchronous throws from the Windows branch are turned into rejections by the
 * `async` keyword, so both branches share one failure contract.
 */
async function applyPlatformAcl(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    await applyWindowsAcl(filePath);
    return;
  }

  await chmod(filePath, POSIX_TOKEN_MODE);
}

/**
 * Windows: strip inheritance, then grant read access to the current account only.
 *
 * The account comes from `os.userInfo()` rather than `%USERNAME%`: the command is
 * executed directly (no shell), so the user name is passed as one argv element
 * and survives spaces and localized characters without shell re-parsing.
 */
async function applyWindowsAcl(filePath: string): Promise<void> {
  const user = userInfo().username;

  await runCommand("icacls", [filePath, "/inheritance:r", "/grant:r", `${user}:R`]);
}

/**
 * Run a command without a shell and reject with its stderr attached.
 *
 * `windowsHide` keeps a console window from flashing when the host application
 * starts the engine from a GUI process.
 */
function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error === null) {
        resolvePromise();
        return;
      }

      const code = error.code;
      const detail =
        typeof code === "number"
          ? `${command} exited with code ${code}`
          : `${command} failed${typeof code === "string" ? ` (${code})` : ""}`;
      const failure: AclCommandFailure = new Error(detail);

      if (typeof code === "number" || typeof code === "string") {
        failure.code = code;
      }

      // The callback hands stderr separately; attach it so the summary below has
      // the raw diagnostic even when the error message itself is generic.
      (failure as AclCommandFailure & { stderr?: string }).stderr = stderr;
      rejectPromise(failure);
    });
  });
}

/**
 * Turn an ACL failure into one short, single-line reason.
 *
 * Raw stderr wins over the message because it is what the platform command
 * actually said. Whitespace is compacted so the value fits a log line, and the
 * length is capped so a chatty failure cannot bloat the host's error record.
 */
function summarizeAclFailure(error: unknown): string {
  const record = error as { stderr?: unknown; message?: unknown; code?: unknown } | null;
  const stderr = typeof record?.stderr === "string" ? record.stderr : "";
  const message = typeof record?.message === "string" ? record.message : String(error);
  const raw = stderr.trim() === "" ? message : stderr;
  const compact = raw.replace(/\s+/g, " ").trim();
  const code = record?.code;
  const prefix = typeof code === "number" ? `exit ${code}: ` : "";
  const summary = `${prefix}${compact === "" ? "acl command failed" : compact}`;

  return summary.length > ACL_REASON_LIMIT ? `${summary.slice(0, ACL_REASON_LIMIT)}...` : summary;
}

/** True when the error is the platform's "file does not exist" signal. */
function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}
