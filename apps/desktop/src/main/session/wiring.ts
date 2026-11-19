/**
 * The shell side of the session selector frames.
 *
 * The store owns the state and never sends; this module is the one place that
 * turns a renderer's `session.*` request into a store call and the store's
 * answer into a control frame. It is deliberately small, because the split it
 * performs is the whole reason it exists:
 *
 *   renderer -> `session.subscribe` / `session.unsubscribe` / `session.select`
 *              arrive on the bridge's submit path, which is a renderer-bound
 *              sender. Handing them to it would number them and send them back.
 *   engine   -> one merged change per event; the command service hands each one
 *              here so the folds can see it.
 *
 * Nothing here reads a clock, opens a socket or touches `electron`: the store is
 * injected and the sink is the bridge's `send`, so the whole module runs in a
 * plain Node process.
 *
 * What it deliberately does not do:
 *   - it never rewrites a payload. The bytes that came off the IPC boundary are
 *     parsed once, and only to learn the frame type; the store receives the
 *     body's fields as they are.
 *   - it recognises only the four session frame types. Anything else (a
 *     `bridge.ready`, a layout save, a frame from a future producer) is handed
 *     back to the caller, which keeps the existing path byte-for-byte intact.
 */

import type {
  ControlFrame,
  Frame,
  SelectRequest,
  SelectResult,
  SessionResultBody,
  SessionSelectCode,
  SessionStore,
  SessionViewBody,
} from "@haruyuki/protocol";
import {
  SESSION_BAD_PARAMS,
  SESSION_UNAVAILABLE,
  SESSION_UNKNOWN_SELECTOR,
} from "@haruyuki/protocol";
import type { MergerChange } from "@haruyuki/core";

/** What the shell supplies. */
export interface SessionWiringOptions {
  /** The assembled store; the shell builds it once for the app's lifetime. */
  readonly store: SessionStore;
  /** The bridge sink. Every frame this module emits leaves through exactly this. */
  readonly send: (frame: Frame) => void;
}

/** The handle the composition root keeps. */
export interface SessionWiring {
  /**
   * Consume one renderer-originated control frame.
   *
   * @param payload the raw string off the IPC boundary, never rewritten
   * @returns `true` when this module recognised and consumed the frame; `false`
   *   hands it back to the existing submit path untouched
   */
  onControlFrame(payload: string): boolean;

  /** Feed one merged change to the store. Never throws. */
  onMergerChange(change: MergerChange): void;

  /** Release every live subscription; idempotent, and never throws. */
  dispose(): void;
}

/** The frame types this side consumes, as the renderer spells them. */
const REQUEST_TYPES: ReadonlySet<string> = new Set([
  "session.subscribe",
  "session.unsubscribe",
  "session.select",
]);

/**
 * The largest a single control frame may be, in UTF-8 bytes.
 *
 * The control channel carries one frame per message and never batches, so a body
 * over this size has nowhere to go: it cannot be split across frames, and it must
 * not be cut, because a half-drawn list is worse than a list drawn a moment
 * later. A result that would exceed the limit is therefore not pushed at all -
 * the page asks for it with `session.select`, whose answer travels on the
 * request's own correlation id and has no such ceiling.
 *
 * The number is the channel's, not this module's choice; it is named here so the
 * one place that measures and the tests that pin it read the same constant.
 */
export const VIEW_FRAME_LIMIT_BYTES = 16 * 1024;

/**
 * Selectors a page asks for, rather than has pushed at it.
 *
 * These three answer with one turn's or one conversation's content, so what they
 * return grows with how much the engine has written rather than with how much of
 * it the reader has on screen. That is why the selector contract's carrier
 * column names a one-shot select for them: a push of one is a push whose size
 * nobody can bound in advance.
 *
 * A subscription to one of these is still recorded - a conversation's watcher and
 * the unread badge hang off the subscription table, and a re-subscribe must still
 * replace the instance it replaces - but it never becomes a push frame. Nothing
 * is withheld: the same value is available in full from `session.select`.
 */
const ON_DEMAND_SELECTORS: ReadonlySet<string> = new Set([
  "entity.turns",
  "entity.blocks",
  "entity.subagents",
]);

/** A non-empty string, or `null`. */
function readText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A readable record, or `null`. */
function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * The request a subscribe/select body declares, or `null` when it names nothing.
 *
 * The instance is required of a subscription and optional of a one-shot select:
 * a subscription is a place a later frame is sent to, while a select is answered
 * on the envelope's correlation id alone. An empty instance is used for the
 * latter rather than inventing one, because the store's selector run never reads
 * it.
 */
function readRequest(
  record: Readonly<Record<string, unknown>>,
  instanceRequired: boolean,
): SelectRequest | null {
  const instanceId = readText(record["instanceId"]);
  const selector = readText(record["selector"]);

  if (selector === null || (instanceRequired && instanceId === null)) {
    return null;
  }

  const params = readRecord(record["params"]);
  const active = record["active"];

  return {
    instanceId: instanceId ?? "",
    selector,
    params: params ?? {},
    ...(typeof active === "boolean" ? { active } : {}),
  };
}

/**
 * The refusal a failed selection carries, or `null` when it succeeded.
 *
 * The store's documented answer for a failed run is a `session.result` body with
 * `ok: false` and a code, and the code rides on the same object the signed result
 * shape describes. Reading it here instead of asserting the wider shape keeps
 * the published contract the one the types state, while the failure arm still
 * crosses the wire as the frame body the renderer decodes.
 */
function refusalCodeOf(selection: SelectResult): SessionSelectCode | null {
  const candidate = (selection as unknown as Record<string, unknown>)["code"];

  if (
    candidate === SESSION_UNKNOWN_SELECTOR ||
    candidate === SESSION_BAD_PARAMS ||
    candidate === SESSION_UNAVAILABLE
  ) {
    return candidate;
  }

  return null;
}

/**
 * Build the shell side of the session frames.
 *
 * @param options the store and the bridge sink
 * @returns the control-frame consumer, the change sink and the disposer
 */
export function createSessionWiring(options: SessionWiringOptions): SessionWiring {
  const { store, send } = options;

  /** The live unsubscribe handle per renderer instance, so one instance is one subscription. */
  const handles = new Map<string, () => void>();

  let disposed = false;

  /**
   * Emit one store answer as its own control frame, when it belongs on the push
   * path at all and fits the control channel.
   *
   * The body is the store's result plus the instance it belongs to; the
   * correlation id rides on the envelope, because that is where the renderer
   * matches an answer to the request that asked for it.
   *
   * Two answers never become a frame here, and neither one loses anything:
   *
   * - **A selector carried on demand.** Its value grows with the conversation,
   *   not with what is on screen, so the contract hands it to a one-shot select.
   *   The subscription itself is still made: the watcher and the unread badge
   *   live on the subscription table, and a page that asks for the value gets it
   *   in full from `session.select`.
   * - **A result whose serialized frame is over {@link VIEW_FRAME_LIMIT_BYTES}.**
   *   The size is measured on the bytes that would actually be sent, not
   *   estimated from the shape: a turn with hundreds of blocks is small in
   *   description and large in fact. Over the limit the frame is withheld rather
   *   than cut - a truncated list draws a page that is wrong without saying so,
   *   while the whole value is still one `session.select` away.
   */
  function emitView(request: SelectRequest, reqId: string, result: SelectResult): void {
    if (ON_DEMAND_SELECTORS.has(request.selector)) {
      return;
    }

    const body: SessionViewBody = { ...result, instanceId: request.instanceId };
    const frame: ControlFrame<"session.view", SessionViewBody> = {
      v: 1,
      ch: "control",
      seq: 0,
      t: "session.view",
      body,
      reqId,
    };

    // Measured on the serialized frame, because that is what the channel carries:
    // the envelope's fields grow and shrink with the selector's params too, and an
    // estimate of the body alone would be a second, quieter answer to "how big".
    if (Buffer.byteLength(JSON.stringify(frame), "utf8") > VIEW_FRAME_LIMIT_BYTES) {
      return;
    }

    send(frame);
  }

  /** Start (or replace) one subscription; the store answers with the current value first. */
  function subscribe(record: Readonly<Record<string, unknown>>, reqId: string): void {
    const request = readRequest(record, true);

    if (request === null) {
      return;
    }

    // The store replaces a re-subscribed instance on its own, so the previous
    // handle is not called here: releasing it first would report a departure
    // and an arrival for what is one instance re-reporting itself.
    //
    // A re-subscribe that only flips `active` to `false` does not release the
    // conversation's watcher either, and that is the intended reading: losing
    // focus is the page leaving the reader's sight, while the tab is still open
    // and will report itself active again. The store's edge detection counts
    // "does this conversation have an active instance", and a watcher is released
    // when an instance is actually unsubscribed or disposed -- not when it
    // reports that the reader looked away.
    const off = store.subscribe(request, (result) => {
      emitView(request, reqId, result);
    });

    handles.set(request.instanceId, off);
  }

  /** End one subscription by instance; an unknown instance is a no-op. */
  function unsubscribe(record: Readonly<Record<string, unknown>>): void {
    const instanceId = readText(record["instanceId"]);

    if (instanceId === null) {
      return;
    }

    const off = handles.get(instanceId);

    if (off === undefined) {
      return;
    }

    handles.delete(instanceId);

    try {
      off();
    } catch {
      // A handle that throws is a store bug; the map no longer holds it, and a
      // later re-subscribe of the same instance must still work.
    }
  }

  /** Answer one on-demand selector request. */
  function select(record: Readonly<Record<string, unknown>>, reqId: string): void {
    const request = readRequest(record, false);

    if (request === null) {
      const refused: ControlFrame<"session.result", SessionResultBody> = {
        v: 1,
        ch: "control",
        seq: 0,
        t: "session.result",
        body: { ok: false, selector: "", code: "SESSION_BAD_PARAMS" },
        reqId,
      };

      send(refused);

      return;
    }

    const selection = store.select(request);
    const code = refusalCodeOf(selection);

    const body: SessionResultBody =
      code === null
        ? {
            ok: true,
            selector: selection.selector,
            params: selection.params,
            revision: selection.revision,
            epoch: selection.epoch,
            value: selection.value,
          }
        : { ok: false, selector: selection.selector, code };

    const frame: ControlFrame<"session.result", SessionResultBody> = {
      v: 1,
      ch: "control",
      seq: 0,
      t: "session.result",
      body,
      reqId,
    };

    send(frame);
  }

  function onControlFrame(payload: string): boolean {
    if (disposed || typeof payload !== "string") {
      return false;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(payload);
    } catch {
      // Not JSON at all: nothing here owns it, so the existing path keeps it.
      return false;
    }

    const frame = readRecord(parsed);

    if (frame === null) {
      return false;
    }

    const type = readText(frame["t"]);

    if (type === null || !REQUEST_TYPES.has(type)) {
      // `bridge.ready`, a layout frame, a bulk page: not this module's.
      return false;
    }

    const reqId = readText(frame["reqId"]) ?? "";
    const body = readRecord(frame["body"]);

    if (body === null) {
      // A recognised frame with an unusable body is still ours: consuming it
      // keeps a malformed request from being echoed back to the renderer as a
      // frame no consumer expects.
      //
      // A one-shot select is the exception that must still answer. Its caller is
      // waiting on the correlation id, so consuming the request without a frame
      // would leave that wait open for the life of the page - the one outcome
      // worse than a refusal. The refusal arm already exists for a request whose
      // shape cannot be read, so a body that is not even a record travels on it.
      if (type === "session.select") {
        select({}, reqId);
      }

      // A subscription and its cancellation are not answered on the correlation
      // id: they are state held by the table, and a request that could not be
      // read asked for no state. Nothing is left waiting on them.
      return true;
    }

    if (type === "session.subscribe") {
      subscribe(body, reqId);
    } else if (type === "session.unsubscribe") {
      unsubscribe(body);
    } else {
      select(body, reqId);
    }

    return true;
  }

  function onMergerChange(change: MergerChange): void {
    if (disposed) {
      return;
    }

    try {
      store.ingest(change);
    } catch {
      // The store documents that it never throws; one unexpected payload must
      // not take the channel's other subscribers down with it.
    }
  }

  function dispose(): void {
    if (disposed) {
      return;
    }

    disposed = true;

    for (const off of handles.values()) {
      try {
        off();
      } catch {
        // Same standing as unsubscribe: the map is dropped next either way.
      }
    }

    handles.clear();
  }

  return { onControlFrame, onMergerChange, dispose };
}
