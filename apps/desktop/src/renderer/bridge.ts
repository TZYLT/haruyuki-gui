/**
 * The renderer half of the bridge.
 *
 * C5's `FrameEntry` validates and counts; it deliberately does not dispatch to
 * business code (`entry.ts:59-64`). This module adds the one narrow route D3
 * owns: `term.output` goes straight to the terminal router, never through React
 * React state. Every other frame stays with `FrameEntry` for the layers that
 * render it.
 *
 * The ready frame is the first thing sent, before any subscription is useful.
 * Its version fields come from the URL rather than a value import of
 * `@haruyuki/protocol`: rule R7 keeps the renderer from importing that package's
 * runtime values, and the main process already knows the versions.
 */

import { createFrameEntry, type FrameEntry } from "@haruyuki/ui";
import type { TerminalNotice, TerminalRouter } from "@haruyuki/ui";
import type { LayoutSnapshotBody } from "@haruyuki/protocol";

import { BRIDGE_CHANNEL_NAMES } from "../shared/bridge.js";

/** The version facts the main process puts in the URL. */
export interface BridgeBoot {
  appVersion: string;
  bridgeVersion: string;
  frameProtocolVersion: number;
}

/** The three members of `window.haruyuki` this module uses. */
export interface RendererBridgeSurface {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

/** What the renderer entry injects. */
export interface RendererBridgeOptions {
  bridge: RendererBridgeSurface;
  boot: BridgeBoot;
  terminal: TerminalRouter;
  onNotice: (notice: TerminalNotice) => void;
  /** Optional; called when the ready invoke rejects. */
  onReadyError?: (error: unknown) => void;
  /** Optional; called once when the current generation's handshake is accepted. */
  onAccepted?: () => void;
  /** Optional; the bulk `layout.snapshot` route, once the frame host is mounted. */
  onLayoutSnapshot?: (body: LayoutSnapshotBody) => void;
}

/** The renderer's bridge handle. */
export interface RendererBridge {
  readonly entry: FrameEntry;
  dispose(): void;
}

/** Build the renderer bridge and send the ready frame. */
export function createRendererBridge(options: RendererBridgeOptions): RendererBridge {
  const { bridge, boot, terminal } = options;

  assertBoot(boot);

  const entry = createFrameEntry({
    expectedBridgeVersion: boot.bridgeVersion,
    frameProtocolVersion: boot.frameProtocolVersion,
  });

  const unsubscribes: Array<() => void> = [];
  let disposed = false;
  let accepted = false;

  const subscribe = (channel: string, listener: (payload: unknown) => void): void => {
    unsubscribes.push(bridge.on(channel, listener));
  };

  const onDeliver =
    (channel: string) =>
    (payload: unknown): void => {
      if (disposed || typeof payload !== "string") return;

      entry.handle(payload);

      // `bridge.ready` is the c2s half; `bridge.accept` is the existing s2c
      // fact that this generation's handshake succeeded. Reading the type here
      // costs one parse and saves every consumer from inferring acceptance from
      // the absence of a reject.
      if (!accepted && readFrameType(payload) === "bridge.accept") {
        accepted = true;
        options.onAccepted?.();
      }

      if (channel === BRIDGE_CHANNEL_NAMES.frameDeliver.bulk) {
        const layout = readLayoutBody(payload);

        if (layout !== null) options.onLayoutSnapshot?.(layout);

        return;
      }

      if (channel !== BRIDGE_CHANNEL_NAMES.frameDeliver.stream) return;

      const body = readTermBody(payload);

      if (body !== null) terminal.deliver(body);
    };

  subscribe(
    BRIDGE_CHANNEL_NAMES.frameDeliver.control,
    onDeliver(BRIDGE_CHANNEL_NAMES.frameDeliver.control),
  );
  subscribe(
    BRIDGE_CHANNEL_NAMES.frameDeliver.stream,
    onDeliver(BRIDGE_CHANNEL_NAMES.frameDeliver.stream),
  );
  subscribe(
    BRIDGE_CHANNEL_NAMES.frameDeliver.bulk,
    onDeliver(BRIDGE_CHANNEL_NAMES.frameDeliver.bulk),
  );
  subscribe(BRIDGE_CHANNEL_NAMES.terminalNotice, (payload) => {
    if (disposed) return;

    const notice = readNotice(payload);

    if (notice !== null) options.onNotice(notice);
  });

  const ready = JSON.stringify({
    v: 1,
    ch: "control",
    seq: 0,
    t: "bridge.ready",
    body: { appVersion: boot.appVersion, bridgeVersion: boot.bridgeVersion },
  });

  void bridge
    .invoke(BRIDGE_CHANNEL_NAMES.frameSubmit, ready)
    .catch((error: unknown) => options.onReadyError?.(error));

  return {
    entry,
    dispose() {
      if (disposed) return;

      disposed = true;

      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes.length = 0;
    },
  };
}

/** Fail loudly on a missing/garbled boot parameter rather than showing a dead page. */
function assertBoot(boot: BridgeBoot): void {
  if (typeof boot.appVersion !== "string" || boot.appVersion === "") {
    throw new RangeError("bridge boot: appVersion must be a non-empty string");
  }

  if (typeof boot.bridgeVersion !== "string" || boot.bridgeVersion === "") {
    throw new RangeError("bridge boot: bridgeVersion must be a non-empty string");
  }

  if (!Number.isFinite(boot.frameProtocolVersion)) {
    throw new RangeError("bridge boot: frameProtocolVersion must be finite");
  }
}

/** Read the frame type out of one serialized frame; null when it cannot be read. */
function readFrameType(payload: string): string | null {
  try {
    const parsed: unknown = JSON.parse(payload);

    if (typeof parsed !== "object" || parsed === null) return null;

    const t = (parsed as Record<string, unknown>)["t"];

    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

/** Read a `term.output` body out of one serialized frame; null for every other type. */
function readTermBody(payload: string): {
  terminal_id: string;
  slice: number;
  slices: number;
  offset: number;
  bytes: number;
  final: boolean;
  text: string;
} | null {
  try {
    const parsed: unknown = JSON.parse(payload);

    if (typeof parsed !== "object" || parsed === null) return null;

    const frame = parsed as Record<string, unknown>;

    if (frame["t"] !== "term.output") return null;

    const body = frame["body"];

    if (typeof body !== "object" || body === null) return null;

    const record = body as Record<string, unknown>;
    const terminalId = record["terminal_id"];
    const text = record["text"];

    if (typeof terminalId !== "string" || terminalId === "") return null;
    if (typeof text !== "string") return null;

    return {
      terminal_id: terminalId,
      text,
      slice: readNumber(record["slice"]),
      slices: readNumber(record["slices"]),
      offset: readNumber(record["offset"]),
      bytes: readNumber(record["bytes"]),
      final: record["final"] === true,
    };
  } catch {
    return null;
  }
}

/** Read a `layout.snapshot` body out of one serialized frame; null for every other type. */
function readLayoutBody(payload: string): LayoutSnapshotBody | null {
  try {
    const parsed: unknown = JSON.parse(payload);

    if (typeof parsed !== "object" || parsed === null) return null;

    const frame = parsed as Record<string, unknown>;

    if (frame["t"] !== "layout.snapshot") return null;

    const body = frame["body"];

    if (typeof body !== "object" || body === null) return null;

    const record = body as Record<string, unknown>;
    const items = record["items"];
    const revision = record["revision"];

    if (!Array.isArray(items) || items.length !== 1) return null;
    if (typeof revision !== "number" || !Number.isFinite(revision)) return null;

    const doc = items[0];

    if (typeof doc !== "object" || doc === null) return null;

    return body as unknown as LayoutSnapshotBody;
  } catch {
    return null;
  }
}

/** Read the transport-level notice payload; null when it is not one. */
function readNotice(payload: unknown): TerminalNotice | null {
  if (typeof payload !== "object" || payload === null) return null;

  const record = payload as Record<string, unknown>;
  const terminalId = record["terminal_id"];
  const dropped = record["droppedBytes"];

  if (typeof terminalId !== "string" || terminalId === "") return null;
  if (typeof dropped !== "number" || !Number.isFinite(dropped) || dropped < 0) return null;

  return { terminal_id: terminalId, droppedBytes: dropped };
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
