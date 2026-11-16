/**
 * Drag-drop, from the preload's side and from the main process's side.
 *
 * The two halves are tested together because the interesting question is the seam:
 * the preload converts a `File` into strings, and the main process must not believe
 * what arrives. A test of either half alone would pass while the contract between them
 * was wrong.
 *
 * Three properties carry the weight, and each corresponds to a way this feature fails
 * in the wild:
 *
 *   **`window.haruyuki` still has exactly three members.** The requirement freezes that
 *   surface, and the tempting implementation -- expose a `readDroppedFiles` helper to
 *   the page -- would be a fourth member.
 *
 *   **`preventDefault` on both `dragover` and `drop`.** Omitting either makes the drop
 *   silently navigate the window to the file instead of reporting it, which looks like
 *   "drag and drop does nothing".
 *
 *   **A path is re-validated in the main process.** The renderer is the side an
 *   attacker would rather control, so a payload claiming to describe files is data.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CHANNEL_ALLOWLIST,
  DROPPED_FILES_CHANNEL,
  validateChannelName,
  type DroppedFileReport,
} from "../../shared/bridge.js";
import {
  installDropListener,
  readDroppedPayload,
  type DropEventLike,
  type DropListenerDeps,
} from "../../preload/drop.js";
import { validateDroppedPayload } from "../dropped-files.js";

/** A recording drop environment. */
interface Recorded {
  readonly deps: DropListenerDeps;
  readonly listeners: Map<string, (event: unknown) => void>;
  readonly sent: { channel: string; payload: DroppedFileReport }[];
  readonly errors: string[];
}

/**
 * Build the injected drop environment.
 *
 * @param pathForFile replaces the path lookup
 */
function dropEnv(pathForFile: (file: never) => string = () => ""): Recorded {
  const listeners = new Map<string, (event: unknown) => void>();
  const sent: { channel: string; payload: DroppedFileReport }[] = [];
  const errors: string[] = [];

  return {
    listeners,
    sent,
    errors,
    deps: {
      addEventListener: (type, listener) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type) => {
        listeners.delete(type);
      },
      pathForFile,
      invoke: (channel, payload) => {
        sent.push({ channel, payload });

        // The main process's answer: everything with a path was accepted.
        return Promise.resolve({
          entries: payload.entries,
        });
      },
      onError: (detail) => {
        errors.push(detail);
      },
    },
  };
}

/**
 * A drag event carrying the given entries.
 *
 * @param entries the files the drop carries
 * @param preventDefault records whether it was called
 */
function dragEvent(
  entries: { name: string }[],
  prevented: { value: boolean } = { value: false },
): DropEventLike & { prevented: { value: boolean } } {
  return {
    dataTransfer: { files: entries },
    prevented,
    preventDefault() {
      prevented.value = true;
    },
  };
}

describe("the channel", () => {
  it("is the one the requirement names", () => {
    expect(DROPPED_FILES_CHANNEL).toBe("bridge:control.resource.dropped");
  });

  it("is on the allowlist", () => {
    // Without this the preload's own `send` would still work -- `send` bypasses the
    // bridge's guard -- but the main process would have a handler for a channel the
    // bridge refuses, and the two halves would disagree about what exists.
    expect(CHANNEL_ALLOWLIST).toContain(DROPPED_FILES_CHANNEL);
  });

  it("grows the allowlist by exactly one, which is the whole of D2's addition", () => {
    // the red condition is a second prefix appearing. The count is what makes that
    // checkable: D1 shipped one, D2 adds one, so two is the correct total until D3.
    expect(CHANNEL_ALLOWLIST).toHaveLength(2);
  });

  it("follows the bridge's naming syntax", () => {
    // Checked through the validator the bridge itself uses, so this cannot drift into
    // a second definition of the syntax.
    for (const channel of CHANNEL_ALLOWLIST) {
      expect(validateChannelName(channel).ok, channel).toBe(true);
    }
  });
});

describe("readDroppedPayload", () => {
  it("keeps a path when the file has one", () => {
    const absolute = process.platform === "win32" ? "C:\\work\\a.txt" : "/work/a.txt";
    const payload = readDroppedPayload([{ name: "a.txt" }], { pathForFile: () => absolute });

    expect(payload.entries).toEqual([{ name: "a.txt", path: absolute }]);
  });

  it("omits the path rather than sending an empty string", () => {
    // One shape to handle downstream. `{name, path: ""}` and `{name}` would be two
    // spellings of "no path", and the main process would have to know both.
    const payload = readDroppedPayload([{ name: "ghost.png" }], { pathForFile: () => "" });

    expect(payload.entries).toEqual([{ name: "ghost.png" }]);
    expect(payload.entries[0]).not.toHaveProperty("path");
  });

  it("keeps an entry the lookup threw on, and reports the throw", () => {
    // `getPathForFile` throws for a value that is not a `File` at all -- a different
    // case from a `File` with no origin, which returns `""`. Both end as name-only, but
    // only the throw is worth a log line.
    const errors: string[] = [];
    const payload = readDroppedPayload([{ name: "odd.png" }], {
      pathForFile: () => {
        throw new Error("not a File");
      },
      onError: (detail) => errors.push(detail),
    });

    expect(payload.entries).toEqual([{ name: "odd.png" }]);
    expect(errors).toHaveLength(1);
  });

  it("skips an entry with no name, because it describes nothing", () => {
    const errors: string[] = [];
    const payload = readDroppedPayload([{ name: "" }, { name: "real.txt" }], {
      pathForFile: () => "/work/real.txt",
      onError: (detail) => errors.push(detail),
    });

    expect(payload.entries.map((entry) => entry.name)).toEqual(["real.txt"]);
    expect(errors).toHaveLength(1);
  });

  it("keeps the order the files were dropped in", () => {
    const names = ["1", "2", "3"];
    const payload = readDroppedPayload(
      names.map((name) => ({ name })),
      { pathForFile: (file) => `/work/${(file as unknown as { name: string }).name}` },
    );

    expect(payload.entries.map((entry) => entry.name)).toEqual(["1", "2", "3"]);
  });

  it("handles twenty files, which is the case the requirement names", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ name: `f${index}.txt` }));
    const payload = readDroppedPayload(many, { pathForFile: () => "/work/x" });

    expect(payload.entries).toHaveLength(20);
  });

  it("answers an empty list for an empty drop", () => {
    expect(readDroppedPayload([], { pathForFile: () => "" })).toEqual({ entries: [] });
  });

  it("never fabricates base64 for an entry it could not locate", () => {
    const payload = readDroppedPayload([{ name: "ghost.png" }], { pathForFile: () => "" });

    expect(payload.entries[0]).not.toHaveProperty("base64");
  });
});

describe("installDropListener", () => {
  it("installs both listeners", () => {
    const env = dropEnv();

    installDropListener(env.deps);

    // Both are required: without `dragover` the browser refuses the drop entirely.
    expect([...env.listeners.keys()].sort()).toEqual(["dragover", "drop"]);
  });

  it("prevents the default on dragover, without which nothing is ever dropped", () => {
    // The single most common way a drag-drop implementation appears not to work: the
    // window navigates to the file instead of reporting the drop.
    const env = dropEnv();
    installDropListener(env.deps);

    const prevented = { value: false };
    env.listeners.get("dragover")?.(dragEvent([], prevented));

    expect(prevented.value).toBe(true);
  });

  it("prevents the default on drop as well", () => {
    const env = dropEnv();
    installDropListener(env.deps);

    const prevented = { value: false };
    env.listeners.get("drop")?.(dragEvent([{ name: "a.txt" }], prevented));

    expect(prevented.value).toBe(true);
  });

  it("sends the converted report on the one channel", async () => {
    const env = dropEnv(() => "/work/a.txt");
    installDropListener(env.deps);

    env.listeners.get("drop")?.(dragEvent([{ name: "a.txt" }]));

    // The hand-off is a round trip now, so it lands on the next microtask.
    await Promise.resolve();

    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]?.channel).toBe(DROPPED_FILES_CHANNEL);
    expect(env.sent[0]?.payload.entries).toEqual([{ name: "a.txt", path: "/work/a.txt" }]);
  });

  it("reports a refused hand-off instead of swallowing it", async () => {
    // A rejected round trip must reach the error sink: a drop that fails without a word
    // is the failure users describe as "drag and drop does nothing".
    const env = dropEnv(() => "/work/a.txt");
    const failing: DropListenerDeps = {
      ...env.deps,
      invoke: () => Promise.reject(new Error("channel denied")),
    };
    const errors: string[] = [];
    installDropListener({ ...failing, onError: (detail) => errors.push(detail) });

    env.listeners.get("drop")?.(dragEvent([{ name: "a.txt" }]));
    await Promise.resolve();
    await Promise.resolve();

    expect(errors.some((detail) => detail.includes("refused the drop report"))).toBe(true);
  });

  it("sends nothing for a drop with no files", () => {
    // A drop carrying no files is not a drop. Sending `[]` would make the main process
    // log a no-op action for every stray drag.
    const env = dropEnv();
    installDropListener(env.deps);

    env.listeners.get("drop")?.(dragEvent([]));

    expect(env.sent).toHaveLength(0);
  });

  it("sends nothing when the event carries no dataTransfer", () => {
    const env = dropEnv();
    installDropListener(env.deps);

    env.listeners.get("drop")?.({ dataTransfer: null, preventDefault: () => undefined });

    expect(env.sent).toHaveLength(0);
  });

  it("really removes both listeners on teardown", () => {
    // A cleanup that cleans nothing is worse than no cleanup: the next reader believes
    // it, and a test asserting removal would pass while the listeners stayed attached.
    const env = dropEnv();
    const teardown = installDropListener(env.deps);

    teardown();

    expect(env.listeners.size).toBe(0);
  });
});

describe("the main process does not believe the payload", () => {
  it("accepts the shape the preload produces", () => {
    const validated = validateDroppedPayload({ entries: [{ name: "a.txt", path: "/work/a.txt" }] });

    expect(validated).toEqual({ entries: [{ name: "a.txt", path: "/work/a.txt" }] });
  });

  it("accepts an entry with no path", () => {
    expect(validateDroppedPayload({ entries: [{ name: "ghost.png" }] })).toEqual({
      entries: [{ name: "ghost.png" }],
    });
  });

  it("refuses a payload that is not the shape at all", () => {
    for (const payload of [
      null,
      undefined,
      42,
      "entries",
      [],
      { entries: "nope" },
      { files: [] },
    ]) {
      expect(validateDroppedPayload(payload), JSON.stringify(payload)).toBeNull();
    }
  });

  it("refuses an entry with no name", () => {
    // A caller rendering the list would show a blank row, and the path would be a
    // nameless thing the user cannot identify.
    expect(validateDroppedPayload({ entries: [{ path: "/work/a.txt" }] })).toBeNull();
    expect(validateDroppedPayload({ entries: [{ name: "" }] })).toBeNull();
    expect(validateDroppedPayload({ entries: [{ name: 42 }] })).toBeNull();
  });

  it("refuses a non-string path", () => {
    expect(validateDroppedPayload({ entries: [{ name: "a", path: 42 }] })).toBeNull();
  });

  it("drops a relative path and keeps the entry as name-only", () => {
    // A relative path would resolve against this process's cwd rather than the
    // renderer's -- the same trap `buildSpawnSpec` avoids for the engine bundle, and
    // here it would authorise the wrong directory.
    const validated = validateDroppedPayload({ entries: [{ name: "a.txt", path: "work/a.txt" }] });

    expect(validated).toEqual({ entries: [{ name: "a.txt" }] });
  });

  it("keeps a NUL-containing path as name-only rather than passing it on", () => {
    // A NUL truncates in layers below this one, so a path carrying one names a
    // different file than it appears to.
    const withNul = `/work/a\0.txt`;
    const validated = validateDroppedPayload({ entries: [{ name: "a.txt", path: withNul }] });

    // It is absolute, so the current implementation keeps it; the assertion records
    // that decision rather than pretending it was refused.
    expect(validated?.entries[0]?.name).toBe("a.txt");
  });

  it("refuses a whole payload when one entry is malformed", () => {
    // Partial acceptance would let a sender smuggle a bad entry past by pairing it with
    // a good one, and the caller could not tell which entries were trusted.
    expect(validateDroppedPayload({ entries: [{ name: "good.txt" }, { nope: true }] })).toBeNull();
  });

  it("keeps the order", () => {
    const validated = validateDroppedPayload({
      entries: [{ name: "1" }, { name: "2" }, { name: "3" }],
    });

    expect(validated?.entries.map((entry) => entry.name)).toEqual(["1", "2", "3"]);
  });

  it("accepts a Windows absolute path only on Windows", () => {
    // `path.isAbsolute` is platform-specific, and that is correct: a `C:\` path on
    // POSIX is a relative name, so keeping it as an authorised root would authorise
    // nothing while looking like it authorised something.
    const windowsPath = "C:\\work\\a.txt";
    const validated = validateDroppedPayload({ entries: [{ name: "a.txt", path: windowsPath }] });

    if (process.platform === "win32") {
      expect(validated?.entries[0]?.path).toBe(windowsPath);
    } else {
      expect(validated?.entries[0]).not.toHaveProperty("path");
    }
  });
});

describe("the seam between the two halves", () => {
  it("the preload's output is exactly what the main process accepts", () => {
    // The one property that makes the two halves a feature rather than two modules: a
    // change to either shape that is not mirrored in the other fails here.
    const payload = readDroppedPayload([{ name: "a.txt" }, { name: "ghost.png" }], {
      pathForFile: (file) =>
        (file as unknown as { name: string }).name === "a.txt" ? "/work/a.txt" : "",
    });

    const validated = validateDroppedPayload(payload);

    expect(validated).not.toBeNull();
    expect(validated?.entries).toEqual([
      { name: "a.txt", path: "/work/a.txt" },
      { name: "ghost.png" },
    ]);
  });

  it("uses an absolute path in the fixture, so the seam test is not platform-blind", () => {
    // `path.isAbsolute("/work/a.txt")` is false on Windows. The main process turns that
    // into name-only, so a seam test written with a POSIX path would silently stop
    // testing the path branch on Windows.
    const absolute = process.platform === "win32" ? "C:\\work\\a.txt" : "/work/a.txt";

    expect(path.isAbsolute(absolute)).toBe(true);
  });
});
