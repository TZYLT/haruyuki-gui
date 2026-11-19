/**
 * The rung an engine was found on, as the status bar reports it.
 *
 * The host resolves it and shows it, but the snapshots the child emits carry a
 * `source` of their own, and those arrive later and win. The tooltip therefore
 * said `external` for every engine, which is the coarse kind rather than the
 * rung -- the half of the tooltip a bug report needs to say where to look.
 */

import { describe, expect, it } from "vitest";

import { narrowHostToCore } from "../../core/ipc.js";

const INIT = {
  kind: "init",
  paths: { userData: "/u", logs: "/l", cache: "/c", temp: "/t" },
  cwd: "/work",
  locale: "en",
  engine: { kind: "external", dir: "/e", bundlePath: "/e/bundle.mjs" },
  expectedVersion: "1.0.0",
  capabilities: {
    canNotify: false,
    canPopout: false,
    canFloat: false,
    canOpenExternal: false,
    canPickFiles: false,
    canReadDroppedFiles: false,
  },
};

describe("the engine's origin", () => {
  it("travels to the child that reports the status", () => {
    const narrowed = narrowHostToCore({ ...INIT, engineOrigin: "picked" });

    expect(narrowed.ok && narrowed.message.kind === "init" && narrowed.message.engineOrigin).toBe(
      "picked",
    );
  });

  it("is left out when the host did not resolve one", () => {
    // The coarse kind is a truthful fallback, so an absent rung is not an
    // error -- but it must not be invented either.
    const narrowed = narrowHostToCore(INIT);

    expect(narrowed.ok && "engineOrigin" in narrowed.message).toBe(false);
  });

  it("refuses a rung that is not a name", () => {
    expect(narrowHostToCore({ ...INIT, engineOrigin: 7 }).ok).toBe(false);
  });
});
