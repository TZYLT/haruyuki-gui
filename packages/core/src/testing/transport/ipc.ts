/**
 * ipc.ts - the Electron-shaped transport double.
 *
 * Scope: model the platform API shape and do not add a seam of its own, on the
 * `TransportDouble` interface in `./delivery`, with the async granularity the
 * two doubles must not share.
 *
 * Shape only. This module does not import `electron`, does not touch a
 * `webContents` and runs in a plain `node` process: the platform object is
 * modelled as data.
 *
 * What is modelled from the real shell:
 *
 * - `send(channel, payload)` is `ipcRenderer.send` / `webContents.send`: the
 *   platform channel is a routing label, the payload is the frame. The channel
 *   string is checked for being non-empty and is otherwise not interpreted -
 *   the frozen `Observation` shape has no field for it, and inventing routing
 *   semantics here would make the double a second seam.
 * - Delivery is one `queueMicrotask` hop, the finest granularity a plain Node
 *   process offers. It is deliberately not the same as the `postMessage`
 *   double's `setTimeout(0)`: a harness that sees
 *   only one granularity cannot tell a real cross-channel ordering race from an
 *   artefact of the double.
 * - `post`, `onFrame` and `close` are the frozen members, unchanged.
 */

import type { BridgeFrame } from "../fixture";

import type { TransportDouble, TransportDoubleOptions } from "./delivery";
import { createDelivery } from "./delivery";

/**
 * The IPC double: the frozen `TransportDouble` plus the platform send shape.
 *
 * `send` is the same frame path as `post`; it exists so a shell adapter can be
 * driven the way it drives `ipcRenderer` instead of being taught a test-only
 * method name.
 */
export interface IpcTransportDouble extends TransportDouble {
  readonly name: "ipc";
  send(channel: string, payload: BridgeFrame): void;
}

/**
 * Create the `ipc`-shaped double.
 *
 * @param options `onReject` is called synchronously for every frame that is not
 * delivered; see {@link TransportDoubleOptions}.
 */
export function createIpcDouble(options: TransportDoubleOptions = {}): IpcTransportDouble {
  const delivery = createDelivery({ name: "ipc", schedule: queueMicrotask, options });

  return {
    name: "ipc",

    post: delivery.double.post,
    onFrame: delivery.double.onFrame,
    close: delivery.double.close,

    send(channel, payload) {
      if (typeof channel !== "string" || channel.length === 0) {
        delivery.reject(payload, "ipc channel must be a non-empty string");
        return;
      }

      delivery.double.post(payload);
    },
  };
}
