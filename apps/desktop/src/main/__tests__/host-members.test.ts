/**
 * The operating-system-facing members: notifications, the browser, the dialog, the
 * resource URL, shutdown and dropped files.
 *
 * These members share a property that makes them easy to get subtly wrong: every one
 * of them can fail, and every failure has a frozen code the contract says must be a
 * *value* rather than a throw. So the tests are weighted towards the refusals -- a
 * happy path that works and a refusal that throws would still pass a test that only
 * checked the happy path.
 *
 * Two of them are worth calling out because the requirement names them:
 *
 *   `notify` must succeed silently when the host cannot notify. A caller must not
 *   need a branch in every place that reports something.
 *
 *   `readDroppedFiles` must cope with an entry that has a name and no path. That is
 *   not a hypothetical: measured on this Electron, `getPathForFile` answers `""` for
 *   a `File` the browser constructed, and `""` is a normal return value.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDesktopMembers,
  isOpenableUrl,
  OPEN_EXTERNAL_SCHEMES,
  type DesktopMembersDeps,
} from "../host-members.js";

/** A recording stand-in for the shell. */
interface Recorded extends DesktopMembersDeps {
  readonly notifications: { title: string; body: string }[];
  readonly opened: string[];
  readonly failures: string[];
  readonly dialogCalls: { kind: string; multiple: boolean }[];
}

/**
 * Build the injected shell.
 *
 * @param overrides replace any individual behaviour
 */
function shell(overrides: Partial<DesktopMembersDeps> = {}): Recorded {
  const notifications: { title: string; body: string }[] = [];
  const opened: string[] = [];
  const failures: string[] = [];
  const dialogCalls: { kind: string; multiple: boolean }[] = [];

  return {
    notifications,
    opened,
    failures,
    dialogCalls,
    showNotification: (title, body) => notifications.push({ title, body }),
    openExternal: async (url) => {
      opened.push(url);
    },
    showOpenDialog: async (options) => {
      dialogCalls.push({ kind: options.kind, multiple: options.multiple });

      return { cancelled: true, paths: [] };
    },
    canNotify: () => true,
    readableRoots: () => [],
    trustAllPaths: () => false,
    onFailure: (error) => failures.push(error.code),
    ...overrides,
  };
}

describe("isOpenableUrl", () => {
  it("accepts http and https", () => {
    expect(isOpenableUrl("https://example.com/a")).toBe(true);
    expect(isOpenableUrl("http://example.com")).toBe(true);
  });

  it("refuses every scheme that could read or execute locally", () => {
    // `file:` would let a compromised renderer read local files by asking the OS to
    // open them; `javascript:` runs inside the system browser's context.
    for (const url of [
      "file:///C:/Windows/win.ini",
      "javascript:alert(1)",
      "data:text/html,<script>x</script>",
      "vbscript:msgbox",
      "mailto:a@b.com",
      "ftp://example.com",
      "chrome://settings",
    ]) {
      expect(isOpenableUrl(url), url).toBe(false);
    }
  });

  it("refuses a scheme with no host, which a prefix test would accept", () => {
    // Both of these pass `startsWith("http")` and cannot be opened. Parsing is what
    // separates them, and it is why the check is not a prefix test.
    expect(isOpenableUrl("https://")).toBe(false);
    expect(isOpenableUrl("http://")).toBe(false);
  });

  it("accepts the host-less form the URL standard actually resolves", () => {
    // `new URL("http:evil.com")` is a valid URL: WHATWG resolves it to
    // `http://evil.com/`, and a browser hands the same thing to the OS. Refusing it
    // here would be stricter than the browser for no security gain -- the destination
    // is still an http host, which is exactly what this allow-list permits.
    //
    // Recorded as a test because the first version of this file asserted the
    // opposite and was wrong: it assumed a missing `//` meant a missing host.
    expect(isOpenableUrl("http:evil.com")).toBe(true);
  });

  it("refuses a relative string and garbage", () => {
    for (const url of ["/docs/page", "example.com", "", "   ", "ht tp://x"]) {
      expect(isOpenableUrl(url), JSON.stringify(url)).toBe(false);
    }
  });

  it("names exactly the two schemes it accepts", () => {
    // The list is the boundary; a third entry would be a security change.
    expect([...OPEN_EXTERNAL_SCHEMES]).toEqual(["http:", "https:"]);
  });
});

describe("openExternal", () => {
  it("hands an accepted URL to the system and reports success", async () => {
    const deps = shell();
    const { members } = createDesktopMembers(deps);

    await expect(members.openExternal("https://example.com")).resolves.toEqual({ ok: true });
    expect(deps.opened).toEqual(["https://example.com"]);
  });

  it("refuses a bad scheme as a value, with the frozen code", async () => {
    const deps = shell();
    const { members } = createDesktopMembers(deps);

    // The contract says a refusal is `{ok:false, code:"REJECTED_SCHEME"}` and not a
    // throw, so the caller classifies it without unwrapping an exception.
    await expect(members.openExternal("file:///etc/passwd")).resolves.toEqual({
      ok: false,
      code: "REJECTED_SCHEME",
    });
    // Nothing reached the OS.
    expect(deps.opened).toEqual([]);
  });

  it("reports a refusal with a code, so it leaves a trace", async () => {
    const deps = shell();
    const { members } = createDesktopMembers(deps);

    await members.openExternal("javascript:void(0)");

    // This assertion used to expect `APP_PROTOCOL_DENIED`, which pinned the bug rather
    // than the behaviour: the caller was told `REJECTED_SCHEME` while the log said
    // something else. Corrected to the code the caller actually receives, so the log and
    // the return value cannot drift apart again without this failing.
    expect(deps.failures).toContain("REJECTED_SCHEME");
  });

  it("reports the same code to the log and to the caller", async () => {
    // This is the invariant the two sides of one failure have to share. The first
    // version of this handler told `onFailure` one code and returned a different one,
    // which meant the log and the behaviour disagreed about the same event -- and a
    // reader would have had to know which path produced which name.
    const deps = shell({
      openExternal: async () => {
        throw new Error("no browser registered");
      },
    });
    const { members } = createDesktopMembers(deps);

    const answer = await members.openExternal("https://example.com");

    expect(answer.ok).toBe(false);
    if (answer.ok) return;

    // Two observation points, one name.
    expect(deps.failures).toEqual([answer.code]);
  });

  it("does the same for a refused scheme, which has its own path", async () => {
    // The other branch: refused before the OS is asked. It must agree with itself for
    // the same reason, even though its code is chosen rather than forced.
    const deps = shell();
    const { members } = createDesktopMembers(deps);

    const answer = await members.openExternal("file:///etc/passwd");

    expect(answer.ok).toBe(false);
    if (answer.ok) return;

    expect(deps.failures).toEqual([answer.code]);
  });

  it("turns an OS-level failure into the only code the union has", async () => {
    // There is no code for "the OS refused the hand-off", and adding one would be a
    // contract change. The important part is that it is a value, not a throw.
    const deps = shell({
      openExternal: async () => {
        throw new Error("no browser registered");
      },
    });
    const { members } = createDesktopMembers(deps);

    await expect(members.openExternal("https://example.com")).resolves.toEqual({
      ok: false,
      code: "REJECTED_SCHEME",
    });
  });
});

describe("pickPaths", () => {
  it("answers an empty array on cancellation, not an error", async () => {
    // "Nobody picked anything" is a normal outcome of opening a dialog. An error here
    // would force every caller to distinguish it from a real failure.
    const deps = shell();
    const { members } = createDesktopMembers(deps);

    await expect(members.pickPaths({ kind: "file" })).resolves.toEqual([]);
  });

  it("passes the selected paths through in order", async () => {
    const deps = shell({
      showOpenDialog: async () => ({ cancelled: false, paths: ["a", "b", "c"] }),
    });
    const { members } = createDesktopMembers(deps);

    await expect(members.pickPaths({ kind: "file", multiple: true })).resolves.toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("truncates to one when multiple was not asked for", async () => {
    // The contract says `multiple: true` returns several and otherwise one. The real
    // dialog already behaves that way, so this case is about every *other* host: the
    // parity doubles can return four, and a caller that asked for one must not receive
    // four. Without the truncation the clause was simply unimplemented, and no test
    // noticed because every existing case used `multiple: true` or a cancellation.
    const deps = shell({
      showOpenDialog: async () => ({ cancelled: false, paths: ["a", "b", "c"] }),
    });
    const { members } = createDesktopMembers(deps);

    const single = await members.pickPaths({ kind: "file" });
    const omitted = await members.pickPaths({ kind: "file", multiple: false });

    expect(single).toEqual(["a"]);
    expect(omitted).toEqual(["a"]);
  });

  it("keeps every path when multiple was asked for", async () => {
    // The other half of the same clause: truncating here would break multi-select.
    const deps = shell({
      showOpenDialog: async () => ({ cancelled: false, paths: ["a", "b", "c"] }),
    });
    const { members } = createDesktopMembers(deps);

    await expect(members.pickPaths({ kind: "file", multiple: true })).resolves.toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("forwards the kind, so a directory picker is a directory picker", async () => {
    const deps = shell();
    const { members } = createDesktopMembers(deps);

    await members.pickPaths({ kind: "directory" });

    expect(deps.dialogCalls[0]?.kind).toBe("directory");
  });

  it("treats an absent multiple flag as single selection", async () => {
    const deps = shell();
    const { members } = createDesktopMembers(deps);

    await members.pickPaths({ kind: "file" });

    // Normalised before it reaches the shell, so the shell never has to decide what
    // `undefined` means.
    expect(deps.dialogCalls[0]?.multiple).toBe(false);
  });
});

describe("resolveLocalResource", () => {
  const ROOT = process.platform === "win32" ? "C:\\work" : "/work";

  it("has a fixed mapping from its refusal to the shell code it reports", async () => {
    // Two vocabularies, one refusal: `APP_PROTOCOL_DENIED` is the shell code the log and
    // UI speak, `OUT_OF_ROOT` is the port code the frozen union makes a caller branch on.
    // Neither table has the other's value, so they cannot be the same string -- what makes
    // that safe is the mapping being fixed and total. If a second refusal reason is added,
    // it has to pick a shell code here rather than appearing only in the return value.
    const outside = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd";
    const deps = shell({ readableRoots: () => [ROOT] });
    const { members } = createDesktopMembers(deps);

    const answer = await members.resolveLocalResource(outside);

    // One refusal, both names present, no third possibility.
    expect(answer).toEqual({ ok: false, code: "OUT_OF_ROOT" });
    expect(deps.failures).toEqual(["APP_PROTOCOL_DENIED"]);
  });

  it("answers a media URL for a path inside the readable set", async () => {
    const inside = path.join(ROOT, "shot.png");
    const deps = shell({ readableRoots: () => [ROOT] });
    const { members } = createDesktopMembers(deps);

    const result = await members.resolveLocalResource(inside);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toContain("haruyuki-media://");
  });

  it("refuses a path outside the set with OUT_OF_ROOT", async () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/passwd";
    const deps = shell({ readableRoots: () => [ROOT] });
    const { members } = createDesktopMembers(deps);

    await expect(members.resolveLocalResource(outside)).resolves.toEqual({
      ok: false,
      code: "OUT_OF_ROOT",
    });
  });

  it("delegates the boundary instead of restating it", async () => {
    // The URL shape and the containment test live in `media-protocol.ts`. A second
    // implementation here would be a second boundary, and the weaker one wins.
    //
    // Checked by behaviour rather than by reading the source: a sibling directory
    // whose name starts with the root's text is outside, and a private prefix test
    // would let it through.
    const sibling = process.platform === "win32" ? "C:\\work2\\shot.png" : "/work2/shot.png";
    const deps = shell({ readableRoots: () => [ROOT] });
    const { members } = createDesktopMembers(deps);

    await expect(members.resolveLocalResource(sibling)).resolves.toEqual({
      ok: false,
      code: "OUT_OF_ROOT",
    });
  });

  it("honours the position-trust switch, which widens location only", async () => {
    const anywhere = process.platform === "win32" ? "C:\\any\\a.png" : "/any/a.png";
    const deps = shell({ readableRoots: () => [], trustAllPaths: () => true });
    const { members } = createDesktopMembers(deps);

    const result = await members.resolveLocalResource(anywhere);

    expect(result.ok).toBe(true);
  });
});

describe("onShutdown and runShutdown", () => {
  it("runs every registered callback once", async () => {
    const calls: string[] = [];
    const { members, runShutdown } = createDesktopMembers(shell());

    members.onShutdown(() => calls.push("a"));
    members.onShutdown(() => calls.push("b"));

    await runShutdown();

    expect(calls).toEqual(["a", "b"]);
  });

  it("runs nothing twice, because the quit path can arrive twice", async () => {
    // `before-quit` fires, and a `window-all-closed` handler may also call
    // `app.quit()`. An engine told to stop twice is a race.
    const calls: string[] = [];
    const { members, runShutdown } = createDesktopMembers(shell());

    members.onShutdown(() => calls.push("a"));
    await runShutdown();
    await runShutdown();

    expect(calls).toEqual(["a"]);
  });

  it("keeps going when one callback throws", async () => {
    // The contract calls this a courtesy hook. One broken subscriber silently
    // cancelling another's cleanup would be worse than the throwing subscriber.
    const calls: string[] = [];
    const { members, runShutdown } = createDesktopMembers(shell());

    members.onShutdown(() => {
      throw new Error("cleanup exploded");
    });
    members.onShutdown(() => calls.push("survivor"));

    await expect(runShutdown()).resolves.toBeUndefined();

    expect(calls).toEqual(["survivor"]);
  });

  it("does not run a callback registered during the run", async () => {
    // Iterating the list while a callback appends to it is a loop that can grow
    // itself. The list is drained instead.
    const calls: string[] = [];
    const { members, runShutdown } = createDesktopMembers(shell());

    members.onShutdown(() => {
      calls.push("first");
      members.onShutdown(() => calls.push("late"));
    });

    await runShutdown();

    expect(calls).toEqual(["first"]);
  });

  it("accepts registration from a synchronous context", () => {
    // Synchronous registration is the contract: a caller must be able to register
    // during startup, before any await can run.
    const { members } = createDesktopMembers(shell());

    expect(() => {
      members.onShutdown(() => undefined);
    }).not.toThrow();
  });
});

describe("notify", () => {
  it("raises a notification when the host can", async () => {
    const deps = shell();
    const { members } = createDesktopMembers(deps);

    await members.notify("warn", "engine is restarting");

    expect(deps.notifications).toHaveLength(1);
    expect(deps.notifications[0]?.body).toBe("engine is restarting");
  });

  it("succeeds silently when the host cannot notify", async () => {
    // The refusal is the capability flag, never an error: a caller's notification
    // path must have no branch.
    const deps = shell({ canNotify: () => false });
    const { members } = createDesktopMembers(deps);

    await expect(members.notify("error", "anything")).resolves.toBeUndefined();
    expect(deps.notifications).toHaveLength(0);
  });

  it("asks the capability question once, not per notification", async () => {
    // `canNotify` is a property of the build, not of the call. Asking per
    // notification would let two paths disagree about the same host.
    let asked = 0;
    const deps = shell({
      canNotify: () => {
        asked += 1;

        return true;
      },
    });
    const { members } = createDesktopMembers(deps);

    await members.notify("info", "one");
    await members.notify("info", "two");

    expect(asked).toBe(1);
  });

  it("uses the level as the title, since there is no product name to show", async () => {
    const deps = shell();
    const { members } = createDesktopMembers(deps);

    await members.notify("error", "boom");

    expect(deps.notifications[0]?.title).toBe("error");
  });
});

describe("readDroppedFiles", () => {
  it("passes an absolute path through with its name", async () => {
    const absolute = process.platform === "win32" ? "C:\\work\\a.txt" : "/work/a.txt";
    const { members } = createDesktopMembers(shell());

    const result = await members.readDroppedFiles([{ name: "a.txt", path: absolute }]);

    expect(result).toEqual({ ok: true, entries: [{ name: "a.txt", path: absolute }] });
  });

  it("answers name-only for a file with no path", async () => {
    // Measured, not hypothetical: `getPathForFile` answers `""` for a `File` the
    // browser constructed. `""` is a normal return value, so this is an entry with a
    // name and no location rather than a failed call.
    const { members } = createDesktopMembers(shell());

    const result = await members.readDroppedFiles([{ name: "ghost.png", path: "" }]);

    expect(result).toEqual({ ok: true, entries: [{ name: "ghost.png" }] });
  });

  it("answers name-only when the path is absent entirely", async () => {
    const { members } = createDesktopMembers(shell());

    const result = await members.readDroppedFiles([{ name: "ghost.png" }]);

    expect(result).toEqual({ ok: true, entries: [{ name: "ghost.png" }] });
  });

  it("never fabricates base64 for an entry it could not locate", async () => {
    // Reading a file's bytes to synthesise a payload would be content a caller
    // trusts but that was never on disk where it claims to be.
    const { members } = createDesktopMembers(shell());

    const result = await members.readDroppedFiles([{ name: "ghost.png", path: "" }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]).not.toHaveProperty("base64");
  });

  it("refuses a relative path, which would resolve against the wrong cwd", async () => {
    // The same trap `buildSpawnSpec` avoids for the engine bundle: a relative path
    // looks valid here and resolves elsewhere in the child.
    const { members } = createDesktopMembers(shell());

    const result = await members.readDroppedFiles([{ name: "a.txt", path: "work/a.txt" }]);

    expect(result).toEqual({ ok: true, entries: [{ name: "a.txt" }] });
  });

  it("keeps the order the files were dropped in", async () => {
    const base = process.platform === "win32" ? "C:\\work" : "/work";
    const { members } = createDesktopMembers(shell());

    const result = await members.readDroppedFiles([
      { name: "1.txt", path: path.join(base, "1.txt") },
      { name: "2.txt" },
      { name: "3.txt", path: path.join(base, "3.txt") },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((entry) => entry.name)).toEqual(["1.txt", "2.txt", "3.txt"]);
  });

  it("answers an empty list for an empty drop rather than failing", async () => {
    const { members } = createDesktopMembers(shell());

    await expect(members.readDroppedFiles([])).resolves.toEqual({ ok: true, entries: [] });
  });
});
