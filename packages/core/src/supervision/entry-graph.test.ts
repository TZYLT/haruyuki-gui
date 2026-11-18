/**
 * The supervision entry must stay reachable without the engine transport.
 *
 * Why this test exists: the desktop main process bundled `@haruyuki/core` from its
 * root, the root re-exports the engine transport, and that transport's first
 * statement needs `import.meta.url` -- which a CommonJS bundle cannot evaluate.
 * The build config patched the expression with a build-machine absolute path, so
 * the packaged application resolved the websocket client under a directory that
 * only exists on the machine that built it.
 *
 * Moving the supervision primitives onto their own subpath is one half of the fix.
 * It only stays a fix while that subpath's graph is free of the transport: a
 * single value import from `./marker` or `./evidence` back into `../engine` would
 * put the expression in the bundle again, and the symptom would be a packaged
 * application that cannot start rather than a failing test.
 *
 * So this walks the subpath's own import graph -- relative specifiers only, since
 * the entry itself is what is being judged -- and refuses two things:
 *
 *   1. `engine/connection` anywhere in it. That module is the one that calls
 *      `createRequire(import.meta.url)` at load time.
 *   2. `import.meta` anywhere in it, for the same reason one step earlier: no
 *      member of the graph may depend on an expression the bundle cannot keep.
 *
 * Value imports only. A `import type` is erased by the bundler and cannot pull a
 * module into the output, so counting them would fail on something harmless --
 * and a test that fails for the wrong reason gets deleted, which is worse than
 * no test.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** `packages/core/src/supervision`, resolved from this file's own location. */
const ENTRY = fileURLToPath(import.meta.url).replace(/[^\\/]+$/, "index.ts");

/** The transport module that must not appear in the graph. */
const TRANSPORT = path.join(ENTRY, "..", "..", "engine", "connection.ts");

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;

  const base = path.resolve(path.dirname(fromFile), spec);
  const withoutExtension = base.replace(/\.jsx?$/, "");

  // Source imports are written with the emitted extension (`.js`), so the `.ts`
  // next to it is what actually exists on disk.
  for (const candidate of [
    base,
    `${base}.ts`,
    `${withoutExtension}.ts`,
    `${withoutExtension}.tsx`,
    path.join(base, "index.ts"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }

  return null;
}

/** Specifiers named by value imports and value re-exports in one file. */
function valueSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  const specifiers: string[] = [];
  const statement = /(?:^|\n)\s*(?:import|export)\s+([^;]*?)\s+from\s+["']([^"']+)["']/g;

  let match: RegExpExecArray | null;
  while ((match = statement.exec(source)) !== null) {
    const clause = match[1]!.trim();
    const specifier = match[2]!;

    // `import type { X } from` and `import type X from` are erased.
    if (/^type\b/.test(clause)) continue;

    // A brace list of only `type X` members is erased as well.
    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (braces !== null) {
      const members = braces[1]!
        .split(",")
        .map((member) => member.trim())
        .filter((member) => member.length > 0);

      if (members.every((member) => /^type\s/.test(member))) continue;
    }

    specifiers.push(specifier);
  }

  return specifiers;
}

/** Every file reachable from the entry through value imports. */
function valueGraph(entry: string): string[] {
  const seen = new Set<string>([entry]);
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.shift()!;

    for (const specifier of valueSpecifiers(file)) {
      const resolved = resolveRelative(file, specifier);
      if (resolved === null || seen.has(resolved)) continue;

      seen.add(resolved);
      queue.push(resolved);
    }
  }

  return [...seen].sort();
}

describe("the supervision subpath stays clear of the engine transport", () => {
  it("has no engine transport in its value import graph", () => {
    const graph = valueGraph(ENTRY).map((file) =>
      path.relative(path.join(ENTRY, ".."), file).replaceAll("\\", "/"),
    );

    // The entry has to reach something, or the walker is broken and everything
    // below passes for the wrong reason.
    expect(graph.length, "the subpath graph is empty").toBeGreaterThan(3);

    expect(graph, "the supervision subpath now reaches the engine transport").not.toContain(
      path.relative(path.join(ENTRY, ".."), TRANSPORT).replaceAll("\\", "/"),
    );
  });

  it("has no import.meta expression in its value import graph", () => {
    const offenders = valueGraph(ENTRY).filter((file) =>
      readFileSync(file, "utf8").includes("import.meta"),
    );

    // A CommonJS bundle turns `import.meta` into an empty object, so any member of
    // this graph that dereferences it would need the same build-machine patch the
    // transport needed.
    expect(
      offenders.map((file) => path.relative(path.join(ENTRY, ".."), file).replaceAll("\\", "/")),
      "a supervision module now needs import.meta",
    ).toEqual([]);
  });
});
