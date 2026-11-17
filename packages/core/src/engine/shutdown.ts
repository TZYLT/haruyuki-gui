/**
 * Teardown of one hosted engine attempt: the graceful stop and the failure
 * cleanup.
 *
 * Split out of `engine.ts` (E-142). Both paths do the same four things in a
 * different order, and getting the order wrong is the difference between a clean
 * stop and an orphan or a frame arriving during teardown — so they live together
 * where the order is visible in one place.
 *
 * Invariants (B1 `no recursive` sections 3.3 (c)/(e), 4.2):
 *
 * - **The socket goes first** on the failure path, so no frame can arrive during
 *   teardown. The graceful path closes it politely before the child stops, so no
 *   dangling TCP handle keeps the host process alive.
 * - **Child subscriptions are released before the child is stopped**, so a stop
 *   cannot be mistaken for a crash.
 * - **The token file is deleted last on the graceful path and before the child
 *   stops on the failure path**: a crash restart must still be able to read it
 *   (`B1-Q06`), and a failed attempt must not leave it behind.
 * - Both entry points are shared and idempotent: a callback cannot await, so
 *   `declareFailure` fires the cleanup and a later `stopGraceful` joins it.
 */

import { stopGraceful as stopChildGracefully } from "./spawn";
import type { ChildWatch } from "./child-watch";
import type { SocketSession } from "./socket-session";
import type { TokenLifecycle } from "./token-lifecycle";
import type { EngineState } from "./types";

/** The collaborators and the one facade capability teardown needs. */
export interface TeardownParts {
  /** Write the state first, then notify; the facade owns the machine. */
  transition(next: EngineState): void;
  /** The facade must forget the endpoint it advertised once the socket is gone. */
  onSocketReleased(): void;
  readonly session: SocketSession;
  readonly tokens: TokenLifecycle;
  readonly children: ChildWatch;
}

export class Teardown {
  readonly #parts: TeardownParts;

  /** The socket host is stable; `release` is called with it every time. */
  readonly #socketHost: { released(): void };

  #stopInFlight: Promise<void> | null = null;

  #cleanupInFlight: Promise<void> | null = null;

  constructor(parts: TeardownParts) {
    this.#parts = parts;
    this.#socketHost = { released: () => parts.onSocketReleased() };
  }

  /** A new attempt owns its own in-flight bookkeeping. */
  reset(): void {
    this.#stopInFlight = null;
    this.#cleanupInFlight = null;
  }

  get stopInFlight(): Promise<void> | null {
    return this.#stopInFlight;
  }

  set stopInFlight(stopping: Promise<void> | null) {
    this.#stopInFlight = stopping;
  }

  /** One graceful stop; the caller owns the in-flight bookkeeping. */
  async stopOnce(budgetMs: number): Promise<void> {
    const { transition, session, children, tokens } = this.#parts;

    transition("closing");
    // Polite close, then the child is stopped; once the server is gone the socket
    // closes for real, so no dangling TCP handle keeps the host process alive.
    session.release(false, this.#socketHost);

    const child = children.takeChild();
    children.releaseSubscriptions();

    if (child !== null) {
      await stopChildGracefully(child, budgetMs);
      children.recordExit(child);
    }

    await tokens.ensureRemoved();
    transition("closed");
  }

  /**
   * Shared failure cleanup: socket, then token file, then the child.
   *
   * Started from a callback that cannot await (`declareFailure`) and joined by
   * any later `stopGraceful`.
   */
  ensureCleanup(): Promise<void> {
    if (this.#cleanupInFlight === null) {
      this.#cleanupInFlight = this.#runCleanup();
    }

    return this.#cleanupInFlight;
  }

  /** Order matters: the socket first, so no frame can arrive during teardown. */
  async #runCleanup(): Promise<void> {
    const { session, tokens, children } = this.#parts;

    session.release(true, this.#socketHost);
    await tokens.ensureRemoved();

    const child = children.takeChild();
    children.releaseSubscriptions();

    if (child !== null) {
      await stopChildGracefully(child);
      children.recordExit(child);
    }
  }
}
