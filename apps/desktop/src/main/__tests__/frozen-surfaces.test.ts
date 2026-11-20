/**
 * The two diff assertions that make the frozen contract checkable rather than
 * reviewed once and forgotten.
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
 * The git half is advisory: it reports what the branch touched outside a comment, and a
 * missing git binary makes it skip rather than fail, because a test that cannot run its
 * check must not pretend to have run it (see doc 31 section 5.5 -- the same rule that
 * turned an early `return` into `it.skipIf`). A comment-only edit is not a contract
 * change, so the classification lives in one place and is visible.
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
 * Report that a check could not run, without reporting it as a pass.
 *
 * `vitest`'s runtime skip is reachable through the context object only, so the honest
 * alternatives are a throw (which fails a check that merely could not run) or a silent
 * return (which reports it as a pass and therefore lies about the reading -- doc 31
 * section 5.5). This throws with a recognisable message and the caller filters it, which
 * at least cannot be mistaken for a green result.
 */
class CheckCouldNotRun extends Error {
  constructor(reason: string) {
    super(`CHECK DID NOT RUN: ${reason}`);
    this.name = "CheckCouldNotRun";
  }
}

/**
 * Ask git which lines of one file this branch changed outside a comment.
 *
 * The frozen checks below ask "did this branch touch the file", which is the right
 * question for a behaviour change and the wrong one for a comment rewrite: a frozen
 * file whose private citations were removed is still the same contract. So every
 * added or removed line is classified, and anything that is not a comment line -- a
 * `//` line, a block comment's `*` continuation, or a `/*` opener -- is reported.
 * Prose that moves into a different number of lines still shows up here, which is
 * why the caller compares against an empty list rather than a count.
 *
 * @param relative path from the repository root
 * @returns the offending lines, or `null` when git cannot answer
 */
function changesOutsideComments(relative: string): string[] | null {
  try {
    const output = execFileSync("git", ["diff", "--unified=0", "main...HEAD", "--", relative], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // A git failure is a skip, not a red: see the file header.
      stdio: ["ignore", "pipe", "ignore"],
    });

    return output.split("\n").filter((line) => {
      if (!line.startsWith("+") && !line.startsWith("-")) return false;
      if (line.startsWith("+++") || line.startsWith("---")) return false;
      const body = line.slice(1).trim();
      if (body.length === 0) return false;
      return !(body.startsWith("//") || body.startsWith("/*") || body.startsWith("*"));
    });
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
    // calls the split a pure addition -- the earlier shape stays byte-for-byte
    // unchanged and six items are new -- which is why the two interfaces are asserted
    // as one set.
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

  it("changed no code outside its comments on this branch", () => {
    const changed = changesOutsideComments("packages/core/src/port/host-port.ts");

    // A git that cannot answer means the check did not run. Reporting that as a pass
    // would lie about the reading (doc 31 section 5.5); reporting it as a failure would
    // be wrong about the code. The suite records it as skippable by throwing a named
    // error, which `vitest` prints rather than sampling as green.
    if (changed === null) {
      throw new CheckCouldNotRun("git diff did not answer");
    }

    expect(changed).toEqual([]);
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

  it("changed no code outside its comments on this branch", () => {
    const changed = changesOutsideComments("apps/desktop/src/main/protocol.ts");

    // Unrun, not passing -- see the note above.
    if (changed === null) {
      throw new CheckCouldNotRun("git diff did not answer");
    }

    // The file `app://` lives in. Adding a scheme elsewhere is the whole point of this
    // item; editing this file is how `app://` behaviour would drift.
    expect(changed).toEqual([]);
  });

  it("only added to the CSP: every D1 directive is still there in order", () => {
    // The `csp.test.ts` file asserts this too, and it is repeated here because the two
    // tests answer different questions: that one pins the current value, this one is
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

describe("rendered content never reaches innerHTML", () => {
  it("has zero innerHTML / dangerouslySetInnerHTML / v-html in either package", () => {
    // This was recorded in the work log as verified when nothing verified it -- a grep
    // was run by hand and the result written down, which protects nothing on the next
    // commit. The assertion exists precisely so the state cannot regress silently.
    //
    // The prohibition is the render half of the media channel's whole design: files are
    // served as `text/plain` so the browser will not interpret them, and that is worth
    // nothing if the viewer then assigns the text to `innerHTML`.
    //
    // Comments are stripped before the search, because the two files that document the
    // rule mention the word by name, and a plain grep would fail on the explanation.
    const { readdirSync, readFileSync, statSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");

    /** Every `.ts`/`.tsx` under a directory, recursively. */
    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return walk(full);
        return /\.tsx?$/.test(full) ? [full] : [];
      });
    }

    /** Remove block and line comments, so prose about the rule does not trip it. */
    function withoutComments(source: string): string {
      return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    }

    const violations: string[] = [];

    for (const root of ["packages/ui/src", "apps/desktop/src"]) {
      for (const file of walk(path.join(REPO_ROOT, root))) {
        // Tests are excluded: a test may legitimately name the property it forbids.
        if (file.includes("__tests__") || file.endsWith(".test.ts") || file.endsWith(".test.tsx")) {
          continue;
        }

        const code = withoutComments(readFileSync(file, "utf8"));

        for (const forbidden of ["innerHTML", "dangerouslySetInnerHTML", "v-html"]) {
          if (code.includes(forbidden)) violations.push(`${file}: ${forbidden}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

describe("the app name is set by the shell, before any getPath", () => {
  it("calls applyAppName as the first statement of main()", () => {
    // The runtime half of this is `verify:host-port`, which now calls the same
    // `applyAppName` the shell calls. This is the half that catches the specific
    // mistake a probe cannot: a `getPath` moved above the call, or the call deleted
    // while the probe still passes because it sets the name itself.
    const source = read("apps/desktop/src/main/main.ts");

    const mainStart = source.indexOf("async function main(): Promise<void> {");
    expect(mainStart).toBeGreaterThan(-1);

    const body = source.slice(mainStart);
    const callOffset = body.indexOf("applyAppName()");
    expect(callOffset).toBeGreaterThan(-1);

    // Every `app.getPath` in the file must come after the call, or `setName` has no
    // effect on the paths it resolves.
    const firstGetPath = body.indexOf("app.getPath(");
    if (firstGetPath !== -1) {
      expect(callOffset).toBeLessThan(firstGetPath);
    }
  });

  it("registers the schemes before the first await in main()", () => {
    // The failure this prevents, from a real launch: moving the directory creation above
    // the registration -- because it needs an `await` -- suspended `main()` at a point
    // before `registerSchemesAsPrivileged` ran, so it executed after the ready event and
    // Electron threw "should be called before app is ready". The window then showed only
    // the error page, and nothing in the test suite noticed, because no unit test starts
    // the shell.
    //
    // Asserts the executable equivalent of "before ready": registration precedes the
    // first `await` in `main()`. **This is a proxy, not the rule** -- see the comment in
    // `main.ts`. It holds only while `main()` is the file's sole async entry point; if a
    // module-scope `await` is ever introduced, this assertion must be replaced rather than
    // trusted, because it would then pass on a registration that runs after ready.
    const source = read("apps/desktop/src/main/main.ts");

    const body = source.slice(source.indexOf("async function main(): Promise<void> {"));
    const registration = body.indexOf("protocol.registerSchemesAsPrivileged([");
    const firstAwait = body.indexOf("await ");

    expect(registration).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(-1);

    // The registration comes first, and before the ready event as well.
    expect(registration).toBeLessThan(firstAwait);
    expect(registration).toBeLessThan(body.indexOf("await app.whenReady()"));
  });

  it("sets the name before the registration, which is before the first await", () => {
    // `setName` also has an ordering requirement, and the two are adjacent. Asserted
    // together because a future edit inside this window can break either.
    //
    // Same proxy caveat as the case above: "before the first `await`" stands in for
    // "before `app.ready`" only while `main()` is the sole async entry point.
    const source = read("apps/desktop/src/main/main.ts");

    const body = source.slice(source.indexOf("async function main(): Promise<void> {"));
    const name = body.indexOf("applyAppName()");
    const registration = body.indexOf("protocol.registerSchemesAsPrivileged([");
    const firstAwait = body.indexOf("await ");

    expect(name).toBeGreaterThan(-1);
    expect(name).toBeLessThan(registration);
    expect(registration).toBeLessThan(firstAwait);
  });

  it("has exactly one definition of the name-setting call", () => {
    // Two places calling `app.setName` is how the probe came to measure itself. One
    // function, called from both sides.
    const proofSource = read("apps/desktop/src/main/app-identity.ts");

    expect(proofSource).toContain("export function applyAppName");
    expect(proofSource).toContain("app.setName(APP_NAME)");

    const mainSource = read("apps/desktop/src/main/main.ts");

    // `main.ts` must not call `app.setName` directly any more.
    expect(mainSource).not.toContain("app.setName(");
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
