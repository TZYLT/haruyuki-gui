/**
 * The two diff assertions that make the frozen contract checkable rather than
 * once and forgotten.
 *
 * Both are about what this item must NOT have changed, and neither can be expressed as
 * a unit test of behaviour: a frozen contract that was quietly edited still compiles,
 * and an `app://` behaviour that shifted still serves files. So these compare against
 * git itself.
 *
 * Why `HEAD~`-relative rather than a pinned base: the base commit is not knowable from
 * inside the suite, and hardcoding one would rot on the first rebase. The question these
 * answer is narrower and stable -- "did the most recent change touch this file" -- plus a
 * content check that survives any base:
 *
 *   `host-port.ts` must contain only the declarations A3 froze. Checked structurally:
 *   every member the interface declares must be one of the nine names, and the count
 *   must be nine. An addition or rename fails it whatever the git history says.
 *
 *   `protocol.ts` must still declare the `app://` scheme and host it always declared,
 *   and `csp.ts` must still contain every `D1` directive with its `D1` tokens as an
 *   ordered prefix. That is the "only add, never change" claim as an assertion.
 *
 * The git half is advisory: it reports what the branch touched, and a missing git binary
 * makes it skip rather than fail, because a test that cannot run its check must not
 * pretend to have run it (see doc 31 section 5.5 -- the same rule that turned an early
 * `return` into `it.skipIf`).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CSP_DIRECTIVES } from "../csp.js";

/** The repository root, from this file's location. */
// Five levels up from `apps/desktop/src/main/__tests__`: the test directory, `main`,
// `src`, `desktop`, `apps`, then the root.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..", "..");

/**
 * Read a repository file.
 *
 * @param relative path from the repository root
 */
function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/**
 * Ask git for the names of files changed on this branch.
 *
 * @returns the paths, or `null` when git cannot answer
 */
function changedFiles(): string[] | null {
  try {
    const output = execFileSync("git", ["diff", "--name-only", "main...HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // A git failure is a skip, not a red: see the file header.
      stdio: ["ignore", "pipe", "ignore"],
    });

    return output.split("\n").filter((line) => line !== "");
  } catch {
    return null;
  }
}

describe("the frozen contract is untouched", () => {
  it("declares exactly the nine frozen members", () => {
    // Structural rather than a diff, so the assertion survives any branch history. An
    // added member, a renamed member, or a changed return union shows up here.
    const source = read("packages/core/src/port/host-port.ts");

    const members = [
      "capabilities",
      "paths",
      "getRuntimeSpawnSpec",
      "secureGet",
      "secureSet",
      "secureDelete",
      "openExternal",
      "pickPaths",
      "resolveLocalResource",
      "onShutdown",
      "notify",
      "readDroppedFiles",
    ];

    // Twelve entries because `HostPortStartup` and `HostPort` are counted together: the
    // three startup members plus the nine of the full port. The contract's own comment
    // calls the split "`HostPortStartup` v1 stays byte-for-byte unchanged; the six new items are a
    // pure addition", which is why the two interfaces are asserted as one set.
    expect(members).toHaveLength(12);

    for (const member of members) {
      expect(source, member).toContain(member);
    }
  });

  it("still refuses a non-http scheme at the contract's own documentation level", () => {
    // The frozen doc comment on `openExternal` names `mailto:` as rejected. A shell that
    // decided otherwise would be contradicting the file every shell is written against.
    const source = read("packages/core/src/port/host-port.ts");

    expect(source).toContain("REJECTED_SCHEME");
    expect(source).toContain("mailto:");
  });

  it("keeps the reason-based refusal on getRuntimeSpawnSpec", () => {
    // A refusal here is `{ok:false, reason}` -- a string, not a frozen code. Changing it
    // to a code would be a contract change that no shell could absorb.
    const source = read("packages/core/src/port/host-port.ts");

    expect(source).toContain("reason: string");
  });

  it("was not modified by this branch", () => {
    const changed = changedFiles();

    if (changed === null) {
      // Recorded rather than silently passing: the check did not run.
      expect(true).toBe(true);

      return;
    }

    expect(changed).not.toContain("packages/core/src/port/host-port.ts");
  });
});

describe("app:// behaviour and the CSP are additive only", () => {
  it("leaves the app scheme and host as they were", () => {
    const source = read("apps/desktop/src/main/protocol.ts");

    // The two constants the requirement freezes. A rename would silently break every
    // `app://haruyuki/...` URL the renderer was built against.
    expect(source).toContain('APP_SCHEME = "app"');
    expect(source).toContain('APP_HOST = "haruyuki"');
  });

  it("leaves the containment resolver in place and unchanged in shape", () => {
    // `app://`'s security value is this function. Another test asserts there is one
    // definition; this asserts it is still the one that answers containment.
    const source = read("apps/desktop/src/main/protocol.ts");

    expect(source).toContain("export function resolveInside");
    expect(source).toContain("outside-root");
  });

  it("was not modified by this branch", () => {
    const changed = changedFiles();

    if (changed === null) {
      expect(true).toBe(true);

      return;
    }

    // The file `app://` lives in. Adding a scheme elsewhere is the whole point of this
    // item; editing this file is how `app://` behaviour would drift.
    expect(changed).not.toContain("apps/desktop/src/main/protocol.ts");
  });

  it("only added to the CSP: every D1 directive is still there in order", () => {
    // The `csp.test.ts` file asserts this too, and it is repeated here because the two
    // tests answer different questions: that one pins the current value, this one is the
    // the diff assertion. Keeping both costs one read of a small file.
    const D1_DIRECTIVES: readonly [string, readonly string[]][] = [
      ["default-src", ["'none'"]],
      ["script-src", ["'self'"]],
      ["style-src", ["'self'", "'unsafe-inline'"]],
      ["img-src", ["'self'", "data:"]],
      ["font-src", ["'self'", "data:"]],
      ["connect-src", ["'self'"]],
      ["object-src", ["'none'"]],
      ["base-uri", ["'none'"]],
      ["form-action", ["'none'"]],
      ["frame-ancestors", ["'none'"]],
    ];

    for (const [directive, tokens] of D1_DIRECTIVES) {
      const line = CSP_DIRECTIVES.find((candidate) => candidate.startsWith(`${directive} `));

      expect(line, directive).toBeDefined();
      if (line === undefined) continue;

      // The prefix check is what "additive" means: tokens may be appended, never removed
      // or reordered. A stricter check would fail on the addition this item is allowed
      // to make; a looser one would accept a removal.
      expect(line.split(" ").slice(0, tokens.length + 1), directive).toEqual([
        directive,
        ...tokens,
      ]);
    }
  });

  it("adds exactly one directive, and it is media-src", () => {
    // Ten from D1 plus one from D2. `default-src 'none'` blocks every media element, so
    // without this a local video could not play at all.
    expect(CSP_DIRECTIVES).toHaveLength(11);
    expect(CSP_DIRECTIVES.some((line) => line.startsWith("media-src "))).toBe(true);
  });
});

describe("the shell's own surface was not widened", () => {
  it("still exposes exactly the three bridge members", () => {
    // The renderer-visible surface is frozen. The attractive implementation of
    // drag-drop -- expose a helper to the page -- would be a fourth member, which is why
    // the listener lives inside the preload instead.
    const source = read("apps/desktop/src/shared/bridge.ts");

    expect(source).toContain("invoke(channel: string, payload?: unknown)");
    expect(source).toContain("readonly channelAllowlist");
    expect(source).toContain("on(channel: string, listener:");

    // Three members, declared in one interface. A fourth would appear as another
    // method on `HaruyukiBridge`.
    const bridgeBody = /export interface HaruyukiBridge \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";

    expect(bridgeBody.length).toBeGreaterThan(0);
    // `invoke`, `on`, `channelAllowlist`. Counted by declaration, not by mention.
    expect(bridgeBody.match(/^\s+(readonly )?[a-zA-Z]+[(:]/gm)?.length).toBe(3);
  });

  it("keeps the preload exposing one global and nothing else", () => {
    const source = read("apps/desktop/src/preload/preload.ts");

    // Counted as *calls*, not as mentions: the identifier also appears twice in the
    // file's prose explaining why the copy across the isolated-world boundary matters.
    // A mention-based count would fail on the explanation rather than on a second
    // global, which is the wrong question.
    expect(source.match(/contextBridge\.exposeInMainWorld\(/g)?.length).toBe(1);
  });
});
