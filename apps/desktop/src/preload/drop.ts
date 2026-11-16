/**
 * Reading a dropped file's path, in the preload.
 *
 * This is the only place in the application where that can happen, and the reason
 * is a type fact rather than a preference: `File` is a renderer-side object, and
 * `webUtils.getPathForFile(file)` takes a `File`. The main process cannot do this at
 * all -- not "should not", *cannot* -- because it never has the argument.
 *
 * Two constraints shape the whole module:
 *
 *   **No new preload member.** `window.haruyuki` is frozen at three members,
 *   and the requirement is explicit that other items add *channels*, never members.
 *   So the listener here runs inside the preload, converts the drop itself, and sends
 *   the result over one channel. Nothing is exposed to the page.
 *
 *   **The payload is `{name, path}[]`.** A `File` does not survive structured clone
 *   with its identity intact, so passing the objects through would hand the main
 *   process something that looks like a file and cannot be read. Converting to
 *   strings first is what makes the payload honest.
 *
 * What this module does NOT do: decide whether a path is allowed. The main process
 * re-checks that the path is absolute and inside the readable set (requirement
 * section 4.6 item 7). A preload that also checked would be a second boundary, and
 * the preload is the side an attacker would rather compromise.
 */

import { DROPPED_FILES_CHANNEL, type DroppedFileReport } from "../shared/bridge.js";

// Re-exported so the preload's entry point imports one module, and so the string has
// exactly one definition (`bridge.ts`) rather than one per side.
export { DROPPED_FILES_CHANNEL };

/** What the window's drag events need. Injected so this module is testable. */
export interface DropListenerDeps {
  /** The element to listen on; the window's own `drop` target. */
  addEventListener(type: "drop" | "dragover", listener: (event: unknown) => void): void;
  /** The matching removal, so the teardown below can actually tear down. */
  removeEventListener(type: "drop" | "dragover", listener: (event: unknown) => void): void;
  /**
   * Convert one `File` to a path, or `""` when it has no disk origin.
   *
   * `webUtils.getPathForFile` in the real preload. Returns `""` for a `File` the
   * browser constructed -- measured, and a normal return value rather than an error.
   */
  pathForFile(file: never): string;
  /** Send the converted report to the main process. */
  send(channel: string, payload: DroppedFileReport): void;
  /** Report a conversion failure so it reaches the log rather than vanishing. */
  readonly onError?: (detail: string) => void;
}

/**
 * The minimal shape of a DOM `DragEvent` this module reads.
 *
 * Declared rather than taken from lib.dom: the preload is bundled separately and a
 * dependency on DOM types there pulls in declarations the sandboxed runtime does not
 * have. Three fields is the whole contract.
 */
export interface DropEventLike {
  readonly dataTransfer: {
    readonly files: ArrayLike<unknown>;
  } | null;
  preventDefault(): void;
}

/**
 * Read the files out of one drop event.
 *
 * Every entry comes back, including ones with no path: dropping a file the browser
 * cannot locate should still tell the caller that something was dropped, otherwise
 * the UI shows nothing happened for a real user gesture.
 *
 * @param files the event's `files` list
 * @param deps what converts a file to a path
 */
export function readDroppedPayload(
  files: ArrayLike<unknown>,
  deps: Pick<DropListenerDeps, "pathForFile" | "onError">,
): DroppedFileReport {
  const entries: { name: string; path?: string }[] = [];

  for (const candidate of Array.from(files)) {
    // `name` is always present on a `File`, but a drop can carry other list entries
    // on some platforms, so it is read defensively rather than asserted.
    const name =
      typeof (candidate as { name?: unknown }).name === "string"
        ? (candidate as { name: string }).name
        : "";

    if (name === "") {
      deps.onError?.("a dropped entry had no name; skipped");
      continue;
    }

    let path = "";

    try {
      path = deps.pathForFile(candidate as never);
    } catch (error) {
      // `getPathForFile` throws for a value that is not a `File` at all. That is a
      // different case from a `File` with no origin (which returns `""`), and it is
      // worth a log line because it means the event carried something unexpected.
      deps.onError?.(`getPathForFile threw for ${name}: ${String(error).slice(0, 80)}`);
    }

    // An empty path is omitted rather than sent as `""`: the main process then has
    // one shape to handle ("no path") instead of two spellings of it.
    if (path === "") {
      entries.push({ name });
      continue;
    }

    entries.push({ name, path });
  }

  return { entries };
}

/**
 * Install the drop listener.
 *
 * `dragover` is handled for one reason: without `preventDefault` on it the browser
 * refuses the drop and navigates to the file instead. That is the single most common
 * way a drag-drop implementation appears not to work.
 *
 * @param deps what the listener needs
 * @returns a function that removes the listeners
 */
export function installDropListener(deps: DropListenerDeps): () => void {
  const onDragOver = (event: unknown): void => {
    const drag = event as DropEventLike;

    // Both a `dragover` and a `drop` need this; omitting either one is enough to
    // break the interaction, and neither breaks it visibly.
    drag.preventDefault();
  };

  const onDrop = (event: unknown): void => {
    const drop = event as DropEventLike;

    drop.preventDefault();

    const transfer = drop.dataTransfer;
    if (transfer === null) return;

    const payload = readDroppedPayload(transfer.files, deps);

    // An empty drop (nothing dropped, or everything skipped) still gets sent? No:
    // a drop with no files is not a drop, and sending `[]` would make the main
    // process log a no-op action.
    if (payload.entries.length === 0) return;

    deps.send(DROPPED_FILES_CHANNEL, payload);
  };

  deps.addEventListener("dragover", onDragOver);
  deps.addEventListener("drop", onDrop);

  // A real teardown, not a placeholder. The listener normally lives as long as the
  // renderer, so nothing calls this in production -- but a function that returns a
  // cleanup which cleans nothing is worse than one that returns nothing at all: the
  // next reader would believe the listeners were removed, and a test asserting that
  // removal happened would pass while the listeners stayed attached.
  return () => {
    deps.removeEventListener("dragover", onDragOver);
    deps.removeEventListener("drop", onDrop);
  };
}
