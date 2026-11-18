/**
 * The update check's five answers, exercised without a network.
 *
 * Every case injects a `fetch` double rather than reaching GitHub. That is not
 * tidiness: the real endpoint is rate limited per source address, so a suite that
 * called it would both flake and burn the quota it is testing the handling of.
 *
 * The doubles answer with real `Response` objects, because that is what the
 * client inspects -- a hand-rolled `{ok, status, json()}` would pass while the
 * actual property names drifted.
 *
 * The one case that is not about a canned answer is the import test: it proves
 * the module does nothing until it is called. That is the property a startup-time
 * query would break, and it cannot be observed from any single call.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ABOUT_INFO_CHANNEL,
  ABOUT_OPEN_CHANNEL,
  guardChannel,
  UPDATE_CHECK_CHANNEL,
  validateChannelName,
} from "../../shared/bridge.js";
import {
  checkForUpdate,
  registerUpdateIpc,
  type UpdateCheckResult,
  UPDATE_CHECKING,
  UPDATE_ENDPOINT,
  UPDATE_PAGE_URL,
} from "../update-check.js";

/** The version the doubles are compared against. */
const CURRENT = "0.1.0";

/** A `fetch` double that answers one canned response. */
function respondWith(response: Response): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;

  const fetchDouble = (() => {
    calls += 1;

    return Promise.resolve(response);
  }) as unknown as typeof fetch;

  return { fetch: fetchDouble, calls: () => calls };
}

/** A `fetch` double that never answers, so only the deadline can end the call. */
const neverAnswers = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

/** A `fetch` double that fails the way an unreachable host does. */
const unreachable = (() =>
  Promise.reject(new TypeError("getaddrinfo ENOTFOUND api.github.com"))) as unknown as typeof fetch;

/** A release body GitHub would send for a published tag. */
function releaseBody(tag: string): Response {
  return new Response(JSON.stringify({ tag_name: tag, name: tag }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Run one check against a canned transport. */
async function check(
  transport: typeof globalThis.fetch,
  current = CURRENT,
  timeoutMs?: number,
): Promise<UpdateCheckResult> {
  return checkForUpdate({
    current: () => current,
    fetch: transport,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("in progress", () => {
  it("exposes the checking value the renderer shows while the request is open", () => {
    // The fifth state, and the only one this module never returns: it names the
    // interval between the click and the answer, so both sides spell it once.
    expect(UPDATE_CHECKING).toEqual({ state: "checking" });
  });

  it("never resolves to checking, whatever the transport does", async () => {
    const answers = await Promise.all([
      check(respondWith(releaseBody("v0.2.0")).fetch),
      check(respondWith(releaseBody("v0.1.0")).fetch),
      check(respondWith(new Response("", { status: 403 })).fetch),
      check(unreachable),
      check(respondWith(new Response("", { status: 404 })).fetch),
    ]);

    expect(answers.map((result) => result.state)).toEqual([
      "available",
      "up-to-date",
      "failed",
      "failed",
      "failed",
    ]);
  });
});

describe("channels", () => {
  it("names a well-formed, allowed channel for each of the three additions", () => {
    for (const channel of [UPDATE_CHECK_CHANNEL, ABOUT_INFO_CHANNEL, ABOUT_OPEN_CHANNEL]) {
      expect(validateChannelName(channel).ok, channel).toBe(true);
      expect(guardChannel(channel), channel).toEqual({ ok: true, channel: "control" });
    }
  });

  it("keeps the three names distinct from the existing control channels", () => {
    expect(new Set([UPDATE_CHECK_CHANNEL, ABOUT_INFO_CHANNEL, ABOUT_OPEN_CHANNEL]).size).toBe(3);
    expect(UPDATE_CHECK_CHANNEL).toBe("bridge:control.update.check");
    expect(ABOUT_INFO_CHANNEL).toBe("bridge:control.about.info");
    expect(ABOUT_OPEN_CHANNEL).toBe("bridge:control.about.open");
  });
});

describe("newer release published", () => {
  it("reports the tag, the installed version and the fixed page", async () => {
    const result = await check(respondWith(releaseBody("v0.2.0")).fetch);

    expect(result).toEqual({
      state: "available",
      current: CURRENT,
      latest: "0.2.0",
      pageUrl: UPDATE_PAGE_URL,
    });
    expect(UPDATE_PAGE_URL).toBe("https://github.com/TZYLT/haruyuki-gui/releases/latest");
  });

  it("queries the release endpoint exactly once", async () => {
    const transport = respondWith(releaseBody("v0.2.0"));

    await check(transport.fetch);

    // No retry and no cache: one click is one request, whatever the answer.
    expect(transport.calls()).toBe(1);
  });

  it("treats a tag with or without the v prefix as the same release", async () => {
    const withPrefix = await check(respondWith(releaseBody("v0.1.0")).fetch);
    const withoutPrefix = await check(respondWith(releaseBody("0.1.0")).fetch);

    expect(withPrefix).toEqual({ state: "up-to-date", current: CURRENT });
    expect(withoutPrefix).toEqual({ state: "up-to-date", current: CURRENT });
  });
});

describe("already on the newest release", () => {
  it("says up to date and no more", async () => {
    const result = await check(respondWith(releaseBody("v0.1.0")).fetch);

    expect(result).toEqual({ state: "up-to-date", current: CURRENT });
  });
});

describe("quota exhausted", () => {
  it("reports rate-limit for a refused request", async () => {
    const result = await check(
      respondWith(new Response("API rate limit exceeded", { status: 403 })).fetch,
    );

    expect(result).toEqual({ state: "failed", reason: "rate-limit", detail: "HTTP 403" });
  });

  it("reports rate-limit for a proxy's 429 as well", async () => {
    const result = await check(respondWith(new Response("", { status: 429 })).fetch);

    expect(result).toMatchObject({ state: "failed", reason: "rate-limit" });
  });
});

describe("github unreachable", () => {
  it("reports network for a DNS or connection failure", async () => {
    const result = await check(unreachable);

    expect(result).toMatchObject({ state: "failed", reason: "network" });
    expect((result as { detail?: string }).detail).toContain("getaddrinfo");
  });

  it("reports network when the deadline expires", async () => {
    const result = await check(neverAnswers, CURRENT, 20);

    expect(result).toMatchObject({ state: "failed", reason: "network" });
  });

  it("reports network for a server error rather than inventing a conclusion", async () => {
    const result = await check(respondWith(new Response("", { status: 500 })).fetch);

    expect(result).toMatchObject({ state: "failed", reason: "network", detail: "HTTP 500" });
  });
});

describe("never published", () => {
  it("reports no-release for a repository without a latest release", async () => {
    const result = await check(respondWith(new Response("", { status: 404 })).fetch);

    expect(result).toEqual({ state: "failed", reason: "no-release", detail: "HTTP 404" });
  });

  it("reports no-release for a success with no tag in it", async () => {
    const result = await check(respondWith(new Response("{}", { status: 200 })).fetch);

    expect(result).toMatchObject({ state: "failed", reason: "no-release" });
  });

  it("reports network, not no-release, when something else answered", async () => {
    // A captive portal or a proxy error page answers `200` with HTML. Calling
    // that "never released" would be the merge this module exists to prevent.
    const result = await check(respondWith(new Response("<html>", { status: 200 })).fetch);

    expect(result).toMatchObject({ state: "failed", reason: "network" });
    expect((result as { detail?: string }).detail).toBe("response was not JSON");
  });
});

describe("the three non-answers stay distinct", () => {
  it("gives each unknown its own reason and never calls one of them up to date", async () => {
    const reasons = [
      await check(respondWith(new Response("", { status: 403 })).fetch),
      await check(unreachable),
      await check(respondWith(new Response("", { status: 404 })).fetch),
    ];

    for (const result of reasons) {
      expect(result.state).toBe("failed");
      expect(result).not.toHaveProperty("current");
    }

    const codes = reasons.map((result) => (result as { reason: string }).reason);

    expect(codes).toEqual(["rate-limit", "network", "no-release"]);
    expect(new Set(codes).size).toBe(3);
  });

  it("never rejects, whatever the transport does", async () => {
    const thrown = (() => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    await expect(check(thrown)).resolves.toMatchObject({ state: "failed" });
    await expect(check(neverAnswers, CURRENT, 10)).resolves.toMatchObject({ state: "failed" });
  });
});

describe("nothing happens until the check is called", () => {
  it("issues no request and schedules no timer when the module is imported", async () => {
    vi.resetModules();

    // A spy installed before the fresh import: any module-level request would land
    // here, which is exactly the failure a startup-time query would produce.
    const spy = vi.fn(() => Promise.reject(new Error("this test has no network")));
    const original = globalThis.fetch;

    globalThis.fetch = spy as unknown as typeof fetch;
    vi.useFakeTimers();

    try {
      await import("../update-check.js");

      expect(spy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      // The acceptance window, measured from a launch: no timer may fire a request
      // into it either.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reads the transport at call time, not at import time", async () => {
    const transport = respondWith(releaseBody("v0.2.0"));

    const result = await checkForUpdate({ current: () => CURRENT, fetch: transport.fetch });

    expect(result.state).toBe("available");
    expect(transport.calls()).toBe(1);
  });

  it("queries the documented endpoint", async () => {
    const seen: string[] = [];

    const recording = ((input: string | URL | Request) => {
      seen.push(String(input));

      return Promise.resolve(releaseBody("v0.2.0"));
    }) as unknown as typeof fetch;

    await check(recording);

    expect(seen).toEqual([UPDATE_ENDPOINT]);
    expect(UPDATE_ENDPOINT).toBe("https://api.github.com/repos/TZYLT/haruyuki-gui/releases/latest");
  });
});

describe("registration", () => {
  /** A minimal `ipcMain`: records handlers, so a second one is visible. */
  function createIpc() {
    const handlers = new Map<string, () => unknown>();
    const removed: string[] = [];

    return {
      removed,
      handle: (channel: string, listener: () => unknown): void => {
        expect(handlers.has(channel), `two handlers on ${channel}`).toBe(false);
        handlers.set(channel, listener as () => unknown);
      },
      removeHandler: (channel: string): void => {
        removed.push(channel);
        handlers.delete(channel);
      },
      call: (channel: string): Promise<UpdateCheckResult> =>
        Promise.resolve(handlers.get(channel)?.() as UpdateCheckResult),
      size: (): number => handlers.size,
    };
  }

  it("registers exactly the update channel", async () => {
    const ipc = createIpc();

    registerUpdateIpc({
      ipc,
      current: () => CURRENT,
      fetch: respondWith(releaseBody("v0.2.0")).fetch,
    });

    expect(ipc.size()).toBe(1);
    await expect(ipc.call(UPDATE_CHECK_CHANNEL)).resolves.toMatchObject({ state: "available" });
  });

  it("answers the frozen shape through the channel", async () => {
    const ipc = createIpc();

    registerUpdateIpc({
      ipc,
      current: () => CURRENT,
      fetch: respondWith(releaseBody("v0.1.0")).fetch,
    });

    await expect(ipc.call(UPDATE_CHECK_CHANNEL)).resolves.toEqual({
      state: "up-to-date",
      current: CURRENT,
    });
  });

  it("removes the handler once, and only once, on dispose", () => {
    const ipc = createIpc();
    const dispose = registerUpdateIpc({ ipc, current: () => CURRENT });

    expect(ipc.size()).toBe(1);

    dispose();
    dispose();

    expect(ipc.removed).toEqual([UPDATE_CHECK_CHANNEL]);
    expect(ipc.size()).toBe(0);
  });

  it("does not stack a second handler when called twice on one ipc", () => {
    const ipc = createIpc();

    const first = registerUpdateIpc({ ipc, current: () => CURRENT });
    const second = registerUpdateIpc({ ipc, current: () => CURRENT });

    // `ipcMain.handle` throws on a duplicate channel, so the second call must be
    // the no-op rather than the caller learning that from an exception.
    expect(ipc.size()).toBe(1);

    second();
    expect(ipc.removed).toEqual([]);
    expect(ipc.size()).toBe(1);

    first();
    expect(ipc.size()).toBe(0);
  });

  it("answers a failure instead of rejecting when the transport throws", async () => {
    const ipc = createIpc();

    registerUpdateIpc({ ipc, current: () => CURRENT, fetch: unreachable });

    await expect(ipc.call(UPDATE_CHECK_CHANNEL)).resolves.toMatchObject({ state: "failed" });
  });
});
