/**
 * The renderer's frame source: the bridge channels, adapted to the shape the
 * terminal feed consumes.
 *
 * Why this adapter exists
 *   `packages/ui` may not import the bridge, and the bridge may not import the
 *   terminal layer, so neither can name the other's contract. This is the one file
 *   that knows both: it registers on the deliver channels and hands over the
 *   discriminator and the unvalidated body, which is exactly what
 *   `createTerminalFeed` asks for and nothing more.
 *
 * Why it parses instead of forwarding the raw string
 *   The feed's contract is `{ t, body }`, not a JSON string: parsing belongs to
 *   whoever owns the transport, and `bridge.ts` already parses for its own
 *   purposes. A payload that does not parse is dropped here, because a frame whose
 *   type cannot be read cannot be routed -- and dropping is recorded by the feed,
 *   which counts what it refused.
 *
 * Why there is no lifecycle subscription
 *   The bridge reports a ready frame it sends, not a readiness it is told about
 *   (`bridge.ready` is c2s). There is no event to subscribe to, so the optional
 *   half of the contract is left out on purpose rather than stubbed with a
 *   callback that would never fire. The panel's `engineReady` is passed `false`
 *   for the same reason.
 */

import type { TerminalFrame, TerminalFrameSource } from "@haruyuki/ui";

import { BRIDGE_CHANNEL_NAMES } from "../shared/bridge.js";

/** What a frame looks like on the wire, as much of it as this adapter reads. */
interface Parsed {
  readonly t: string;
  readonly body: unknown;
}

/**
 * Read one delivered payload as a frame.
 *
 * @param payload the raw JSON text
 * @returns the frame, or `null` when it is not one
 */
function readFrame(payload: unknown): TerminalFrame | null {
  if (typeof payload !== "string") return null;

  let parsed: unknown;

  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const t = record["t"];

  if (typeof t !== "string" || t === "") return null;

  const frame: Parsed = { t, body: record["body"] };

  return frame;
}

/** The bridge surface this adapter needs, narrowed so a test needs no Electron. */
export interface FrameChannelSurface {
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

/**
 * Build a frame source over the bridge's delivery channels.
 *
 * All three channels are read because the terminal's frames are not guaranteed to
 * arrive on one: `term.output` rides the stream channel, and a control frame such
 * as `terminal_spawned` may be routed by the main process on either. Registering
 * on all three and letting the feed refuse what it does not understand is what
 * keeps this adapter from having to know the routing table.
 *
 * @param bridge the shell bridge's subscription surface
 * @returns the source the feed consumes
 */
export function createBridgeFrameSource(bridge: FrameChannelSurface): TerminalFrameSource {
  return {
    subscribe(listener: (frame: TerminalFrame) => void): () => void {
      const channels = [
        BRIDGE_CHANNEL_NAMES.frameDeliver.control,
        BRIDGE_CHANNEL_NAMES.frameDeliver.stream,
        BRIDGE_CHANNEL_NAMES.frameDeliver.bulk,
      ];

      const unsubscribes = channels.map((channel) =>
        bridge.on(channel, (payload: unknown) => {
          const frame = readFrame(payload);

          if (frame !== null) listener(frame);
        }),
      );

      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
  };
}
