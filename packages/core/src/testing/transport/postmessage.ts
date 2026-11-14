/**
 * postmessage.ts - the webview-shaped transport double.
 *
 * Scope sources: docs/18-A3 sections 1.2 `R-10` (model `postMessage` / `message`
 * events, do not add a frozen seam), 3.4.4 (the frozen `TransportDouble`) and 7
 * `R-06` (different async granularity from the `ipc` double). Requirement side:
 * docs/17-A3 section 4.3, acceptance pick-path.
 *
 * Shape only. This module does not use `window`, `MessageEvent` or any DOM
 * global: the platform object is modelled on `setTimeout`, so the double runs in
 * a plain `node` process next to the headless host.
 *
 * What is modelled from the real shell:
 *
 * - `postMessage(frame)` is the outbound half; `onFrame` stands in for the
 *   `message` event listener and unwraps the `data` field a real event would
 *   carry. The double hands the frame itself to the listener, because the
 *   envelope, not the event wrapper, is what `Observation` records.
 * - Delivery is one `setTimeout(0)` macrotask, one turn coarser than the
 *   `ipc` double's `queueMicrotask`. The two
 *   granularities are the executable form of "cross-channel order is not
 *   guaranteed": post the same back-to-back pair to both doubles and, on the
 *   combined timeline, the ipc arrival can overtake the postMessage one. Within
 *   one double the order is always the post order - the inversion is between
 *   shells over the same channel, which is what a merge of the two would see.
 * - `post`, `onFrame` and `close` are the frozen members, unchanged.
 */

import type { BridgeFrame } from "../fixture";

import type { TransportDouble, TransportDoubleOptions } from "./delivery";
import { createDelivery } from "./delivery";

/** The `postMessage` double: the frozen `TransportDouble` plus the platform shape. */
export interface PostMessageTransportDouble extends TransportDouble {
  readonly name: "postmessage";
  postMessage(frame: BridgeFrame): void;
}

/**
 * Create the `postmessage`-shaped double.
 *
 * @param options `onReject` is called synchronously for every frame that is not
 * delivered; see {@link TransportDoubleOptions}.
 */
export function createPostMessageDouble(
  options: TransportDoubleOptions = {},
): PostMessageTransportDouble {
  const delivery = createDelivery({
    name: "postmessage",
    schedule: (task) => {
      setTimeout(task, 0);
    },
    options,
  });

  return {
    name: "postmessage",

    post: delivery.double.post,
    onFrame: delivery.double.onFrame,
    close: delivery.double.close,

    postMessage: delivery.double.post,
  };
}
