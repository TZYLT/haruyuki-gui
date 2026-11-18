/**
 * The update check: one question, five distinguishable answers.
 *
 * The whole module exists to keep three "I do not know" answers apart. "There is
 * no newer release", "GitHub refused the request" and "GitHub could not be
 * reached" look identical to a caller that only keeps a boolean, and telling a
 * user "you are up to date" because the network was down is the one failure this
 * feature cannot afford. So the result is a union whose every non-answer has its
 * own `reason`, and no branch here ever widens one into another.
 *
 * Two properties are deliberately absent, because both would burn the same quota
 * they exist to protect: nothing is cached, and nothing is retried. The quota is
 * counted per source address, so a retry is not "one more chance" -- it is a
 * faster way to run out.
 *
 * Nothing here runs until it is called. There is no module-level fetch and no
 * timer: a shell that queried on startup would make every launch pay for a check
 * nobody asked for, and the check is only meaningful when a window is open to
 * show it. `fetch` is injected so the whole table of outcomes is exercisable
 * without a network, and so a test can prove the import issued no request.
 */

import { UPDATE_CHECK_CHANNEL } from "../shared/bridge.js";
import type { Logger } from "./log.js";

/** Where the "open the download page" button sends the user. Fixed by the contract. */
export const UPDATE_PAGE_URL = "https://github.com/TZYLT/haruyuki-gui/releases/latest" as const;

/** The release endpoint. `/latest` answers 404 while the repository has no release. */
export const UPDATE_ENDPOINT = "https://api.github.com/repos/TZYLT/haruyuki-gui/releases/latest";

/**
 * How long one check may take.
 *
 * A spinner that never resolves is worse than a failure: the user cannot tell it
 * from a hung window. Eight seconds covers a slow-but-working connection, and
 * anything slower is reported as `network`.
 */
export const UPDATE_TIMEOUT_MS = 8_000;

/** The three "no conclusion" reasons. Kept apart on purpose; see the module comment. */
export type UpdateCheckFailureReason = "rate-limit" | "network" | "no-release";

/**
 * What the update check answers.
 *
 * `checking` is not produced here -- this function resolves once. It is part of
 * the frozen shape because the renderer needs a name for the interval between
 * the click and the answer, and declaring it in one place keeps the renderer
 * from inventing a second spelling.
 */
export type UpdateCheckResult =
  | { readonly state: "checking" }
  | {
      readonly state: "available";
      readonly current: string;
      readonly latest: string;
      readonly pageUrl: string;
    }
  | { readonly state: "up-to-date"; readonly current: string }
  | {
      readonly state: "failed";
      readonly reason: UpdateCheckFailureReason;
      readonly detail?: string;
    };

/** The in-progress value the renderer shows while the check is on the wire. */
export const UPDATE_CHECKING: UpdateCheckResult = { state: "checking" };

/** Everything one check needs; all of it injectable so no test opens a socket. */
export interface UpdateCheckDeps {
  /** The installed version, read at call time rather than at import time. */
  readonly current: () => string;
  /** `fetch`, or a double that records the call and answers a canned response. */
  readonly fetch?: typeof fetch;
  /** Budget override for tests; production never passes it. */
  readonly timeoutMs?: number;
}

/**
 * Strip the decoration a release tag may carry, so `v0.2.0` and `0.2.0` are the
 * same release rather than an update the user is offered twice.
 *
 * @param version a version as the app or a tag spells it
 */
function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/**
 * Turn a failed request into the reason the caller can act on.
 *
 * The mapping is the contract, not a guess: GitHub answers `403` for an exhausted
 * quota, `404` for a repository with no `latest` release, and everything else
 * means we did not get an answer from GitHub at all.
 *
 * @param status the HTTP status, or `null` when no response arrived
 * @param detail any transport-level message
 */
function failureFor(
  status: number | null,
  detail: string | undefined,
): Extract<UpdateCheckResult, { state: "failed" }> {
  if (status === 403 || status === 429) {
    // 429 is not what GitHub documents, but a proxy in front of it may answer it,
    // and both mean the same thing to the user: the quota is the problem.
    return detail === undefined
      ? { state: "failed", reason: "rate-limit" }
      : { state: "failed", reason: "rate-limit", detail };
  }

  if (status === 404) {
    return detail === undefined
      ? { state: "failed", reason: "no-release" }
      : { state: "failed", reason: "no-release", detail };
  }

  return detail === undefined
    ? { state: "failed", reason: "network" }
    : { state: "failed", reason: "network", detail };
}

/**
 * Read a response body as JSON.
 *
 * `null` means the body was not JSON at all, which is a different fact from an
 * empty JSON object: the first is something other than the GitHub API answering
 * (a captive portal, a proxy's error page) and belongs to `network`, while an
 * object with no `tag_name` is genuinely "this repository has no release".
 */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return null;
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;

  return body as Record<string, unknown>;
}

/** Keep a transport message on one ASCII line; it is shown, not translated. */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  // The detail is rendered inside a single line of UI copy, and a DNS failure's
  // message can carry a newline or a non-ASCII hostname.
  const ascii = raw
    .replace(/[^\x20-\x7E]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return ascii === "" ? "unknown error" : ascii;
}

/**
 * Ask GitHub whether a newer release exists.
 *
 * Never throws and never caches: every call is one request with one deadline.
 *
 * @param deps the installed version, the transport and (in tests) the budget
 */
export async function checkForUpdate(deps: UpdateCheckDeps): Promise<UpdateCheckResult> {
  const current = deps.current();
  const timeoutMs = deps.timeoutMs ?? UPDATE_TIMEOUT_MS;
  const request = deps.fetch ?? globalThis.fetch;

  // One timer does both jobs: it closes the socket through the signal and it
  // settles this promise even against a transport that ignores the signal. Two
  // clocks (a signal-only timeout plus a `Promise.race` deadline) would leave a
  // timer alive after a fast answer and could not be cleared.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no response within ${timeoutMs} ms`));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      request(UPDATE_ENDPOINT, {
        method: "GET",
        signal: controller.signal,
        headers: { accept: "application/vnd.github+json" },
      }),
      deadline,
    ]);

    if (!response.ok) return failureFor(response.status, `HTTP ${response.status}`);

    const body = await readJson(response);

    // Not JSON at all: something answered, but it was not the releases API. That
    // is `network`, not `no-release` -- a captive portal must never be shown as
    // "this software has never been released".
    if (body === null) {
      return { state: "failed", reason: "network", detail: "response was not JSON" };
    }

    // A `200` with no tag is the same fact as a `404`: nothing has ever been
    // published. Keeping it as `no-release` rather than "up to date" is the
    // whole point of the reason set.
    const tag = typeof body["tag_name"] === "string" ? body["tag_name"] : "";

    if (tag.trim() === "") {
      return { state: "failed", reason: "no-release", detail: "release has no tag" };
    }

    if (normalizeVersion(tag) === normalizeVersion(current)) {
      return { state: "up-to-date", current };
    }

    return { state: "available", current, latest: normalizeVersion(tag), pageUrl: UPDATE_PAGE_URL };
  } catch (error) {
    // A `403` can also be thrown as a non-ok response by a double; the status is
    // in the response, so only genuine transport failures land here.
    return failureFor(null, describe(error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The part of `ipcMain` the registrar uses; fakeable, so tests need no Electron. */
export interface UpdateIpcMain {
  handle(channel: string, listener: () => Promise<unknown> | unknown): void;
  removeHandler?(channel: string): void;
}

/** What `registerUpdateIpc` needs from the composition root. */
export interface UpdateIpcDeps {
  readonly ipc: UpdateIpcMain;
  /** The installed version at the moment of the click. */
  readonly current: () => string;
  readonly logger?: Logger;
  /** Transport override for tests; production leaves it out. */
  readonly fetch?: typeof fetch;
}

/** One `ipcMain` per process in production; the set makes re-entry a no-op. */
const registered = new WeakSet<object>();

/**
 * Register the one channel the about window's button calls.
 *
 * Registration is guarded per `ipc`: `ipcMain.handle` throws on a second handler
 * for one channel, and a reload or a second composition call is a normal thing
 * to happen. A second call therefore returns a disposer that removes nothing --
 * the first call owns the handler. The disposer itself is idempotent for the
 * other half of the same reason: a window teardown may run cleanup twice.
 *
 * @param deps the IPC surface, the version source and the transport
 * @returns a disposer that removes the handler, at most once
 */
export function registerUpdateIpc(deps: UpdateIpcDeps): () => void {
  const { ipc, logger } = deps;

  if (registered.has(ipc as object)) return () => undefined;

  registered.add(ipc as object);

  ipc.handle(UPDATE_CHECK_CHANNEL, async () => {
    const result = await checkForUpdate({
      current: deps.current,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });

    // The log line is the only place the three reasons stay distinguishable
    // after the renderer has turned them into sentences. `checking` is never
    // returned by the check itself, so there is nothing to log for it.
    if (result.state === "failed") {
      logger?.warn("update.check.failed", { reason: result.reason, detail: result.detail });
    } else if (result.state === "available") {
      logger?.info("update.check.available", { current: result.current, latest: result.latest });
    } else if (result.state === "up-to-date") {
      logger?.info("update.check.up-to-date", { current: result.current });
    }

    return result;
  });

  let disposed = false;

  return () => {
    if (disposed) return;

    disposed = true;
    ipc.removeHandler?.(UPDATE_CHECK_CHANNEL);
  };
}
