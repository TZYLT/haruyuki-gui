/**
 * Token-file lifecycle of one hosted engine attempt.
 *
 * Split out of `engine.ts` (E-142): write, note the ACL, delete once. This is a
 * complete contract by itself and touches nothing else in the facade.
 *
 * Invariants (B1 `no recursive` section 3.3 (c), `R-5`, `B1-Q06`):
 *
 * - The token CONTENT never leaves this module's file; the facade only ever
 *   passes the PATH to the child.
 * - A degraded ACL is recorded, never thrown: a usable engine beats no engine,
 *   but the facade must not lose the fact either.
 * - Deletion is shared and idempotent. `kill()` starts it without awaiting (the
 *   emergency path must not block), and a later stop still observes completion.
 * - The file is deleted only after the child is gone. Deleting it earlier would
 *   make a crash restart unable to read it (`B1-Q06`).
 */

import { tokenAclDegradation } from "./degradations";
import { EngineStartError, messageOf } from "./start-internals";
import { removeTokenFile, writeTokenFile } from "./token";
import type { TokenFile } from "./token";
import type { EngineDegradation } from "./types";

/** What the facade owns while this module owns the file. */
export interface TokenLifecycleHost {
  /** Record a degradation; the facade owns the list's lifetime. */
  note(degradation: EngineDegradation): void;
}

export class TokenLifecycle {
  #path: string | null = null;

  #removal: Promise<void> | null = null;

  /** A new attempt owns a new file; forget the previous one's handle. */
  reset(): void {
    this.#path = null;
    this.#removal = null;
  }

  /** Write the token file; a write failure is a pre-spawn failure. */
  async write(dir: string, token: string): Promise<TokenFile> {
    try {
      const file = await writeTokenFile(dir, token);
      this.#path = file.path;
      return file;
    } catch (error) {
      throw new EngineStartError(
        "SPAWN_FAILED",
        `could not write the engine token file in ${dir}: ${messageOf(error)}`,
      );
    }
  }

  /**
   * Record a degraded token-file ACL instead of dropping it.
   *
   * `writeTokenFile` degrades rather than throwing (R-5), which is right - a
   * usable engine beats no engine - but it also means the file may keep the
   * directory's inherited permissions, and on Windows that can be "Everyone can
   * read". The facade cannot fix that, so it must not lose it either.
   */
  noteAcl(file: TokenFile, host: TokenLifecycleHost): void {
    const degraded = tokenAclDegradation(file);

    if (degraded !== null) {
      host.note(degraded);
    }
  }

  /**
   * Delete the token file once per attempt and share the promise, so `kill()`
   * can start the unlink without awaiting it and a later `stopGraceful` still
   * observes its completion.
   */
  ensureRemoved(): Promise<void> {
    if (this.#removal === null) {
      this.#removal = this.#removeOnce();
    }

    return this.#removal;
  }

  /** Single-point unlink of the token file; never throws. */
  async #removeOnce(): Promise<void> {
    const path = this.#path;
    this.#path = null;

    if (path === null) {
      return;
    }

    try {
      await removeTokenFile(path);
    } catch {
      // Best effort: a locked or already-removed file must not turn a stop into
      // a rejection, and the caller has no recovery action to take.
    }
  }
}
