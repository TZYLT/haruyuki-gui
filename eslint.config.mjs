// ESLint flat config - workspace lint gates.
//
// Global ignores + TypeScript parser wiring live in the shared block below.
// The per-package blocks implement the package-boundary rules (the frozen
// acceptance matrix plus the shell host-API rules): importing across a
// forbidden edge, or value-importing a package that may only be type-imported,
// or reaching for the other app shell's host API, is an error. Each rule id is
// embedded in its message so gate self-tests can assert which rule fired.
//
// Deliberate choices:
// - eslint core `no-restricted-imports` is used (the @typescript-eslint copy is
//   deprecated since ESLint 9.37). With the TS parser it understands
//   `import type` and honours `allowTypeImports`.
// - The rule matches the raw import string, so deep paths are covered with
//   `patterns.group` (gitignore-style prefixes) rather than `paths`.
// - `files` patterns are relative to this config file (the repo root), so a
//   bare `eslint .` from the root sees them.
// - No type-aware linting: no `parserOptions.project` / `projectService`.

import tseslint from "typescript-eslint";

import { rules as i18nRules } from "./scripts/lint/i18n-messages.mjs";

// `tsx` is part of the module surface, not an exception: the renderer package
// is where JSX lives, and a file extension that eslint silently skips is a file
// where every rule in this config stops applying. The parser needs
// `ecmaFeatures.jsx` as well (`TSX` cannot be parsed in plain TS mode), which is
// set once in the shared block below.
const MODULE_EXTENSIONS = "js,mjs,cjs,ts,mts,cts,tsx";

/**
 * Build the `files` glob for one workspace package.
 * @param {string} packagePath workspace-relative package directory
 * @returns {string[]} flat-config `files` globs
 */
function packageFiles(packagePath) {
  return [`${packagePath}/**/*.{${MODULE_EXTENSIONS}}`];
}

// R4 bare-name deny list. `node:*` (node:fs, node:fs/promises, ...) is appended
// to the derived pattern list below.
const NODE_BUILTIN_MODULES = [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
];

// Leading "/" anchors each pattern to the start of the import string. Without
// it, gitignore semantics would match the bare name at ANY path segment and
// `@haruyuki/core/sub/path` would falsely trip the `path` builtin.
// A matched prefix implies its subpaths (`fs` covers `fs/promises`, `path`
// covers `path/posix`), but the explicit `/*` entries are kept for clarity.
const NODE_BUILTIN_PATTERNS = NODE_BUILTIN_MODULES.flatMap((name) => [`/${name}`, `/${name}/*`]);
NODE_BUILTIN_PATTERNS.push("/node:*");

// Host APIs, anchored the same way: `/electron/*` covers deep imports such as
// `electron/main`; `vscode` has no public subpaths worth listing.
const HOST_API_PATTERNS = ["/electron", "/electron/*", "/vscode"];

// R12: each app shell binds exactly one host API and must never import the
// other shell's one. The leading "/" matters here for the same reason as above:
// without it, `@haruyuki/vscode` (an internal package, governed by R8/R9) would
// match the bare `vscode` host pattern and report the wrong rule.
const VSCODE_HOST_API_PATTERNS = ["/vscode"];
const ELECTRON_HOST_API_PATTERNS = ["/electron", "/electron/*"];

export default [
  {
    // `_research/` is exploration residue outside the workspace (and owns its
    // own nested configs), so workspace gates must not scan it. `docs/` is a
    // separate, unpublished git repository that only exists in the primary
    // checkout: linting it would make `pnpm verify` depend on where it runs.
    // `coverage/` is a report directory, never source.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/fixtures/**",
      "_research/**",
      "docs/**",
      "coverage/**",
    ],
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {},
  },
  // JSX/TSX block. JSX is syntax, not module resolution, so it is opted into
  // here rather than by widening the extension glob: enabling `jsx` for every
  // TS file would let `.ts` files contain JSX, which the TypeScript compiler
  // rejects (`TS17004`).
  {
    files: ["**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {},
  },

  // R1 + R3: packages/protocol must not import any internal package at all
  // (including deep paths such as `@haruyuki/core/internal/foo`) and must stay
  // host-agnostic. Both rules share one config object because flat config
  // overrides `no-restricted-imports` wholesale per matching object - a second
  // protocol block would silently drop the first one's patterns.
  {
    files: packageFiles("packages/protocol"),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@haruyuki/*", "@haruyuki/**"],
              message:
                "R1: @haruyuki/protocol is the leaf package and must not import other @haruyuki/* packages (deep paths included); move shared code into protocol instead",
            },
            {
              group: HOST_API_PATTERNS,
              message:
                "R3: @haruyuki/protocol must not import host APIs (electron / electron/* / vscode); keep host wiring in apps/*",
            },
          ],
        },
      ],
    },
  },
  // R2 + R10: packages/core must stay host-agnostic (no Electron/VSCode) and
  // must not reach up into the renderer or the app shells. Both rules share one
  // config object: flat config overrides `no-restricted-imports` wholesale per
  // matching object, so a second core block would drop the first one's patterns.
  {
    files: packageFiles("packages/core"),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: HOST_API_PATTERNS,
              message:
                "R2: @haruyuki/core must not import host APIs (electron / electron/* / vscode); keep host wiring in apps/*",
            },
            {
              group: [
                "@haruyuki/ui",
                "@haruyuki/ui/*",
                "@haruyuki/ui/**",
                "@haruyuki/desktop",
                "@haruyuki/desktop/*",
                "@haruyuki/desktop/**",
                "@haruyuki/vscode",
                "@haruyuki/vscode/*",
                "@haruyuki/vscode/**",
              ],
              message:
                "R10: @haruyuki/core must not import @haruyuki/ui, @haruyuki/desktop or @haruyuki/vscode (type imports included); the dependency edge points the other way",
            },
          ],
        },
      ],
    },
  },
  // R4-R7 + R11: the renderer (packages/ui) may only depend on protocol/core
  // types, and must not import the app shells at all.
  {
    files: packageFiles("packages/ui"),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: NODE_BUILTIN_PATTERNS,
              message:
                "R4: @haruyuki/ui is the renderer and must not import Node builtins (node:* or bare names such as fs/path/child_process); keep I/O in @haruyuki/core",
            },
            {
              group: HOST_API_PATTERNS,
              message:
                "R5: @haruyuki/ui is the renderer and must not import host APIs (electron / electron/* / vscode); talk to the host through the protocol instead",
            },
            {
              group: ["@haruyuki/core", "@haruyuki/core/*", "@haruyuki/core/**"],
              allowTypeImports: true,
              message:
                "R6: @haruyuki/ui must not value-import @haruyuki/core; use 'import type' instead",
            },
            {
              group: ["@haruyuki/protocol", "@haruyuki/protocol/*", "@haruyuki/protocol/**"],
              allowTypeImports: true,
              message:
                "R7: @haruyuki/ui may only 'import type' from @haruyuki/protocol; value imports are forbidden",
            },
            {
              group: [
                "@haruyuki/desktop",
                "@haruyuki/desktop/*",
                "@haruyuki/desktop/**",
                "@haruyuki/vscode",
                "@haruyuki/vscode/*",
                "@haruyuki/vscode/**",
              ],
              message:
                "R11: @haruyuki/ui must not import the app shells @haruyuki/desktop or @haruyuki/vscode (type imports included); the dependency edge points the other way",
            },
          ],
        },
      ],
    },
  },

  // R8 + R12: apps/desktop may import protocol/core/ui, but never the sibling
  // app shell, and it binds the Electron host API, so the VSCode host API is
  // off limits. Both rules share one config object for the override reason
  // noted above; the allowed edges stay unrestricted on purpose.
  {
    files: packageFiles("apps/desktop"),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@haruyuki/vscode", "@haruyuki/vscode/*", "@haruyuki/vscode/**"],
              message:
                "R8: @haruyuki/desktop (apps/desktop) must not import the sibling app shell @haruyuki/vscode (type imports included)",
            },
            {
              group: VSCODE_HOST_API_PATTERNS,
              message:
                'R12: @haruyuki/desktop (apps/desktop) binds the Electron host API and must not import the VSCode host API "vscode" (type imports included)',
            },
          ],
        },
      ],
    },
  },
  // R9 + R12: apps/vscode may import protocol/core/ui, but never the sibling
  // app shell, and it binds the VSCode host API, so Electron is off limits.
  {
    files: packageFiles("apps/vscode"),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@haruyuki/desktop", "@haruyuki/desktop/*", "@haruyuki/desktop/**"],
              message:
                "R9: @haruyuki/vscode (apps/vscode) must not import the sibling app shell @haruyuki/desktop (type imports included)",
            },
            {
              group: ELECTRON_HOST_API_PATTERNS,
              message:
                "R12: @haruyuki/vscode (apps/vscode) binds the VSCode host API and must not import the Electron host API (electron / electron/*; type imports included)",
            },
          ],
        },
      ],
    },
  },

  // Hard-coded user-facing text in the renderer.
  //
  // Scoped to the package that renders text for a user. Applying these to every
  // package would flag the catalogue files themselves -- which are Chinese and
  // English prose by definition -- and a rule that needs a dozen exceptions is a
  // rule somebody eventually disables.
  //
  // `no-user-facing-en` requires two words to look like prose: a single English
  // word is ambiguous enough (a class, a unit, a state constant) that flagging it
  // would produce enough noise to get the rule turned off.
  {
    files: [
      "packages/ui/src/components/**/*.{ts,tsx}",
      "packages/ui/src/examples/**/*.{ts,tsx}",
      "packages/ui/src/icons/**/*.{ts,tsx}",
    ],
    ignores: ["**/*.test.{ts,tsx}"],
    plugins: {
      "haruyuki-i18n": { rules: i18nRules },
    },
    rules: {
      "haruyuki-i18n/no-cjk-in-source": "error",
      "haruyuki-i18n/no-user-facing-en": "error",
    },
  },
];
