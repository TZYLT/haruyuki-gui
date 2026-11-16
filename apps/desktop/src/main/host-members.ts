/**
 * Five of the six remaining `HostPort` members, implemented against Electron.
 *
 * `host-port.ts` holds the three startup members (`capabilities`, `paths`,
 * `getRuntimeSpawnSpec`) because they are read before anything else can run. This
 * file holds the ones that touch the operating system: notifications, the browser,
 * the file dialog, the resource URL, shutdown and dropped files. That grouping is
 * not cosmetic -- these are the members whose failure mode is always "the OS said
 * no", and putting them together makes the shared shape visible.
 *
 * The sixth (`secure*`) is the one member that needs a store, and it lives in
 * `secrets.ts` because it has its own state machine: a keyring that may be absent,
 * a decision that may be made once or permanently, and a plaintext mode that must
 * never be entered silently. Rather than making this file's type technically
 * complete by stubbing three members that always throw, the return type names only
 * what is actually built here; assembling the full port is `main.ts`'s job and the
 * compiler then cannot be fooled into thinking a stub is an implementation.
 *
 * Every member follows the contract's three rules (see `host-port.ts` for why they
 * exist): asynchronous even when the answer is known, failures as values with a
 * frozen code, and a resolved success never implying that something happened.
 *
 * Everything Electron-specific is injected. `apps/desktop` unit tests run under
 * plain Node, where importing `electron` yields `undefined` and `app.getPath()`
 * throws, so a module that reached for the real thing would be untestable -- and
 * the failure paths are exactly where this item's risk lives.
 */

import path from "node:path";

import type { HostPort } from "@haruyuki/core";

import { mediaUrlFor } from "./media-protocol.js";

/** The schemes `openExternal` accepts. A boundary, not a preference. */
export const OPEN_EXTERNAL_SCHEMES = ["http:", "https:"] as const;

/** The members this file builds. The rest come from `host-port.ts` and `secrets.ts`. */
export type DesktopMembers = Pick<
  HostPort,
  | "openExternal"
  | "pickPaths"
  | "resolveLocalResource"
  | "onShutdown"
  | "notify"
  | "readDroppedFiles"
>;

/**
 * What these members need from the shell.
 *
 * A narrow, hand-written interface rather than the `electron` module's types: a test
 * can satisfy it in three lines, and the real implementation can change across
 * Electron majors without breaking a test that never cared about the difference.
 */
export interface DesktopMembersDeps {
  /** Raise a system notification. */
  showNotification(title: string, body: string): void;
  /** Hand a URL to the operating system. */
  openExternal(url: string): Promise<void>;
  /**
   * Open a file picker.
   *
   * `cancelled` is separate from an empty `paths` because the two mean different
   * things: "the user dismissed the dialog" versus "the dialog reported success and
   * nothing was selected". Collapsing them would hide a broken picker.
   */
  showOpenDialog(options: {
    kind: "file" | "directory";
    multiple: boolean;
  }): Promise<{ cancelled: boolean; paths: string[] }>;
  /** Whether this build can raise OS-level notifications at all. */
  canNotify(): boolean;
  /** The paths currently authorised for local resource display. */
  readableRoots(): readonly string[];
  /** Whether the user has switched the position check off. */
  trustAllPaths(): boolean;
  /** Report a refusal so it reaches the log with a code. */
  readonly onFailure?: (error: { code: string; detail: string; messageKey: string }) => void;
}

/** What this file returns: the six members plus the shutdown trigger. */
export interface DesktopMembersResult {
  readonly members: DesktopMembers;
  /** Run the registered shutdown callbacks, once. */
  runShutdown(): Promise<void>;
}

/**
 * Whether a URL may be handed to the operating system.
 *
 * `http:` and `https:` only. A scheme allow-list is a security boundary rather than
 * a preference: `file:` would let a compromised renderer read local files by
 * handing them to an external application, and `javascript:` executes inside the
 * system browser's context. `mailto:` is deliberately absent -- it is not a browser
 * URL, and the frozen requirement rejects it with everything else.
 *
 * Parsed rather than prefix-matched. `http:evil.com` passes a `startsWith("http:")`
 * test and has no host, and a control character before the scheme passes it too; a
 * real `URL` parse refuses both.
 *
 * @param url anything that claims to be a URL
 */
export function isOpenableUrl(url: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // An empty host means there is nothing to open, whatever the scheme says.
  if (parsed.hostname === "") return false;

  return (OPEN_EXTERNAL_SCHEMES as readonly string[]).includes(parsed.protocol);
}

/**
 * Build the six members.
 *
 * @param deps the injected shell
 * @param onShutdownCallbacks the registry to append to. Passed in rather than
 *   created here so that one process has one list: two ports each holding a private
 *   list would run only half the cleanup.
 */
export function createDesktopMembers(
  deps: DesktopMembersDeps,
  onShutdownCallbacks: (() => void)[] = [],
): DesktopMembersResult {
  // Asked once, at construction. `canNotify` is a property of this build rather than
  // of this call, and asking per notification would let two paths answer differently.
  const notifyAvailable = deps.canNotify();

  // Idempotent because the quit path can arrive twice: `before-quit` fires, and a
  // `window-all-closed` handler may also call `app.quit()`. Running cleanup twice is
  // not harmless -- a token file deleted twice is fine, but an engine told to stop
  // twice is a race.
  let shutdownRan = false;

  const members: DesktopMembers = {
    async openExternal(url: string) {
      if (!isOpenableUrl(url)) {
        // Reported with the same code the caller receives. Two names for one failure
        // would make the log disagree with the behaviour -- see the comment on the
        // catch block below, which is where that mistake was first made.
        deps.onFailure?.({
          code: "REJECTED_SCHEME",
          detail: `openExternal refused a non-http(s) URL: ${url.slice(0, 40)}`,
          messageKey: "error.shell.resourceDenied",
        });

        return { ok: false as const, code: "REJECTED_SCHEME" as const };
      }

      try {
        await deps.openExternal(url);
      } catch (error) {
        // The frozen union has no code for "the OS refused the hand-off", so the
        // return value has exactly one refusal it can carry. What matters here is that
        // **the reported code and the returned code are the same one**: this is one
        // event, and an observer reading the log and a caller reading the value must
        // not be told two different things about it.
        //
        // The first version of this handler reported `APP_PROTOCOL_DENIED` to
        // `onFailure` while returning `REJECTED_SCHEME`, which meant the same failure
        // had two names depending on where you looked. The mismatch is worse than
        // either code being imperfect, because it makes the log disagree with the
        // behaviour -- and a reader would have to know which path produced which name.
        //
        // `REJECTED_SCHEME` is the honest choice of the two despite covering a wider
        // case than its name suggests: the value is what a caller branches on, and the
        // `detail` keeps the real reason ("no browser registered" versus "not an http
        // URL") so the distinction survives where it can be read.
        deps.onFailure?.({
          code: "REJECTED_SCHEME",
          detail: `openExternal failed: ${String(error).slice(0, 80)}`,
          messageKey: "error.shell.resourceDenied",
        });

        return { ok: false as const, code: "REJECTED_SCHEME" as const };
      }

      return { ok: true as const };
    },

    async pickPaths(opts: { kind: "file" | "directory"; multiple?: boolean }) {
      const answer = await deps.showOpenDialog({
        kind: opts.kind,
        // Absent means single. Normalised here so the injected shell never has to
        // decide what `undefined` means.
        multiple: opts.multiple === true,
      });

      // A cancellation is an empty array, not an error: "nobody picked anything" is a
      // normal outcome of opening a dialog, and making it an error would force every
      // caller to distinguish it from a failure.
      if (answer.cancelled) return [];

      // Truncated to one unless multiple was asked for. The real dialog already refuses
      // to return several in single-select mode, so this is not about the real dialog --
      // it is about the contract holding for *every* implementation. The injected
      // doubles in the parity test, and any future host, can return several, and a caller
      // that asked for one must not silently receive four.
      return opts.multiple === true ? answer.paths : answer.paths.slice(0, 1);
    },

    async resolveLocalResource(absPath: string) {
      // Delegated, not reimplemented: the boundary and the URL shape live in
      // `media-protocol.ts`, and a second implementation of either would be a second
      // boundary -- and the weaker one wins.
      const result = mediaUrlFor(absPath, deps.readableRoots(), deps.trustAllPaths());

      if (!result.ok || result.url === undefined) {
        // Two codes here, and the difference from `openExternal` is deliberate rather
        // than an oversight of the rule stated above. `openExternal` has one failure
        // path whose value is forced to `REJECTED_SCHEME`, so reporting a different code
        // to the observer meant two names for one event. Here the two codes come from
        // **two different vocabularies that serve different readers**: `APP_PROTOCOL_*`
        // is the `ShellErrorCode` the log and the UI speak, `OUT_OF_ROOT` is the
        // `HostPort` refusal the frozen union requires a caller to branch on.
        //
        // They cannot be the same string, because neither table has the other's value.
        // What keeps this honest is that the mapping is fixed and total: every refusal
        // this member produces is `OUT_OF_ROOT` to the caller and `APP_PROTOCOL_DENIED`
        // to the log, with no path where one appears without the other. Asserted below.
        deps.onFailure?.({
          code: "APP_PROTOCOL_DENIED",
          detail: `resolveLocalResource refused: ${absPath} (${result.reason ?? "unknown"})`,
          messageKey: "error.shell.resourceDenied",
        });

        return { ok: false as const, code: "OUT_OF_ROOT" as const };
      }

      return { ok: true as const, url: result.url };
    },

    onShutdown(cb: () => void) {
      // Synchronous registration, because a caller must be able to register from a
      // synchronous context during startup. The asynchronous half belongs to whoever
      // triggers the shutdown, which is `runShutdown`.
      onShutdownCallbacks.push(cb);
    },

    async notify(level: "info" | "warn" | "error", message: string) {
      // The refusal is expressed by the capability flag, never by an error: a caller
      // whose notification path had to branch on "can this host notify" would have
      // that branch in every place that reports something.
      if (!notifyAvailable) return;

      // The title is the level, because the OS shows a title and a body and this item
      // has no product name to put there. A user who sees "warn" learns more than one
      // who sees the name of the application they already know they are using.
      deps.showNotification(level, message);
    },

    async readDroppedFiles(files: readonly { name: string; path?: string }[]) {
      // This build has drag-drop, so `UNSUPPORTED` is never the answer -- but an entry
      // with no usable path is a real case, not a failure of the call: measured, a
      // `File` the browser constructed reports `""` from `getPathForFile`, and `""` is
      // a normal return value rather than an error.
      const entries: { name: string; path?: string; base64?: string }[] = [];

      for (const file of files) {
        const candidate = file.path;

        if (candidate === undefined || candidate === "") {
          // Name only. This item does not invent a path, and it does not read the
          // bytes to fabricate base64 either -- fabricating content is how a caller
          // ends up trusting something that was never there.
          entries.push({ name: file.name });
          continue;
        }

        // A relative path would resolve against the child's cwd rather than this
        // process's -- the same trap `buildSpawnSpec` avoids for the engine bundle.
        if (!path.isAbsolute(candidate)) {
          entries.push({ name: file.name });
          continue;
        }

        entries.push({ name: file.name, path: candidate });
      }

      return { ok: true as const, entries };
    },
  };

  return {
    members,

    async runShutdown(): Promise<void> {
      if (shutdownRan) return;
      shutdownRan = true;

      // Drained rather than iterated in place: a callback that registers another one
      // would otherwise extend the list while it is being walked, and the new one
      // would run in the same pass -- a loop that can grow itself.
      for (const callback of onShutdownCallbacks.splice(0)) {
        try {
          callback();
        } catch {
          // A throwing callback must not stop the others. The contract calls this a
          // courtesy hook, and one broken subscriber silently cancelling another's
          // cleanup would be worse than the throwing subscriber itself.
        }
      }
    },
  };
}
