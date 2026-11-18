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
   * Emit one store answer as its own control frame.
   *
   * The body is the store's result plus the instance it belongs to; the
   * correlation id rides on the envelope, because that is where the renderer
   * matches an answer to the request that asked for it.
   *
   * No size is measured here, deliberately. A `session.view` body is a selector's
   * return value plus four scalars, so its size is a consequence of the shape the
   * selectors are frozen to return - not a runtime property a gate at this layer
   * could influence. The measurement already exists where it belongs: the payload
   * probe replays a recording through the real selector set and compares each
   * view type against the control-channel limit, and the largest (navigation) sits
   * far below it. Intercepting here would change the contract rather than protect
   * it: refusing a subscription would turn a push into a pull the page never asked
   * for, and the page would draw nothing while waiting for a frame that is not
   * coming.
   */
  function emitView(request: SelectRequest, reqId: string, result: SelectResult): void {
    const body: SessionViewBody = { ...result, instanceId: request.instanceId };
    const frame: ControlFrame<"session.view", SessionViewBody> = {
      v: 1,
      ch: "control",
      seq: 0,
      t: "session.view",
      body,
      reqId,
    };

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
