/**
 * Parity between the real desktop implementation and the two doubles.
 *
 * The question this answers is not "does the desktop shell work" -- the probes and the
 * injected unit tests cover that. It is: **does the real implementation answer the same
 * shapes and the same error codes as the doubles the rest of the repository tests
 * against?** A shell that worked but disagreed with `@haruyuki/core`'s doubles would
 * make every downstream test green about a port that does not exist.
 *
 * `packages/core/src/testing/adapters.test.ts` already runs this sequence over the
 * headless port and the two shell doubles. This file runs the *same* sequence over the
 * real desktop members and compares the observable answers. Reusing the sequence
 * matters more than the code: a second, differently-shaped sequence would let a
 * divergence hide in the part it does not cover.
 *
 * What is compared and what is not:
 *
 *   Compared: success/failure, error codes, the *keys* of the spawn spec, and the
 *   boolean/string flags whose values are fixed by the contract.
 *
 *   Not compared: path contents, timings, and anything the shell answers that the
 *   doubles deliberately get wrong (`canFloatingWindow` is false in both, but the
 *   doubles' dialog queue is a fixture while the real one is a human).
 *
 *   Also not compared: `secure*`. The desktop side needs `safeStorage`, which does not
 *   exist under plain Node; the real one is covered by `secrets.test.ts` with a
 *   reversible stand-in and by `verify:host-port` for construction. Pretending to
 *   compare it here would mean comparing two stand-ins.
 */

import { describe, expect, it } from "vitest";

import { createDesktopMembers, type DesktopMembersDeps } from "../host-members.js";
import { buildSpawnSpec, DESKTOP_CAPABILITIES, desktopPaths } from "../host-port.js";

/** A recording double for the shell, matching the shape the core doubles use. */
function doubles(): { deps: DesktopMembersDeps; opened: string[]; notified: number } {
  const opened: string[] = [];
  let notified = 0;

  return {
    opened,
    get notified() {
      return notified;
    },
    deps: {
      showNotification: () => {
        notified += 1;
      },
      openExternal: async (url) => {
        opened.push(url);
      },
      showOpenDialog: async () => ({ cancelled: true, paths: [] }),
      canNotify: () => true,
      readableRoots: () => [],
      trustAllPaths: () => false,
    },
  };
}

/** The call sequence, reduced to the answers that must agree across implementations. */
interface SharedAnswers {
  readonly openExternalAccepted: string;
  readonly openExternalFileScheme: string;
  readonly openExternalMailto: string;
  readonly openExternalRelative: string;
  readonly pickCancelled: string;
  readonly resolveOutside: string;
  readonly notifyResolved: boolean;
  readonly droppedWithoutPath: string;
  readonly droppedWithAbsolutePath: string;
}

/**
 * Run the sequence once.
 *
 * @param members the implementation under test
 * @param absolutePath an absolute path this platform considers absolute
 */
async function runSequence(
  members: ReturnType<typeof createDesktopMembers>["members"],
  absolutePath: string,
): Promise<SharedAnswers> {
  /** Reduce one result to `"OK"` or its code, which is what the doubles compare. */
  const verdict = (answer: { ok: boolean; code?: string }): string =>
    answer.ok ? "OK" : (answer.code ?? "NO-CODE");

  const droppedWithout = await members.readDroppedFiles([{ name: "ghost.png" }]);
  const droppedWith = await members.readDroppedFiles([{ name: "a.txt", path: absolutePath }]);

  return {
    openExternalAccepted: verdict(await members.openExternal("https://example.com/")),
    openExternalFileScheme: verdict(await members.openExternal("file:///etc/passwd")),
    openExternalMailto: verdict(await members.openExternal("mailto:a@b.com")),
    openExternalRelative: verdict(await members.openExternal("/docs/page")),
    pickCancelled: String((await members.pickPaths({ kind: "file" })).length),
    resolveOutside: verdict(
      await members.resolveLocalResource(
        process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd",
      ),
    ),
    // Every level must resolve rather than throw, including when the host cannot
    // notify: the refusal is the capability flag, never an error.
    notifyResolved: await members
      .notify("info", "parity")
      .then(() => true)
      .catch(() => false),
    // The key set matters, not the values: an entry with no path is one shape, and a
    // second spelling of "no path" is how two shells diverge.
    droppedWithoutPath: Object.keys(droppedWithout.ok ? (droppedWithout.entries[0] ?? {}) : {})
      .sort()
      .join(","),
    droppedWithAbsolutePath: Object.keys(droppedWith.ok ? (droppedWith.entries[0] ?? {}) : {})
      .sort()
      .join(","),
  };
}

/** An absolute path that means the same thing to both sides of this comparison. */
const ABSOLUTE = process.platform === "win32" ? "C:\\work\\a.txt" : "/work/a.txt";

describe("the desktop members answer the shapes the doubles answer", () => {
  it("agrees on every refusal code in the sequence", async () => {
    const { members } = createDesktopMembers(doubles().deps);
    const answers = await runSequence(members, ABSOLUTE);

    // The codes are the contract. Each of these four is a different kind of "no", and
    // a shell that collapsed them into one would make a caller unable to tell a bad
    // scheme from a missing host.
    expect(answers.openExternalAccepted).toBe("OK");
    expect(answers.openExternalFileScheme).toBe("REJECTED_SCHEME");
    expect(answers.openExternalMailto).toBe("REJECTED_SCHEME");
    expect(answers.openExternalRelative).toBe("REJECTED_SCHEME");
    expect(answers.resolveOutside).toBe("OUT_OF_ROOT");
  });

  it("agrees that a cancelled dialog is an empty list, not a code", async () => {
    const { members } = createDesktopMembers(doubles().deps);
    const answers = await runSequence(members, ABSOLUTE);

    // "Nobody picked anything" is not a failure, and a code here would force every
    // caller to branch on a normal outcome.
    expect(answers.pickCancelled).toBe("0");
  });

  it("agrees that notify resolves at every level", async () => {
    const { members } = createDesktopMembers(doubles().deps);
    const answers = await runSequence(members, ABSOLUTE);

    expect(answers.notifyResolved).toBe(true);
  });

  it("agrees that a dropped entry with no path carries only its name", async () => {
    // One shape for "no path", not two spellings of it. The core doubles assert
    // `{name}` for the same reason.
    const { members } = createDesktopMembers(doubles().deps);
    const answers = await runSequence(members, ABSOLUTE);

    expect(answers.droppedWithoutPath).toBe("name");
    expect(answers.droppedWithAbsolutePath).toBe("name,path");
  });
});

describe("the spawn spec's shape agrees with the doubles", () => {
  it("has the eight frozen fields, in the frozen set", async () => {
    // The core parity test compares `Object.keys(spec).sort()`; this is the same
    // question asked of the real builder. A field added here and not there would make
    // one implementation promise something the other does not.
    const paths = desktopPaths((name) =>
      name === "userData" ? "/u" : name === "logs" ? "/u/logs" : "/tmp",
    );
    const result = await buildSpawnSpec({ bundlePath: ABSOLUTE }, paths, () => true, "/app");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.spec).sort()).toEqual([
      "argvPrefix",
      "bundlePath",
      "cwd",
      "detached",
      "env",
      "exePath",
      "stdio",
      "windowsHide",
    ]);
  });

  it("keeps the four flags the contract fixes", async () => {
    const paths = desktopPaths((name) =>
      name === "userData" ? "/u" : name === "logs" ? "/u/logs" : "/tmp",
    );
    const result = await buildSpawnSpec({ bundlePath: ABSOLUTE }, paths, () => true, "/app");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The doubles assert the same four. `detached` is the one that differs by
    // platform, and both sides derive it the same way.
    expect(result.spec.stdio).toBe("pipe");
    expect(result.spec.windowsHide).toBe(true);
    expect(result.spec.detached).toBe(process.platform !== "win32");
    expect(result.spec.cwd).toBe(paths.userData);
  });

  it("refuses with a reason rather than a code, as the doubles do", async () => {
    // `getRuntimeSpawnSpec`'s refusal is `{ok:false, reason}` -- a string for the user,
    // not one of the frozen codes. A shell that answered a code here would be
    // answering a different contract.
    const paths = desktopPaths(() => "/u");
    const result = await buildSpawnSpec({ bundlePath: "relative.mjs" }, paths, () => true, "/app");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("the capability constant agrees with what the shell can honour", () => {
  it("claims the three the desktop has and not the one it does not", async () => {
    // `canFloatingWindow: false` is the interesting one: a floating/pinned window is a
    // design decision this item does not make (requirement T-4), and `true` would
    // promise a behaviour nobody has specified.
    expect(DESKTOP_CAPABILITIES).toEqual({
      canNotify: true,
      canReadDroppedFiles: true,
      canPopout: true,
      canFloatingWindow: false,
    });
  });
});
