/**
 * Attach to an already-running external engine server: handshake, then version
 * comparison. Nothing here starts a process, writes a token file or deletes
 * anything - that is the whole difference from the start path.
 *
 * Scope: the facade's `attach` entry, the `AppServerInfo` shape (`./types`) and
 * the rule that the engine's reported version is compared with the one this
 * build was tested against.
 *
 * Why this file exists on top of `connection.ts` and `handshake.ts`: the start
 * path owns the lifecycle of a child process it spawned itself, so it has a
 * token file to read, a stdout to parse and a process to kill. An external
 * server has none of those: the operator passes a `url` and a `token`, and the
 * only work left is opening the socket, asking `app_server_info` who is on the
 * other end, and comparing the reported engine version with what this build was
 * tested against.
 *
 * A version mismatch is a warning, not a veto. An engine version that differs
 * from the expected one is reported through `versionMismatch` and the call still
 * resolves with the full `AppServerInfo`, so the caller can show "combination not
 * tested" and keep going. Only a real transport/handshake failure rejects, and
 * it rejects with the same `EngineConnectionError` that `connectEngine` and
 * `requestAppServerInfo` raise, untouched: this layer never re-classifies, never
 * downgrades a failure to a warning and never swallows one.
 *
 * The URL scheme is validated before the socket is constructed. `ws` happily
 * accepts `http://` and rewrites it, which would turn a paste error into a
 * connection to the wrong endpoint, so a non-ws scheme is a
 * `PROTOCOL_MISMATCH` here with the offending scheme in the message.
 */

import { connectEngine, EngineConnectionError } from "./connection";
import type { ConnectEngineOptions, EngineSocket } from "./connection";
import { requestAppServerInfo } from "./handshake";
import type { AppServerInfo } from "./types";

/** Schemes an attach endpoint may use. `ws` also accepts `http(s)`, on purpose
 * we do not: see the file comment. */
const ATTACH_SCHEMES: readonly string[] = ["ws:", "wss:"];

/**
 * Options for {@link attachToExternalServer}.
 *
 * `url` is the engine WebSocket endpoint the operator configured
 * (`ws://host:port/ws`); `token` is the capability token that server expects,
 * sent only in the Authorization header. `timeoutMs` bounds the upgrade and the
 * handshake separately, so an unresponsive host fails
 * within roughly `2 * timeoutMs`; when absent the two layers keep their own
 * defaults (10 s upgrade, 5 s handshake). `expectedEngineVersion` is the engine
 * build this GUI was tested against; leaving it out disables the comparison.
 */
export type AttachOptions = {
  url: string;
  token: string;
  expectedEngineVersion?: string;
  timeoutMs?: number;
};

/**
 * A version difference worth telling the operator about.
 *
 * `expected` is the trimmed expectation the caller supplied, `actual` is the
 * engine's own `letta_code_version` - read from the handshake response, never
 * from a local `runtime-lock` file.
 */
export type AttachVersionMismatch = {
  expected: string;
  actual: string;
};

/**
 * Outcome of a successful attach.
 *
 * `info` is returned in both branches: a version mismatch is not a failure, so
 * the caller always has the handshake data to display alongside the warning.
 * `versionMismatch` is `null` when the versions match or no expectation was
 * supplied.
 */
export type AttachResult = {
  info: AppServerInfo;
  versionMismatch: AttachVersionMismatch | null;
};

/**
 * Attach to an external engine server, complete the handshake and compare the
 * reported engine version with the expected one.
 *
 * The sequence is: validate the scheme, open an authenticated WebSocket, ask
 * `app_server_info`, record the answer, close the socket. The socket is closed
 * before the promise settles in every branch (see {@link disposeSocket}): this
 * entry is a probe, not a connection lease, so it must not hand back a live
 * handle it cannot expose. A caller that needs a long-lived socket opens one
 * with `connectEngine` itself.
 *
 * Rejects with `EngineConnectionError`, exactly as classified by the layers
 * below:
 * - `PROTOCOL_MISMATCH` for a non-`ws`/`wss` URL or an unparseable one;
 * - `AUTH_FAILED` for a 401/403 upgrade rejection;
 * - `PORT_NOT_FOUND` for a refused port;
 * - `PROTOCOL_MISMATCH` for a missing/mismatched/`success:false` handshake
 *   answer, and `TIMEOUT` for the remaining upgrade faults.
 *
 * @param opts endpoint, token, optional expected engine version and budget
 */
export async function attachToExternalServer(opts: AttachOptions): Promise<AttachResult> {
  const checked = checkAttachUrl(opts.url);

  if (checked.ok === false) {
    throw new EngineConnectionError("PROTOCOL_MISMATCH", checked.detail, checked.wireHint);
  }

  // Built conditionally: `exactOptionalPropertyTypes` forbids assigning an
  // explicit `undefined` to an optional property, and omitting the key is also
  // what lets `connectEngine` apply its own default budget.
  const connectOptions: ConnectEngineOptions =
    opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs };

  const socket = await connectEngine(opts.url, opts.token, connectOptions);

  try {
    const info = await requestAppServerInfo(socket, opts.timeoutMs);

    return {
      info,
      versionMismatch: compareEngineVersion(opts.expectedEngineVersion, info.engineVersion),
    };
  } finally {
    disposeSocket(socket);
  }
}

/**
 * One human-readable sentence for the version-mismatch notice, or `""` when
 * there is nothing to show.
 *
 * The empty string is the "no hint" answer on purpose: a caller that renders
 * `describeAttachMismatch(result)` unconditionally shows a banner only for an
 * untested combination and nothing at all for a matching one, instead of a
 * second, always-true notice competing with real warnings.
 *
 * @param result the resolved value of {@link attachToExternalServer}
 */
export function describeAttachMismatch(result: AttachResult): string {
  if (result.versionMismatch === null) {
    return "";
  }

  const { expected, actual } = result.versionMismatch;

  return `expected engine ${expected}, got ${actual}; combination not tested`;
}

type AttachUrlCheck = { ok: true } | { ok: false; detail: string; wireHint?: string };

/**
 * Reject anything that is not an absolute `ws://` or `wss://` URL.
 *
 * The raw value is never echoed: an operator can paste a URL that carries a
 * token in its userinfo or query string, and an error message is exactly the
 * sort of thing that ends up in a log file. Only the parsed scheme is quoted,
 * which is all a paste error needs.
 */
function checkAttachUrl(rawUrl: string): AttachUrlCheck {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      detail: "attach requires an absolute ws:// or wss:// URL, but the value is not a valid URL.",
    };
  }

  if (ATTACH_SCHEMES.includes(parsed.protocol) === false) {
    const scheme = parsed.protocol.endsWith(":") ? parsed.protocol.slice(0, -1) : parsed.protocol;

    return {
      ok: false,
      detail: `attach requires a ws:// or wss:// URL, but the scheme is "${scheme}".`,
      wireHint: scheme,
    };
  }

  return { ok: true };
}

/**
 * Compare the expected engine version with the reported one.
 *
 * Exact string equality: `letta_code_version` is a build string, not a semver
 * range, and guessing at pre-release ordering here would report a compatible
 * prerelease as matching when it is not. A missing, empty or whitespace-only
 * expectation counts as "no expectation" rather than as a guaranteed mismatch,
 * so an unfilled config field cannot raise a permanent mismatch banner.
 */
function compareEngineVersion(
  expected: string | undefined,
  actual: string,
): AttachVersionMismatch | null {
  if (expected === undefined) {
    return null;
  }

  const wanted = expected.trim();

  if (wanted.length === 0 || wanted === actual) {
    return null;
  }

  return { expected: wanted, actual };
}

/**
 * Release the probe socket.
 *
 * `terminate()` rather than `close()`: this socket is discarded immediately
 * after the handshake, so waiting for a close handshake would only keep the
 * handle alive longer than the caller needs it. Failures are swallowed because
 * the socket may already be gone (the handshake path may have seen `close` or
 * `error`), and a teardown error must not replace the result the caller is about
 * to receive. `connectEngine` leaves a permanent no-op `error` listener on the
 * socket, so terminating cannot surface as an unhandled EventEmitter error.
 */
function disposeSocket(socket: EngineSocket): void {
  try {
    socket.terminate();
  } catch {
    // Already closed or never opened; nothing left to release.
  }
}
