/**
 * app_server_info handshake: the second half of "ready".
 *
 * Scope source: no recursive-B1 sections 2.3 (F-15..F-17), 3.1, 3.3 (d) and (f), and
 * section 8 invariant 2 ("WS open is not ready"). The engine answers one
 * request_id-correlated control frame:
 *
 *   -> {"type":"app_server_info","request_id":"<non-empty>"}
 *   <- {"type":"app_server_info_response","request_id":"<same>","success":true,
 *       "letta_code_version":"0.6.0","protocol_version":1,"backend":"local",
 *       "capabilities":{...}}
 *
 * F-17: the engine echoes any non-empty `request_id`, and the response is
 * correlated by it, so a frame with the right type but a foreign id belongs to
 * another request and is ignored. That is intentional here: the engine uses one
 * socket for several request/response pairs, and treating a stray id as a fatal
 * protocol error would break the moment two requests overlap. A fake server that
 * only answers with a foreign id therefore ends in the timeout path.
 *
 * This module is private by design: it is not exported from `engine/index.ts`,
 * so the facade (`engine.ts`) is its only consumer. Failures are
 * raised as `EngineConnectionError` with `code = "PROTOCOL_MISMATCH"` - the
 * frozen code for "opened but did not answer with a matching response"
 * The facade catches that class and forwards `toEngineError()`; it
 * does not need to inspect messages or build an error of its own.
 */

import { randomUUID } from "node:crypto";

import { EngineConnectionError } from "./connection";
import type { EngineSocket } from "./connection";
import type { AppServerInfo } from "./types";

/** Request frame type; the engine's handler keys on this literal. */
const APP_SERVER_INFO_TYPE = "app_server_info";

/** Response frame type that completes the handshake (F-15). */
const APP_SERVER_INFO_RESPONSE_TYPE = "app_server_info_response";

/** Default handshake budget; F-16 measured 59 ms, so 5 s is generous. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

/** Upper bound of a frame summary copied into `wireHint`. */
const MAX_WIRE_HINT_CHARS = 300;

/**
 * Ask the engine who it is.
 *
 * Sends one `app_server_info` frame with a fresh `request_id`, then resolves with
 * the parsed {@link AppServerInfo} from the matching response. Frames of any other
 * type, malformed JSON and responses carrying a different `request_id` are
 * ignored; the request stays pending until the matching answer arrives or the
 * budget runs out.
 *
 * Rejects with `EngineConnectionError` and `code = "PROTOCOL_MISMATCH"` when:
 * - no matching response arrived within `timeoutMs` (default 5 s, F-16);
 * - the engine answered `success: false`;
 * - the matching answer is missing a valid `protocol_version` /
 *   `letta_code_version`;
 * - the socket errored or closed before the answer;
 * - the request frame could not be written.
 *
 * The socket itself is not closed here: the facade owns the connection lifecycle
 * and closes it on a failed start.
 *
 * @param socket open engine socket, normally just returned by `connectEngine`
 * @param timeoutMs handshake budget, 5 s by default
 */
export function requestAppServerInfo(
  socket: EngineSocket,
  timeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
): Promise<AppServerInfo> {
  const requestId = randomUUID();
  const waitMs = normalizeTimeout(timeoutMs);

  return new Promise<AppServerInfo>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }

      socket.removeListener("message", onMessage);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    const fail = (detail: string, wireHint?: string): void => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new EngineConnectionError("PROTOCOL_MISMATCH", detail, wireHint));
    };

    function onMessage(data: Buffer): void {
      if (settled) {
        return;
      }

      const frame = parseFrame(data);
      if (frame === null || frame.type !== APP_SERVER_INFO_RESPONSE_TYPE) {
        return;
      }

      if (frame.request_id !== requestId) {
        // Belongs to another request_id on the same socket; keep waiting.
        return;
      }

      if (frame.success === false) {
        fail(
          `engine reported app_server_info failure: ${engineErrorText(frame)}`,
          summarizeFrame(frame),
        );
        return;
      }

      const parsed = readAppServerInfo(frame);
      if (parsed.ok === false) {
        fail(parsed.detail, summarizeFrame(frame));
        return;
      }

      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(parsed.info);
    }

    function onError(error: Error): void {
      fail(
        `socket failed while waiting for ${APP_SERVER_INFO_RESPONSE_TYPE}: ${messageOf(error)}`,
        wireCodeOf(error),
      );
    }

    function onClose(code: number): void {
      fail(
        `socket closed (code ${code}) before ${APP_SERVER_INFO_RESPONSE_TYPE} arrived ` +
          `(request_id ${requestId}).`,
        `close ${code}`,
      );
    }

    function onTimeout(): void {
      fail(
        `timed out after ${waitMs}ms waiting for ${APP_SERVER_INFO_RESPONSE_TYPE} ` +
          `(request_id ${requestId}).`,
      );
    }

    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
    timer = setTimeout(onTimeout, waitMs);

    try {
      socket.send(JSON.stringify({ type: APP_SERVER_INFO_TYPE, request_id: requestId }));
    } catch (error) {
      fail(`could not send ${APP_SERVER_INFO_TYPE}: ${messageOf(error)}`, wireCodeOf(error));
    }
  });
}

type ParsedAppServerInfo = { ok: true; info: AppServerInfo } | { ok: false; detail: string };

/**
 * Validate and rename the wire fields.
 *
 * `backend` falls back to `"local"` for any value outside the documented union,
 * while `raw` keeps the untouched frame so a future backend value can still be
 * inspected. The two version fields are required: an empty `engineVersion` would
 * silently pass a later expected-version check, and a missing protocol version
 * cannot be compared at all, so both are protocol failures instead.
 */
function readAppServerInfo(frame: Record<string, unknown>): ParsedAppServerInfo {
  const protocolVersion = frame.protocol_version;

  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion)) {
    return {
      ok: false,
      detail: `${APP_SERVER_INFO_RESPONSE_TYPE} has no integer protocol_version`,
    };
  }

  const engineVersion = frame.letta_code_version;

  if (typeof engineVersion !== "string" || engineVersion.length === 0) {
    return {
      ok: false,
      detail: `${APP_SERVER_INFO_RESPONSE_TYPE} has no non-empty letta_code_version`,
    };
  }

  return {
    ok: true,
    info: {
      protocolVersion,
      engineVersion,
      backend: frame.backend === "api" ? "api" : "local",
      raw: frame,
    },
  };
}

/** Parse one message payload into a JSON object, or `null` when it is not one. */
function parseFrame(data: Buffer): Record<string, unknown> | null {
  let value: unknown;

  try {
    value = JSON.parse(data.toString("utf8"));
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/**
 * Text of a `success: false` answer. The engine's documented response type only
 * has `success: true` (its own guard rejects anything else), so the shape is
 * unknown; the common diagnostic fields are probed in order.
 */
function engineErrorText(frame: Record<string, unknown>): string {
  for (const key of ["error", "message", "detail"] as const) {
    const value = frame[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return "the engine supplied no error text";
}

/** Clip a frame for `wireHint`, so a hostile/large answer cannot bloat logs. */
function summarizeFrame(frame: Record<string, unknown>): string {
  const text = JSON.stringify(frame);

  if (text === undefined) {
    return "unserializable frame";
  }

  return text.length > MAX_WIRE_HINT_CHARS ? `${text.slice(0, MAX_WIRE_HINT_CHARS)}...` : text;
}

/** Readable message for a thrown value of unknown shape. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

/** Extract a Node error code without trusting the thrown value. */
function wireCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

/**
 * Normalize the handshake budget: absent or non-finite falls back to the default;
 * a negative value behaves like an immediate timeout instead of a runaway wait.
 */
function normalizeTimeout(timeoutMs: number): number {
  return Number.isFinite(timeoutMs)
    ? Math.max(0, Math.trunc(timeoutMs))
    : DEFAULT_HANDSHAKE_TIMEOUT_MS;
}
