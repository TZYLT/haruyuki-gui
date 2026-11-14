/**
 * Degradation checks for the engine facade.
 *
 * The checks below cover the facade's observable surface, the watchdog
 * 3.4 (the watchdog self-check) and 7 (R-3/R-5). The `EngineDegradation` type
 * itself lives in `./types`.
 *
 * Why this is its own module: the facade has to *report* four things it cannot
 * fix - an untested engine build, an untested wire protocol, a token file whose
 * exact ACL did not apply, and a watchdog that never proved it was loaded - and
 * all four are pure functions over data the facade already holds. Keeping them
 * out of `engine.ts` keeps the state machine readable and keeps the version /
 * marker rules in one place, testable without spawning anything.
 *
 * None of these is a failure. docs/13 V-7, B1-Q09 and Q49 decide that an
 * untested combination still connects; R-5 decides that a degraded ACL keeps the
 * engine usable; R-3 decides that a missing watchdog falls back to parent-side
 * cleanup. What the host must not do is lose the fact silently.
 */

import type { AppServerInfo, EngineDegradation, EngineSpawnSpec } from "./types";
import type { TokenFile } from "./token";

/**
 * Wire protocol revision this build was tested against.
 *
 * The engine has answered `protocol_version: 1` since 0.6.0 (docs/01-2 section
 * 3.2, docs/13 section 1.2). A different value is not a veto - docs/13 B1-Q09
 * and Q49 require "warn, then connect anyway" - so this constant only feeds the
 * `protocol-version` degradation.
 */
export const EXPECTED_PROTOCOL_VERSION = 1;

/** Marker the injected watchdog prints on stderr at startup. */
export const WATCHDOG_MARKER = "WATCHDOG_OK=";

/**
 * How long to wait for that marker once the WebSocket URL is known.
 *
 * The watchdog is preloaded before any engine code runs, so the marker is
 * written before the engine listens; the wait only costs time in the degraded
 * case where the marker never comes.
 */
export const WATCHDOG_MARKER_GRACE_MS = 250;

/**
 * True when the spawn spec preloads the watchdog, so a marker is expected.
 *
 * The headless host port composes `NODE_OPTIONS=--require "<abs>/watchdog.cjs"`
 * A spec without it is a caller that deliberately runs without orphan
 * without orphan protection, and must not be reported as degraded.
 */
export function expectsWatchdog(spec: EngineSpawnSpec): boolean {
  return spec.env.NODE_OPTIONS?.includes("watchdog.cjs") === true;
}

/**
 * Turn a degraded token-file ACL into a reportable entry.
 *
 * `writeTokenFile` degrades rather than throwing (R-5), which is right - a usable
 * engine beats no engine - but it also means the file may keep the directory's
 * inherited permissions, and on Windows that can be "Everyone can read". The
 * facade cannot fix that, so it must not lose it either.
 */
export function tokenAclDegradation(tokenFile: TokenFile): EngineDegradation | null {
  if (tokenFile.acl !== "degraded") {
    return null;
  }

  return {
    kind: "token-acl",
    detail:
      "the engine token file keeps the directory's inherited permissions instead of an " +
      `owner-only ACL: ${tokenFile.reason ?? "the platform command reported no reason"}`,
  };
}

/**
 * Record an untested engine build or wire protocol.
 *
 * Neither is a failure: docs/13 B1-Q09 and Q49 decide that an untested
 * combination still connects, and V-7 states the same for an external server.
 * `PROTOCOL_MISMATCH` stays reserved for "the handshake never matched", which is
 * what the classification table in no recursive section 3.3 (f) assigns to it.
 *
 * Order is stable (protocol first, then build) so a log line is diffable.
 */
export function versionDegradations(
  info: AppServerInfo,
  expected: string | undefined,
): EngineDegradation[] {
  const found: EngineDegradation[] = [];

  if (info.protocolVersion !== EXPECTED_PROTOCOL_VERSION) {
    found.push({
      kind: "protocol-version",
      detail:
        `the engine reports protocol ${info.protocolVersion} but this build was tested ` +
        `against ${EXPECTED_PROTOCOL_VERSION}; combination not tested`,
    });
  }

  if (expected !== undefined && expected !== info.engineVersion) {
    found.push({
      kind: "engine-version",
      detail: `expected engine ${expected}, got ${info.engineVersion}; combination not tested`,
    });
  }

  return found;
}

/**
 * The watchdog never proved it was loaded.
 *
 * R-3: orphan protection then falls back to the parent process, which only covers
 * a parent that is still alive to run its own cleanup.
 */
export function watchdogDegradation(): EngineDegradation {
  return {
    kind: "watchdog",
    detail:
      "the injected watchdog never printed its WATCHDOG_OK marker, so orphan protection " +
      "falls back to the parent process",
  };
}

/**
 * Wait for one marker line on a stream that may or may not produce it.
 *
 * The observable is a single boolean ("did the marker ever arrive"), so the wait
 * has to be shared: stderr chunks are delivered by the child's pipe on its own
 * schedule, and the start path may reach the check point before the chunk is
 * dispatched. `wait` therefore resolves either when the marker arrives or when
 * the grace expires, and never rejects.
 */
export class MarkerWatch {
  private readonly marker: string;

  private seen = false;

  private readonly waiters: Array<() => void> = [];

  constructor(marker: string) {
    this.marker = marker;
  }

  /** True once a chunk containing the marker has been observed. */
  get found(): boolean {
    return this.seen;
  }

  /** Feed one stderr chunk; wakes every waiter on the first match. */
  observe(chunk: string): void {
    if (this.seen || !chunk.includes(this.marker)) {
      return;
    }

    this.seen = true;

    for (const wake of this.waiters.splice(0)) {
      wake();
    }
  }

  /**
   * Resolve `true` when the marker arrives within `timeoutMs`, `false` on expiry.
   *
   * The timer is cleared by the woken branch, so a marker that arrives first
   * leaves no pending timer behind.
   */
  wait(timeoutMs: number): Promise<boolean> {
    if (this.seen) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (found: boolean): void => {
        clearTimeout(timer);
        resolve(found);
      };

      timer = setTimeout(() => {
        settle(false);
      }, timeoutMs);

      this.waiters.push(() => {
        settle(true);
      });
    });
  }
}
