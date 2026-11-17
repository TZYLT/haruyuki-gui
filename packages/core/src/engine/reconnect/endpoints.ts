/**
 * Decides whether a new endpoint means a new process.
 *
 * A reconnect usually survives on its own: the socket reopens, the same engine
 * answers, and nothing needs replacing. But when the url or the token changes, the
 * process behind it is not the one we were talking to -- a restart is the only way
 * back, and it is expensive enough that doing it on every reconnect would be
 * worse than the problem it solves.
 *
 * So this compares, and only compares: it does not retry, does not time out, and
 * does not look at sockets. The restart port it calls owns those.
 *
 * The comparison is exact on both fields. A token that changed but a url that did
 * not is still a different endpoint -- the old connection would be rejected for
 * authentication, so treating it as "same" would produce a reconnect loop that
 * none of the other decisions could break.
 */

/** Where the engine listens, and what it wants to see on the connection. */
export interface Endpoint {
  readonly url: string;
  readonly token: string;
}

export interface EndpointWatcherOptions {
  /** Replaces the process. Called once per distinct endpoint change. */
  readonly restart: () => Promise<unknown>;
}

export interface EndpointWatcher {
  /**
   * Record the endpoint we are about to use.
   *
   * Resolves `true` when the process was replaced, `false` when the endpoint was
   * the same one already in use (including the first one ever seen).
   */
  apply(endpoint: Endpoint): Promise<boolean>;
  /** How many times the restart port has been asked to run. Zero is a valid answer. */
  restarts(): number;
  /** The endpoint currently considered in use. */
  current(): Endpoint | null;
}

const same = (left: Endpoint, right: Endpoint): boolean =>
  left.url === right.url && left.token === right.token;

export function createEndpointWatcher(options: EndpointWatcherOptions): EndpointWatcher {
  let current: Endpoint | null = null;
  let restarts = 0;
  let inflight: Promise<boolean> | null = null;

  async function apply(endpoint: Endpoint): Promise<boolean> {
    if (current !== null && same(current, endpoint)) return false;

    if (current === null) {
      // The first endpoint is not a change: there was nothing to replace, and
      // restarting here would replace a process nobody started.
      current = endpoint;
      return false;
    }

    if (inflight !== null) return inflight;

    inflight = (async () => {
      try {
        restarts += 1;
        await options.restart();
        current = endpoint;
        return true;
      } catch (error) {
        // The old endpoint stays current: a failed restart leaves the layer where
        // it was, which is the truth, and the next attempt compares against the
        // endpoint that actually produced a process.
        throw error;
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  }

  return {
    apply,
    restarts: () => restarts,
    current: () => current,
  };
}
