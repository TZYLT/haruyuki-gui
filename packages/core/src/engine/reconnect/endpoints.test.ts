/**
 * What this file proves: the comparison, in both directions.
 *
 * A same endpoint must not restart, and a changed one must. The second half is not
 * decoration: "restarts() === 0" alone passes for an implementation that never
 * restarts at all, so every "it did not happen" assertion here is paired with the
 * case where it must.
 */

import { describe, expect, it } from "vitest";

import { createEndpointWatcher } from "./endpoints";

function countingRestart() {
  const calls: number[] = [];
  return {
    calls,
    restart: async () => {
      calls.push(calls.length + 1);
    },
  };
}

const A = { url: "ws://127.0.0.1:1234", token: "token-a" };
const B = { url: "ws://127.0.0.1:5678", token: "token-b" };

describe("endpoint watcher", () => {
  it("does not restart on the first endpoint, because nothing is being replaced", async () => {
    const port = countingRestart();
    const watcher = createEndpointWatcher({ restart: port.restart });

    const restarted = await watcher.apply(A);

    expect(restarted).toBe(false);
    expect(port.calls).toHaveLength(0);
    expect(watcher.restarts()).toBe(0);
  });

  it("does not restart when the same endpoint comes back", async () => {
    const port = countingRestart();
    const watcher = createEndpointWatcher({ restart: port.restart });
    await watcher.apply(A);

    const restarted = await watcher.apply({ url: A.url, token: A.token });

    expect(restarted).toBe(false);
    expect(watcher.restarts()).toBe(0);
  });

  it("restarts once when the endpoint changed, then treats the new one as current", async () => {
    // The other half of the pair: without this, an implementation that never
    // restarts would satisfy the test above.
    const port = countingRestart();
    const watcher = createEndpointWatcher({ restart: port.restart });
    await watcher.apply(A);

    expect(await watcher.apply(B)).toBe(true);
    expect(watcher.restarts()).toBe(1);
    expect(watcher.current()).toEqual(B);

    // And the replacement is not repeated for the endpoint we just moved to.
    expect(await watcher.apply({ url: B.url, token: B.token })).toBe(false);
    expect(watcher.restarts()).toBe(1);
  });

  it("treats a changed token alone as a changed endpoint", async () => {
    // A stale token would be rejected on every connection, so "same url" is not
    // enough to call it the same endpoint.
    const port = countingRestart();
    const watcher = createEndpointWatcher({ restart: port.restart });
    await watcher.apply(A);

    expect(await watcher.apply({ url: A.url, token: "token-b" })).toBe(true);
    expect(port.calls).toHaveLength(1);
  });

  it("keeps the old endpoint current when the restart fails", async () => {
    const watcher = createEndpointWatcher({
      restart: async () => {
        throw new Error("no process");
      },
    });
    await watcher.apply(A);

    await expect(watcher.apply(B)).rejects.toThrow("no process");
    expect(watcher.current()).toEqual(A);
  });
});
