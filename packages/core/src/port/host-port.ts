/**
 * Host port: what the shell (Electron main, a VSCode webview host, or the
 * headless test runner) must provide to the engine host, and nothing more.
 *
 * `HostPortStartup` freezes the startup subset and `HostPort` extends it to the
 * nine-item contract. The declarations here are the definition: where an
 * implementation's reading of a member disagrees with this file, this file
 * wins. This file is types only on purpose - the Electron implementation and
 * the headless implementation both live elsewhere (the headless one in
 * `headless-host-port.ts`), so the contract stays implementable in a plain `node`
 * process and therefore testable without a desktop shell.
 *
 * The shapes are spelled inline so the whole contract is readable in one
 * place: the shared contract test (`contract.test.ts`) reads this interface as
 * the definition, and a one-to-one match keeps that comparison mechanical.
 * `HostPortStartup` stays byte-for-byte unchanged: the startup contract is
 * already consumed, and the six new members are a pure addition rather than a
 * revision.
 */

import type { EngineSpawnSpec } from "../engine/types";

export interface HostPortStartup {
  /**
   * What the hosting shell can actually do. The core must degrade instead of
   * assuming a capability: a headless host answers `false` to all four.
   *
   * `canNotify` - the shell can raise an OS-level notification.
   * `canReadDroppedFiles` - a file dropped on the window exposes a readable path.
   * `canPopout` - a panel can be popped out into its own window.
   * `canFloatingWindow` - the shell supports a floating/pinned window.
   */
  capabilities: {
    canNotify: boolean;
    canReadDroppedFiles: boolean;
    canPopout: boolean;
    canFloatingWindow: boolean;
  };

  /**
   * Per-host directory roots. The core never hardcodes an `app.getPath` result:
   * `userData` holds engine settings and state, `logs` is where the host expects
   * engine log files, `cache` is disposable, and `temp` is where short-lived
   * isolates (token files, scratch state) must be created.
   */
  paths: {
    userData: string;
    logs: string;
    cache: string;
    temp: string;
  };

  /**
   * Resolve the concrete spawn instruction for this host, at call time.
   *
   * Asynchronous because a real host may need to unpack or locate the engine
   * bundle first. A refusal is expressed as `{ ok: false }` with a human-readable
   * `reason` rather than a thrown error, so the caller can classify it as
   * SPAWN_FAILED without unwrapping an exception, and the reason can be shown to
   * the user verbatim.
   */
  getRuntimeSpawnSpec(): Promise<
    { ok: true; spec: EngineSpawnSpec } | { ok: false; reason: string }
  >;
}

/**
 * The full nine-item port: the three startup items above plus the six
 * capabilities that genuinely differ between shells.
 *
 * Two properties hold for every member that returns a promise: it is `async`
 * even when the answer is already known, and it reports its documented failures
 * as a value (`ok: false` plus a frozen code) instead of throwing. The three
 * synchronous members are the ones the contract calls sync values or sync
 * registration: `capabilities`, `paths` and `onShutdown`.
 *
 * The union return types are frozen. Do not add a code, widen a code to
 * `string`, or turn a success/failure union into a thrown error: the shells are
 * written by three teams against this file, and the contract test compares the
 * codes, not only the happy path.
 */
export interface HostPort extends HostPortStartup {
  /**
   * Read one secret - a capability token or a preference that must never sit in
   * plain text.
   *
   * A missing key is `NOT_FOUND`; a store that cannot be reached at all is
   * `STORAGE_UNAVAILABLE`. Neither may degrade into a plaintext fallback or into
   * an empty string: a caller must be able to tell "absent" from "unreadable".
   */
  secureGet(
    key: string,
  ): Promise<
    { ok: true; value: string } | { ok: false; code: "NOT_FOUND" | "STORAGE_UNAVAILABLE" }
  >;

  /**
   * Write one secret. Overwriting an existing key is allowed and is not an
   * error, because a refreshed token replacing a stale one is the normal case.
   */
  secureSet(
    key: string,
    value: string,
  ): Promise<{ ok: true } | { ok: false; code: "STORAGE_UNAVAILABLE" }>;

  /**
   * Delete one secret. Idempotent: deleting a key that is absent still answers
   * `{ ok: true }`, so a cleanup path never has to read first.
   */
  secureDelete(key: string): Promise<{ ok: true }>;

  /**
   * Hand a URL to the operating system (the default browser or mail client).
   *
   * Only `http:` and `https:` are accepted; anything else - `mailto:`, `file:`,
   * `javascript:`, a relative string, an unparsable value - is
   * `REJECTED_SCHEME`. A scheme allow-list is a security boundary, not a
   * preference: `file:` and `javascript:` would let a compromised renderer read
   * local files or execute inside the system browser's context.
   */
  openExternal(url: string): Promise<{ ok: true } | { ok: false; code: "REJECTED_SCHEME" }>;

  /**
   * Ask the user for files or a directory.
   *
   * A user cancellation is an empty array, not an error: "nobody picked
   * anything" is a normal outcome of opening a dialog.
   */
  pickPaths(opts: { kind: "file" | "directory"; multiple?: boolean }): Promise<string[]>;

  /**
   * Turn a local absolute path into a URL the renderer can load - a custom
   * protocol in the desktop shell, `asWebviewUri` in VSCode, `file://` in the
   * headless host.
   *
   * Anything outside the host's allowed roots is `OUT_OF_ROOT`, including `..`
   * escapes, drive-relative paths and paths on another drive. The interpreter
   * must not "helpfully" resolve the path and hand back a working URL: the
   * containment check is the whole security value of this member.
   */
  resolveLocalResource(
    absPath: string,
  ): Promise<{ ok: true; url: string } | { ok: false; code: "OUT_OF_ROOT" }>;

  /**
   * Register a callback that runs when the shell shuts down.
   *
   * Synchronous registration: a caller must be able to register from a
   * synchronous context, and the "async execution" half belongs to whoever
   * triggers the shutdown. This is a courtesy hook, not a safety net - a crash
   * or a hard kill skips it, which is why the watchdog in `watchdog-watch.ts`
   * exists and why orphan cleanup may not depend on this callback.
   */
  onShutdown(cb: () => void): void;

  /**
   * Raise a system notification.
   *
   * Optional capability: when `canNotify` is false the call succeeds silently
   * and the refusal is expressed by the flag, never by an error, so a caller's
   * notification path needs no branch.
   */
  notify(level: "info" | "warn" | "error", message: string): Promise<void>;

  /**
   * Turn dropped files into content the core can use - a path, or the bytes as
   * base64 when the shell cannot expose a readable path.
   *
   * Optional capability: a host without it answers `UNSUPPORTED` and the caller
   * falls back to `pickPaths`. The per-entry shape keeps `name` always and
   * makes `path`/`base64` alternatives, because a shell may hand over one or
   * the other but never needs both.
   */
  readDroppedFiles(
    files: readonly { name: string; path?: string }[],
  ): Promise<
    | { ok: true; entries: { name: string; path?: string; base64?: string }[] }
    | { ok: false; code: "UNSUPPORTED" }
  >;
}
