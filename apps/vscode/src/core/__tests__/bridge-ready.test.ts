/**
 * The announcement a panel makes, and what both processes do with it.
 *
 * The panel sends `ready` after every `boot`. Until this file existed, nothing
 * on the host side read it: the command path answers `ignored` for families it
 * does not own, and the message names no action, so the one message that says "a
 * panel is here" was dropped by both readers. The core's half -- the version
 * comparison and the verdict -- was equally absent.
 *
 * These cases pin both ends separately, because they fail for different reasons
 * and a single end-to-end case would say only "nothing happened".
 */

import { describe, expect, it } from "vitest";

import { narrowHostToCore } from "../../core/ipc.js";

describe("the panel's announcement", () => {
  it("survives the narrowing that every host message passes through", () => {
    // The message the panel posts is `ready`, which is not a host-to-core kind.
    // The host translates it; a translation that no longer narrows would make
    // the announcement a log line about an unusable message instead.
    const narrowed = narrowHostToCore({
      kind: "bridge.ready",
      appVersion: "0.1.0",
      bridgeVersion: "1",
    });

    expect(narrowed).toEqual({
      ok: true,
      message: { kind: "bridge.ready", appVersion: "0.1.0", bridgeVersion: "1" },
    });
  });

  it("refuses an announcement that carries no versions", () => {
    // A panel that announces nothing has nothing to compare, and a silently
    // accepted empty announcement would read as "the versions match".
    expect(narrowHostToCore({ kind: "bridge.ready", appVersion: "0.1.0" }).ok).toBe(false);
    expect(narrowHostToCore({ kind: "bridge.ready", bridgeVersion: "1" }).ok).toBe(false);
    expect(narrowHostToCore({ kind: "bridge.ready", appVersion: "", bridgeVersion: "1" }).ok).toBe(
      false,
    );
  });
});
