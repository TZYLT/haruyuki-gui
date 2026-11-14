/**
 * Host port: what the shell (Electron main, or the headless test runner) must
 * provide to the engine host, and nothing more.
 *
 * Shape source: no recursive-B1 section 3.3(a), the `HostPortStartup` startup subset. This file is
 * types only on purpose - the Electron implementation and the headless
 * implementation both live elsewhere (the headless one in `send.ts`), so the contract
 * stays implementable in a plain `node` process and therefore testable without a
 * desktop shell.
 *
 * The shapes are spelled inline to mirror the frozen contract literally: the
 * shared contract test  reads this interface as the definition of `HostPortStartup`, and
 * a one-to-one match keeps that comparison mechanical.
 */

import type { EngineSpawnSpec } from "../engine/types";

export interface HostPortStartup {
  /**
   * What the hosting shell can actually do. The core must degrade instead of
   * assuming a capability: a headless host answers `false` to all four.
   *
   * `canNotify` - the shell can raise an OS-level notification.
   * `canReadDroppedFiles` - a file dropped on the window exposes a readable path.
   * `canPopout` - a panel can be popped out into its own window.
   * `canFloatingWindow` - the shell supports a floating/pinned window.
   */
  capabilities: {
    canNotify: boolean;
    canReadDroppedFiles: boolean;
    canPopout: boolean;
    canFloatingWindow: boolean;
  };

  /**
   * Per-host directory roots. The core never hardcodes an `app.getPath` result:
   * `userData` holds engine settings and state, `logs` is where the host expects
   * engine log files, `cache` is disposable, and `temp` is where short-lived
   * isolates (token files, scratch state) must be created.
   */
  paths: {
    userData: string;
    logs: string;
    cache: string;
    temp: string;
  };

  /**
   * Resolve the concrete spawn instruction for this host, at call time.
   *
   * Asynchronous because a real host may need to unpack or locate the engine
   * bundle first. A refusal is expressed as `{ ok: false }` with a human-readable
   * `reason` rather than a thrown error, so the caller can classify it as
   * SPAWN_FAILED without unwrapping an exception, and the reason can be shown to
   * the user verbatim.
   */
  getRuntimeSpawnSpec(): Promise<
    { ok: true; spec: EngineSpawnSpec } | { ok: false; reason: string }
  >;
}
