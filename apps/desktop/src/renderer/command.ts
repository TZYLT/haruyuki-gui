/**
 * The renderer's command client.
 *
 * One job: take the intent a page has ("run this capability with this body") and
 * turn the preload's `unknown` answer into a {@link CommandReply}. It does no
 * business thinking - no retry, no queueing, no capability table, no scope
 * decision - because every one of those already has an owner on the other side of
 * the channel: the core dispatcher decides scope and completion, and the main
 * process owns the channel pool.
 *
 * Why the shape is narrowed here rather than trusted
 *   The value crossed `ipcRenderer.invoke`, so it is data, not a typed object.
 *   A host built a version earlier than this renderer can answer with a shape
 *   this file has not seen, and a page that destructured it blind would crash on
 *   a malformed reply instead of showing a refusal. Narrowing once here means
 *   every page downstream can switch on `ok` without a second guard.
 *
 * Why the code is only checked for being a non-empty string
 *   The error-code set is closed *for one version of the surface*, and a newer
 *   main process may legitimately send a code this renderer does not know. That
 *   is a version skew, not a malformed reply, and the page already has a fallback
 *   for an unrecognised code (it shows the code itself). Rejecting the reply here
 *   would throw away `engineText` - the one thing worth showing - over a value the
 *   page can still render.
 *
 * Why a bridge rejection becomes `COMMAND_CHANNEL_UNAVAILABLE`
 *   `ipcRenderer.invoke` rejects when no handler is registered or the handler
 *   itself threw; both mean "there was no working channel to answer on", which is
 *   exactly what that code says. Letting it reject would put a caught-nowhere
 *   promise in every click handler, and the reply union has no arm for "threw".
 */

import type { CommandCall, CommandErrorCode, CommandReply, RuntimeScope } from "@haruyuki/core";

import { BRIDGE_CHANNEL_NAMES } from "../shared/bridge.js";

/**
 * The one preload member this client uses.
 *
 * Structural rather than imported from `shared/bridge.ts`: the renderer needs
 * `invoke` and nothing else, and the full `window.haruyuki` surface satisfies
 * this shape by construction.
 */
export interface CommandBridgeSurface {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
}

/** What a page holds and calls. */
export interface CommandClient {
  invoke(
    capability: string,
    body: Record<string, unknown>,
    runtime?: RuntimeScope,
  ): Promise<CommandReply>;
}

/**
 * A refusal this client produced itself, with an English ASCII `detail` for logs.
 *
 * @param detail what was wrong, in one short sentence
 * @returns the reply a page can render like any other failure
 */
function malformed(detail: string): CommandReply {
  return { ok: false, code: "COMMAND_BAD_PAYLOAD", detail };
}

/** @param value any value @returns whether it is a non-array object */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param value any value @returns whether it is a string or absent */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * Narrows an untrusted value to a command error code.
 *
 * Only the shape is checked (a non-empty string); membership in this build's
 * closed set deliberately is not, for the version-skew reason in the file header.
 */
function isCommandErrorCode(value: unknown): value is CommandErrorCode {
  return typeof value === "string" && value.length > 0;
}

/**
 * Reads one reply off the channel.
 *
 * Unknown extra fields are dropped rather than forwarded: the reply type is the
 * whole contract a page may rely on, and carrying a field the type does not name
 * would make a later page depend on something no signer promised.
 *
 * @param value the untrusted answer from the preload
 * @returns the narrow reply, or a `COMMAND_BAD_PAYLOAD` refusal
 */
function readReply(value: unknown): CommandReply {
  if (!isRecord(value)) {
    return malformed("the command reply is not a plain object");
  }

  const ok = value["ok"];

  if (ok === true) {
    const completion = value["completion"];

    if (completion === "answered") {
      if (!Object.hasOwn(value, "data")) {
        return malformed("an answered reply must carry data");
      }

      return { ok: true, completion: "answered", data: value["data"] };
    }

    if (completion === "accepted") {
      return { ok: true, completion: "accepted" };
    }

    return malformed("the reply's completion is neither answered nor accepted");
  }

  if (ok !== false) {
    return malformed("the reply's ok flag is not a boolean");
  }

  const code = value["code"];
  if (!isCommandErrorCode(code)) {
    return malformed("the reply's code is not a command error code");
  }

  const detail = value["detail"];
  const engineText = value["engineText"];

  if (!isOptionalString(detail) || !isOptionalString(engineText)) {
    return malformed("the reply's detail or engineText is not a string");
  }

  // Built field by field instead of assigning `undefined`: under
  // `exactOptionalPropertyTypes` an absent key and a present `undefined` are
  // different values, and the absent one is what the signed reply means.
  const failure = { ok: false as const, code };

  if (detail !== undefined && engineText !== undefined) {
    return { ...failure, detail, engineText };
  }

  if (detail !== undefined) {
    return { ...failure, detail };
  }

  if (engineText !== undefined) {
    return { ...failure, engineText };
  }

  return failure;
}

/**
 * Builds the client from the preload bridge.
 *
 * @param bridge the preload surface (only `invoke` is used)
 * @returns a client whose `invoke` never rejects
 */
export function createCommandClient(bridge: CommandBridgeSurface): CommandClient {
  return {
    async invoke(
      capability: string,
      body: Record<string, unknown>,
      runtime?: RuntimeScope,
    ): Promise<CommandReply> {
      // `runtime` is a sibling of `body`, never folded into it: the core
      // dispatcher validates the two positions separately, and a body carrying
      // the scope would be refused as an envelope key.
      const call: CommandCall =
        runtime === undefined ? { capability, body } : { capability, body, runtime };

      let raw: unknown;

      try {
        raw = await bridge.invoke(BRIDGE_CHANNEL_NAMES.commandInvoke, call);
      } catch {
        return {
          ok: false,
          code: "COMMAND_CHANNEL_UNAVAILABLE",
          detail: "the command channel rejected the request",
        };
      }

      return readReply(raw);
    },
  };
}
